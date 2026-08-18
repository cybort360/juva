# Juva

**Juva is an agentic grocery shopping optimizer.** A shopper describes what they need, Juva searches normalized local price sources, evaluates basket and travel tradeoffs, guides the trip, then verifies actual savings from receipts.

The key product rule is simple: AI may interpret language, product names and receipts, but deterministic code owns final prices, arithmetic and savings.

## What is built

The repository contains a working Expo/React Native product shell with:

- onboarding for area, travel radius, maximum stores and brand flexibility;
- a natural-language grocery composer;
- editable basket review;
- an animated live-market orchestration experience;
- deterministic single-store, recommended multi-store and absolute-cheapest optimization;
- promotion eligibility checks for the controlled market;
- travel/time/extra-stop cost scoring;
- an itemized plan and route view;
- Shop Mode with offline-friendly local trip state, a swipe-to-collect checklist and in-store price corrections;
- receipt verification: multi-page capture, on-device free-form crop and rotate for redaction, compression, and manual total entry as a first-class fallback;
- server-side-only OpenRouter extraction that transcribes receipts and is structurally unable to judge savings;
- deterministic reconciliation of planned items against receipt lines, which surfaces ambiguity for confirmation rather than guessing;
- shopper-controlled receipt-image retention (none / 7 / 30 days) with explicit deletion;
- verified savings that count only receipt-confirmed trips;
- verified-savings history and saved recurring baskets;
- RevenueCat `juva_plus` entitlement integration with `$rc_monthly` and `$rc_annual` packages;
- subscription management that reads the live entitlement and links out to the billing store, because Juva cannot cancel on the store's behalf;
- one local notification — a reminder to verify a finished trip. There is no push server, so no price-drop or deal alerts are offered;
- a privacy-aware Node API boundary for receipt extraction and normalized retailer feeds;
- a fully deterministic controlled market so the complete product flow works without retailer credentials.

The controlled market uses fictional retailers. It is intentionally labeled demo data and never contributes to real-world claims.

## Instant design preview

Open `preview/index.html` directly in a browser. It is a standalone interactive phone preview of the composer → live market → best plan → Shop Mode → receipt verification → verified-savings flow and requires no npm install.

## Stack

- Expo SDK 56
- React Native 0.85
- TypeScript
- Expo Router
- Expo Camera
- AsyncStorage + SecureStore
- RevenueCat React Native SDK
- optional OpenRouter receipt extraction
- Node HTTP API

## Run the mobile app

```bash
cp .env.example .env
npm install
npx expo install --fix
npm run verify
npx expo start
```

With the shipped `.env.example` defaults (`EXPO_PUBLIC_JUVA_ENV=demo`) the app runs
entirely offline against the controlled market. No API, no RevenueCat key and no
network access are required to reach every screen.

### Scripts

| Script              | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `npm run lint`      | ESLint (Expo flat config + Prettier), zero warnings tolerated  |
| `npm run typecheck` | Strict `tsc --noEmit` for the app and for `services/api`       |
| `npm test`          | Compiles the domain/config/util layer, runs `node:test` suites |
| `npm run verify`    | `lint` → `typecheck` → `test`                                  |
| `npm run doctor`    | `expo-doctor`                                                  |
| `npm run prebuild`  | Regenerates `ios/` and `android/` (both gitignored)            |
| `npm run format`    | Prettier write                                                 |

## Environment profiles

`EXPO_PUBLIC_JUVA_ENV` selects one of four profiles, resolved and validated by
`src/config/env.ts`:

| Profile       | Market                       | Transport      | RevenueCat                             | App identity                    |
| ------------- | ---------------------------- | -------------- | -------------------------------------- | ------------------------------- |
| `demo`        | always the controlled market | n/a            | Test Store if present, else disabled   | Juva Demo, `…mobile.demo`       |
| `development` | demo or remote               | http allowed   | Test Store preferred                   | Juva Dev, `…mobile.dev`         |
| `preview`     | demo or remote               | https required | store key required                     | Juva Preview, `…mobile.preview` |
| `production`  | demo or remote               | https required | store key required, Test Store refused | Juva, `com.juva.mobile`         |

Per-profile values live in `eas.json`. Distinct names and bundle identifiers let a
demo, preview and store build coexist on one device without sharing local data.

Validation never throws: it records issues that the Preferences screen displays,
so a misconfigured build still launches. Two rules are enforced rather than warned
about:

- a RevenueCat Test Store key is refused in `preview`/`production` builds;
- if remote market mode is requested without a usable API URL, Juva falls back to
  the demo market **and** records a blocking issue — presenting demo prices as a
  live lookup is not an acceptable degradation.

Secrets belong in EAS secrets or `services/api/.env`, never in `eas.json` and never
in an `EXPO_PUBLIC_*` variable: those are readable by anyone who installs the app.

For a RevenueCat Test Store transaction, use an Expo development build rather than relying on Expo Go preview mode:

```bash
eas build --profile development --platform android
# or
eas build --profile development --platform ios
```

Add the public RevenueCat Test Store SDK key to:

```env
EXPO_PUBLIC_JUVA_ENV=development
EXPO_PUBLIC_REVENUECAT_TEST_API_KEY=...
```

