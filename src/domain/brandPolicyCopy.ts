import type { BrandPolicy } from './types';

/**
 * One place for the words describing each brand policy.
 *
 * Three screens and a chip all name these states, and when the fourth state was
 * added the wording had to be identical in every one of them — a shopper who picks
 * "Exact product" in onboarding and then sees "Exact items" in settings has no way
 * to know whether those are the same setting.
 */

export interface BrandPolicyOption {
  readonly value: BrandPolicy;
  readonly title: string;
  readonly description: string;
  /** Short form for the per-item chip, where space is tight. */
  readonly chip: string;
}

/** Strictest first, which is also the order the per-item chip cycles through. */
export const BRAND_POLICY_OPTIONS: readonly BrandPolicyOption[] = [
  {
    value: 'exact_product',
    title: 'Exact product',
    description: 'Only the item you named — not another size or variant of it.',
    chip: 'EXACT ITEM',
  },
  {
    value: 'exact_brand',
    title: 'Exact brand',
    description: 'Any suitable product from that brand, but never another brand.',
    chip: 'EXACT BRAND',
  },
  {
    value: 'flexible',
    title: 'Equivalent is okay',
    description: 'Prefer the request, show sensible alternatives.',
    chip: 'FLEXIBLE',
  },
  {
    value: 'cheapest',
    title: 'Lowest price first',
    description: 'Use acceptable equivalents to save more.',
    chip: 'CHEAPEST',
  },
];

export function brandPolicyTitle(policy: BrandPolicy): string {
  return (
    BRAND_POLICY_OPTIONS.find((option) => option.value === policy)?.title ?? 'Equivalent is okay'
  );
}

export function brandPolicyChip(policy: BrandPolicy): string {
  return BRAND_POLICY_OPTIONS.find((option) => option.value === policy)?.chip ?? 'FLEXIBLE';
}

/** Next policy in the cycle, wrapping from loosest back to strictest. */
export function nextBrandPolicy(policy: BrandPolicy): BrandPolicy {
  const index = BRAND_POLICY_OPTIONS.findIndex((option) => option.value === policy);
  const next = BRAND_POLICY_OPTIONS[(index + 1) % BRAND_POLICY_OPTIONS.length];
  return next?.value ?? 'flexible';
}
