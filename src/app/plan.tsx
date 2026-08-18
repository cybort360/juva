import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { MetricPill } from '@/components/MetricPill';
import { PlanCard } from '@/components/PlanCard';
import { PlanLine } from '@/components/PlanLine';
import { SavingsNumber } from '@/components/SavingsNumber';
import { SectionLabel } from '@/components/SectionLabel';
import { StoreRoute } from '@/components/StoreRoute';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { WorthTheTrip } from '@/components/WorthTheTrip';
import { upgradePrompt } from '@/domain/entitlements';
import { grantsPlus } from '@/domain/subscription';
import type { CompletenessRemediation, MissingReason } from '@/domain/types';
import { useJuva } from '@/state/JuvaProvider';
import { useRevenueCat } from '@/state/RevenueCatProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

/** Plain-language reason a line could not be filled by this plan. */
function describeMissing(reason: MissingReason): string {
  switch (reason) {
    case 'unavailable':
      return 'out of stock';
    case 'brand_required':
      return 'requested brand not stocked';
    case 'variant_required':
      return 'requested variant not stocked';
    case 'barcode_mismatch':
      return 'a different product to the one scanned';
    case 'currency_mismatch':
      return 'priced in another currency';
    case 'not_stocked_nearby':
      return 'not stocked at these stores';
  }
}

/** What the shopper can actually do about a basket Juva could not fully price. */
function describeRemediation(remediation: CompletenessRemediation): string {
  switch (remediation) {
    case 'widen_radius':
      return 'Widen the search radius — some of these are stocked further out.';
    case 'allow_substitutions':
      return 'Allow substitutions, so a different brand can fill the gap.';
    case 'retry_providers':
      return 'Retry the price sources. Coverage varies between runs.';
    case 'remove_unpriced_items':
      return 'Remove the unpriced items to get a complete plan for the rest.';
  }
}

