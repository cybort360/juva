# Final adversarial audit

Written against Juva, not for it. Each claim is attacked, the evidence is weighed, and
where the claim is weaker than the marketing would like, **the marketing is what changes**.

---

## 1. "Juva uses real grocery prices"

**Attack.** Which prices, from where, and how many baskets can it actually fill?

**Evidence.** One connected source: Open Food Facts **Open Prices**, plus OSM
Nominatim/Overpass for stores. A recorded live run at 94043 priced **6 of 8** requested
concepts across 3 stores, 68 store-scoped observations, all traceable to a
`sourceIdentifier`. A second location, 11201, priced **0 of 8** with zero provider
failures — the market simply had no data.

**Result.** The claim is true and far narrower than it sounds. Prices are real,
community-contributed, and months old.

**Remaining weakness.** No retailer API. Coverage is thin and geographically lucky. A
shopper in most ZIP codes gets a partial market or nothing.

> **Marketing must say:** "Juva uses real, community-contributed grocery prices where they
> exist, and tells you when they don't." **Never** "real-time prices" or "all stores".

---

## 2. "Juva finds the cheapest practical grocery plan"

**Attack.** "Practical" is unfalsifiable. And is it even the cheapest?

**Evidence.** It is deliberately _not_ the cheapest. The optimizer's score is basket +
weighted travel + time + extra-stop + stale-price + missing-item + uncertainty. Scenario
S17 shows a $1.50-cheaper basket losing because it is 15 miles away. 17 named scenarios in
`docs/OPTIMIZER_SCENARIOS.md` pass.

**Result.** Claim holds, with the honest gloss that "practical" means an explicit,
inspectable trade-off — every figure is published in the plan explanation.

**Remaining weakness.** The weights (34c/mile, time value, `MIN_EFFORT_WEIGHT` 0.2) are
reasoned defaults, not calibrated against real shopper behaviour. No user has validated
them.

> **Say:** "the cheapest practical plan, and it shows you its arithmetic."

---

## 3. "Juva adapts in-store"

**Attack.** Does it adapt, or just recolour a row?

**Evidence.** `adaptTrip` re-runs product-policy matching, promotion eligibility,
minimum-spend resolution and the optimizer's own effort model, then presents ranked
options. Verified live: milk reported at $4.29 produced "Buy here" with a stated
alternative and a stated reason. 33 tests in `shopAdapt`, 17 in `shopStateMachine`.

**Result.** Holds. It genuinely replans and it works with no network.

**Remaining weakness.** Adaptations are accepted **only for the stop the shopper is
standing in**. Anything noticed later goes through receipt corrections instead. Defensible,
but a real limitation.

---

## 4. "Juva proves savings"

**Attack.** Prove it against what? A baseline Juva chose itself?

**Evidence.** The baseline is frozen at planning time into `trip.origin`, fingerprinted
(FNV-1a over the economic fields), deep-frozen in dev, and re-checked before any money is
computed. Six named blockers withhold the claim. A blocked result yields
`verifiedSavingsCents: undefined`, never `0`.

**Result.** This is Juva's strongest claim. The baseline genuinely cannot move.

**Remaining weakness.** The baseline is still _Juva's own_ cheapest-single-store figure,
computed from the same possibly-thin market. If the market is wrong, the baseline is wrong
— and the verification is then internally consistent but externally meaningless.

> **Say:** "verified against the baseline Juva recorded before you shopped." **Never**
> "verified savings versus what you would otherwise have paid."

---

## 5. "Juva never invents prices"

**Attack.** Find one fabricated number.

**Evidence.** Malformed rows are dropped, not repaired. Unpriced concepts are reported,
never estimated. Currency is rejected rather than converted. `LIVE` requires a retailer
API and therefore never appears in the shipped config. Demo data carries `freshness:
'demo'` structurally.

**Result.** Holds. I could not construct a path where a price is invented.

**Remaining weakness.** A _user-reported_ shelf price becomes a `live` observation in the
trip's cached market. That is the shopper's number, correctly labelled `user_reported` and
excluded from verified claims until a receipt confirms it — but it is the one place a
figure Juva did not observe enters the arithmetic.

---

## 6. "Juva's paywall is value-based"

**Attack.** Is the number real, or a plausible-looking default?

**Evidence.** `PaywallValueContext` is produced only when both plans are
comparison-eligible, the baseline kind is not `none`, the saving is positive and the
locked plan's confidence ≥ 0.7. Otherwise a typed refusal and neutral copy. Deterministic
example: $56.58 − $46.08 = $10.50, and the unlocked plan is the same plan id.

**Result.** Holds.

**Remaining weakness.** **No human has ever completed a real purchase.** Conversion is
entirely unproven. The mechanism is sound; the business claim is zero.

---

## 7. "Juva protects receipt privacy"

**Attack.** Get a receipt line into a third party.

**Evidence.** Analytics properties are typed `number | boolean | enum` — there is no type
that accepts free text. A runtime sanitizer backs it, the server re-validates
independently, and rejections report `{ index, reason }` only. A structural test asserts
no receipt-handling module can import a telemetry SDK. Live: `receiptText` and `latitude`
were rejected by the running server with nothing echoed.

**Result.** Holds, and it is enforced structurally rather than by discipline.

**Remaining weakness.** Receipt **images** are sent to OpenRouter for extraction. That is
the product working as designed and disclosed, but it is a real third-party disclosure of
receipt contents.

---

## 8. "Juva works offline during a trip"

**Attack.** Kill the network mid-aisle.

**Evidence.** The trip caches stores, products, promotions and the basket. `adaptTrip`
reads only `trip.market` and issues no request. Verified after a full page reload with the
trip rehydrated from storage.

**Result.** Holds for the shopping loop.

**Remaining weakness.** Juva has **no connectivity detection** — it cannot tell the shopper
they are offline, only that the decision needed no network. Receipt _extraction_ requires
the network and is not queued for later.

---

## Claims I would not make

- "Works at any store" — coverage is one community source
- "Always saves you money" — a valid field test may conclude Juva was wrong
- "Real-time prices" — nothing in the shipped config can ever be `LIVE`
- "Trusted by users" — there are none
- "Production ready" — critical native gates are unexecuted
