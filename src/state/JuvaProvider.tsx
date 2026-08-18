import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import { countBand, savingsBand, verificationEventFor } from '@/domain/analytics';
import { demoList, demoPreferences } from '@/domain/demoMarket';
import { journeyCandidates, type JourneySources } from '@/domain/journeys';
import { interpretListPrompt, interpretPastedList, parseListLine } from '@/domain/listInterpreter';
import { optimizeBasket } from '@/domain/optimizer';
import { reconcileTrip, type MatchConfirmation } from '@/domain/reconcile';
import { buildLedger, persistLedger, readableLedgers } from '@/domain/savingsLedger';
import { adaptTrip, applyAdaptation, type AdaptDecision, type ShopEvent } from '@/domain/shopAdapt';
import { describeSnapshot } from '@/domain/snapshot';
import { createTrip, verifyTrip } from '@/domain/trip';
import { originFingerprint } from '@/domain/tripOrigin';
import type {
  BrandPolicy,
  PersistedLedger,
  ReconciliationCorrection,
  ShoppingTrip,
  SavingsLedger,
  GroceryList,
  MarketSnapshot,
  GroceryListItem,
  JuvaState,
  OptimizedPlan,
  Receipt,
  SavingsRecord,
  TripItemStatus,
  UserPreferences,
  ReconciliationResult,
} from '@/domain/types';
import { track } from '@/services/analytics';
import { getOrCreateAppUserId } from '@/services/identity';
import { loadMarketSnapshot } from '@/services/market';
import { reportHandled } from '@/services/monitoring';
import { cancelReceiptReminder, scheduleReceiptReminder } from '@/services/notifications';
import { clearJuvaState, createStateWriter, loadJuvaState } from '@/services/persistence';
import {
  evaluateJourney,
  identifyForPush,
  initPush,
  syncJourneyTags,
} from '@/services/pushJourneys';
import { deletePages, purgeAllPages, purgeExpiredPages } from '@/services/receiptImages';
import { messageFromError } from '@/utils/errors';

const initialState: JuvaState = {
  preferences: demoPreferences,
  draftPrompt: '',
  plans: [],
  receipts: [],
  savingsRecords: [],
  savedLists: [],
  journeyHistory: [],
};

/** A receipt as a screen supplies it; the provider stamps id and capture time. */
export type NewReceipt = Omit<Receipt, 'id' | 'capturedAt'>;

/** How the shopper entered their list. */
export type ListEntryMode = 'prompt' | 'paste';

export interface OptimizeResult {
  plans: OptimizedPlan[];
  error?: string;
}

type ContextValue = JuvaState & {
  /** False until persisted state has been read. Screens show a loading state. */
  hydrated: boolean;
  optimizing: boolean;
  optimizeError?: string | undefined;
  setDraftPrompt: (value: string) => void;
  updatePreferences: (patch: Partial<UserPreferences>) => void;
  completeOnboarding: () => void;
  createListFromPrompt: (prompt: string, mode?: ListEntryMode) => GroceryList;
  loadDemoBasket: () => void;
  updateListItem: (itemId: string, patch: Partial<GroceryListItem>) => void;
  removeListItem: (itemId: string) => void;
  addListItem: (name: string) => void;
  optimizeActiveList: () => Promise<OptimizeResult>;
  /** Re-plans against the cached snapshot after a preference change. */
  recomputePlans: (patch?: Partial<UserPreferences>) => OptimizedPlan[];
  /** Changes one line's brand rule and re-plans against the same observations. */
  setItemBrandPolicy: (groceryItemId: string, policy: BrandPolicy) => OptimizedPlan[];
  selectPlan: (planId: string) => void;
  selectedPlan?: OptimizedPlan | undefined;
  startSelectedPlan: () => boolean;
  updateTripItem: (
    groceryItemId: string,
    status: TripItemStatus,
    actualPriceCents?: number,
  ) => void;
  advanceTripStop: () => void;
  /**
   * Works out what a shelf report means for the rest of the trip.
   *
   * Returns the decision without applying it, so the shopper sees Juva's reasoning and
   * every option before anything changes. Reads only the trip's own cached market, so
   * it works with no connectivity.
   */
  planShelfChange: (event: ShopEvent) => AdaptDecision | undefined;
  /** Applies the shopper's choice, recording it whether or not it matched the advice. */
  applyShelfChange: (decision: AdaptDecision, chosenOptionId: string) => void;
  completeTrip: () => void;
  addReceipt: (receipt: NewReceipt) => void;
  /** Forgets a stop's receipt so it can be captured again. Deletes its images. */
  removeReceipt: (storeId: string) => void;
  /** Deletes retained images but keeps the figures already read from them. */
  deleteReceiptImages: (receiptId: string) => void;
  /** Deletes every retained receipt image on the device. */
  deleteAllReceiptImages: () => Promise<void>;
  /** The live reconciliation for the active trip, given the shopper's decisions. */
  reconcileActiveTrip: (
    confirmations?: readonly MatchConfirmation[],
  ) => ReconciliationResult | undefined;
  verifyActiveTrip: (confirmations?: readonly MatchConfirmation[]) => SavingsRecord | undefined;
  /**
   * The full economic ledger for the active trip.
   *
   * Recomputed from the trip, its plan and whatever receipts exist — never stored, so it
   * cannot drift from its inputs. Undefined until there is a trip to reconcile.
   */
  activeLedger?: SavingsLedger | undefined;
  /** Frozen ledgers for completed trips this build can read, newest first. */
  ledgerHistory: PersistedLedger[];
  /** Corrections discovered after leaving the store. Append-only. */
  addCorrection: (correction: ReconciliationCorrection) => void;
  saveActiveList: () => void;
  /** Loads a saved basket back in as the active list, ready to re-plan. */
  rerunSavedList: (listId: string) => GroceryList | undefined;
  /** Forgets a saved basket. */
  removeSavedList: (listId: string) => void;
  clearAll: () => Promise<void>;
};

