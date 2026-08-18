import { packsRequired, unitPriceFor, type PackRequirement, type UnitPrice } from './quantity';
import type { GroceryListItem, Promotion, RetailerProduct, UserPreferences } from './types';

/**
 * Deterministic line pricing: promotions, multibuy arithmetic and pack maths.
 *
 * Every number produced here is integer cents derived from an observed price by
 * addition, multiplication and a single final rounding. No estimate, no model
 * output, and no promotion is applied unless every stated condition is satisfied.
 */

export type PromotionStatus =
  | 'applied'
  | 'none'
  | 'partially_applied'
  | 'requirement_not_met'
  | 'expired'
  | 'loyalty_missing'
  | 'coupon_missing'
  | 'minimum_spend_not_met'
  | 'minimum_spend_unresolved'
  | 'not_stackable'
  | 'unmodelled_condition'
  | 'wrong_retailer'
  | 'not_a_discount';

/**
 * Every condition a promotion can carry, named so evaluation can report on each
 * one separately rather than returning a single opaque verdict.
 */
export type PromotionCondition =
  | 'retailer'
  | 'loyalty'
  | 'coupon'
  | 'quantity'
  | 'multibuy'
  | 'expiry'
  | 'minimum_spend'
  | 'stackability'
  | 'is_a_discount';

/**
 * Whether one condition holds.
 *
 * `unknown` is the important third state. A minimum-spend condition cannot be
 * decided from one line in isolation — it depends on what else the plan buys at that
 * store — and answering "not met" would silently drop a discount the shopper is
 * entitled to, while answering "met" would promise one they are not. So it stays
 * unknown until the plan is assembled, and an unknown condition never yields money.
 */
export type ConditionState = 'met' | 'not_met' | 'unknown';

export interface ConditionResult {
  readonly condition: PromotionCondition;
  readonly state: ConditionState;
  /** Plain-language reason, for the plan explanation. */
  readonly detail: string;
}

/**
 * The three-way verdict the spec requires.
 *
 * `unresolved` is not a failure — it means Juva does not yet know, and is refusing
 * to guess. A discount is only ever included in a total or a saving when the verdict
 * is `eligible`.
 */
export type EligibilityVerdict = 'eligible' | 'ineligible' | 'unresolved';

export interface PromotionEligibility {
  readonly promotion: Promotion;
  readonly verdict: EligibilityVerdict;
  /** Every condition evaluated, in the order they were checked. */
  readonly conditions: readonly ConditionResult[];
  /** The first condition that was not met, or the first unknown one. */
  readonly blockingCondition?: PromotionCondition;
  readonly status: PromotionStatus;
}

/** Context a promotion is judged against, beyond the product itself. */
export interface PromotionContext {
  readonly prefs: UserPreferences;
  readonly now: Date;
  /**
   * What the plan spends at this retailer, when known.
   *
   * Undefined during the first pricing pass, which is exactly when a minimum-spend
   * condition is `unknown`. The optimizer re-prices affected lines once the plan's
   * per-store subtotals exist.
   */
  readonly retailerSpendCents?: number;
}

export interface PromotionDecision {
  readonly status: PromotionStatus;
  readonly promotion?: Promotion;
  /** Per-pack price once the promotion applies. Equals list price when it does not. */
  readonly promotedUnitCents: number;
  /** Packs that must be bought together for the offer to apply. */
  readonly requiredQuantity: number;
  /** Every offer considered for this line, eligible or not. */
  readonly eligibility: readonly PromotionEligibility[];
  /** Offers actually used. More than one only when all of them permit stacking. */
  readonly appliedPromotions: readonly Promotion[];
  /**
   * True when some offer could not be decided yet. The optimizer uses this to know
   * a line is worth re-pricing once store subtotals are known.
   */
  readonly hasUnresolved: boolean;
}

/**
 * Discount one promotion takes off a per-pack price, in cents.
 *
 * Coupon and shelf discounts are summed within a single promotion because they are
 * two ways that one offer can express its value, not two offers. Percentages are
 * applied to the shelf price and floored, so a rounding error never favours Juva's
 * savings number over the shopper's receipt.
 */
