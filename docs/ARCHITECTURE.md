# Juva Architecture

```text
Expo mobile app
  │
  ├─ Root layout
  │     ├─ environment resolution + validation (src/config/env.ts)
  │     ├─ Expo Router ErrorBoundary
  │     ├─ hydration gate (loading state until local state is read)
  │     └─ +not-found route
  │
  ├─ Composer / basket editor
  │     └─ deterministic fallback list interpreter
  │
  ├─ Market service
  │     ├─ controlled offline market
  │     └─ remote normalized market API (timeout + shape validation)
  │
  ├─ Deterministic planning engine
  │     ├─ matching.ts   canonical concepts, brand policy, currency
  │     ├─ quantity.ts   unit normalization, unit price, pack size, weight
  │     ├─ pricing.ts    promotions, multibuy, line totals
  │     └─ optimizer.ts  assignment, five plan kinds, scoring, explanations
  │
  ├─ Shop Mode
  │     └─ local persisted trip state
  │
  ├─ Verify
  │     ├─ manual receipt totals
  │     └─ optional receipt extraction API
  │
  └─ RevenueCat
        └─ juva_plus entitlement

Node API
  │
  ├─ /v1/market/search
  │     ├─ retailer adapter layer
  │     │     ├─ RetailerAdapter contract + capability matrix
  │     │     ├─ Open Prices adapter (real, community-contributed)
  │     │     ├─ OSM geography (Nominatim postcode, Overpass stores)
  │     │     ├─ resilience: timeout, retry, rate limit, cache, breaker
  │     │     └─ aggregator: partial failure, locality rule, coverage
  │     └─ authorized normalized retailer feeds
  │
  ├─ /v1/retailers/capabilities
  │     └─ generated capability matrix
  │
  └─ /v1/extract/receipt
        └─ OpenRouter structured extraction
```

## List interpretation

`listInterpreter.ts` turns what a shopper typed, pasted or dictated into a basket.
This is the one place a model could legitimately help, so the boundary is explicit:
interpretation may guess at _what was meant_, but it never invents a price, and an
item it cannot recognise is **kept, not dropped**.

That last rule was a real defect. The interpreter previously matched known
concepts and discarded everything else, so "milk, saffron, eggs" quietly became a
two-item basket that then looked complete. An unrecognised line now becomes a real
item that the optimizer reports as unpriced.

Two modes, one line reader:

- `interpretPastedList` — one item per line. Strips copy-paste ornaments
  (`-`, `*`, `1.`, `☐`), reads a leading count (`2 milk`, `3x eggs`), distinguishes
  a leading _size_ from a count (`500 g rice` is one bag), lets an embedded size
  override the concept default (`tomatoes 5 lb`), and merges repeated concepts by
  summing quantities.
- `interpretListPrompt` — a sentence, falling back to list mode when the text is
  clearly a list. Word-boundary matching, so "oil" is not found inside "boiling".

An empty request yields an empty basket. The composer blocks submission and says
so rather than opening a basket the shopper never asked for.

## Motion and accessibility

Motion is part of how Juva communicates, so it lives in one place
(`src/motion/`) rather than being re-invented per screen.

| Module                | Role                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| `tokens.ts`           | Durations, easings and springs. Money settles, structure snaps, status breathes. |
| `useReducedMotion.ts` | The system reduce-motion setting, plus screen-reader detection.                  |
| `haptics.ts`          | Cues mapped to the _kind_ of action, no-ops where unsupported.                   |

Reanimated 4 drives everything, with `react-native-worklets` as a direct
dependency (a transitive install passes bundling but expo-doctor correctly flags it
as a native-crash risk). `babel-preset-expo` wires the worklets plugin
automatically, so there is no manual babel config.

**The reduced-motion contract:** when reduce-motion is on, the _end state_ renders
immediately and correctly. Motion is the only thing removed — never information.
Every animated component takes that branch explicitly rather than relying on a
global animation-disable.

Honouring it on the _first_ frame takes care, because the two platforms answer at
different times. Web reads `matchMedia` synchronously, so the answer is available
during the first render. Native cannot: `AccessibilityInfo.isReduceMotionEnabled()`
is a promise, so a component that renders before it settles assumes "animate" and
briefly runs a reveal for someone who asked for none. `useReducedMotionState()`
therefore reports `resolved` alongside `reduced`, and `SavingsNumber` holds its
figure still until the setting is actually known — one tick, invisible, versus
animating against an accessibility preference. Verified on a simulator with Reduce
Motion toggled both ways: the figure is correct either way, and the reveal still
runs when motion is allowed.

