# Observability

Sentry observes failures. It is not product analytics, and it never receives shopping
data.

## What Sentry captures

Technical failure classes, reported through `reportHandled` in
`src/services/monitoring.ts`:

- Retailer provider failure, timeout, malformed response
- Optimizer failure and incomplete-market failure
- Shop Mode adaptation and replan failure
- Origin integrity mismatch
- Receipt capture, extraction and reconciliation failure
- Persistence and migration failure
- RevenueCat initialization, offering fetch, purchase and restore failure
- OneSignal registration failure

## Privacy scrubbing

`src/services/privacyScrub.ts` is **deny-by-default**: a key must match the allowlist to
survive, and the deny pattern is applied on top. Two invariants are unit-tested — the
allowlist never intersects the denylist, and array lengths are preserved while contents
are scrubbed.

Blocked: receipt images and OCR text, barcodes, product and item names, basket contents,
prices and totals, addresses, coordinates, model prompts and completions, tokens, keys,
emails, phone numbers.

Allowed diagnostic context: `providerId`, `storeCount`, `basketItemCount`, `lineCount`,
`marketCompleteness`, `optimizerPlanCount`, `tripId`, `errorCode`, `platform`.

Two bugs this design caught during development: `itemCount` was allowlisted while
matching the `item` deny pattern, and a bare `lat` token matched `platform`.

A structural test asserts that no receipt-handling module can even import a telemetry
SDK, and that receipt images leave the device through exactly one function.

## Session replay

Not enabled. Juva's sensitive screens — receipts, receipt review, history, basket detail,
location input, subscription — are most of the app, and masking that cannot be guaranteed
is worse than no replay.

## Product analytics

`src/domain/analytics.ts` defines a closed event vocabulary and a closed property value
type. Properties are `number | boolean | enum` only: there is no way to attach free text,
so there is no way to attach a receipt line, a product name or an address.

Money is reported as a band (`savingsBand`), never an amount — an exact saving plus a
timestamp is a fingerprint. Counts are banded the same way.

`sanitizeProperties` is the runtime backstop for untyped boundaries. It returns what it
rejected as well as what it kept, so tests assert on the rejections rather than merely
observing clean output.

**Verification outcomes are not collapsed.** `verificationEventFor` maps `verified` to
`receipt_verification_completed`, `pending` and `blocked` to
`receipt_verification_blocked`, and `integrity_failed` to `receipt_integrity_failed`. An
integrity failure is never reported as a verified completion, which is what stops the
verification rate from being flattered.

## Diagnostics

`/diagnostics` is development-only and is not routed in production builds. It shows build
mode, API environment, market mode, provider health, RevenueCat and OneSignal state,
Sentry environment, active trip id and origin integrity. It never shows keys, secrets,
receipt contents or loyalty data.
