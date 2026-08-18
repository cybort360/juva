import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState } from 'react-native';
import Purchases, {
  type CustomerInfo,
  type PurchasesEntitlementInfo,
  type PurchasesOffering,
  type PurchasesPackage,
  PURCHASES_ERROR_CODE,
} from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';

import { grantsPlus, subscriptionState, type SubscriptionState } from '@/domain/subscription';
import { reportHandled } from '@/services/monitoring';
import { configureRevenueCat, JUVA_PLUS_ENTITLEMENT } from '@/services/revenuecat';
import { messageFromError } from '@/utils/errors';

type RevenueCatStatus = 'loading' | 'ready' | 'disabled' | 'error';

/**
 * `pending` is a real outcome, not an error.
 *
 * Deferred payments exist — Play's slow card checks, iOS Ask to Buy — and the shopper
 * has done nothing wrong. Treating it as a failure would tell them their purchase
 * broke; treating it as success would grant Plus for money that may never arrive.
 */
type PurchaseOutcome = 'success' | 'pending' | 'cancelled' | 'failed';

interface RevenueCatContextValue {
  status: RevenueCatStatus;
  /** The canonical application-facing subscription state. Screens read this. */
  subscription: SubscriptionState;
  error?: string | undefined;
  offering?: PurchasesOffering | undefined;
  packages: PurchasesPackage[];
  customerInfo?: CustomerInfo | undefined;
  hasPlus: boolean;
  /** The live Juva Plus entitlement, when one is active. */
  plusEntitlement?: PurchasesEntitlementInfo | undefined;
  /**
   * The store's own subscription-management page for this purchase. Cancellation
   * and plan changes happen in the store, never in Juva, so this is a link out
   * rather than something Juva pretends to control.
   */
  managementUrl?: string | undefined;
  purchase: (pkg: PurchasesPackage) => Promise<PurchaseOutcome>;
  restore: () => Promise<boolean>;
  refresh: () => Promise<void>;
  /**
   * Opens RevenueCat's Customer Center, which handles cancellation, plan changes,
   * refunds and subscription history in the store's own terms.
   */
  openCustomerCenter: () => Promise<void>;
  /** True when `hasPlus` came from disk rather than a live check. */
  entitlementIsCached: boolean;
  /** Whether Customer Center can actually be shown on this build. */
  customerCenterAvailable: boolean;
}

/**
 * The last known entitlement, cached on disk.
 *
 * A subscriber who opens Juva on a train must not be silently downgraded to Free
 * because the entitlement check failed. So the last positive answer is trusted until a
 * live check contradicts it. The cache can only ever *grant* what was already paid
 * for — it is written from a real CustomerInfo and never from a local assumption.
 */
const ENTITLEMENT_CACHE_KEY = 'juva.entitlement.v1';

interface CachedEntitlement {
  hasPlus: boolean;
  /** ISO timestamp of the live check this came from. */
  checkedAt: string;
}

const RevenueCatContext = createContext<RevenueCatContextValue | null>(null);

