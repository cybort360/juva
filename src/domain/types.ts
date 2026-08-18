import type { SentMessage } from './journeys';

export type CurrencyCode = 'USD' | 'NGN' | 'GBP' | 'EUR';
export type TransportMode = 'drive' | 'walk' | 'transit';
/**
 * How strictly a basket line is bound to what the shopper named.
 *
 * Four states, because "exact" was previously doing two different jobs. A shopper
 * who writes "Kellogg's Corn Flakes" and one who writes "anything Kellogg's" have
 * different requirements, and collapsing them meant Juva either over-substituted
 * for the first or under-substituted for the second.
 *
 * `exact_product`  only the named product or variant.
 * `exact_brand`    any compatible product from the named brand.
 * `flexible`       an equivalent product from another brand is acceptable.
 * `cheapest`       prefer the cheapest acceptable equivalent.
 *
 * Persisted values from before this split are migrated by `migrateBrandPolicy`.
 */
export type BrandPolicy = 'exact_product' | 'exact_brand' | 'flexible' | 'cheapest';

/** Pre-split policy values, still present in persisted state on existing devices. */
export type LegacyBrandPolicy = 'exact' | 'flexible' | 'cheapest';

/**
 * Trade identifiers for a product, all optional.
 *
 * A barcode is the only evidence that two listings are literally the same article,
 * so when both sides have one it outranks every text signal. But most sources do
 * not publish one — Open Prices supplies a product code, a typical community feed
 * does not — so nothing may *require* an identifier. Absence is not evidence.
 */
export interface ProductIdentifiers {
  /** As printed on the pack, any symbology. Normalized to a GTIN where possible. */
  barcode?: string;
  /** UPC-A, 12 digits. */
  upc?: string;
  /** GTIN-8/12/13/14. The canonical form Juva compares on. */
  gtin?: string;
  /** A retailer's own article number. Only comparable within that retailer. */
  retailerSku?: string;
}
/**
 * How much a price can be trusted right now.
 *
 * `demo` is a first-class value, not an absence of one: prices from Juva's
 * controlled market carry it so that no code path can ever render demo data as
 * live retailer data.
 */
export type Freshness = 'live' | 'recent' | 'older' | 'verify' | 'demo';