export function discountForCents(promotion: Promotion, listCents: number): number {
  if (promotion.overridePriceCents !== undefined) {
    return Math.max(0, listCents - promotion.overridePriceCents);
  }
  const flat = promotion.amountOffCents ?? 0;
  const couponFlat = promotion.couponAmountOffCents ?? 0;
  const percent = promotion.couponPercentOff ?? 0;
  const couponPercent = percent > 0 ? Math.floor((listCents * Math.min(100, percent)) / 100) : 0;
  return Math.min(listCents, flat + couponFlat + couponPercent);
}

/**
 * Evaluates one promotion's conditions against one product.
 *
 * Every condition is checked and recorded even after one fails, so the explanation
 * can show the whole picture rather than only the first obstacle. The *verdict* still
 * turns on the first blocker.
 */
export function evaluateEligibility(
  promotion: Promotion,
  product: RetailerProduct,
  context: PromotionContext,
): PromotionEligibility {
  const listCents = product.observation.priceCents;
  const conditions: ConditionResult[] = [];
  const { prefs, now } = context;

  const sameRetailer = promotion.retailerId === product.observation.retailerId;
  conditions.push({
    condition: 'retailer',
    state: sameRetailer ? 'met' : 'not_met',
    detail: sameRetailer
      ? `offer belongs to ${promotion.retailerId}`
      : `offer belongs to ${promotion.retailerId}, not ${product.observation.retailerId}`,
  });

  const expired =
    promotion.expiresAt !== undefined && Date.parse(promotion.expiresAt) <= now.getTime();
  conditions.push({
    condition: 'expiry',
    state: expired ? 'not_met' : 'met',
    detail:
      promotion.expiresAt === undefined
        ? 'no stated expiry'
        : expired
          ? `expired ${promotion.expiresAt}`
          : `valid until ${promotion.expiresAt}`,
  });

  const loyaltyOk =
    promotion.loyaltyRequired !== true || prefs.loyaltyRetailers.includes(promotion.retailerId);
  conditions.push({
    condition: 'loyalty',
    state: loyaltyOk ? 'met' : 'not_met',
    detail:
      promotion.loyaltyRequired !== true
        ? 'no loyalty card needed'
        : loyaltyOk
          ? 'loyalty card held'
          : 'requires a loyalty card you have not added',
  });

  const couponOk = promotion.couponRequired !== true || prefs.couponIds.includes(promotion.id);
  conditions.push({
    condition: 'coupon',
    state: couponOk ? 'met' : 'not_met',
    detail:
      promotion.couponRequired !== true
        ? 'no coupon needed'
        : couponOk
          ? 'coupon held'
          : 'requires a coupon you do not hold',
  });

  const requiredQuantity = Math.max(1, Math.floor(promotion.requiredQuantity ?? 1));
  conditions.push({
    condition: requiredQuantity > 1 ? 'multibuy' : 'quantity',
    state: 'met',
    detail: requiredQuantity > 1 ? `buy ${requiredQuantity} together` : 'no quantity threshold',
  });

  // Minimum spend: the one condition that genuinely cannot be answered from a line.
  const minimumSpend = promotion.minimumBasketSpendCents;
  const spend = context.retailerSpendCents;
  const spendState: ConditionState =
    minimumSpend === undefined
      ? 'met'
      : spend === undefined
        ? 'unknown'
        : spend >= minimumSpend
          ? 'met'
          : 'not_met';
  conditions.push({
    condition: 'minimum_spend',
    state: spendState,
    detail:
      minimumSpend === undefined
        ? 'no minimum spend'
        : spendState === 'unknown'
          ? `needs ${minimumSpend}c at this store; the plan's spend here is not yet known`
          : spendState === 'met'
            ? `needs ${minimumSpend}c at this store, plan spends ${spend ?? 0}c`
            : `needs ${minimumSpend}c at this store, plan spends only ${spend ?? 0}c`,
  });

  // A condition the source stated but Juva cannot model is never assumed satisfied.
  // It is `not_met` rather than `unknown`: unknown means "ask again later", and there
  // is no later for a condition Juva has no way to evaluate at all.
  const modelled = promotion.hasUnmodelledCondition !== true;
  if (!modelled) {
    conditions.push({
      condition: 'stackability',
      state: 'not_met',
      detail: 'the source states conditions Juva cannot verify',
    });
  }

  const discount = discountForCents(promotion, listCents);
  const isDiscount = discount > 0;
  conditions.push({
    condition: 'is_a_discount',
    state: isDiscount ? 'met' : 'not_met',
    detail: isDiscount ? `${discount}c off ${listCents}c` : 'does not beat the shelf price',
  });

  const failed = conditions.find((entry) => entry.state === 'not_met');
  const unknown = conditions.find((entry) => entry.state === 'unknown');

  const status: PromotionStatus = !sameRetailer
    ? 'wrong_retailer'
    : expired
      ? 'expired'
      : !loyaltyOk
        ? 'loyalty_missing'
        : !couponOk
          ? 'coupon_missing'
          : !modelled
            ? 'unmodelled_condition'
            : spendState === 'not_met'
              ? 'minimum_spend_not_met'
              : spendState === 'unknown'
                ? 'minimum_spend_unresolved'
                : !isDiscount
                  ? 'not_a_discount'
                  : 'applied';

  const verdict: EligibilityVerdict = failed ? 'ineligible' : unknown ? 'unresolved' : 'eligible';
  const blocking = failed?.condition ?? unknown?.condition;

  return {
    promotion,
    verdict,
    conditions,
    ...(blocking === undefined ? {} : { blockingCondition: blocking }),
    status,
  };
}

