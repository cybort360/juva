import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Analytics ingestion.
 *
 * The client sanitizes before sending. This module sanitizes again, because "the client
 * already checked" is not a security property — a client is a program on someone else's
 * device, and a bug in a shipped build cannot be recalled. Everything the app enforces
 * structurally at the type level is re-enforced here at runtime.
 *
 * Storage is an append-only NDJSON log. Juva's API has no database, and adding one for
 * a funnel counter would be the wrong trade: a line-per-event file is durable, trivially
 * greppable, survives a restart, and can be replaced by a real sink behind the
 * `EventSink` interface the moment there is a reason to.
 */

/** The closed event vocabulary. Must match `src/domain/analytics.ts` exactly. */
export const ALLOWED_EVENTS = new Set([
  'app_opened',
  'onboarding_started',
  'onboarding_completed',
  'list_created',
  'market_search_started',
  'market_search_completed',
  'market_search_partial',
  'optimization_completed',
  'single_store_plan_seen',
  'juva_pick_found',
  'juva_pick_locked',
  'worth_trip_changed',
  'shop_mode_started',
  'shop_adaptation_created',
  'shop_trip_completed',
  'receipt_verification_started',
  'receipt_verification_blocked',
  'receipt_verification_completed',
  'receipt_integrity_failed',
  'verified_savings_created',
  'paywall_seen',
  'paywall_value_context_present',
  'purchase_started',
  'purchase_cancelled',
  'purchase_failed',
  'purchase_completed',
  'restore_started',
  'restore_completed',
  'notification_opt_in',
  'notification_opened',
]);

/**
 * Enumerated string values the client is allowed to send.
 *
 * Anything else that is a string is content by definition — a product name, a receipt
 * line, an address — and is rejected rather than stored.
 */
const ALLOWED_STRINGS = new Set([
  'none',
  'under_1',
  '1_to_5',
  '5_to_15',
  '15_to_40',
  'over_40',
  '0',
  '6_to_15',
  '16_to_30',
  'over_30',
  'complete',
  'partial',
  'demo',
  'remote',
  'verified',
  'pending',
  'blocked',
  'integrity_failed',
  'monthly',
  'annual',
  'scan',
  'manual',
  'unknown',
  'free',
  'plus',
  'purchase_pending',
  'offline_cached_plus',
  'billing_unavailable',
  'different_price',
  'unavailable',
  'quantity_changed',
  'different_package',
  'substitute',
]);

/** Property names that must never be stored, whatever their value. */
const FORBIDDEN_KEYS =
  /(name|title|text|description|address|street|postcode|zip|latitude|longitude|\blat\b|\blon\b|lng|coord|gps|location|barcode|upc|gtin|sku|loyalty|card|token|secret|email|phone|receipt|image|photo|uri|url|prompt|completion|note|query|term)/i;

export const MAX_BATCH = 50;
const MAX_PROPERTIES = 20;
const MAX_KEY_LENGTH = 40;
const MAX_ID_LENGTH = 120;

export interface StoredEvent {
  eventId: string;
  eventName: string;
  at: string;
  receivedAt: string;
  properties: Record<string, number | boolean | string>;
}

export type RejectionReason =
  'unknown_event' | 'malformed' | 'forbidden_key' | 'unsupported_value' | 'too_many_properties';

