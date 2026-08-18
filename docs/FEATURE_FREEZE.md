# Feature freeze — Juva 1.0

**Juva 1.0 is feature-frozen as of this commit.** The next source of truth is users, not
another engineering pass.

## P0 release scope

Everything below exists and is covered by automated tests. Native-device gates are listed
in `RELEASE_REPORT.md`.

- Onboarding, location and preferences
- Grocery list composer and basket confirmation
- Market search with real/demo separation and price provenance
- Deterministic optimizer: one-store baseline, Juva Pick, lowest effort, strict budget
- Worth the Trip recomputation
- Shop Mode with offline-capable adaptive replanning
- Receipt capture, extraction and deterministic reconciliation
- Verified Savings and the permanent Savings Ledger
- RevenueCat `juva_plus` with a deterministic value-based paywall
- History
- Notification lifecycle (Journeys A–D)
- Privacy scrubbing, analytics and observability

## Explicitly out of 1.0

Not deferred because they are bad ideas — deferred because Juva has no users yet, and
building them now would be guessing.

Nutrition scoring · calorie tracking · cashback · delivery ordering · pantry management ·
grocery social network · community feed · autonomous checkout · recipe platform ·
household collaboration · loyalty synchronisation · broad global retailer expansion ·
receipt-to-community Price Graph · multi-agent orchestration · speculative AI features ·
ML ranking · price crowdsourcing · experimentation infrastructure

## Change admission

From now on a change ships only if it is one of:

| Category                 | Meaning                                   |
| ------------------------ | ----------------------------------------- |
| **RELEASE BLOCKER**      | 1.0 cannot ship without it                |
| **BUG**                  | Implemented behaviour is wrong            |
| **SECURITY / PRIVACY**   | Data exposure or a trust-model violation  |
| **STORE REQUIREMENT**    | App Store or Play Store demands it        |
| **COMPETITION EVIDENCE** | Required to substantiate a Shipaton claim |

Everything else is deferred to 1.1 with a one-line note. No exceptions for "it's small".
