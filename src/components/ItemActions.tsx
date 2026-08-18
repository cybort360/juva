import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import type { ShopEvent, ShopEventKind } from '@/domain/shopAdapt';
import type { CurrencyCode, TripItem } from '@/domain/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { decimalToCents } from '@/utils/money';

/**
 * The seven things that can happen to a line in a shop.
 *
 * A contextual panel rather than a redesign of the row: the checklist keeps its two
 * primary actions — collect and skip — and everything rarer lives one tap behind a
 * "something's different" control. That ordering matches how often each is used, and it
 * keeps the scanning experience calm for the ninety per cent of lines where nothing
 * surprising happens.
 *
 * Each correction that needs a number opens a single field with a large target and a
 * numeric keypad, because the shopper is standing up and holding something.
 */

type Mode = 'menu' | 'price' | 'quantity' | 'package' | 'substitute';

interface Props {
  item: TripItem;
  currency: CurrencyCode;
  /** Marks the line collected or back to pending. */
  onCollect: () => void;
  onSkip: () => void;
  /** Sends a correction to the replanner. */
  onReport: (event: ShopEvent) => void;
  onClose: () => void;
}

export function ItemActions({ item, currency, onCollect, onSkip, onReport, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('menu');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState(String(item.actualQuantity ?? item.quantity));
  const [size, setSize] = useState(item.actualSizeLabel ?? item.sizeLabel);
  const [substituteName, setSubstituteName] = useState('');

  const report = (kind: ShopEventKind, extra: Partial<ShopEvent> = {}): void => {
    onReport({ kind, groceryItemId: item.groceryItemId, ...extra });
    onClose();
  };

  if (mode === 'menu') {
    return (
      <View style={styles.panel}>
        <Text style={styles.label}>WHAT&rsquo;S DIFFERENT?</Text>
        <View style={styles.grid}>
          <Action
            label={item.status === 'collected' ? 'Un-collect' : 'Collected'}
            onPress={() => {
              onCollect();
              onClose();
            }}
          />
          <Action label="Different price" onPress={() => setMode('price')} />
          <Action label="Not on the shelf" tone="amber" onPress={() => report('unavailable')} />
          <Action label="Substitute" onPress={() => setMode('substitute')} />
          <Action label="Different quantity" onPress={() => setMode('quantity')} />
          <Action label="Different size" onPress={() => setMode('package')} />
          <Action
            label={item.status === 'skipped' ? 'Un-skip' : 'Skip for now'}
            onPress={() => {
              onSkip();
              onClose();
            }}
          />
        </View>
        <Dismiss onPress={onClose} />
      </View>
    );
  }

  if (mode === 'price') {
    return (
      <Field
        label="ACTUAL SHELF PRICE"
        hint={`Juva expected ${(item.listPriceCents / 100).toFixed(2)} ${currency}`}
        value={price}
        onChange={setPrice}
        placeholder="0.00"
        keyboard="decimal-pad"
        accessibilityLabel={`Actual shelf price for ${item.productTitle}`}
        onSubmit={() => {
          const cents = decimalToCents(price);
          if (cents !== null && cents > 0) {
            report('different_price', { observedPriceCents: cents });
          }
        }}
        onCancel={() => setMode('menu')}
      />
    );
  }

  if (mode === 'quantity') {
    return (
      <Field
        label="HOW MANY ARE YOU TAKING?"
        hint={`Planned ${item.quantity}`}
        value={quantity}
        onChange={setQuantity}
        placeholder={String(item.quantity)}
        keyboard="number-pad"
        accessibilityLabel={`Quantity of ${item.productTitle}`}
        onSubmit={() => {
          const next = Number(quantity);
          // Zero is not a quantity change; it is doing without, and that route goes
          // through the replanner so the trip stops being comparable.
          if (Number.isFinite(next) && next > 0) {
            report('quantity_changed', { observedQuantity: next });
          }
        }}
        onCancel={() => setMode('menu')}
      />
    );
  }

  if (mode === 'package') {
    return (
      <View style={styles.panel}>
        <Text style={styles.label}>DIFFERENT SIZE</Text>
        <Text style={styles.hint}>Juva expected {item.sizeLabel}</Text>
        <TextInput
          value={size}
          onChangeText={setSize}
          placeholder="e.g. 36 oz"
          placeholderTextColor={colors.muted}
          style={styles.input}
          autoFocus
          accessibilityLabel={`Actual pack size for ${item.productTitle}`}
        />
        <TextInput
          value={price}
          onChangeText={setPrice}
          placeholder="Shelf price for that size"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          style={styles.input}
          accessibilityLabel={`Shelf price for the ${size} pack`}
        />
        {/* Stated up front rather than discovered afterwards: if the labels cannot be
            compared, Juva records both and does not pretend they are equivalent. */}
        <Text style={styles.note}>
          If Juva can&rsquo;t compare the two sizes it will say so rather than guess a per-unit
          price.
        </Text>
        <View style={styles.row}>
          <Action
            label="Save"
            tone="ink"
            onPress={() => {
              const cents = decimalToCents(price);
              report('different_package', {
                observedSizeLabel: size.trim() === '' ? item.sizeLabel : size.trim(),
                ...(cents !== null && cents > 0 ? { observedPriceCents: cents } : {}),
              });
            }}
          />
          <Action label="Back" onPress={() => setMode('menu')} />
        </View>
      </View>
    );
  }

  // Substitute. Asking the replanner with no manual entry lists what the cached market
  // actually has; typing a name is the fallback for a shelf Juva cannot see.
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>SUBSTITUTE</Text>
      <Text style={styles.hint}>
        Juva will show alternatives it can price, within your brand rule for this item.
      </Text>
      <View style={styles.row}>
        <Action label="Show alternatives" tone="ink" onPress={() => report('substitute')} />
        <Action label="Back" onPress={() => setMode('menu')} />
      </View>

      <Text style={styles.label}>OR TYPE WHAT YOU TOOK</Text>
      <TextInput
        value={substituteName}
        onChangeText={setSubstituteName}
        placeholder="Product name"
        placeholderTextColor={colors.muted}
        style={styles.input}
        accessibilityLabel={`Substitute product for ${item.requestedName}`}
      />
      <TextInput
        value={price}
        onChangeText={setPrice}
        placeholder="Its shelf price"
        placeholderTextColor={colors.muted}
        keyboardType="decimal-pad"
        style={styles.input}
        accessibilityLabel="Shelf price for the substitute"
      />
      <Text style={styles.note}>
        A product Juva can&rsquo;t see stays unverified until your receipt confirms it.
      </Text>
      <Action
        label="Use this substitute"
        tone="ink"
        onPress={() => {
          const cents = decimalToCents(price);
          if (substituteName.trim() === '' || cents === null || cents <= 0) return;
          report('substitute', {
            manualSubstitute: { title: substituteName.trim(), priceCents: cents },
          });
        }}
      />
    </View>
  );
}