/**
 * Decides whether a promotion may be used, and at what per-pack price.
 *
 * The order of checks matters for explanation quality: the first genuine reason a
 * promotion cannot be honoured is the one reported.
 */
export function evaluatePromotion(
  product: RetailerProduct,
  promotions: readonly Promotion[],
  prefs: UserPreferences,
  now: Date = new Date(),
  retailerSpendCents?: number,
): PromotionDecision {
  const listCents = product.observation.priceCents;
  const ids = [
    ...(product.observation.promotionId === undefined ? [] : [product.observation.promotionId]),
    ...(product.observation.additionalPromotionIds ?? []),
  ];
  const offers = ids
    .map((id) => promotions.find((entry) => entry.id === id))
    .filter((entry): entry is Promotion => entry !== undefined);

  if (offers.length === 0) {
    return {
      status: 'none',
      promotedUnitCents: listCents,
      requiredQuantity: 1,
      eligibility: [],
      appliedPromotions: [],
      hasUnresolved: false,
    };
  }

  const context: PromotionContext = {
    prefs,
    now,
    ...(retailerSpendCents === undefined ? {} : { retailerSpendCents }),
  };
  const eligibility = offers.map((offer) => evaluateEligibility(offer, product, context));
  const hasUnresolved = eligibility.some((entry) => entry.verdict === 'unresolved');
  const eligible = eligibility.filter((entry) => entry.verdict === 'eligible');

  if (eligible.length === 0) {
    // Nothing may be applied. Report the first offer's own reason, which is the one
    // the shopper would ask about.
    const first = eligibility[0];
    return {
      status: first?.status ?? 'none',
      ...(first === undefined ? {} : { promotion: first.promotion }),
      promotedUnitCents: listCents,
      requiredQuantity: Math.max(1, Math.floor(first?.promotion.requiredQuantity ?? 1)),
      eligibility,
      appliedPromotions: [],
      hasUnresolved,
    };
  }

  /**
   * Choosing between eligible offers.
   *
   * Stacking requires *every* offer in the combination to permit it — one
   * non-stackable offer in the set forbids the whole combination, because
   * "cannot be combined with other offers" is a statement about the other offers
   * too. Otherwise Juva applies the single best one, which is what a till does.
   */
  const stackableSet = eligible.filter((entry) => entry.promotion.stackable === true);
  const canStack = eligible.length > 1 && stackableSet.length === eligible.length;

  const applied = canStack
    ? eligible
    : [
        [...eligible].sort(
          (a, b) =>
            discountForCents(b.promotion, listCents) - discountForCents(a.promotion, listCents) ||
            a.promotion.id.localeCompare(b.promotion.id),
        )[0],
      ].filter((entry): entry is PromotionEligibility => entry !== undefined);

  // Discounts are subtracted in sequence from the shelf price, floored at zero. A
  // stacked pair can take a line to nothing but never below it.
  const promotedUnitCents = applied.reduce(
    (price, entry) => Math.max(0, price - discountForCents(entry.promotion, listCents)),
    listCents,
  );

  const leadEntry = applied[0];
  const requiredQuantity = Math.max(
    1,
    ...applied.map((entry) => Math.floor(entry.promotion.requiredQuantity ?? 1)),
  );

  // An offer that was eligible but lost to a competing non-stackable one is reported
  // as such, so the explanation does not imply it was unavailable.
  const status: PromotionStatus =
    promotedUnitCents >= listCents
      ? 'not_a_discount'
      : !canStack && eligible.length > 1
        ? 'applied'
        : 'applied';

  return {
    status,
    ...(leadEntry === undefined ? {} : { promotion: leadEntry.promotion }),
    promotedUnitCents,
    requiredQuantity,
    eligibility,
    appliedPromotions: applied.map((entry) => entry.promotion),
    hasUnresolved,
  };
}