export interface LocationProfile {
  label: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, needed to disambiguate postcodes between countries. */
  countryCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface UserPreferences {
  location: LocationProfile;
  radiusMiles: number;
  maxStores: number;
  transportMode: TransportMode;
  brandPolicy: BrandPolicy;
  loyaltyRetailers: string[];
  /**
   * Ids of promotions the shopper holds a coupon for. A coupon-gated offer is never
   * assumed: not listed here means not held, and the discount does not apply.
   */
  couponIds: string[];
  timeValueCentsPerMinute: number;
  extraStopPenaltyCents: number;
  /**
   * How much the shopper values convenience over the lowest basket price, 0..1.
   *
   * 0 ignores travel and effort entirely and chases the cheapest basket; 1
   * weights effort twice as heavily as its raw cost. 0.5 is neutral, meaning
   * effort counts at face value. This scales only the effort terms of the score —
   * never a price, a total or a saving.
   */
  conveniencePreference: number;
  /**
   * Planning penalty for an item no store in the plan can supply. Represents the
   * cost of a second trip, not an estimate of the item's price.
   */
  missingItemPenaltyCents: number;
  /**
   * Whether Juva may remind the shopper to verify a finished trip. Local only —
   * Juva has no push server, so nothing else is offered.
   */
  receiptRemindersEnabled: boolean;
  /** How long after finishing a trip the reminder fires. */
  receiptReminderMinutes: number;
  /**
   * How long retained receipt images are kept, in days. Zero means the image is
   * discarded as soon as extraction finishes and never stored.
   */
  receiptImageRetentionDays: number;
  onboarded: boolean;
}

export interface GroceryListItem {
  id: string;
  concept: string;
  displayName: string;
  quantity: number;
  unit: string;
  requestedBrand?: string;
  /**
   * The specific variant asked for, when the shopper named one ("whole", "unsalted",
   * "sourdough"). Only `exact_product` treats it as a hard requirement.
   */
  requestedVariant?: string;
  /** Identifiers the shopper supplied, e.g. by scanning a pack they already own. */
  requestedIdentifiers?: ProductIdentifiers;
  brandPolicy?: BrandPolicy;
  notes?: string;
}

export interface GroceryList {
  id: string;
  title: string;
  prompt: string;
  budgetCents?: number;
  currency: CurrencyCode;
  items: GroceryListItem[];
  createdAt: string;
  recurring?: boolean;
}

export interface Store {
  id: string;
  retailerId: string;
  retailerName: string;
  displayName: string;
  address: string;
  distanceMiles: number;
  etaMinutes: number;
  /**
   * Exact position, when the source knows it. Navigation prefers these over the
   * address: a name or address search can land on a different branch of the same
   * chain, and the whole plan is priced at one specific store.
   */
  latitude?: number;
  longitude?: number;
  /** Per-retailer accent, resolved against the `forest`/`blue`/`amber` palette. */
  colorToken: 'forest' | 'blue' | 'amber';
}

export type PriceSource =
  | 'retailer_api'
  | 'affiliate_feed'
  | 'public_feed'
  | 'community_feed'
  | 'receipt_verified'
  | 'demo';

/**
 * Where a price is valid. Only `store` may feed a local plan, so a national or
 * online price can never be shown as the price at a specific branch.
 */
export type PriceScopeKind = 'store' | 'region' | 'national' | 'online';

/**
 * Stock state. `unknown` is the honest default for sources with no inventory
 * feed; it must never be silently treated as `in_stock`.
 */
export type AvailabilityState = 'in_stock' | 'out_of_stock' | 'unknown';

/**
 * One observed price, with everything needed to judge whether to trust it.
 *
 * Provenance is not optional metadata here: the retailer, the exact store scope,
 * the source kind, when it was seen and how confident we are are all required,
 * because Juva's savings claims are only as defensible as this record.
 */
export interface PriceObservation {
  id: string;
  storeId: string;
  /** Retailer the price belongs to. */
  retailerId: string;
  retailerProductId: string;
  /** Scope the price was observed at. `store` for anything plannable. */
  scope: PriceScopeKind;
  priceCents: number;
  currency: CurrencyCode;
  /** Shelf price before any applied promotion, when the source distinguishes it. */
  regularPriceCents?: number;
  /** Unit price where the source supports it; omitted rather than estimated. */
  unitPriceCents?: number;
  /** Basis for `unitPriceCents`, e.g. "kg", "L", "unit". */
  unitLabel?: string;
  source: PriceSource;
  /**
   * The upstream record behind this price.
   *
   * Optional because the demo market has no upstream to point at. For real data it is
   * always present, which the recorded-payload integration test asserts.
   */
  sourceIdentifier?: string;
  observedAt: string;
  /** Set only when the source states an expiry. */
  expiresAt?: string;
  /** Receipts that independently confirmed this price. Receipt-derived prices only. */
  verificationCount?: number;
  freshness: Freshness;
  confidence: number;
  promotionId?: string;
  /**
   * Further offers on the same product, beyond `promotionId`.
   *
   * Separate from `promotionId` so existing sources and stored state keep working:
   * a single-offer product needs no change. Stacking is only ever considered when
   * more than one offer is present and each permits it.
   */
  additionalPromotionIds?: string[];
  /** Whether Juva may plan on buying this. */
  available: boolean;
  /** What the source actually knows about stock. */
  availability: AvailabilityState;
}

/**
 * A retailer offer, with every condition it carries stated explicitly.
 *
 * Money fields end in `Cents` because every amount in Juva is integer minor units;
 * a bare `couponAmountOff` would invite a float dollar value, and a float that
 * touches a price is a rounding error the shopper pays for.
 */
export interface Promotion {
  id: string;
  retailerId: string;
  label: string;
  /** Packs that must be bought together. Above 1 this is a multibuy. */
  requiredQuantity?: number;
  loyaltyRequired?: boolean;
  expiresAt?: string;
  /** Shelf discount, applied without the shopper doing anything. */
  amountOffCents?: number;
  overridePriceCents?: number;
  /**
   * Minimum spend at this retailer before the offer applies. Evaluated against
   * what the plan actually buys at that store, never against a whole basket split
   * across several.
   */
  minimumBasketSpendCents?: number;
  /** True when the shopper must be holding a coupon for this to apply at all. */
  couponRequired?: boolean;
  /** Coupon discount as a fixed amount. Kept separate from `amountOffCents`. */
  couponAmountOffCents?: number;
  /** Coupon discount as a percentage, 0–100. Applied to the shelf price. */
  couponPercentOff?: number;
  /**
   * Whether this offer may combine with another on the same line. Defaults to
   * false: a source that does not say "stacks" has not granted permission, and
   * assuming it did would understate the bill.
   */
  stackable?: boolean;
  /**
   * True when the source states a condition Juva cannot evaluate. Such a
   * promotion is never applied, because promising an unverifiable discount would
   * understate what the shopper actually pays.
   */
  hasUnmodelledCondition?: boolean;
}

export interface RetailerProduct {
  id: string;
  canonicalConcept: string;
  storeId: string;
  title: string;
  brand: string;
  sizeLabel: string;
  /**
   * True when the price is per unit of weight and the shopper takes an arbitrary
   * amount (loose meat, produce by the pound). Such lines use a fractional
   * multiplier instead of whole packs.
   */
  soldByWeight?: boolean;
  quantityValue?: number;
  quantityUnit?: string;
  /** Trade identifiers, when the source publishes any. */
  identifiers?: ProductIdentifiers;
  observation: PriceObservation;
}

export type MarketDataMode = 'demo' | 'remote';

/** Attribution for a real data source, as its licence requires. */
export interface SourceAttribution {
  name: string;
  url: string;
  licence: string;
  notice?: string;
}

/** Whether a requested basket concept could be priced from real observations. */
export interface ConceptCoverage {
  concept: string;
  storesWithPrice: number;
  observationCount: number;
  priced: boolean;
}

/** Everything the optimizer needs about one local market at one moment. */
export interface MarketSnapshot {
  stores: Store[];
  products: RetailerProduct[];
  promotions: Promotion[];
  mode: MarketDataMode;
  fetchedAt: string;
  /** Per-concept coverage. Empty for the demo market, which covers everything. */
  coverage?: ConceptCoverage[];
  /** Concepts no source could price. Reported, never filled in. */
  unpricedConcepts?: string[];
  /** True when a source failed and the market may be thinner than usual. */
  partial?: boolean;
  sourceFailures?: string[];
  attributions?: SourceAttribution[];
}

/**
 * Observable facts about the snapshot a plan was built from. Screens read this
 * instead of estimating counts, so no displayed figure is invented.
 */
export interface MarketSnapshotMeta {
  mode: MarketDataMode;
  fetchedAt: string;
  storeNames: string[];
  storeCount: number;
  productCount: number;
  promotionCount: number;
  matchedProductCount: number;
  combinationsEvaluated: number;
  /** Concepts no real source could price. Surfaced to the shopper as-is. */
  unpricedConcepts: string[];
  /** True when a source failed, so coverage may be thinner than usual. */
  partial: boolean;
  sourceFailures: string[];
  attributions: SourceAttribution[];
  /** Worst freshness present among the observations actually used. */
  weakestFreshness: Freshness;
}

export interface PlanItem {
  groceryItemId: string;
  /**
   * Trade identifiers for the chosen product, when the source published any.
   *
   * Carried onto the plan so receipt reconciliation can match on a barcode rather than
   * on words. Absent for every source Juva currently connects to, which is why the
   * matching hierarchy still has to work without it — but present the moment one does.
   */
  identifiers?: ProductIdentifiers;
  requestedName: string;
  storeId: string;
  retailerProductId: string;
  productTitle: string;
  productBrand: string;
  sizeLabel: string;
  /** Packs bought, or the weight multiplier for goods sold by weight. */
  quantity: number;
  /** How `quantity` was derived from the requested amount and the pack size. */
  packBasis: 'weighed' | 'pack_multiple' | 'requested_count';
  /** True when whole packs were rounded up past the requested amount. */
  roundedUp: boolean;
  /** Observed shelf price per unit, before any promotion Juva applied. */
  listPriceCents: number;
  /** Price per unit Juva expects to be charged, after eligible promotions. */
  unitPriceCents: number;
  lineTotalCents: number;
  /** Line total at shelf price, before promotions. */
  listTotalCents: number;
  /** Comparison price in the shopper's basis (per kg / per L / per item). */
  comparisonUnitPriceCents?: number;
  /** Basis for `comparisonUnitPriceCents`, e.g. "per kg". */
  comparisonUnitLabel?: string;
  /** Why a promotion did or did not apply, for auditable explanations. */
  promotionStatus: PromotionOutcome;
  /** (listPrice - unitPrice) * quantity. Zero when no promotion applied. */
  promotionSavingsCents: number;
  /**
   * Difference against the requested brand at the same store, times quantity.
   * Zero unless a substitution happened and the requested brand was observed.
   */
  substitutionSavingsCents: number;
  confidence: number;
  freshness: Freshness;
  source: PriceSource;
  /**
   * When the underlying price was observed.
   *
   * Carried onto the plan so the comparison can say "checked 18 minutes ago" instead of
   * leaving the shopper to assume a price is current. A freshness badge alone invites that
   * assumption; a timestamp cannot be misread.
   */
  observedAt: string;
  substitution: boolean;
  promotionLabel?: string;
}

export interface PlanStop {
  store: Store;
  items: PlanItem[];
  subtotalCents: number;
}

/** Why a promotion did or did not reach the shelf price Juva planned on. */
export type PromotionOutcome =
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

/** Why no store in a plan could supply a basket line. */
export type MissingReason =
  | 'not_stocked_nearby'
  | 'unavailable'
  | 'brand_required'
  /** The shopper named a variant no candidate satisfied, under `exact_product`. */
  | 'variant_required'
  /** Both sides published a barcode and they disagreed. */
  | 'barcode_mismatch'
  | 'currency_mismatch';

export interface MissingItem {
  groceryItemId: string;
  requestedName: string;
  reason: MissingReason;
  /** True when another store outside this plan could have supplied it. */
  availableElsewhere: boolean;
}

export type PlanKind =
  | 'recommended'
  | 'cheapest_single_store'
  | 'cheapest_multi_store'
  | 'lowest_effort'
  | 'strict_budget'
  | 'custom';

/**
 * The scored components behind a recommendation, kept separate so the choice is
 * auditable rather than a single opaque number.
 *
 * Only `basketCostCents` is money the shopper pays. Every other term is a
 * planning cost used to rank plans, and none of them ever enters a basket total
 * or a savings figure.
 */
export interface PlanScore {
  basketCostCents: number;
  travelCostCents: number;
  travelTimeCostCents: number;
  extraStopPenaltyCents: number;
  /** Risk penalty for prices that may no longer hold. */
  staleDataPenaltyCents: number;
  /** Penalty for lines this plan cannot supply. */
  missingItemPenaltyCents: number;
  /**
   * Risk penalty for lines Juva is not certain it matched correctly.
   *
   * Distinct from `staleDataPenaltyCents`, which is about *when* a price was seen.
   * This is about *what* was matched: a substituted or loosely matched product may
   * simply not be the thing the shopper wanted, and that risk scales with the
   * money on the line. Never a price — a ranking term only.
   */
  uncertaintyPenaltyCents: number;
  /** Multiplier applied to the effort terms, from `conveniencePreference`. */
  effortWeight: number;
  /** Weighted sum used for ranking. */
  totalCents: number;
}

/**
 * What the savings figure is measured against.
 *
 * The default is always `cheapest_complete_single_store` when one exists, and the
 * others are offered *alongside* it rather than substituted for it. Picking whichever
 * baseline happened to produce the biggest number would make every saving a
 * marketing figure; see `PlanBaseline.isDefault`.
 */
export type BaselineKind =
  | 'cheapest_complete_single_store'
  | 'cheapest_complete_any'
  /** What the shopper's usual store would have charged for the same basket. */
  | 'usual_store'
  /** What this basket cost the last time it was actually bought and verified. */
  | 'previous_recurring_basket'
  /** No complete basket exists anywhere nearby, so no saving can be claimed. */
  | 'none';

/**
 * One baseline a plan can be compared against.
 *
 * Every baseline a plan could have used is kept, not just the one the headline
 * saving quotes, so a shopper can see that the comparison was chosen by rule
 * rather than by whichever number flattered Juva most.
 */
export interface PlanBaseline {
  kind: BaselineKind;
  /** Full-basket cost under this baseline. Zero only for `none`. */
  cents: number;
  /** What this baseline is, in the shopper's words. */
  label: string;
  /** The store it was measured at, when it has one. */
  storeId?: string;
  /** True for the one baseline the plan's savings figure is measured against. */
  isDefault: boolean;
  /** Savings against this baseline. Zero when the plan is not comparable. */
  savingsCents: number;
}

/** What a shopper can do about a basket Juva could not fully price. */
export type CompletenessRemediation =
  'widen_radius' | 'allow_substitutions' | 'retry_providers' | 'remove_unpriced_items';

/**
 * How much of the requested basket this plan actually priced.
 *
 * A partial plan is a legitimate, useful answer — "here is what I could price" —
 * but it is *not* a basket, and it must never be treated as one. So completeness
 * is a first-class object rather than a boolean, carrying both the counts the
 * shopper needs to see and the hard gate on whether this plan may take part in
 * price comparison at all.
 */
export interface PlanCompleteness {
  /** Lines the shopper asked for. */
  requestedItemCount: number;
  /** Lines this plan priced from a real observation at a real store. */
  pricedItemCount: number;
  /** True only when `pricedItemCount === requestedItemCount`. */
  complete: boolean;
  /** Concepts no store in this plan could price. */
  unresolvedConcepts: string[];
  /**
   * Whether this plan may take part in the cheapest-single-store ranking, the
   * Juva Pick comparison and the savings baseline.
   *
   * False for any partial plan. A cheaper basket that is missing three items is
   * not a cheaper basket, and letting it compete would produce a savings number
   * measured against a basket the shopper never asked for.
   */
  comparisonEligible: boolean;
  /** Why the plan cannot be compared. Present only when `comparisonEligible` is false. */
  ineligibleReason?: string;
  /** Ordered by how likely each is to actually help. */
  remediations: CompletenessRemediation[];
}

/** One named, countable reason Juva is more or less sure about a plan. */
export interface PlanConfidenceFactor {
  kind:
    | 'exact_matches'
    | 'substitutions'
    | 'fresh_prices'
    | 'stale_prices'
    | 'unpriced_items'
    | 'unknown_availability'
    | 'unverifiable_promotions';
  /** Lines this factor covers. */
  count: number;
  /** Signed contribution to `PlanConfidence.score`, in permille, so the sum is checkable. */
  deltaPermille: number;
  /** What to show the shopper, e.g. "11 of 12 matched exactly". */
  detail: string;
}

/**
 * Juva Plan Confidence: one number, and the arithmetic that produced it.
 *
 * `score` is not a judgement — it is `basePermille` plus every factor's
 * `deltaPermille`, clamped. Which means a shopper asking "why 74%?" gets a list of
 * counted reasons rather than a shrug, and a confidence figure can never drift
 * away from the facts it claims to summarise.
 */
export interface PlanConfidence {
  /** 0–1. What the UI shows. */
  score: number;
  /** Starting point before factors, in permille. */
  basePermille: number;
  factors: PlanConfidenceFactor[];
}

/** A product Juva considered for a line and did not choose, and why. */
export interface RejectedCandidate {
  groceryItemId: string;
  storeId: string;
  retailerProductId: string;
  productTitle: string;
  /** Line total this candidate would have cost, for comparison with the chosen one. */
  lineTotalCents: number;
  reason:
    | 'dearer'
    | 'brand_policy'
    | 'weaker_freshness'
    | 'lower_confidence'
    | 'wrong_currency'
    | 'unavailable';
}

/** The distance and time assumptions a plan's travel cost was computed from. */
export interface RouteInputs {
  transportMode: UserPreferences['transportMode'];
  /** Cents per mile assumed for vehicle running cost. */
  driveCostCentsPerMile: number;
  minutesPerMile: number;
  tripOverheadMinutes: number;
  perExtraStopMinutes: number;
  perExtraStopMiles: number;
  /** Store-to-store order the estimate assumed, nearest first. */
  stopOrder: string[];
}

/** A promotion this plan actually applied, and what it was worth. */
export interface AppliedPromotion {
  promotionId: string;
  label: string;
  groceryItemId: string;
  storeId: string;
  /** Money taken off this line by the promotion. */
  savingsCents: number;
}

export interface PlanExplanation {
  basketCostCents: number;
  storeCount: number;
  travelMiles: number;
  etaMinutes: number;
  baselineCents: number;
  baselineKind: BaselineKind;
  estimatedSavingsCents: number;
  /** One sentence on why this plan is what it is. */
  rationale: string;
  /** Auditable score components behind the ranking. */
  score: PlanScore;
  /** Every store this plan sends the shopper to, in visiting order. */
  storesSelected: string[];
  /** Products chosen, by basket line, so a choice can be traced to a line. */
  productsChosen: { groceryItemId: string; storeId: string; retailerProductId: string }[];
  /** What Juva looked at and passed over. The interesting half of any decision. */
  rejectedCandidates: RejectedCandidate[];
  /** Promotions actually applied, never ones that merely existed. */
  promotionsApplied: AppliedPromotion[];
  /** Distance and time assumptions behind the travel figures. */
  routeInputs: RouteInputs;
  /** The counted reasons behind the confidence figure. */
  confidence: PlanConfidence;
  /** How much of the basket this plan priced, and whether it may be compared. */
  completeness: PlanCompleteness;
  /** Every baseline considered, with the default flagged. */
  baselines: PlanBaseline[];
  /**
   * The tradeoff this plan makes against the cheapest complete basket, stated in
   * money and minutes rather than implied by ordering.
   */
  tradeoffs: PlanTradeoff[];
}

/** One explicit "this costs more but saves that" statement. */
export interface PlanTradeoff {
  kind: 'cheaper_but_further' | 'dearer_but_closer' | 'fewer_stops' | 'more_stops' | 'equivalent';
  /** Signed: positive means this plan's basket costs more than the reference. */
  deltaBasketCents: number;
  /** Signed: positive means this plan takes longer. */
  deltaMinutes: number;
  /** Signed: positive means this plan visits more stores. */
  deltaStops: number;
  /** Plain-language statement of the trade, e.g. "$2.40 cheaper for 9 more minutes". */
  detail: string;
}

export interface OptimizedPlan {
  id: string;
  kind: PlanKind;
  label: string;
  stops: PlanStop[];
  basketCostCents: number;
  travelCostCents: number;
  /** Weighted ranking score. Not a price. */
  effectiveCostCents: number;
  travelMiles: number;
  etaMinutes: number;
  confidence: number;
  comparedBaselineCents: number;
  savingsVsBaselineCents: number;
  /** Lines no store in this plan can supply. Empty for a complete plan. */
  missingItems: MissingItem[];
  /**
   * True when every requested line is priced.
   *
   * Kept alongside `completeness` because a great deal of existing code reads it;
   * it is exactly `completeness.complete`.
   */
  complete: boolean;
  /** How much of the basket was priced, and whether this plan may be compared. */
  completeness: PlanCompleteness;
  /** The counted factors behind `confidence`. */
  confidenceDetail: PlanConfidence;
  /** Every baseline considered for this plan, with the default flagged. */
  baselines: PlanBaseline[];
  /**
   * The priced subtotal, which for a partial plan is *not* a basket total.
   *
   * Identical to `basketCostCents` for a complete plan. Named separately so a
   * partial plan's figure cannot be rendered as though it were the whole basket.
   */
  pricedSubtotalCents: number;
  /** Weakest freshness among the observations this plan relies on. */
  weakestFreshness: Freshness;
  explanation: PlanExplanation;
}

/**
 * What happened to one line while the shopper was in the store.
 *
 * `pending` and `collected` are the ordinary path. The rest are all reports of the
 * shelf disagreeing with the plan, and each one can trigger a replan.
 */
/**
 * Where a figure attached to a purchase came from.
 *
 * The distinction drives what Juva may claim: only `receipt_verified` money can enter a
 * verified saving, and only `provider_observed` money may carry a retailer promotion
 * Juva applied itself.
 */
export type PriceEvidenceSource = 'provider_observed' | 'user_reported' | 'receipt_verified';

/**
 * What is known about one line by the time the shopper reviews their receipt.
 *
 * Rendered distinctly so a hand-typed substitute never looks like a provider-backed
 * product until reconciliation actually confirms it.
 */
export type VerificationState =
  /** Untouched since planning. */
  | 'planned'
  /** The shopper corrected it in the aisle; no receipt has confirmed it yet. */
  | 'reported_in_store'
  /** A receipt line explained it. */
  | 'receipt_verified'
  /** Ambiguous, unmatched, or evidence that disagrees with itself. */
  | 'needs_review';

export type TripItemStatus =
  | 'pending'
  | 'collected'
  | 'skipped'
  /** Not on the shelf. The strongest trigger: the line cannot be filled here at all. */
  | 'unavailable'
  | 'different_price'
  /** A different pack size was taken, so quantity maths and unit price both change. */
  | 'different_package'
  /** A different product was taken, subject to the line's brand policy. */
  | 'substituted'
  /** The shopper took more or fewer packs than planned. */
  | 'quantity_changed';

export interface TripItem extends PlanItem {
  status: TripItemStatus;
  /** Shelf price the shopper reported, per unit. Overrides the planned price. */
  actualPriceCents?: number;
  /** Packs actually taken, when it differed from the plan. */
  actualQuantity?: number;
  /** Pack label actually taken, when a different package was picked up. */
  actualSizeLabel?: string;
  /** Retailer product actually taken, when a substitute was accepted. */
  substituteProductId?: string;
  substituteTitle?: string;
  /** Store this line moved to after a replan, when the replan moved it. */
  movedToStoreId?: string;
  /**
   * True when the shopper typed a substitute Juva has no observation for.
   *
   * Such a line is priced from what the shopper said and is explicitly not a Juva price.
   * It stays unverified until receipt reconciliation confirms what was actually charged.
   */
  substituteUnverified?: boolean;
  /**
   * Where this line's current price came from.
   *
   * `provider_observed` is a price Juva saw in the market data. `user_reported` is one
   * the shopper told it — a shelf correction or a hand-typed substitute — which is
   * evidence, not an observation, and carries no retailer promotion of its own.
   * `receipt_verified` is set only once a receipt line confirmed what was charged.
   */
  sourceType?: PriceEvidenceSource;
  /** False until a receipt line confirms this figure. */
  verified?: boolean;
  /**
   * False when the actual pack could not be normalized against the requested unit.
   *
   * A "500 g" plan against a shelf marked "family size" has no honest conversion, so
   * Juva records the pack the shopper took and declines to claim the quantities are
   * equivalent, rather than inventing a ratio.
   */
  unitsNormalized?: boolean;
}

/**
 * The plan the trip started from, frozen.
 *
 * Nothing in Shop Mode may write to this. It is the record the verified saving is
 * measured against, and the whole point of adaptive shopping is that the route can
 * change *without* the baseline moving underneath it — otherwise Juva could improve
 * its own savings figure by replanning, which is not a saving, it is a moving goalpost.
 */
export interface TripOrigin {
  planId: string;
  planKind: PlanKind;
  basketCostCents: number;
  comparedBaselineCents: number;
  baselineKind: BaselineKind;
  savingsVsBaselineCents: number;
  storeIds: string[];
  capturedAt: string;
  /**
   * Whether the originating plan was eligible for comparison at all. A trip that
   * started from a partial plan can never acquire a savings claim by replanning.
   */
  comparisonEligible: boolean;
  /**
   * Deterministic hash of the economically relevant fields above, stamped once when the
   * trip starts.
   *
   * Freezing protects the object in memory, but persistence thaws it: `JSON.parse`
   * returns a plain mutable object, so after a reload this hash is the only thing that
   * can still tell whether the baseline moved. Recomputing it would defeat the purpose —
   * it is compared against the fields, never regenerated from them.
   */
  fingerprint: string;
}

/**
 * Everything a replan needs, cached on the trip itself.
 *
 * Juva's market snapshot normally lives in memory only, which means a shopper who
 * loses signal in the store — or whose app is killed and relaunched at the checkout —
 * could not have their trip replanned. Caching it here is what makes the adaptive loop
 * work offline: the deterministic optimizer needs no network, only this.
 */
export interface TripMarketCache {
  /** Kept so demo data can never be re-presented as real mid-trip. */
  mode: MarketDataMode;
  capturedAt: string;
  stores: Store[];
  products: RetailerProduct[];
  promotions: Promotion[];
  /** The basket as planned, so a replan honours the same brand and quantity rules. */
  list: GroceryList;
}

/** One adaptive decision, recorded whether or not the shopper took Juva's advice. */
export interface TripAdaptation {
  id: string;
  at: string;
  groceryItemId: string;
  requestedName: string;
  /** What the shopper reported. Mirrors `ShopEventKind` in `shopAdapt`. */
  event:
    'different_price' | 'unavailable' | 'quantity_changed' | 'different_package' | 'substitute';
  /** Where the line stood before this change. */
  before: { storeId: string; retailerProductId: string; lineTotalCents: number };
  /** Every option Juva evaluated, with its arithmetic. */
  options: AdaptOption[];
  recommendedOptionId: string;
  /** What the shopper actually chose. */
  chosenOptionId: string;
  /** True when the shopper went against the recommendation. Never discouraged. */
  overrodeRecommendation: boolean;
  /** Where the line ended up. Null when it left the basket. */
  after: { storeId: string; retailerProductId: string; lineTotalCents: number } | null;
  /** Trip basket total after applying the decision. */
  tripBasketCentsAfter: number;
  /**
   * Whether the decision was made entirely from `trip.market`.
   *
   * This replaced an `offline` flag that claimed more than Juva can know. Juva has no
   * connectivity detection, so "the device was offline" was never a fact it could
   * record — what it can state is that the replanner read the cached market and asked
   * nothing of the network, which is what these two fields say.
   */
  usedCachedMarket: boolean;
  /** Whether completing this decision needed a network call. Always false today. */
  networkRequired: boolean;
}

/** A promotion whose status changed because of an adaptive decision. */
export interface PromotionImpact {
  storeId: string;
  groceryItemId: string;
  promotionLabel: string;
  before: PromotionOutcome;
  after: PromotionOutcome;
  /** Positive when the change gains the shopper money. */
  savingsDeltaCents: number;
}

/**
 * One way the rest of the trip could go, with the arithmetic behind it.
 *
 * `netDeltaCents` is what ranks them: the basket difference plus the weighted cost of
 * any extra travel, using the optimizer's own effort model. Lower is better.
 */
export interface AdaptOption {
  id: string;
  kind:
    | 'buy_here'
    | 'buy_at_existing_stop'
    | 'change_substitute'
    | 'add_stop'
    | 'remove_stop'
    | 'drop_item';
  label: string;
  /** Null only when the line leaves the basket. */
  storeId: string | null;
  retailerProductId: string | null;
  productTitle: string;
  lineTotalCents: number;
  /** Change to what the shopper pays, including promotion knock-ons at both stores. */
  basketDeltaCents: number;
  extraMiles: number;
  extraMinutes: number;
  extraStops: number;
  /** Weighted planning cost of that effort. A ranking figure, never money. */
  effortDeltaCents: number;
  netDeltaCents: number;
  /**
   * Whether this option competes on cost at all.
   *
   * False for "do without": a basket missing a line is arithmetically cheaper and must
   * never win on that arithmetic. It is excluded from ranking entirely rather than
   * pushed to the end with a sentinel score — a sentinel that reaches a subtraction
   * produces a nonsense number, and one that reaches a savings figure produces a
   * plausible one, which is worse.
   */
  rankable: boolean;
  promotionImpacts: PromotionImpact[];
  /** True when this option is a different brand to the one requested. */
  substitution: boolean;
  /** True when the shopper supplied this option by hand rather than Juva observing it. */
  manualEntry?: boolean;
  /** False when the pack could not be normalized against the requested unit. */
  unitsNormalized?: boolean;
  feasible: boolean;
  infeasibleReason?: string;
}

export interface ShoppingTrip {
  id: string;
  planId: string;
  listTitle: string;
  startedAt: string;
  completedAt?: string;
  currentStopIndex: number;
  stops: {
    store: Store;
    items: TripItem[];
    expectedSubtotalCents: number;
  }[];
  /** The frozen original. Read-only for the whole life of the trip. */
  origin: TripOrigin;
  /** The cached market, so replanning works with no network. */
  market: TripMarketCache;
  /** Audit log of every adaptation, in order. */
  adaptations: TripAdaptation[];
}

/**
 * What a printed line on a receipt actually is.
 *
 * Receipts mix items with things that are not items — coupons, bag fees, tax,
 * subtotals. Classifying them is the difference between a coupon reducing the
 * basket and a coupon looking like a negatively-priced product.
 */
export type ReceiptLineKind = 'item' | 'discount' | 'fee' | 'tax' | 'subtotal' | 'ignored';

export interface ReceiptLine {
  id: string;
  rawText: string;
  productName: string;
  /** Always the amount charged for this line, in integer cents. */
  chargedPriceCents: number;
  quantity: number;
  barcode?: string;
  /** Printed per-unit price, when the receipt showed one. */
  unitPriceCents?: number | undefined;
  /** A discount printed against this line, as a positive magnitude. */
  discountCents?: number | undefined;
  kind: ReceiptLineKind;
  /** The shopper blacked this line out before anything left the device. */
  redacted?: boolean | undefined;
}

export interface Receipt {
  id: string;
  capturedAt: string;
  merchant?: string;
  storeId?: string;
  /**
   * Retained page images, in reading order. A long receipt is several images.
   * Empty once the shopper deletes them, or when they typed the total instead —
   * so this is never assumed to be non-empty.
   */
  imageUris: string[];
  currency: CurrencyCode;
  lines: ReceiptLine[];
  /** Printed receipt total, when the shopper entered it or the scan read one. */
  totalCents?: number | undefined;
  /** Basket-level discounts, as a positive magnitude. */
  receiptDiscountCents?: number | undefined;
  /** How the figures got here. A manual total is not a read receipt. */
  source: 'scan' | 'manual';
  /** Extraction confidence, 0..1. Absent for manual entry, which is not a guess. */
  confidence?: number | undefined;
  /** Set when the images were deleted but the figures were kept. */
  imagesDeletedAt?: string | undefined;
}

export interface VerificationLine {
  tripItemId: string;
  productName: string;
  expectedCents: number;
  actualCents: number;
  differenceCents: number;
}

/**
 * How a planned item ended up being reconciled against the receipt.
 *
 * `ambiguous` is not a failure — it is the engine declining to guess between
 * candidates and handing the decision to the shopper.
 */
export type ReconcileStatus =
  'matched' | 'price_changed' | 'substituted' | 'missing' | 'ambiguous' | 'assumed_planned';

/**
 * How much weight the match itself carries, independent of the money.
 *
 * `exact` is a barcode or an unambiguous description match; `none` means nothing
 * on the receipt corresponded and the figure came from elsewhere.
 */
export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface ReconciledItem {
  tripItemId: string;
  productName: string;
  expectedCents: number;
  /** Undefined when nothing on the receipt explained this item. */
  actualCents?: number | undefined;
  differenceCents: number;
  status: ReconcileStatus;
  confidence: MatchConfidence;
  /** The receipt line that explained it, once resolved. */
  receiptLineId?: string | undefined;
  /** Candidates when the engine refused to choose. */
  candidateLineIds: string[];
  needsConfirmation: boolean;
  /**
   * True when the shopper picked this match themselves rather than the engine scoring it.
   *
   * A decision the shopper made is stronger evidence than any description score, and it
   * is the only thing besides an exact identifier match that may promote a hand-typed
   * substitute to verified.
   */
  userConfirmed?: boolean;
  /** Plain-language reason, shown to the shopper rather than a status code. */
  reason: string;
}

export interface UnmatchedReceiptLine {
  receiptLineId: string;
  storeId: string;
  productName: string;
  chargedPriceCents: number;
  kind: ReceiptLineKind;
}

/** Where a reconciliation's numbers came from, per stop. */
export interface ReconcileProvenance {
  storeId: string;
  retailerName: string;
  source: 'scan' | 'manual' | 'missing';
  /** True when a printed total governed the stop rather than summed lines. */
  usedPrintedTotal: boolean;
  lineCount: number;
  confidence?: number | undefined;
}

export interface ReconciliationResult {
  items: ReconciledItem[];
  unmatchedLines: UnmatchedReceiptLine[];
  /** Basket-level discounts across all stops, positive. */
  receiptDiscountCents: number;
  expectedTotalCents: number;
  actualTotalCents: number;
  /** actual − expected. Positive means the shopper paid more than planned. */
  differenceCents: number;
  /** Residual not attributable to any planned item: tax, fees, unplanned items. */
  unattributedCents: number;
  missingItemCount: number;
  /** True while any item still needs a decision from the shopper. */
  needsConfirmation: boolean;
  /** 0..1, the weakest link across stops and matches. Never a money figure. */
  confidence: number;
  provenance: ReconcileProvenance[];
}

/**
 * A correction discovered after leaving the store.
 *
 * Shop Mode deliberately only accepts changes for the stop the shopper is standing in,
 * so anything noticed at the checkout or on the way home has nowhere to go in the
 * adaptation log — and that log is append-only history of what was decided *in* the
 * shop. Rewriting it to fit a later discovery would destroy the record of what Juva
 * actually recommended at the time. These live alongside it instead.
 */
export interface ReconciliationCorrection {
  id: string;
  at: string;
  tripItemId: string;
  kind:
    | 'price_differed'
    | 'quantity_differed'
    | 'package_differed'
    | 'unreported_substitute'
    | 'never_purchased';
  /** The figure the trip carried before this correction. */
  beforeCents: number;
  /** What the shopper says was actually true. Absent for `never_purchased`. */
  actualCents?: number;
  actualQuantity?: number;
  actualSizeLabel?: string;
  substituteTitle?: string;
  /** Free text the shopper supplied, for the audit trail. */
  note?: string;
}

/**
 * Whether a trip's economic origin can still be trusted.
 *
 * Checked immediately before any verified saving is computed. A failure stops the
 * calculation dead rather than producing a figure measured against a baseline that has
 * moved — the evidence is preserved so the corruption can be investigated.
 */
export interface TripIntegrity {
  ok: boolean;
  expectedFingerprint: string;
  actualFingerprint: string;
  checkedAt: string;
  /** Present on failure: what the origin currently claims, for debugging. */
  evidence?: TripOrigin;
}

/**
 * The permanent economic record of one trip.
 *
 * Five figures are kept separately and none overwrites another, because each answers a
 * different question and collapsing them would destroy the chain: what a comparable
 * basket would have cost, what Juva planned, what the plan became after the shelves
 * disagreed, what was actually charged, and what of that is provable.
 */
export interface SavingsLedger {
  tripId: string;
  listTitle: string;
  currency: CurrencyCode;
  createdAt: string;
  integrity: TripIntegrity;