**Values crossing the JS/UI boundary must be shared values, not refs.** A worklet
cannot reliably read a React ref's mutations; doing so in the money display briefly
interpolated against a stale bound and rendered a figure that was never between the
two amounts. Interpolation bounds are `useSharedValue`.

`JuvaPressable` is the single tactile primitive: press spring, matching haptic, and
a real accessibility role/state. `JuvaButton`, the Juva Rail, the Worth-the-Trip
segments and the Shop Mode checklist are all built on it, so touch feedback and
screen-reader semantics cannot drift between them.

**Selection state is published twice, on purpose.** `accessibilityState` is what
iOS and Android read; react-native-web 0.21 no longer forwards it, so on web a
`role="checkbox"` reached the DOM with no `aria-checked` — role announced, state
invisible, with no error or warning. `JuvaPressable` therefore also emits
`aria-checked`/`aria-selected`/`aria-busy`/`aria-disabled`, which React Native
treats as first-class and folds back into `accessibilityState`. Because all
fourteen state-carrying touchables route through the primitive, this is one fix
rather than fourteen. Verify accessibility against the rendered DOM attribute, not
the React prop — the prop was correct throughout the period the behaviour was broken.

### Gestures

Shop Mode's checklist rows are pannable: right past a threshold collects, left
skips. `activeOffsetX`/`failOffsetY` are set so vertical scrolling always wins the
gesture, the haptic fires at the threshold rather than on release (so the detent is
felt before committing), and travel past the threshold is rubber-banded. Both
actions also exist as ordinary controls — the row is itself the collect checkbox
and skip is a button — because a swipe is invisible to a screen reader and
undiscoverable without one.

**The scroll container has to be Gesture Handler's `ScrollView`, not React
Native's.** With the core one, the swipe silently did nothing: on iOS it is a
`UIScrollView` whose recognizer never joins Gesture Handler's arena, so it
cancelled the pan mid-drag. A cancelled gesture calls `onFinalize`, never `onEnd`,
which is where the commit lives — no error, no warning, no visual hint, and
`activeOffsetX`/`failOffsetY` do not help because the conflict is with a recognizer
outside the arena. Worse, a _fast_ drag was picked up by the underlying press
instead, so a left swipe _collected_ the item rather than skipping it. Anything
built on gestures in this app must be exercised on a device — the browser cannot
reach this, and neither can the test suite.

## Retailer data layer

Every real source implements one contract (`services/api/src/retailers/contract.ts`)
and declares a capability matrix. Two rules are structural rather than advisory:

1. **Locality.** An observation carries the scope it was observed at, and only
   `store` scope is plannable. A price from one branch can never be presented as
   another location's price. This is enforced in the adapter, re-checked in the
   aggregator, and re-checked again on the device.
2. **Declared capability.** Nothing is inferred from the presence of data. A source
   with no stock feed reports `availability: 'unknown'`, never `in_stock`.

Geography and prices come from different authorities: OpenStreetMap for where a
store is, a price source for what it costs there, joined on OSM id. See
[REAL_DATA.md](REAL_DATA.md) for connected sources, measured coverage and limits.

## Partial failure

A basket is never failed because a source failed. Each source, and each store
within a source, is settled independently; failures are returned as structured
entries and surfaced, and coverage is reported per concept. Items no source could
price stay unpriced rather than being estimated or borrowed from elsewhere.

## Agent boundary

Juva is agentic where ambiguity exists, not where arithmetic exists.

Probabilistic services may eventually help with natural-language list parsing, canonical product matching, substitution reasoning and receipt extraction. The deterministic engine remains responsible for final monetary calculations and plan scoring.

## Configuration layer

`src/config/env.ts` is a pure resolver: it takes raw strings and returns a frozen,
validated `JuvaEnv` plus a list of issues. Because it is pure it is unit-tested
directly, with no React Native or Expo imports.

`src/config/runtimeEnv.ts` is the only module that reads `process.env`. Every read
is a literal static member expression, because the Expo babel plugin inlines
`EXPO_PUBLIC_*` at build time — a dynamic `process.env[key]` lookup would resolve
to `undefined` in a release bundle.

Validation is non-throwing by design: the app must launch when every optional
external service is absent. Issues surface on the Preferences screen instead.

## Market modes

`EXPO_PUBLIC_MARKET_MODE=demo` uses a deterministic fictional market and requires no backend.

