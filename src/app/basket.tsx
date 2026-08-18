import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { MetricPill } from '@/components/MetricPill';
import { SectionLabel } from '@/components/SectionLabel';
import { TopBar } from '@/components/TopBar';
import { brandPolicyChip, nextBrandPolicy } from '@/domain/brandPolicyCopy';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

export default function BasketScreen() {
  const { activeList, preferences, updateListItem, removeListItem, addListItem } = useJuva();
  const [newItem, setNewItem] = useState('');

  if (!activeList) {
    return (
      <AppScreen>
        <TopBar back title="Your basket" />
        <Text style={styles.empty}>No active grocery list.</Text>
        <JuvaButton label="Start a list" onPress={() => router.replace('/')} />
      </AppScreen>
    );
  }

  return (
    <AppScreen
      footer={
        <View style={styles.footer}>
          <JuvaButton
            label="Find the best basket"
            variant="dark"
            onPress={() => router.push('/searching')}
          />
        </View>
      }
    >
      <TopBar back title="Your basket" eyebrow="REVIEW BEFORE SEARCH" />

      <View style={styles.hero}>
        <Text style={styles.title}>{activeList.title}</Text>
        <Text style={styles.prompt}>“{activeList.prompt}”</Text>
        <View style={styles.pills}>
          <MetricPill label={`${activeList.items.length} items`} />
          {activeList.budgetCents ? (
            <MetricPill
              label={`${formatMoney(activeList.budgetCents, activeList.currency)} budget`}
            />
          ) : null}
          <MetricPill label={`${preferences.maxStores} stores max`} />
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <SectionLabel>Items</SectionLabel>
        <Text style={styles.sectionMeta}>tap brand mode to change</Text>
      </View>

      <View style={styles.list}>
        {activeList.items.map((item, index) => (
          <View key={item.id} style={styles.item}>
            <View style={styles.index}>
              <Text style={styles.indexText}>{String(index + 1).padStart(2, '0')}</Text>
            </View>
            <View style={styles.itemBody}>
              <TextInput
                value={item.displayName}
                onChangeText={(displayName) =>
                  updateListItem(item.id, { displayName, concept: displayName.toLowerCase() })
                }
                style={styles.itemName}
              />
              <View style={styles.itemMetaRow}>
                <Text style={styles.itemMeta}>{item.unit}</Text>
                <Pressable
                  onPress={() => {
                    // Cycles strictest to loosest, then wraps. Four states now, so
                    // the label is shortened rather than the cycle.
                    const current = item.brandPolicy ?? preferences.brandPolicy;
                    updateListItem(item.id, { brandPolicy: nextBrandPolicy(current) });
                  }}
                  style={styles.policy}
                >
                  <Text style={styles.policyText}>
                    {brandPolicyChip(item.brandPolicy ?? preferences.brandPolicy)}
                  </Text>
                </Pressable>
              </View>
            </View>
            <Pressable onPress={() => removeListItem(item.id)} hitSlop={8}>
              <Text style={styles.remove}>×</Text>
            </Pressable>
          </View>
        ))}
      </View>

      <View style={styles.addRow}>
        <TextInput
          value={newItem}
          onChangeText={setNewItem}
          onSubmitEditing={() => {
            addListItem(newItem);
            setNewItem('');
          }}
          placeholder="Add another item"
          placeholderTextColor={colors.muted}
          style={styles.addInput}
          returnKeyType="done"
        />
        <Pressable
          onPress={() => {
            addListItem(newItem);
            setNewItem('');
          }}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      <View style={styles.searchScope}>
        <SectionLabel>Search scope</SectionLabel>
        <View style={styles.scopeRow}>
          <Text style={styles.scopeLabel}>Area</Text>
          <Text style={styles.scopeValue}>{preferences.location.label}</Text>
        </View>
        <View style={styles.scopeRow}>
          <Text style={styles.scopeLabel}>Radius</Text>
          <Text style={styles.scopeValue}>{preferences.radiusMiles} miles</Text>
        </View>
        <View style={styles.scopeRow}>
          <Text style={styles.scopeLabel}>Transport</Text>
          <Text style={styles.scopeValue}>{preferences.transportMode}</Text>
        </View>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  footer: { paddingBottom: 2 },
  empty: { ...type.body, color: colors.muted },
  hero: { gap: spacing.sm },
  title: { ...type.display, color: colors.ink },
  prompt: { ...type.body, color: colors.muted, maxWidth: 350 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionMeta: { ...type.bodySmall, color: colors.muted },
  list: { gap: spacing.xs },
  item: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  index: {
    width: 34,
    height: 34,
    borderRadius: 13,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indexText: { ...type.label, color: colors.signal, letterSpacing: 0.4 },
  itemBody: { flex: 1, gap: 5 },
  itemName: { ...type.body, color: colors.ink, fontWeight: '900', padding: 0 },
  itemMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  itemMeta: { ...type.bodySmall, color: colors.muted },
  policy: {
    backgroundColor: colors.paperStrong,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  policyText: { ...type.label, fontSize: 8, letterSpacing: 0.6, color: colors.inkSoft },
  remove: { fontSize: 23, color: colors.muted, padding: 4 },
  addRow: { flexDirection: 'row', gap: spacing.sm },
  addInput: {
    flex: 1,
    minHeight: 54,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: spacing.md,
    ...type.bodySmall,
    color: colors.ink,
  },
  addButton: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: colors.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: { fontSize: 24, color: colors.ink },
  searchScope: {
    backgroundColor: colors.paperStrong,
    borderRadius: 24,
    padding: spacing.lg,
    gap: spacing.md,
  },
  scopeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  scopeLabel: { ...type.bodySmall, color: colors.muted },
  scopeValue: {
    ...type.bodySmall,
    color: colors.ink,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
});