  /** 1. What a comparable basket would have cost. Frozen at planning time. */
  baselineCents: number;
  baselineKind: BaselineKind;
  baselineLabel: string;

  /** 2. What Juva originally planned. Frozen at planning time. */
  originalPlannedCents: number;

  /** 3. What the plan became after in-store adaptations. */
  finalExpectedCents: number;

  /** 4. What the receipts actually say was charged. */
  actualCents: number;

  /** actual − final expected. Positive means dearer than the adapted plan. */
  differenceCents: number;

  /**
   * 5. The verified saving.
   *
   * Present **only** when `claimability.state` is `verified`. Absent — not zero — in
   * every other case, so no screen can render a refusal as a $0.00 result.
   */
  verifiedSavingsCents?: number | undefined;
  /** The pre-trip estimate, kept beside the verified figure and never added to it. */
  estimatedSavingsCents: number;

  storeSelectionSavingsCents: number;
  promotionSavingsCents: number;
  substitutionSavingsCents: number;

  /** Why a verified saving is or is not claimable, in the shopper's words. */
  claimability: SavingsClaimability;
  lines: LedgerLine[];
  /** Corrections made after leaving the store. */
  corrections: ReconciliationCorrection[];
  unattributedCents: number;
  confidence: number;
}

/**
 * What Juva is able to say about a trip's saving.
 *
 * The distinction that matters is between `verified` with a figure of zero — "we
 * checked, and you saved nothing" — and every other state, which means "we cannot tell
 * you". Collapsing those into a `0` was mathematically safe and semantically false: a
 * shopper reading $0.00 has no way to know whether Juva verified their trip or refused
 * to.
 */
export type SavingsClaimState =
  /** Every link held. `verifiedSavingsCents` is present and is a real answer. */
  | 'verified'
  /** Evidence is still outstanding — a receipt, or a match the shopper must settle. */
  | 'pending'
  /** The basket is not comparable, so no saving can be computed from it. */
  | 'blocked'
  /** The trip's economic origin failed its fingerprint check. Nothing may be computed. */
  | 'integrity_failed';

/** Whether a verified saving may be claimed, and if not, why not. */
export interface SavingsClaimability {
  state: SavingsClaimState;
  claimable: boolean;
  /** Every reason it is not, so the screen can list them rather than say "no". */
  blockers: SavingsBlocker[];
}

export type SavingsBlocker =
  | 'origin_integrity_failed'
  | 'baseline_not_comparable'
  | 'items_dropped'
  | 'receipt_missing'
  | 'matches_unconfirmed'
  | 'unverified_substitute';

/** One line of the ledger, carrying its evidence through the whole chain. */
export interface LedgerLine {
  tripItemId: string;
  productName: string;
  /** What the original plan said. */
  plannedCents: number;
  /** What the trip expected after any in-store correction. */
  expectedCents: number;
  /** What the receipt says, once matched. */
  actualCents?: number | undefined;
  differenceCents: number;
  state: VerificationState;
  sourceType: PriceEvidenceSource;
  /** True when this line is a substitute the shopper typed rather than Juva observed. */
  manualSubstitute: boolean;
  reason: string;
}

/**
 * Current shape of a persisted ledger. Bump on any breaking change.
 *
 * Old snapshots are never reinterpreted under new rules: a record written by an older
 * version is kept and shown as-is where possible, and quarantined rather than migrated
 * when its shape no longer fits. Silently re-reading yesterday's evidence with today's
 * assumptions is how a proof stops being a proof.
 */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * A ledger frozen at the moment a trip was verified.
 *
 * Snapshot rather than reconstruction: rebuilding a historical ledger would need the
 * trip, its plan, its market cache and every receipt kept forever, and any drift in the
 * reconciliation engine would silently change what a past trip "proved". A stored
 * snapshot cannot drift, which is the entire point of an economic record.
 *
 * Receipt *images* are deliberately not part of this. The ledger keeps the figures and
 * the reasoning; images stay under the shopper's retention setting and their deletion
 * must never invalidate a proof.
 */
export interface PersistedLedger {
  schemaVersion: number;
  /** The ledger exactly as it was computed. Never recomputed on read. */
  ledger: SavingsLedger;
  /** Stores visited, kept denormalized so history renders without the trip. */
  storeNames: string[];
  savedAt: string;
}

export interface SavingsRecord {
  id: string;
  tripId: string;
  createdAt: string;
  currency: CurrencyCode;
  /** What the plan said the basket would cost. */
  plannedCents: number;
  /** Synonym kept explicit because the screens speak in these words. */
  expectedTotalCents: number;
  actualCents: number;
  /** actual − expected. Positive means dearer than planned. */
  differenceCents: number;
  baselineCents: number;
  /** The pre-trip estimate. Retained so it can be shown beside the verified one. */
  estimatedSavingsCents: number;
  verifiedSavingsCents: number;
  storeSelectionSavingsCents: number;
  promotionSavingsCents: number;
  substitutionSavingsCents: number;
  /**
   * Only a trip whose receipts were actually read and confirmed counts toward the
   * shopper's verified total. An unconfirmed record is kept, and excluded.
   */
  receiptConfirmed: boolean;
  /** 0..1 reconciliation confidence. Not a probability of the money being right. */
  confidence: number;
  provenance: ReconcileProvenance[];
  unmatchedLineCount: number;
  missingItemCount: number;
  lines: VerificationLine[];
}

export interface ExtractedReceiptLine {
  rawText: string;
  productName: string;
  chargedPriceCents: number;
  quantity: number;
  barcode?: string;
  unitPriceCents?: number | undefined;
  discountCents?: number | undefined;
  kind: ReceiptLineKind;
}

/**
 * What the model is allowed to return: a transcription, and nothing more.
 *
 * There is deliberately no savings, verdict or recommendation field anywhere in
 * this shape. The model cannot express an opinion about money because there is
 * nowhere for one to go.
 */
export interface ReceiptExtraction {
  merchant?: string;
  currency: CurrencyCode;
  totalCents?: number;
  receiptDiscountCents?: number | undefined;
  lines: ExtractedReceiptLine[];
  confidence: number;
}

/**
 * The clearable fields below are declared `?: T | undefined` rather than `?: T`
 * because reducers reset them by spreading `undefined` over the previous value.
 * Under `exactOptionalPropertyTypes` that is only sound if the type says so.
 */
export interface JuvaState {
  preferences: UserPreferences;
  draftPrompt: string;
  activeList?: GroceryList | undefined;
  plans: OptimizedPlan[];
  selectedPlanId?: string | undefined;
  activeTrip?: ShoppingTrip | undefined;
  receipts: Receipt[];
  savingsRecords: SavingsRecord[];
  savedLists: GroceryList[];
  /** Provenance of the snapshot behind `plans`. Absent until a search runs. */
  lastSnapshot?: MarketSnapshotMeta | undefined;
  /**
   * Lifecycle messages already sent.
   *
   * Persisted because the caps are meaningless otherwise: a weekly limit that resets on
   * every launch is not a limit, and "one message per subject, ever" needs to outlive the
   * process. Pruned on write so it cannot grow without bound.
   */
  journeyHistory: SentMessage[];
  /**
   * Corrections discovered after leaving a store.
   *
   * Kept beside the trip rather than inside it: `activeTrip.adaptations` is the
   * append-only record of what was decided in the shop, and a later discovery must not
   * rewrite that history.
   */
  corrections?: ReconciliationCorrection[];
  /**
   * Frozen ledgers for completed trips, newest last.
   *
   * The permanent economic record. Written once when a trip is verified and never
   * recomputed, so reopening a months-old trip shows exactly the figures it showed then.
   */
  ledgers?: PersistedLedger[];
  /**
   * The last recommendation Juva made for each saved basket.
   *
   * Journey D compares a fresh optimization against this. Deliberately compact — store
   * ids, a cost, a confidence — because a notification trigger is no reason to keep a
   * shopper's product list around a second time.
   */
  recommendationSnapshots?: RecommendationSnapshot[];
}

/** A compact record of what Juva last recommended for one saved basket. */
export interface RecommendationSnapshot {
  basketId: string;
  planKind: PlanKind;
  primaryStoreIds: string[];
  storeCount: number;
  estimatedCostCents: number;
  travelMinutes: number;
  confidence: number;
  marketCompleteness: 'complete' | 'partial';
  observedAt: string;
  /** Bumped when the optimizer's scoring changes, so snapshots are never compared across it. */
  optimizerVersion: number;
}

/** Current optimizer scoring generation. Snapshots from another generation are not compared. */
export const OPTIMIZER_VERSION = 1;
