# Release checklist

`PASS` verified in this environment · `MANUAL` needs a device or account · `BLOCKED`
cannot proceed · `N/A` not applicable

## Code

| Item            | Status      | Evidence                                                                          |
| --------------- | ----------- | --------------------------------------------------------------------------------- |
| Domain tests    | **PASS**    | 730 pass / 0 fail                                                                 |
| API tests       | **PASS**    | 90 pass / 0 fail                                                                  |
| Typecheck (app) | **PASS**    | `tsc --noEmit` clean                                                              |
| Typecheck (API) | **PASS**    | `tsc --noEmit` clean                                                              |
| Lint            | **PASS**    | `eslint . --max-warnings 0`                                                       |
| Format          | **PASS**    | `prettier --check .`                                                              |
| Secret scan     | **PASS**    | clean, 8 rules                                                                    |
| Version control | **BLOCKED** | **Not a git repository.** No commit SHA, no CI trigger, no #BuildInPublic history |

## Data

| Item                            | Status     | Evidence                                           |
| ------------------------------- | ---------- | -------------------------------------------------- |
| Real provider connected         | **PASS**   | Open Prices + OSM Nominatim/Overpass               |
| Tested location                 | **PASS**   | 94043 — 3 stores, 68 observations, 6 of 8 concepts |
| Negative location               | **PASS**   | 11201 — 0 of 8, zero provider failures             |
| Provenance on every observation | **PASS**   | `tests/realDataIntegration.test.ts`                |
| Partial-provider failure        | **PASS**   | Observed against a real Overpass 504               |
| Field basket (physical)         | **MANUAL** | No real shopping trip performed                    |

## Optimizer

| Item                 | Status   | Evidence                               |
| -------------------- | -------- | -------------------------------------- |
| Complete baseline    | **PASS** | `optimizerScenarios` S01–S17           |
| Juva Pick            | **PASS** | S02, S03                               |
| Worth the Trip       | **PASS** | 16 tests, verified live in browser     |
| Partial-plan refusal | **PASS** | `planExplanation.test.ts`              |
| Determinism          | **PASS** | Byte-identical across input reordering |

## Shop Mode

| Item                      | Status     | Evidence                                          |
| ------------------------- | ---------- | ------------------------------------------------- |
| Persistence               | **PASS**   | Survives reload; verified in browser              |
| Adaptation                | **PASS**   | 33 + 17 tests; verified live                      |
| Immutable origin          | **PASS**   | 19 tests; fingerprint unchanged after every event |
| Reload                    | **PASS**   | `proofLifecycle.test.ts`                          |
| Device hardware / haptics | **MANUAL** | Simulator cannot verify haptics                   |

## Receipt

| Item                       | Status     | Evidence                                |
| -------------------------- | ---------- | --------------------------------------- |
| Capture (code)             | **PASS**   | crop/rotate/compress/redact implemented |
| Capture (hardware)         | **MANUAL** | No camera testing performed             |
| Extraction                 | **PASS**   | Provider probe, 4 stages                |
| Reconciliation             | **PASS**   | 32 tests                                |
| Corrections                | **PASS**   | Append-only, 24 tests                   |
| Ledger + historical reload | **PASS**   | Byte-identical after restart            |

## RevenueCat

| Item                              | Status      | Evidence                                            |
| --------------------------------- | ----------- | --------------------------------------------------- |
| Canonical SubscriptionState       | **PASS**    | 12 wiring tests + repository grep guard             |
| Deterministic paywall context     | **PASS**    | $56.58 − $46.08 = $10.50                            |
| Test Store purchase               | **MANUAL**  | `docs/TEST_STORE_DEVICE_CHECKLIST.md` — **NOT RUN** |
| Cancellation / restore / relaunch | **MANUAL**  | Same gate                                           |
| Production store keys             | **BLOCKED** | No `appl_`/`goog_` keys configured                  |

## OneSignal

| Item                         | Status     | Evidence                                         |
| ---------------------------- | ---------- | ------------------------------------------------ |
| Journeys A–D logic           | **PASS**   | 49 tests across `journeys` + `planChangeJourney` |
| Journey D snapshot trigger   | **PASS**   | Compare-then-replace enforced                    |
| Registration / real delivery | **MANUAL** | Needs Apple Developer account or Android build   |
| Deep link round trip         | **MANUAL** | Same gate                                        |

## Analytics

| Item                              | Status                | Evidence                                                                            |
| --------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `/v1/events` live                 | **PASS**              | Exercised against the running server                                                |
| Server rejects sensitive payloads | **PASS**              | `forbidden_key` returned, nothing echoed                                            |
| Durable sink                      | **PASS (local only)** | NDJSON written and read back                                                        |
| Idempotency across restart        | **PASS**              | Same id after restart → `duplicates: 1`                                             |
| Retry / queue lifecycle           | **PASS**              | 12 tests                                                                            |
| **Production durable sink**       | **BLOCKED**           | `DEPLOYMENT BLOCKER: DURABLE_ANALYTICS_SINK` — local file is not multi-replica safe |

## Privacy

| Item                             | Status      | Evidence                                |
| -------------------------------- | ----------- | --------------------------------------- |
| Sentry scrubbing                 | **PASS**    | 23 tests, deny-by-default               |
| Analytics privacy                | **PASS**    | Structural — no type accepts free text  |
| Receipts excluded from telemetry | **PASS**    | Structural import test                  |
| Location precision               | **PASS**    | Postcode-first; GPS optional            |
| Sentry coverage                  | **13 / 17** | 4 documented exceptions — **not** 17/17 |

## Store

| Item                  | Status       | Evidence                                                                     |
| --------------------- | ------------ | ---------------------------------------------------------------------------- |
| Identifiers           | **PARTIAL**  | Profile-suffixed IDs exist; production ID unconfirmed against a store record |
| Production build      | **MANUAL**   | Never executed                                                               |
| Screenshots           | **MANUAL**   | Not produced                                                                 |
| Listing copy          | **NOT DONE** | `docs/STORE_LISTING.md` not written this pass                                |
| Review notes          | **NOT DONE** | Not written this pass                                                        |
| Privacy / support URL | **BLOCKED**  | No hosted URLs exist                                                         |
| Submission            | **BLOCKED**  | Depends on all of the above                                                  |

## Competition

| Item                                  | Status           | Evidence                                                                                              |
| ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Shipaton eligibility / release window | **NOT VERIFIED** | I did not fetch the official rules. Must be checked against the live source before any public release |