`EXPO_PUBLIC_MARKET_MODE=remote` posts the active grocery concepts and area to the API and expects normalized `Store[]` and `RetailerProduct[]` results. The same optimizer then runs on the mobile client, which means price-source ingestion can evolve without rewriting plan logic.

## Price provenance

Every product price carries store ID, source, observed timestamp, freshness and confidence. Remote retailer feeds are converted into this normalized shape by the API.

`Freshness` includes `demo` as a first-class value rather than treating demo data as
an absence of freshness. Controlled-market observations carry `freshness: 'demo'` and
`source: 'demo'`, and `FreshnessBadge` renders that as `DEMO`. The invariant "demo
data is never shown as live" is therefore structural, not a naming convention. The
adapter contract's own `FreshnessState` deliberately excludes `demo`, so demo data
cannot travel through a real source at all.

Every `PriceObservation` carries retailer, store scope, source kind, `observedAt`,
`expiresAt` when stated, price, currency, unit price where the source supports it,
promotion requirements, confidence and freshness. Fields the source does not provide
are omitted rather than estimated, and `LIVE` is only shown when the weakest
observation behind a plan really is live.

Screens that want to describe a search read `MarketSnapshotMeta`, which counts what
is actually in the snapshot (stores in radius, listings in range, concept matches,
applicable promotions, store combinations enumerated). No displayed count is derived
from a formula over basket size.

## The planning engine

Four modules, each with one job, so a change to unit conversion cannot quietly
alter promotion logic.

| Module         | Responsibility                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `matching.ts`  | Canonical concept aliases, brand satisfaction, currency consistency, availability. Rejects with a named reason. |
| `quantity.ts`  | Unit normalization to g/ml/ct, unit price, pack-size comparison, packs required, weighed goods.                 |
| `pricing.ts`   | Promotion eligibility (loyalty, expiry, retailer, unmodelled conditions), multibuy groups, line totals.         |
| `optimizer.ts` | Per-(item, store) assignment, store-combination search, five plan kinds, scoring, explanations.                 |

### Two kinds of number, never mixed

- **Money the shopper pays** — line totals, `basketCostCents`, savings. Only these
  are presented as prices.
- **Planning costs** — travel, time, extra stops, stale-data risk, missing items.
  These rank plans and never enter a price or a saving.

The plan screen shows both, labelled, so a recommendation is auditable.

### Plans generated

`cheapest_single_store`, `cheapest_multi_store`, `recommended`, `lowest_effort`,
and `strict_budget` when the list has a budget. A kind is **absent when it does
not exist** — no complete single-store basket nearby, no multi-store option within
the store limit, nothing inside the budget — rather than being filled with a near
miss. Kinds that resolve to the same trip collapse into one card, and the
collapsed roles are disclosed in the rationale.

### The recommended score

```text
basket cost
+ ( travel cost + travel time cost + extra-stop penalty ) x effortWeight
+ stale-data penalty
+ missing-item penalty
```

`effortWeight` is `2 x conveniencePreference`, so 0 ignores effort entirely, 0.5 is
neutral, and 1 doubles it. Risk terms are deliberately unweighted: a shopper who
wants the lowest price still does not want a price that has moved or an item they
cannot buy.

Freshness maps to a per-line risk penalty (`live`/`demo` 0, `recent` 15c,
`older` 60c, `verify` 150c). That is what stops a stale bargain outranking a fresh,
slightly dearer basket.

### Quantities, packs and weight

Three cases are kept distinct because conflating them produces wrong totals:

- **Weighed goods** (loose meat at $3.99/lb) use a fractional multiplier.
- **Discrete packs** round up to whole packs, since half a carton cannot be bought.
- **Unreadable or incomparable sizes** fall back to the requested pack count rather
  than inventing a conversion.

`oz` is ambiguous between weight and fluid ounces, so a cross-dimension comparison
returns "no information" instead of a plausible wrong answer.

### Promotions

A promotion applies only when every stated condition holds: right retailer, not
expired, loyalty card held, quantity threshold met, and no condition Juva cannot
evaluate. Multibuy charges whole qualifying groups at the offer price and the
remainder at shelf price. Juva never adds a pack the shopper did not ask for to
reach a threshold. An offer that could not be applied is _shown with its reason_
rather than hidden.

### Missing items

