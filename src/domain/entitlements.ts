import type { OptimizedPlan, SavingsRecord } from './types';

/**
 * What the free tier includes, and what Juva Plus adds.
 *
 * Kept here as pure functions so the boundary is one testable place rather than a
 * scatter of `hasPlus &&` checks across screens. Two rules shape it:
 *
 * Nothing that tells a shopper the truth about money is ever gated. The cheapest
 * complete single-store plan, Shop Mode, receipt verification and their verified
 * savings are free, because charging for "what does this actually cost" would make
 * the product dishonest. What Plus sells is *more optimization work* — splitting a
 * basket, re-planning against trade-offs, watching a recurring basket.
 *
 * And the paywall is only ever offered against a figure Juva has already computed.
 * There is no "unlock to see if you could save"; the saving is calculated first, by
 * deterministic code, and the offer quotes it.
 */

/** Items a free basket may hold before Plus is needed. */
export const FREE_ITEM_LIMIT = 10;

/** Saved recurring baskets a free account may keep. Plus is unlimited. */
export const FREE_SAVED_LIST_LIMIT = 1;

/**
 * Optimization runs a free account may make per day.
 *
 * "Limited optimizations" needs a number to mean anything. This one is chosen to be
 * comfortably above a normal weekly shop — a shopper planning one basket, changing
 * their mind twice and re-running is never blocked — while still bounding the
 * repeated re-planning that Plus exists to sell.
 */
export const FREE_OPTIMIZATIONS_PER_DAY = 5;

/** Verified trips a free account can look back through. Plus shows all of them. */
export const FREE_HISTORY_LIMIT = 3;

export type PlusFeature =
  | 'multi_store'
  | 'worth_the_trip'
  | 'unlimited_lists'
  | 'unlimited_optimization'
  | 'recurring_baskets'
  | 'price_alerts'
  | 'budget_agent'
  | 'smart_substitutions'
  | 'full_history';

const PLUS_ONLY: Readonly<Record<PlusFeature, true>> = {
  multi_store: true,
  worth_the_trip: true,
  unlimited_lists: true,
  unlimited_optimization: true,
  recurring_baskets: true,
  price_alerts: true,
  budget_agent: true,
  smart_substitutions: true,
  full_history: true,
};

export function featureAvailable(feature: PlusFeature, hasPlus: boolean): boolean {
  return hasPlus || PLUS_ONLY[feature] !== true;
}

/** Items allowed in a basket. `undefined` means no limit. */
export function itemLimit(hasPlus: boolean): number | undefined {
  return hasPlus ? undefined : FREE_ITEM_LIMIT;
}

export function savedListLimit(hasPlus: boolean): number | undefined {
  return hasPlus ? undefined : FREE_SAVED_LIST_LIMIT;
}

/**
 * Whether another item may be added.
 *
 * Reported as a reason rather than a boolean so the UI can say what the limit is
 * instead of silently refusing a tap.
 */
export interface LimitCheck {
  allowed: boolean;
  /** Present only when blocked. Written to be shown to the shopper verbatim. */
  reason?: string;
}

export function canAddItem(currentCount: number, hasPlus: boolean): LimitCheck {
  const limit = itemLimit(hasPlus);
  if (limit === undefined || currentCount < limit) return { allowed: true };
  return {
    allowed: false,
    reason: `A free basket holds ${limit} items. Juva Plus removes the limit.`,
  };
}

export function canSaveList(currentCount: number, hasPlus: boolean): LimitCheck {
  const limit = savedListLimit(hasPlus);
  if (limit === undefined || currentCount < limit) return { allowed: true };
  return {
    allowed: false,
    reason: `Free keeps ${limit} recurring basket. Juva Plus keeps as many as you like.`,
  };
}

/**
 * Whether another optimization may run today.
 *
 * The count is of runs already made in the current local day; the caller owns the
 * clock so this stays pure and testable.
 */
export function canOptimize(runsToday: number, hasPlus: boolean): LimitCheck {
  if (hasPlus || runsToday < FREE_OPTIMIZATIONS_PER_DAY) return { allowed: true };
  return {
    allowed: false,
    reason: `Free includes ${FREE_OPTIMIZATIONS_PER_DAY} searches a day. Juva Plus is unlimited.`,
  };
}

