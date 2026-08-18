import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { ChecklistItem } from '@/components/ChecklistItem';
import { CollectProgress } from '@/components/CollectProgress';
import { ItemActions } from '@/components/ItemActions';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { MetricPill } from '@/components/MetricPill';
import { JuvaPressable } from '@/components/Pressable';
import { SectionLabel } from '@/components/SectionLabel';
import { ShelfChange } from '@/components/ShelfChange';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import type { AdaptDecision } from '@/domain/shopAdapt';
import { hapticCollect, hapticSelect, hapticSuccess } from '@/motion/haptics';
import { hasPreciseLocation, openStoreInMaps } from '@/services/navigation';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

export default function ShopScreen() {
  const {
    activeTrip,
    activeList,
    updateTripItem,
    advanceTripStop,
    completeTrip,
    planShelfChange,
    applyShelfChange,
  } = useJuva();
  const [editingId, setEditingId] = useState<string>();
  const [navError, setNavError] = useState<string>();
  /** The decision Juva is currently asking the shopper to settle. */
  const [decision, setDecision] = useState<AdaptDecision>();

  // Every hook runs before any conditional return: React matches hooks by call
  // order, so an early return above a hook breaks the screen the moment a trip
  // starts or ends beneath it.
  const stop = activeTrip
    ? (activeTrip.stops[activeTrip.currentStopIndex] ?? activeTrip.stops[0])
    : undefined;
  const expected = useMemo(
    () =>
      (stop?.items ?? []).reduce(
        (sum, item) => sum + (item.actualPriceCents ?? item.lineTotalCents),
        0,
      ),
    [stop?.items],
  );

  if (!activeTrip) {
    return (
      <AppScreen footer={<JuvaRail />}>
        <TopBar title="Shop" />
        <Surface>
          <Text style={styles.emptyTitle}>No active trip.</Text>
          <Text style={styles.emptyCopy}>Choose an optimized plan first.</Text>
          <JuvaButton label="Plan groceries" onPress={() => router.replace('/')} />
        </Surface>
      </AppScreen>
    );
  }

  if (!stop)
    return (
      <AppScreen footer={<JuvaRail />}>
        <TopBar title="Shop" />
        <Surface>
          <Text style={styles.emptyTitle}>This trip has no store stops.</Text>
        </Surface>
      </AppScreen>
    );

  const currency = activeList?.currency ?? 'USD';
  const nextStop = activeTrip.stops[activeTrip.currentStopIndex + 1];
  const collected = stop.items.filter((item) => item.status === 'collected').length;
  const done = collected === stop.items.length;
  const lastStop = activeTrip.currentStopIndex === activeTrip.stops.length - 1;

  return (
    <AppScreen
      footer={
        <JuvaRail
          status={`SHOP · ${stop.store.retailerName.toUpperCase()} · ${stop.items.length - collected} LEFT`}
        />
      }
    >
      <TopBar
        title="Shop"
        eyebrow={`STORE ${activeTrip.currentStopIndex + 1} OF ${activeTrip.stops.length}`}
        right={
          <Pressable onPress={() => router.push('/plan')}>
            <Text style={styles.routeLink}>PLAN</Text>
          </Pressable>
        }
      />

      <Surface dark>
        <Text style={styles.storeEyebrow}>NOW SHOPPING</Text>
        <Text style={styles.storeTitle}>{stop.store.retailerName}</Text>
        <Text style={styles.address}>{stop.store.address}</Text>
        <JuvaPressable
          onPress={() => {
            void openStoreInMaps(stop.store).then((opened) => {
              if (!opened) setNavError('No maps app could be opened on this device.');
            });
          }}
          feedback="tap"
          style={styles.navigate}
          accessibilityLabel={`Navigate to ${stop.store.retailerName}`}
          accessibilityHint={
            hasPreciseLocation(stop.store)
              ? 'Opens your maps app at this exact store'
              : 'Opens your maps app searching for this address'
          }
        >
          <Text style={styles.navigateText}>◎ NAVIGATE</Text>
        </JuvaPressable>
        {navError ? <Text style={styles.navError}>{navError}</Text> : null}
        <View style={styles.metrics}>
          <MetricPill dark label={`${collected}/${stop.items.length} collected`} />
          <MetricPill dark label={`${formatMoney(expected, currency)} expected`} />
        </View>
        <CollectProgress collected={collected} total={stop.items.length} />
      </Surface>

      {decision ? (
        <>
          <View style={styles.sectionHeader}>
            <SectionLabel>Juva re-checked the trip</SectionLabel>
            <Text style={styles.sectionMeta}>no network needed</Text>
          </View>
          <ShelfChange
            decision={decision}
            currency={currency}
            onChoose={(optionId) => {
              applyShelfChange(decision, optionId);
              hapticCollect();
              setDecision(undefined);
            }}
            onDismiss={() => setDecision(undefined)}
          />
        </>
      ) : null}

      <View style={styles.sectionHeader}>
        <SectionLabel>Checklist</SectionLabel>
        <Text style={styles.sectionMeta}>decided on this device, from your saved trip</Text>
      </View>
      <View style={styles.list}>
        {stop.items.map((item) => (
          <ChecklistItem
            key={item.groceryItemId}
            item={item}
            currency={currency}
            onToggle={() => {
              const next = item.status === 'collected' ? 'pending' : 'collected';
              if (next === 'collected') hapticCollect();
              else hapticSelect();
              updateTripItem(item.groceryItemId, next);
            }}
            onSkip={() =>
              updateTripItem(item.groceryItemId, item.status === 'skipped' ? 'pending' : 'skipped')
            }
            onCorrectPrice={() => setEditingId(item.groceryItemId)}
            {...(editingId === item.groceryItemId
              ? {
                  editor: (
                    <ItemActions
                      item={item}
                      currency={currency}
                      onCollect={() => {
                        const next = item.status === 'collected' ? 'pending' : 'collected';
                        if (next === 'collected') hapticCollect();
                        else hapticSelect();
                        updateTripItem(item.groceryItemId, next);
                      }}
                      onSkip={() =>
                        updateTripItem(
                          item.groceryItemId,
                          item.status === 'skipped' ? 'pending' : 'skipped',
                        )
                      }
                      onReport={(event) => {
                        hapticSelect();
                        const next = planShelfChange(event);
                        if (next) setDecision(next);
                      }}
                      onClose={() => setEditingId(undefined)}
                    />
                  ),
                }
              : {})}
          />
        ))}
      </View>

      {done ? (
        <Surface signal>
          <Text style={styles.doneLabel}>
            {lastStop
              ? 'TRIP READY TO VERIFY'
              : `${stop.store.retailerName.toUpperCase()} COMPLETE`}
          </Text>
          <Text style={styles.doneCount}>
            {collected} / {stop.items.length} collected
          </Text>
          <Text style={styles.doneTitle}>
            {lastStop
              ? 'One last thing: check what you actually paid.'
              : `Next: ${nextStop?.store.retailerName ?? 'next store'}`}
          </Text>
          <Text style={styles.doneCopy}>
            {lastStop
              ? 'Receipt verification turns estimated savings into verified savings.'
              : `${nextStop?.store.distanceMiles.toFixed(1) ?? '—'} miles · about ${nextStop?.store.etaMinutes ?? '—'} min`}
          </Text>

          {/* The handoff, not a map. Juva has no business rebuilding turn-by-turn
              navigation when the phone already has an app that does it properly. */}
          {!lastStop && nextStop ? (
            <JuvaPressable
              onPress={() => {
                void openStoreInMaps(nextStop.store).then((opened) => {
                  if (!opened) setNavError('No maps app could be opened on this device.');
                });
              }}
              feedback="tap"
              style={styles.nextNavigate}
              accessibilityLabel={`Navigate to ${nextStop.store.retailerName}`}
              accessibilityHint="Opens your maps app"
            >
              <Text style={styles.nextNavigateText}>NAVIGATE →</Text>
            </JuvaPressable>
          ) : null}

          <JuvaButton
            label={
              lastStop
                ? 'Verify receipts'
                : `Start shopping at ${nextStop?.store.retailerName ?? 'the next store'}`
            }
            onPress={() => {
              if (lastStop) {
                hapticSuccess();
                completeTrip();
                router.push('/verify');
              } else {
                advanceTripStop();
              }
            }}
          />
        </Surface>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  emptyTitle: { ...type.h2, color: colors.ink },
  emptyCopy: { ...type.bodySmall, color: colors.muted },
  routeLink: { ...type.label, color: colors.signalDeep },
  navigate: {
    alignSelf: 'flex-start',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  navigateText: { ...type.label, fontSize: 9, color: colors.signal },
  navError: { ...type.bodySmall, fontSize: 11, color: colors.amber },
  storeEyebrow: { ...type.label, color: colors.signal },
  storeTitle: { ...type.display, color: colors.white },
  address: { ...type.bodySmall, color: 'rgba(255,255,255,0.56)' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  progress: {
    height: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  progressFill: { height: 5, backgroundColor: colors.signal },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionMeta: { ...type.bodySmall, fontSize: 11, color: colors.muted },
  list: { gap: 2 },
  item: {
    minHeight: 96,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  itemChecked: { opacity: 0.58 },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: { backgroundColor: colors.ink, borderColor: colors.ink },
  checkText: { color: colors.signal, fontWeight: '900' },
  itemBody: { flex: 1 },
  itemName: { ...type.body, color: colors.ink, fontWeight: '900' },
  checkedText: { textDecorationLine: 'line-through' },
  itemMeta: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  promo: {
    ...type.bodySmall,
    fontSize: 11,
    color: colors.signalDeep,
    fontWeight: '900',
    marginTop: 3,
  },
  diff: { ...type.bodySmall, fontSize: 11, color: colors.blue, fontWeight: '900', marginTop: 6 },
  price: { ...type.bodySmall, color: colors.ink, fontWeight: '900', marginTop: 3 },
  priceEdit: { flexDirection: 'row', gap: spacing.xs, marginTop: 8 },
  priceInput: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: 10,
    color: colors.ink,
  },
  apply: {
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: colors.ink,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyText: { ...type.label, fontSize: 8, color: colors.white },
  unavailable: {
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unavailableText: { ...type.label, fontSize: 8, color: colors.amber },
  doneLabel: { ...type.label, color: colors.signalDeep },
  doneCount: { ...type.bodySmall, color: colors.inkSoft, fontWeight: '900' },
  nextNavigate: {
    alignSelf: 'flex-start',
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.ink,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  nextNavigateText: { ...type.label, fontSize: 9, color: colors.signal },
  doneTitle: { ...type.h2, color: colors.ink },
  doneCopy: { ...type.bodySmall, color: colors.inkSoft },
});
