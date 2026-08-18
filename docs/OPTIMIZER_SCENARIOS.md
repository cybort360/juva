# Optimizer scenario matrix

The seventeen required optimizer scenarios, each mapped to a named test with its
fixture, expected result and the result actually observed.

Every row points at a test in [`tests/optimizerScenarios.test.ts`](../tests/optimizerScenarios.test.ts),
numbered `S01`–`S17` to match this table. That file is deliberately self-contained: it
does not reuse the shared demo market, and every expected figure is written out, so a
scenario cannot start passing for a different reason than it was written for. Where a
scenario is also exercised from another angle, the corroborating test is listed too.

**Reproduce:** `npm test`

Results below are from the run of 17 Aug 2026: **531 domain tests pass, 0 fail.**

---

## The matrix

### S01 one store wins

- **Test** `S01 one store wins`
- **Fixture** `alpha` at 1 mi and `beta` at 4 mi; `alpha` is cheaper on both lines
  ($3.00 + $4.00 against $3.80 + $4.60).
- **Expected** One stop at `alpha`, basket $7.00, complete.
- **Actual** 1 stop, `alpha`, `basketCostCents` 700, `completeness.complete` true.
- **Pass**

### S02 two stores win

- **Test** `S02 two stores win`
- **Fixture** `alpha` 1 mi sells milk $3.00 / rice $14.00; `beta` 2 mi sells milk
  $13.00 / rice $4.00. Splitting saves $9.00.
- **Expected** Two stops, basket $7.00.
- **Actual** 2 stops (`alpha` + `beta`), `basketCostCents` 700.
- **Pass**
- **Also** `planning.test.ts` → "a two-store market with split bargains yields both
  single and multi plans", "raising maxStores genuinely finds a cheaper basket".

### S03 third stop not worth it

- **Test** `S03 third stop not worth it`
- **Fixture** The S02 market plus `gamma` at 8 mi, which undercuts bread by 40c.
  `maxStores: 3`.
- **Expected** The worthwhile two-store split is taken; the third stop is not. The
  three-stop plan is still generated and scores worse.
- **Actual** 2 stops, `gamma` absent, basket $12.00. The three-stop plan is 40c cheaper
  on the basket and higher on `effectiveCostCents`.
- **Pass**
- **Also visible in the app.** With the demo basket in walk mode, the Worth the Trip
  panel reads: _"Split the basket costs $1.30 less on the basket. It needs 3 stores (1
  more) and about 58 minutes longer… Juva scores it $3.68 worse overall."_

### S04 strict budget

- **Test** `S04 strict budget`
- **Fixture** `alpha` 1 mi at $12.00 total, `beta` 3 mi at $8.00 total, budget $9.00.
- **Expected** A complete plan inside the budget at $8.00, whose rationale names the
  within-budget role. The recommendation is knowingly the dearer, nearer trip.
- **Actual** Inside-budget complete plan at 800, rationale matches `/within-budget
plan/`; recommendation 1200.
- **Pass**
- **Note** `dedupePlans` labels a trip with the highest-priority kind that selected it,
  so this plan carries `cheapest_single_store` and states the budget role in its
  rationale. The test finds it by shape rather than by `kind`.
- **Also** `planning.test.ts` → "a strict-budget plan appears only when a budget
  exists", "the budget plan maximises coverage before minimising price".

### S05 missing product

- **Test** `S05 missing product`
- **Fixture** One store stocking milk only; basket asks for milk and saffron.
- **Expected** Saffron reported missing with reason `not_stocked_nearby`, basket $3.00,
  no saving claimed, plan not comparison-eligible.
- **Actual** 1 missing item ("Saffron", `not_stocked_nearby`), 300,
  `comparisonEligible` false, `savingsVsBaselineCents` 0.
- **Pass**
- **Also** `planning.test.ts` → "an item no store stocks is reported, not priced",
  "an incomplete plan claims no saving".

### S06 stale price

- **Test** `S06 stale price`
- **Fixture** `fresh` (both lines `recent`) at $8.00 against `stale` (both `verify`) at
  $7.40, same distance, `maxStores: 1`.