A plan may be incomplete. Unfilled lines are reported with a reason
(`not_stocked_nearby`, `unavailable`, `brand_required`, `currency_mismatch`),
contribute nothing to the basket total, and suppress the savings claim — an
incomplete basket is cheaper for the wrong reason. The missing-item penalty
represents one extra trip, so it tips close calls toward completeness without
being an unbounded preference.

### Recomputing on preference change

Changing how a shopper wants to shop is not a reason to re-observe prices, so
`recomputePlans` re-runs the optimizer over the cached snapshot. The "Worth the
Trip?" control therefore rebuilds the whole plan set — ranking, scores and every
figure — with no network round trip and no risk of the compared prices shifting
underneath the comparison.

## Receipt verification

Estimated savings become verified savings here, and only here. The pipeline is
deliberately split so that a model touches only transcription:

```text
capture (expo-camera, multi-page)
  -> prepare        resize + JPEG compress before anything is written
  -> crop / rotate  on-device redaction; the footer carries card digits
  -> base64         one string, one request, never retained
  -> Juva API       holds the OpenRouter credential; images stay in the request
  -> OpenRouter     transcribes into a strict schema
  -> toReceiptLines re-derives line classification in code, not on trust
  -> reconcileTrip  deterministic integer-cent matching
  -> verifyTrip     the record, and whether it counts
```

**The model transcribes; it never decides.** The JSON schema is `strict` with
`additionalProperties: false` and contains no savings, verdict or recommendation
field — there is nowhere for an opinion about money to go, and the provider rejects
invented properties before Juva sees them. A test asserts no such field exists. Line
classification (item, discount, fee, tax, subtotal) is re-derived by
`classifyReceiptLine` rather than taken from the model, because classification
decides whether money is added or subtracted.

### Cropping

The crop tool is the redaction control, so its geometry lives in
`utils/cropGeometry.ts` as pure, tested arithmetic rather than inside the component.
A scale error there would crop a different region than the one the shopper drew, and
since cropping is how a footer full of card digits gets removed, a silent
off-by-scale is a privacy failure rather than a cosmetic one. Two decisions worth
knowing:

- The letterbox offset is subtracted before scaling. `resizeMode="contain"` centres
  the image, so a selection at the image's left edge is not at the container's left
  edge.
- Bounds round **outward** — origin floors, extent ceils — so a crop never shaves a
  pixel row the shopper had inside their selection.

The overlay uses Gesture Handler pans on the UI thread and reads the values once on
commit; the mapping never happens in a worklet. Dragging is invisible to a screen
reader, so "Drop the footer" and "Whole page" exist as ordinary buttons that do the
same job. `ReceiptCapture` scrolls inside Gesture Handler's `ScrollView` for the same
reason Shop Mode does — the core one would cancel these pans mid-drag.

### Reconciliation

`reconcile.ts` matches planned items to receipt lines using only description
similarity — a planned item carries a retailer product id, never a barcode, so there
is no exact key to join on. Receipt descriptions are truncated and abbreviated, so
`receipt.ts` expands them first. Genuinely ambiguous abbreviations are deliberately
not expanded: "WHT" is both white and wheat, and white bread is not wheat bread.

**The engine refuses to guess.** When two lines are within a small margin of each
other for one item, the item comes back `ambiguous` with both candidates and
contributes no money until the shopper chooses. That refusal is the reason a verified
figure can be trusted, and it is why the confirmation UI exists rather than being a
nicety.

Precedence for what an item actually cost:

1. a shelf correction the shopper entered in Shop Mode,
2. a match the shopper explicitly confirmed,
3. an unambiguous description match,
4. the planned price, reported as `assumed_planned` — never silently.

A printed total governs its stop, because it is the only figure the shopper actually
paid; tax, fees and unmatched lines are inside it by definition, and the residual is
surfaced as `unattributedCents` rather than absorbed. A **total-only** receipt —
typed manually, or one whose every line was redacted — settles the stop from that
total and asks nothing, because there is no question to put to the shopper.
Unchecked is not the same as missing.

Confidence is the **weakest link**, not an average: one clean stop must not average
away a stop with no receipt at all. It describes how well the receipt matched the
plan, never how likely the arithmetic is to be right — the arithmetic is exact.

### What counts as verified

A trip contributes to VERIFIED SAVINGS only when every stop produced a receipt and no
match is still waiting on the shopper. Anything less is kept with
`receiptConfirmed: false` and contributes zero. The rule lives in one place,
`domain/savings.ts`, so a screen cannot quietly inflate the headline by summing the
wrong set.

### Receipt privacy

