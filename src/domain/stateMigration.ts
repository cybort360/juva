import { migrateBrandPolicy } from './matching';
import type {
  GroceryList,
  JuvaState,
  ShoppingTrip,
  TripAdaptation,
  UserPreferences,
} from './types';

/**
 * Forward migration of persisted device state.
 *
 * Juva keeps one JSON blob on the device and validates it structurally on load. That
 * check is shape-only, so a stored `brandPolicy: 'exact'` from before the policy split
 * passes validation and then flows into the optimizer as a value no branch handles —
 * which would quietly behave as the loosest policy, the opposite of what the shopper
 * chose. Rather than discard the state (losing saved lists and verified savings) or
 * leave it wrong, it is upgraded here on the way in.
 *
 * Kept in `domain/` rather than in `services/persistence.ts` because that module
 * imports AsyncStorage, and a React Native import cannot be loaded by the deterministic
 * test suite. The migration is the part that needs testing.
 */

/** Every list in the state, so a policy migration reaches items too. */
function migrateList(list: GroceryList): GroceryList {
  return {
    ...list,
    items: list.items.map((item) =>
      item.brandPolicy === undefined
        ? item
        : { ...item, brandPolicy: migrateBrandPolicy(item.brandPolicy) },
    ),
  };
}

function migratePreferences(preferences: UserPreferences): UserPreferences {
  return {
    ...preferences,
    brandPolicy: migrateBrandPolicy(preferences.brandPolicy),
    // Added with coupon-gated promotions. Absent on older state, and an absent list
    // is correctly read as "holds no coupons" — never as "holds them all".
    couponIds: Array.isArray(preferences.couponIds) ? preferences.couponIds : [],
    loyaltyRetailers: Array.isArray(preferences.loyaltyRetailers)
      ? preferences.loyaltyRetailers
      : [],
  };
}

/**
 * An adaptation record from before the connectivity fields were corrected.
 *
 * The old `offline: true` was recorded to mean "the replanner used no network", which is
 * not the same claim as "the device was offline" — and Juva has no way to know the
 * second. The migration converts the fact that was actually being recorded.
 */
interface LegacyAdaptation {
  offline?: boolean;
  usedCachedMarket?: boolean;
  networkRequired?: boolean;
}

function migrateTrip(trip: ShoppingTrip): ShoppingTrip {
  return {
    ...trip,
    adaptations: trip.adaptations.map((adaptation) => {
      const legacy = adaptation as TripAdaptation & LegacyAdaptation;
      if (typeof legacy.usedCachedMarket === 'boolean') return adaptation;
      const { offline: _offline, ...rest } = legacy;
      return {
        ...(rest as TripAdaptation),
        // Every historic decision was made by the same cache-only replanner, so this is
        // the fact the old flag stood for — restated without the connectivity claim.
        usedCachedMarket: true,
        networkRequired: false,
      };
    }),
  };
}

/** Whether anything in this state predates the current schema. */
export function needsMigration(state: JuvaState): boolean {
  const trip = state.activeTrip;
  if (
    trip !== undefined &&
    trip.adaptations.some(
      (adaptation) =>
        typeof (adaptation as TripAdaptation & LegacyAdaptation).usedCachedMarket !== 'boolean',
    )
  ) {
    return true;
  }
  const preferences = state.preferences;
  if ((preferences.brandPolicy as string) === 'exact') return true;
  if (!Array.isArray(preferences.couponIds)) return true;
  const lists = [
    ...state.savedLists,
    ...(state.activeList === undefined ? [] : [state.activeList]),
  ];
  return lists.some((list) => list.items.some((item) => (item.brandPolicy as string) === 'exact'));
}

export function migrateState(state: JuvaState): JuvaState {
  // A normal restart must be a no-op. Returning the same object keeps an ordinary
  // launch identical to before, so the migration can only ever affect state that
  // actually predates the schema.
  if (!needsMigration(state)) return state;

  return {
    ...state,
    preferences: migratePreferences(state.preferences),
    savedLists: state.savedLists.map(migrateList),
    ...(state.activeList === undefined ? {} : { activeList: migrateList(state.activeList) }),
    /**
     * Stored plans are dropped, but only on a state that genuinely needed migrating.
     *
     * A plan is a *computed* result: its prices, promotions and savings came from a
     * snapshot taken at a moment that has passed, and it was optimized under the old
     * policy rules. Rewriting the values inside one would produce a plan claiming to
     * have been optimized under rules it never saw. The shopper re-runs a search and
     * gets a real answer instead — which costs them one tap, once.
     */
    plans: [],
    selectedPlanId: undefined,
    ...(state.activeTrip === undefined ? {} : { activeTrip: migrateTrip(state.activeTrip) }),
  };
}
