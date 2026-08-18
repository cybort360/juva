import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaRail } from '@/components/JuvaRail';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { env } from '@/config/runtimeEnv';
import {
  confirmedRecords,
  estimatedSavingsTotalCents,
  verifiedSavingsTotalCents,
} from '@/domain/savings';
import { grantsPlus } from '@/domain/subscription';
import { useJuva } from '@/state/JuvaProvider';
import { useRevenueCat } from '@/state/RevenueCatProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

const rows = [
  { label: 'Savings history', path: '/history' },
  { label: 'Shopping preferences', path: '/settings' },
  { label: 'Notifications', path: '/notifications' },
  { label: 'Subscription', path: '/subscription' },
] as const;

/** Development-only, so a store build has no route to it in the UI. */
const diagnosticsRow = { label: 'Diagnostics', path: '/diagnostics' } as const;

export default function ProfileScreen() {
  const { preferences, savedLists, savingsRecords } = useJuva();
  const { subscription } = useRevenueCat();
  const total = verifiedSavingsTotalCents(savingsRecords);
  const estimated = estimatedSavingsTotalCents(savingsRecords);
  const confirmed = confirmedRecords(savingsRecords);
  const currency = savingsRecords[0]?.currency ?? 'USD';
  return (
    <AppScreen footer={<JuvaRail />}>
      <TopBar back title="Juva" eyebrow="YOUR SPACE" />
      <Surface signal>
        <Text style={styles.small}>VERIFIED SAVINGS</Text>
        <Text style={styles.amount}>{formatMoney(total, currency)}</Text>
        <Text style={styles.copy}>
          {confirmed.length} of {savingsRecords.length} trips confirmed by a receipt ·{' '}
          {savedLists.length} saved baskets
        </Text>
        {/*
          The two figures are shown apart and never summed. An estimate is what Juva
          expected to save; a verified saving is what a receipt proved. Adding them, or
          showing only the larger, would be the easiest way for Juva to flatter itself.
        */}
        <View style={styles.divider} />
        <Text style={styles.small}>ESTIMATED, BEFORE RECEIPTS</Text>
        <Text style={styles.estimate}>{formatMoney(estimated, currency)}</Text>
        <Text style={styles.copy}>
          Only receipt-confirmed trips count toward the verified figure above.
        </Text>
      </Surface>
      <View style={styles.grid}>
        <Surface style={styles.gridCard}>
          <Text style={styles.gridLabel}>AREA</Text>
          <Text style={styles.gridValue}>{preferences.location.label}</Text>
          <Text style={styles.gridMeta}>{preferences.radiusMiles} mi radius</Text>
        </Surface>
        <Surface style={styles.gridCard}>
          <Text style={styles.gridLabel}>PLAN</Text>
          <Text style={styles.gridValue}>{grantsPlus(subscription) ? 'Juva Plus' : 'Free'}</Text>
          <Text style={styles.gridMeta}>{preferences.maxStores} stores max</Text>
        </Surface>
      </View>
      <SectionLabel>Manage</SectionLabel>
      <Surface style={styles.menu}>
        {(env.environment === 'production' ? rows : [...rows, diagnosticsRow]).map((row, index) => (
          <Pressable
            key={row.label}
            onPress={() => router.push(row.path)}
            style={[styles.row, index > 0 && styles.rowBorder]}
          >
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </Surface>
      <Surface dark>
        <Text style={styles.darkLabel}>JUVA PRINCIPLE</Text>
        <Text style={styles.darkTitle}>
          Estimated savings are never presented as verified savings.
        </Text>
        <Text style={styles.darkCopy}>
          Prices carry source, freshness and confidence. Final savings are arithmetic, not AI
          output.
        </Text>
      </Surface>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  small: { ...type.label, color: colors.signalDeep },
  amount: { ...type.displayXL, color: colors.ink },
  copy: { ...type.bodySmall, color: colors.inkSoft },
  estimate: { ...type.display, color: colors.inkSoft },
  divider: {
    height: 1,
    backgroundColor: 'rgba(22,26,22,0.14)',
    marginVertical: spacing.sm,
  },
  grid: { flexDirection: 'row', gap: spacing.sm },
  gridCard: { flex: 1, minHeight: 145 },
  gridLabel: { ...type.label, color: colors.muted },
  gridValue: { ...type.h2, color: colors.ink },
  gridMeta: { ...type.bodySmall, color: colors.muted },
  menu: { paddingVertical: 4, gap: 0 },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  rowLabel: { ...type.body, color: colors.ink, fontWeight: '800' },
  chevron: { fontSize: 25, color: colors.muted },
  darkLabel: { ...type.label, color: colors.signal },
  darkTitle: { ...type.h2, color: colors.white },
  darkCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.6)' },
});