- **Expected** The fresh, dearer basket wins. The penalty is a ranking term only.
- **Actual** `fresh` recommended, basket 800, `staleDataPenaltyCents` 30. The stale plan
  carries a 300 penalty and its `basketCostCents` stays 740 — the penalty never entered
  the basket.
- **Pass**
- **Also** `planning.test.ts` → "a stale bargain can lose to a fresh price", "the stale
  penalty never enters the basket cost or the saving".

### S07 loyalty pricing

- **Test** `S07 loyalty pricing`
- **Fixture** `$1 off with a members card` on a $5.00 line, run twice: without the card
  and with it.
- **Expected** $5.00 and no applied promotion without the card; $4.00 and a 100c
  applied promotion with it.
- **Actual** 500 / `promotionsApplied` empty; 400 / `savingsCents` 100.
- **Pass**
- **Also** `optimizer.test.ts` → "loyalty promotions only apply to shoppers who hold the
  card"; `promotionConditions.test.ts` → "loyalty is checked against the retailer, not
  any retailer".

### S08 multibuy

- **Test** `S08 multibuy`
- **Fixture** "2 for $7" on an 18 oz cereal at $5.00, at one, two and three packs.
- **Expected** 1 pack $5.00 (threshold unmet); 2 packs $7.00; 3 packs $12.00 — two at
  the offer price, one at shelf, with no fourth pack added to reach another group.
- **Actual** 500 / 700 / 1200.
- **Pass**
- **Also** `optimizer.test.ts` → "multi-buy promotions are not applied to single-unit
  lines"; `promotionConditions.test.ts` → the multibuy + minimum-spend combinations.

### S09 weighted goods

- **Test** `S09 weighted goods`
- **Fixture** Chicken at $4.00/lb sold by weight, 2.5 lb requested.
- **Expected** $10.00, `packBasis` `weighed`, not rounded up to a whole pack.
- **Actual** `basketCostCents` 1000, `packBasis` `weighed`, `roundedUp` false.
- **Pass**
- **Also** `planning.test.ts` → "weighed goods are billed by the amount taken".

### S10 brand locked

- **Test** `S10 brand locked`
- **Fixture** `exact_product` for "Kellogg's Corn Flakes" where the store carries
  Kellogg's **Frosties** at $4.00 and a Value **Corn Flakes** at $2.50, plus milk at
  $3.00 so a plan exists.
- **Expected** The cereal line goes unfilled, reported as `variant_required`; the
  cheaper own-brand is deliberately not taken; basket $3.00.
- **Actual** 1 missing item with reason `variant_required`, no Value line in the plan,
  `basketCostCents` 300, `allow_substitutions` offered as a remediation.
- **Pass**
- **Note** This scenario found a reporting bug. `bestAssignmentAtStore` kept the _last_
  rejection seen, so the Value own-brand's `brand_required` overwrote Frosties'
  `variant_required` — telling a shopper "that brand is not stocked" when the brand was
  on the shelf and the product was not. Fixed with a specificity order
  (`moreSpecificRejection` in `optimizer.ts`).
- **Also** `brandPolicy.test.ts` → the four `exact_product` / `exact_brand` tests.

### S11 flexible brand

- **Test** `S11 flexible brand`
- **Fixture** The same market, `flexible`: Kellogg's $4.00 against Value $2.50.
- **Expected** The own-brand is taken, flagged as a substitution, with the saving
  measured against the requested brand's price _at that store_.
- **Actual** 250, `substitution` true, `productBrand` "Value",
  `substitutionSavingsCents` 150.
- **Pass**
- **Also** `planning.test.ts` → "flexible brand policy prefers the request unless the
  saving beats the penalty", "substitution savings are measured against the requested
  brand at that store".

### S12 unavailable product

- **Test** `S12 unavailable product`
- **Fixture** Eggs present in the feed but `available: false`.
- **Expected** Reported as `unavailable`, not as simply absent. Basket $3.00.
- **Actual** 1 missing item, reason `unavailable`, 300.
- **Pass**
- **Also** `planning.test.ts` → "an out-of-stock product is reported as unavailable,
  not absent".