/** The plan kind the shopper is currently looking at, if any. */
function currentKind(state: JuvaState): OptimizedPlan['kind'] | undefined {
  return state.plans.find((plan) => plan.id === state.selectedPlanId)?.kind;
}

const JuvaContext = createContext<ContextValue | null>(null);

export function JuvaProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<JuvaState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string>();
  const writerRef = useRef(createStateWriter());
  /** Last observed market, so preference changes can re-plan without refetching. */
  const snapshotRef = useRef<MarketSnapshot | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void loadJuvaState(initialState)
      .then((loaded) => {
        if (active) setState(loaded);
      })
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (hydrated) writerRef.current.schedule(state);
  }, [hydrated, state]);

  /**
   * Enforces the image retention window once, on launch.
   *
   * Retention has to be swept rather than scheduled: the app is not running when a
   * window expires, so the only honest moment to honour it is the next start. This
   * also clears pages a crash left behind mid-capture, which belong to no receipt.
   */
  const sweptRef = useRef(false);
  useEffect(() => {
    if (!hydrated || sweptRef.current) return;
    sweptRef.current = true;
    void purgeExpiredPages(state.preferences.receiptImageRetentionDays).catch(() => undefined);
  }, [hydrated, state.preferences.receiptImageRetentionDays]);

  // Persist whatever is pending when the provider goes away.
  useEffect(() => {
    const writer = writerRef.current;
    return () => {
      void writer.flush();
    };
  }, []);

  const setDraftPrompt = useCallback(
    (draftPrompt: string) => setState((current) => ({ ...current, draftPrompt })),
    [],
  );

  const updatePreferences = useCallback(
    (patch: Partial<UserPreferences>) =>
      setState((current) => ({ ...current, preferences: { ...current.preferences, ...patch } })),
    [],
  );

  const completeOnboarding = useCallback(
    () => updatePreferences({ onboarded: true }),
    [updatePreferences],
  );

  /**
   * Interprets what the shopper wrote into a basket.
   *
   * `paste` forces line-by-line reading; `prompt` reads a sentence but falls back
   * to list mode when the text is clearly a list. Either way an unrecognised item
   * is kept, so the basket never looks more complete than it is.
   */
  const createListFromPrompt = useCallback((prompt: string, mode: ListEntryMode = 'prompt') => {
    const list = mode === 'paste' ? interpretPastedList(prompt) : interpretListPrompt(prompt);
    // The basket size travels as a band; nothing on the list itself ever does.
    track('list_created', {
      basketItemCount: countBand(list.items.length),
      entryMode: mode === 'paste',
    });
    setOptimizeError(undefined);
    setState((current) => ({
      ...current,
      activeList: list,
      draftPrompt: prompt,
      plans: [],
      selectedPlanId: undefined,
      lastSnapshot: undefined,
    }));
    return list;
  }, []);

  const loadDemoBasket = useCallback(() => {
    setOptimizeError(undefined);
    setState((current) => ({
      ...current,
      activeList: { ...demoList, id: `demo-${Date.now()}`, createdAt: new Date().toISOString() },
      draftPrompt: demoList.prompt,
      plans: [],
      selectedPlanId: undefined,
      lastSnapshot: undefined,
    }));
  }, []);

  const updateListItem = useCallback((itemId: string, patch: Partial<GroceryListItem>) => {
    setState((current) =>
      current.activeList
        ? {
            ...current,
            activeList: {
              ...current.activeList,
              items: current.activeList.items.map((item) =>
                item.id === itemId ? { ...item, ...patch } : item,
              ),
            },
          }
        : current,
    );
  }, []);

  const removeListItem = useCallback((itemId: string) => {
    setState((current) =>
      current.activeList
        ? {
            ...current,
            activeList: {
              ...current.activeList,
              items: current.activeList.items.filter((item) => item.id !== itemId),
            },
          }
        : current,
    );
  }, []);

  /**
   * Adds one hand-typed item.
   *
   * Parsed with the same reader a pasted list uses, so "2 lb tomatoes" typed here
   * behaves exactly as it would pasted. An item already in the basket has its
   * quantity increased rather than appearing twice.
   */
  const addListItem = useCallback((name: string) => {
    const parsed = parseListLine(name);
    if (!parsed) return;
    setState((current) => {
      const list = current.activeList;
      if (!list) return current;

      const existing = list.items.find((item) => item.concept === parsed.concept);
      const items = existing
        ? list.items.map((item) =>
            item.concept === parsed.concept
              ? { ...item, quantity: item.quantity + parsed.quantity }
              : item,
          )
        : [
            ...list.items,
            {
              id: `manual-${Date.now()}`,
              concept: parsed.concept,
              displayName: parsed.displayName,
              quantity: parsed.quantity,
              unit: parsed.unit,
            },
          ];
      return { ...current, activeList: { ...list, items } };
    });
  }, []);

  /**
   * Loads a market snapshot and runs the deterministic optimizer over it.
   *
   * Failures are returned rather than thrown so the search screen can explain
   * what happened instead of silently showing an empty plan list.
   */
  const optimizeActiveList = useCallback(async (): Promise<OptimizeResult> => {
    const list = state.activeList;
    if (!list) return { plans: [] };

    setOptimizing(true);
    setOptimizeError(undefined);
    track('market_search_started', { basketItemCount: countBand(list.items.length) });
    try {
      const snapshot = await loadMarketSnapshot(list, state.preferences);
      // Held so preference changes can re-plan against the same observations.
      snapshotRef.current = snapshot;
      const plans = optimizeBasket({
        list,
        stores: snapshot.stores,
        products: snapshot.products,
        promotions: snapshot.promotions,
        preferences: state.preferences,
      });
      const meta = describeSnapshot(list, snapshot, state.preferences);

      // Emitted where the transition actually happens, not from a screen. The band
      // vocabulary is the only thing that leaves — never a product, a store or an amount.
      track(snapshot.partial === true ? 'market_search_partial' : 'market_search_completed', {
        storeCount: snapshot.stores.length,
        marketMode: snapshot.mode === 'demo' ? 'demo' : 'remote',
      });
      const best = plans.find((plan) => plan.kind === 'recommended') ?? plans[0];
      track('optimization_completed', {
        planCount: plans.length,
        marketCompleteness: best?.completeness.comparisonEligible === true ? 'complete' : 'partial',
        savingsBand: savingsBand(best?.savingsVsBaselineCents ?? 0),
      });
      if (plans.some((plan) => plan.stops.length === 1)) track('single_store_plan_seen');
      if (plans.some((plan) => plan.stops.length > 1)) track('juva_pick_found');

      setState((current) => ({
        ...current,
        plans,
        lastSnapshot: meta,
        selectedPlanId: plans.find((plan) => plan.kind === 'recommended')?.id ?? plans[0]?.id,
      }));

      if (plans.length === 0) {
        const error =
          'No nearby store could supply this whole basket. Try a wider radius or fewer items.';
        // Exceptional, not routine: a market that returned stores and products but no
        // plan at all usually means a matching or data-shape problem worth investigating.
        reportHandled('optimizer.no_plans', {
          storeCount: snapshot.stores.length,
          productCount: snapshot.products.length,
          itemCount: list.items.length,
        });
        setOptimizeError(error);
        return { plans, error };
      }
      return { plans };
    } catch (caught) {
      const error = messageFromError(caught);
      setOptimizeError(error);
      return { plans: [], error };
    } finally {
      setOptimizing(false);
    }
  }, [state.activeList, state.preferences]);

  /**
   * Re-plans against the observations already held, after a preference change.
   *
   * Changing how a shopper wants to shop is not a reason to re-observe prices, so
   * this re-runs the deterministic optimizer over the cached snapshot. That makes
   * the trade-off controls genuinely recompute — the plan set, the ranking and
   * every figure are rebuilt — without a network round trip or any risk of the
   * displayed prices silently changing underneath the comparison.
   */
  const recomputePlans = useCallback(
    (patch: Partial<UserPreferences> = {}): OptimizedPlan[] => {
      const snapshot = snapshotRef.current;
      const list = state.activeList;
      if (!snapshot || !list) return state.plans;

      const preferences = { ...state.preferences, ...patch };
      const plans = optimizeBasket({
        list,
        stores: snapshot.stores,
        products: snapshot.products,
        promotions: snapshot.promotions,
        preferences,
      });
      const meta = describeSnapshot(list, snapshot, preferences);
      // A Worth the Trip adjustment is a real preference change, not a re-render.
      track('worth_trip_changed', { planCount: plans.length });

      setState((current) => ({
        ...current,
        preferences,
        plans,
        lastSnapshot: meta,
        // Keep the shopper on the same kind of plan they were looking at, so a
        // slider nudge does not silently jump them to a different trip.
        selectedPlanId:
          plans.find((plan) => plan.kind === currentKind(current))?.id ??
          plans.find((plan) => plan.kind === 'recommended')?.id ??
          plans[0]?.id,
      }));
      return plans;
    },
    [state.activeList, state.plans, state.preferences],
  );

  /**
   * Applies a brand decision to one line, then re-plans.
   *
   * The updated list is passed to the optimizer directly rather than read back
   * from state, because a `setState` has not committed yet at this point — using
   * stale state would silently plan the previous basket.
   */
  const setItemBrandPolicy = useCallback(
    (groceryItemId: string, policy: BrandPolicy): OptimizedPlan[] => {
      const snapshot = snapshotRef.current;
      const list = state.activeList;
      if (!snapshot || !list) return state.plans;

      const nextList: GroceryList = {
        ...list,
        items: list.items.map((item) =>
          item.id === groceryItemId ? { ...item, brandPolicy: policy } : item,
        ),
      };
      const plans = optimizeBasket({
        list: nextList,
        stores: snapshot.stores,
        products: snapshot.products,
        promotions: snapshot.promotions,
        preferences: state.preferences,
      });
      const meta = describeSnapshot(nextList, snapshot, state.preferences);

      setState((current) => ({
        ...current,
        activeList: nextList,
        plans,
        lastSnapshot: meta,
        selectedPlanId:
          plans.find((plan) => plan.kind === currentKind(current))?.id ??
          plans.find((plan) => plan.kind === 'recommended')?.id ??
          plans[0]?.id,
      }));
      return plans;
    },
    [state.activeList, state.plans, state.preferences],
  );

  const selectPlan = useCallback(
    (selectedPlanId: string) => setState((current) => ({ ...current, selectedPlanId })),
    [],
  );

  const selectedPlan = useMemo(
    () =>
      state.plans.find((plan) => plan.id === state.selectedPlanId) ??
      state.plans.find((plan) => plan.kind === 'recommended') ??
      state.plans[0],
    [state.plans, state.selectedPlanId],
  );

  /**
   * Starts the trip, caching the market snapshot onto it.
   *
   * The snapshot is required rather than optional: without it the trip cannot be
   * replanned in the store, which is the entire point of adaptive Shop Mode. A plan can
   * only be started while the snapshot that produced it is still in hand.
   */
  const startSelectedPlan = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (!selectedPlan || !state.activeList || !snapshot) return false;
    const trip = createTrip(selectedPlan, state.activeList, snapshot);
    track('shop_mode_started', { stopCount: trip.stops.length });
    setState((current) => ({ ...current, activeTrip: trip }));
    return true;
  }, [selectedPlan, state.activeList]);

  const updateTripItem = useCallback(
    (groceryItemId: string, status: TripItemStatus, actualPriceCents?: number) => {
      setState((current) =>
        current.activeTrip
          ? {
              ...current,
              activeTrip: {
                ...current.activeTrip,
                stops: current.activeTrip.stops.map((stop) => ({
                  ...stop,
                  items: stop.items.map((item) =>
                    item.groceryItemId === groceryItemId
                      ? {
                          ...item,
                          status,
                          ...(actualPriceCents === undefined ? {} : { actualPriceCents }),
                        }
                      : item,
                  ),
                })),
              },
            }
          : current,
      );
    },
    [],
  );

  const planShelfChange = useCallback(
    (event: ShopEvent): AdaptDecision | undefined => {
      const trip = state.activeTrip;
      if (!trip) return undefined;
      /**
       * No connectivity claim is made here.
       *
       * Replanning reads only `trip.market`, cached on the trip, and issues no request of
       * any kind. Juva has no connectivity detection, so the adaptation records what it
       * can assert — `usedCachedMarket` and `networkRequired` — rather than a guess about
       * whether the device had signal.
       */
      const decision = adaptTrip({ trip, event, preferences: state.preferences });
      if (!decision) {
        // The replanner could not produce any option for a line the shopper is looking
        // at. Only ids and counts travel.
        reportHandled('shop.adaptation_failed', {
          tripId: trip.id,
          eventKind: event.kind,
          stopIndex: trip.currentStopIndex,
        });
      }
      return decision;
    },
    [state.activeTrip, state.preferences],
  );

  const applyShelfChange = useCallback((decision: AdaptDecision, chosenOptionId: string) => {
    setState((current) => {
      if (!current.activeTrip) return current;
      const applied = applyAdaptation({
        trip: current.activeTrip,
        decision,
        chosenOptionId,
      });
      return applied ? { ...current, activeTrip: applied.trip } : current;
    });
  }, []);

  const advanceTripStop = useCallback(() => {
    setState((current) =>
      current.activeTrip
        ? {
            ...current,
            activeTrip: {
              ...current.activeTrip,
              currentStopIndex: Math.min(
                current.activeTrip.currentStopIndex + 1,
                current.activeTrip.stops.length - 1,
              ),
            },
          }
        : current,
    );
  }, []);

  /**
   * Marks the trip finished and, if the shopper opted in, schedules the one
   * reminder Juva can honestly deliver: verify this trip's receipt.
   *
   * Scheduling is fire-and-forget. A device that refuses the notification must
   * not block the shopper from reaching the verify screen.
   */
  const completeTrip = useCallback(() => {
    const storeName =
      state.activeTrip?.stops[state.activeTrip.currentStopIndex]?.store.retailerName ??
      state.activeTrip?.stops[0]?.store.retailerName;

    if (state.preferences.receiptRemindersEnabled && storeName) {
      void scheduleReceiptReminder({
        storeName,
        afterMinutes: state.preferences.receiptReminderMinutes,
      });
    }

    track('shop_trip_completed');
    setState((current) =>
      current.activeTrip
        ? {
            ...current,
            activeTrip: { ...current.activeTrip, completedAt: new Date().toISOString() },
          }
        : current,
    );
  }, [state.activeTrip, state.preferences]);

  /**
   * Records a receipt for a stop, replacing any earlier one for the same store.
   * Identity and capture time are stamped here rather than at the call site, so
   * screens stay free of clock reads and every receipt is stamped one way.
   */
  const addReceipt = useCallback(
    (receipt: NewReceipt) =>
      setState((current) => {
        // Replacing a stop's receipt orphans the previous images, so they go now.
        const replaced = current.receipts.filter((entry) => entry.storeId === receipt.storeId);
        const orphaned = replaced.flatMap((entry) => entry.imageUris);
        if (orphaned.length > 0) void deletePages(orphaned);
        return {
          ...current,
          receipts: [
            { ...receipt, id: `receipt-${Date.now()}`, capturedAt: new Date().toISOString() },
            ...current.receipts.filter((entry) => entry.storeId !== receipt.storeId),
          ],
        };
      }),
    [],
  );

  const removeReceipt = useCallback(
    (storeId: string) =>
      setState((current) => {
        const going = current.receipts.filter((entry) => entry.storeId === storeId);
        const uris = going.flatMap((entry) => entry.imageUris);
        if (uris.length > 0) void deletePages(uris);
        return {
          ...current,
          receipts: current.receipts.filter((entry) => entry.storeId !== storeId),
        };
      }),
    [],
  );

  /**
   * Deletes the images and records that it happened.
   *
   * The figures already read from the receipt are kept — deleting a photograph is
   * not a request to un-verify a trip — and `imagesDeletedAt` is what lets the UI
   * say so rather than looking like the images were lost.
   */
  const deleteReceiptImages = useCallback(
    (receiptId: string) =>
      setState((current) => {
        const target = current.receipts.find((entry) => entry.id === receiptId);
        if (!target || target.imageUris.length === 0) return current;
        void deletePages(target.imageUris);
        return {
          ...current,
          receipts: current.receipts.map((entry) =>
            entry.id === receiptId
              ? { ...entry, imageUris: [], imagesDeletedAt: new Date().toISOString() }
              : entry,
          ),
        };
      }),
    [],
  );

  const deleteAllReceiptImages = useCallback(async () => {
    await purgeAllPages();
    const deletedAt = new Date().toISOString();
    setState((current) => ({
      ...current,
      receipts: current.receipts.map((entry) =>
        entry.imageUris.length === 0
          ? entry
          : { ...entry, imageUris: [], imagesDeletedAt: deletedAt },
      ),
    }));
  }, []);

  /**
   * The reconciliation as it currently stands.
   *
   * Pure and cheap, so the verify screen can re-run it on every decision the
   * shopper makes and always show figures that match what verifying would record.
   */
  const reconcileActiveTrip = useCallback(
    (confirmations: readonly MatchConfirmation[] = []) =>
      state.activeTrip ? reconcileTrip(state.activeTrip, state.receipts, confirmations) : undefined,
    [state.activeTrip, state.receipts],
  );

  /**
   * The ledger for the active trip.
   *
   * Derived, never stored: a persisted ledger could disagree with the trip it came from,
   * and the one thing this layer exists to guarantee is that the chain adds up.
   */
  const activeLedger = useMemo((): SavingsLedger | undefined => {
    const trip = state.activeTrip;
    if (!trip || !selectedPlan) return undefined;
    return buildLedger({
      trip,
      plan: selectedPlan,
      receipts: state.receipts,
      currency: state.activeList?.currency ?? 'USD',
      corrections: state.corrections ?? [],
    });
  }, [state.activeTrip, state.receipts, state.corrections, state.activeList, selectedPlan]);

  /** Origin integrity, checked before a ledger is written. */
  const ledger0Ok = (trip: ShoppingTrip): boolean =>
    originFingerprint(trip.origin) === trip.origin.fingerprint;

  const ledgerHistory = useMemo(() => readableLedgers(state.ledgers ?? []), [state.ledgers]);

  const addCorrection = useCallback((correction: ReconciliationCorrection) => {
    // Append-only, and kept apart from `activeTrip.adaptations`, which is the record of
    // what was decided *in* the shop and must stay exactly as it happened.
    setState((current) => ({
      ...current,
      corrections: [...(current.corrections ?? []), correction],
    }));
  }, []);

  const verifyActiveTrip = useCallback(
    (confirmations: readonly MatchConfirmation[] = []) => {
      const trip = state.activeTrip;
      if (!trip || !selectedPlan) return undefined;
      // The reminder has served its purpose; leaving it pending would nag about a
      // trip the shopper already verified.
      void cancelReceiptReminder();
      const record = verifyTrip(
        trip,
        selectedPlan,
        state.receipts,
        state.activeList?.currency ?? 'USD',
        confirmations,
      );
      /**
       * Freeze the ledger alongside the record.
       *
       * The record carries the headline figures; the ledger carries the whole chain and
       * the reasoning. Both are written once, here, and never recomputed — reopening this
       * trip in six months must show what it showed today, not what today's engine would
       * make of the same inputs.
       */
      if (!ledger0Ok(trip)) {
        /**
         * The most serious failure Juva can have.
         *
         * A trip whose economic origin no longer matches its own fingerprint means
         * something wrote to the immutable baseline. Only the trip id and the two
         * fingerprints travel — never a basket, a price or a store.
         */
        reportHandled('trip.origin_integrity_mismatch', {
          tripId: trip.id,
          expectedFingerprint: trip.origin.fingerprint,
          actualFingerprint: originFingerprint(trip.origin),
        });
      }

      const ledger = buildLedger({
        trip,
        plan: selectedPlan,
        receipts: state.receipts,
        currency: state.activeList?.currency ?? 'USD',
        confirmations,
        corrections: state.corrections ?? [],
      });
      const frozen = persistLedger(
        ledger,
        trip.stops.map((stop) => stop.store.retailerName),
      );

      /**
       * The verification outcome, reported as what it actually was.
       *
       * `verificationEventFor` keeps verified, blocked and integrity-failed as three
       * separate events — collapsing them would make the verification rate look better
       * than it is, which is precisely the number nobody should be able to flatter.
       */
      // Reconciliation that produced no line at all against a trip that has items is a
      // failure, not a product state.
      if (ledger.lines.length === 0 && trip.stops.some((stop) => stop.items.length > 0)) {
        reportHandled('receipt.reconciliation_failed', { tripId: trip.id });
      }

      track(verificationEventFor(ledger.claimability.state), {
        verificationState: ledger.claimability.state,
        blockerCount: ledger.claimability.blockers.length,
      });
      if (ledger.claimability.state === 'verified') {
        track('verified_savings_created', {
          savingsBand: savingsBand(ledger.verifiedSavingsCents ?? 0),
        });
      }

      setState((current) => ({
        ...current,
        savingsRecords: [record, ...current.savingsRecords],
        ledgers: [...(current.ledgers ?? []), frozen],
      }));
      return record;
    },
    [selectedPlan, state.activeList?.currency, state.activeTrip, state.receipts, state.corrections],
  );

  const saveActiveList = useCallback(() => {
    setState((current) => {
      const list = current.activeList;
      if (!list) return current;
      return {
        ...current,
        savedLists: [
          { ...list, recurring: true },
          ...current.savedLists.filter((entry) => entry.id !== list.id),
        ],
      };
    });
  }, []);

  /**
   * Re-runs a saved basket.
   *
   * The saved items are copied into a fresh list with a new id and timestamp
   * rather than reused in place, so re-running last week's shop cannot overwrite
   * the record of it. Prices are deliberately not carried over: the basket is
   * re-priced against today's market, because a week-old price is not today's.
   */
  const rerunSavedList = useCallback(
    (listId: string): GroceryList | undefined => {
      const saved = state.savedLists.find((entry) => entry.id === listId);
      if (!saved) return undefined;

      const fresh: GroceryList = {
        ...saved,
        id: `rerun-${Date.now()}`,
        createdAt: new Date().toISOString(),
        items: saved.items.map((item, index) => ({ ...item, id: `rerun-${Date.now()}-${index}` })),
      };
      setOptimizeError(undefined);
      snapshotRef.current = undefined;
      setState((current) => ({
        ...current,
        activeList: fresh,
        draftPrompt: fresh.prompt,
        plans: [],
        selectedPlanId: undefined,
        lastSnapshot: undefined,
      }));
      return fresh;
    },
    [state.savedLists],
  );

  const removeSavedList = useCallback((listId: string) => {
    setState((current) => ({
      ...current,
      savedLists: current.savedLists.filter((entry) => entry.id !== listId),
    }));
  }, []);

  const clearAll = useCallback(async () => {
    writerRef.current.cancel();
    setState(initialState);
    await clearJuvaState();
  }, []);

  /**
   * Push identity and journey tags.
   *
   * All three calls no-op unless OneSignal is configured *and* the native module is
   * present, so this is inert in Expo Go and in any build without an app id. The tags
   * are the only thing Juva sends: a closed vocabulary of counts and coarse states, so
   * a campaign can be targeted without OneSignal learning what anyone bought.
   *
   * The id is the same anonymous UUID RevenueCat uses, so a subscription and a device
   * are the same person without either service being told who that is.
   */
  useEffect(() => {
    if (!hydrated) return;
    initPush();
    void getOrCreateAppUserId()
      .then(identifyForPush)
      .catch(() => undefined);
  }, [hydrated]);

  /**
   * Offers each candidate lifecycle message to the deterministic rules.
   *
   * Runs on hydration and on foreground rather than on every state change: these are
   * "you left something unfinished" messages, and the moment worth checking is when the
   * shopper comes back, not the moment they act. `evaluateJourney` applies the caps and
   * refuses outright when nothing can be delivered, so this loop cannot spend a cap on a
   * message that was never sent.
   *
   * Candidates are offered in order and the history is threaded through, so the weekly cap
   * and the minimum gap apply *across* them within a single pass — otherwise four things
   * changing at once would produce four messages.
   */
  const evaluateJourneys = useCallback(() => {
    setState((current) => {
      const unverified = current.savingsRecords.find((record) => !record.receiptConfirmed);
      // The budget belongs to the basket the shopper asked for, not to preferences.
      const budget = current.activeList?.budgetCents;
      const cheapestPlan = current.plans.reduce<number | undefined>(
        (best, plan) =>
          best === undefined ? plan.basketCostCents : Math.min(best, plan.basketCostCents),
        undefined,
      );

      const sources: JourneySources = {
        // A plan that was selected but never shopped.
        ...(current.selectedPlanId !== undefined && current.activeTrip === undefined
          ? { pendingPlanId: current.selectedPlanId }
          : {}),
        // A finished trip whose receipts were never confirmed.
        ...(unverified === undefined ? {} : { unverifiedTripId: unverified.tripId }),
        // A basket that now fits a budget it previously did not.
        ...(budget !== undefined &&
        cheapestPlan !== undefined &&
        cheapestPlan < budget &&
        current.activeList !== undefined
          ? {
              underBudgetListId: current.activeList.id,
              underBudgetByCents: budget - cheapestPlan,
            }
          : {}),
      };

      let history = current.journeyHistory;
      let changed = false;
      for (const candidate of journeyCandidates(sources)) {
        const outcome = evaluateJourney(candidate, history);
        if (outcome.delivered) {
          history = outcome.history;
          changed = true;
        }
      }
      return changed ? { ...current, journeyHistory: history } : current;
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    /**
     * Deferred a tick rather than called inline.
     *
     * A synchronous `setState` here would force an extra render before the first paint,
     * which `react-hooks/set-state-in-effect` correctly objects to — and nothing about a
     * "you left something unfinished" message needs to be decided during mount.
     */
    const initial = setTimeout(evaluateJourneys, 0);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') evaluateJourneys();
    });
    return () => {
      clearTimeout(initial);
      subscription.remove();
    };
  }, [hydrated, evaluateJourneys]);

  useEffect(() => {
    if (!hydrated) return;
    syncJourneyTags({
      tier: 'free',
      tripPending: state.activeTrip !== undefined,
      receiptPending:
        state.activeTrip !== undefined && state.receipts.length < state.activeTrip.stops.length,
      savedListCount: state.savedLists.length,
      verifiedTripCount: state.savingsRecords.filter((record) => record.receiptConfirmed).length,
    });
  }, [
    hydrated,
    state.activeTrip,
    state.receipts.length,
    state.savedLists.length,
    state.savingsRecords,
  ]);

  const value = useMemo<ContextValue>(
    () => ({
      ...state,
      hydrated,
      optimizing,
      ...(optimizeError === undefined ? {} : { optimizeError }),
      setDraftPrompt,
      updatePreferences,
      completeOnboarding,
      createListFromPrompt,
      loadDemoBasket,
      updateListItem,
      removeListItem,
      addListItem,
      optimizeActiveList,
      recomputePlans,
      setItemBrandPolicy,
      activeLedger,
      ledgerHistory,
      addCorrection,
      planShelfChange,
      applyShelfChange,
      selectPlan,
      selectedPlan,
      startSelectedPlan,
      updateTripItem,
      advanceTripStop,
      completeTrip,
      addReceipt,
      removeReceipt,
      deleteReceiptImages,
      deleteAllReceiptImages,
      reconcileActiveTrip,
      verifyActiveTrip,
      saveActiveList,
      rerunSavedList,
      removeSavedList,
      clearAll,
    }),
    [
      state,
      hydrated,
      optimizing,
      optimizeError,
      setDraftPrompt,
      updatePreferences,
      completeOnboarding,
      createListFromPrompt,
      loadDemoBasket,
      updateListItem,
      removeListItem,
      addListItem,
      optimizeActiveList,
      recomputePlans,
      setItemBrandPolicy,
      activeLedger,
      ledgerHistory,
      addCorrection,
      planShelfChange,
      applyShelfChange,
      selectPlan,
      selectedPlan,
      startSelectedPlan,
      updateTripItem,
      advanceTripStop,
      completeTrip,
      addReceipt,
      removeReceipt,
      deleteReceiptImages,
      deleteAllReceiptImages,
      reconcileActiveTrip,
      verifyActiveTrip,
      saveActiveList,
      rerunSavedList,
      removeSavedList,
      clearAll,
    ],
  );

  return <JuvaContext.Provider value={value}>{children}</JuvaContext.Provider>;
}

export function useJuva(): ContextValue {
  const value = useContext(JuvaContext);
  if (!value) throw new Error('useJuva must be used inside JuvaProvider.');
  return value;
}
