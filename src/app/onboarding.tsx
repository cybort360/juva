import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaPressable } from '@/components/Pressable';
import { BRAND_POLICY_OPTIONS } from '@/domain/brandPolicyCopy';
import { track } from '@/services/analytics';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

/** Steps are 0-indexed; the last one commits and enters the app. */
const LAST_STEP = 5;

/**
 * Retailers whose loyalty pricing Juva can model, keyed by the same `retailerId`
 * the optimizer matches promotions against.
 */
const LOYALTY_RETAILERS = [
  { id: 'grove', name: 'Grove Market', detail: 'Members-only shelf prices' },
  { id: 'north', name: 'North Market', detail: 'Multi-buy and card offers' },
  { id: 'value', name: 'Value Foods', detail: 'Card discounts' },
] as const;

const BUDGET_PRIORITIES = [
  { value: 0, title: 'The lowest total, always', detail: 'Juva will send you further to save.' },
  { value: 0.5, title: 'Balanced', detail: 'Weigh the saving against the trip it costs.' },
  {
    value: 1,
    title: 'Keep it convenient',
    detail: 'Prefer one nearby stop unless a saving is large.',
  },
] as const;

export default function OnboardingScreen() {
  // Once per mount, not per render: a step change is not a new onboarding.
  useEffect(() => {
    track('onboarding_started');
  }, []);

  const { preferences, updatePreferences, completeOnboarding } = useJuva();
  const [step, setStep] = useState(0);
  const [area, setArea] = useState(preferences.location.postalCode ?? '11201');

  const finish = () => {
    track('onboarding_completed');
    completeOnboarding();
    router.replace('/');
  };

  return (
    <AppScreen
      contentStyle={styles.screen}
      footer={
        <View style={styles.footer}>
          {step > 0 ? (
            <Pressable onPress={() => setStep((s) => s - 1)}>
              <Text style={styles.back}>Back</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <JuvaButton
            label={step === LAST_STEP ? 'Start saving' : 'Continue'}
            variant="dark"
            style={styles.continue}
            onPress={() => {
              if (step === 1)
                updatePreferences({
                  location: { label: area === '11201' ? 'Brooklyn, NY' : area, postalCode: area },
                });
              if (step === LAST_STEP) finish();
              else setStep((s) => s + 1);
            }}
          />
        </View>
      }
    >
      <View style={styles.progress}>
        <View
          style={[styles.progressFill, { width: `${((step + 1) / (LAST_STEP + 1)) * 100}%` }]}
        />
      </View>
      <View style={styles.brand}>
        <Text style={styles.brandText}>JUVA</Text>
      </View>

      <View style={styles.body}>
        {step === 0 ? (
          <>
            <Text style={styles.kicker}>SHOP SMARTER AROUND YOU</Text>
            <Text style={styles.title}>The best basket isn’t always the cheapest store.</Text>
            <Text style={styles.copy}>
              Juva weighs price, distance, time and your preferences before recommending where to
              shop.
            </Text>
            <View style={styles.signalCard}>
              <Text style={styles.signalBig}>$18.42</Text>
              <Text style={styles.signalText}>example savings on a 12-item basket</Text>
            </View>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Text style={styles.kicker}>YOUR SHOPPING AREA</Text>
            <Text style={styles.title}>Where should Juva shop?</Text>
            <Text style={styles.copy}>Start with an area. Precise GPS is not required.</Text>
            <TextInput
              value={area}
              onChangeText={setArea}
              keyboardType="numbers-and-punctuation"
              style={styles.areaInput}
              placeholder="ZIP / postcode"
            />
            <Pressable
              onPress={() => {
                setArea('11201');
                updatePreferences({ location: { label: 'Brooklyn, NY', postalCode: '11201' } });
              }}
              style={styles.locationAction}
            >
              <Text style={styles.locationActionText}>◎ Use sample current area</Text>
            </Pressable>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Text style={styles.kicker}>TRAVEL TOLERANCE</Text>
            <Text style={styles.title}>How far is a saving worth?</Text>
            <Text style={styles.copy}>Choose a search radius. You can change this per basket.</Text>
            <View style={styles.choices}>
              {[2, 5, 10].map((miles) => (
                <Pressable
                  key={miles}
                  onPress={() => updatePreferences({ radiusMiles: miles })}
                  style={[styles.choice, preferences.radiusMiles === miles && styles.choiceActive]}
                >
                  <Text
                    style={[
                      styles.choiceBig,
                      preferences.radiusMiles === miles && styles.choiceBigActive,
                    ]}
                  >
                    {miles}
                  </Text>
                  <Text
                    style={[
                      styles.choiceSmall,
                      preferences.radiusMiles === miles && styles.choiceSmallActive,
                    ]}
                  >
                    miles
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.subLabel}>MAXIMUM STORES</Text>
            <View style={styles.segment}>
              {[1, 2, 3].map((count) => (
                <Pressable
                  key={count}
                  onPress={() => updatePreferences({ maxStores: count })}
                  style={[
                    styles.segmentItem,
                    preferences.maxStores === count && styles.segmentActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      preferences.maxStores === count && styles.segmentTextActive,
                    ]}
                  >
                    {count}
                    {count === 3 ? '+' : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <Text style={styles.kicker}>BRAND FLEXIBILITY</Text>
            <Text style={styles.title}>How should Juva handle alternatives?</Text>
            <Text style={styles.copy}>Exact preferences can still be set item by item.</Text>
            {BRAND_POLICY_OPTIONS.map(({ value, title, description }) => (
              <Pressable
                key={value}
                onPress={() => updatePreferences({ brandPolicy: value })}
                style={[styles.option, preferences.brandPolicy === value && styles.optionActive]}
              >
                <View
                  style={[styles.radio, preferences.brandPolicy === value && styles.radioActive]}
                />
                <View style={styles.optionText}>
                  <Text style={styles.optionTitle}>{title}</Text>
                  <Text style={styles.optionCopy}>{description}</Text>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        {step === 4 ? (
          <>
            <Text style={styles.kicker}>LOYALTY MEMBERSHIPS</Text>
            <Text style={styles.title}>Which cards do you already carry?</Text>
            <Text style={styles.copy}>
              Juva only promises a members-only price when you hold that card. Leave a retailer off
              and its loyalty offers are ignored rather than assumed.
            </Text>
            {LOYALTY_RETAILERS.map((retailer) => {
              const held = preferences.loyaltyRetailers.includes(retailer.id);
              return (
                <JuvaPressable
                  key={retailer.id}
                  feedback="select"
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: held }}
                  accessibilityLabel={`${retailer.name} loyalty card`}
                  onPress={() =>
                    updatePreferences({
                      loyaltyRetailers: held
                        ? preferences.loyaltyRetailers.filter((id) => id !== retailer.id)
                        : [...preferences.loyaltyRetailers, retailer.id],
                    })
                  }
                  style={[styles.option, held && styles.optionActive]}
                >
                  <View style={[styles.radio, styles.radioSquare, held && styles.radioActive]} />
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle} allowFontScaling>
                      {retailer.name}
                    </Text>
                    <Text style={styles.optionCopy} allowFontScaling>
                      {retailer.detail}
                    </Text>
                  </View>
                </JuvaPressable>
              );
            })}
          </>
        ) : null}

        {step === 5 ? (
          <>
            <Text style={styles.kicker}>PRICE VS CONVENIENCE</Text>
            <Text style={styles.title}>What matters more on a normal week?</Text>
            <Text style={styles.copy}>
              This sets how heavily Juva weighs travel, time and extra stops against basket price.
              It never changes a price — only which plan it recommends.
            </Text>
            {BUDGET_PRIORITIES.map((option) => {
              const active = preferences.conveniencePreference === option.value;
              return (
                <JuvaPressable
                  key={option.title}
                  feedback="select"
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={option.title}
                  onPress={() => updatePreferences({ conveniencePreference: option.value })}
                  style={[styles.option, active && styles.optionActive]}
                >
                  <View style={[styles.radio, active && styles.radioActive]} />
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle} allowFontScaling>
                      {option.title}
                    </Text>
                    <Text style={styles.optionCopy} allowFontScaling>
                      {option.detail}
                    </Text>
                  </View>
                </JuvaPressable>
              );
            })}
          </>
        ) : null}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  /**
   * `flexGrow` rather than `flex`, because this is a ScrollView content container.
   *
   * The screen previously used `scroll={false}` with a `flex: 1` centred body, so any step
   * taller than the viewport overflowed in *both* directions — painting the eyebrow over
   * the JUVA wordmark and running the last option under the footer. Growing instead lets a
   * short step stay centred and a tall one scroll, which also survives large text sizes.
   */
  screen: { flexGrow: 1 },
  progress: { height: 3, backgroundColor: colors.paperStrong, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: colors.ink },
  brand: { marginTop: spacing.md },
  brandText: { ...type.label, color: colors.ink, fontSize: 14, letterSpacing: 3.5 },
  body: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.lg,
  },
  kicker: { ...type.label, color: colors.signalDeep },
  title: { ...type.display, color: colors.ink, maxWidth: 360 },
  copy: { ...type.body, color: colors.muted, maxWidth: 340 },
  signalCard: {
    backgroundColor: colors.signal,
    borderRadius: 30,
    padding: spacing.xl,
    marginTop: spacing.md,
  },
  signalBig: { ...type.displayXL, color: colors.ink },
  signalText: { ...type.bodySmall, color: colors.inkSoft, fontWeight: '800' },
  areaInput: {
    minHeight: 70,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    ...type.h2,
    color: colors.ink,
  },
  locationAction: { paddingVertical: spacing.sm },
  locationActionText: { ...type.bodySmall, color: colors.signalDeep, fontWeight: '900' },
  choices: { flexDirection: 'row', gap: spacing.sm },
  choice: {
    flex: 1,
    aspectRatio: 0.95,
    borderRadius: 24,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceBig: { ...type.h1, color: colors.ink },
  choiceBigActive: { color: colors.white },
  choiceSmall: { ...type.bodySmall, color: colors.muted },
  choiceSmallActive: { color: 'rgba(255,255,255,0.65)' },
  subLabel: { ...type.label, color: colors.muted, marginTop: spacing.md },
  segment: {
    flexDirection: 'row',
    borderRadius: 20,
    backgroundColor: colors.paperStrong,
    padding: 5,
  },
  segmentItem: {
    flex: 1,
    minHeight: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: colors.white },
  segmentText: { ...type.body, color: colors.muted, fontWeight: '900' },
  segmentTextActive: { color: colors.ink },
  option: {
    borderRadius: 22,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
  },
  optionActive: { borderColor: colors.ink, borderWidth: 2 },
  radioSquare: { borderRadius: 6 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.line },
  radioActive: { borderWidth: 5, borderColor: colors.ink },
  optionText: { flex: 1 },
  optionTitle: { ...type.body, color: colors.ink, fontWeight: '900' },
  optionCopy: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  back: { ...type.bodySmall, color: colors.ink, fontWeight: '900', padding: spacing.md },
  continue: { flex: 1 },
});