### S13 promotion expires

- **Test** `S13 promotion expires`
- **Fixture** A `$1 off` offer with `expiresAt` ten days before planning time.
- **Expected** Shelf price paid, no applied promotion, and the line says why rather
  than omitting the offer.
- **Actual** `basketCostCents` 500, `promotionsApplied` empty, line
  `promotionStatus` `expired`, label matches `/expired/i`, `promotionSavingsCents` 0.
- **Pass**
- **Also** `promotionConditions.test.ts` → "an expired coupon is ineligible even when
  held", "an offer expiring exactly now is treated as expired".

### S14 quantity mismatch

- **Tests** `S14 quantity mismatch`, `S14 quantity mismatch picks the cheaper way to
reach the amount`
- **Fixture** 5 lb of rice requested; sold only in 2 lb bags at $3.00. Second test adds
  a 6 lb bag at $11.00.
- **Expected** Three whole bags (6 lb), `roundedUp` true, $9.00. The larger pack with
  the worse unit price does not win merely because it is one item.
- **Actual** `quantity` 3, `roundedUp` true, 900; second test picks `a-small` at 900
  over the 6 lb at 1100.
- **Pass**
- **Also** `planning.test.ts` → "pack-size comparison picks the cheaper way to reach the
  requested amount"; the whole of `quantity.test.ts`.

### S15 ambiguous product

- **Test** `S15 ambiguous product`
- **Fixture** Request for Kellogg's Corn Flakes under `flexible`; the only candidate is
  a Value "Bran Squares" — a different brand _and_ a different variant.
- **Expected** Priced but flagged as a substitution the shopper can reject, with no
  substitution saving claimed since the requested product was never seen here.
- **Actual** `substitution` true, `basketCostCents` 250, `substitutionSavingsCents` 0.
- **Pass**
- **Also** `brandPolicy.test.ts` → "flexible marks a differing variant as needing
  confirmation" (`tier: 'manual_confirmation'`, `needsConfirmation: true`);
  `identity.test.ts` → the malformed and contradictory-identifier cases.

### S16 under-budget alternative

- **Tests** `S16 under-budget alternative`, `S16 no under-budget plan is invented when
nothing fits`
- **Fixture** `local` 1 mi at $12.00, `beta` 6 mi at $9.00, budget $10.00. Second test:
  a $18.00 basket against a $5.00 budget.
- **Expected** The recommendation stays the nearer $12.00 trip; a complete $9.00
  under-budget plan is offered as a genuinely different plan. Nothing is offered when
  nothing fits.
- **Actual** Recommendation 1200; under-budget plan 900, complete, different `id`,
  rationale matches `/within-budget plan/`. Second test: no `strict_budget` plan.
- **Pass**

### S17 travel cost reverses cheapest choice

- **Test** `S17 travel cost reverses cheapest choice`
- **Fixture** `local` 1 mi at $10.00 against `budget` 15 mi at $8.50, `maxStores: 1`.
- **Expected** The nearer, dearer store is recommended; the cheaper basket exists,
  loses on the weighted score, and the travel term is what did it.
- **Actual** `local` recommended at 1000; cheapest basket 850 at `budget` with a higher
  `effectiveCostCents` and a higher `travelCostCents`.
- **Pass**
- **Also** `worthTheTrip.test.ts` → "D: travel cost reverses which single store wins",
  "D: the reversal is caused by the travel term, and undoes itself when it shrinks".

---

## Worth the Trip reverification

[`tests/worthTheTrip.test.ts`](../tests/worthTheTrip.test.ts), 13 tests, all passing.
Each calls `optimizeBasket` with exactly the preference patch the control emits, which
is what `recomputePlans` in `JuvaProvider` does.

