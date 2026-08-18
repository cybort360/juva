# RevenueCat Test Store device checklist

**This checklist is the release gate for purchases.** The automated lifecycle test
(`tests/commercialLifecycle.test.ts`) uses a fake adapter at the same application-facing
boundary as the real one. It proves Juva's integration — that the paywall figure is the
optimizer's, that entitlement flows through the canonical state, that the exact locked
plan unlocks. It proves **nothing whatsoever** about the RevenueCat SDK, the store UI, or
a real transaction.

Nothing below may be marked passed from a simulator or a mock.

## Prerequisites

- A **development build** (not Expo Go — `react-native-purchases` has no native module there)
- `EXPO_PUBLIC_REVENUECAT_TEST_API_KEY` set, and `JUVA_ENV` set to `development` or `demo`
  (production and preview builds refuse the Test Store key by design)
- RevenueCat dashboard access to confirm the customer and transaction

## Record for each run

| Field                                         | Value |
| --------------------------------------------- | ----- |
| Device                                        |       |
| OS version                                    |       |
| App build / commit                            |       |
| Environment (`JUVA_ENV`)                      |       |
| RevenueCat app user ID                        |       |
| Package tested (`$rc_monthly` / `$rc_annual`) |       |
| Date and time                                 |       |
| Evidence (screenshot / recording reference)   |       |

## Steps

| #   | Step                                              | Expected                                                                                        | Result |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| 1   | Launch the app                                    | Diagnostics shows RevenueCat `ready`, subscription state `free`                                 | ☐      |
| 2   | Check the offering                                | `default` offering loads                                                                        | ☐      |
| 3   | Check packages                                    | Both `$rc_monthly` and `$rc_annual` are present and priced                                      | ☐      |
| 4   | Build a basket that produces a multi-store plan   | Paywall shows a personalized "Juva found another $X"                                            | ☐      |
| 5   | Record the exact `$X` and the locked plan's cost  | Note both here →                                                                                |        |
| 6   | Tap a package                                     | The store's purchase sheet appears                                                              | ☐      |
| 7   | **Cancel** the sheet                              | Copy says cancelled, nothing charged; **no error state**; state stays `free`; plan stays locked | ☐      |
| 8   | Tap again and **complete** the purchase           | Purchase succeeds                                                                               | ☐      |
| 9   | Observe entitlement                               | Subscription state becomes `plus`; diagnostics shows it                                         | ☐      |
| 10  | Observe the unlock                                | The **same** plan from step 5 unlocks, at the **same** cost — not a recomputed one              | ☐      |
| 11  | Confirm in the RevenueCat dashboard               | The customer and transaction appear                                                             | ☐      |
| 12  | Force-quit and relaunch                           | State resolves to `plus` again                                                                  | ☐      |
| 13  | Enable airplane mode and relaunch                 | State is `offline_cached_plus`; Plus features remain                                            | ☐      |
| 14  | Restore Purchases (from the paywall)              | Reports restored; state `plus`                                                                  | ☐      |
| 15  | Restore on a fresh install with no purchase       | Reports nothing found; state stays `free`; **no false success**                                 | ☐      |
| 16  | Open Customer Center / subscription management    | Opens, or falls back to the store management URL                                                | ☐      |
| 17  | Start Shop Mode and enable airplane mode mid-trip | The trip stays fully usable; replanning still works                                             | ☐      |

## Platform notes

**iOS.** A StoreKit configuration file or a sandbox Apple ID is required. Ask to Buy
produces the `pending` outcome — worth exercising, since it is the one path where a
purchase succeeds at the SDK level and grants nothing until the entitlement arrives.

**Android.** A license-tested account on an internal testing track. Deferred billing also
lands on the `pending` path.

## Sign-off

|                 |                         |
| --------------- | ----------------------- |
| Tested by       |                         |
| Date            |                         |
| iOS result      | ☐ pass ☐ fail ☐ not run |
| Android result  | ☐ pass ☐ fail ☐ not run |
| Blocking issues |                         |

**Status as of this commit: NOT RUN.** No real purchase has been executed on any device.
