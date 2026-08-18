import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { describeSubscription, grantsPlus } from '@/domain/subscription';
import { useRevenueCat } from '@/state/RevenueCatProvider';
import { colors } from '@/theme/colors';
import { type } from '@/theme/type';

/** Store identifiers RevenueCat reports, mapped to what a shopper would call them. */
function describeStore(store: string): string {
  switch (store.toUpperCase()) {
    case 'APP_STORE':
    case 'MAC_APP_STORE':
      return 'the App Store';
    case 'PLAY_STORE':
      return 'Google Play';
    case 'STRIPE':
      return 'Stripe';
    case 'RC_BILLING':
    case 'PADDLE':
      return 'web billing';
    case 'PROMOTIONAL':
      return 'a promotional grant';
    default:
      return store.toLowerCase().replace(/_/g, ' ');
  }
}

function formatDate(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Subscription management.
 *
 * Every fact here comes from RevenueCat's live entitlement, never from a local
 * guess: whether it renews, when it lapses, which store holds the billing
 * relationship. Cancellation and plan changes are deliberately *not* actions
 * Juva performs — those belong to the store, so this links out to it. An app that
 * appeared to cancel a subscription it cannot cancel would be the worst possible
 * lie to tell about someone's money.
 */
export default function SubscriptionScreen() {
  const { status, error, subscription, plusEntitlement, managementUrl, restore, refresh } =
    useRevenueCat();
  const hasPlus = grantsPlus(subscription);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const expires = formatDate(plusEntitlement?.expirationDate ?? null);
  const renews = plusEntitlement?.willRenew === true;
  const cancelledAt = formatDate(plusEntitlement?.unsubscribeDetectedAt ?? null);

  const restoreAccess = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    const restored = await restore();
    setBusy(false);
    setMessage(
      restored
        ? 'Juva Plus restored on this device.'
        : 'No active Juva Plus purchase was found for this account.',
    );
  };

  return (
    <AppScreen>
      <TopBar back title="Subscription" eyebrow="JUVA SPACE" />

      <Surface dark>
        <Text style={styles.planLabel}>YOUR PLAN</Text>
        <Text style={styles.planName} allowFontScaling>
          {hasPlus ? 'Juva Plus' : 'Juva Free'}
        </Text>
        {/* The canonical state in the shopper's words. A billing outage says so rather
            than presenting itself as the free plan. */}
        <Text style={styles.planMeta} allowFontScaling>
          {describeSubscription(subscription)}
        </Text>

        {hasPlus && plusEntitlement ? (
          <>
            <Text style={styles.planMeta} allowFontScaling>
              {renews
                ? expires
                  ? `Renews ${expires}.`
                  : 'Renews automatically.'
                : expires
                  ? `Access continues until ${expires}, then stops.`
                  : 'Does not renew.'}
            </Text>
            <Text style={styles.planMeta} allowFontScaling>
              Billed through {describeStore(plusEntitlement.store)}
              {plusEntitlement.periodType.toLowerCase() === 'trial' ? ', currently in a trial' : ''}
              .
            </Text>
            {cancelledAt ? (
              <Text style={styles.warn} allowFontScaling>
                A cancellation was recorded on {cancelledAt}. Plus stays active until the date
                above.
              </Text>
            ) : null}
            {plusEntitlement.isSandbox ? (
              <Text style={styles.warn} allowFontScaling>
                This is a sandbox purchase, not a real charge.
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.planMeta} allowFontScaling>
            Multi-store optimization is a Plus feature. The cheapest single-store plan, Shop Mode
            and receipt verification are always free.
          </Text>
        )}
      </Surface>

      {status === 'disabled' ? (
        <Surface>
          <Text style={styles.stateTitle} allowFontScaling>
            Purchases are not configured on this build.
          </Text>
          <Text style={styles.stateCopy} allowFontScaling>
            No RevenueCat key is present, so Juva cannot read or change a subscription here. Every
            other part of the app works normally.
          </Text>
        </Surface>
      ) : null}

      {status === 'error' || error ? (
        <Surface>
          <Text style={styles.error} allowFontScaling>
            {error ?? 'Juva could not reach the store to check your subscription.'}
          </Text>
          <JuvaButton
            label="Try again"
            variant="ghost"
            busy={busy}
            onPress={() => {
              setBusy(true);
              void refresh()
                .catch(() => setMessage('Still could not reach the store.'))
                .finally(() => setBusy(false));
            }}
          />
        </Surface>
      ) : null}

      <SectionLabel>Manage</SectionLabel>
      <Surface>
        {hasPlus ? (
          <>
            <Text style={styles.manageCopy} allowFontScaling>
              Cancelling, switching between monthly and annual, or changing the payment method all
              happen in {plusEntitlement ? describeStore(plusEntitlement.store) : 'your app store'}.
              Juva cannot do those on your behalf.
            </Text>
            <JuvaButton
              label={managementUrl ? 'Manage in the store' : 'Manage in your store settings'}
              variant="dark"
              disabled={!managementUrl}
              accessibilityHint="Opens the store's own subscription page"
              onPress={() => {
                if (managementUrl) void Linking.openURL(managementUrl);
              }}
            />
            {!managementUrl ? (
              <Text style={styles.stateCopy} allowFontScaling>
                The store did not provide a management link for this purchase — open your
                subscriptions from your device settings instead.
              </Text>
            ) : null}
          </>
        ) : (
          <JuvaButton
            label="See what Plus unlocks"
            variant="signal"
            onPress={() => router.push('/paywall')}
          />
        )}

        <JuvaButton
          label="Restore purchases"
          variant="ghost"
          busy={busy}
          onPress={() => void restoreAccess()}
          accessibilityHint="Checks the store for a purchase made on another device"
        />
        {message ? (
          <Text style={styles.message} accessibilityLiveRegion="polite" allowFontScaling>
            {message}
          </Text>
        ) : null}
      </Surface>

      <SectionLabel>What Plus changes</SectionLabel>
      <Surface>
        {[
          ['Multi-store plans', 'Split a basket across stores when the saving beats the trip.'],
          ['Worth-the-trip controls', 'Re-plan against your own price-versus-convenience balance.'],
          ['Recurring baskets', 'Re-price a saved basket against today’s market.'],
        ].map(([title, copy]) => (
          <View key={title} style={styles.feature}>
            <Text style={styles.featureTitle} allowFontScaling>
              {title}
            </Text>
            <Text style={styles.featureCopy} allowFontScaling>
              {copy}
            </Text>
          </View>
        ))}
        <Text style={styles.stateCopy} allowFontScaling>
          Prices, savings and receipt verification are never gated. Juva does not charge for knowing
          what something costs.
        </Text>
      </Surface>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  planLabel: { ...type.label, color: colors.signal },
  planName: { ...type.display, color: colors.white },
  planMeta: { ...type.bodySmall, color: 'rgba(255,255,255,0.66)', lineHeight: 20 },
  warn: { ...type.bodySmall, color: colors.amber, fontWeight: '800' },
  stateTitle: { ...type.h2, color: colors.ink },
  stateCopy: { ...type.bodySmall, fontSize: 12, lineHeight: 18, color: colors.muted },
  error: { ...type.bodySmall, color: colors.red, fontWeight: '800' },
  manageCopy: { ...type.bodySmall, color: colors.inkSoft, lineHeight: 20 },
  message: { ...type.bodySmall, color: colors.signalDeep, fontWeight: '900', textAlign: 'center' },
  feature: { gap: 2 },
  featureTitle: { ...type.body, color: colors.ink, fontWeight: '900' },
  featureCopy: { ...type.bodySmall, color: colors.muted },
});
