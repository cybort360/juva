import type { ShoppingTrip, TripOrigin } from './types';

/**
 * The permanent economic baseline of a trip, and the machinery that keeps it that way.
 *
 * `trip.origin` is what every savings claim is ultimately measured against. If it could
 * drift — by a stray mutation, a spread that reused a nested reference, or a replan that
 * "helpfully" recomputed it — Juva would be able to improve its own savings figure by
 * replanning, and the number would mean nothing.
 *
 * Sharing one object reference across adaptations is not immutability. It only means
 * nothing has written to it *yet*. So this module does three separate things, because
 * each catches a failure the others miss:
 *
 * 1. **A value snapshot.** `snapshotOrigin` copies every field, including the store id
 *    array, so the trip's origin shares no structure with the plan it came from.
 * 2. **A freeze.** In development the snapshot is deeply frozen, so an accidental write
 *    throws at the point of the mistake rather than corrupting a shopper's savings.
 *    Production skips it: the cost is real and the fingerprint catches the same class of
 *    bug after the fact.
 * 3. **A fingerprint.** A deterministic hash over the economically relevant fields,
 *    stored with the origin and re-checked after every adaptation. This is the one that
 *    survives persistence — `JSON.parse` returns a thawed object, so a reloaded trip has
 *    no frozen protection at all and the hash is the only remaining guard.
 */

/**
 * Fields the fingerprint covers.
 *
 * Deliberately not `capturedAt` or `planKind`: the first is provenance and the second is
 * a label. What must never move is the money and the terms on which it is compared.
 */
function fingerprintPayload(origin: TripOrigin): string {
  return [
    origin.planId,
    origin.basketCostCents,
    origin.comparedBaselineCents,
    origin.baselineKind,
    origin.savingsVsBaselineCents,
    origin.comparisonEligible ? '1' : '0',
    // Sorted so an incidental reordering of stops is not read as tampering, while a
    // changed set of stores still is.
    [...origin.storeIds].sort().join(','),
  ].join('|');
}

/**
 * FNV-1a, 32-bit, rendered as hex.
 *
 * Not a cryptographic hash and not trying to be — this defends against a bug, not an
 * attacker who already controls the device. What it has to be is dependency-free and
 * bit-identical on every platform and every run, which a cryptographic library imported
 * for the purpose would not have been.
 */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // The FNV prime, multiplied in 16-bit halves so it stays inside a 32-bit integer
    // rather than losing precision through a float.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The fingerprint an origin's current field values imply. */
export function originFingerprint(origin: TripOrigin): string {
  return fingerprint(fingerprintPayload(origin));
}

/** Whether deep-freezing is worth its cost. Development and test builds only. */
function shouldFreeze(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Freezes an origin and everything reachable from it.
 *
 * Shallow `Object.freeze` would leave `storeIds` writable, which is exactly the kind of
 * near-miss this is meant to catch: the array is part of what the fingerprint covers.
 */
export function freezeOrigin(origin: TripOrigin): TripOrigin {
  if (!shouldFreeze()) return origin;
  Object.freeze(origin.storeIds);
  return Object.freeze(origin);
}

/**
 * Takes a value snapshot of an origin and stamps it with its fingerprint.
 *
 * Called once, when the trip starts. Every later copy goes through `carryOrigin`, which
 * preserves the stamped fingerprint rather than recomputing one — a recomputed
 * fingerprint would agree with whatever the fields happen to say now, which is precisely
 * the thing being guarded against.
 */
export function snapshotOrigin(origin: Omit<TripOrigin, 'fingerprint'>): TripOrigin {
  const snapshot: TripOrigin = {
    planId: origin.planId,
    planKind: origin.planKind,
    basketCostCents: origin.basketCostCents,
    comparedBaselineCents: origin.comparedBaselineCents,
    baselineKind: origin.baselineKind,
    savingsVsBaselineCents: origin.savingsVsBaselineCents,
    storeIds: [...origin.storeIds],
    capturedAt: origin.capturedAt,
    comparisonEligible: origin.comparisonEligible,
    fingerprint: '',
  };
  return freezeOrigin({ ...snapshot, fingerprint: originFingerprint(snapshot) });
}

/**
 * Carries an origin through an adaptation as a fresh value snapshot.
 *
 * A new object each time, so no two trip versions share mutable structure, but with the
 * *stored* fingerprint copied verbatim so `originIntact` can still tell whether the
 * fields moved since the trip began.
 */
export function carryOrigin(origin: TripOrigin): TripOrigin {
  return freezeOrigin({
    planId: origin.planId,
    planKind: origin.planKind,
    basketCostCents: origin.basketCostCents,
    comparedBaselineCents: origin.comparedBaselineCents,
    baselineKind: origin.baselineKind,
    savingsVsBaselineCents: origin.savingsVsBaselineCents,
    storeIds: [...origin.storeIds],
    capturedAt: origin.capturedAt,
    comparisonEligible: origin.comparisonEligible,
    fingerprint: origin.fingerprint,
  });
}

/**
 * Whether an origin still says what it said when the trip started.
 *
 * Compares the stored fingerprint against one recomputed from the current field values.
 * A mismatch means something wrote to the baseline, and the caller must refuse to act on
 * it rather than quietly producing a savings figure from a corrupted record.
 */
export function originIntact(origin: TripOrigin): boolean {
  return origin.fingerprint === originFingerprint(origin);
}

/** Convenience for the common check: is this whole trip's baseline still trustworthy? */
export function tripOriginIntact(trip: ShoppingTrip): boolean {
  return originIntact(trip.origin);
}
