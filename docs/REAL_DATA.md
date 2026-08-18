# Juva real retailer data

This document describes Juva's real price sources: what is connected, what those
sources can and cannot answer, and how to add another one.

**Scope claim, stated plainly:** Juva has **no national or global grocery
coverage**, and no retailer partnership. One real source is connected, it is
community-contributed rather than retailer-authorised, and its useful coverage is a
handful of areas. Everything below is written to keep that accurate.

---

## 1. Connected sources

| Source                                                            | Role                               | Credentials    | Automated access          |
| ----------------------------------------------------------------- | ---------------------------------- | -------------- | ------------------------- |
| [Open Food Facts — Open Prices](https://prices.openfoodfacts.org) | prices, promotions, product detail | none for reads | permitted public API      |
| [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org)    | postcode → coordinates             | none           | permitted, policy-limited |
| [OpenStreetMap Overpass](https://overpass-api.de)                 | grocery stores near coordinates    | none           | permitted, policy-limited |

### Why the geography and the prices come from different places

Open Prices attributes every price to an OpenStreetMap store, but its
`/locations` endpoint has **no coordinate, radius or postcode filter**. So Juva
uses OSM as the authority for _where_ a store is, and Open Prices as the authority
for _what something costs there_, joined on `osm_id`/`osm_type`.

That split is what makes the locality rule enforceable: a price is only ever
attributed to the exact OSM store it was observed at.

> A measured trap worth knowing: the Open Prices list endpoints **silently ignore
> unsupported query parameters**. `osm_address_country_code=US` returns French
> stores and the unfiltered total. Never assume a filter worked — verify the
> records that come back. The adapter re-checks the `location` each item echoes and
> discards anything that does not match the store it asked about.

---

## 2. Capability matrix

Served live at `GET /v1/retailers/capabilities`, generated from the adapters so it
cannot drift from the code. Each value was checked against the live API.

| Capability               | Open Prices      | Notes                                                                                        |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------------- |
| Pricing                  | ✅               | Integer minor units, multiple currencies.                                                    |
| Local-store pricing      | ✅               | Every price is bound to one OSM store.                                                       |
| Inventory / availability | ❌               | No stock concept exists. Availability is reported as `unknown`, never assumed `in_stock`.    |
| Promotions               | ✅               | `price_is_discounted`, `price_without_discount`, `discount_type`.                            |
| Loyalty pricing          | ✅               | `discount_type = LOYALTY_PROGRAM`; applied only when the shopper holds that retailer's card. |
| Product details          | ✅               | Barcode, name, brand, quantity, category tags.                                               |
| `observedAt` provided    | ✅               | Per-price observation date.                                                                  |
| `expiresAt` provided     | ❌               | No expiry, so `expiresAt` is omitted rather than invented.                                   |
| Typical freshness        | `mixed_or_stale` | Ranges from days to well over a year.                                                        |

---

## 3. Known limitations

These are measured, not estimated.

**Coverage is narrow and uneven.**

- 333 locations in the United States, concentrated in a few Bay Area postcodes
  (94040, 94043, 94086, 94022). Safeway Mountain View (`WAY 35603394`) is the
  best-covered US store with roughly 9,972 prices.
- France is much better covered (121 locations in Grenoble alone).
- Most of the world has effectively nothing.

**The catalogue is packaged-goods-skewed.** At a well-covered store,
`en:chicken-breasts` and `en:bananas` returned **zero** prices. Fresh produce,
meat and loose goods are largely absent because contributions are barcode-driven.

**Much of the data is stale.** A live run against Safeway Mountain View returned
milk prices observed 2025-11-12 — roughly nine months old, classified `verify`.
Juva labels these `REAL · VERIFY`, never `LIVE`.

**Category tags are noisy.** `en:breads` returns croutons and matzo meal;
`en:yogurts` returns a butter spread. A category tag alone is therefore never
accepted as a concept match — the product name must confirm it, and a name-only
match carries lower confidence than name-plus-category.

**Consequence for the product.** A real-mode basket of everyday groceries will
usually be **partially priced**. Juva reports exactly which items it could not
price and leaves them out of the total. It does not estimate them, substitute a
different store's price, or fall back to demo data.

---

## 4. Credentials and configuration

No credentials are needed for the connected sources. Two variables matter:

```env
# Comma-separated adapter ids to enable. Empty means no real source is called.
JUVA_RETAILER_ADAPTERS=open_prices

# Required by the Nominatim and Overpass usage policies: a contactable identifier.
JUVA_CONTACT_USER_AGENT=Juva/0.2 (you@example.com)
```

Adapters are **opt-in**. Adding one to the codebase never changes what a running
deployment queries until its id is listed here.

Set `EXPO_PUBLIC_MARKET_MODE=remote` on the device, plus
`EXPO_PUBLIC_API_BASE_URL`, to consume real data. With `demo` (the default) the app
never contacts a price source at all.

### Verifying a real setup

```bash
npm --prefix services/api run live-check
```

This hits the real APIs and prints the resolved location, the stores found, and
each normalized observation with its freshness, confidence and store scope. It is
deliberately outside the test suite, because it needs network access and depends on
third-party data that changes.

---

## 5. Rate limits and politeness

Juva talks to free community infrastructure. Exceeding a published limit gets the
project blocked, which would take the real-data layer down for everyone, so the
limits are enforced in code rather than left to callers
(`services/api/src/retailers/resilience.ts`).

| Service     | Enforced minimum interval | Basis                                                     |
| ----------- | ------------------------- | --------------------------------------------------------- |
| Nominatim   | 1,100 ms                  | Published policy: absolute maximum 1 request/second.      |
| Overpass    | 1,500 ms                  | Shared community resource; kept well clear of its limits. |
| Open Prices | 350 ms                    | No published hard limit; conservative by choice.          |

Also enforced:

- **Timeouts** — 8 s per request (24 s for Overpass, which is slower by nature).
- **Retries** — up to 3 attempts with exponential backoff plus jitter. Only
  timeouts, network errors, `408`, `429` and `5xx` are retried; a `404` is not,
  because it will not start working.
- **Caching** — bounded TTL caches: geocodes 24 h, store lists 6 h, prices 30 min.
  Bounded because a long-running server keyed by free-text location would
  otherwise grow without limit.
- **Circuit breaker** — 3 consecutive failures suppress calls for 60 s. A tripped
  breaker is _reported_, not hidden, because a basket priced while a source was
  down has different coverage than one priced when it was up.
- **Identification** — every request carries `JUVA_CONTACT_USER_AGENT`.

Provider state is visible at `GET /health`.

---

## 6. Partial failure

A basket is never failed because a source failed. Each source, and each store
within a source, is settled independently:

- one source down → the others still contribute, and `partial: true` is returned;
- one store timing out → only that store is lost;
- every source down → an empty market, reported as empty. Never an invented one.

Failures are returned as structured `failures[]` entries and surfaced in the app
rather than swallowed.

---

## 7. Data separation

Demo and real data cannot be confused, structurally rather than by convention:

- `Freshness` includes `demo` as a first-class value. Demo observations carry
  `source: 'demo'` and `freshness: 'demo'`, and render as `DEMO`.
- `FreshnessState` in the adapter contract deliberately **excludes** `demo`, so
  demo data cannot travel through an adapter at all.
- Real observations are labelled by their measured freshness. `LIVE` appears only
  when the weakest observation in the plan really is live.
- Demo mode makes no network calls, so real and demo data never mix in one
  snapshot.

---

## 8. Adding another retailer

1. **Check the terms first.** Only add a source whose terms permit automated
   retrieval — an authorized API, an affiliate/partner feed, an openly licensed
   dataset, or a written agreement. Do not scrape a retailer that prohibits it.
   Record the basis in `SourceAttribution.automatedAccess`.

2. **Implement `RetailerAdapter`** (`services/api/src/retailers/contract.ts`):

   ```ts
   export class MyRetailerAdapter implements RetailerAdapter {
     readonly id = 'my_retailer';
     readonly displayName = 'My Retailer';
     readonly capabilities = MY_CAPABILITIES; // declare only what you verified
     readonly attribution = MY_ATTRIBUTION;

     isEnabled(): boolean { /* false when credentials are missing */ }
     async findNearbyStores(query: NearbyStoreQuery): Promise<AdapterStore[]> { … }
     async searchStorePrices(query: StorePriceQuery): Promise<AdapterObservation[]> { … }
     health(): ProviderHealth { return this.healthTracker.snapshot(); }
   }
   ```

3. **Obey the rules the contract encodes.**
   - Every observation gets `scope: { kind: 'store', storeId }` for the store it
     was actually observed at. Anything else is not plannable.
   - `availability: 'unknown'` unless the source really reports stock.
   - Omit `unitPrice` and `expiresAt` rather than estimating them.
   - Set `requirements.hasUnmodelledCondition` when the source states a condition
     Juva cannot evaluate; such promotions are never applied.
   - Confirm concept matches on the product name, not on a category tag alone.

4. **Route calls through `JsonClient`** so timeouts, retries, rate limiting and
   health tracking apply automatically. Pass a `RateLimiter` matching the
   provider's published limit.

5. **Register it** in `services/api/src/retailers/registry.ts` and enable it by id
   via `JUVA_RETAILER_ADAPTERS`.

6. **Test it against mocked responses** in `services/api/tests/`. Cover at minimum:
   normalization, a cross-store observation being rejected, a currency mismatch
   being excluded, promotion requirements, and freshness classification.

7. **Update the capability matrix and limitations above** with what you measured —
   not with what the provider's marketing claims.

### Worked example: a retailer developer API

Several grocers publish developer APIs offering store locators, product search and
store-scoped prices under OAuth client credentials. Such a source would be a
better fit than a community dataset — genuinely retailer-authorised, fresher, and
often with real promotion data. It is **not** connected here because it requires
credentials this project does not hold. If you add one:

- put the client id/secret in `services/api/.env` only, never in `EXPO_PUBLIC_*`;
- set `automatedAccess: 'permitted_with_credentials'`;
- `isEnabled()` returns false without credentials, so the app still launches;
- declare `inventory: true` only if you verified the stock field is populated for
  the stores you actually query.

---

## 9. What is not verified

Stated so nothing here reads as a stronger claim than it is:

- No retailer partnership or authorised retailer feed is connected.
- The authorized-feed path (`JUVA_RETAILER_FEEDS_JSON`) is exercised by its
  contract and tests, not against a live partner feed.
- Coverage figures were measured on 2026-08-11 and will drift as contributors add
  data.
- The live smoke check exercises Mountain View, CA. Other areas may return nothing.

## Adapter interface (as of 17 Aug 2026)

`RetailerAdapter` — every method is required; capabilities declare which return real data.

| Method              | Open Prices behaviour                                             |
| ------------------- | ----------------------------------------------------------------- |
| `isEnabled()`       | True when `JUVA_RETAILER_ADAPTERS` includes `open_prices`         |
| `getNearbyStores()` | Real. OSM Overpass, keyed by OSM identity                         |
| `searchProducts()`  | Derived from priced rows — no catalogue endpoint exists           |
| `getProduct()`      | Real. Open Food Facts product record                              |
| `getPrice()`        | Real. Store-scoped observations, the batch path aggregation uses  |
| `getPromotions()`   | Derived from priced rows — discounts are inlined, not a feed      |
| `getAvailability()` | Always `unknown`. No stock feed exists, and guessing is forbidden |
| `health()`          | Real. Circuit state, consecutive failures, last success           |

## Mocked provider test coverage

All ten required scenarios, in `services/api/tests/`:

| Scenario                 | Test location                                               |
| ------------------------ | ----------------------------------------------------------- |
| Valid response           | `openPrices` — a price is normalized with full provenance   |
| Stale response           | `openPrices` — freshness reflects age; maxAgeDays filters   |
| Provider timeout         | `resilience` — a hanging request times out                  |
| Provider 429             | `resilience` — a rate-limit response is retryable           |
| Unavailable product      | `openPrices` — no recorded price yields no observation      |
| Malformed product        | `openPrices` — a malformed row is skipped, not guessed      |
| Promotion                | `openPrices` — a loyalty discount becomes a promotion       |
| Location mismatch        | `openPrices` / `aggregate` — another store's price rejected |
| Currency mismatch        | `openPrices` / `aggregate` — not mixed into the basket      |
| Partial-provider failure | `aggregate` — one failing source does not fail the basket   |

See `docs/PRICE_GRAPH.md` for the observation shape, the freshness rules, and how to add
another adapter.

## REAL_DATA_STATUS

Measured 17 Aug 2026. Every number below came from an executed request, not an estimate.
Re-measure with `npm --prefix services/api run live-check` and the requests in this section.

### Providers currently connected

| Provider                          | Role                       | Auth       | Status              |
| --------------------------------- | -------------------------- | ---------- | ------------------- |
| Open Food Facts **Open Prices**   | Grocery price observations | None       | Live                |
| OpenStreetMap **Nominatim**       | Postcode → coordinates     | User-Agent | Live                |
| OpenStreetMap **Overpass**        | Nearby grocery stores      | User-Agent | Live, unreliable    |
| Authorized normalized feeds       | Retailer feeds             | Per-feed   | **None configured** |
| Retailer first-party pricing APIs | —                          | —          | **None connected**  |

Because no retailer pricing API is connected, **`LIVE` freshness never appears** in the
shipped configuration. Verified: zero `live` observations across every request below.

### Exact locations tested

| Location                    | Radius | Stores found | Products | Concepts priced |
| --------------------------- | ------ | ------------ | -------- | --------------- |
| **94043** Mountain View, CA | 3 mi   | 2            | 158      | **6 of 8**      |
| **94043** Mountain View, CA | 2 mi   | 3            | 68       | 2 of 2          |
| **11201** Brooklyn, NY      | 3 mi   | **0**        | **0**    | **0 of 8**      |

94043 geocoded to 37.4067782, −122.0873145 via Nominatim, `origin: postal_code`.

### Concepts tested and priced

Basket tested at 94043 / 3 mi: `milk, eggs, bread, rice, chicken, cereal, bananas, yogurt`
— **8 concepts tested, 6 priced, 2 unpriced.**

| Concept | Result   | Stores with a price | Observations |
| ------- | -------- | ------------------- | ------------ |
| milk    | priced   | 2                   | 47           |
| eggs    | priced   | 2                   | 19           |
| bread   | priced   | 1                   | 22           |
| rice    | priced   | 1                   | 53           |
| cereal  | priced   | 2                   | 31           |
| yogurt  | priced   | 1                   | 3            |
| chicken | unpriced | 0                   | 0            |
| bananas | unpriced | 0                   | 0            |

Unpriced concepts are reported as unpriced and surfaced as missing items. They are never
estimated, substituted from another store, or filled from demo data.

### Scope of each successful price

**All 158 observations were tied to an exact store.** Distribution: `{"store": 158}`.
Zero region-scoped, zero national, zero general observations. `rejectedForStoreScope: 0`.

Only `store` scope is plannable — a region-wide or national price is rejected rather than
attributed to a branch, because a price a shopper cannot walk in and pay is not a price.

Freshness across those 158: **83 `verify`, 43 `older`, 32 `recent`, 0 `live`.**
56 promotions parsed, including real loyalty-card discounts.

### Current basket coverage limitations

- **A full weekly basket cannot be priced from real data.** 6 of 8 everyday concepts priced
  in the best-covered location tested; fresh produce and meat (`bananas`, `chicken`) had no
  observations at all, because contributors photograph barcoded packaged goods far more than
  loose produce.
- **Coverage is per-store, not per-area.** Of 2–3 stores found, typically one carried most
  observations. A multi-store plan is often impossible even where a single-store plan is not.
- **Most data is months old.** The majority is `verify`, the weakest state. Prices are
  presented as "check at the shelf", not as current.
- **Coverage is a property of a location, not of Juva.** Brooklyn 11201 returned zero stores
  and zero prices with **zero upstream failures** — genuine absence of data, not an error.

### Known upstream reliability issues

- **Overpass returns 504 under load.** Observed during this pass: a request immediately after
  a prior run failed with `overpass-api.de returned 504`, producing 0 stores,
  `partial: true`, and an explicit failure entry. Juva reported reduced coverage and
  returned an empty market rather than inventing prices. Retrying after ~50s succeeded.
  Overpass is a free, shared, heavily-loaded service with no SLA.
- **Nominatim and Overpass require a contactable User-Agent** (`JUVA_CONTACT_USER_AGENT`).
  Anonymous traffic is blocked by policy.
- **Rate limits are strict**, and Juva self-limits: minimum spacing between calls, bounded
  retry, a circuit breaker, and a cache. Repeated failures open the circuit and stop calls.
- **Open Prices has no stock feed.** `getAvailability` always returns `unknown` and
  `capabilities.inventory` is `false`. Availability is never guessed.

### Open Prices is supplemental — an explicit statement

**Open Prices is a supplemental, community-contributed price source. It must never be
represented as broad, current, or reliable US grocery coverage.**

It is a crowdsourced dataset in which volunteers photograph price tags. Whether any given
store, product or price exists in it depends entirely on whether a person happened to record
it. There is no agreement with any retailer, no completeness guarantee, and no freshness
guarantee. Measured coverage was 6 of 8 concepts in the single best-covered location tested
and **0 of 8** in a major US metropolitan postcode.

Juva must not be described as having national, regional, or retailer-wide price coverage.
The defensible claim is narrower and is the one to use:

> In a small number of well-covered locations, Juva can price part of a basket from real,
> store-specific, community-contributed observations, each labelled with its source, its
> age and its confidence.

Data is licensed **ODbL 1.0** and attribution travels with every response.