/**
 * The history a tier may see.
 *
 * Free sees recent savings; Plus sees all of it. Records are never deleted by this —
 * a hidden record still counts toward the verified total, because the shopper earned
 * it whether or not their tier lets them scroll to it.
 */
export function visibleHistory(
  records: readonly SavingsRecord[],
  hasPlus: boolean,
): SavingsRecord[] {
  return hasPlus ? [...records] : records.slice(0, FREE_HISTORY_LIMIT);
}

export function hiddenHistoryCount(records: readonly SavingsRecord[], hasPlus: boolean): number {
  return Math.max(0, records.length - visibleHistory(records, hasPlus).length);
}

/**
 * The plan a free shopper is entitled to shop.
 *
 * Always the cheapest *complete* single-store plan — completeness matters, because a
 * cheaper plan that silently drops an item is not a cheaper shop.
 */
export function freePlan(plans: readonly OptimizedPlan[]): OptimizedPlan | undefined {
  const singles = plans.filter((plan) => plan.stops.length === 1);
  const complete = singles.filter((plan) => plan.complete);
  const candidates = complete.length > 0 ? complete : singles;
  return candidates.reduce<OptimizedPlan | undefined>(
    (best, plan) =>
      best === undefined || plan.basketCostCents < best.basketCostCents ? plan : best,
    undefined,
  );
}

/** The best multi-store plan, which is what Plus unlocks. */
export function bestMultiStorePlan(plans: readonly OptimizedPlan[]): OptimizedPlan | undefined {
  return plans
    .filter((plan) => plan.stops.length > 1)
    .reduce<OptimizedPlan | undefined>(
      (best, plan) =>
        best === undefined || plan.basketCostCents < best.basketCostCents ? plan : best,
      undefined,
    );
}

export interface UpgradePrompt {
  /** Extra saving the multi-store plan would deliver, in integer cents. */
  additionalSavingsCents: number;
  storeCount: number;
  extraDistanceMiles: number;
  extraMinutes: number;
  /** The plan the shopper can already shop, for free. */
  freePlanId: string;
  lockedPlanId: string;
}

/**
 * The one paywall trigger Juva uses.
 *
 * The free single-store plan is shown first and is fully shoppable; only then, and
 * only if a multi-store plan is genuinely cheaper, is the difference named. The
 * figure is the subtraction of two basket costs the optimizer already produced — it
 * is not a projection, a model output, or a rounded marketing number, and if it is
 * zero or negative there is no prompt at all.
 *
 * Returns `undefined` for a shopper who already has Plus, for an empty plan set
 * (which is what a first launch has), and whenever the split does not actually save
 * money. There is deliberately no path here that shows an offer without a
 * calculated saving behind it.
 */
export function upgradePrompt(
  plans: readonly OptimizedPlan[],
  hasPlus: boolean,
): UpgradePrompt | undefined {
  if (hasPlus) return undefined;
  if (plans.length === 0) return undefined;

  const free = freePlan(plans);
  const locked = bestMultiStorePlan(plans);
  if (!free || !locked) return undefined;

  /**
   * Both plans must be comparable, or the difference is not a saving.
   *
   * `freePlan` falls back to an incomplete single-store plan when no complete one
   * exists, and the cheapest multi-store plan may itself be partial. Subtracting
   * those two figures would advertise "Juva found another $12" for a basket that is
   * simply missing two items — a fabricated saving, on the one screen where Juva
   * asks for money. Completeness is the gate here for the same reason it is in the
   * optimizer.
   */
  if (!free.completeness.comparisonEligible || !locked.completeness.comparisonEligible) {
    return undefined;
  }

  const additionalSavingsCents = free.basketCostCents - locked.basketCostCents;
  if (additionalSavingsCents <= 0) return undefined;

  return {
    additionalSavingsCents,
    storeCount: locked.stops.length,
    // Reported so the offer states its cost as well as its benefit.
    extraDistanceMiles: Math.max(0, locked.travelMiles - free.travelMiles),
    extraMinutes: Math.max(0, locked.etaMinutes - free.etaMinutes),
    freePlanId: free.id,
    lockedPlanId: locked.id,
  };
}