export interface ValidationResult {
  accepted: StoredEvent[];
  /**
   * Why each rejected entry was rejected — by index and reason only.
   *
   * The offending value is deliberately not included. Logging what was rejected is how a
   * receipt line ends up in an error log, which is the exact thing the rejection was for.
   */
  rejected: { index: number; reason: RejectionReason }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one batch. Never throws, never echoes a rejected value.
 */
export function validateBatch(body: unknown, now: Date = new Date()): ValidationResult | null {
  if (!isRecord(body) || !Array.isArray(body.events)) return null;
  if (body.events.length === 0 || body.events.length > MAX_BATCH) return null;

  const accepted: StoredEvent[] = [];
  const rejected: { index: number; reason: RejectionReason }[] = [];

  body.events.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      rejected.push({ index, reason: 'malformed' });
      return;
    }
    const { id, event, at, properties } = entry;

    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MAX_ID_LENGTH ||
      typeof at !== 'string' ||
      Number.isNaN(Date.parse(at))
    ) {
      rejected.push({ index, reason: 'malformed' });
      return;
    }
    if (typeof event !== 'string' || !ALLOWED_EVENTS.has(event)) {
      rejected.push({ index, reason: 'unknown_event' });
      return;
    }
    if (properties !== undefined && !isRecord(properties)) {
      rejected.push({ index, reason: 'malformed' });
      return;
    }

    const source = isRecord(properties) ? properties : {};
    const entries = Object.entries(source);
    if (entries.length > MAX_PROPERTIES) {
      rejected.push({ index, reason: 'too_many_properties' });
      return;
    }

    const safe: Record<string, number | boolean | string> = {};
    let reason: RejectionReason | undefined;

    for (const [key, value] of entries) {
      if (key.length > MAX_KEY_LENGTH || FORBIDDEN_KEYS.test(key)) {
        reason = 'forbidden_key';
        break;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        safe[key] = value;
        continue;
      }
      if (typeof value === 'boolean') {
        safe[key] = value;
        continue;
      }
      if (typeof value === 'string' && ALLOWED_STRINGS.has(value)) {
        safe[key] = value;
        continue;
      }
      // Free text, an object, an array, a base64 image — all the same answer.
      reason = 'unsupported_value';
      break;
    }

    if (reason !== undefined) {
      rejected.push({ index, reason });
      return;
    }

    accepted.push({
      eventId: id,
      eventName: event,
      at,
      receivedAt: now.toISOString(),
      properties: safe,
    });
  });

  return { accepted, rejected };
}

/** Where accepted events go. Swappable for a real warehouse without touching the route. */
export interface EventSink {
  /** Returns how many were newly stored; duplicates are silently skipped. */
  store(events: readonly StoredEvent[]): Promise<{ stored: number; duplicates: number }>;
}

/**
 * Append-only NDJSON on disk.
 *
 * Durable across restarts, and idempotent: `eventId`s already seen are skipped, so the
 * client's retries cannot double-count a conversion. The seen-set is rebuilt from the
 * file on first use, which keeps deduplication correct after a restart without a
 * database.
 */
export class FileEventSink implements EventSink {
  private seen: Set<string> | undefined;

  constructor(private readonly file: string) {}

  private async loadSeen(): Promise<Set<string>> {
    if (this.seen) return this.seen;
    const seen = new Set<string>();
    try {
      const contents = await readFile(this.file, 'utf8');
      for (const line of contents.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line) as { eventId?: string };
          if (typeof parsed.eventId === 'string') seen.add(parsed.eventId);
        } catch {
          // A truncated final line from an interrupted write. Skipped, not fatal.
        }
      }
    } catch {
      // No file yet. An empty set is the correct starting point.
    }
    this.seen = seen;
    return seen;
  }

  async store(events: readonly StoredEvent[]): Promise<{ stored: number; duplicates: number }> {
    const seen = await this.loadSeen();
    const fresh = events.filter((entry) => !seen.has(entry.eventId));
    if (fresh.length === 0) return { stored: 0, duplicates: events.length };

    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${fresh.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    for (const entry of fresh) seen.add(entry.eventId);
    return { stored: fresh.length, duplicates: events.length - fresh.length };
  }
}

/** In-memory sink for tests and for a deployment with no writable disk. */
export class MemoryEventSink implements EventSink {
  readonly events: StoredEvent[] = [];
  private readonly seen = new Set<string>();
  /** Set to make every store fail, to prove the client retries. */
  failing = false;

  store(events: readonly StoredEvent[]): Promise<{ stored: number; duplicates: number }> {
    if (this.failing) return Promise.reject(new Error('sink unavailable'));
    let stored = 0;
    let duplicates = 0;
    for (const entry of events) {
      if (this.seen.has(entry.eventId)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(entry.eventId);
      this.events.push(entry);
      stored += 1;
    }
    return Promise.resolve({ stored, duplicates });
  }
}
