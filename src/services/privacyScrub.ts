/**
 * Scrubbing for anything that leaves the device as diagnostics.
 *
 * Crash reporting is a privacy hazard shaped like a debugging tool: breadcrumbs,
 * URLs, error messages and local state all get uploaded, and every one of them is a
 * place a receipt line or a home address can hide. So this module is deny-by-default —
 * it does not try to spot secrets in an otherwise-safe payload, it strips whole
 * categories and keeps only a short allowlist of keys that cannot identify anyone.
 *
 * Pure and exhaustively tested on purpose. It runs in Sentry's `beforeSend`, where a
 * mistake is silent: the report still uploads, just with something in it that should
 * never have left.
 */

/**
 * Keys whose values are removed wherever they appear, at any depth.
 *
 * Substring matching, so `receiptTotal` and `userProductName` are both caught. The
 * tokens are deliberately whole words rather than fragments: a bare `lat` also
 * matches `platform`, `latency` and `translate`, which is how an over-eager pattern
 * quietly starts denying the diagnostics it was supposed to keep.
 */
const DENIED_KEY_PATTERN =
  /(receipt|barcode|loyalty|product|item|basket|price|total|address|street|postcode|postal|zipcode|latitude|longitude|coord|geo|location|image|photo|uri|url|prompt|completion|openrouter|token|apikey|secret|password|email|phone|name)/i;

/**
 * Keys that survive scrubbing.
 *
 * Deliberately tiny. Anything not named here is dropped even if it looks harmless,
 * because the failure mode of guessing wrong is uploading someone's shopping.
 */
const ALLOWED_KEYS = new Set([
  'screen',
  'route',
  'kind',
  'status',
  'code',
  'stage',
  'count',
  'duration',
  'durationMs',
  'ms',
  'attempt',
  'retries',
  'platform',
  'environment',
  'release',
  'marketMode',
  'hasPlus',
  'tier',
  'freshness',
  'source',
  'adapter',
  'reason',
  'outcome',
  'stops',
  'storeCount',
  'lineCount',
  'ok',
  'enabled',
  'supported',
]);

/** Replacement marker, so a reader can tell a field was removed rather than absent. */
export const REDACTED = '[scrubbed]';

/** Whether a key is denied outright. Exposed so the invariant can be tested. */
export function isDeniedKey(key: string): boolean {
  return DENIED_KEY_PATTERN.test(key);
}

/**
 * The allowlist, exposed for the contradiction test.
 *
 * Deny is checked before allow, so an allowlisted key that also matches the deny
 * pattern is a promise the module cannot keep — `itemCount` was exactly that, since
 * it contains "item". A test asserts the two lists never overlap.
 */
export function allowlistedKeys(): string[] {
  return [...ALLOWED_KEYS];
}

const MAX_DEPTH = 6;

/**
 * Patterns for values that must never appear even under an allowed key.
 *
 * A free-text `reason` is allowed through, so the value itself is still checked for
 * the shapes that carry identity: money, coordinates, long digit runs, emails,
 * file URIs.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  /\b\d{1,3}\.\d{4,}\b/, // a coordinate
  /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/, // a coordinate pair
  /\b\d{8,}\b/, // barcode, loyalty id, card fragment
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email
  /\b(?:file|content|data|assets-library|ph):\/\/\S*/i, // a local asset path
  /[$£€₦]\s?\d/, // money
];

export function looksSensitive(value: string): boolean {
  return VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Redacts a free-text string.
 *
 * Whole-value replacement rather than masking the matched part: a message reading
 * "failed to price [scrubbed] at [scrubbed]" still leaks the shape of the basket,
 * and the surrounding words are rarely worth the risk.
 */
export function scrubString(value: string): string {
  return looksSensitive(value) ? REDACTED : value;
}

/**
 * Recursively strips a structured payload down to the allowlist.
 *
 * Arrays keep their length — the fact that there were four of something is useful
 * and harmless — while their contents are scrubbed individually.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (DENIED_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      if (!ALLOWED_KEYS.has(key)) {
        result[key] = REDACTED;
        continue;
      }
      result[key] = scrubValue(entry, depth + 1);
    }
    return result;
  }

  // Functions, symbols and anything else exotic are never diagnostics.
  return REDACTED;
}

/**
 * Reduces a URL to its origin and path shape.
 *
 * Query strings and path segments are where identifiers end up — a postcode in a
 * geocode lookup, a barcode in a product request — so only the host and a
 * digit-flattened path survive.
 */
export function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/\d[\w-]*/g, '/:id');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return REDACTED;
  }
}