export interface LinePricing {
  /** Packs bought, or fractional weight for goods sold by weight. */
  readonly packs: number;
  readonly packBasis: PackRequirement['basis'];
  readonly roundedUp: boolean;
  /** Observed shelf price for one pack. */
  readonly listUnitCents: number;
  /** Total at shelf price, with no promotion. */
  readonly listTotalCents: number;
  /** Total Juva expects to be charged. */
  readonly chargedTotalCents: number;
  /** listTotal - chargedTotal. Never negative. */
  readonly promotionSavingsCents: number;
  /** Effective average per pack, for display only. */
  readonly effectiveUnitCents: number;
  readonly promotionStatus: PromotionStatus;
  readonly promotion?: Promotion;
  /** Packs sold at the promotional price. */
  readonly promotedPacks: number;
  readonly unitPrice?: UnitPrice;
  /** Every offer considered on this line, with each condition's outcome. */
  readonly eligibility: readonly PromotionEligibility[];
  /** Offers actually taken off the price. Length above one means they stacked. */
  readonly appliedPromotions: readonly Promotion[];
  /**
   * True when an offer's eligibility could not be decided with what was known.
   * Its discount is *not* in `chargedTotalCents` — an unresolved condition never
   * yields money — and the optimizer re-prices such lines once store spend is known.
   */
  readonly hasUnresolvedPromotion: boolean;
}

/**
 * Prices one basket line at one store.
 *
 * Multibuy is applied by whole qualifying groups, with the remainder at shelf
 * price: a "2 for $7" offer on three packs charges two at the offer price and one
 * at full price. Juva never adds a pack the shopper did not ask for in order to
 * reach a threshold, because that raises the bill to claim a saving.
 */
export function priceLine(
  item: GroceryListItem,
  product: RetailerProduct,
  promotions: readonly Promotion[],
  prefs: UserPreferences,
  now: Date = new Date(),
  retailerSpendCents?: number,
): LinePricing {
  const listUnitCents = product.observation.priceCents;
  const soldByWeight = product.soldByWeight === true;
  const requirement = packsRequired(
    { quantity: item.quantity, unit: item.unit },
    product.sizeLabel,
    soldByWeight,
  );
  const decision = evaluatePromotion(product, promotions, prefs, now, retailerSpendCents);

  const listTotalCents = roundCents(listUnitCents * requirement.packs);

  // Goods sold by weight have no discrete pack, so a multi-pack threshold cannot
  // be evaluated against them.
  const multibuyApplies = decision.requiredQuantity > 1;
  if (decision.status !== 'applied') {
    return finish({
      requirement,
      listUnitCents,
      listTotalCents,
      chargedTotalCents: listTotalCents,
      promotedPacks: 0,
      status: decision.status,
      promotion: decision.promotion,
      product,
      decision,
    });
  }

  if (multibuyApplies && (soldByWeight || requirement.basis === 'weighed')) {
    return finish({
      requirement,
      listUnitCents,
      listTotalCents,
      chargedTotalCents: listTotalCents,
      promotedPacks: 0,
      status: 'requirement_not_met',
      promotion: decision.promotion,
      product,
      decision,
    });
  }

  if (!multibuyApplies) {
    const charged = roundCents(decision.promotedUnitCents * requirement.packs);
    return finish({
      requirement,
      listUnitCents,
      listTotalCents,
      chargedTotalCents: charged,
      promotedPacks: requirement.packs,
      status: 'applied',
      promotion: decision.promotion,
      product,
      decision,
    });
  }

  // Multibuy: whole groups at the offer price, remainder at shelf price.
  const wholePacks = Math.floor(requirement.packs);
  const groups = Math.floor(wholePacks / decision.requiredQuantity);
  if (groups < 1) {
    return finish({
      requirement,
      listUnitCents,
      listTotalCents,
      chargedTotalCents: listTotalCents,
      promotedPacks: 0,
      status: 'requirement_not_met',
      promotion: decision.promotion,
      product,
      decision,
    });
  }

  const promotedPacks = groups * decision.requiredQuantity;
  const remainderPacks = requirement.packs - promotedPacks;
  const chargedTotalCents = roundCents(
    decision.promotedUnitCents * promotedPacks + listUnitCents * remainderPacks,
  );

  return finish({
    requirement,
    listUnitCents,
    listTotalCents,
    chargedTotalCents,
    promotedPacks,
    status: remainderPacks > 0 ? 'partially_applied' : 'applied',
    promotion: decision.promotion,
    product,
    decision,
  });
}

