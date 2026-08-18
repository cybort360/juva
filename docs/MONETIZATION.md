# Monetization

Juva Plus wraps around Juva's trust system. It never bends it: receipt truth, verified
savings and the integrity gate are identical for a free shopper and a subscriber.

## Free vs Juva Plus

**Free.** Everything needed to discover whether Juva was right.

- Grocery lists, natural-language input, location and store search
- Product comparison with full provenance
- The cheapest complete single-store plan
- Shop Mode, including in-store adaptation and offline replanning
- **Receipt capture, reconciliation and verified savings, in full**
- Savings history and the per-trip Savings Ledger

Receipt truth is deliberately not paywalled. A shopper must never have to pay to find out
that Juva's previous claim was wrong.

**Juva Plus.** Optimization breadth, not truth.

- Multi-store Juva Pick
- Unlimited lists and optimizations (free: `FREE_ITEM_LIMIT`, `FREE_OPTIMIZATIONS_PER_DAY`
  in `src/domain/entitlements.ts`)
- Extended history (free: `FREE_HISTORY_LIMIT`)
- Saved recurring baskets beyond `FREE_SAVED_LIST_LIMIT`

Nothing unimplemented is advertised. A Budget Agent is not offered because it does not
exist.

## RevenueCat configuration

|             |                             |
| ----------- | --------------------------- |
| Entitlement | `juva_plus`                 |
| Offering    | `default`                   |
| Packages    | `$rc_monthly`, `$rc_annual` |

Both packages grant `juva_plus`. No lifetime product participates in product logic.

## Key selection

`resolveRevenueCat` in `src/config/env.ts` picks the key from the environment and
platform, and reports issues rather than throwing.

| Environment        | Key used                                       |
| ------------------ | ---------------------------------------------- |
| development / demo | Test Store key, falling back to a platform key |
| preview            | Platform key only                              |
| production         | Platform key only                              |

**A production or preview build refuses to initialize with the Test Store key.** If the
resolved store key equals the Test Store key, the key is discarded, an `error` issue is
raised and purchases are disabled — rather than shipping a build that takes fake money.

Keys are public SDK keys and are the only RevenueCat credentials in the bundle. No secret
key is present; `scripts/secret-scan.mjs` enforces this.

## Subscription state

`src/domain/subscription.ts` derives one canonical state from RevenueCat's answer:

`unknown | free | plus | purchase_pending | offline_cached_plus | billing_unavailable`

Screens read `grantsPlus()` and `canOfferPurchase()` rather than combining `hasPlus`,
`status` and `error` for themselves.

The distinction that matters is `billing_unavailable` versus `free`: a shopper whose
entitlement could not be checked has not been downgraded. Only `free` may be offered a
purchase, so an entitlement that has not loaded can never paywall an existing subscriber.

## Value-based paywall

The paywall renders `PaywallValueContext` (`src/domain/paywallValue.ts`) and computes
nothing itself. The context is produced only when:

- the shopper does not already have Plus
- both the free baseline plan and the locked plan are `comparisonEligible`
- the baseline kind is not `none`
- `potentialSavingsCents > 0`
- the locked plan's confidence is at least `MIN_PAYWALL_CONFIDENCE` (0.7)

Otherwise a typed refusal is returned and the paywall shows neutral copy. There is no
example figure in real mode.

`potentialSavingsCents === baselineCostCents − lockedPlanCostCents`, asserted both in
`paywallValueIsSound()` and in tests. Lifetime estimated savings and receipt-verified
savings are never used as paywall metrics.

## Restore

Reachable from the paywall, Settings and the subscription screen. A restore is only
reported as successful when `juva_plus` is active afterwards.

## Offline behaviour

The last _positive_ live entitlement is cached (`juva.entitlement.v1`). A cached grant
yields `offline_cached_plus`, which unlocks Plus. A cached `false` grants nothing — it
means "not subscribed when we last looked", not "not subscribed now". There is no
permanent offline Plus.

An active trip is independent of billing refresh: Shop Mode replans from the trip's own
cached market and makes no network call.

## Known billing limitations

- Real iOS and Android store purchases are unverified. Only the RevenueCat Test Store
  path has been exercised.
- `appl_` / `goog_` production keys are not configured in this repository.
- Customer Center availability is probed at runtime; where the installed SDK does not
  support it, the store's management URL is used instead.
