import { brandRankPenaltyCents, effectiveBrandPolicy, matchProduct } from './matching';
import { priceLine, promotionStatusLabel, roundCents, type LinePricing } from './pricing';
import { displayUnitPriceCents } from './quantity';
import type {
  AppliedPromotion,
  BaselineKind,
  Freshness,
  GroceryList,
  GroceryListItem,
  MissingItem,
  MissingReason,
  OptimizedPlan,
  PlanBaseline,
  PlanCompleteness,
  PlanConfidence,
  PlanConfidenceFactor,
  CompletenessRemediation,
  PlanExplanation,
  PlanItem,
  PlanKind,
  PlanScore,
  PlanStop,
  PlanTradeoff,
  Promotion,
  RejectedCandidate,
  RetailerProduct,
  RouteInputs,
  Store,
  UserPreferences,
} from './types';

/**
 * Juva's deterministic grocery planner.
 *
 * Every monetary figure here is integer cents obtained by arithmetic over
 * observed prices. Nothing is estimated, interpolated or model-generated: a line
 * no store can supply becomes a reported missing item, never a guessed price.
 *
 * The engine separates two kinds of number, and never mixes them:
 *
 * - **Money the shopper pays** — `basketCostCents`, line totals, savings. Only
 *   these are presented as prices.
 * - **Planning costs** — travel, time, extra stops, stale data, missing items.
 *   These rank plans against each other and never enter a price or a saving.
 */

/** Hard bound on stores per plan, which bounds the combination search. */
export const MAX_COMBINATION_SIZE = 4;

/** Nearest eligible stores considered, to bound combinatorial work. */
export const MAX_STORES_CONSIDERED = 12;

/**
 * Estimated vehicle running cost per mile, in cents. A published-style mileage
 * assumption, surfaced in the score breakdown and never added to a basket total.
 */
export const DRIVE_COST_CENTS_PER_MILE = 34;

/** Minutes per mile by transport mode. */
const MINUTES_PER_MILE: Record<UserPreferences['transportMode'], number> = {
  drive: 3.2,
  walk: 13,
  transit: 5.5,
};

/** Fixed overhead per trip, in minutes: parking, queueing, walking the aisles. */
const TRIP_OVERHEAD_MINUTES = 12;
/** Extra minutes for each additional stop beyond the first. */
const PER_EXTRA_STOP_MINUTES = 9;
/** Extra miles incurred hopping between stops. */
const PER_EXTRA_STOP_MILES = 1.35;

/**
 * Planning penalty per line, by how much its price can still be trusted.
 *
 * This expresses the risk that the shelf price has moved, and is the mechanism
 * that stops a stale bargain from outranking a fresh, slightly dearer basket.
 * `demo` is zero because the controlled market is deterministic by construction.
 */
export const STALE_PENALTY_CENTS: Record<Freshness, number> = {
  live: 0,
  demo: 0,
  recent: 15,
  older: 60,
  verify: 150,
};

/**
 * Share of a line's money put at risk by an uncertain match.
 *
 * A line Juva is only 60% sure it matched carries 40% × this rate as a ranking
 * penalty. Proportional to the line rather than flat, because being wrong about a
 * $24 roast matters more than being wrong about a 79c onion. Never a price.
 */
export const UNCERTAINTY_PENALTY_RATE = 0.35;

/** Ranking penalty per line whose store publishes no stock feed. */
export const UNKNOWN_AVAILABILITY_PENALTY_CENTS = 8;

/** Rejected candidates kept per basket line, so an explanation stays readable. */
export const MAX_REJECTED_PER_LINE = 4;

