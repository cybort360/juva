import { brandRankPenaltyCents, effectiveBrandPolicy, matchProduct } from './matching';
import {
  EXTRA_STOP_MILES,
  EXTRA_STOP_MINUTES,
  effortCostCents,
  minutesPerMileFor,
} from './optimizer';
import { priceLine, roundCents, type LinePricing } from './pricing';
import { normalizeLabel } from './quantity';
import { carryOrigin, originIntact } from './tripOrigin';
import type {
  AdaptOption,
  GroceryListItem,
  Promotion,
  PromotionImpact,
  RetailerProduct,
  ShoppingTrip,
  Store,
  TripAdaptation,
  TripItem,
  TripItemStatus,
  UserPreferences,
} from './types';

/**
 * The adaptive half of Shop Mode.
 *
 * A plan stops being true the moment the shopper reaches the shelf. This module takes
 * one report from inside the store — a different price, an empty shelf, a different
 * pack — and works out what it means for the *rest of the trip*, deterministically and
 * with no network.
 *
 * Three rules shape everything here.
 *
 * **The original plan is never touched.** `trip.origin` is frozen at the start and the
 * verified saving is measured against it. If replanning could move the baseline, Juva
 * could manufacture savings by replanning, and the number would mean nothing.
 *
 * **Effort is priced by the main optimizer's model.** `effortCostCents` is imported, not
 * reimplemented, so a mid-trip detour is judged on exactly the terms that produced the
 * plan. A cheaper module here would be how a 30c saving justifies a 6-mile drive.
 *
 * **Every promotion is re-evaluated, never carried over.** Moving a line off a store
 * lowers that store's spend, which can fail a minimum-spend offer on the lines that
 * stay. So both the losing and the gaining store are re-priced in full, through
 * `priceLine`, with the store's own post-change spend supplied.
 */

/**
 * How much better a change must be before Juva recommends it, in cents.
 *
 * The effort model already stops a small saving from buying a long detour. This is a
 * second, blunter guard against *churn*: a 10c advantage is inside the noise of a shelf
 * price and is not worth rerouting a shopper who is already standing in an aisle. Below
 * this margin the honest answer is "carry on".
 */
export const ADAPT_SWITCH_MARGIN_CENTS = 50;

/** How many substitute or alternate-store options to offer per decision. */
const MAX_OPTIONS_PER_KIND = 2;

/** Every kind of correction a shopper can report from the aisle. */
export type ShopEventKind =
  | 'different_price'
  | 'unavailable'
  | 'quantity_changed'
  | 'different_package'
  /** Asking for alternatives without claiming the shelf is empty. */
  | 'substitute';

/** What the shopper reported at the shelf. */
export interface ShopEvent {
  kind: ShopEventKind;
  groceryItemId: string;
  /** Observed shelf price per unit. Required for a price or package change. */
  observedPriceCents?: number;
  /** Packs the shopper is actually taking. Required for a quantity change. */
  observedQuantity?: number;
  /** Pack label actually on the shelf. Required for a package change. */
  observedSizeLabel?: string;
  /**
   * A substitute the shopper typed in because Juva had nothing to offer.
   *
   * Priced from what they said and marked unverified: it is the shopper's figure, not
   * an observation Juva made, and the distinction survives into reconciliation.
   */
  manualSubstitute?: { title: string; priceCents: number };
}

