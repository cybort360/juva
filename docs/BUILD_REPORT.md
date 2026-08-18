# Juva Build Report

## Implemented

- Full Expo Router screen flow: onboarding, composer, basket review, live search, optimized plan, Shop Mode, receipt verification, verified result, history, profile, settings and paywall.
- Custom Juva Rail navigation/status surface instead of a stock tab bar.
- Animated market-search states and animated monetary reveal.
- Deterministic optimizer with store-combination search, promotion conditions, brand preference penalties, travel cost, time cost and extra-stop penalty.
- Controlled 3-store / 12-item market where the recommended 2-store basket is cheaper than the cheapest complete single-store basket while a third stop saves too little to justify the effort.
- Local persisted app state.
- Manual in-store price corrections.
- Receipt-total verification plus optional OpenRouter structured receipt extraction.
- RevenueCat `juva_plus` integration and value-based multi-store paywall boundary.
- Remote normalized retailer feed API contract.
- Standalone interactive HTML product preview.

## Engineering pass

Dependency and configuration work:

- Reconciled every dependency to Expo SDK 56 via `npx expo install --fix`. `react-dom` was undeclared, so npm resolved it to a version demanding `react@^19.2.8` against the pinned `react@19.2.3` and installation failed outright; declaring `react-dom@19.2.3` and `react-native-web@~0.21.0` fixed it without `--legacy-peer-deps`.
- Removed the unused `ts-node` dependency.
- Added ESLint (Expo flat config + Prettier), Prettier, and `lint` / `typecheck` / `test` / `verify` / `doctor` / `prebuild` scripts.
- Enabled `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax` on top of the existing `strict` + `noUncheckedIndexedAccess`, for the app, the API service and the domain test project.
- Split configuration into `demo` / `development` / `preview` / `production` profiles with per-profile app names, bundle identifiers and EAS channels.
- Added non-throwing environment validation, an Expo Router `ErrorBoundary`, a `+not-found` route, a shared loading state and a hydration gate.
- Widened `.gitignore` to cover generated native projects, build output and signing material.

Correctness fixes found during the pass:

- `shop.tsx` called `useMemo` below two conditional early returns. React matches hooks by call order, so the hook count changed the moment a trip began beneath the screen; every hook now runs before any return.
- The optimizer imported `demoPromotions` directly, so promotions silently disappeared in remote market mode. Promotions now travel with the market snapshot.
- Savings attribution used invented constants (70 cents per promotion, 110 per substitution). It is now computed from observed price deltas, and the three figures are labelled with their different bases instead of implying they sum.
- Plan ids were not unique across plan kinds, so selecting a plan card could select a different plan with the same id. Ids now include the kind.
- `decimalToCents` used `Math.round(Number(value) * 100)`, which returns 100 rather than 101 for `"1.005"` because 1.005 has no exact binary representation. Money is now parsed digit-wise, never through a float.
- The searching screen displayed fabricated counts derived from basket size (`items * 9 + 12` "listings found") and hardcoded demo retailer names, while labelling the demo market `LIVE MARKET`. It now reports snapshot counts and labels demo data `DEMO MARKET`.
- Demo observations carried `freshness: 'live'`. `demo` is now a `Freshness` value and renders as `DEMO`.
- The "worth the trip?" panel claimed the cheapest plan "saves only $0.00 more" and "adds about 0 minutes" whenever the recommendation already was the cheapest plan. It now states that case directly.
- `SavingsNumber` mirrored an `Animated.Value` listener into React state to render text. Where frames are suspended — a backgrounded tab or an app that is not foregrounded — no frame ever arrives and the figure stayed at `$0.00`; this was reproduced in a hidden browser tab. The reveal is now derived during render from a fraction that a timer forces to completion, so the amount is correct whether or not frames run.
- Receipt line matching could attribute one receipt line to several planned items; each line is now consumed once.
- Replaced `router.push(path as never)` casts with literal typed routes, dropped unsafe `as string` casts, removed duplicated colour aliases, and removed dead types and fields (`SearchEvent`, `PriceObservation.unitPriceCents`, `OptimizedPlan.missingItemIds`).
- Screens hardcoded `'USD'` in place of the basket currency; they now use it.
- `getOrCreateAppUserId` used SecureStore unconditionally, which has no web implementation; web falls back to AsyncStorage.
- Persisted state is validated structurally on read, written debounced instead of once per keystroke, and keyed `v3` so pre-existing payloads are discarded rather than half-migrated.

## Executed validation

All of the following were run in this environment:

```text
npm install                                   clean install, 0 peer conflicts
npx expo install --fix                        no version changes required afterwards
npx expo-doctor                               21/21 checks passed
npm run lint                                  0 errors, 0 warnings
npm run typecheck                             0 errors (app + services/api)
npm test                                      56/56 domain tests passed
npx expo export --platform web                bundled 879 modules, no resolution errors
npx expo prebuild --clean --platform all      ios/ and android/ generated, no warnings
```

`expo prebuild` reports that SDK 57 is available. Staying on SDK 56 is intentional and
is the target of this pass; nothing else is unexplained.

Native identity resolution was confirmed from generated output: `EXPO_PUBLIC_JUVA_ENV=demo`
produced app name `Juva Demo` and bundle identifier `com.juva.mobile.demo`.

### Demo flow driven end to end

The exported web build was served and driven through the whole product path:
onboarding → composer → demo basket (12 items) → search → plan → plan switching →
Shop Mode (12/12 collected) → verify (manual total) → verified result.

Observed figures, with arithmetic checked by hand:

```text
one stop:           $56.58   1 store   North Market
recommended:        $46.08   2 stores  Grove $16.47 + North $29.61   save $10.50
absolute cheapest:  $44.78   3 stores                                save $11.80
worth the trip:     cheapest saves $1.30 more for ~20 extra minutes
every price line:   labelled DEMO
verification:       baseline $56.58, paid $50.00, verified saving $6.58
attribution:        store selection $0.00 (this is the baseline), promotions $0.00
                    (the 2-for cereal offer correctly not applied to one unit),
                    substitutions $0.00 (requested brand was in stock)
```

Purchases were unconfigured throughout, and the free one-stop plan remained fully
shoppable, confirming that Juva launches and works with no external service present.

## Not verified here

- No iOS or Android binary was compiled; `prebuild` generates the native projects but Xcode/Gradle builds were not run.
- No real RevenueCat purchase was executed. That needs a development build and a Test Store key.
- No real retailer feed was contacted. Remote market mode is exercised only by its contract and validation paths, not against a live authorized feed.
