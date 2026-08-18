# Juva Product

## Product sentence

Juva finds the cheapest practical way to buy a grocery basket nearby, accounting for local prices, promotions, availability, distance, time and user preferences, then verifies actual savings from receipts.

## Core loop

1. **Plan** — describe or enter groceries.
2. **Optimize** — compare feasible local baskets and route/effort cost.
3. **Shop** — follow a store-by-store checklist and record price changes.
4. **Verify** — scan or enter receipt totals.
5. **Learn** — preserve verified savings and recurring basket intent.

## Signature moments

- The composer: “Weekly groceries for two under $80.”
- Live market orchestration with real status summaries rather than fake chain-of-thought.
- A large “you save” reveal against a defined single-store baseline.
- Multi-store vs one-stop vs absolute-cheapest tradeoffs.
- Receipt-verified savings after checkout.

## Free / Plus boundary

The implemented paywall is value-first. The user can understand and use core planning before purchase. `juva_plus` is designed around multi-store optimization, recurring basket monitoring, worth-the-trip intelligence, extended history and smart substitutions.

## Truth rules

1. Never invent a price.
2. Never let an LLM calculate final savings.
3. Never call stale data live.
4. Never reuse a local price across stores without source evidence.
5. Never apply a promotion before validating explicit conditions.
6. Never call savings verified without receipt evidence or user-entered receipt totals.
7. Never hide travel effort when recommending a multi-store basket.
8. Never require precise GPS where an area is enough.
9. Never reveal or fabricate model chain-of-thought.
10. Never mix demo-market savings into real user claims.