export interface AdaptDecision {
  event: ShopEvent;
  /** Every option evaluated, feasible or not, best first. */
  options: AdaptOption[];
  recommended: AdaptOption;
  /** True when the recommendation is to carry on as planned. */
  unchanged: boolean;
  /** Short heading, e.g. "PRICE CHANGED". */
  headline: string;
  /** The arithmetic in words, built from the same figures as the options. */
  detail: string;
  /** The one-line recommendation, e.g. "Buy here." */
  recommendation: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Market access over the cached snapshot
// ─────────────────────────────────────────────────────────────────────────────

function listItemFor(trip: ShoppingTrip, groceryItemId: string): GroceryListItem | undefined {
  return trip.market.list.items.find((entry) => entry.id === groceryItemId);
}

function storeFor(trip: ShoppingTrip, storeId: string): Store | undefined {
  return (
    trip.stops.find((stop) => stop.store.id === storeId)?.store ??
    trip.market.stores.find((store) => store.id === storeId)
  );
}

/**
 * Applies the shopper's report to the cached market.
 *
 * The report becomes a real observation rather than a special case: the price the
 * shopper read off the shelf is the freshest, most trustworthy figure Juva will ever
 * have for that product, so it is written in as `live` from a `receipt_verified`
 * source. Everything downstream then treats it like any other observation, including
 * the promotion and freshness machinery.
 */
function observedMarket(
  trip: ShoppingTrip,
  event: ShopEvent,
  atStoreId: string,
  now: Date,
): RetailerProduct[] {
  const item = trip.stops
    .flatMap((stop) => stop.items)
    .find((entry) => entry.groceryItemId === event.groceryItemId);
  if (!item) return trip.market.products;

  return trip.market.products.map((product) => {
    const isTheOne =
      product.storeId === atStoreId &&
      product.observation.retailerProductId === item.retailerProductId;
    if (!isTheOne) return product;

    if (event.kind === 'unavailable') {
      return {
        ...product,
        observation: {
          ...product.observation,
          available: false,
          availability: 'out_of_stock' as const,
          observedAt: now.toISOString(),
        },
      };
    }

    if (event.observedPriceCents === undefined) return product;
    return {
      ...product,
      ...(event.observedSizeLabel === undefined ? {} : { sizeLabel: event.observedSizeLabel }),
      observation: {
        ...product.observation,
        priceCents: event.observedPriceCents,
        observedAt: now.toISOString(),
        // Seen with the shopper's own eyes, seconds ago. Nothing is fresher.
        freshness: 'live' as const,
        source: 'receipt_verified' as const,
        confidence: 1,
      },
    };
  });
}

/** The basket line as the replan should treat it, honouring a quantity change. */
function effectiveListItem(item: GroceryListItem, event: ShopEvent): GroceryListItem {
  if (event.kind !== 'quantity_changed' || event.observedQuantity === undefined) return item;
  return { ...item, quantity: Math.max(0, event.observedQuantity) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store re-pricing, with promotions re-evaluated from scratch
// ─────────────────────────────────────────────────────────────────────────────

interface StoreLine {
  readonly tripItem: TripItem;
  readonly listItem: GroceryListItem;
  readonly product: RetailerProduct;
}

/**
 * Prices every line at one store, resolving minimum-spend offers against the store's
 * own subtotal.
 *
 * Two passes, mirroring the optimizer: the first prices with spend unknown, which
 * leaves any minimum-spend offer unresolved and therefore unapplied; the second
 * supplies the resulting subtotal so those offers can settle. A discount is only ever
 * included once its condition is actually satisfied.
 */
function repriceStore(
  lines: readonly StoreLine[],
  promotions: readonly Promotion[],
  prefs: UserPreferences,
  now: Date,
): { subtotalCents: number; pricing: Map<string, LinePricing> } {
  const first = lines.map((line) => ({
    line,
    pricing: priceLine(line.listItem, line.product, promotions, prefs, now),
  }));
  const provisional = first.reduce((sum, entry) => sum + entry.pricing.chargedTotalCents, 0);

  const pricing = new Map<string, LinePricing>();
  let subtotalCents = 0;
  for (const entry of first) {
    const settled = entry.pricing.hasUnresolvedPromotion
      ? priceLine(entry.line.listItem, entry.line.product, promotions, prefs, now, provisional)
      : entry.pricing;
    pricing.set(entry.line.tripItem.groceryItemId, settled);
    subtotalCents += settled.chargedTotalCents;
  }
  return { subtotalCents, pricing };
}

/**
 * Lines that still have to be bought at a store, given the trip's current state.
 *
 * Collected and skipped lines are settled: their money is spent or forgone, and they
 * neither move nor count toward a minimum spend that has yet to be met. The line being
 * decided is excluded so a caller can add it back at whichever store it is considering.
 */
function openLinesAt(
  trip: ShoppingTrip,
  storeId: string,
  excludeGroceryItemId: string,
  products: readonly RetailerProduct[],
): StoreLine[] {
  const out: StoreLine[] = [];
  for (const stop of trip.stops) {
    if (stop.store.id !== storeId) continue;
    for (const tripItem of stop.items) {
      if (tripItem.groceryItemId === excludeGroceryItemId) continue;
      if (tripItem.status === 'skipped' || tripItem.status === 'unavailable') continue;
      const listItem = listItemFor(trip, tripItem.groceryItemId);
      const product = products.find(
        (entry) =>
          entry.storeId === storeId &&
          entry.observation.retailerProductId === tripItem.retailerProductId,
      );
      if (!listItem || !product) continue;
      out.push({ tripItem, listItem, product });
    }
  }
  return out;
}

/** Spend already committed at a store, from lines the shopper has collected. */
function committedSpendAt(trip: ShoppingTrip, storeId: string): number {
  return trip.stops
    .filter((stop) => stop.store.id === storeId)
    .flatMap((stop) => stop.items)
    .filter((item) => item.status === 'collected' || item.status === 'different_price')
    .reduce((sum, item) => sum + actualLineTotal(item), 0);
}

/** What a line actually costs, preferring what the shopper observed over the plan. */
export function actualLineTotal(item: TripItem): number {
  if (item.actualPriceCents === undefined) return item.lineTotalCents;
  const quantity = item.actualQuantity ?? item.quantity;
  return roundCents(item.actualPriceCents * quantity);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate products
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Products at one store that may legally fill a line.
 *
 * Delegates entirely to `matchProduct`, so brand policy, variant rules, barcode
 * identity, currency and availability are enforced exactly as the optimizer enforces
 * them. Shop Mode has no looser path to a substitute: an `exact_product` line stays
 * `exact_product` in the aisle.
 */
function candidatesAt(
  storeId: string,
  listItem: GroceryListItem,
  products: readonly RetailerProduct[],
  prefs: UserPreferences,
  currency: string,
): { product: RetailerProduct; substitution: boolean }[] {
  const out: { product: RetailerProduct; substitution: boolean }[] = [];
  for (const product of products) {
    if (product.storeId !== storeId) continue;
    const match = matchProduct(listItem, product, {
      currency,
      defaultBrandPolicy: prefs.brandPolicy,
    });
    if (!match.matched) continue;
    out.push({ product, substitution: match.substitution });
  }
  return out;
}

/** Promotion status changes caused by an option, for the explanation. */
function promotionImpactsFor(
  before: Map<string, LinePricing>,
  after: Map<string, LinePricing>,
  storeId: string,
): PromotionImpact[] {
  const impacts: PromotionImpact[] = [];
  for (const [groceryItemId, previous] of before) {
    const next = after.get(groceryItemId);
    if (!next) continue;
    if (previous.promotionStatus === next.promotionStatus) continue;
    const label = next.promotion?.label ?? previous.promotion?.label;
    if (label === undefined) continue;
    impacts.push({
      storeId,
      groceryItemId,
      promotionLabel: label,
      before: previous.promotionStatus,
      after: next.promotionStatus,
      savingsDeltaCents: next.promotionSavingsCents - previous.promotionSavingsCents,
    });
  }
  return impacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// The replanner
// ─────────────────────────────────────────────────────────────────────────────

interface Context {
  trip: ShoppingTrip;
  event: ShopEvent;
  prefs: UserPreferences;
  now: Date;
  currency: string;
  products: RetailerProduct[];
  currentStoreId: string;
  tripItem: TripItem;
  listItem: GroceryListItem;
  /** Baseline: what the line and its store cost with the plan untouched. */
  plannedLineCents: number;
}

/**
 * Cost of putting a line at one store, including that store's promotion knock-ons.
 *
 * Returns `null` when the store cannot supply the line at all. The delta is measured
 * against the store's subtotal *without* this line, so a minimum-spend offer that the
 * line pushes over its threshold shows up as the saving it is.
 */
function costAtStore(
  context: Context,
  storeId: string,
  product: RetailerProduct,
): { lineCents: number; storeDeltaCents: number; impacts: PromotionImpact[] } | null {
  const { trip, prefs, now, listItem } = context;
  const promotions = trip.market.promotions;
  const others = openLinesAt(trip, storeId, context.tripItem.groceryItemId, context.products);
  const committed = committedSpendAt(trip, storeId);

  const withoutLine = repriceStore(others, promotions, prefs, now);
  const withLine = repriceStore(
    [...others, { tripItem: context.tripItem, listItem, product }],
    promotions,
    prefs,
    now,
  );

  // Committed spend counts toward a minimum-spend threshold: money already in the
  // basket at this store is money spent there.
  const lineCents = withLine.pricing.get(context.tripItem.groceryItemId)?.chargedTotalCents;
  if (lineCents === undefined) return null;

  return {
    lineCents,
    storeDeltaCents: withLine.subtotalCents + committed - (withoutLine.subtotalCents + committed),
    impacts: promotionImpactsFor(withoutLine.pricing, withLine.pricing, storeId),
  };
}

/**
 * What taking the line *away* from its planned store does to the lines that stay.
 *
 * Only the knock-on is returned, never the line's own cost. That distinction is the
 * whole point: the line's cost is accounted once, at whichever store ends up supplying
 * it, and counting it again here would make every move look far cheaper than it is.
 *
 * A positive figure means the remaining lines get dearer — typically because the store
 * drops below a minimum-spend threshold and loses an offer that was carrying them.
 */
function removalKnockOnAt(
  context: Context,
  storeId: string,
): { knockOnCents: number; impacts: PromotionImpact[] } {
  const { trip, prefs, now } = context;
  const promotions = trip.market.promotions;
  const others = openLinesAt(trip, storeId, context.tripItem.groceryItemId, context.products);
  const product = context.products.find(
    (entry) =>
      entry.storeId === storeId &&
      entry.observation.retailerProductId === context.tripItem.retailerProductId,
  );

  const withoutLine = repriceStore(others, promotions, prefs, now);
  if (!product) return { knockOnCents: 0, impacts: [] };
  const withLine = repriceStore(
    [...others, { tripItem: context.tripItem, listItem: context.listItem, product }],
    promotions,
    prefs,
    now,
  );

  const lineCents = withLine.pricing.get(context.tripItem.groceryItemId)?.chargedTotalCents ?? 0;

  return {
    // (subtotal without the line) − (subtotal with it, less the line's own cost).
    knockOnCents: withoutLine.subtotalCents - (withLine.subtotalCents - lineCents),
    // Reported from the perspective of the store losing the line.
    impacts: promotionImpactsFor(withLine.pricing, withoutLine.pricing, storeId),
  };
}

/** Stores the shopper is still going to visit. The current stop is not one of them. */
function remainingStoreIds(trip: ShoppingTrip): string[] {
  return trip.stops
    .slice(trip.currentStopIndex + 1)
    .map((stop) => stop.store.id)
    .filter((id, index, all) => all.indexOf(id) === index);
}

/** Effort of adding a store that is not already on the route. */
function detourEffort(store: Store, trip: ShoppingTrip, prefs: UserPreferences) {
  const furthest = Math.max(0, ...trip.stops.map((stop) => stop.store.distanceMiles));
  // Only the distance beyond the existing route's reach is genuinely new, plus the
  // hop between stops — the same geometry the optimizer uses.
  const extraMiles = Number(
    (Math.max(0, store.distanceMiles - furthest) * 2 + EXTRA_STOP_MILES).toFixed(2),
  );
  const extraMinutes = Math.round(
    extraMiles * minutesPerMileFor(prefs.transportMode) + EXTRA_STOP_MINUTES,
  );
  return { miles: extraMiles, minutes: extraMinutes, extraStops: 1 };
}

/** Effort saved by dropping a store from the route entirely. */
function removedStopEffort(store: Store, trip: ShoppingTrip, prefs: UserPreferences) {
  const others = trip.stops.filter((stop) => stop.store.id !== store.id);
  const furthestOther = Math.max(0, ...others.map((stop) => stop.store.distanceMiles));
  const savedMiles = Number(
    (Math.max(0, store.distanceMiles - furthestOther) * 2 + EXTRA_STOP_MILES).toFixed(2),
  );
  const savedMinutes = Math.round(
    savedMiles * minutesPerMileFor(prefs.transportMode) + EXTRA_STOP_MINUTES,
  );
  return { miles: -savedMiles, minutes: -savedMinutes, extraStops: -1 };
}

function money(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * Works out what a shelf report means for the rest of the trip.
 *
 * Pure and deterministic: same trip, same event, same preferences, same answer, with no
 * network and no model involved in any figure.
 */
export function adaptTrip(input: {
  trip: ShoppingTrip;
  event: ShopEvent;
  preferences: UserPreferences;
  now?: Date;
  /** Whether Juva is working from the cache with no connectivity. Recorded, not used. */
  offline?: boolean;
}): AdaptDecision | undefined {
  const { trip, event, preferences: prefs } = input;
  const now = input.now ?? new Date();

  const stop = trip.stops[trip.currentStopIndex];
  if (!stop) return undefined;
  const tripItem = stop.items.find((entry) => entry.groceryItemId === event.groceryItemId);
  const rawListItem = listItemFor(trip, event.groceryItemId);
  if (!tripItem || !rawListItem) return undefined;

  const listItem = effectiveListItem(rawListItem, event);
  const currency = trip.market.list.currency;
  const products = observedMarket(trip, event, stop.store.id, now);

  const context: Context = {
    trip,
    event,
    prefs,
    now,
    currency,
    products,
    currentStoreId: stop.store.id,
    tripItem,
    listItem,
    plannedLineCents: tripItem.lineTotalCents,
  };

  const options: AdaptOption[] = [];
  const policy = effectiveBrandPolicy(listItem, prefs.brandPolicy);

  // ── Buy it here, at whatever the shelf says ───────────────────────────────
  const hereCandidates = candidatesAt(stop.store.id, listItem, products, prefs, currency);
  const hereSame = hereCandidates.find(
    (entry) => entry.product.observation.retailerProductId === tripItem.retailerProductId,
  );

  /**
   * Whether the requested pack could be normalized against the shelf's.
   *
   * A "500 g" line against a pack marked "family size" has no honest conversion. Juva
   * records both and declines to claim they are equivalent rather than inventing a
   * ratio, which would put a fabricated quantity into a real total.
   */
  const unitsNormalized =
    event.kind !== 'different_package' || event.observedSizeLabel === undefined
      ? true
      : normalizeLabel(event.observedSizeLabel) !== null &&
        normalizeLabel(listItem.unit) !== null &&
        normalizeLabel(event.observedSizeLabel)?.dimension ===
          normalizeLabel(listItem.unit)?.dimension;

  if (hereSame) {
    const cost = costAtStore(context, stop.store.id, hereSame.product);
    if (cost) {
      options.push({
        id: 'buy_here',
        kind: 'buy_here',
        label: `Buy it at ${stop.store.retailerName}`,
        storeId: stop.store.id,
        retailerProductId: hereSame.product.observation.retailerProductId,
        productTitle: hereSame.product.title,
        lineTotalCents: cost.lineCents,
        basketDeltaCents: cost.storeDeltaCents - context.plannedLineCents,
        extraMiles: 0,
        extraMinutes: 0,
        extraStops: 0,
        effortDeltaCents: 0,
        netDeltaCents: cost.storeDeltaCents - context.plannedLineCents,
        promotionImpacts: cost.impacts,
        rankable: true,
        substitution: false,
        unitsNormalized,
        feasible: true,
      });
    }
  }

  // ── Take a different product on the same shelf ────────────────────────────
  const substitutes = hereCandidates
    .filter((entry) => entry.product.observation.retailerProductId !== tripItem.retailerProductId)
    .map((entry) => {
      const cost = costAtStore(context, stop.store.id, entry.product);
      return cost ? { entry, cost } : undefined;
    })
    .filter(
      (
        value,
      ): value is {
        entry: (typeof hereCandidates)[number];
        cost: NonNullable<ReturnType<typeof costAtStore>>;
      } => value !== undefined,
    )
    .sort(
      (a, b) =>
        a.cost.lineCents +
          brandRankPenaltyCents(policy, a.entry.substitution) -
          (b.cost.lineCents + brandRankPenaltyCents(policy, b.entry.substitution)) ||
        a.entry.product.observation.retailerProductId.localeCompare(
          b.entry.product.observation.retailerProductId,
        ),
    )
    .slice(0, MAX_OPTIONS_PER_KIND);

  for (const { entry, cost } of substitutes) {
    const delta = cost.storeDeltaCents - context.plannedLineCents;
    options.push({
      id: `substitute:${entry.product.observation.retailerProductId}`,
      kind: 'change_substitute',
      label: `Take ${entry.product.title} instead`,
      storeId: stop.store.id,
      retailerProductId: entry.product.observation.retailerProductId,
      productTitle: entry.product.title,
      lineTotalCents: cost.lineCents,
      basketDeltaCents: delta,
      extraMiles: 0,
      extraMinutes: 0,
      extraStops: 0,
      effortDeltaCents: 0,
      netDeltaCents: delta,
      promotionImpacts: cost.impacts,
      rankable: true,
      substitution: entry.substitution,
      feasible: true,
    });
  }

  // ── A substitute the shopper typed in ─────────────────────────────────────
  //
  // Offered only when they supplied one, and always marked unverified: this is their
  // figure, not an observation Juva made, and reconciliation has to be able to tell the
  // difference when the receipt arrives.
  if (event.manualSubstitute !== undefined) {
    const manualTotal = roundCents(
      event.manualSubstitute.priceCents * (event.observedQuantity ?? tripItem.quantity),
    );
    options.push({
      id: 'manual_substitute',
      kind: 'change_substitute',
      label: `Take ${event.manualSubstitute.title}`,
      storeId: stop.store.id,
      retailerProductId: null,
      productTitle: event.manualSubstitute.title,
      lineTotalCents: manualTotal,
      basketDeltaCents: manualTotal - context.plannedLineCents,
      extraMiles: 0,
      extraMinutes: 0,
      extraStops: 0,
      effortDeltaCents: 0,
      netDeltaCents: manualTotal - context.plannedLineCents,
      // It competes on price, because the shopper told Juva what it costs. What it does
      // not carry is a promotion: an offer Juva cannot see on a product it cannot see is
      // not something it may promise.
      rankable: true,
      promotionImpacts: [],
      substitution: true,
      manualEntry: true,
      feasible: true,
    });
  }

  // ── Buy it at a stop already on the route ─────────────────────────────────
  const removal = removalKnockOnAt(context, stop.store.id);
  for (const storeId of remainingStoreIds(trip)) {
    const store = storeFor(trip, storeId);
    if (!store) continue;
    const best = candidatesAt(storeId, listItem, products, prefs, currency)
      .map((entry) => {
        const cost = costAtStore(context, storeId, entry.product);
        return cost ? { entry, cost } : undefined;
      })
      .filter((value): value is NonNullable<typeof value> => value !== undefined)
      .sort((a, b) => a.cost.lineCents - b.cost.lineCents)[0];
    if (!best) continue;

    // No extra travel: the shopper is going there anyway.
    const delta = best.cost.storeDeltaCents - context.plannedLineCents + removal.knockOnCents;
    options.push({
      id: `existing:${storeId}`,
      kind: 'buy_at_existing_stop',
      label: `Buy it at ${store.retailerName} instead`,
      storeId,
      retailerProductId: best.entry.product.observation.retailerProductId,
      productTitle: best.entry.product.title,
      lineTotalCents: best.cost.lineCents,
      basketDeltaCents: delta,
      extraMiles: 0,
      extraMinutes: 0,
      extraStops: 0,
      effortDeltaCents: 0,
      netDeltaCents: delta,
      promotionImpacts: [...removal.impacts, ...best.cost.impacts],
      rankable: true,
      substitution: best.entry.substitution,
      feasible: true,
    });
  }

  // ── Add a stop that is not on the route ───────────────────────────────────
  const onRoute = new Set(trip.stops.map((entry) => entry.store.id));
  const detours = trip.market.stores
    .filter((store) => !onRoute.has(store.id) && store.distanceMiles <= prefs.radiusMiles)
    .map((store) => {
      const best = candidatesAt(store.id, listItem, products, prefs, currency)
        .map((entry) => {
          const cost = costAtStore(context, store.id, entry.product);
          return cost ? { entry, cost } : undefined;
        })
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
        .sort((a, b) => a.cost.lineCents - b.cost.lineCents)[0];
      if (!best) return undefined;
      const effort = detourEffort(store, trip, prefs);
      const effortDelta = effortCostCents(effort, prefs);
      const basketDelta =
        best.cost.storeDeltaCents - context.plannedLineCents + removal.knockOnCents;
      return { store, best, effort, effortDelta, basketDelta };
    })
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort(
      (a, b) =>
        a.basketDelta + a.effortDelta - (b.basketDelta + b.effortDelta) ||
        a.store.id.localeCompare(b.store.id),
    )
    .slice(0, MAX_OPTIONS_PER_KIND);

  for (const detour of detours) {
    options.push({
      id: `add_stop:${detour.store.id}`,
      kind: 'add_stop',
      label: `Add a stop at ${detour.store.retailerName}`,
      storeId: detour.store.id,
      retailerProductId: detour.best.entry.product.observation.retailerProductId,
      productTitle: detour.best.entry.product.title,
      lineTotalCents: detour.best.cost.lineCents,
      basketDeltaCents: detour.basketDelta,
      extraMiles: detour.effort.miles,
      extraMinutes: detour.effort.minutes,
      extraStops: 1,
      effortDeltaCents: detour.effortDelta,
      netDeltaCents: detour.basketDelta + detour.effortDelta,
      promotionImpacts: [...removal.impacts, ...detour.best.cost.impacts],
      rankable: true,
      substitution: detour.best.entry.substitution,
      feasible: true,
    });
  }

  // ── Drop a later stop that this line was the last reason to visit ─────────
  if (hereSame) {
    for (const storeId of remainingStoreIds(trip)) {
      const store = storeFor(trip, storeId);
      if (!store) continue;
      const stillNeeded = trip.stops
        .filter((entry) => entry.store.id === storeId)
        .flatMap((entry) => entry.items)
        .filter(
          (line) =>
            line.groceryItemId !== event.groceryItemId &&
            line.status !== 'skipped' &&
            line.status !== 'unavailable',
        );
      if (stillNeeded.length > 0) continue;

      const cost = costAtStore(context, stop.store.id, hereSame.product);
      if (!cost) continue;
      const effort = removedStopEffort(store, trip, prefs);
      const effortDelta = effortCostCents(effort, prefs);
      const basketDelta = cost.storeDeltaCents - context.plannedLineCents;
      options.push({
        id: `remove_stop:${storeId}`,
        kind: 'remove_stop',
        label: `Buy it here and skip ${store.retailerName}`,
        storeId: stop.store.id,
        retailerProductId: hereSame.product.observation.retailerProductId,
        productTitle: hereSame.product.title,
        lineTotalCents: cost.lineCents,
        basketDeltaCents: basketDelta,
        extraMiles: effort.miles,
        extraMinutes: effort.minutes,
        extraStops: -1,
        effortDeltaCents: effortDelta,
        netDeltaCents: basketDelta + effortDelta,
        promotionImpacts: cost.impacts,
        rankable: true,
        substitution: false,
        feasible: true,
      });
    }
  }

  // ── Leave it out of the basket ────────────────────────────────────────────
  // Always offered, and never described as a saving: a basket without the item is
  // cheaper for the wrong reason, which is exactly what the completeness gate exists
  // to say. `basketDeltaCents` is the honest arithmetic; the explanation does not
  // present it as money saved.
  options.push({
    id: 'drop',
    kind: 'drop_item',
    label: `Do without ${tripItem.requestedName}`,
    storeId: null,
    retailerProductId: null,
    productTitle: tripItem.requestedName,
    lineTotalCents: 0,
    basketDeltaCents: removal.knockOnCents - context.plannedLineCents,
    extraMiles: 0,
    extraMinutes: 0,
    extraStops: 0,
    effortDeltaCents: 0,
    // The honest arithmetic, so the figure shown is the figure that is true. It simply
    // does not compete: `rankable: false` keeps it out of the comparison entirely rather
    // than giving it a score that could reach a subtraction or a savings claim.
    netDeltaCents: removal.knockOnCents - context.plannedLineCents,
    rankable: false,
    promotionImpacts: removal.impacts,
    substitution: false,
    feasible: true,
  });

  // Rankable options first, cheapest first; everything else keeps a stable place at the
  // end. Non-rankable options never take part in the comparison that follows.
  const ranked = [...options].sort((a, b) => {
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    if (!a.rankable) return a.id.localeCompare(b.id);
    return a.netDeltaCents - b.netDeltaCents || a.id.localeCompare(b.id);
  });

  const stayPut = options.find((option) => option.id === 'buy_here');
  const best = ranked.find((option) => option.rankable);
  if (!best) {
    // Nothing competes — the line cannot be filled anywhere. The only honest answer is
    // to do without, and it is presented as a gap rather than as a saving.
    const fallback = ranked[0];
    if (!fallback) return undefined;
    return {
      event,
      options: ranked,
      recommended: fallback,
      unchanged: false,
      ...explain(context, fallback, stayPut, ranked),
    };
  }

  /**
   * Choosing what to recommend.
   *
   * When the line can still be bought here, staying put wins unless something else is
   * better by more than the churn margin. That asymmetry is deliberate: the shopper is
   * already standing in the aisle, and a recommendation to walk away should have to
   * earn it.
   */
  const recommended =
    stayPut !== undefined && best.netDeltaCents > stayPut.netDeltaCents - ADAPT_SWITCH_MARGIN_CENTS
      ? stayPut
      : best;

  return {
    event,
    options: ranked,
    recommended,
    unchanged: recommended.id === 'buy_here' && recommended.basketDeltaCents === 0,
    ...explain(context, recommended, stayPut, ranked),
  };
}

/**
 * The shopper-facing words, built from the option figures.
 *
 * Written here rather than in the screen so the explanation cannot drift from the
 * decision it describes — the same reason the plan rationale is built in the optimizer.
 */
function explain(
  context: Context,
  recommended: AdaptOption,
  stayPut: AdaptOption | undefined,
  ranked: readonly AdaptOption[],
): { headline: string; detail: string; recommendation: string } {
  const { event, tripItem, prefs } = context;
  const name = tripItem.requestedName;

  const headline =
    event.kind === 'unavailable'
      ? 'NOT ON THE SHELF'
      : event.kind === 'quantity_changed'
        ? 'QUANTITY CHANGED'
        : event.kind === 'different_package'
          ? 'DIFFERENT PACK'
          : 'PRICE CHANGED';

  const parts: string[] = [];

  if (event.kind === 'unavailable') {
    parts.push(`${name} is not available here.`);
  } else if (event.observedPriceCents !== undefined) {
    const delta = event.observedPriceCents - tripItem.listPriceCents;
    parts.push(
      delta === 0
        ? `${name} is the price Juva expected.`
        : `${name} is ${money(delta)} ${delta > 0 ? 'higher' : 'lower'} here than planned.`,
    );
  } else if (event.kind === 'quantity_changed' && event.observedQuantity !== undefined) {
    parts.push(`${name} changed to ${event.observedQuantity} from ${tripItem.quantity}.`);
  }

  // The best genuine alternative, so the trade-off is stated even when Juva advises
  // against taking it.
  const alternative = ranked.find(
    (option) => option.id !== 'buy_here' && option.id !== 'drop' && option.feasible,
  );
  if (alternative && stayPut) {
    const saving = stayPut.netDeltaCents - alternative.basketDeltaCents;
    if (saving > 0) {
      const cost =
        alternative.extraMinutes > 0
          ? `, but that adds ${alternative.extraMinutes} minutes`
          : alternative.kind === 'buy_at_existing_stop'
            ? ' with no extra travel'
            : '';
      parts.push(`${alternative.label} saves ${money(saving)}${cost}.`);
    }
  }

  for (const impact of recommended.promotionImpacts) {
    if (impact.after === 'applied') {
      parts.push(`This keeps "${impact.promotionLabel}" applied.`);
    } else if (impact.before === 'applied') {
      parts.push(
        `Heads up: "${impact.promotionLabel}" no longer applies, costing ${money(impact.savingsDeltaCents)}.`,
      );
    }
  }

  const recommendation =
    recommended.kind === 'buy_here'
      ? 'Buy here.'
      : recommended.kind === 'change_substitute'
        ? `Take ${recommended.productTitle}.`
        : recommended.kind === 'buy_at_existing_stop'
          ? `Buy it at your next stop instead.`
          : recommended.kind === 'add_stop'
            ? `Worth adding a stop: ${recommended.label.replace('Add a stop at ', '')}.`
            : recommended.kind === 'remove_stop'
              ? 'Buy here and skip the other stop.'
              : `Leave ${name} out for now.`;

  if (recommended.kind === 'buy_here' && alternative && alternative.extraMinutes > 0) {
    parts.push(
      `${prefs.conveniencePreference >= 0.5 ? 'On your settings' : 'Even at your lowest-price setting'}, the detour costs more than it saves.`,
    );
  }

  return { headline, detail: parts.join(' '), recommendation };
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying a decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies the shopper's choice to the trip.
 *
 * `trip.origin` is copied through untouched — this function cannot corrupt the baseline
 * even if asked to, which is what makes the savings figure survive a replan.
 */
export function applyAdaptation(input: {
  trip: ShoppingTrip;
  decision: AdaptDecision;
  chosenOptionId: string;
  now?: Date;
}): { trip: ShoppingTrip; adaptation: TripAdaptation } | undefined {
  const { trip, decision } = input;
  const now = input.now ?? new Date();

  /**
   * Refuse to adapt a trip whose baseline has already been tampered with.
   *
   * Proceeding would layer a correct-looking adaptation on top of a corrupted record and
   * produce a savings figure that reconciles perfectly against the wrong number — which
   * is far worse than doing nothing.
   */
  if (!originIntact(trip.origin)) return undefined;
  const chosen = decision.options.find((option) => option.id === input.chosenOptionId);
  if (!chosen) return undefined;

  const groceryItemId = decision.event.groceryItemId;
  const source = trip.stops[trip.currentStopIndex];
  const before = source?.items.find((item) => item.groceryItemId === groceryItemId);
  if (!source || !before) return undefined;

  const status = statusFor(decision.event, chosen);

  const nextStops = trip.stops.map((stop) => {
    const isSource = stop.store.id === source.store.id;
    const isTarget = chosen.storeId !== null && stop.store.id === chosen.storeId;

    // The line stays where it is, updated in place.
    if (isSource && isTarget) {
      return {
        ...stop,
        items: stop.items.map((item) =>
          item.groceryItemId === groceryItemId ? updatedItem(item, decision, chosen, status) : item,
        ),
        expectedSubtotalCents: stop.expectedSubtotalCents,
      };
    }

    // The line leaves this stop.
    if (isSource) {
      return {
        ...stop,
        items: stop.items.map((item) =>
          item.groceryItemId === groceryItemId
            ? {
                ...updatedItem(item, decision, chosen, status),
                ...(chosen.storeId === null ? {} : { movedToStoreId: chosen.storeId }),
              }
            : item,
        ),
      };
    }

    // The line arrives at this stop.
    if (isTarget) {
      const moved = updatedItem(before, decision, chosen, 'pending');
      return {
        ...stop,
        items: [
          ...stop.items.filter((item) => item.groceryItemId !== groceryItemId),
          { ...moved, storeId: stop.store.id },
        ],
      };
    }

    return stop;
  });

  const withSubtotals = nextStops.map((stop) => ({
    ...stop,
    expectedSubtotalCents: stop.items
      .filter((item) => item.status !== 'skipped' && item.status !== 'unavailable')
      .reduce((sum, item) => sum + actualLineTotal(item), 0),
  }));

  const adaptation: TripAdaptation = {
    id: `adapt-${now.getTime()}-${groceryItemId}`,
    at: now.toISOString(),
    groceryItemId,
    requestedName: before.requestedName,
    event: decision.event.kind,
    before: {
      storeId: source.store.id,
      retailerProductId: before.retailerProductId,
      lineTotalCents: before.lineTotalCents,
    },
    options: decision.options,
    recommendedOptionId: decision.recommended.id,
    chosenOptionId: chosen.id,
    overrodeRecommendation: chosen.id !== decision.recommended.id,
    after:
      chosen.storeId === null || chosen.retailerProductId === null
        ? null
        : {
            storeId: chosen.storeId,
            retailerProductId: chosen.retailerProductId,
            lineTotalCents: chosen.lineTotalCents,
          },
    tripBasketCentsAfter: withSubtotals.reduce((sum, stop) => sum + stop.expectedSubtotalCents, 0),
    // Facts Juva can actually assert: the replan read the cached market, and needed no
    // network to do it. Neither claims to know whether the device had a connection.
    usedCachedMarket: true,
    networkRequired: false,
  };

  return {
    trip: {
      ...trip,
      stops: withSubtotals,
      // A fresh value snapshot carrying the *stored* fingerprint, so no two trip
      // versions share mutable structure and the hash still reflects the trip's start.
      origin: carryOrigin(trip.origin),
      adaptations: [...trip.adaptations, adaptation],
    },
    adaptation,
  };
}

function statusFor(event: ShopEvent, chosen: AdaptOption): TripItemStatus {
  if (chosen.kind === 'drop_item') return 'unavailable';
  if (chosen.kind === 'change_substitute') return 'substituted';
  if (event.kind === 'substitute') return 'pending';
  if (event.kind === 'quantity_changed') return 'quantity_changed';
  if (event.kind === 'different_package') return 'different_package';
  if (event.kind === 'unavailable') return chosen.kind === 'buy_here' ? 'pending' : 'pending';
  return 'different_price';
}

function updatedItem(
  item: TripItem,
  decision: AdaptDecision,
  chosen: AdaptOption,
  status: TripItemStatus,
): TripItem {
  const { event } = decision;
  const quantity = event.observedQuantity ?? item.quantity;
  return {
    ...item,
    status,
    lineTotalCents: chosen.lineTotalCents,
    ...(chosen.retailerProductId === null
      ? {}
      : { retailerProductId: chosen.retailerProductId, productTitle: chosen.productTitle }),
    ...(event.observedPriceCents === undefined
      ? {}
      : { actualPriceCents: event.observedPriceCents }),
    ...(event.observedQuantity === undefined ? {} : { actualQuantity: quantity }),
    ...(event.observedSizeLabel === undefined ? {} : { actualSizeLabel: event.observedSizeLabel }),
    ...(chosen.kind === 'change_substitute' && chosen.retailerProductId !== null
      ? { substituteProductId: chosen.retailerProductId, substituteTitle: chosen.productTitle }
      : {}),
    // A hand-typed substitute has no observation behind it. The flag travels with the
    // line so the plan, the checklist and reconciliation all know this figure came from
    // the shopper rather than from a price Juva saw.
    ...(chosen.manualEntry === true
      ? { substituteTitle: chosen.productTitle, substituteUnverified: true }
      : {}),
    ...(chosen.unitsNormalized === false ? { unitsNormalized: false } : {}),
  };
}

/**
 * What the trip now expects to cost, and what that means against the frozen baseline.
 *
 * The saving is measured against `origin.comparedBaselineCents` — never a recomputed
 * one — and only when the originating plan was eligible for comparison in the first
 * place. A trip that started partial stays uncomparable however well the replans go.
 */
export function tripProgress(trip: ShoppingTrip): {
  expectedTotalCents: number;
  originalTotalCents: number;
  driftCents: number;
  baselineCents: number;
  estimatedSavingsCents: number;
  comparisonEligible: boolean;
  droppedItemCount: number;
} {
  const expectedTotalCents = trip.stops.reduce(
    (sum, stop) =>
      sum +
      stop.items
        .filter((item) => item.status !== 'skipped' && item.status !== 'unavailable')
        .reduce((lineSum, item) => lineSum + actualLineTotal(item), 0),
    0,
  );
  const droppedItemCount = trip.stops
    .flatMap((stop) => stop.items)
    .filter((item) => item.status === 'skipped' || item.status === 'unavailable').length;

  // A trip that lost a line is no longer the basket the baseline priced, so it stops
  // being comparable — the same rule the optimizer applies to a partial plan.
  const comparisonEligible = trip.origin.comparisonEligible && droppedItemCount === 0;

  return {
    expectedTotalCents,
    originalTotalCents: trip.origin.basketCostCents,
    driftCents: expectedTotalCents - trip.origin.basketCostCents,
    baselineCents: trip.origin.comparedBaselineCents,
    estimatedSavingsCents: comparisonEligible
      ? Math.max(0, trip.origin.comparedBaselineCents - expectedTotalCents)
      : 0,
    comparisonEligible,
    droppedItemCount,
  };
}
