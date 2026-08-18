import type { CurrencyCode } from '@/domain/types';

/** Longest input accepted, so a paste cannot produce an absurd amount. */
const MAX_INPUT_LENGTH = 24;

export function formatMoney(cents: number, currency: CurrencyCode): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Parses a shopper-entered amount into integer cents.
 *
 * Deliberately string-based. `Math.round(Number('1.005') * 100)` yields 100
 * rather than 101, because 1.005 has no exact binary representation. Juva's
 * savings figures are subtractions of these values, so the parser never routes
 * money through a float.
 *
 * Returns `null` for anything that is not a usable non-negative amount, so
 * callers must decide what to do rather than receiving a silent zero.
 */
export function decimalToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;
  // A minus sign anywhere means this is not an amount Juva can charge against.
  if (trimmed.includes('-')) return null;

  const cleaned = trimmed.replace(/[^0-9.]/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  if (!/\d/.test(cleaned)) return null;

  const [whole = '', fraction = ''] = cleaned.split('.');
  const wholeCents = (whole === '' ? 0 : Number(whole)) * 100;
  if (!Number.isSafeInteger(wholeCents)) return null;

  const centDigits = fraction.slice(0, 2).padEnd(2, '0');
  const remainder = fraction.slice(2);
  // Round half up on the first discarded digit.
  const roundUp = remainder.length > 0 && Number(remainder[0]) >= 5;

  const total = wholeCents + Number(centDigits) + (roundUp ? 1 : 0);
  return Number.isSafeInteger(total) ? total : null;
}
