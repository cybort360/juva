/**
 * The one place Juva decides whether a shopper has Plus.
 *
 * Before this, `hasPlus`, `status`, `entitlementIsCached` and `error` were four separate
 * facts that every screen combined for itself — which is how one surface ends up showing
 * a paywall while another shows Plus features, and how a billing outage gets rendered as
 * "you are on the free plan". The state below is derived once, from RevenueCat's own
 * answer, and screens read it rather than reconstruct it.
 *
 * The distinction that matters most is `billing_unavailable` versus `free`. A shopper
 * whose entitlement Juva could not check has not been downgraded — Juva simply does not
 * know — and telling them otherwise is both wrong and, for someone who has paid,
 * insulting.
 */

export type SubscriptionState =
  /** No answer yet. The first frame after launch, before RevenueCat replies. */
  | 'unknown'
  /** RevenueCat answered, and `juva_plus` is not active. */
  | 'free'
  /** RevenueCat answered, and `juva_plus` is active. */
  | 'plus'
  /** A purchase is awaiting the store — deferred payment, parental approval. */
  | 'purchase_pending'
  /** Plus, granted from the last live answer because this one could not be obtained. */
  | 'offline_cached_plus'
  /** Billing could not be reached and there is no cached grant. Entitlement is unknown. */
  | 'billing_unavailable';

export interface SubscriptionInputs {
  /** True once RevenueCat has been configured with a usable key. */
  readonly configured: boolean;
  /** True while the first CustomerInfo is still outstanding. */
  readonly loading: boolean;
  /** True when a configuration or fetch error is outstanding. */
  readonly failed: boolean;
  /** Whether RevenueCat's live CustomerInfo reports `juva_plus` active. */
  readonly liveEntitlementActive: boolean | undefined;
  /** The last live answer, read from disk. Undefined when nothing was ever cached. */
  readonly cachedEntitlementActive: boolean | undefined;
  /** True while a purchase is awaiting the store. */
  readonly purchasePending: boolean;
}

/**
 * Derives the canonical state.
 *
 * Order matters. A pending purchase outranks everything because it is the most
 * actionable thing on screen; a live answer outranks a cached one because it is current;
 * and a cache may only ever *grant* Plus, never revoke it — a cached `false` is not
 * evidence that a subscription lapsed, only that it had not started when we last looked.
 */
export function subscriptionState(inputs: SubscriptionInputs): SubscriptionState {
  if (inputs.purchasePending) return 'purchase_pending';

  if (inputs.liveEntitlementActive !== undefined) {
    return inputs.liveEntitlementActive ? 'plus' : 'free';
  }

  // No live answer. A previous positive one stands in.
  if (inputs.cachedEntitlementActive === true) return 'offline_cached_plus';

  // Still waiting on the first reply, and nothing cached to fall back on.
  if (inputs.loading && !inputs.failed) return 'unknown';

  /**
   * Purchases are switched off in this build — no key, or a key the environment
   * refused. That is a known configuration, not a billing outage, and the shopper is
   * genuinely on the free tier because there is no way for them to buy anything.
   */
  if (!inputs.configured && !inputs.failed) return 'free';

  return 'billing_unavailable';
}

/**
 * Whether Plus features should be unlocked.
 *
 * Cached Plus counts: someone who paid should not lose multi-store planning on a train.
 * `billing_unavailable` deliberately does not — granting Plus to an unknown entitlement
 * would make an outage the cheapest way to get it.
 */
export function grantsPlus(state: SubscriptionState): boolean {
  return state === 'plus' || state === 'offline_cached_plus';
}

/**
 * Whether Juva may offer a purchase right now.
 *
 * Not while the answer is unknown — a paywall shown to an existing subscriber because
 * their entitlement had not loaded is the worst version of this screen.
 */
export function canOfferPurchase(state: SubscriptionState): boolean {
  return state === 'free';
}

/** What the shopper is told about their subscription, in their words. */
export function describeSubscription(state: SubscriptionState): string {
  switch (state) {
    case 'unknown':
      return 'Checking your subscription…';
    case 'free':
      return 'You are on the free plan.';
    case 'plus':
      return 'Juva Plus is active.';
    case 'purchase_pending':
      return 'Your purchase is waiting on the store. Juva will unlock Plus as soon as it clears.';
    case 'offline_cached_plus':
      return 'Juva Plus is active, from your last check. Juva could not reach the store just now.';
    case 'billing_unavailable':
      return 'Juva could not reach the store to check your subscription. Your shopping is unaffected.';
  }
}