Juva checks the `juva_plus` entitlement and only displays RevenueCat packages `$rc_monthly` and `$rc_annual`.

## Run the API

```bash
cd services/api
cp .env.example .env
npm install
npm run dev
```

The API exposes:

- `GET /health`
- `POST /v1/market/search`
- `POST /v1/extract/receipt`

### Market data contract

Juva does not assume it is permitted to scrape arbitrary retailer websites. The API accepts authorized normalized retailer feeds configured through `JUVA_RETAILER_FEEDS_JSON`.

Each configured feed receives:

```json
{
  "concepts": ["milk", "eggs", "rice"],
  "location": { "postalCode": "11201" },
  "radiusMiles": 5,
  "currency": "USD"
}
```

and returns normalized `stores` and `products`. See `docs/RETAILER_ADAPTERS.md`.

Set `EXPO_PUBLIC_MARKET_MODE=remote` once real retailer adapters are available. In `demo` mode the mobile app runs against the included controlled market.

Feed responses also report `coverage` (`feedsQueried`, `feedsSucceeded`, `failedFeeds`).
A partially failed fan-out can make a basket look cheaper or more complete than it
is, so the failure is reported rather than silently dropped.

## Real retailer data

One real price source is connected: **Open Food Facts Open Prices**, joined to
OpenStreetMap for store geography. It is community-contributed, not
retailer-authorised, and its useful coverage is a handful of areas — Juva makes **no
national or global coverage claim**.

```env
JUVA_RETAILER_ADAPTERS=open_prices
JUVA_CONTACT_USER_AGENT=Juva/0.2 (you@example.com)
```

Adapters are opt-in, so adding one to the codebase never changes what a running
deployment queries. Verify a real setup with:

```bash
npm --prefix services/api run live-check
```

Connected sources, the measured capability matrix, known limitations, rate limits
and how to add another retailer are documented in
[docs/REAL_DATA.md](docs/REAL_DATA.md).

A real-mode basket is usually **partially priced**. Juva names the items it could
not price and leaves them out of the total rather than estimating them, substituting
another store's price, or falling back to demo data.

## Price provenance

Every observation carries a `freshness` value, and `demo` is one of them. Demo
observations are labelled `DEMO` wherever a price appears; no code path can render
controlled-market data as `LIVE`. The searching screen reports counts taken from the
snapshot the optimizer actually saw (listings in range, matches, promotions checked,
store combinations) rather than estimating them.

## Deterministic planning engine

Four focused modules: `matching.ts` (canonical concepts, brand policy, currency),
`quantity.ts` (unit normalization, unit price, pack size, weighed goods),
`pricing.ts` (promotions, multibuy, line totals) and `optimizer.ts` (assignment,
plan kinds, scoring, explanations).

Juva generates up to five plans — cheapest complete single-store, cheapest complete
multi-store, the recommendation, lowest-effort, and a strict-budget plan when the
list has a budget. A kind is **absent when it genuinely does not exist** rather than
filled with a near miss.

The recommendation is scored as:

```text
basket cost
+ ( estimated travel cost + travel time + extra-stop penalty ) x effortWeight
+ stale-data penalty
+ missing-item penalty
```

`effortWeight` is `2 x conveniencePreference`: 0 chases the cheapest basket, 0.5 is
neutral, 1 doubles the weight on effort. Only `basket cost` is money the shopper
pays; the rest are planning costs that rank plans and never enter a total or a
saving. The plan screen shows the full breakdown so a recommendation is auditable.

Promotions apply only when every stated condition holds — right retailer, not
expired, loyalty card held, quantity threshold met, no condition Juva cannot verify.
Multibuy charges whole qualifying groups and the remainder at shelf price, and Juva
never adds a pack you did not ask for to unlock an offer. An offer that could not be
applied is shown with its reason instead of disappearing.

Unfilled lines are reported with a reason, contribute nothing to the total, and
suppress the savings claim. Final basket totals and savings do not come from an LLM.

The **Worth the Trip?** control on the plan screen changes maximum stores, the
price-versus-convenience priority and transport mode, and genuinely re-runs the
optimizer over the same observed prices — the plan set, ranking and every figure are
rebuilt rather than re-labelled.

Savings are attributed to observed causes, never estimated. The three figures on the
verified-trip screen answer different questions and deliberately do not sum:
store selection is measured against the cheapest complete single-store basket,
promotions against observed shelf price, substitutions against the requested brand
at the same store.

Run the domain tests:

```bash
npm test
```

## Receipt verification

During Shop Mode the user can record in-store price changes. At verification time they can either:

1. scan a receipt through the optional OpenRouter API; or
2. enter each store's actual receipt total manually.

Juva compares the actual total with the pre-trip cheapest complete single-store baseline. Projected and receipt-verified savings are stored separately by design.

## Important current boundary

This repository is a full product implementation around a deterministic controlled market plus a production data-adapter boundary. It does **not** pretend that arbitrary retailer coverage is already solved. Real store-specific price coverage requires authorized APIs, affiliate feeds, retailer partnerships or other permitted sources connected through the adapter contract.

See:

- `docs/ARCHITECTURE.md`
- `docs/PRODUCT.md`
- `docs/RETAILER_ADAPTERS.md`
- `docs/PRIVACY.md`
- `docs/SHIPATON_EVIDENCE.md`
