import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { savingsBand } from '@/domain/analytics';
import { paywallValueContext, paywallValueIsSound } from '@/domain/paywallValue';
import { grantsPlus } from '@/domain/subscription';
import { track } from '@/services/analytics';
import { useJuva } from '@/state/JuvaProvider';
import { useRevenueCat } from '@/state/RevenueCatProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

const features = [
  [
    'Multi-store optimization',
    'See the plan Juva actually recommends, not only the cheapest single store.',
  ],
  ['Worth-the-trip engine', 'Balance basket price against time, distance and extra stops.'],
  [
    'Unlimited baskets and searches',
    'Keep as many recurring baskets as you like, and re-plan freely.',
  ],
  ['Full verified savings history', 'Keep receipt-verified savings separate from projections.'],
  ['Smart substitutions', 'Find acceptable alternatives when a switch saves enough to matter.'],
];

/**
 * Named here rather than sold above.
 *
 * Background price alerts are built but not yet delivered end to end: nothing computes
 * a saved basket getting cheaper, and no campaign exists to send it. Listing it as a
 * paid feature would be charging for something that does not run, so it is stated as
 * planned instead — and it stays here, visible, until it actually works.
 */
const NOT_YET = 'Background price alerts are not live yet. Nothing is charged for them.';

export default function PaywallScreen() {
  const { plans } = useJuva();
  const { status, error, packages, subscription, purchase, restore } = useRevenueCat();
  const hasPlus = grantsPlus(subscription);
  const [busyPackage, setBusyPackage] = useState<string>();
  const [message, setMessage] = useState<string>();

  const buy = async (pkg: PurchasesPackage) => {
    setBusyPackage(pkg.identifier);
    setMessage(undefined);
    const packageKind = pkg.identifier === '$rc_annual' ? 'annual' : 'monthly';
    track('purchase_started', { packageKind });

    const outcome = await purchase(pkg);
    setBusyPackage(undefined);

    // Four distinct outcomes, reported as four distinct events. A cancellation is not a
    // failure and must never be counted as one.
    if (outcome === 'success') track('purchase_completed', { packageKind });
    else if (outcome === 'cancelled') track('purchase_cancelled', { packageKind });
    else if (outcome === 'failed') track('purchase_failed', { packageKind });

    if (outcome === 'success') setMessage('Juva Plus is active.');
    else if (outcome === 'cancelled') setMessage('Purchase cancelled. Nothing was charged.');
    else if (outcome === 'pending') {
      /**
       * A deferred payment, not a failure.
       *
       * Ask to Buy and slow card authorisation both land here. Telling the shopper their
       * purchase failed would be wrong twice over: they did nothing wrong, and the payment
       * may still complete — at which point Plus arrives on its own through the
       * customer-info listener.
       */
      setMessage(
        'Your purchase is waiting on approval from your store. Juva Plus will unlock by itself once it clears — there is nothing else to do, and you have not been charged twice.',
      );
    } else {
      setMessage('Purchase failed. Nothing was charged. Check the store and try again.');
    }
  };

  /**
   * The paywall's evidence, or nothing.
   *
   * Computed in the domain and only rendered when `paywallValueIsSound` agrees the figure
   * follows from its own inputs — a context that somehow arrived inconsistent is treated
   * as no context at all rather than shown.
   */
  const valueResult = paywallValueContext({ plans, hasPlus });
  const value =
    'context' in valueResult && paywallValueIsSound(valueResult.context)
      ? valueResult.context
      : undefined;

  /**
   * The paywall impression, with whether it carried a personalized claim.
   *
   * `paywall_value_context_present` is what makes the conversion rate honest: a neutral
   * paywall shown because the market was partial is not a missed conversion, and counting
   * it as one would create pressure to loosen the honesty gates.
   */
  useEffect(() => {
    track('paywall_seen', { subscriptionState: subscription });
    if (value) {
      track('paywall_value_context_present', {
        savingsBand: savingsBand(value.potentialSavingsCents),
        additionalStops: value.additionalStops,
      });
    }
    // Once per mount: a re-render is not a second impression.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restoreAccess = async () => {
    setMessage(undefined);
    track('restore_started');
    const restored = await restore();
    track('restore_completed', { restoredPlus: restored });
    setMessage(restored ? 'Juva Plus restored.' : 'No active Juva Plus purchase was found.');
  };

  return (
    <AppScreen>
      <TopBar back title="Juva Plus" eyebrow="UNLOCK THE FULL OPTIMIZER" />
      <Surface signal style={styles.hero}>
        <Text style={styles.heroLabel}>{hasPlus ? 'PLUS ACTIVE' : 'JUVA FOUND MORE'}</Text>
        {/*
          The personalized claim renders only when the evidence object exists, and it
          renders that object's own figures. When Juva cannot justify a number — a partial
          market, no valid baseline, low confidence — the copy is neutral rather than
          smaller. There is no example value in real mode.
        */}
        <Text style={styles.heroTitle}>
          {hasPlus
            ? 'You have the full Juva engine.'
            : value
              ? `Juva found another ${formatMoney(value.potentialSavingsCents, 'USD')}.`
              : 'Turn price comparison into a shopping plan.'}
        </Text>
        <Text style={styles.heroCopy}>
          {value
            ? `${formatMoney(value.baselineCostCents, 'USD')} at the best single store, ${formatMoney(value.lockedPlanCostCents, 'USD')} across ${value.additionalStops + 1} stores — about ${value.additionalTravelMinutes} minutes more.`
            : 'The free plan proves the single-store basket. Plus unlocks the multi-store and recurring intelligence around it.'}
        </Text>
      </Surface>

      <Surface>
        {features.map(([title, copy]) => (
          <View key={title} style={styles.feature}>
            <View style={styles.check}>
              <Text style={styles.checkText}>✓</Text>
            </View>
            <View style={styles.featureText}>
              <Text style={styles.featureTitle}>{title}</Text>
              <Text style={styles.featureCopy}>{copy}</Text>
            </View>
          </View>
        ))}
        {/* Stated plainly on the paywall itself, where the decision is being made. */}
        <Text style={styles.notYet}>{NOT_YET}</Text>
      </Surface>

      {status === 'disabled' ? (
        <Surface>
          <Text style={styles.stateTitle}>
            RevenueCat Test Store is not configured on this device.
          </Text>
          <Text style={styles.stateCopy}>
            Add EXPO_PUBLIC_REVENUECAT_TEST_API_KEY to .env and restart the development build. The
            rest of Juva remains usable without purchases configured.
          </Text>
        </Surface>
      ) : null}

      {status === 'error' || error ? (
        <Surface>
          <Text style={styles.error}>{error ?? 'RevenueCat could not start.'}</Text>
        </Surface>
      ) : null}

      {packages.map((pkg) => {
        const annual = pkg.identifier === '$rc_annual';
        return (
          <Surface key={pkg.identifier} dark={annual}>
            <View style={styles.packageRow}>
              <View style={styles.packageCopy}>
                <Text style={[styles.packageKicker, annual && styles.packageKickerDark]}>
                  {annual ? 'BEST VALUE' : 'FLEXIBLE'}
                </Text>
                <Text style={[styles.packageTitle, annual && styles.packageTitleDark]}>
                  {annual ? 'Annual' : 'Monthly'}
                </Text>
                <Text style={[styles.packagePrice, annual && styles.packagePriceDark]}>
                  {pkg.product.priceString}
                </Text>
              </View>
              <JuvaButton
                label={busyPackage === pkg.identifier ? 'Working…' : 'Choose'}
                variant={annual ? 'signal' : 'dark'}
                disabled={Boolean(busyPackage)}
                onPress={() => void buy(pkg)}
                style={styles.choose}
              />
            </View>
          </Surface>
        );
      })}

      {message ? <Text style={styles.message}>{message}</Text> : null}
      <JuvaButton label="Restore purchases" variant="ghost" onPress={() => void restoreAccess()} />
      {hasPlus ? (
        <JuvaButton label="Back to Juva" variant="dark" onPress={() => router.back()} />
      ) : null}
      <Text style={styles.legal}>
        Subscriptions renew through the applicable store unless cancelled. RevenueCat Test Store
        transactions are simulated and require a development build for full purchase testing.
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  hero: { paddingVertical: spacing.xl },
  heroLabel: { ...type.label, color: colors.signalDeep },
  heroTitle: { ...type.display, color: colors.ink },
  heroCopy: { ...type.bodySmall, color: colors.inkSoft, maxWidth: 330 },
  notYet: { ...type.bodySmall, fontSize: 12, color: colors.muted, lineHeight: 18 },
  feature: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  check: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: colors.forestSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: { color: colors.signalDeep, fontWeight: '900' },
  featureText: { flex: 1 },
  featureTitle: { ...type.body, color: colors.ink, fontWeight: '900' },
  featureCopy: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  stateTitle: { ...type.h2, color: colors.ink },
  stateCopy: { ...type.bodySmall, color: colors.muted },
  error: { ...type.bodySmall, color: colors.red, fontWeight: '800' },
  packageRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  packageCopy: { flex: 1 },
  packageKicker: { ...type.label, color: colors.signalDeep },
  packageKickerDark: { color: colors.signal },
  packageTitle: { ...type.h2, color: colors.ink, marginTop: 4 },
  packageTitleDark: { color: colors.white },
  packagePrice: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  packagePriceDark: { color: 'rgba(255,255,255,0.6)' },
  choose: { width: 110 },
  message: { ...type.bodySmall, color: colors.signalDeep, fontWeight: '900', textAlign: 'center' },
  legal: {
    ...type.bodySmall,
    fontSize: 11,
    lineHeight: 17,
    color: colors.muted,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
  },
});
