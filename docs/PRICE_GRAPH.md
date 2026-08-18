# The Juva Price Graph

Every price in Juva is an **observation**: a claim that a specific product cost a specific
amount at a specific store at a specific moment, attributable to a specific source. Juva
never holds "the price of milk". It holds observations, and the optimizer reasons over them.

That distinction is the whole design. A price without a store is not plannable. A price
without a timestamp cannot be given a freshness. A price without a source cannot be
disputed. So all three are required, and an observation missing any of them is discarded
rather than repaired.

## The observation

`AdapterObservation` in `services/api/src/retailers/contract.ts`. Required unless noted.

| Field                                    | Meaning                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `observationId`                          | Stable identity of this observation inside Juva                       |
| `sourceIdentifier`                       | The upstream record, so a figure can be traced back to its origin     |
| `matchedConcept`                         | Canonical product identity — sources disagree on ids, agree on "milk" |
| `product.id`                             | Retailer/source-native product id (a barcode where available)         |
| `retailerId`                             | Which retailer                                                        |
| `scope`                                  | Where the price is valid. Only `store` scope is plannable             |
| `price`                                  | Amount in integer minor units, plus currency                          |
| `regularPrice`                           | Optional. Pre-promotion shelf price, when the source distinguishes it |
| `product.quantityValue` / `quantityUnit` | Quantity and unit, when stated                                        |
| `unitPrice`                              | Optional. Normalized comparison price, only when derivable            |
| `promotion`                              | Optional. Includes `requirements`, which carry membership conditions  |
| `availability`                           | Stock state, or `unknown`                                             |
| `source`                                 | Source kind: retailer API, authorized feed, community feed, receipt   |
| `observedAt`                             | When the price was seen                                               |
| `expiresAt`                              | Optional. Only when the source states an expiry                       |
| `freshness`                              | Derived state, never supplied by a source                             |
| `confidence`                             | 0–1, how sure the match is                                            |
| `verificationCount`                      | Optional. Receipts that independently confirmed this price            |

### Money is integer minor units

Every amount is integer cents. No float ever touches a price, a subtotal or a saving. A
float `0.1 + 0.2` is a rounding error the shopper pays for.

## Freshness

Four states, computed **deterministically** from the source kind and timestamps in
`classifyFreshness`. A source can never assert its own freshness.

| State    | Meaning                                     | Threshold     |
| -------- | ------------------------------------------- | ------------- |
| `LIVE`   | Fetched now from a retailer's own price API | ≤ 2 days      |
| `RECENT` | Recent enough to plan against confidently   | ≤ 14 days     |
| `OLDER`  | Usable, but check at the shelf              | ≤ 120 days    |
| `VERIFY` | Old, unreliable, or of unknown age          | anything else |

Plus `demo` — a first-class state, not an absence of one, so that no code path can render
controlled demo data as real.

**`LIVE` requires the source to justify it.** A community-contributed price is never `LIVE`
however recent, because "someone recorded this two days ago" is not the same claim as "the
retailer's API returned this just now". The only source kind eligible for `LIVE` is a
retailer's own pricing API, and Juva is not currently connected to one — so **in the shipped
configuration `LIVE` never appears.** Verified empirically: every observation in the live run
below came back `verify`.

An unparseable or future timestamp yields `VERIFY`, never a fresh state — a clock error
must not manufacture a fresh price.

## The rules that never bend

**Locality.** An observation carries the scope it was observed at. Only `store` scope is
plannable. A price from one branch can never be presented as another's. Enforced in the
adapter, re-checked in the aggregator, re-checked again on the device.

**Declared capability.** Nothing is inferred from the presence of data. A source with no
stock feed returns `availability: 'unknown'` and `capabilities.inventory: false`. Guessing
`in_stock` would send someone to an empty shelf on Juva's word.

**Currency.** An observation in a different currency than the basket is rejected, never
converted. A converted price is a price nobody was ever charged.

**Malformed rows are dropped, not repaired.** A missing amount, an unparseable amount, a
null currency, a null product, or no date anywhere → discarded. A coerced `NaN` or a
defaulted zero would be a fabricated price wearing a real store's name. A row with no `date`
but a dated price-tag `proof` is dated from the proof, which is evidence rather than a guess.

**No LLM touches a price.** Models may help interpret a list, match a product or read a
receipt photo. Amounts, promotions, totals and savings are computed only by deterministic
code. The receipt extraction schema has no field in which a model could express an opinion
about money.

## What the shopper sees

The item comparison shows the provenance rather than implying it:

```
$3.49
Source           Community-contributed
Store            open_prices:way:35603394
Price checked    checked 2 months ago
Price confidence 80%
[VERIFY badge]
```

A freshness badge alone invites the assumption that a price is current. A source and a
timestamp cannot be misread. Relative time is floored, never rounded up, so a claim always
errs toward sounding older rather than fresher.

## Adding a retailer

An adapter-level change. The optimizer consumes normalized observations and never learns a
source's name or shape.

1. Implement `RetailerAdapter` in `services/api/src/retailers/`:
   `isEnabled`, `getNearbyStores`, `searchProducts`, `getProduct`, `getPrice`,
   `getPromotions`, `getAvailability`, `health`.
2. Declare `capabilities` truthfully and `attribution` including licence and whether
   automated access is permitted.
3. Register it in `registry.ts` and enable it via `JUVA_RETAILER_ADAPTERS`.
4. Add mocked tests for the ten required scenarios (see `docs/REAL_DATA.md`).

Nothing in `src/domain/optimizer.ts` changes.

## Verified live run

`npm --prefix services/api run live-check`, executed 17 Aug 2026 against postcode 94043
(Mountain View, CA):

- Geocoded via OSM Nominatim to 37.4067782, −122.0873145
- **6 real stores** found via OSM Overpass within ~1.25 mi
- **92 store-scoped observations**, e.g. Safeway `open_prices:way:35603394` → 90
- Real loyalty promotions parsed, e.g. `$0.32 off with loyalty card, loyalty=true`
- Unit-price normalization where derivable, e.g. `1055c/L`
- **Every observation `freshness: verify`** — correct, since the data is community
  contributed and months old. Nothing claimed `LIVE`.

Coverage is narrow and honest: of a full basket, only `milk` and `eggs` matched at these
stores. Unmatched concepts are reported as unpriced rather than estimated.
