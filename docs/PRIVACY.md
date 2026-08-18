# Juva Privacy Model

Juva handles potentially sensitive shopping and location data, so the default is data minimization.

- Area/postcode is sufficient for planning; precise background GPS is not required.
- Active lists, shopping trips, receipts metadata and savings records are persisted locally by the current app.
- Receipt images are sent only when the user explicitly invokes receipt scanning and a receipt-extraction API is configured.
- The API must not log raw receipt image bodies or extracted receipt contents.
- RevenueCat receives subscription identity/transaction state, not receipt contents.
- Marketing, crash or notification providers must never receive raw receipt text, product histories, exact location, loyalty identifiers or payment fragments.
- Projected savings and verified savings are separate data fields.
- Users can delete all local Juva data from Settings.

## Receipt images

A receipt photograph is the most sensitive artefact Juva touches: it records what was
bought, where, when, and sometimes part of a card number. The handling is therefore
specific rather than general.

- **Stored in one place Juva controls.** Pages live in an app-owned cache directory,
  resized and JPEG-compressed before the first write, so a full-resolution original
  never lands on disk.
- **Redaction happens before upload.** A free-form crop rectangle with draggable
  corners, plus rotate, lets the shopper remove
  a receipt footer — where card digits and loyalty identifiers are printed — on the
  device, before any image is read.
- **One egress point, one destination.** `src/services/vision.ts` is the only module
  that encodes an image and sends it, and it posts to the configured
  `/v1/extract/receipt` endpoint and nowhere else.
- **Temporary copies are always deleted.** The base64 string exists for one request.
  Captured pages are deleted on cancel, on failure, and after extraction when
  retention is set to zero.
- **The server writes nothing to disk.** Images pass from request memory to the
  provider. No temporary upload is created, and error paths do not echo the body.
- **The provider credential is server-side only.** `OPENROUTER_API_KEY` exists on the
  API; no app file references it.
- **Retention is the shopper's choice.** Not at all, 7 days, or 30 days, enforced by a
  sweep on launch, plus an explicit "delete all receipt images now" control. Deleting
  images keeps the figures already read from them, and the record says the images were
  deleted.
- **Nothing is logged.** No receipt-handling module contains a `console.*` call; a file
  path alone is enough to locate an image on a shared device.

### On OneSignal, Layers and Sentry

None of these — and no analytics, crash-reporting or push-marketing SDK of any kind —
is a dependency of this repository. There is consequently nothing to scrub, and Juva
does not ship code implying otherwise.

What exists instead is enforcement for the day one is added:
`tests/receiptPrivacy.test.ts` fails if such a package appears in `package.json`, if a
known sink is referenced in `src/` or `services/api/src/`, if a second image uploader
appears, or if a `console.*` call is added to a receipt module. The test failure is the
prompt to make the decision deliberately rather than by accident.

Before production launch, add a published privacy policy, data retention schedule, processor inventory and store-specific privacy disclosures.
