import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { LiveDot } from '@/components/LiveDot';
import { SearchStage } from '@/components/SearchStage';
import { hapticWarn } from '@/motion/haptics';
import { EASING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { useJuva } from '@/state/JuvaProvider';
import { useOnlineStatus } from '@/state/useOnlineStatus';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

/** Minimum time the search choreography is allowed to run, in milliseconds. */
const CHOREOGRAPHY_MS = 3900;
const STAGE_INTERVAL_MS = 620;

interface Stage {
  readonly name: string;
  readonly detail: string;
}

const ENGINE_STAGES: readonly Stage[] = [
  { name: 'Product resolver', detail: 'normalizing equivalent items' },
  { name: 'Route engine', detail: 'pricing time and distance' },
  { name: 'Basket optimizer', detail: 'evaluating combinations' },
];

export default function SearchingScreen() {
  const { activeList, optimizeActiveList, lastSnapshot, preferences } = useJuva();
  const [activeIndex, setActiveIndex] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const online = useOnlineStatus();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    let cancelled = false;

    progress.value = reduced
      ? 1
      : withTiming(1, { duration: CHOREOGRAPHY_MS, easing: EASING.settle });

    const ticker = setInterval(() => setActiveIndex((current) => current + 1), STAGE_INTERVAL_MS);

    // Run the real search immediately and hold the result until the
    // choreography has had its full run, so the rhythm stays constant while the
    // numbers on screen remain the ones the optimizer actually saw.
    const search = optimizeActiveList();
    const floor = new Promise<void>((resolve) => setTimeout(resolve, CHOREOGRAPHY_MS));

    void Promise.all([search, floor]).then(([result]) => {
      if (cancelled) return;
      clearInterval(ticker);
      if (result.plans.length > 0) {
        router.replace('/plan');
        return;
      }
      hapticWarn();
      setFailure(result.error ?? 'Juva could not build a plan for this basket.');
    });

    return () => {
      cancelled = true;
      clearInterval(ticker);
    };
  }, [optimizeActiveList, progress, reduced]);

  // Driven on the UI thread, so the bar keeps moving while the optimizer works.
  const progressStyle = useAnimatedStyle(() => ({
    width: `${4 + progress.value * 96}%`,
  }));

  // Store rows come from the snapshot once it has loaded. Before that Juva shows
  // the radius it is searching rather than inventing retailer names.
  const stages = useMemo<Stage[]>(() => {
    const storeStages: Stage[] = lastSnapshot
      ? lastSnapshot.storeNames.map((name) => ({
          name,
          detail: 'checking prices and availability',
        }))
      : [
          {
            name: `Stores within ${preferences.radiusMiles} mi`,
            detail: 'opening the local market',
          },
        ];
    return [...storeStages, ...ENGINE_STAGES];
  }, [lastSnapshot, preferences.radiusMiles]);

  // Every figure below is a count from the snapshot, never an estimate.
  const stats = useMemo<string[]>(() => {
    if (!lastSnapshot) return [];
    const itemCount = activeList?.items.length ?? 0;
    return [
      `${lastSnapshot.productCount} listings in range`,
      `${lastSnapshot.matchedProductCount} matched to ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`,
      `${lastSnapshot.promotionCount} promotions checked`,
      `${lastSnapshot.combinationsEvaluated} store combinations`,
    ];
  }, [activeList?.items.length, lastSnapshot]);

  const isDemo = lastSnapshot?.mode === 'demo';
  /**
   * Real observations are only called LIVE when they actually are. A market whose
   * weakest price needs re-checking is labelled REAL · VERIFY, because calling
   * nine-month-old community data "live" is the exact misrepresentation Juva
   * exists to avoid.
   */
  const marketLabel = !lastSnapshot
    ? 'OPENING MARKET'
    : isDemo
      ? 'DEMO MARKET'
      : lastSnapshot.weakestFreshness === 'live'
        ? 'LIVE MARKET'
        : `REAL · ${lastSnapshot.weakestFreshness.toUpperCase()}`;

  return (
    <AppScreen
      scroll={false}
      footer={<JuvaRail status={`JUVA SEARCHING · ${marketLabel}`} />}
      contentStyle={styles.screen}
    >
      <View style={styles.header}>
        <Text style={styles.logo}>JUVA</Text>
        <View style={styles.live}>
          <LiveDot active={!failure} />
          <Text style={styles.liveText}>{marketLabel}</Text>
        </View>
      </View>

      <View style={styles.hero}>
        <Text style={styles.kicker}>{failure ? 'SEARCH STOPPED' : 'BUILDING YOUR BASKET'}</Text>
        <Text style={styles.title}>
          {failure ? 'Juva could not complete this basket.' : 'Finding the best way to buy this.'}
        </Text>
        <View style={styles.progress}>
          <Animated.View style={[styles.progressFill, progressStyle]} />
        </View>
      </View>

      {failure ? (
        <View style={styles.failure}>
          <Text style={styles.failureCopy} allowFontScaling accessibilityLiveRegion="polite">
            {failure}
          </Text>
          {!online ? (
            <Text style={styles.offlineCopy} allowFontScaling>
              This device is offline. Juva needs a connection to look up local prices — a trip
              already in progress keeps working without one.
            </Text>
          ) : null}
          <JuvaButton
            label="Try again"
            variant="dark"
            busy={retrying}
            onPress={() => {
              setRetrying(true);
              setFailure(undefined);
              void optimizeActiveList().then((result) => {
                setRetrying(false);
                if (result.plans.length > 0) router.replace('/plan');
                else {
                  hapticWarn();
                  setFailure(result.error ?? 'Juva could not build a plan for this basket.');
                }
              });
            }}
            accessibilityHint="Runs the search again"
          />
          <JuvaButton
            label="Adjust the basket"
            variant="ghost"
            onPress={() => router.replace('/basket')}
          />
        </View>
      ) : (
        <>
          <View style={styles.tasks}>
            {stages.map((stage, index) => {
              const current = Math.min(activeIndex, stages.length - 1);
              return (
                <SearchStage
                  key={`${stage.name}-${index}`}
                  name={stage.name}
                  detail={stage.detail}
                  index={index}
                  state={index < current ? 'done' : index === current ? 'active' : 'waiting'}
                />
              );
            })}
          </View>

          <View style={styles.stats}>
            {stats.map((stat) => (
              <View key={stat} style={styles.stat}>
                <Text style={styles.statText}>{stat}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      {/* Items no source could price are named, never quietly dropped. */}
      {lastSnapshot && lastSnapshot.unpricedConcepts.length > 0 ? (
        <View style={styles.gap}>
          <Text style={styles.gapLabel}>NOT PRICED NEARBY</Text>
          <Text style={styles.gapCopy}>
            {lastSnapshot.unpricedConcepts.join(', ')} — no store in range had a price Juva could
            verify. These stay out of the basket total rather than being estimated.
          </Text>
        </View>
      ) : null}

      <Text style={styles.note}>
        {isDemo
          ? "Prices in Juva's controlled market are demo observations, labelled DEMO everywhere they appear."
          : lastSnapshot?.partial
            ? 'Some price sources did not answer, so coverage may be thinner than usual. Every price shown carries its store, source, timestamp and confidence.'
            : 'Every price carries its source, store, timestamp and confidence. Final costs are arithmetic, never model output.'}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingBottom: spacing.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logo: { ...type.label, color: colors.ink, fontSize: 15, letterSpacing: 3.5 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveText: { ...type.label, color: colors.signalDeep, fontSize: 9 },
  hero: { gap: spacing.sm, marginTop: spacing.xl },
  kicker: { ...type.label, color: colors.muted },
  title: { ...type.display, color: colors.ink, maxWidth: 350 },
  progress: {
    height: 6,
    backgroundColor: colors.paperStrong,
    borderRadius: 9,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  progressFill: { height: 6, backgroundColor: colors.signalDeep, borderRadius: 9 },
  failure: { gap: spacing.md, marginTop: spacing.lg },
  failureCopy: { ...type.body, color: colors.inkSoft, maxWidth: 340 },
  offlineCopy: { ...type.bodySmall, color: colors.amber, maxWidth: 340 },
  tasks: { gap: 8, marginTop: spacing.lg },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: {
    borderRadius: 999,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  statText: { ...type.bodySmall, fontSize: 11, color: colors.inkSoft, fontWeight: '800' },
  gap: {
    gap: 5,
    borderRadius: 18,
    backgroundColor: colors.amberSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  gapLabel: { ...type.label, fontSize: 9, color: colors.ink },
  gapCopy: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.inkSoft },
  note: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
});
