# Sentry failure-class coverage

An audit, not a claim. Most rows below are **not captured**, and saying so is the point of
the document — an observability doc that overstates coverage is worse than none, because
it stops anyone looking again.

Captures go through `reportHandled(code, extra)` in `src/services/monitoring.ts`. Every
payload is scrubbed by `beforeSend` regardless of the caller, and the `extra` shape is
deliberately narrow (`string | number | boolean`) so a caller cannot attach an object
full of shopping data.

## Expected outcomes are not errors

These are normal product states and are **deliberately not captured**:

- A partial market — Juva reports reduced coverage by design
- A cancelled purchase — the shopper changed their mind
- Notification permission denied — a legitimate choice
- A blocked verification — the receipt layer working correctly
- No offering when purchases are disabled by configuration

Capturing them would bury real failures in noise and would make the Sentry issue count a
measure of how much Juva is used rather than how often it breaks.

## Coverage

| #   | Failure class                       | Code                                                                               | Location                             | Safe context                              | Status                                                                                    |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Retailer provider failure           | —                                                                                  | `services/api/src/retailers/`        | —                                         | **Not captured — justified.** The API process has no Sentry SDK                           |
| 2   | Provider timeout                    | —                                                                                  | `services/api/src/retailers/`        | —                                         | **Not captured — justified.** Same root cause                                             |
| 3   | Malformed provider response         | —                                                                                  | `domain/marketWire.ts`               | —                                         | **Not captured — justified.** Rows are dropped by design and surfaced as partial coverage |
| 4   | Optimizer failure                   | `optimizer.no_plans`                                                               | `JuvaProvider.optimizeActiveList`    | `storeCount`, `productCount`, `itemCount` | **Captured**                                                                              |
| 5   | Optimizer excessive duration        | —                                                                                  | —                                    | —                                         | **Not captured — justified.** Needs performance tracing; thresholds documented below      |
| 6   | Incomplete market (exceptional)     | `optimizer.no_plans`                                                               | as row 4                             | as row 4                                  | **Captured.** An ordinary partial market is deliberately not an error                     |
| 7   | Shop Mode adaptation failure        | `shop.adaptation_failed`                                                           | `JuvaProvider.planShelfChange`       | `tripId`, `eventKind`, `stopIndex`        | **Captured**                                                                              |
| 8   | Replan failure                      | `shop.replan_failed`                                                               | `JuvaProvider.applyShelfChange`      | `chosenOptionId`                          | **Captured**                                                                              |
| 9   | Origin integrity mismatch           | `trip.origin_integrity_mismatch`                                                   | `JuvaProvider.verifyActiveTrip`      | `tripId`, both fingerprints               | **Captured**                                                                              |
| 10  | Receipt capture failure             | `receipt.capture_failed`                                                           | `services/receiptImages.preparePage` | `operation`                               | **Captured**                                                                              |
| 11  | Receipt extraction failure          | `receipt.extraction_failed`                                                        | `services/vision.extractReceipt`     | `pageCount`                               | **Captured**                                                                              |
| 12  | Receipt reconciliation failure      | `receipt.reconciliation_failed`                                                    | `JuvaProvider.verifyActiveTrip`      | `tripId`                                  | **Captured.** Ambiguity is a product state, not reported                                  |
| 13  | Persistence failure                 | `persistence.read_failed`, `persistence.write_failed`, `persistence.corrupt_state` | `services/persistence.ts`            | `operation`, `entityKind`                 | **Captured**                                                                              |
| 14  | Migration failure                   | `migration.failed`, `persistence.unsupported_schema`                               | `services/persistence.loadJuvaState` | `operation`, `entityKind`, `recovered`    | **Captured**                                                                              |
| 15  | RevenueCat initialization failure   | `revenuecat.init_failed`                                                           | `RevenueCatProvider`                 | none                                      | **Captured**                                                                              |
| 16  | RevenueCat purchase/restore failure | `revenuecat.purchase_failed`                                                       | `RevenueCatProvider.purchase`        | `code`                                    | **Captured.** Cancellation is expected and is not reported                                |
| 17  | OneSignal registration failure      | `onesignal.registration_failed`                                                    | `services/pushJourneys.loadSdk`      | `platform`                                | **Captured**                                                                              |

**13 of 17 captured. 4 justified exceptions**, from two root causes:

- **Rows 1, 2, 3** are the API process or data-shape handling that is a product state
  rather than a failure. The API is a separate `node:http` service with no Sentry SDK;
  wiring one is a deployment decision, and reporting a server's failures from the client
  would report the wrong thing from the wrong place.
- **Row 5** needs Sentry performance tracing, which is not configured. Reporting a
  duration through `captureMessage` would be using the error channel as a metrics channel.

## Performance thresholds (documented, not instrumented)

Report only anomalous durations, never every successful call:

| Operation              | Threshold |
| ---------------------- | --------- |
| Market search          | > 8s      |
| Optimizer run          | > 2s      |
| Shop Mode replan       | > 500ms   |
| Receipt reconciliation | > 1s      |

## Privacy

Proven by test rather than asserted:

- `tests/privacyScrub.test.ts` — deny-by-default, allowlist/denylist disjointness, array
  length preserved while contents are scrubbed
- `tests/receiptPrivacy.test.ts` — no receipt-handling module can import a telemetry SDK;
  receipt images leave the device through exactly one function

Never sent: receipt contents or images, grocery item names, the basket, exact
coordinates, loyalty identifiers, payment fragments, OpenRouter prompts or responses,
secrets.

Sent instead: `tripId`, `providerId`, `storeCount`, `basketItemCount`,
`marketCompleteness`, `errorCode`, fingerprints (opaque 8-hex hashes).

## Session replay

Not enabled. Juva's sensitive screens — receipts, receipt review, history, basket detail,
location input, subscription — are most of the app, and masking that cannot be guaranteed
is worse than no replay at all.

## What to do next

Priority order, if this is picked up: 13 and 14 (a silent persistence failure loses a
shopper's trip), then 11, then 1–3 on the API side.
