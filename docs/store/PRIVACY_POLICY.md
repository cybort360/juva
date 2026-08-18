# Juva privacy policy

_Last updated: 12 August 2026._

Juva is a grocery planning app. This policy describes what it handles, what leaves your
device, and what you can delete. It is written to be checkable against the code rather
than to be reassuring.

**There is no account and no sign-in.** Juva does not know your name, email or phone
number, because it never asks for them.

## What stays on your device

All of the following is stored locally and is not uploaded anywhere:

- your grocery lists and saved recurring baskets
- your plans, active trip and the checklist state during a shop
- receipt figures — totals, lines, the reconciliation and your savings history
- your preferences, including the area you shop in and your radius
- receipt photographs, for as long as you choose to keep them

Deleting the app deletes all of it. You can also delete it from inside the app, at any
time, without deleting the app: **Juva Space → Shopping preferences → Data**.

## What leaves your device, and when

**Your shopping area, when you search for prices.** To price a basket, Juva asks its own
API for stores and prices near you. It sends the area or postcode and a radius — not a
precise GPS position, and not your address. Juva does not use background location.

**A receipt image, only when you ask for one to be read.** If you tap to have a receipt
photographed and read, a compressed copy is sent to Juva's API, which passes it to an AI
provider (OpenRouter) purely to transcribe the printed text. It is not written to disk on
the server, not logged, and not retained after the response. You can crop the image on your
device first — cropping out the footer is how you keep card digits and loyalty numbers from
ever being sent. Typing the total instead sends nothing at all.

**Nothing else.** Juva has no analytics. Your basket, your product names, your receipt
contents, your barcodes, your loyalty identifiers and your exact location are never sent to
any analytics, advertising or marketing service.

## AI, and what it is not allowed to do

An AI model is used for exactly one thing: reading the printed text on a receipt
photograph you chose to have read. It transcribes and nothing more.

**No AI calculates any price, total or saving.** Every monetary figure in Juva is integer
arithmetic in the app's own code, over prices that were printed on a receipt, entered by
you, or observed from a price source. The model has no field in which it could express an
opinion about your money.

## Third-party services

| Service                                             | What it receives                                                           | Status in this build                      |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| **RevenueCat** (subscriptions)                      | An anonymous random ID, and your subscription state. No shopping data.     | Active when purchases are configured      |
| **OpenRouter** (receipt text, via Juva's API)       | A receipt image, only when you ask for one to be read. Not retained.       | Active when receipt reading is configured |
| **Open Food Facts Open Prices** / **OpenStreetMap** | A product concept and a search area. No identity.                          | Active for real price data                |
| **Sentry** (crash reporting)                        | Crash and performance data, aggressively stripped — see below.             | Included, not enabled in this build       |
| **OneSignal** (notifications)                       | A device token, an anonymous ID, and coarse status tags. No shopping data. | Included, not enabled in this build       |

The anonymous ID shared with RevenueCat and OneSignal is a random UUID generated on your
device. It is not derived from your device's identifiers, and it is not linked to a name or
an email anywhere.

## Crash reporting, if enabled

Crash reports are stripped before they are sent, by code that is tested against exactly
this list. Removed: your exact location, receipt contents, product names, barcodes, loyalty
identifiers, images and image paths, anything sent to or returned by the AI provider, and
any identity. Request bodies are dropped entirely rather than filtered. Screenshots and
view hierarchies are switched off. Juva never attaches a user identity to a crash report.

## Notifications, if enabled

Juva sends at most two lifecycle messages a week, never between 21:00 and 09:00 your local
time, and never twice about the same thing. No notification contains a product name, a
store name, a location, or an unverified saving. There are no streak or re-engagement
notifications; the app has no code that could produce one.

## Children

Juva is not directed at children and does not knowingly collect data from anyone under 13.

## Your choices

| To do this                                       | Go to                                              |
| ------------------------------------------------ | -------------------------------------------------- |
| Keep receipt images for less time, or not at all | Juva Space → Shopping preferences → Receipt images |
| Delete every receipt image now                   | Juva Space → Shopping preferences → Receipt images |
| Delete one receipt's images, keep its figures    | Verify screen → the receipt → Delete images        |
| Turn notifications off                           | Juva Space → Notifications                         |
| Delete everything                                | Juva Space → Shopping preferences → Data           |

## Changes and contact

Material changes will be reflected here with a new date. Questions, or a data request:
**cybort360@gmail.com**.
