# App review notes

Paste into App Store Connect → App Review Information → Notes, and into the Play Console
release notes for reviewers.

## What Juva does

Juva plans a grocery shop. You enter a basket, Juva compares prices at nearby stores,
and it produces plans — the cheapest single store, and (for subscribers) a multi-store
split — then guides the trip and reconciles the receipt against the plan.

## Reviewing without going to a shop

**No account is required. No sign-in. No shop visit.** The build you receive runs in demo
mode, against a fictional local market.

1. Launch. Complete the six onboarding steps (area, radius, stores, transport, brands,
   priority) — any answers are fine.
2. On the composer, tap the example chip **"Milk, eggs, rice, chicken, bread, cereal"**,
   then **Build my basket**, then **Find the best basket**.
3. The plan appears with a total and a saving. Scroll for other plans and the
   **Worth the Trip** controls — changing **Maximum stores** genuinely re-plans.
4. Set **Maximum stores** to **1**, then **Shop this plan** to enter Shop Mode. Tap a row
   to collect it, or swipe right to collect / left to skip.
5. Tap **VERIFY** in the bottom bar. Type any total (e.g. `30.44`) and tap **Add**, then
   **Verify my trip** for the receipt reconciliation.

## Fictional data, labelled as such

Every store and price in the review build is invented. The retailers — Grove Market,
North Market, Value Foods — do not exist. Prices carry a **DEMO** badge everywhere they
appear, and the app has no code path that can label demo data "LIVE": provenance is part
of the price type, not a display choice.

## Camera and photo access

The camera is used only for photographing a receipt, and only after you tap
**Photograph receipt**. Nothing is captured in the background. Receipt photos stay on the
device unless you ask Juva to read one, in which case a copy is sent to Juva's own API for
text extraction and deleted immediately afterwards. Cropping and rotation happen on the
device first, so you can remove a receipt footer before anything is sent. You can review
without ever using the camera — typing a total is a first-class path, not a fallback.

## Subscription

- Entitlement `juva_plus`, offering `default`, packages `$rc_monthly` and `$rc_annual`.
- Purchases go through RevenueCat. **No paywall appears on first launch.** The upgrade
  offer appears only after a plan has been computed, below the free plan, and quotes the
  actual calculated difference between the two baskets.
- Everything needed to shop honestly is free: the cheapest complete single-store plan,
  Shop Mode, receipt verification and verified savings. The subscription sells additional
  optimization (multi-store splitting, unlimited re-planning, full history).
- **Restore purchases** is on the Subscription screen in Juva Space.
- Cancellation is not performed in-app: Juva links out to the store's own subscription
  management, because an app cannot cancel a store subscription.

## Where things are

| To see                | Go to                                              |
| --------------------- | -------------------------------------------------- |
| Subscription, restore | Juva Space (orb, bottom right) → Subscription      |
| Privacy controls      | Juva Space → Shopping preferences → Receipt images |
| Notifications         | Juva Space → Notifications                         |
| Data deletion         | Juva Space → Shopping preferences → Data           |

## Known limitations we are not hiding

- Real price coverage is narrow. Outside demo mode Juva reads community-contributed data
  (Open Food Facts Open Prices) plus OpenStreetMap geography; it is not a national price
  database and the app does not claim to be one.
- Background price alerts are built but not delivered end to end. The paywall says so and
  they are not sold.
