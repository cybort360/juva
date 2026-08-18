# Retention

Juva sends a message only when something changed a grocery decision, or when a valuable
loop is genuinely unfinished. The rules live in `src/domain/journeys.ts` — pure, tested,
and enforced in code rather than in a dashboard, because caps configured only in a web
console are a promise nobody can verify and stop applying the moment someone builds a
campaign by hand.

## The four journeys

| Kind                   | Fires when                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `basket_cheaper`       | A saved basket is meaningfully cheaper than when it was last priced |
| `receipt_not_verified` | A finished trip still has no receipt, after a delay                 |
| `trip_not_started`     | A plan was built and never shopped                                  |
| `basket_under_budget`  | A saved basket crosses back under a stored budget                   |

## Thresholds and caps

| Rule              | Value                                       |
| ----------------- | ------------------------------------------- |
| Meaningful saving | `MEANINGFUL_SAVING_CENTS` = 300             |
| Messages per week | `MAX_PER_WEEK` = 2                          |
| Minimum gap       | `MIN_GAP_HOURS` = 20                        |
| Quiet hours       | 21:00 – 09:00 local (`DEFAULT_QUIET_HOURS`) |
| Per subject       | One message per subject, ever               |

"Milk is $0.09 cheaper" is impossible: it is below the threshold. Nothing streak-shaped
or engagement-shaped exists.

## Truth rules

- A saving from a partial or non-comparable basket is never sent.
- A stale market change is never called "today"; freshness is checked against the
  observation timestamps.
- **Estimated market savings and verified historical savings are different claims** and
  the copy says which one it is. Receipt-verified language never describes a predicted
  future saving.

## Delivery

Juva has no server that composes messages. `evaluateJourney` sets a OneSignal _tag_ when
the deterministic rules allow it, and a journey configured against those tags delivers.
The cap is therefore enforced before the tag flips, not after.

A cap is only ever spent on a message that was actually deliverable: `evaluateJourney`
refuses _before_ deciding when the SDK is absent, so a build without OneSignal cannot
burn a shopper's one-per-subject allowance on nothing.

## Privacy

Tags are a closed vocabulary of booleans, counts and coarse states — `tier`,
`trip_pending`, `receipt_pending`, `saved_lists`, `verified_trips`. Values are coerced to
strings in one place so there is a single point to audit.

Never sent: receipt images, OCR text, basket contents, product names, loyalty
identifiers, payment fragments, exact coordinates, model input or output, or user notes.

## Permission

Asked from an explicit control in Notification settings, never on launch — a reflexive
denial is permanent as far as the app is concerned. The opt-in for lifecycle messages is
separate from the local receipt reminder, because they are different promises: one is a
timer on the device, the other is a message from a server.

## Deep links

Journeys route to existing screens (`/plan`, `/verify`, `/shop`). No notification carries
a payload beyond the tag that triggered it.

## Status

Delivery to a physical device is **unverified** — it needs an Apple Developer account or
an Android build plus a real handset. The decision logic is unit-tested; the transport is
not.
