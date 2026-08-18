import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { FreshnessBadge } from '@/components/FreshnessBadge';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaPressable } from '@/components/Pressable';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { env } from '@/config/runtimeEnv';
import { brandPolicyTitle } from '@/domain/brandPolicyCopy';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

const RETENTION_OPTIONS = [
  { days: 0, label: 'Not at all' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const;

export default function SettingsScreen() {
  const { preferences, updatePreferences, clearAll, deleteAllReceiptImages, lastSnapshot } =
    useJuva();
  return (
    <AppScreen>
      <TopBar back title="Preferences" eyebrow="JUVA SETTINGS" />
      <SectionLabel>Shopping area</SectionLabel>
      <Surface>
        <Text style={styles.label}>ZIP / POSTCODE</Text>
        <TextInput
          value={preferences.location.postalCode ?? ''}
          onChangeText={(postalCode) =>
            updatePreferences({
              location: {
                ...preferences.location,
                postalCode,
                label: postalCode || preferences.location.label,
              },
            })
          }
          style={styles.input}
        />
        <Text style={styles.label}>SEARCH RADIUS</Text>
        <View style={styles.segments}>
          {[2, 5, 10].map((value) => (
            <Pressable
              key={value}
              onPress={() => updatePreferences({ radiusMiles: value })}
              style={[styles.segment, preferences.radiusMiles === value && styles.segmentActive]}
            >
              <Text
                style={[
                  styles.segmentText,
                  preferences.radiusMiles === value && styles.segmentTextActive,
                ]}
              >
                {value} mi
              </Text>
            </Pressable>
          ))}
        </View>
      </Surface>
      <SectionLabel>Optimization</SectionLabel>
      <Surface>
        <Text style={styles.label}>MAXIMUM STORES</Text>
        <View style={styles.segments}>
          {[1, 2, 3].map((value) => (
            <Pressable
              key={value}
              onPress={() => updatePreferences({ maxStores: value })}
              style={[styles.segment, preferences.maxStores === value && styles.segmentActive]}
            >
              <Text
                style={[
                  styles.segmentText,
                  preferences.maxStores === value && styles.segmentTextActive,
                ]}
              >
                {value}
                {value === 3 ? '+' : ''}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.label}>DEFAULT BRAND POLICY</Text>
        <View style={styles.stack}>
          {(['exact_product', 'exact_brand', 'flexible', 'cheapest'] as const).map((value) => (
            <Pressable
              key={value}
              onPress={() => updatePreferences({ brandPolicy: value })}
              style={[styles.option, preferences.brandPolicy === value && styles.optionActive]}
            >
              <Text style={styles.optionText}>{brandPolicyTitle(value)}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>GETTING THERE</Text>
        <View style={styles.segments}>
          {(['drive', 'walk', 'transit'] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`Travel by ${value}`}
              onPress={() => updatePreferences({ transportMode: value })}
              style={[styles.segment, preferences.transportMode === value && styles.segmentActive]}
            >
              <Text
                style={[
                  styles.segmentText,
                  preferences.transportMode === value && styles.segmentTextActive,
                ]}
              >
                {value === 'drive' ? 'Drive' : value === 'walk' ? 'Walk' : 'Transit'}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>PRICE VS CONVENIENCE</Text>
        <View style={styles.segments}>
          {(
            [
              { label: 'Lowest price', value: 0 },
              { label: 'Balanced', value: 0.5 },
              { label: 'Convenience', value: 1 },
            ] as const
          ).map((option) => (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              accessibilityLabel={`Prioritise ${option.label.toLowerCase()}`}
              onPress={() => updatePreferences({ conveniencePreference: option.value })}
              style={[
                styles.segment,
                preferences.conveniencePreference === option.value && styles.segmentActive,
              ]}
            >
              <Text
                style={[
                  styles.optionText,
                  preferences.conveniencePreference === option.value && styles.segmentTextActive,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.privacy}>
          Sets how heavily Juva weighs travel, time and extra stops against basket price. It never
          changes a price — only which plan Juva recommends.
        </Text>
      </Surface>
      <SectionLabel>Market data</SectionLabel>
      <Surface>
        <View style={styles.statusRow}>
          <View style={styles.statusText}>
            <Text style={styles.label}>PRICE SOURCE</Text>
            <Text style={styles.statusValue}>
              {env.marketMode === 'demo'
                ? "Juva's controlled demo market"
                : 'Configured retailer feeds'}
            </Text>
          </View>
          {env.marketMode === 'demo' ? <FreshnessBadge value="demo" /> : null}
        </View>
        <Text style={styles.privacy}>
          {env.marketMode === 'demo'
            ? 'Demo prices are deterministic, work offline, and are labelled DEMO everywhere they appear. They never count as live retailer prices.'
            : `Prices come from ${env.apiBaseUrl ?? 'the configured market API'} with retailer, store, source, timestamp, confidence and freshness attached. Coverage is partial: items no source can price are listed rather than estimated.`}
        </Text>
        {lastSnapshot && lastSnapshot.mode === 'remote' ? (
          <View style={styles.issues}>
            <Text style={styles.label}>LAST SEARCH</Text>
            <Text style={styles.issue}>
              {lastSnapshot.storeCount} stores in range · {lastSnapshot.matchedProductCount} matched
              listings · weakest freshness {lastSnapshot.weakestFreshness}
              {lastSnapshot.partial ? ' · some sources did not answer' : ''}
            </Text>
            {lastSnapshot.unpricedConcepts.length > 0 ? (
              <Text style={styles.issue}>
                Not priced: {lastSnapshot.unpricedConcepts.join(', ')}
              </Text>
            ) : null}
            {lastSnapshot.attributions.map((attribution) => (
              <Text key={attribution.name} style={styles.issue}>
                {attribution.notice ?? `${attribution.name} — ${attribution.licence}`}
              </Text>
            ))}
          </View>
        ) : null}
        <Text style={styles.label}>BUILD PROFILE</Text>
        <Text style={styles.statusValue}>{env.environment}</Text>
        {env.issues.length > 0 ? (
          <View style={styles.issues}>
            {env.issues.map((issue) => (
              <Text
                key={`${issue.key}-${issue.message}`}
                style={[styles.issue, issue.severity === 'error' && styles.issueError]}
              >
                {issue.severity === 'error' ? '● ' : '○ '}
                {issue.key}: {issue.message}
              </Text>
            ))}
          </View>
        ) : null}
      </Surface>
      <SectionLabel>Receipt images</SectionLabel>
      <Surface>
        <Text style={styles.privacy}>
          A receipt photograph shows what you bought, where and when. Juva keeps them on this device
          only, for as long as you choose, and sends a copy to the extraction API only at the moment
          you ask it to read one.
        </Text>
        <Text style={styles.label}>KEEP IMAGES FOR</Text>
        <View style={styles.segments} accessibilityRole="radiogroup">
          {RETENTION_OPTIONS.map((option) => {
            const active = preferences.receiptImageRetentionDays === option.days;
            return (
              <JuvaPressable
                key={option.days}
                onPress={() => updatePreferences({ receiptImageRetentionDays: option.days })}
                feedback="select"
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Keep receipt images for ${option.label}`}
                style={[styles.segment, active && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {option.label}
                </Text>
              </JuvaPressable>
            );
          })}
        </View>
        <Text style={styles.privacy}>
          {preferences.receiptImageRetentionDays === 0
            ? 'Images are deleted the moment the receipt has been read. Nothing is kept.'
            : `Images older than ${preferences.receiptImageRetentionDays} days are deleted the next time Juva opens. The figures already read from them are kept.`}
        </Text>
        <JuvaButton
          label="Delete all receipt images now"
          variant="ghost"
          onPress={() =>
            Alert.alert(
              'Delete receipt images?',
              'Every receipt photograph on this device is deleted. Verified savings and receipt figures are kept.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => void deleteAllReceiptImages(),
                },
              ],
            )
          }
        />
      </Surface>
      <SectionLabel>Data</SectionLabel>
      <Surface>
        <Text style={styles.privacy}>
          Everything else — your lists, trips, receipts figures and savings history — is stored on
          this device. Juva has no account, and sends nothing to an analytics service.
        </Text>
        <JuvaButton
          label="Delete all local Juva data"
          variant="ghost"
          onPress={() =>
            Alert.alert(
              'Delete Juva data?',
              'This removes local lists, trips, receipts and savings history from this device.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => void clearAll().then(() => router.replace('/onboarding')),
                },
              ],
            )
          }
        />
      </Surface>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  label: { ...type.label, color: colors.muted },
  input: {
    minHeight: 54,
    borderRadius: 18,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    ...type.body,
    color: colors.ink,
  },
  segments: { flexDirection: 'row', gap: spacing.xs },
  segment: {
    flex: 1,
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: colors.paperStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: colors.ink },
  segmentText: { ...type.bodySmall, color: colors.muted, fontWeight: '900' },
  segmentTextActive: { color: colors.white },
  stack: { gap: spacing.xs },
  option: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  optionActive: { borderColor: colors.ink, borderWidth: 2 },
  optionText: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
  privacy: { ...type.bodySmall, color: colors.muted },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  statusText: { flex: 1 },
  statusValue: {
    ...type.bodySmall,
    color: colors.ink,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
  issues: {
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  issue: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
  issueError: { color: colors.red, fontWeight: '800' },
});
