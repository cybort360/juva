/**
 * Juva's product analytics vocabulary.
 *
 * A closed set of event names and a closed set of property values, because the failure
 * mode for analytics is not a missing event — it is a helpful `productName` added in a
 * hurry that ships a shopper's groceries to a third party forever.
 *
 * So the rule here is structural rather than procedural: properties are `number |
 * boolean | Band | string-enum` only. There is no way to attach free text, which means
 * there is no way to attach a receipt line, a product name, an address or a note. A
 * developer who needs to express "how big was the saving" reaches for a band, because
 * the type system offers nothing else.
 *
 * This module defines and validates the events. It does not send them — the transport
 * lives in `services/`, so the vocabulary stays testable without a network.
 */

export type AnalyticsEvent =
  | 'app_opened'
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'list_created'
  | 'market_search_started'
  | 'market_search_completed'
  | 'market_search_partial'
  | 'optimization_completed'
  | 'single_store_plan_seen'
  | 'juva_pick_found'
  | 'juva_pick_locked'
  | 'worth_trip_changed'
  | 'shop_mode_started'
  | 'shop_adaptation_created'
  | 'shop_trip_completed'
  | 'receipt_verification_started'
  | 'receipt_verification_blocked'
  | 'receipt_verification_completed'
  | 'receipt_integrity_failed'
  | 'verified_savings_created'
  | 'paywall_seen'
  | 'paywall_value_context_present'
  | 'purchase_started'
  | 'purchase_cancelled'
  | 'purchase_failed'
  | 'purchase_completed'
  | 'restore_started'
  | 'restore_completed'
  | 'notification_opt_in'
  | 'notification_opened';

/**
 * Money as a band, never an amount.
 *
 * An exact saving is a fingerprint: combined with a timestamp it narrows down who a
 * shopper is and what they bought. A band answers every product question worth asking —
 * is the value meaningful, is it growing — and answers none of the identifying ones.
 */
export type SavingsBand = 'none' | 'under_1' | '1_to_5' | '5_to_15' | '15_to_40' | 'over_40';

export function savingsBand(cents: number): SavingsBand {
  if (cents <= 0) return 'none';
  if (cents < 100) return 'under_1';
  if (cents < 500) return '1_to_5';
  if (cents < 1500) return '5_to_15';
  if (cents < 4000) return '15_to_40';
  return 'over_40';
}

/** Basket size as a band, for the same reason. */
export type CountBand = '0' | '1_to_5' | '6_to_15' | '16_to_30' | 'over_30';

export function countBand(count: number): CountBand {
  if (count <= 0) return '0';
  if (count <= 5) return '1_to_5';
  if (count <= 15) return '6_to_15';
  if (count <= 30) return '16_to_30';
  return 'over_30';
}

/**
 * The only value types an event property may hold.
 *
 * Deliberately excludes arbitrary strings. The string members are enumerated unions —
 * a plan kind, a band, a blocker name — all of which are Juva's own vocabulary rather
 * than anything a shopper typed or a retailer printed.
 */
export type AnalyticsValue =
  | number
  | boolean
  | SavingsBand
  | CountBand
  | 'complete'
  | 'partial'
  | 'demo'
  | 'remote'
  | 'verified'
  | 'pending'
  | 'blocked'
  | 'integrity_failed'
  | 'monthly'
  | 'annual'
  | 'scan'
  | 'manual';

export type AnalyticsProperties = Readonly<Record<string, AnalyticsValue>>;

/**
 * Property names that must never appear, whatever their value.
 *
 * The type system already forbids free text, so this catches the other half: a
 * correctly-typed value under a name that reveals what it is. `storeCount: 3` is fine;
 * `storeName` would not be, even as an enum, because the enum would be the store list.
 */
const FORBIDDEN_KEYS =
  /(name|title|text|description|address|street|postcode|zip|latitude|longitude|\blat\b|\blon\b|lng|coord|gps|location|barcode|upc|gtin|sku|loyalty|card|token|secret|email|phone|receipt|image|photo|uri|url|prompt|completion|note|query|term)/i;

export interface AnalyticsRejection {
  key: string;
  reason: 'forbidden_key' | 'unsupported_value';
}

/**
 * Strips anything that must not leave the device.
 *
 * Returns the safe subset plus what was dropped, so a test can assert on the rejections
 * rather than merely observing that the output looks clean. Silent stripping is how a
 * privacy bug survives review.
 */
export function sanitizeProperties(properties: Readonly<Record<string, unknown>>): {
  safe: Record<string, AnalyticsValue>;
  rejected: AnalyticsRejection[];
} {
  const safe: Record<string, AnalyticsValue> = {};
  const rejected: AnalyticsRejection[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_KEYS.test(key)) {
      rejected.push({ key, reason: 'forbidden_key' });
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }
    // A string is only allowed when it is one of Juva's own enumerated values. Anything
    // else is, by definition, content.
    if (typeof value === 'string' && ALLOWED_STRINGS.has(value)) {
      safe[key] = value as AnalyticsValue;
      continue;
    }
    rejected.push({ key, reason: 'unsupported_value' });
  }

  return { safe, rejected };
}

const ALLOWED_STRINGS = new Set<string>([
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
]);

/**
 * Whether a verification outcome may be reported as a completion.
 *
 * The receipt layer distinguishes a verified result from a blocked one and from an
 * integrity failure, and analytics must preserve that distinction — collapsing them
 * would make the verification rate look better than it is, which is precisely the number
 * nobody should be able to flatter.
 */
export function verificationEventFor(
  state: 'verified' | 'pending' | 'blocked' | 'integrity_failed',
): AnalyticsEvent {
  switch (state) {
    case 'verified':
      return 'receipt_verification_completed';
    case 'integrity_failed':
      return 'receipt_integrity_failed';
    case 'pending':
    case 'blocked':
      return 'receipt_verification_blocked';
  }
}
