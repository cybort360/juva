import AsyncStorage from '@react-native-async-storage/async-storage';

import { migrateState } from '@/domain/stateMigration';
import type { JuvaState } from '@/domain/types';
import { reportHandled } from '@/services/monitoring';

/**
 * Bumped whenever the persisted shape changes. A mismatch discards the old
 * payload rather than migrating it, because a partially-migrated plan could
 * carry prices that no longer correspond to any observation.
 */
const STORAGE_KEY = 'juva.state.v7';
const LEGACY_KEYS = [
  'juva.state.v6',
  'juva.state.v5',
  'juva.state.v4',
  'juva.state.v3',
  'juva.state.v2',
  'juva.state.v1',
];

const SAVE_DEBOUNCE_MS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreferences(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.location) &&
    typeof value.radiusMiles === 'number' &&
    typeof value.maxStores === 'number' &&
    typeof value.transportMode === 'string' &&
    typeof value.brandPolicy === 'string' &&
    Array.isArray(value.loyaltyRetailers) &&
    typeof value.timeValueCentsPerMinute === 'number' &&
    typeof value.extraStopPenaltyCents === 'number' &&
    typeof value.onboarded === 'boolean'
  );
}

/**
 * Structural validation of untrusted on-device JSON.
 *
 * This is deliberately shape-only: it guards against corrupt or stale payloads
 * reaching the optimizer, it is not a trust boundary against a hostile device.
 */
function isPersistedState(value: unknown): value is JuvaState {
  if (!isRecord(value)) return false;
  return (
    isPreferences(value.preferences) &&
    typeof value.draftPrompt === 'string' &&
    Array.isArray(value.plans) &&
    Array.isArray(value.receipts) &&
    Array.isArray(value.savingsRecords) &&
    Array.isArray(value.savedLists) &&
    Array.isArray(value.journeyHistory)
  );
}

export async function loadJuvaState(fallback: JuvaState): Promise<JuvaState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Older schemas are not migrated; drop them so they cannot resurface.
      await AsyncStorage.multiRemove(LEGACY_KEYS).catch(() => undefined);
      return fallback;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt state. Reported so it is not silent, then discarded — a shopper with an
      // unreadable file gets a working app, not a crash loop.
      reportHandled('persistence.corrupt_state', { operation: 'read', entityKind: 'juva_state' });
      return fallback;
    }
    if (!isPersistedState(parsed)) {
      reportHandled('persistence.unsupported_schema', {
        operation: 'read',
        entityKind: 'juva_state',
        storageVersion: STORAGE_KEY,
      });
      return fallback;
    }
    try {
      // Shape validation accepts values from older schemas, so upgrade them rather than
      // letting a stale enum reach the optimizer. A no-op on current state.
      return migrateState(parsed);
    } catch {
      // A migration that throws must not cost the shopper their app. The fallback is
      // recorded so a broken migration is visible rather than silently resetting people.
      reportHandled('migration.failed', {
        operation: 'migrate',
        entityKind: 'juva_state',
        recovered: true,
      });
      return fallback;
    }
  } catch {
    reportHandled('persistence.read_failed', { operation: 'read', entityKind: 'juva_state' });
    return fallback;
  }
}

export async function saveJuvaState(state: JuvaState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export async function clearJuvaState(): Promise<void> {
  await AsyncStorage.multiRemove([STORAGE_KEY, ...LEGACY_KEYS]);
}

/**
 * Coalesces bursts of state changes into one write. The composer updates state
 * on every keystroke; without this, each one would hit AsyncStorage.
 */
export function createStateWriter(): {
  schedule: (state: JuvaState) => void;
  flush: () => Promise<void>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: JuvaState | undefined;

  const write = async (): Promise<void> => {
    const next = pending;
    pending = undefined;
    if (!next) return;
    try {
      await saveJuvaState(next);
    } catch {
      // A failed local write must never break the shopping flow — but it must not be
      // invisible either: a shopper silently losing their trip is the worst outcome here.
      reportHandled('persistence.write_failed', { operation: 'write', entityKind: 'juva_state' });
    }
  };

  return {
    schedule(state) {
      pending = state;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void write();
      }, SAVE_DEBOUNCE_MS);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await write();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
