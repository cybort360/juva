import type { SavingsRecord } from './types';

/**
 * The records that may contribute to a shopper's verified savings.
 *
 * Only a trip whose receipts were actually read, and whose uncertain matches were
 * resolved, has been verified. Unconfirmed records are kept — they are still a
 * record of a trip — but they are not evidence of a saving, so they are filtered
 * out here rather than at each screen, where one omission would quietly inflate
 * the headline figure.
 */
export function confirmedRecords(records: readonly SavingsRecord[]): SavingsRecord[] {
  return records.filter((record) => record.receiptConfirmed);
}

/** Sum of verified savings across confirmed trips only. */
export function verifiedSavingsTotalCents(records: readonly SavingsRecord[]): number {
  return confirmedRecords(records).reduce((sum, record) => sum + record.verifiedSavingsCents, 0);
}

/**
 * Sum of the pre-trip estimates, across every record.
 *
 * Reported beside the verified figure and never added to it: an estimate and a
 * verified saving are different claims about the same trip.
 */
export function estimatedSavingsTotalCents(records: readonly SavingsRecord[]): number {
  return records.reduce((sum, record) => sum + record.estimatedSavingsCents, 0);
}