A receipt photograph shows what was bought, where, when, and sometimes part of a card
number. The guarantees, each backed by a test in `tests/receiptPrivacy.test.ts`:

- **One egress point.** `services/vision.ts` is the only module that base64-encodes
  an image and calls `fetch`, and it has exactly one destination.
- **Nothing is logged.** No `console.*` in any receipt-handling module. A file path is
  enough to find an image on a shared device.
- **No temporary uploads.** The API passes images to the provider from request memory
  and writes nothing to disk. Error paths never echo the body.
- **The credential is server-side.** `OPENROUTER_API_KEY` appears in no app file.
- **Retention is the shopper's.** Not at all / 7 days / 30 days, swept on launch, plus
  an explicit delete-everything control. Deleting images keeps the figures already
  read from them — deleting a photograph is not a request to un-verify.

There is **no analytics, crash-reporting or push-marketing SDK in this repository**,
so there is nothing to scrub. Rather than write code pretending otherwise, the privacy
tests fail the moment such a dependency or call site appears — which is when the
decision about receipt data actually needs making.

## Monetization

`domain/entitlements.ts` holds the whole free/Plus boundary as pure functions, so it is
one testable place rather than a scatter of `hasPlus &&` checks. Two rules shape it.

**Nothing that tells a shopper the truth about money is gated.** The cheapest complete
single-store plan, Shop Mode, receipt verification and verified savings are free.
Charging to answer "what does this actually cost" would make the product dishonest.
What Plus sells is more optimization _work_ — splitting a basket, re-planning against
trade-offs, watching a recurring basket.

**The paywall only ever quotes a figure already computed.** `upgradePrompt` subtracts
two basket costs the optimizer produced and returns nothing when the difference is zero
or negative. There is no code path that offers an upgrade without a calculated saving
behind it, and none that shows a projection. It also returns nothing for an empty plan
set, which is what a first launch has — so a paywall on first launch is structurally
impossible rather than merely avoided.

The trigger sits _below_ the free plan on the plan screen: the shopper sees what they
can already shop before being told what they cannot, and the offer states its cost
(extra stops, miles, minutes) alongside its benefit.

Free limits are named constants — 10 items, 1 saved basket, 5 searches a day, 3 trips of
history — because "limited optimizations" needs a number to mean anything. A trimmed
history hides records from display but never deletes them: a hidden trip still counts
toward the verified total, because the shopper earned it.

### Entitlement lifecycle

- **Offline cached entitlement.** The last live answer is persisted, and used when no
  live `CustomerInfo` is available. The fall back is one-directional by construction —
  written only from a real `CustomerInfo` — so it can restore access that was paid for
  and can never invent it. `entitlementIsCached` says which one is in play.
- **Pending purchases** are a distinct outcome, not a failure. Ask to Buy and slow card
  authorisation land there; Plus is deliberately not granted, and arrives through the
  customer-info listener if the payment clears.
- **Foreground refresh.** A subscription can lapse or be refunded entirely outside Juva,
  and the listener only fires while the app runs; `AppState` re-checks on activation.
- **Customer Center** is RevenueCat's own, presented rather than reimplemented.
  Cancellation and plan changes belong to the store.
- **Stable user id** is a random UUID in SecureStore, shared with OneSignal so a
  subscription and a device are the same person without either service learning who.

## Lifecycle messaging

`domain/journeys.ts` decides whether a message is worth sending; `services/pushJourneys.ts`
is the OneSignal wiring. The split is the point: caps and quiet hours configured only in
a web console are a promise nobody can verify from the code, and they stop applying the
moment someone builds a campaign by hand.

Four journeys exist, and `JourneyKind` is the entire vocabulary — each member names a
real change in the shopper's own data. There is no code path capable of producing a
streak, a "we miss you", or a nudge to open the app.

Enforced in code, not configuration: quiet hours 21:00–09:00 local (wrapping midnight),
at most two messages in a rolling week across all journeys, never two within 20 hours,
one message per subject ever, and a 300c floor below which a saving is not worth the
attention. Quiet hours is checked _last_ so the reported reason names the permanent
objection rather than a temporary one — a caller can then retry in the morning.

No journey body contains a product, store or location; a lock screen is the least
private surface Juva touches. The receipt reminder quotes no figure at all, because at
that point the saving is still an estimate.

## Crash and performance monitoring