/** Least trustworthy first, so a plan reports its weakest link. */
const FRESHNESS_RANK: Record<Freshness, number> = {
  verify: 0,
  older: 1,
  recent: 2,
  demo: 3,
  live: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// Candidate assignment
// ─────────────────────────────────────────────────────────────────────────────

interface Assignment {
  readonly item: GroceryListItem;
  readonly product: RetailerProduct;
  readonly pricing: LinePricing;
  readonly substitution: boolean;
  /** Cost used for ranking candidates. Includes the brand preference penalty. */
  readonly rankCents: number;
  /**
   * Cheapest line total for the *requested* brand at this same store, when it was
   * observed there. Captured during assignment because that is the only point
   * with the store's full candidate set in scope; used to attribute substitution
   * savings to a real observed price rather than an assumed one.
   */
  readonly requestedBrandLineCents?: number;
}

interface CandidatePlan {
  readonly storeKey: string;
  readonly stops: PlanStop[];
  readonly assignments: Assignment[];
  readonly missingItems: MissingItem[];
  readonly complete: boolean;
  readonly basketCostCents: number;
  readonly travelMiles: number;
  readonly etaMinutes: number;
  readonly travelCostCents: number;
  readonly confidence: number;
  readonly weakestFreshness: Freshness;
  readonly score: PlanScore;
  /** Products considered and passed over, capped per line. */
  readonly rejectedCandidates: RejectedCandidate[];
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const first = items[0];
  if (first === undefined) return [];
  const rest = items.slice(1);
  return [
    ...combinations(rest, size - 1).map((combo) => [first, ...combo]),
    ...combinations(rest, size),
  ];
}

/**
 * Best product for one line at one store.
 *
 * Ranked by what the shopper would actually be charged for the whole line, so a
 * cheaper unit price on a pack size that forces buying three does not win over a
 * single correctly-sized pack. Ties break on comparison unit price, then on id so
 * the result is stable.
 */
function bestAssignmentAtStore(
  item: GroceryListItem,
  products: readonly RetailerProduct[],
  promotions: readonly Promotion[],
  prefs: UserPreferences,
  currency: string,
  now: Date,
): { assignment?: Assignment; rejection?: MissingReason; rejected: RejectedCandidate[] } {
  const policy = effectiveBrandPolicy(item, prefs.brandPolicy);
  let best: Assignment | undefined;
  let rejection: MissingReason | undefined;
  let requestedBrandLineCents: number | undefined;
  const matched: Assignment[] = [];
  const unmatched: RejectedCandidate[] = [];

  for (const product of products) {
    const match = matchProduct(item, product, {
      currency,
      defaultBrandPolicy: prefs.brandPolicy,
    });
    if (!match.matched) {
      const reason = mapRejection(match.rejection);
      // Keep the most specific reason, not the last one seen. A shopper who asked for
      // Kellogg's Corn Flakes and was offered Kellogg's Frosties and a Value own-brand
      // gets two rejections; reporting the own-brand's `brand_required` would say "that
      // brand is not stocked" when the brand was on the shelf and the product was not.
      rejection = moreSpecificRejection(rejection, reason);
      // Only reasons that say something about *this* product are worth recording. A
      // `not_stocked_nearby` rejection just means "unrelated product", and listing
      // every unrelated item in the shop explains nothing.
      const recordable = REJECTION_TO_CANDIDATE_REASON[reason ?? 'not_stocked_nearby'];
      if (recordable !== undefined) {
        unmatched.push({
          groceryItemId: item.id,
          storeId: product.storeId,
          retailerProductId: product.observation.retailerProductId,
          productTitle: product.title,
          lineTotalCents: product.observation.priceCents,
          reason: recordable,
        });
      }
      continue;
    }

    const pricing = priceLine(item, product, promotions, prefs, now);

    // Track the requested brand's own cheapest line here, while the store's full
    // candidate set is in scope.
    if (item.requestedBrand !== undefined && !match.substitution) {
      requestedBrandLineCents =
        requestedBrandLineCents === undefined
          ? pricing.chargedTotalCents
          : Math.min(requestedBrandLineCents, pricing.chargedTotalCents);
    }

    const rankCents = pricing.chargedTotalCents + brandRankPenaltyCents(policy, match.substitution);
    const candidate: Assignment = {
      item,
      product,
      pricing,
      substitution: match.substitution,
      rankCents,
    };

    matched.push(candidate);
    if (!best || isBetterAssignment(candidate, best)) best = candidate;
  }

  if (!best) {
    return rejection === undefined ? { rejected: unmatched } : { rejection, rejected: unmatched };
  }
  const winner = best;
  const rejected = [
    ...matched.filter((entry) => entry !== winner).map((entry) => describeRejection(entry, winner)),
    ...unmatched,
  ];
  return {
    assignment:
      requestedBrandLineCents === undefined ? winner : { ...winner, requestedBrandLineCents },
    rejected,
  };
}

/**
 * Which match rejections are worth showing as a named rejected candidate.
 *
 * `undefined` means "do not record": a concept mismatch is not a decision Juva made
 * about a product, it is simply a different product.
 */
const REJECTION_TO_CANDIDATE_REASON: Record<
  MissingReason,
  RejectedCandidate['reason'] | undefined
> = {
  not_stocked_nearby: undefined,
  unavailable: 'unavailable',
  brand_required: 'brand_policy',
  variant_required: 'brand_policy',
  barcode_mismatch: 'brand_policy',
  currency_mismatch: 'wrong_currency',
};

/**
 * Why a matched product lost to the one Juva chose.
 *
 * Derived by comparing the two rather than recorded during ranking, so the stated
 * reason is always the actual difference between them and cannot drift from
 * `isBetterAssignment`.
 */
function describeRejection(loser: Assignment, winner: Assignment): RejectedCandidate {
  const reason: RejectedCandidate['reason'] =
    // Cheaper on the shelf but ranked below the winner: only the brand penalty can
    // do that, so say so plainly instead of calling a cheaper product "dearer".
    loser.pricing.chargedTotalCents < winner.pricing.chargedTotalCents
      ? 'brand_policy'
      : loser.pricing.chargedTotalCents > winner.pricing.chargedTotalCents
        ? 'dearer'
        : FRESHNESS_RANK[loser.product.observation.freshness] <
            FRESHNESS_RANK[winner.product.observation.freshness]
          ? 'weaker_freshness'
          : 'lower_confidence';
  return {
    groceryItemId: loser.item.id,
    storeId: loser.product.storeId,
    retailerProductId: loser.product.observation.retailerProductId,
    productTitle: loser.product.title,
    lineTotalCents: loser.pricing.chargedTotalCents,
    reason,
  };
}

function isBetterAssignment(candidate: Assignment, incumbent: Assignment): boolean {
  if (candidate.rankCents !== incumbent.rankCents) {
    return candidate.rankCents < incumbent.rankCents;
  }
  // Same line cost: prefer the better value per unit, which favours the larger
  // pack when both satisfy the request identically.
  const candidateUnit = candidate.pricing.unitPrice?.centsPerBaseUnit;
  const incumbentUnit = incumbent.pricing.unitPrice?.centsPerBaseUnit;
  if (
    candidateUnit !== undefined &&
    incumbentUnit !== undefined &&
    candidateUnit !== incumbentUnit
  ) {
    return candidateUnit < incumbentUnit;
  }
  return candidate.product.id.localeCompare(incumbent.product.id) < 0;
}

/**
 * How informative each missing-item reason is, most specific first.
 *
 * The first three describe the *requested* product: Juva found it and something about
 * that article stopped it. `brand_required` is weaker — it describes a policy blocking
 * some other product — and `not_stocked_nearby` says only that nothing matched.
 */
const REJECTION_SPECIFICITY: readonly MissingReason[] = [
  'barcode_mismatch',
  'variant_required',
  'unavailable',
  'brand_required',
  'currency_mismatch',
  'not_stocked_nearby',
];

function moreSpecificRejection(
  current: MissingReason | undefined,
  candidate: MissingReason | undefined,
): MissingReason | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return REJECTION_SPECIFICITY.indexOf(candidate) < REJECTION_SPECIFICITY.indexOf(current)
    ? candidate
    : current;
}

