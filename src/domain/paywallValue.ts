import { bestMultiStorePlan, freePlan } from './entitlements';
import type { OptimizedPlan } from './types';

/**
 * The evidence behind a personalized paywall claim.
 *
 * The paywall is the one screen where Juva asks for money, which makes it the one screen
 * where a fabricated number does the most damage. So the copy does not compute anything:
 * it renders this object, and this object is only produced when the arithmetic behind it
 * is defensible.
 *
 * Everything here comes from two plans the deterministic optimizer actually generated.
 * There is no model in this path, no estimate, and no example figure — in real mode a
 * claim is either backed by a real comparison or there is no claim.
 */

/**
 * Minimum plan confidence before Juva will quote a personalized figure.
 *
 * Below this the optimizer is telling us it is unsure which products it matched, and a
 * saving computed from uncertain matches is a number with a decimal point and no
 * meaning. The neutral paywall is the honest fallback, not a smaller number.
 */
export const MIN_PAYWALL_CONFIDENCE = 0.7;

/** Why a personalized claim is not being made. Shown in diagnostics, never to sell. */
export type PaywallValueRefusal =
  | 'already_plus'
  | 'no_plans'
  | 'no_locked_plan'
  | 'market_incomplete'
  | 'baseline_invalid'
  | 'no_additional_saving'
  | 'confidence_too_low';

export interface PaywallValueContext {
  /** The free plan the shopper can already have. */
  baselinePlanId: string;
  /** The Plus plan being sold. */
  lockedPlanId: string;
  baselineCostCents: number;
  lockedPlanCostCents: number;
  /** baselineCostCents − lockedPlanCostCents. Always positive when this object exists. */
  potentialSavingsCents: number;
  additionalStops: number;
  additionalTravelMinutes: number;
  additionalTravelMiles: number;
  /** The locked plan's own confidence, 0..1. */
  planConfidence: number;
  /** Whether every requested line was priced in both plans. Always true here. */
  marketCompleteness: 'complete';
  calculatedAt: string;
}

/**
 * Builds the paywall's evidence, or explains why it cannot.
 *
 * Returns a refusal rather than a zeroed context, for the same reason a blocked
 * verification is not a $0 saving: "we cannot say" and "the answer is nothing" are
 * different claims, and only one of them may be rendered as a number.
 */
export function paywallValueContext(input: {
  plans: readonly OptimizedPlan[];
  hasPlus: boolean;
  now?: Date;
}): { context: PaywallValueContext } | { refusal: PaywallValueRefusal } {
  const { plans, hasPlus } = input;
  const now = input.now ?? new Date();

  if (hasPlus) return { refusal: 'already_plus' };
  if (plans.length === 0) return { refusal: 'no_plans' };

  const baseline = freePlan(plans);
  const locked = bestMultiStorePlan(plans);
  if (!baseline) return { refusal: 'no_plans' };
  if (!locked) return { refusal: 'no_locked_plan' };

  /**
   * Both sides must price the whole basket.
   *
   * `freePlan` falls back to an incomplete single-store plan when no complete one
   * exists, and the cheapest multi-store plan may itself be partial. Subtracting those
   * would advertise a saving for a basket that is simply missing two items.
   */
  if (!baseline.completeness.comparisonEligible) return { refusal: 'market_incomplete' };
  if (!locked.completeness.comparisonEligible) return { refusal: 'market_incomplete' };

  // A plan with no comparable baseline has no saving to quote, whatever it costs.
  if (baseline.explanation.baselineKind === 'none') return { refusal: 'baseline_invalid' };

  const potentialSavingsCents = baseline.basketCostCents - locked.basketCostCents;
  if (potentialSavingsCents <= 0) return { refusal: 'no_additional_saving' };

  if (locked.confidence < MIN_PAYWALL_CONFIDENCE) return { refusal: 'confidence_too_low' };

  return {
    context: {
      baselinePlanId: baseline.id,
      lockedPlanId: locked.id,
      baselineCostCents: baseline.basketCostCents,
      lockedPlanCostCents: locked.basketCostCents,
      potentialSavingsCents,
      additionalStops: Math.max(0, locked.stops.length - baseline.stops.length),
      additionalTravelMinutes: Math.max(0, locked.etaMinutes - baseline.etaMinutes),
      additionalTravelMiles: Math.max(
        0,
        Number((locked.travelMiles - baseline.travelMiles).toFixed(2)),
      ),
      planConfidence: locked.confidence,
      marketCompleteness: 'complete',
      calculatedAt: now.toISOString(),
    },
  };
}

/**
 * Re-checks a context's arithmetic before it is rendered.
 *
 * Cheap, and it means a context that was mutated, persisted across a schema change, or
 * assembled by hand in a test cannot reach the paywall carrying a figure that does not
 * follow from its own evidence.
 */
export function paywallValueIsSound(context: PaywallValueContext): boolean {
  return (
    context.potentialSavingsCents === context.baselineCostCents - context.lockedPlanCostCents &&
    context.potentialSavingsCents > 0 &&
    context.baselinePlanId !== context.lockedPlanId &&
    context.planConfidence >= MIN_PAYWALL_CONFIDENCE
  );
}

/**
 * Whether a refusal is a normal outcome or something worth showing in diagnostics.
 *
 * `already_plus` and `no_plans` are simply "not now". The rest mean Juva had plans and
 * declined to quote from them, which is the interesting case when someone asks why a
 * shopper never saw a personalized paywall.
 */
export function refusalIsNoteworthy(refusal: PaywallValueRefusal): boolean {
  return refusal !== 'already_plus' && refusal !== 'no_plans';
}