export default function PlanScreen() {
  const {
    plans,
    selectedPlan,
    selectPlan,
    activeList,
    preferences,
    startSelectedPlan,
    saveActiveList,
    recomputePlans,
    setItemBrandPolicy,
  } = useJuva();
  const { subscription } = useRevenueCat();
  const hasPlus = grantsPlus(subscription);

  if (!selectedPlan || !activeList) {
    return (
      <AppScreen>
        <TopBar back title="Plan" />
        <Text style={styles.empty}>No optimized plan yet.</Text>
        <JuvaButton label="Build a basket" onPress={() => router.replace('/')} />
      </AppScreen>
    );
  }

  const currency = activeList.currency;
  const planRequiresPlus = selectedPlan.stops.length > 1 && !hasPlus;
  /**
   * The upgrade offer, quoted from figures the optimizer already produced.
   *
   * Computed here rather than inside the paywall so the number the shopper is shown is
   * the same subtraction the engine did — there is no second, marketing-shaped estimate
   * anywhere in this path.
   */
  const offer = upgradePrompt(plans, hasPlus);
  const explanation = selectedPlan.explanation;
  /**
   * A partial plan is a different claim from a complete one, and the screen has to
   * make that difference visible rather than rendering "YOU SAVE $0.00" over a
   * subtotal. Everything below branches on this one flag.
   */
  const { completeness } = selectedPlan;

  return (
    <AppScreen
      footer={
        <JuvaRail
          status={
            completeness.comparisonEligible
              ? `BEST PLAN · SAVE ${formatMoney(selectedPlan.savingsVsBaselineCents, currency)}`
              : `PARTIAL PLAN · ${completeness.pricedItemCount} OF ${completeness.requestedItemCount} PRICED`
          }
        />
      }
    >
      <TopBar
        back
        title="Your plan"
        eyebrow="JUVA OPTIMIZED"
        right={
          <Pressable onPress={saveActiveList}>
            <Text style={styles.saveAction}>SAVE</Text>
          </Pressable>
        }
      />

      <Surface dark style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.heroLabel}>BEST FOR YOU</Text>
          <Text style={styles.confidence}>
            {Math.round(selectedPlan.confidence * 100)}% confidence
          </Text>
        </View>
        <SavingsNumber cents={selectedPlan.pricedSubtotalCents} currency={currency} dark />
        <Text style={styles.heroCopy}>
          {completeness.complete
            ? `Total basket cost across ${selectedPlan.stops.length} nearby ${selectedPlan.stops.length === 1 ? 'store' : 'stores'}.`
            : `Priced subtotal for ${completeness.pricedItemCount} of ${completeness.requestedItemCount} items, across ${selectedPlan.stops.length} nearby ${selectedPlan.stops.length === 1 ? 'store' : 'stores'}. Not a basket total.`}
        </Text>
        <View style={styles.heroDivider} />
        {completeness.comparisonEligible ? (
          <>
            <Text style={styles.saveLabel}>YOU SAVE</Text>
            <Text style={styles.saveValue}>
              {formatMoney(selectedPlan.savingsVsBaselineCents, currency)}
            </Text>
            <Text style={styles.saveCopy}>
              vs{' '}
              {explanation.baselines.find((entry) => entry.isDefault)?.label.toLowerCase() ??
                'the cheapest single store Juva found'}
              , for the complete basket.
            </Text>
          </>
        ) : (
          /* No savings figure at all, rather than a zero that reads as "no bargain
             here". A zero implies Juva compared and found nothing; the truth is that
             it refused to compare. */
          <>
            <Text style={styles.saveLabel}>NO SAVING CLAIMED</Text>
            <Text style={styles.partialCopy}>
              {completeness.ineligibleReason ??
                'This plan cannot be compared against a complete basket.'}
            </Text>
          </>
        )}
        <View style={styles.metrics}>
          <MetricPill
            dark
            label={`${selectedPlan.stops.length} ${selectedPlan.stops.length === 1 ? 'stop' : 'stops'}`}
          />
          <MetricPill dark label={`${selectedPlan.travelMiles.toFixed(1)} mi`} />
          <MetricPill dark label={`~${selectedPlan.etaMinutes} min`} />
        </View>
      </Surface>

      {/*
        The only paywall trigger. It sits below the free plan, which is already
        shoppable above — the shopper sees what they can have before being told what
        they cannot, and the figure is deterministic.
      */}
      {offer ? (
        <Surface>
          <Text style={styles.offerLabel}>WORTH KNOWING</Text>
          <Text style={styles.offerTitle}>
            {`Juva found another ${formatMoney(offer.additionalSavingsCents, currency)} in savings with a smarter multi-store plan.`}
          </Text>
          <Text style={styles.offerCopy}>
            {`Splitting across ${offer.storeCount} stores costs about ${Math.round(offer.extraMinutes)} more minutes and ${offer.extraDistanceMiles.toFixed(1)} more miles. The one-stop plan above stays free, and stays yours.`}
          </Text>
          <JuvaButton
            label="See Juva Plus"
            variant="dark"
            onPress={() => router.push('/paywall')}
            accessibilityHint="Opens the Juva Plus options"
          />
        </Surface>
      ) : null}

      <View style={styles.sectionHeader}>
        <SectionLabel>Route</SectionLabel>
        <Text style={styles.sectionMeta}>price + effort balanced</Text>
      </View>
      <Surface>
        <StoreRoute stops={selectedPlan.stops} currency={currency} />
        <JuvaButton
          label={planRequiresPlus ? 'Unlock this plan' : 'Shop this plan'}
          variant="signal"
          onPress={() => {
            if (planRequiresPlus) router.push('/paywall');
            else if (startSelectedPlan()) router.push('/shop');
          }}
        />
        {planRequiresPlus ? (
          <Text style={styles.plusNote}>
            Multi-store optimization is a Juva Plus feature. The one-stop plan remains available
            free.
          </Text>
        ) : null}
      </Surface>

      <View style={styles.sectionHeader}>
        <SectionLabel>Other ways to shop</SectionLabel>
        <Text style={styles.sectionMeta}>compare tradeoffs</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cards}
      >
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            currency={currency}
            selected={plan.id === selectedPlan.id}
            onPress={() => selectPlan(plan.id)}
          />
        ))}
      </ScrollView>

      <Surface signal>
        <WorthTheTrip
          selected={selectedPlan}
          plans={plans}
          preferences={preferences}
          currency={currency}
          onRecompute={(patch) => recomputePlans(patch)}
        />
      </Surface>

      {/* Why this plan, from the same numbers the ranking used. */}
      <View style={styles.sectionHeader}>
        <SectionLabel>Why this plan</SectionLabel>
        <Text style={styles.sectionMeta}>deterministic score</Text>
      </View>
      <Surface>
        <Text style={styles.rationale}>{explanation.rationale}</Text>
        <View style={styles.breakdown}>
          {[
            ['Basket', explanation.score.basketCostCents],
            ['Travel', explanation.score.travelCostCents],
            ['Time', explanation.score.travelTimeCostCents],
            ['Extra stops', explanation.score.extraStopPenaltyCents],
            ['Stale-price risk', explanation.score.staleDataPenaltyCents],
            ['Missing items', explanation.score.missingItemPenaltyCents],
            ['Match uncertainty', explanation.score.uncertaintyPenaltyCents],
          ].map(([label, cents]) => (
            <View key={String(label)} style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>{label}</Text>
              <Text style={styles.breakdownValue}>{formatMoney(Number(cents), currency)}</Text>
            </View>
          ))}
          <View style={[styles.breakdownRow, styles.breakdownTotal]}>
            <Text style={styles.breakdownTotalLabel}>
              Ranking score · effort ×{explanation.score.effortWeight.toFixed(2)}
            </Text>
            <Text style={styles.breakdownTotalValue}>
              {formatMoney(explanation.score.totalCents, currency)}
            </Text>
          </View>
        </View>
        <Text style={styles.breakdownNote}>
          Only the basket is money you pay. The rest are planning costs Juva uses to rank plans;
          they never enter a total or a saving.
        </Text>

        {/* The confidence figure, shown as the arithmetic behind it. A percentage
            with nothing under it is a mood, not a measurement. */}
        <Text style={styles.missingLabel}>
          {Math.round(selectedPlan.confidence * 100)}% CONFIDENCE, BECAUSE
        </Text>
        {explanation.confidence.factors.map((factor) => (
          <View key={factor.kind} style={styles.missingRow}>
            <Text style={styles.missingName}>{factor.detail}</Text>
            <Text style={styles.missingReason}>
              {factor.deltaPermille === 0
                ? 'no change'
                : `${(factor.deltaPermille / 10).toFixed(0)}%`}
            </Text>
          </View>
        ))}
      </Surface>

      {selectedPlan.missingItems.length > 0 ? (
        <Surface>
          <Text style={styles.missingLabel}>NOT IN THIS PLAN</Text>
          {selectedPlan.missingItems.map((missing) => (
            <View key={missing.groceryItemId} style={styles.missingRow}>
              <Text style={styles.missingName}>{missing.requestedName}</Text>
              <Text style={styles.missingReason}>{describeMissing(missing.reason)}</Text>
            </View>
          ))}
          <Text style={styles.breakdownNote}>
            These stay out of the basket total. Juva does not estimate a price for an item it cannot
            find.
          </Text>

          {completeness.remediations.length > 0 ? (
            <>
              <Text style={styles.missingLabel}>WHAT MIGHT HELP</Text>
              {completeness.remediations.map((remediation) => (
                <Text key={remediation} style={styles.remediation}>
                  {describeRemediation(remediation)}
                </Text>
              ))}
            </>
          ) : null}
        </Surface>
      ) : null}

      <View style={styles.sectionHeader}>
        <SectionLabel>Basket</SectionLabel>
        <Text style={styles.sectionMeta}>{activeList.items.length} items</Text>
      </View>
      {selectedPlan.stops.map((stop) => (
        <Surface key={stop.store.id}>
          <View style={styles.storeHeader}>
            <View>
              <Text style={styles.storeTitle}>{stop.store.retailerName}</Text>
              <Text style={styles.storeMeta}>{stop.store.address}</Text>
            </View>
            <Text style={styles.storeTotal}>{formatMoney(stop.subtotalCents, currency)}</Text>
          </View>
          {stop.items.map((item) => (
            <PlanLine
              key={item.groceryItemId}
              item={item}
              currency={currency}
              onBrandPolicyChange={setItemBrandPolicy}
            />
          ))}
        </Surface>
      ))}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  empty: { ...type.body, color: colors.muted },
  saveAction: { ...type.label, color: colors.signalDeep },
  hero: { padding: spacing.xl },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroLabel: { ...type.label, color: colors.signal },
  confidence: { ...type.bodySmall, color: 'rgba(255,255,255,0.56)' },
  partialCopy: {
    ...type.bodySmall,
    color: colors.amber,
    lineHeight: 19,
    marginTop: 2,
  },
  remediation: { ...type.bodySmall, fontSize: 12, lineHeight: 18, color: colors.muted },
  heroCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.58)', maxWidth: 300 },
  heroDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: spacing.xs },
  saveLabel: { ...type.label, color: 'rgba(255,255,255,0.48)' },
  saveValue: { ...type.h1, color: colors.signal },
  saveCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.62)', maxWidth: 310 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionMeta: { ...type.bodySmall, color: colors.muted },
  cards: { gap: spacing.sm, paddingRight: spacing.lg },
  rationale: { ...type.bodySmall, color: colors.inkSoft, lineHeight: 20 },
  breakdown: { gap: 2 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  breakdownLabel: { ...type.bodySmall, fontSize: 12, color: colors.muted },
  breakdownValue: { ...type.bodySmall, fontSize: 12, color: colors.ink, fontWeight: '800' },
  breakdownTotal: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 4,
    paddingTop: spacing.xs,
  },
  breakdownTotalLabel: { ...type.bodySmall, fontSize: 12, color: colors.ink, fontWeight: '900' },
  breakdownTotalValue: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  breakdownNote: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
  missingLabel: { ...type.label, color: colors.red },
  missingRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  missingName: { ...type.bodySmall, color: colors.ink, fontWeight: '800', flex: 1 },
  missingReason: { ...type.bodySmall, fontSize: 11, color: colors.muted },
  worthLabel: { ...type.label, color: colors.signalDeep },
  worthTitle: { ...type.h2, color: colors.ink },
  worthCopy: { ...type.bodySmall, color: colors.inkSoft },
  offerLabel: { ...type.label, color: colors.signalDeep },
  offerTitle: { ...type.h2, color: colors.ink },
  offerCopy: { ...type.bodySmall, color: colors.muted, lineHeight: 20 },
  plusNote: { ...type.bodySmall, fontSize: 11, color: colors.muted, textAlign: 'center' },
  storeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  storeTitle: { ...type.h2, color: colors.ink },
  storeMeta: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  storeTotal: { ...type.h2, color: colors.ink },
});