function mapRejection(
  rejection: ReturnType<typeof matchProduct>['rejection'],
): MissingReason | undefined {
  switch (rejection) {
    case 'unavailable':
      return 'unavailable';
    case 'brand_required':
      return 'brand_required';
    case 'variant_required':
      return 'variant_required';
    case 'barcode_mismatch':
      return 'barcode_mismatch';
    case 'currency_mismatch':
      return 'currency_mismatch';
    case 'concept_mismatch':
    case 'price_not_positive':
    case undefined:
      return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry and scoring
// ─────────────────────────────────────────────────────────────────────────────

interface Geometry {
  readonly travelMiles: number;
  readonly etaMinutes: number;
  readonly travelCostCents: number;
}

/**
 * Estimated trip geometry: out and back to the furthest stop, plus a hop for each
 * extra store. Explicitly an estimate, and reported as one.
 */
export function estimateGeometry(stops: readonly PlanStop[], prefs: UserPreferences): Geometry {
  if (stops.length === 0) return { travelMiles: 0, etaMinutes: 0, travelCostCents: 0 };
  const furthestMiles = Math.max(...stops.map((stop) => stop.store.distanceMiles));
  const extraStops = Math.max(0, stops.length - 1);
  const travelMiles = Number((furthestMiles * 2 + extraStops * PER_EXTRA_STOP_MILES).toFixed(2));
  const etaMinutes = Math.round(
    TRIP_OVERHEAD_MINUTES +
      travelMiles * MINUTES_PER_MILE[prefs.transportMode] +
      extraStops * PER_EXTRA_STOP_MINUTES,
  );
  // Only driving carries a per-mile money cost. Transit fares are not modelled
  // rather than invented, so transit shows as time cost only.
  const travelCostCents =
    prefs.transportMode === 'drive' ? roundCents(travelMiles * DRIVE_COST_CENTS_PER_MILE) : 0;
  return { travelMiles, etaMinutes, travelCostCents };
}

/** Minutes per mile for a transport mode. One table, shared with Shop Mode. */
export function minutesPerMileFor(mode: UserPreferences['transportMode']): number {
  return MINUTES_PER_MILE[mode];
}

/** Miles and minutes added by one more stop on a route. */
export const EXTRA_STOP_MILES = PER_EXTRA_STOP_MILES;
export const EXTRA_STOP_MINUTES = PER_EXTRA_STOP_MINUTES;

/**
 * Weighted planning cost of a piece of effort, in cents.
 *
 * The single place effort is priced. Shop Mode's replanner compares a detour against
 * a price difference using exactly this function, so a mid-trip decision cannot use a
 * gentler travel model than the one that produced the plan — which is how a 30c saving
 * would end up justifying a 6-mile drive.
 *
 * Returns a *ranking* cost, never money the shopper pays.
 */
export function effortCostCents(
  effort: { miles: number; minutes: number; extraStops: number },
  prefs: UserPreferences,
): number {
  const travelCents =
    prefs.transportMode === 'drive' ? effort.miles * DRIVE_COST_CENTS_PER_MILE : 0;
  const timeCents = effort.minutes * prefs.timeValueCentsPerMinute;
  const stopCents = Math.max(0, effort.extraStops) * prefs.extraStopPenaltyCents;
  return roundCents((travelCents + timeCents + stopCents) * effortWeightFor(prefs));
}

/**
 * The comparison the Worth the Trip control renders.
 *
 * Extracted from the component so it can be tested, and so there is no second place
 * where a "cheaper alternative" could be decided. The control's whole claim is that
 * its numbers come from plans the optimizer actually generated — a claim that is only
 * checkable if the derivation is a function rather than JSX.
 */
export interface TripComparison {
  /** The cheapest complete plan, when it is not the one already selected. */
  readonly alternative?: OptimizedPlan;
  /** Basket difference against the selected plan. Never negative. */
  readonly extraSavingsCents: number;
  readonly extraMinutes: number;
  readonly extraStops: number;
  /** Whether the alternative scores better once effort is weighed. */
  readonly alternativeScoresBetter: boolean;
}

export function worthTheTripComparison(
  selected: OptimizedPlan,
  plans: readonly OptimizedPlan[],
): TripComparison {
  // Only complete plans, for the same reason savings are gated on completeness: a
  // basket missing an item is cheaper for the wrong reason.
  const cheapest = [...plans]
    .filter((plan) => plan.completeness.comparisonEligible)
    .sort((a, b) => a.basketCostCents - b.basketCostCents || a.id.localeCompare(b.id))[0];

  const alternative = cheapest && cheapest.id !== selected.id ? cheapest : undefined;
  if (!alternative) {
    return {
      extraSavingsCents: 0,
      extraMinutes: 0,
      extraStops: 0,
      alternativeScoresBetter: false,
    };
  }

  return {
    alternative,
    extraSavingsCents: Math.max(0, selected.basketCostCents - alternative.basketCostCents),
    extraMinutes: alternative.etaMinutes - selected.etaMinutes,
    extraStops: alternative.stops.length - selected.stops.length,
    alternativeScoresBetter: alternative.effectiveCostCents < selected.effectiveCostCents,
  };
}

/**
 * Floor on the effort weight, so a trip is never free to the ranking.
 *
 * Without this, `conveniencePreference: 0` multiplied travel, time and the extra-stop
 * penalty by zero — and a 30c cheaper line 6 miles away won, sending the shopper on a
 * 12-mile round trip that costs about $4 in fuel by Juva's own mileage figure to save
 * 30c. That is not "the lowest total", which is what the setting promises; it is a
 * worse total with the driving left out of the sum.
 *
 * The floor only binds below `conveniencePreference` 0.1. Both documented anchors are
 * unchanged: 0.5 still weights effort at face value, 1 still weights it double.
 */
export const MIN_EFFORT_WEIGHT = 0.2;

export function effortWeightFor(prefs: UserPreferences): number {
  const preference = Math.min(1, Math.max(0, prefs.conveniencePreference));
  return Number(Math.max(MIN_EFFORT_WEIGHT, preference * 2).toFixed(4));
}

/**
 * Scores a plan for ranking.
 *
 * The weighted sum is what the recommendation uses. Effort terms scale with the
 * shopper's convenience preference; risk terms (stale data, missing items) do
 * not, because a shopper who wants the lowest price still does not want a price
 * that has moved or an item they cannot buy.
 */
export function scorePlan(input: {
  basketCostCents: number;
  travelCostCents: number;
  etaMinutes: number;
  stopCount: number;
  assignments: readonly Assignment[];
  missingCount: number;
  prefs: UserPreferences;
}): PlanScore {
  const travelTimeCostCents = roundCents(input.etaMinutes * input.prefs.timeValueCentsPerMinute);
  const extraStopPenaltyCents =
    Math.max(0, input.stopCount - 1) * input.prefs.extraStopPenaltyCents;
  const staleDataPenaltyCents = input.assignments.reduce(
    (sum, assignment) => sum + STALE_PENALTY_CENTS[assignment.product.observation.freshness],
    0,
  );
  const missingItemPenaltyCents = input.missingCount * input.prefs.missingItemPenaltyCents;
  const uncertaintyPenaltyCents = input.assignments.reduce((sum, assignment) => {
    const { confidence, availability } = assignment.product.observation;
    const doubt = Math.max(0, 1 - confidence);
    const matchRisk = roundCents(
      assignment.pricing.chargedTotalCents * doubt * UNCERTAINTY_PENALTY_RATE,
    );
    const stockRisk = availability === 'unknown' ? UNKNOWN_AVAILABILITY_PENALTY_CENTS : 0;
    return sum + matchRisk + stockRisk;
  }, 0);
  const effortWeight = effortWeightFor(input.prefs);

  const effortCents = input.travelCostCents + travelTimeCostCents + extraStopPenaltyCents;

  return {
    basketCostCents: input.basketCostCents,
    travelCostCents: input.travelCostCents,
    travelTimeCostCents,
    extraStopPenaltyCents,
    staleDataPenaltyCents,
    missingItemPenaltyCents,
    uncertaintyPenaltyCents,
    effortWeight,
    totalCents: roundCents(
      input.basketCostCents +
        effortCents * effortWeight +
        staleDataPenaltyCents +
        missingItemPenaltyCents +
        uncertaintyPenaltyCents,
    ),
  };
}

/** Raw effort cost, unweighted. Used to rank the lowest-effort plan. */
function rawEffortCents(plan: CandidatePlan, prefs: UserPreferences): number {
  return (
    plan.travelCostCents +
    roundCents(plan.etaMinutes * prefs.timeValueCentsPerMinute) +
    Math.max(0, plan.stops.length - 1) * prefs.extraStopPenaltyCents
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan construction
// ─────────────────────────────────────────────────────────────────────────────

function toPlanItem(assignment: Assignment): PlanItem {
  const { item, product, pricing } = assignment;
  const promotionLabel = promotionStatusLabel(pricing);
  const comparison = pricing.unitPrice;

  // Substitution saving against the requested brand at this same store. Zero when
  // that brand was never observed here, rather than an assumed difference.
  const substitutionSavingsCents =
    assignment.substitution && assignment.requestedBrandLineCents !== undefined
      ? Math.max(0, assignment.requestedBrandLineCents - pricing.chargedTotalCents)
      : 0;

  return {
    groceryItemId: item.id,
    ...(product.identifiers === undefined ? {} : { identifiers: product.identifiers }),
    requestedName: item.displayName,
    storeId: product.storeId,
    retailerProductId: product.id,
    productTitle: product.title,
    productBrand: product.brand,
    sizeLabel: product.sizeLabel,
    quantity: pricing.packs,
    packBasis: pricing.packBasis,
    roundedUp: pricing.roundedUp,
    listPriceCents: pricing.listUnitCents,
    unitPriceCents: pricing.effectiveUnitCents,
    lineTotalCents: pricing.chargedTotalCents,
    listTotalCents: pricing.listTotalCents,
    promotionSavingsCents: pricing.promotionSavingsCents,
    substitutionSavingsCents,
    confidence: product.observation.confidence,
    freshness: product.observation.freshness,
    source: product.observation.source,
    observedAt: product.observation.observedAt,
    substitution: assignment.substitution,
    promotionStatus: pricing.promotionStatus,
    ...(comparison === undefined
      ? {}
      : {
          comparisonUnitPriceCents: displayUnitPriceCents(comparison),
          comparisonUnitLabel: comparison.label,
        }),
    ...(promotionLabel === undefined ? {} : { promotionLabel }),
  };
}

function buildCandidate(
  list: GroceryList,
  storeCombo: readonly Store[],
  assignmentIndex: Map<string, Map<string, Assignment>>,
  rejectionIndex: Map<string, Map<string, MissingReason>>,
  rejectedIndex: Map<string, Map<string, RejectedCandidate[]>>,
  anywhereIndex: Set<string>,
  prefs: UserPreferences,
  promotions: readonly Promotion[],
  now: Date,
): CandidatePlan | null {
  if (list.items.length === 0) return null;

  const comboIds = storeCombo.map((store) => store.id);
  const chosen: Assignment[] = [];
  const missingItems: MissingItem[] = [];
  const rejectedCandidates: RejectedCandidate[] = [];

  for (const item of list.items) {
    const perStore = assignmentIndex.get(item.id);
    let best: Assignment | undefined;
    for (const storeId of comboIds) {
      const assignment = perStore?.get(storeId);
      if (!assignment) continue;
      if (!best || isBetterAssignment(assignment, best)) best = assignment;
    }

    if (best) {
      chosen.push(best);
      // Two kinds of loser are worth explaining: another store in this same plan
      // that could have supplied the line, and the products passed over inside the
      // store that won it.
      const winner = best;
      const crossStore = comboIds
        .map((storeId) => perStore?.get(storeId))
        .filter((entry): entry is Assignment => entry !== undefined && entry !== winner)
        .map((entry) => describeRejection(entry, winner));
      const withinStore = rejectedIndex.get(item.id)?.get(winner.product.storeId) ?? [];
      rejectedCandidates.push(
        ...[...crossStore, ...withinStore]
          .sort(
            (a, b) =>
              a.lineTotalCents - b.lineTotalCents ||
              a.retailerProductId.localeCompare(b.retailerProductId),
          )
          .slice(0, MAX_REJECTED_PER_LINE),
      );
      continue;
    }

    // Report the most specific reason any store in this combo gave.
    const reasons = comboIds
      .map((storeId) => rejectionIndex.get(item.id)?.get(storeId))
      .filter((reason): reason is MissingReason => reason !== undefined);
    missingItems.push({
      groceryItemId: item.id,
      requestedName: item.displayName,
      reason: reasons[0] ?? 'not_stocked_nearby',
      availableElsewhere: anywhereIndex.has(item.id),
    });
  }

  if (chosen.length === 0) return null;

  // Minimum-spend offers can only be decided now, once this combination's per-store
  // subtotals exist. Until this point they were `unresolved` and contributed nothing.
  const settled = resolveSpendGatedPromotions(chosen, promotions, prefs, now);

  const usedStoreIds = new Set(settled.map((assignment) => assignment.product.storeId));
  const stops: PlanStop[] = storeCombo
    .filter((store) => usedStoreIds.has(store.id))
    .map((store) => {
      const items = settled
        .filter((assignment) => assignment.product.storeId === store.id)
        .map(toPlanItem);
      return {
        store,
        items,
        subtotalCents: items.reduce((sum, item) => sum + item.lineTotalCents, 0),
      };
    })
    .sort((a, b) => a.store.distanceMiles - b.store.distanceMiles);

  const basketCostCents = stops.reduce((sum, stop) => sum + stop.subtotalCents, 0);
  const geometry = estimateGeometry(stops, prefs);
  const weakestFreshness = settled.reduce<Freshness>((worst, assignment) => {
    const candidate = assignment.product.observation.freshness;
    return FRESHNESS_RANK[candidate] < FRESHNESS_RANK[worst] ? candidate : worst;
  }, 'live');

  return {
    storeKey: [...usedStoreIds].sort().join('-'),
    stops,
    assignments: chosen,
    missingItems,
    complete: missingItems.length === 0,
    basketCostCents,
    travelMiles: geometry.travelMiles,
    etaMinutes: geometry.etaMinutes,
    travelCostCents: geometry.travelCostCents,
    confidence:
      settled.reduce((sum, assignment) => sum + assignment.product.observation.confidence, 0) /
      chosen.length,
    rejectedCandidates,
    weakestFreshness,
    score: scorePlan({
      basketCostCents,
      travelCostCents: geometry.travelCostCents,
      etaMinutes: geometry.etaMinutes,
      stopCount: stops.length,
      assignments: chosen,
      missingCount: missingItems.length,
      prefs,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface OptimizeInput {
  readonly list: GroceryList;
  readonly stores: readonly Store[];
  readonly products: readonly RetailerProduct[];
  readonly promotions: readonly Promotion[];
  readonly preferences: UserPreferences;
  /** Injected for deterministic tests of promotion expiry. */
  readonly now?: Date;
  /**
   * The store this shopper normally uses, when known.
   *
   * Enables the `usual_store` baseline — "against where you'd have gone anyway" —
   * which is often the comparison a shopper actually cares about. It is offered
   * *alongside* the default baseline, never instead of it.
   */
  readonly usualStoreId?: string;
  /**
   * What this basket cost the last time it was bought and verified from a receipt.
   *
   * Enables the `previous_recurring_basket` baseline. Must come from a verified
   * trip, never from a previous estimate, or the comparison would be an estimate
   * measured against an estimate.
   */
  readonly previousRecurringBasketCents?: number;
}

/** A baseline before it is measured against any particular plan. */
interface BaselineCandidate {
  kind: BaselineKind;
  cents: number;
  label: string;
  storeId?: string;
}

const PLAN_LABELS: Record<PlanKind, string> = {
  recommended: 'Best for you',
  cheapest_single_store: 'One stop',
  cheapest_multi_store: 'Split the basket',
  lowest_effort: 'Least effort',
  strict_budget: 'Within budget',
  custom: 'Custom',
};

/**
 * Builds the plan set for a basket.
 *
 * Returns up to five distinct plans. A plan kind is absent when it genuinely does
 * not exist — no complete single-store basket nearby, no multi-store option
 * within the store limit, nothing inside the budget — rather than being filled
 * with a near-miss that would misrepresent what is available.
 */
export function optimizeBasket(input: OptimizeInput): OptimizedPlan[] {
  const { list, stores, products, promotions, preferences: prefs } = input;
  const now = input.now ?? new Date();
  if (list.items.length === 0) return [];

  const eligibleStores = [...stores]
    .filter((store) => store.distanceMiles <= prefs.radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, MAX_STORES_CONSIDERED);
  if (eligibleStores.length === 0) return [];

  const productsByStore = new Map<string, RetailerProduct[]>();
  for (const product of products) {
    const bucket = productsByStore.get(product.storeId);
    if (bucket) bucket.push(product);
    else productsByStore.set(product.storeId, [product]);
  }

  // Per (item, store) best assignment. Items are independent given a store set,
  // so precomputing this makes combination search cheap and exact.
  const assignmentIndex = new Map<string, Map<string, Assignment>>();
  const rejectionIndex = new Map<string, Map<string, MissingReason>>();
  const rejectedIndex = new Map<string, Map<string, RejectedCandidate[]>>();
  const anywhereIndex = new Set<string>();

  for (const item of list.items) {
    const perStore = new Map<string, Assignment>();
    const perStoreRejection = new Map<string, MissingReason>();
    const perStoreRejected = new Map<string, RejectedCandidate[]>();
    for (const store of eligibleStores) {
      const result = bestAssignmentAtStore(
        item,
        productsByStore.get(store.id) ?? [],
        promotions,
        prefs,
        list.currency,
        now,
      );
      if (result.rejected.length > 0) perStoreRejected.set(store.id, result.rejected);
      if (result.assignment) {
        perStore.set(store.id, result.assignment);
        anywhereIndex.add(item.id);
      } else if (result.rejection) {
        perStoreRejection.set(store.id, result.rejection);
      }
    }
    assignmentIndex.set(item.id, perStore);
    rejectionIndex.set(item.id, perStoreRejection);
    rejectedIndex.set(item.id, perStoreRejected);
  }

  const storeLimit = Math.max(1, Math.min(Math.floor(prefs.maxStores), MAX_COMBINATION_SIZE));
  const searchSize = Math.min(eligibleStores.length, storeLimit);

  const candidates = new Map<string, CandidatePlan>();
  for (let size = 1; size <= searchSize; size += 1) {
    for (const combo of combinations(eligibleStores, size)) {
      const candidate = buildCandidate(
        list,
        combo,
        assignmentIndex,
        rejectionIndex,
        rejectedIndex,
        anywhereIndex,
        prefs,
        promotions,
        now,
      );
      if (!candidate) continue;
      // Keyed by the stores actually used, so a combo with an idle store collapses
      // onto the smaller plan it is equivalent to.
      const existing = candidates.get(candidate.storeKey);
      if (!existing || candidate.basketCostCents < existing.basketCostCents) {
        candidates.set(candidate.storeKey, candidate);
      }
    }
  }

  const all = [...candidates.values()];
  if (all.length === 0) return [];

  const completePlans = all.filter((plan) => plan.complete);

  // Baseline: the cheapest complete single-store basket. Falls back to the
  // cheapest complete basket of any size, and to none when nothing nearby can
  // supply the whole list — in which case no saving is claimed.
  const cheapestCompleteSingle = pickCheapestBasket(
    completePlans.filter((plan) => plan.stops.length === 1),
  );
  const cheapestCompleteAny = pickCheapestBasket(completePlans);

  const baselines = buildBaselines(
    completePlans,
    cheapestCompleteSingle,
    cheapestCompleteAny,
    input,
  );
  // The default is the *first* baseline by rule, never the largest by outcome.
  const baseline = baselines[0] ?? { kind: 'none' as BaselineKind, cents: 0, label: 'No baseline' };

  const selected: { kind: PlanKind; plan: CandidatePlan }[] = [];

  // 1. Cheapest complete single-store plan. Only complete plans qualify: "one stop
  //    for $38" is not an answer if the one stop is missing the milk.
  if (cheapestCompleteSingle) {
    selected.push({ kind: 'cheapest_single_store', plan: cheapestCompleteSingle });
  }

  // 2. Cheapest complete multi-store plan, within the shopper's store limit.
  const cheapestCompleteMulti = pickCheapestBasket(
    completePlans.filter((plan) => plan.stops.length > 1),
  );
  if (cheapestCompleteMulti) {
    selected.push({ kind: 'cheapest_multi_store', plan: cheapestCompleteMulti });
  }

  // 3. Juva's recommendation: lowest weighted score among the plans that may be
  //    compared at all. When *no* complete plan exists the field is partial plans
  //    only, so the shopper still gets a best answer — it is simply labelled as a
  //    partial one and claims no saving.
  const rankable = completePlans.length > 0 ? completePlans : all;
  const recommended = [...rankable].sort(
    (a, b) =>
      a.score.totalCents - b.score.totalCents ||
      a.missingItems.length - b.missingItems.length ||
      a.stops.length - b.stops.length ||
      a.storeKey.localeCompare(b.storeKey),
  )[0];
  if (recommended) selected.push({ kind: 'recommended', plan: recommended });

  // 4. Lowest-effort plan: least travel, time and stops, ignoring the convenience
  //    weighting so it is a genuine extreme rather than a re-weighted duplicate.
  const lowestEffort = [...rankable].sort((a, b) => {
    const effortA = rawEffortCents(a, prefs) + a.score.missingItemPenaltyCents;
    const effortB = rawEffortCents(b, prefs) + b.score.missingItemPenaltyCents;
    return (
      effortA - effortB ||
      a.basketCostCents - b.basketCostCents ||
      a.storeKey.localeCompare(b.storeKey)
    );
  })[0];
  if (lowestEffort) selected.push({ kind: 'lowest_effort', plan: lowestEffort });

  // 5. Strict-budget plan, only when a budget exists and something fits it.
  if (list.budgetCents !== undefined) {
    const budget = list.budgetCents;
    const withinBudget = rankable.filter((plan) => plan.basketCostCents <= budget);
    const strict = [...withinBudget].sort(
      (a, b) =>
        // Maximise coverage first: a cheap basket missing half the list is not a
        // usable answer to "keep me under budget".
        a.missingItems.length - b.missingItems.length ||
        a.basketCostCents - b.basketCostCents ||
        a.stops.length - b.stops.length ||
        a.storeKey.localeCompare(b.storeKey),
    )[0];
    if (strict) selected.push({ kind: 'strict_budget', plan: strict });
  }

  return dedupePlans(selected, baselines, baseline, cheapestCompleteSingle, prefs, list);
}

/**
 * Every baseline this market supports, most defensible first.
 *
 * Order is the whole point. `cheapest_complete_single_store` is first whenever it
 * exists because it is the honest answer to "what would this have cost me if I'd
 * just gone to one shop?" — and the caller takes the *first* entry as the default,
 * never the largest. A shopper's usual store or their last verified basket may well
 * produce a bigger, more flattering number; those are offered as alternates so the
 * bigger number is visible without being the headline.
 */
function buildBaselines(
  completePlans: readonly CandidatePlan[],
  cheapestCompleteSingle: CandidatePlan | undefined,
  cheapestCompleteAny: CandidatePlan | undefined,
  input: OptimizeInput,
): BaselineCandidate[] {
  const out: BaselineCandidate[] = [];

  if (cheapestCompleteSingle) {
    const storeId = cheapestCompleteSingle.stops[0]?.store.id;
    out.push({
      kind: 'cheapest_complete_single_store',
      cents: cheapestCompleteSingle.basketCostCents,
      label: 'Cheapest single store nearby',
      ...(storeId === undefined ? {} : { storeId }),
    });
  } else if (cheapestCompleteAny) {
    out.push({
      kind: 'cheapest_complete_any',
      cents: cheapestCompleteAny.basketCostCents,
      label: 'Cheapest complete basket nearby',
    });
  }

  // The shopper's usual store, but only when it can supply the *whole* basket —
  // otherwise the comparison is against a shop that would have sent them home
  // without half the list.
  const usualStoreId = input.usualStoreId;
  if (usualStoreId !== undefined) {
    const usual = completePlans.find(
      (plan) => plan.stops.length === 1 && plan.stops[0]?.store.id === usualStoreId,
    );
    if (usual) {
      out.push({
        kind: 'usual_store',
        cents: usual.basketCostCents,
        label: 'Your usual store',
        storeId: usualStoreId,
      });
    }
  }

  const previous = input.previousRecurringBasketCents;
  if (previous !== undefined && previous > 0) {
    out.push({
      kind: 'previous_recurring_basket',
      cents: previous,
      label: 'What you paid last time',
    });
  }

  if (out.length === 0) {
    out.push({ kind: 'none', cents: 0, label: 'No complete basket nearby to compare against' });
  }
  return out;
}

/**
 * Settles minimum-spend offers now that the plan's per-store subtotals are known.
 *
 * During assignment a spend-gated offer is `unresolved`: whether it applies depends
 * on what else this particular plan buys at that store, which is not known until a
 * store combination exists. So the discount contributed nothing, and this pass gives
 * it the chance to.
 *
 * The subtlety is that granting a discount lowers the very subtotal the threshold was
 * tested against, which can take the plan back below the minimum. So this iterates to
 * a fixed point on the *post-discount* spend — the figure a till would ring up — and
 * every round can only lower it, so it terminates. If it has not stabilised within
 * `SPEND_RESOLUTION_ROUNDS`, the discount is dropped: an offer Juva cannot settle is
 * an offer it does not promise.
 */
const SPEND_RESOLUTION_ROUNDS = 4;

function resolveSpendGatedPromotions(
  chosen: readonly Assignment[],
  promotions: readonly Promotion[],
  prefs: UserPreferences,
  now: Date,
): Assignment[] {
  if (!chosen.some((assignment) => assignment.pricing.hasUnresolvedPromotion)) return [...chosen];

  let current = [...chosen];
  for (let round = 0; round < SPEND_RESOLUTION_ROUNDS; round += 1) {
    const spendByStore = new Map<string, number>();
    for (const assignment of current) {
      const storeId = assignment.product.storeId;
      spendByStore.set(
        storeId,
        (spendByStore.get(storeId) ?? 0) + assignment.pricing.chargedTotalCents,
      );
    }

    const next = current.map((assignment) => {
      if (!assignment.pricing.hasUnresolvedPromotion) return assignment;
      const spend = spendByStore.get(assignment.product.storeId) ?? 0;
      const pricing = priceLine(assignment.item, assignment.product, promotions, prefs, now, spend);
      if (pricing.chargedTotalCents === assignment.pricing.chargedTotalCents) return assignment;
      return {
        ...assignment,
        pricing,
        // The ranking delta moves with the charge, so a resolved discount also makes
        // the plan rank as the better trip it now is.
        rankCents:
          assignment.rankCents - (assignment.pricing.chargedTotalCents - pricing.chargedTotalCents),
      };
    });

    const stable = next.every(
      (assignment, index) =>
        assignment.pricing.chargedTotalCents === current[index]?.pricing.chargedTotalCents,
    );
    current = next;
    if (stable) return current;
  }

  // Did not settle. Fall back to the undiscounted pricing rather than pick a round.
  return [...chosen];
}

function pickCheapestBasket(plans: readonly CandidatePlan[]): CandidatePlan | undefined {
  return [...plans].sort(
    (a, b) =>
      a.basketCostCents - b.basketCostCents ||
      a.stops.length - b.stops.length ||
      a.storeKey.localeCompare(b.storeKey),
  )[0];
}

/**
 * Collapses plan kinds that resolved to the same shopping trip.
 *
 * When the cheapest single-store plan *is* the recommendation, Juva shows one
 * plan rather than two identical cards with different titles. Kind priority is
 * the order a shopper cares about.
 */
const KIND_PRIORITY: PlanKind[] = [
  'recommended',
  'cheapest_single_store',
  'cheapest_multi_store',
  'strict_budget',
  'lowest_effort',
  'custom',
];

function dedupePlans(
  selected: readonly { kind: PlanKind; plan: CandidatePlan }[],
  baselines: readonly BaselineCandidate[],
  baseline: BaselineCandidate,
  reference: CandidatePlan | undefined,
  prefs: UserPreferences,
  list: GroceryList,
): OptimizedPlan[] {
  const byTrip = new Map<
    string,
    { kind: PlanKind; plan: CandidatePlan; alsoKnownAs: PlanKind[] }
  >();

  for (const entry of selected) {
    // Two selections are the same trip only if they buy the same things at the
    // same stores for the same money.
    const tripKey = `${entry.plan.storeKey}|${entry.plan.basketCostCents}|${entry.plan.missingItems.length}`;
    const existing = byTrip.get(tripKey);
    if (!existing) {
      byTrip.set(tripKey, { kind: entry.kind, plan: entry.plan, alsoKnownAs: [] });
      continue;
    }
    const winner =
      KIND_PRIORITY.indexOf(entry.kind) < KIND_PRIORITY.indexOf(existing.kind)
        ? entry.kind
        : existing.kind;
    const loser = winner === entry.kind ? existing.kind : entry.kind;
    byTrip.set(tripKey, {
      kind: winner,
      plan: existing.plan,
      alsoKnownAs: [...existing.alsoKnownAs, loser],
    });
  }

  return [...byTrip.values()]
    .sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind))
    .map((entry) =>
      finalizePlan(entry.plan, entry.kind, entry.alsoKnownAs, {
        baselines,
        baseline,
        reference,
        prefs,
        list,
      }),
    );
}

interface FinalizeContext {
  baselines: readonly BaselineCandidate[];
  baseline: BaselineCandidate;
  /** The cheapest complete basket, used as the reference for tradeoff statements. */
  reference: CandidatePlan | undefined;
  prefs: UserPreferences;
  list: GroceryList;
}

function finalizePlan(
  plan: CandidatePlan,
  kind: PlanKind,
  alsoKnownAs: readonly PlanKind[],
  ctx: FinalizeContext,
): OptimizedPlan {
  const { baseline, prefs, list } = ctx;
  const completeness = buildCompleteness(plan, list, prefs);

  // Savings only mean something against a complete baseline, and only for a plan
  // that is itself complete. An incomplete basket is cheaper for the wrong reason.
  const savings = savingsAgainst(baseline, plan, completeness);

  const confidence = buildConfidence(plan, completeness);
  const baselineViews: PlanBaseline[] = ctx.baselines.map((candidate) => ({
    kind: candidate.kind,
    cents: candidate.cents,
    label: candidate.label,
    ...(candidate.storeId === undefined ? {} : { storeId: candidate.storeId }),
    isDefault: candidate.kind === baseline.kind,
    savingsCents: savingsAgainst(candidate, plan, completeness),
  }));

  const explanation: PlanExplanation = {
    basketCostCents: plan.basketCostCents,
    storeCount: plan.stops.length,
    travelMiles: plan.travelMiles,
    etaMinutes: plan.etaMinutes,
    baselineCents: baseline.cents,
    baselineKind: baseline.kind,
    estimatedSavingsCents: savings,
    rationale: buildRationale(
      plan,
      kind,
      alsoKnownAs,
      baseline,
      savings,
      completeness,
      prefs,
      list,
    ),
    score: plan.score,
    storesSelected: plan.stops.map((stop) => stop.store.id),
    productsChosen: plan.assignments.map((assignment) => ({
      groceryItemId: assignment.item.id,
      storeId: assignment.product.storeId,
      retailerProductId: assignment.product.observation.retailerProductId,
    })),
    rejectedCandidates: plan.rejectedCandidates,
    promotionsApplied: appliedPromotions(plan),
    routeInputs: routeInputsFor(plan, prefs),
    confidence,
    completeness,
    baselines: baselineViews,
    tradeoffs: buildTradeoffs(plan, ctx.reference),
  };

  return {
    id: `plan-${kind}-${plan.storeKey}`,
    kind,
    label: PLAN_LABELS[kind],
    stops: plan.stops,
    basketCostCents: plan.basketCostCents,
    pricedSubtotalCents: plan.basketCostCents,
    travelCostCents: plan.travelCostCents,
    effectiveCostCents: plan.score.totalCents,
    travelMiles: plan.travelMiles,
    etaMinutes: plan.etaMinutes,
    confidence: confidence.score,
    confidenceDetail: confidence,
    comparedBaselineCents: baseline.cents,
    savingsVsBaselineCents: savings,
    missingItems: plan.missingItems,
    complete: plan.complete,
    completeness,
    baselines: baselineViews,
    weakestFreshness: plan.weakestFreshness,
    explanation,
  };
}

/**
 * The one place a savings figure is produced.
 *
 * Three gates, all of which must pass: there has to be a real baseline, the plan
 * has to be comparable at all, and the result is floored at zero. Centralised so
 * that no future caller can compute a saving by subtracting two numbers itself.
 */
function savingsAgainst(
  baseline: BaselineCandidate,
  plan: CandidatePlan,
  completeness: PlanCompleteness,
): number {
  if (baseline.kind === 'none' || baseline.cents <= 0) return 0;
  if (!completeness.comparisonEligible) return 0;
  return Math.max(0, baseline.cents - plan.basketCostCents);
}

/**
 * How much of the basket a plan priced, and whether it may be compared.
 *
 * The gate is deliberately absolute: one unpriced line disqualifies the plan from
 * every price comparison. A softer rule — "compare anyway if we got most of it" —
 * is how a $40 basket missing the $12 salmon becomes an advertised $12 saving.
 */
function buildCompleteness(
  plan: CandidatePlan,
  list: GroceryList,
  prefs: UserPreferences,
): PlanCompleteness {
  const requestedItemCount = list.items.length;
  const pricedItemCount = plan.assignments.length;
  const complete = plan.complete && pricedItemCount === requestedItemCount;
  const unresolvedConcepts = plan.missingItems.map((missing) => missing.requestedName);

  if (complete) {
    return {
      requestedItemCount,
      pricedItemCount,
      complete: true,
      unresolvedConcepts: [],
      comparisonEligible: true,
      remediations: [],
    };
  }

  return {
    requestedItemCount,
    pricedItemCount,
    complete: false,
    unresolvedConcepts,
    comparisonEligible: false,
    ineligibleReason: `${pricedItemCount} of ${requestedItemCount} items could be priced, so this is a priced subtotal rather than a basket total.`,
    remediations: remediationsFor(plan, prefs),
  };
}

/**
 * What might actually fix an incomplete basket, most promising first.
 *
 * Derived from why each line failed rather than offered as a generic list, so a
 * shopper is not told to widen their radius when the item is stocked next door and
 * their own brand rule is what excluded it.
 */
function remediationsFor(plan: CandidatePlan, prefs: UserPreferences): CompletenessRemediation[] {
  const out: CompletenessRemediation[] = [];
  const reasons = new Set(plan.missingItems.map((missing) => missing.reason));

  if (plan.missingItems.some((missing) => missing.availableElsewhere)) out.push('widen_radius');
  if (
    reasons.has('brand_required') ||
    reasons.has('variant_required') ||
    prefs.brandPolicy === 'exact_product' ||
    prefs.brandPolicy === 'exact_brand'
  ) {
    out.push('allow_substitutions');
  }
  if (reasons.has('not_stocked_nearby') && !out.includes('widen_radius')) out.push('widen_radius');
  // Always last: retrying is the only option left when nothing about the request
  // explains the gap, and offering it first would blame the shopper's setup for
  // what is usually thin coverage.
  out.push('retry_providers');
  out.push('remove_unpriced_items');
  return out;
}

/** Permille confidence before any factor is applied. */
export const CONFIDENCE_BASE_PERMILLE = 1000;

/**
 * Juva Plan Confidence, as arithmetic rather than as a feeling.
 *
 * Each factor states a count and the permille it moves the score, and the score is
 * exactly the base plus their sum. So the number is reconstructible from what the
 * shopper is shown — which is the only version of a confidence score worth showing.
 */
function buildConfidence(plan: CandidatePlan, completeness: PlanCompleteness): PlanConfidence {
  const factors: PlanConfidenceFactor[] = [];
  const total = plan.assignments.length;
  const substitutions = plan.assignments.filter((a) => a.substitution).length;
  const exact = total - substitutions;
  const fresh = plan.assignments.filter((a) =>
    ['live', 'recent', 'demo'].includes(a.product.observation.freshness),
  ).length;
  const stale = total - fresh;
  const unknownStock = plan.assignments.filter(
    (a) => a.product.observation.availability === 'unknown',
  ).length;
  const unverifiable = plan.assignments.filter(
    (a) => a.pricing.promotionStatus === 'unmodelled_condition',
  ).length;

  if (exact > 0) {
    // Counted against the whole request, not just the lines that got priced.
    // "12 of 12 matched exactly" beside "1 item could not be priced" reads as a
    // contradiction; "12 of 13" is the same fact stated so it cannot mislead.
    factors.push({
      kind: 'exact_matches',
      count: exact,
      deltaPermille: 0,
      detail: `${exact} of ${completeness.requestedItemCount} matched exactly`,
    });
  }
  if (substitutions > 0) {
    factors.push({
      kind: 'substitutions',
      count: substitutions,
      deltaPermille: -40 * substitutions,
      detail: `${substitutions} substituted for an equivalent`,
    });
  }
  if (fresh > 0) {
    factors.push({
      kind: 'fresh_prices',
      count: fresh,
      deltaPermille: 0,
      detail: `${fresh} price${fresh === 1 ? '' : 's'} recently checked`,
    });
  }
  if (stale > 0) {
    factors.push({
      kind: 'stale_prices',
      count: stale,
      deltaPermille: -60 * stale,
      detail: `${stale} price${stale === 1 ? '' : 's'} worth checking at the shelf`,
    });
  }
  if (unknownStock > 0) {
    factors.push({
      kind: 'unknown_availability',
      count: unknownStock,
      deltaPermille: -15 * unknownStock,
      detail: `${unknownStock} with no stock information`,
    });
  }
  if (unverifiable > 0) {
    factors.push({
      kind: 'unverifiable_promotions',
      count: unverifiable,
      deltaPermille: -20 * unverifiable,
      detail: `${unverifiable} promotion${unverifiable === 1 ? '' : 's'} Juva could not verify`,
    });
  }
  // An unpriced line is the heaviest factor there is: it is the difference between
  // a plan and a partial answer.
  const unpriced = completeness.requestedItemCount - completeness.pricedItemCount;
  if (unpriced > 0) {
    factors.push({
      kind: 'unpriced_items',
      count: unpriced,
      deltaPermille: -150 * unpriced,
      detail: `${unpriced} item${unpriced === 1 ? '' : 's'} could not be priced at all`,
    });
  }

  const permille = factors.reduce(
    (sum, factor) => sum + factor.deltaPermille,
    CONFIDENCE_BASE_PERMILLE,
  );
  return {
    score: Math.min(1, Math.max(0, permille / 1000)),
    basePermille: CONFIDENCE_BASE_PERMILLE,
    factors,
  };
}

/** Promotions this plan actually applied, with what each was worth. */
function appliedPromotions(plan: CandidatePlan): AppliedPromotion[] {
  const out: AppliedPromotion[] = [];
  for (const assignment of plan.assignments) {
    const promotion = assignment.pricing.promotion;
    // A promotion that exists but did not apply is not an applied promotion.
    if (!promotion || assignment.pricing.promotionSavingsCents <= 0) continue;
    out.push({
      promotionId: promotion.id,
      label: promotion.label,
      groceryItemId: assignment.item.id,
      storeId: assignment.product.storeId,
      savingsCents: assignment.pricing.promotionSavingsCents,
    });
  }
  return out;
}

/** The assumptions behind a plan's distance and time figures, stated rather than implied. */
function routeInputsFor(plan: CandidatePlan, prefs: UserPreferences): RouteInputs {
  return {
    transportMode: prefs.transportMode,
    driveCostCentsPerMile: DRIVE_COST_CENTS_PER_MILE,
    minutesPerMile: MINUTES_PER_MILE[prefs.transportMode],
    tripOverheadMinutes: TRIP_OVERHEAD_MINUTES,
    perExtraStopMinutes: PER_EXTRA_STOP_MINUTES,
    perExtraStopMiles: PER_EXTRA_STOP_MILES,
    stopOrder: plan.stops.map((stop) => stop.store.id),
  };
}

/**
 * The trade this plan makes against the cheapest complete basket.
 *
 * Stated in money, minutes and stops rather than left to be inferred from list
 * order. "Cheapest" and "cheapest practical" only differ in ways a shopper can see
 * if someone writes the difference down.
 */
function buildTradeoffs(plan: CandidatePlan, reference: CandidatePlan | undefined): PlanTradeoff[] {
  if (!reference || reference.storeKey === plan.storeKey) return [];

  const deltaBasketCents = plan.basketCostCents - reference.basketCostCents;
  const deltaMinutes = plan.etaMinutes - reference.etaMinutes;
  const deltaStops = plan.stops.length - reference.stops.length;

  if (deltaBasketCents === 0 && deltaMinutes === 0 && deltaStops === 0) {
    return [
      {
        kind: 'equivalent',
        deltaBasketCents: 0,
        deltaMinutes: 0,
        deltaStops: 0,
        detail: 'Same cost, same effort as the cheapest single store.',
      },
    ];
  }

  const kind: PlanTradeoff['kind'] =
    deltaBasketCents < 0 && deltaMinutes > 0
      ? 'cheaper_but_further'
      : deltaBasketCents > 0 && deltaMinutes < 0
        ? 'dearer_but_closer'
        : deltaStops > 0
          ? 'more_stops'
          : deltaStops < 0
            ? 'fewer_stops'
            : 'equivalent';

  const moneyPart =
    deltaBasketCents === 0
      ? 'the same money'
      : deltaBasketCents < 0
        ? `$${money(-deltaBasketCents)} cheaper`
        : `$${money(deltaBasketCents)} dearer`;
  const timePart =
    deltaMinutes === 0
      ? 'the same time'
      : deltaMinutes > 0
        ? `${deltaMinutes} more minutes`
        : `${-deltaMinutes} fewer minutes`;
  const stopPart =
    deltaStops === 0 ? '' : deltaStops > 0 ? `, ${deltaStops} more stop(s)` : `, one less stop`;

  return [
    {
      kind,
      deltaBasketCents,
      deltaMinutes,
      deltaStops,
      detail: `${moneyPart} for ${timePart}${stopPart}, against the cheapest single store.`,
    },
  ];
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * A sentence explaining the plan in the shopper's terms.
 *
 * Built from the same numbers the score used, so the explanation cannot drift
 * from the decision it describes.
 */
function buildRationale(
  plan: CandidatePlan,
  kind: PlanKind,
  alsoKnownAs: readonly PlanKind[],
  baseline: BaselineCandidate,
  savings: number,
  completeness: PlanCompleteness,
  prefs: UserPreferences,
  list: GroceryList,
): string {
  const parts: string[] = [];
  const storeWord = plan.stops.length === 1 ? 'store' : 'stores';
  // A partial plan's figure is a priced subtotal, and the sentence has to say so
  // before it says anything else. "$1.00 across 1 store" reads as a basket total.
  parts.push(
    completeness.complete
      ? `${money(plan.basketCostCents)} across ${plan.stops.length} ${storeWord}, about ${plan.travelMiles.toFixed(1)} miles and ${plan.etaMinutes} minutes.`
      : `${money(plan.basketCostCents)} for the ${completeness.pricedItemCount} of ${completeness.requestedItemCount} items Juva could price, across ${plan.stops.length} ${storeWord}, about ${plan.travelMiles.toFixed(1)} miles and ${plan.etaMinutes} minutes. That is a priced subtotal, not a basket total.`,
  );

  if (!completeness.complete) {
    const unresolved = completeness.unresolvedConcepts;
    parts.push(
      `${unresolved.length} item${unresolved.length === 1 ? '' : 's'} could not be priced here${unresolved.length > 0 ? ` (${unresolved.join(', ')})` : ''}, so no saving is claimed and this is not compared against any baseline.`,
    );
  } else if (baseline.kind === 'none') {
    parts.push('No nearby store can supply the whole list, so no saving is claimed.');
  } else if (savings > 0) {
    parts.push(
      `That is ${money(savings)} under the ${money(baseline.cents)} baseline: ${baseline.label.toLowerCase()}.`,
    );
  } else {
    parts.push(
      `That matches the ${money(baseline.cents)} ${baseline.label.toLowerCase()} baseline.`,
    );
  }

  switch (kind) {
    case 'recommended': {
      const score = plan.score;
      const effort = roundCents(
        (score.travelCostCents + score.travelTimeCostCents + score.extraStopPenaltyCents) *
          score.effortWeight,
      );
      parts.push(
        `Juva recommends it because basket ${money(score.basketCostCents)} plus ${money(effort)} of weighted travel and effort` +
          (score.staleDataPenaltyCents > 0
            ? `, plus ${money(score.staleDataPenaltyCents)} for prices that may have moved`
            : '') +
          (score.missingItemPenaltyCents > 0
            ? `, plus ${money(score.missingItemPenaltyCents)} for items it cannot supply`
            : '') +
          ` is the lowest total of any option within ${prefs.maxStores} ${prefs.maxStores === 1 ? 'store' : 'stores'}.`,
      );
      break;
    }
    case 'cheapest_single_store':
      parts.push(
        'Everything in one trip, at the cheapest single store that stocks the whole list.',
      );
      break;
    case 'cheapest_multi_store':
      parts.push('The lowest basket price available by splitting across stores.');
      break;
    case 'lowest_effort':
      parts.push('The least travel and fewest stops, whatever the basket costs.');
      break;
    case 'strict_budget':
      parts.push(
        list.budgetCents === undefined
          ? 'Kept within budget.'
          : `Kept within the ${money(list.budgetCents)} budget.`,
      );
      break;
    case 'custom':
      break;
  }

  if (alsoKnownAs.length > 0) {
    parts.push(`This is also the ${alsoKnownAs.map(describeKind).join(' and ')}.`);
  }
  if (plan.weakestFreshness === 'verify' || plan.weakestFreshness === 'older') {
    parts.push('Some prices need checking in store.');
  }
  return parts.join(' ');
}

function describeKind(kind: PlanKind): string {
  switch (kind) {
    case 'recommended':
      return 'recommended plan';
    case 'cheapest_single_store':
      return 'cheapest single-store plan';
    case 'cheapest_multi_store':
      return 'cheapest multi-store plan';
    case 'lowest_effort':
      return 'lowest-effort plan';
    case 'strict_budget':
      return 'within-budget plan';
    case 'custom':
      return 'custom plan';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Savings attribution
// ─────────────────────────────────────────────────────────────────────────────

export interface SavingsAttribution {
  /** Basket difference against the cheapest complete single-store basket. */
  readonly storeSelectionCents: number;
  /** Promotions applied in this plan, measured against observed shelf prices. */
  readonly promotionCents: number;
  /** Substitutions, measured against the requested brand at the same store. */
  readonly substitutionCents: number;
}

/**
 * Attributes savings to their observed causes.
 *
 * These three figures answer different questions and deliberately do not sum to
 * a single headline number: store selection is measured against the single-store
 * baseline, promotions against shelf price, substitutions against the requested
 * brand. Every value is a subtraction of two observed prices.
 */
export function savingsBreakdown(plan: OptimizedPlan): SavingsAttribution {
  const items = plan.stops.flatMap((stop) => stop.items);
  return {
    storeSelectionCents: plan.savingsVsBaselineCents,
    promotionCents: items.reduce((sum, item) => sum + item.promotionSavingsCents, 0),
    substitutionCents: items.reduce((sum, item) => sum + item.substitutionSavingsCents, 0),
  };
}
