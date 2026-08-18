# End-to-end flows

Maestro flows covering the twelve journeys required for release. They drive the **demo
market**, so every one runs without visiting a shop, without retailer credentials and
without a network — which is also what makes them usable as a judge/reviewer walkthrough.

## Status

**These flows have not been executed.** Maestro is not installed on the machine where
they were written, so they are unverified artifacts: the selectors are taken from the
accessibility labels in the source, but no run has confirmed them. Treat the first run as
part of writing them.

```bash
# Install Maestro, then:
brew install maestro                      # or: curl -fsSL https://get.maestro.mobile.dev | bash
maestro test e2e/                         # all flows
maestro test e2e/03-optimization.yaml     # one flow
```

Flows assume a **development build** on a booted simulator or attached device, with
`EXPO_PUBLIC_MARKET_MODE=demo`. Two flows are explicitly conditional:

| Flow                      | Runs where                                                       |
| ------------------------- | ---------------------------------------------------------------- |
| `09-paywall.yaml`         | Any build. Asserts the offer quotes a figure, not that it sells. |
| `10-purchase-cancel.yaml` | Needs a RevenueCat **Test Store** key. Skipped otherwise.        |
| `11-restore.yaml`         | Needs a RevenueCat key. Asserts the honest "no purchase found".  |

## What these cannot prove

- **A purchase.** `10` and `11` exercise the app's handling of a cancel and a restore.
  Whether money moved is only knowable from the RevenueCat dashboard.
- **A notification.** No flow asserts a delivered push; that needs a campaign and a
  device token.
- **Real retailer data.** The demo market is fictional by design. A flow against Open
  Prices would be non-deterministic and is deliberately not attempted here.

## Selector convention

Flows target accessibility labels rather than text where possible, because those labels
are asserted by the component tests and are what a screen reader reads. Where a flow
targets visible text, the text is also the thing a shopper reads — so a copy change that
breaks a flow is a copy change worth noticing.
