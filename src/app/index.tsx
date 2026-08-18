import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { ComposerModes, composerCopy, type ComposerMode } from '@/components/ComposerModes';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { JuvaPressable } from '@/components/Pressable';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { isDemoMarket } from '@/config/runtimeEnv';
import { confirmedRecords, verifiedSavingsTotalCents } from '@/domain/savings';
import { hapticWarn } from '@/motion/haptics';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

const prompts = [
  'Weekly groceries for two under $80',
  'Milk, eggs, rice, chicken, bread, cereal',
  'Cheapest breakfast groceries nearby',
];

export default function HomeScreen() {
  const [mode, setMode] = useState<ComposerMode>('describe');
  const [unreadable, setUnreadable] = useState(false);
  const {
    preferences,
    draftPrompt,
    setDraftPrompt,
    createListFromPrompt,
    loadDemoBasket,
    savedLists,
    savingsRecords,
  } = useJuva();

  // The layout holds rendering until state is hydrated, so `preferences` here is
  // always the shopper's real state rather than the initial default.
  useEffect(() => {
    if (!preferences.onboarded) router.replace('/onboarding');
  }, [preferences.onboarded]);

  const run = () => {
    const value = draftPrompt.trim();
    if (!value) return;
    const list = createListFromPrompt(value, mode === 'paste' ? 'paste' : 'prompt');
    // Nothing readable means nothing to review; say so rather than opening an
    // empty basket the shopper then has to back out of.
    if (list.items.length === 0) {
      hapticWarn();
      setUnreadable(true);
      return;
    }
    setUnreadable(false);
    router.push('/basket');
  };

  const currency = savingsRecords[0]?.currency ?? 'USD';
  const verified = verifiedSavingsTotalCents(savingsRecords);
  const verifiedTrips = confirmedRecords(savingsRecords).length;

  return (
    <AppScreen footer={<JuvaRail />}>
      <View style={styles.topRow}>
        <View>
          <Text style={styles.logo}>JUVA</Text>
          <Text style={styles.location}>
            {preferences.location.label} · within {preferences.radiusMiles} mi
          </Text>
        </View>
        <JuvaPressable
          onPress={() => router.push('/profile')}
          accessibilityRole="link"
          accessibilityLabel="Juva Space"
          style={styles.orb}
        >
          <View style={styles.orbInner} />
        </JuvaPressable>
      </View>

      <View style={styles.heroCopy}>
        <Text style={styles.kicker}>YOUR GROCERY SHOPPING AGENT</Text>
        <Text style={styles.title}>What do you need?</Text>
        <Text style={styles.subtitle}>
          Juva finds the cheapest practical way it can to buy your basket from the stores it can see
          nearby.
        </Text>
      </View>

      <View style={styles.composer}>
        <TextInput
          value={draftPrompt}
          onChangeText={setDraftPrompt}
          multiline
          placeholder={composerCopy[mode].placeholder}
          placeholderTextColor={colors.muted}
          style={styles.input}
          textAlignVertical="top"
          accessibilityLabel={composerCopy[mode].hint}
          // A pasted list is read line by line, so newlines must stay in the field.
          blurOnSubmit={false}
          allowFontScaling
        />
        <View style={styles.composerBottom}>
          <ComposerModes mode={mode} onChange={setMode} />
          <JuvaPressable
            onPress={run}
            disabled={!draftPrompt.trim()}
            accessibilityLabel="Build my basket"
            accessibilityHint={
              mode === 'paste' ? 'Reads your list line by line' : 'Interprets what you described'
            }
            style={styles.go}
          >
            <Text style={styles.goText}>→</Text>
          </JuvaPressable>
        </View>
      </View>

      {unreadable ? (
        <Text style={styles.unreadable} accessibilityLiveRegion="polite" allowFontScaling>
          Juva could not read an item in that. Try one item per line, or tap a suggestion below.
        </Text>
      ) : null}

      <View style={styles.quickRow}>
        {prompts.slice(0, 2).map((prompt) => (
          <JuvaPressable
            key={prompt}
            onPress={() => {
              setMode('describe');
              setUnreadable(false);
              setDraftPrompt(prompt);
            }}
            feedback="select"
            accessibilityLabel={`Use the example: ${prompt}`}
            style={styles.quick}
          >
            <Text numberOfLines={2} style={styles.quickText} allowFontScaling>
              {prompt}
            </Text>
          </JuvaPressable>
        ))}
      </View>

      <Surface dark>
        <View style={styles.surfaceTop}>
          <View>
            <Text style={styles.darkLabel}>VERIFIED SAVINGS</Text>
            <Text style={styles.darkAmount}>{formatMoney(verified, currency)}</Text>
          </View>
          <Text style={styles.darkMeta}>{verifiedTrips} trips</Text>
        </View>
        <Text style={styles.darkCopy}>
          Only receipt-verified savings count here. Estimated savings stay separate.
        </Text>
        <Pressable onPress={() => router.push('/history')}>
          <Text style={styles.darkLink}>Open history →</Text>
        </Pressable>
      </Surface>

      <View style={styles.sectionHeader}>
        <SectionLabel>Fast start</SectionLabel>
        <Text style={styles.sectionMeta}>real optimization engine</Text>
      </View>
      <Surface signal>
        <Text style={styles.demoTitle}>
          {isDemoMarket ? "Run Juva's controlled market" : 'Start from the standard basket'}
        </Text>
        <Text style={styles.demoCopy}>
          {isDemoMarket
            ? '12 common groceries, three nearby stores, promotions, travel cost and receipt verification. Fully offline and labelled DEMO.'
            : '12 common groceries priced against the stores currently configured around you.'}
        </Text>
        <JuvaButton
          label={isDemoMarket ? 'Load the demo basket' : 'Load the standard basket'}
          variant="dark"
          onPress={() => {
            loadDemoBasket();
            router.push('/basket');
          }}
        />
      </Surface>

      {savedLists.length > 0 ? (
        <View style={styles.savedBlock}>
          <SectionLabel>Your baskets</SectionLabel>
          {savedLists.slice(0, 2).map((list) => (
            <Surface key={list.id}>
              <Text style={styles.savedTitle}>{list.title}</Text>
              <Text style={styles.savedMeta}>{list.items.length} items · saved basket</Text>
            </Surface>
          ))}
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logo: { ...type.label, color: colors.ink, fontSize: 15, letterSpacing: 3.5 },
  location: { ...type.bodySmall, color: colors.muted, marginTop: 5 },
  orb: {
    width: 42,
    height: 42,
    borderRadius: 18,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbInner: { width: 13, height: 13, borderRadius: 7, backgroundColor: colors.signal },
  heroCopy: { gap: spacing.xs, marginTop: spacing.lg },
  kicker: { ...type.label, color: colors.signalDeep },
  title: { ...type.display, color: colors.ink, maxWidth: 330 },
  subtitle: { ...type.body, color: colors.muted, maxWidth: 340 },
  composer: {
    minHeight: 190,
    borderRadius: 30,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    shadowColor: colors.black,
    shadowOpacity: 0.05,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  input: { flex: 1, minHeight: 92, ...type.h2, color: colors.ink, padding: 0 },
  composerBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  inputActions: { flexDirection: 'row', gap: 10 },
  actionGlyph: {
    width: 40,
    height: 40,
    textAlign: 'center',
    lineHeight: 40,
    borderRadius: 14,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontSize: 20,
  },
  go: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: colors.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadable: { ...type.bodySmall, color: colors.amber, marginTop: -spacing.xs },
  goText: { fontSize: 26, color: colors.ink, marginTop: -2 },
  quickRow: { flexDirection: 'row', gap: spacing.sm },
  quick: {
    flex: 1,
    minHeight: 78,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paperStrong,
    padding: spacing.md,
    justifyContent: 'center',
  },
  quickText: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
  surfaceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  darkLabel: { ...type.label, color: 'rgba(255,255,255,0.5)' },
  darkAmount: { ...type.display, color: colors.white, marginTop: 5 },
  darkMeta: { ...type.bodySmall, color: colors.signal, fontWeight: '900' },
  darkCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.62)', maxWidth: 300 },
  darkLink: { ...type.bodySmall, color: colors.white, fontWeight: '900' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionMeta: { ...type.bodySmall, color: colors.muted },
  demoTitle: { ...type.h2, color: colors.ink },
  demoCopy: { ...type.bodySmall, color: colors.inkSoft },
  savedBlock: { gap: spacing.sm },
  savedTitle: { ...type.h2, color: colors.ink },
  savedMeta: { ...type.bodySmall, color: colors.muted },
});