export function RevenueCatProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<RevenueCatStatus>('loading');
  const [error, setError] = useState<string>();
  const [offering, setOffering] = useState<PurchasesOffering>();
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>();
  const [cachedPlus, setCachedPlus] = useState<boolean>();
  /**
   * A purchase awaiting the store.
   *
   * Held here rather than returned only to the caller, because the canonical state has
   * to report it: a shopper with Ask to Buy pending should see "waiting on the store"
   * everywhere, not "free" on one screen and a spinner on another.
   */
  const [purchasePending, setPurchasePending] = useState(false);

  /** Persists a live answer so an offline launch is not a silent downgrade. */
  const cacheEntitlement = useCallback(async (info: CustomerInfo) => {
    const payload: CachedEntitlement = {
      hasPlus: Boolean(info.entitlements.active[JUVA_PLUS_ENTITLEMENT]),
      checkedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(payload)).catch(
      () => undefined,
    );
  }, []);

  const refresh = useCallback(async () => {
    const [offerings, info] = await Promise.all([
      Purchases.getOfferings(),
      Purchases.getCustomerInfo(),
    ]);
    setOffering(offerings.current ?? undefined);
    setCustomerInfo(info);
    await cacheEntitlement(info);
  }, [cacheEntitlement]);

  useEffect(() => {
    let active = true;
    const customerInfoListener = (info: CustomerInfo) => {
      setCustomerInfo(info);
      void cacheEntitlement(info);
    };
    let listenerAdded = false;

    /**
     * Purchases are optional infrastructure: an unconfigured key, a missing
     * native module, or no network must all leave the rest of Juva usable.
     * Configuration and the first offerings fetch are therefore guarded
     * separately, so a failed network call still leaves the SDK wired up.
     */
    /**
     * Read the cached entitlement first.
     *
     * This runs before configuration so a subscriber sees Plus immediately on a cold,
     * offline launch rather than a flash of Free while the store is contacted.
     */
    const loadCache = async (): Promise<void> => {
      try {
        const raw = await AsyncStorage.getItem(ENTITLEMENT_CACHE_KEY);
        if (!raw || !active) return;
        const parsed = JSON.parse(raw) as CachedEntitlement;
        if (typeof parsed.hasPlus === 'boolean') setCachedPlus(parsed.hasPlus);
      } catch {
        // A corrupt cache is simply no cache.
      }
    };

    const start = async (): Promise<void> => {
      await loadCache();
      let setup: Awaited<ReturnType<typeof configureRevenueCat>>;
      try {
        setup = await configureRevenueCat();
      } catch (caught) {
        if (!active) return;
        setError(messageFromError(caught));
        reportHandled('revenuecat.init_failed');
        setStatus('error');
        return;
      }

      if (!active) return;
      if (setup === 'disabled') {
        setStatus('disabled');
        return;
      }

      Purchases.addCustomerInfoUpdateListener(customerInfoListener);
      listenerAdded = true;

      try {
        await refresh();
        if (active) setStatus('ready');
      } catch (caught) {
        if (!active) return;
        setError(messageFromError(caught));
        setStatus('error');
      }
    };

    void start();

    return () => {
      active = false;
      if (listenerAdded) Purchases.removeCustomerInfoUpdateListener(customerInfoListener);
    };
  }, [refresh, cacheEntitlement]);

  /**
   * Re-checks the entitlement when the app returns to the foreground.
   *
   * A subscription can lapse, be cancelled or be refunded entirely outside Juva, and
   * the customer-info listener only fires while the app is running. Without this, a
   * subscriber who cancelled yesterday could keep Plus until the next cold start.
   */
  useEffect(() => {
    if (status !== 'ready') return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [status, refresh]);

  const purchase = useCallback(async (pkg: PurchasesPackage): Promise<PurchaseOutcome> => {
    try {
      const result = await Purchases.purchasePackage(pkg);
      setCustomerInfo(result.customerInfo);
      return 'success';
    } catch (caught) {
      const purchaseError = caught as { code?: string; userCancelled?: boolean };
      if (
        purchaseError.userCancelled ||
        purchaseError.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
      ) {
        return 'cancelled';
      }
      /**
       * A deferred payment is not a failure.
       *
       * Ask to Buy and slow card authorisation both land here. Plus is deliberately
       * *not* granted — the entitlement arrives through the customer-info listener if
       * and when the payment clears.
       */
      if (purchaseError.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
        setPurchasePending(true);
        return 'pending';
      }
      // A genuine billing failure. A cancellation is *not* routed here — it is an
      // expected outcome and must never become an issue in Sentry.
      reportHandled('revenuecat.purchase_failed', {
        code: String(purchaseError.code ?? 'unknown'),
      });
      setError(messageFromError(caught));
      return 'failed';
    }
  }, []);

  /**
   * Customer Center.
   *
   * Cancellation, plan changes and refund requests all live here, presented by
   * RevenueCat in the store's own terms. Juva does not reimplement any of it — an app
   * that appeared to cancel a subscription it cannot cancel would be lying about
   * someone's money.
   */
  const openCustomerCenter = useCallback(async () => {
    try {
      await RevenueCatUI.presentCustomerCenter();
      // The visit may have changed things, so re-read rather than assume.
      await refresh();
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }, [refresh]);

  const restore = useCallback(async () => {
    try {
      const info = await Purchases.restorePurchases();
      setCustomerInfo(info);
      return Boolean(info.entitlements.active[JUVA_PLUS_ENTITLEMENT]);
    } catch (caught) {
      setError(messageFromError(caught));
      return false;
    }
  }, []);

  const packages = useMemo(
    () =>
      (offering?.availablePackages ?? []).filter((pkg) =>
        ['$rc_monthly', '$rc_annual'].includes(pkg.identifier),
      ),
    [offering],
  );

  /**
   * CustomerInfo → SubscriptionState.
   *
   * A live answer settles it either way; a cached *positive* stands in when there is no
   * live answer; a cached negative settles nothing. `billing_unavailable` is deliberately
   * distinct from `free` — a shopper Juva could not check has not been downgraded.
   */
  const state = useMemo(
    () =>
      subscriptionState({
        configured: status !== 'disabled',
        loading: status === 'loading',
        failed: status === 'error',
        liveEntitlementActive:
          customerInfo === undefined
            ? undefined
            : Boolean(customerInfo.entitlements.active[JUVA_PLUS_ENTITLEMENT]),
        cachedEntitlementActive: cachedPlus,
        purchasePending,
      }),
    [status, customerInfo, cachedPlus, purchasePending],
  );

  const value = useMemo<RevenueCatContextValue>(
    () => ({
      status,
      error,
      offering,
      packages,
      customerInfo,
      /**
       * The canonical state, derived once from RevenueCat's own answer.
       *
       * This is the only place entitlement is decided. Screens read `subscription` (or
       * the derived `hasPlus` below) and never inspect `customerInfo` themselves —
       * `tests/subscriptionWiring.test.ts` enforces that with a repository grep.
       */
      subscription: state,
      /**
       * Derived, never stored.
       *
       * Kept for the screens that only need a boolean, but computed from the canonical
       * state rather than maintained alongside it, so there is exactly one truth source.
       * @deprecated Prefer `subscription` and `grantsPlus`.
       */
      hasPlus: grantsPlus(state),
      entitlementIsCached: state === 'offline_cached_plus',
      customerCenterAvailable: status === 'ready',
      openCustomerCenter,
      plusEntitlement: customerInfo?.entitlements.active[JUVA_PLUS_ENTITLEMENT],
      ...(customerInfo?.managementURL == null ? {} : { managementUrl: customerInfo.managementURL }),
      purchase,
      restore,
      refresh,
    }),
    [
      status,
      error,
      offering,
      packages,
      customerInfo,
      state,
      purchase,
      restore,
      refresh,
      openCustomerCenter,
    ],
  );

  return <RevenueCatContext.Provider value={value}>{children}</RevenueCatContext.Provider>;
}

export function useRevenueCat(): RevenueCatContextValue {
  const value = useContext(RevenueCatContext);
  if (!value) throw new Error('useRevenueCat must be used inside RevenueCatProvider.');
  return value;
}