| Claim                                    | Test                                                                              | Result                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A low effort chooses fewer stores        | `A: prioritising less effort recommends the single-store trip`                    | 1 stop at `near`, basket $24.00                              |
| B low price accepts a worthwhile stop    | `B: prioritising the lowest price accepts the second stop`                        | 2 stops, basket $15.00                                       |
| A vs B differ                            | `A vs B: the same observations produce genuinely different recommendations`       | different `id`, stop count, basket and ETA                   |
| C trivial saving still rejected          | `C: a 30c saving does not buy a second stop, even at the lowest-price end`        | 1 stop at every `conveniencePreference` in {0, 0.25, 0.5, 1} |
| C the rejected plan still exists         | `C: the trivial-saving plan is still generated and still explains itself`         | two-stop plan present, higher `effectiveCostCents`           |
| D travel reverses the choice             | `D: travel cost reverses which single store wins`                                 | `local` wins at 15 mi despite a $1.50 dearer basket          |
| D and reverses back                      | `D: the reversal is caused by the travel term, and undoes itself when it shrinks` | `budget` wins again at 1.5 mi                                |
| D transport mode matters                 | `D: switching to walking changes the answer through travel time alone`            | ETA and `minutesPerMile` both change                         |
| E the UI compares real plans             | `E: the control compares two plans the optimizer actually generated`              | alternative is a member of the returned plan set, by `id`    |
| E every number is arithmetic on them     | `E: every number the control shows is arithmetic over those two plans`            | 900 / 1 stop delta, each field reconstructed                 |
| E nothing invented when already cheapest | `E: the control offers nothing when the selected plan is already cheapest`        | no alternative, all deltas 0                                 |
| E no partial alternative                 | `E: a partial plan is never offered as the cheaper alternative`                   | only comparison-eligible plans offered                       |
| E deterministic                          | `E: the comparison is deterministic for the same plan set`                        | identical for reversed input order                           |

### Claim E, in the running app

The derivation the control renders was moved out of the component into
`worthTheTripComparison` in `optimizer.ts`, so "the UI shows optimizer output" is a
statement a test can check rather than one the component asserts about itself.

Observed in the web build (demo basket, 12 items, three stores):

| Action                       | Rendered result                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial (balanced, 2 stores) | $46.08, 2 stops, save $10.50, 5.2 mi, ~37 min, ranking score $50.00 at `effort ×1.00`                                                                                                                            |
| Tap **CONVENIENCE**          | score $53.61 at `effort ×2.00`; plan unchanged — the $10.50 saving genuinely outweighs doubled effort                                                                                                            |
| Tap **MAXIMUM STORES 1**     | $56.58, 1 stop, save $0.00, 3.8 mi, ~24 min, score $60.99                                                                                                                                                        |
| Tap **3** then **WALK**      | ETA ~88 min; Worth the Trip switches to its alternative branch: _"Split the basket costs $1.30 less on the basket. It needs 3 stores (1 more) and about 58 minutes longer… Juva scores it $3.68 worse overall."_ |

Basket total, stop count, distance, ETA, ranking score and the comparison copy all move
together with the optimizer's output. Nothing is a visual-only change.

One caveat about method: the taps above were dispatched as synthetic `MouseEvent`s from
the console, which is why one of them raised a `setPointerCapture` warning in the Expo
overlay. That is an artefact of driving Gesture Handler without a real pointer id, not
a fault in the app — the page underneath was intact and re-rendered correctly.

---

## A behaviour change this pass introduced

Scenario C exposed a genuine flaw. `effortWeightFor` returned exactly `0` at
`conveniencePreference: 0`, which multiplied travel, time and the extra-stop penalty by
zero — so a 30c cheaper line 6 miles away won, sending the shopper on a 12-mile round
trip costing about $4.00 in fuel by Juva's own mileage figure to save 30c. That is not
"the lowest total", which is what the setting promises.

`MIN_EFFORT_WEIGHT = 0.2` now floors the weight. It binds only below
`conveniencePreference` 0.1; both documented anchors are unchanged (0.5 weights effort
at face value, 1 weights it double). Covered by `planning.test.ts` → "the effort weight
never reaches zero, so a trip is never free to the ranking".
