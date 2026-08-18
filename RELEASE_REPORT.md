# Juva release report

One classification per system. Conservative by rule: anything not executed in this
environment is `MANUAL STEP REQUIRED`, never "verified".

## Classifications

| System                         | Classification       | Note                                                  |
| ------------------------------ | -------------------- | ----------------------------------------------------- |
| App startup / onboarding       | TESTED IN SIMULATOR  | Web build; all onboarding steps reachable             |
| Grocery composer / basket      | TESTED IN AUTOMATION | Interpreter tests + browser walkthrough               |
| Market search (demo)           | CONTROLLED DEMO ONLY | Deterministic 12-item, 3-store market                 |
| Market search (real)           | TESTED IN AUTOMATION | Open Prices at 94043; recorded payload fixture        |
| Optimizer                      | TESTED IN AUTOMATION | 17 named scenarios, deterministic                     |
| Worth the Trip                 | TESTED IN SIMULATOR  | Verified live in browser                              |
| Shop Mode + adaptation         | TESTED IN SIMULATOR  | Verified live; origin fingerprint unchanged           |
| Origin immutability            | TESTED IN AUTOMATION | 19 tests, freeze + fingerprint + snapshot             |
| Receipt capture                | MANUAL STEP REQUIRED | No camera hardware exercised                          |
| Receipt extraction             | TESTED IN AUTOMATION | Provider probe; live model call not re-run this pass  |
| Reconciliation                 | TESTED IN AUTOMATION | 32 tests                                              |
| Savings Ledger                 | TESTED IN AUTOMATION | Byte-identical after restart                          |
| RevenueCat wiring              | TESTED IN AUTOMATION | Canonical state + grep guard                          |
| RevenueCat Test Store purchase | MANUAL STEP REQUIRED | **Never executed**                                    |
| OneSignal Journeys A–D         | TESTED IN AUTOMATION | Logic only                                            |
| OneSignal delivery             | MANUAL STEP REQUIRED | **Never executed**                                    |
| Analytics pipeline             | VERIFIED             | Live against the running API, including restart dedup |
| Durable analytics sink         | BLOCKED              | Local file only; not multi-replica safe               |
| Sentry                         | TESTED IN AUTOMATION | **13 / 17**, 4 documented exceptions                  |
| Persistence / migration        | TESTED IN AUTOMATION | Plus new failure observability                        |
| Deep links                     | NOT IMPLEMENTED      | No audit performed this pass                          |
| Production API deployment      | NOT IMPLEMENTED      | No hosting configured                                 |
| Store listing / screenshots    | NOT IMPLEMENTED      | Not produced this pass                                |
| Version control                | BLOCKED              | **Not a git repository**                              |
| Shipaton eligibility check     | NOT IMPLEMENTED      | Official rules not consulted                          |

## Test results

| Suite                 | Result                |
| --------------------- | --------------------- |
| Domain                | **730 pass / 0 fail** |
| API                   | **90 pass / 0 fail**  |
| Typecheck (app + API) | clean                 |
| Lint                  | clean, zero warnings  |
| Format                | clean                 |
| Secret scan           | clean, 8 rules        |

## expo-doctor: 2 checks failed

| Finding                                    | Impact                                        | Observed in Juva?                        | Decision                                                                                                   |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Hermes V1 memory regression (expo 56.0.19) | Documented upstream memory regression         | **Not observed** in any run this session | **KNOWN / ACCEPTED.** Fix requires SDK 57; an SDK major during freeze is a larger risk than the regression |
| 8 patch-version mismatches                 | Patch drift (e.g. `expo` 56.0.19 vs ~56.0.20) | No symptoms                              | **KNOWN / ACCEPTED** for beta; run `npx expo install --fix` before a store build                           |

## Live analytics evidence

Against the Juva API on port 8791:

```
GET  /health           → {"ok":true,"service":"juva-api",...}
POST /v1/events valid  → {"received":1,"stored":1,"duplicates":0,"rejected":[]}
POST same id again     → {"received":1,"stored":0,"duplicates":1}
POST receiptText+lat   → {"stored":0,"rejected":[{"index":0,"reason":"forbidden_key"}]}
POST unknown event     → {"stored":0,"rejected":[{"index":0,"reason":"unknown_event"}]}

durable file:
{"eventId":"rel-1","eventName":"optimization_completed",...,"properties":{"planCount":4,"marketCompleteness":"complete"}}

after process restart, same id → {"stored":0,"duplicates":1}   file still 1 line
```

Nothing sensitive reached storage, and no rejected value was echoed.

## Release decision

# READY FOR BETA

The eleven beta gates hold: the app starts, the list → plan path works, demo works, one
real-data path works honestly, the optimizer is deterministic, Shop Mode persists,
adaptation cannot mutate the baseline, receipt verification works, the ledger persists,
sensitive data does not leak, and no P0 data-corruption or security bug is known.

**Not ready for public release.** Blocking, in order:

1. **Not a git repository.** No commit history, no CI trigger, no #BuildInPublic evidence.
2. **No RevenueCat native purchase ever executed.** Monetization is unproven end to end.
3. **No production API deployment.** The app has no backend to talk to.
4. **`DEPLOYMENT BLOCKER: DURABLE_ANALYTICS_SINK`** — local NDJSON is not production-safe.
5. **No store metadata, screenshots, listing, privacy or support URLs.**
6. **Native camera/receipt flow unverified.**
7. **Shipaton eligibility and release window unverified** against the official source.

Beta means a development build on devices you control, with testers who know the coverage
is narrow.