function Action({
  label,
  onPress,
  tone = 'paper',
}: {
  label: string;
  onPress: () => void;
  tone?: 'paper' | 'ink' | 'amber';
}) {
  return (
    <JuvaPressable
      onPress={onPress}
      feedback="select"
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        styles.action,
        tone === 'ink' && styles.actionInk,
        tone === 'amber' && styles.actionAmber,
      ]}
    >
      <Text
        style={[
          styles.actionText,
          tone === 'ink' && styles.actionTextInk,
          tone === 'amber' && styles.actionTextAmber,
        ]}
      >
        {label}
      </Text>
    </JuvaPressable>
  );
}

function Dismiss({ onPress }: { onPress: () => void }) {
  return (
    <JuvaPressable
      onPress={onPress}
      feedback="tap"
      accessibilityRole="button"
      accessibilityLabel="Close"
      style={styles.dismiss}
    >
      <Text style={styles.dismissText}>CLOSE</Text>
    </JuvaPressable>
  );
}

function Field(props: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  keyboard: 'decimal-pad' | 'number-pad';
  accessibilityLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>{props.label}</Text>
      <Text style={styles.hint}>{props.hint}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={props.keyboard}
        style={styles.input}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={props.onSubmit}
        accessibilityLabel={props.accessibilityLabel}
      />
      <View style={styles.row}>
        <Action label="Save" tone="ink" onPress={props.onSubmit} />
        <Action label="Back" onPress={props.onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8, paddingTop: spacing.sm },
  label: { ...type.label, fontSize: 9, color: colors.muted },
  hint: { ...type.bodySmall, fontSize: 12, color: colors.inkSoft },
  note: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  row: { flexDirection: 'row', gap: 6 },
  action: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionInk: { backgroundColor: colors.ink },
  actionAmber: { backgroundColor: 'rgba(214,143,43,0.14)' },
  actionText: { ...type.bodySmall, fontSize: 12, color: colors.ink, fontWeight: '900' },
  actionTextInk: { color: colors.white },
  actionTextAmber: { color: colors.amber },
  input: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: 12,
    color: colors.ink,
    ...type.body,
  },
  dismiss: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  dismissText: { ...type.label, fontSize: 9, color: colors.muted },
});
