# Commercial evidence

Every monetary claim Juva makes must be traceable to deterministic evidence. This
document is the contract: what each claim is, and what has to exist for it to be made.

## Claim / evidence contract

| Claim                                | Evidence required                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| "Local price: $3.49"                 | `PriceObservation` — provider, store, `sourceIdentifier`, `observedAt`, derived `freshness`, confidence                                     |
| "Cheapest single-store plan: $56.58" | Market snapshot, plan `completeness.comparisonEligible`, the plan's own `explanation`                                                       |
| "Juva found another $10.50"          | `PaywallValueContext` — a valid baseline plan id, a locked plan id, and `potentialSavingsCents === baselineCostCents − lockedPlanCostCents` |
| "Verified saving: $8.67"             | `SavingsLedger` with `claimability.state === 'verified'` — immutable origin, intact fingerprint, receipts, reconciliation, corrections      |
| "Juva Plus active"                   | RevenueCat `CustomerInfo` reporting `juva_plus` active, or a cached prior positive                                                          |

An LLM response is never evidence. Models interpret lists, match products and transcribe
receipts; every figure above is integer-cent arithmetic over observed values.

## Estimated versus verified

These are different claims about different things and are never summed, substituted or
shown as one number.

**Estimated savings** — what the optimizer expects, before shopping. Baseline minus
planned basket. Exists the moment a plan does.

**Verified savings** — what a receipt proved. `origin.comparedBaselineCents` minus actual
eligible spend, computed only when `claimability.blockers` is empty.

A blocked or integrity-failed verification is **not** `$0` verified savings.
`verifiedSavingsCents` is `undefined` in those states, and the UI shows the state and its
reasons instead of a figure. Only receipt-confirmed trips contribute to the lifetime
verified total.

## Evidence strength

Not all receipt evidence is equal, and the distinctions are preserved rather than
flattened:

| Source              | Meaning                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `provider_observed` | A price Juva saw in market data                                                                        |
| `user_reported`     | A shelf correction or hand-typed substitute — evidence, not observation; carries no retailer promotion |
| `receipt_verified`  | Confirmed by a receipt line                                                                            |

A hand-typed substitute is promoted to `receipt_verified` only on an exact identifier
match or the shopper's own confirmation — never on text similarity. A manual-total-only
receipt yields `assumed_planned` lines and is never equivalent to a line-verified
receipt.

Legacy `SavingsRecord`s written before ledger persistence have no ledger and no "View
verification" route. No ledger is fabricated for them.

## Funnel definitions

Definitions only. No dashboard exists, and none should before there are real users.

| Stage          | Definition                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Activation     | Shopper reaches a first valid grocery plan (`optimization_completed` with at least one comparison-eligible plan) |
| Core value     | Shopper is shown a complete Juva recommendation (`single_store_plan_seen`)                                       |
| Execution      | Shopper starts Shop Mode (`shop_mode_started`)                                                                   |
| Proof          | Shopper completes receipt verification (`receipt_verification_completed`)                                        |
| Monetization   | Shopper sees a value-based paywall (`paywall_seen` with `paywall_value_context_present`)                         |
| Conversion     | `juva_plus` activates (`purchase_completed`)                                                                     |
| Retention      | Shopper returns for another basket or trip                                                                       |
| Verified value | Receipt-confirmed savings (`verified_savings_created`)                                                           |

### Rates

```
optimization_completion_rate = valid completed optimizations / optimization starts
verification_rate            = receipt-confirmed trips / completed shopping trips
paywall_conversion           = juva_plus activations / eligible value-paywall impressions
```

"Eligible" is load-bearing: an impression only counts when a `PaywallValueContext` was
present. A neutral paywall shown because the market was partial is not a missed
conversion, and counting it as one would create pressure to loosen the honesty gates.

## Automated versus native evidence

These are different kinds of proof and are never presented as one.

### Verified in code — automated, deterministic, re-runnable

| Proven                                                                       | Where                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Paywall arithmetic reconciles to optimizer output                            | `tests/commercial.test.ts`                                          |
| `PaywallValueContext` refuses partial / low-confidence / zero-saving markets | `tests/commercial.test.ts`                                          |
| Every subscription-state transition                                          | `tests/subscriptionWiring.test.ts`                                  |
| No screen derives entitlement independently (repository grep)                | `tests/subscriptionWiring.test.ts`                                  |
| Premium gating routes through `grantsPlus`                                   | `tests/subscriptionWiring.test.ts`                                  |
| Event emission from real transitions, and their ordering                     | `tests/commercialLifecycle.test.ts`                                 |
| Analytics privacy — sensitive fields cannot escape                           | `tests/commercial.test.ts`                                          |
| Analytics failure cannot break the product loop                              | `tests/commercialLifecycle.test.ts`                                 |
| The exact locked plan unlocks after purchase                                 | `tests/commercialLifecycle.test.ts`                                 |
| Verified savings independent of the paywall estimate                         | `tests/commercialLifecycle.test.ts`                                 |
| Ledger identical after restart                                               | `tests/commercialLifecycle.test.ts`, `tests/proofLifecycle.test.ts` |

The purchase leg of these tests uses a **fake adapter**. It implements the same
application-facing boundary as the real one and proves Juva's integration around it.

### Requires a native device — not yet performed

| Unproven                                        | Gate                                           |
| ----------------------------------------------- | ---------------------------------------------- |
| RevenueCat SDK configuration on a real build    | `docs/TEST_STORE_DEVICE_CHECKLIST.md`          |
| Test Store purchase UI                          | same                                           |
| An actual purchase transaction                  | same                                           |
| An entitlement genuinely returned by RevenueCat | same                                           |
| Restore against a real account                  | same                                           |
| Customer Center / subscription management       | same                                           |
| Push notification delivery                      | manual, needs Apple Developer or Android build |

**A mock is not evidence that a real store purchase succeeded.** As of this commit, no
real purchase has been executed on any device.

## What must never happen

- A paywall figure that is not the subtraction of two plans the optimizer generated
- Lifetime estimated or verified savings used as a paywall metric
- A blocked verification counted toward lifetime verified savings
- An integrity failure emitted as a verified-savings event
- Receipt-derived observations written into the shared Price Graph (see
  `RECEIPT_OBSERVATIONS_ARE_LOCAL_ONLY`)