`services/privacyScrub.ts` is pure and exhaustively tested; `services/monitoring.ts` is
thin wiring around it, so there is no second place where a decision about what to upload
could be made. Crash reporting is a privacy hazard shaped like a debugging tool —
breadcrumbs, URLs, messages and request bodies all capture user content by default — so
the scrubber is **deny-by-default**: whole categories are stripped and a short allowlist
of keys survives.

Removed at the source as well as scrubbed on the way out: `sendDefaultPii`,
`attachScreenshot` and `attachViewHierarchy` are all off, request bodies are dropped
wholesale, and console and tap breadcrumbs are discarded rather than filtered — the text
of a tap on the plan screen is a price.

Stack traces are kept. They are why crash reporting exists, and frame paths are Juva's
own module names. `setUser` is never called anywhere: a report tied to an identity turns
a debugging tool into a tracking one, and a test asserts no call site exists.

Two invariants worth knowing, both learned from tests failing:

- **The allowlist must never contradict the denylist.** Deny is checked first, so an
  allowlisted key that also matches the deny pattern is a promise the module cannot
  keep. `itemCount` was exactly that, since it contains "item".
- **Deny tokens must be whole words.** A bare `lat` also matches `platform`, `latency`
  and `translate` — which is how an over-eager pattern quietly starts denying the
  diagnostics it was meant to keep.

`tests/receiptPrivacy.test.ts` now asserts that telemetry SDKs stay behind their own
modules and that **no receipt-handling module can reach them at all** — not "we are
careful near Sentry" but "receipt code cannot see Sentry".

## Savings attribution

`savingsBreakdown` returns three independently-based figures, each a subtraction of
two observed prices:

- `storeSelectionCents` — against the cheapest complete single-store basket;
- `promotionCents` — against observed shelf price;
- `substitutionCents` — against the requested brand at the same store.

They are not components of one total, and the verified-trip screen says so. The
headline verified figure is the receipt total against the pre-trip baseline.

## Notifications

Juva has exactly one notification it can honestly deliver, and the settings screen
says so instead of listing plausible alerts. `services/notifications.ts` schedules a
**local** reminder to verify a finished trip — scheduled by `completeTrip`, cancelled
by `verifyActiveTrip`. There is no push infrastructure, so price-drop and deal alerts
are not offered rather than offered as a switch that silently never fires.

Two constraints in the notification body itself:

- **No monetary figures.** A reminder fires before the receipt is read, so any amount
  it quoted would be an estimate wearing the clothes of a verified saving.
- **Nothing leaves the device.** The basket, the location and the prices are not
  needed to schedule it, so they are not sent.

**Ask about our own reminder, never the process's.**
`getAllScheduledNotificationsAsync()` returns every notification scheduled in the
process — under Expo Go, that is every other project the shopper has opened.
Counting that list raw made the settings screen report "2 reminders currently
scheduled" when Juva had scheduled none: strangers' reminders presented as Juva's.
Because the reminder uses one fixed identifier, the honest question is whether that
identifier is present, which is what `receiptReminderScheduled()` asks.

Permission is requested only when the shopper turns the reminder on — never at cold
start, because a reflexive denial is permanent from the app's point of view. A denied
state links to system settings rather than re-prompting. On web
`notificationsSupported()` is false and the control is disabled with a plain
explanation.

## Subscription

`app/subscription.tsx` reads the live RevenueCat entitlement and nothing else:
whether it renews, when access lapses, which store holds the billing relationship,
whether a cancellation has been detected, whether the purchase is sandbox. Nothing
is inferred locally.

Cancelling, switching term and changing payment method are deliberately **not**
actions Juva performs — they belong to the store, so the screen links out via
`managementURL` and says which store it is. An app that appeared to cancel a
subscription it cannot cancel would be the worst possible lie to tell about
someone's money. When no key is configured the screen states that purchases are
unavailable on the build instead of rendering an invented plan.

## Resilience

- Missing RevenueCat configuration disables monetization without crashing core shopping flows; configuration and the first offerings fetch are guarded separately so a network failure still leaves the SDK wired up.
- Missing receipt AI falls back to manual store totals, and the scan affordance is hidden when no extraction endpoint is configured.
- A failed remote market lookup surfaces an error; it is never backfilled with demo prices.
- Active shopping state is persisted locally, with debounced writes and shape validation on read. A schema change bumps the storage key rather than migrating, because a half-migrated plan could carry prices matching no observation.
- Rendering is held behind a hydration gate so no screen shows a misleading empty state for data that exists on disk.
- Monetary reveals settle on their true value even when frames are suspended (backgrounded app or tab), so an amount can never remain stuck at zero.