export interface ScrubbableEvent {
  message?: unknown;
  exception?: unknown;
  request?: { url?: unknown; data?: unknown; headers?: unknown; query_string?: unknown };
  user?: unknown;
  contexts?: unknown;
  extra?: unknown;
  tags?: unknown;
  breadcrumbs?: unknown;
  server_name?: unknown;
  [key: string]: unknown;
}

/**
 * The `beforeSend` transform.
 *
 * Structured as a whitelist over a copy: fields are carried across deliberately
 * rather than deleted from the original, so a future Sentry SDK that adds a new
 * field carrying user content does not silently start shipping it.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const scrubbed = { ...event } as ScrubbableEvent;

  // Identity is never useful to Juva: the stable RevenueCat id is the only handle on
  // a person, and it does not belong in crash reports either.
  delete scrubbed.user;
  // Device hostnames are user-chosen and often contain a real name.
  delete scrubbed.server_name;

  if (typeof scrubbed.message === 'string') scrubbed.message = scrubString(scrubbed.message);

  if (scrubbed.request && typeof scrubbed.request === 'object') {
    const request = scrubbed.request;
    scrubbed.request = {
      ...(typeof request.url === 'string' ? { url: scrubUrl(request.url) } : {}),
      // A request body is the single most likely place a receipt payload appears.
      data: REDACTED,
      headers: REDACTED,
      query_string: REDACTED,
    };
  }

  if (scrubbed.extra !== undefined) scrubbed.extra = scrubValue(scrubbed.extra);
  if (scrubbed.contexts !== undefined) scrubbed.contexts = scrubValue(scrubbed.contexts);
  if (scrubbed.tags !== undefined) scrubbed.tags = scrubValue(scrubbed.tags);

  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  }

  if (Array.isArray(scrubbed.exception)) {
    scrubbed.exception = scrubbed.exception.map((entry) => scrubValue(entry));
  } else if (scrubbed.exception !== undefined && typeof scrubbed.exception === 'object') {
    scrubbed.exception = scrubException(scrubbed.exception as Record<string, unknown>);
  }

  return scrubbed as T;
}

/**
 * Scrubs an exception while keeping the stack trace.
 *
 * The stack is the reason crash reporting exists, and frame paths are Juva's own
 * module names rather than user content — so `stacktrace` is carried across intact
 * while the human-readable `value` is checked.
 */
function scrubException(exception: Record<string, unknown>): Record<string, unknown> {
  const values = exception.values;
  if (!Array.isArray(values)) return { ...exception };
  return {
    ...exception,
    values: values.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const item = entry as Record<string, unknown>;
      return {
        ...item,
        ...(typeof item.value === 'string' ? { value: scrubString(item.value) } : {}),
      };
    }),
  };
}

export function scrubBreadcrumb(crumb: unknown): unknown {
  if (crumb === null || typeof crumb !== 'object') return crumb;
  const source = crumb as Record<string, unknown>;
  return {
    ...(typeof source.type === 'string' ? { type: source.type } : {}),
    ...(typeof source.category === 'string' ? { category: source.category } : {}),
    ...(typeof source.level === 'string' ? { level: source.level } : {}),
    ...(typeof source.timestamp === 'number' ? { timestamp: source.timestamp } : {}),
    ...(typeof source.message === 'string' ? { message: scrubString(source.message) } : {}),
    ...(source.data === undefined ? {} : { data: scrubValue(source.data) }),
  };
}