function finish(input: {
  requirement: PackRequirement;
  listUnitCents: number;
  listTotalCents: number;
  chargedTotalCents: number;
  promotedPacks: number;
  status: PromotionStatus;
  promotion: Promotion | undefined;
  product: RetailerProduct;
  decision: PromotionDecision;
}): LinePricing {
  const { requirement, listUnitCents, listTotalCents, chargedTotalCents } = input;
  const unitPrice = unitPriceFor(listUnitCents, input.product.sizeLabel);

  return {
    packs: requirement.packs,
    packBasis: requirement.basis,
    roundedUp: requirement.roundedUp,
    listUnitCents,
    listTotalCents,
    chargedTotalCents,
    promotionSavingsCents: Math.max(0, listTotalCents - chargedTotalCents),
    effectiveUnitCents:
      requirement.packs > 0 ? roundCents(chargedTotalCents / requirement.packs) : chargedTotalCents,
    promotionStatus: input.status,
    promotedPacks: input.promotedPacks,
    ...(input.promotion === undefined ? {} : { promotion: input.promotion }),
    ...(unitPrice === null ? {} : { unitPrice }),
    eligibility: input.decision.eligibility,
    // Only report offers as applied when the line actually charged less for them.
    // A multibuy that failed its threshold is eligible in principle but took nothing
    // off, and listing it as applied would imply money that was never saved.
    appliedPromotions: chargedTotalCents < listTotalCents ? input.decision.appliedPromotions : [],
    hasUnresolvedPromotion: input.decision.hasUnresolved,
  };
}

/** Single rounding point for money. Applied once per total, never mid-chain. */
export function roundCents(value: number): number {
  return Math.round(value);
}

/**
 * A human-readable statement of why a promotion did or did not apply. Used in
 * plan explanations so an unapplied offer is visible rather than silently absent.
 */
export function promotionStatusLabel(pricing: LinePricing): string | undefined {
  const promotion = pricing.promotion;
  if (!promotion) return undefined;
  switch (pricing.promotionStatus) {
    case 'applied':
      return promotion.label;
    case 'partially_applied':
      return `${promotion.label} (applied to ${pricing.promotedPacks} of ${pricing.packs})`;
    case 'requirement_not_met':
      return `${promotion.label} — needs ${promotion.requiredQuantity ?? 2}, not applied`;
    case 'loyalty_missing':
      return `${promotion.label} — requires a loyalty card`;
    case 'coupon_missing':
      return `${promotion.label} — requires a coupon you do not hold`;
    case 'minimum_spend_not_met':
      return `${promotion.label} — needs a larger spend at this store, not applied`;
    case 'minimum_spend_unresolved':
      return `${promotion.label} — minimum spend not confirmed, not applied`;
    case 'not_stackable':
      return `${promotion.label} — cannot be combined with the offer already applied`;
    case 'expired':
      return `${promotion.label} — expired`;
    case 'unmodelled_condition':
      return `${promotion.label} — conditions Juva cannot verify`;
    case 'wrong_retailer':
    case 'not_a_discount':
    case 'none':
      return undefined;
  }
}
