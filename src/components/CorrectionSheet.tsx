import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import type { CurrencyCode, ReceiptLine, ReconciledItem } from '@/domain/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { decimalToCents, formatMoney } from '@/utils/money';

/**
 * Correcting a line after the shop.
 *
 * Shop Mode only accepts changes for the aisle the shopper is standing in, which is the
 * right rule while shopping and useless at the kitchen table. Everything noticed later
 * arrives here instead — and lands in `corrections`, never in the trip's adaptation log,
 * because that log is the record of what was decided *in* the shop and rewriting it to
 * fit a later discovery would destroy the history it exists to keep.
 *
 * Three figures are always shown together: what Juva planned, what the receipt says, and
 * what the shopper is telling it. A correction with no visible planned figure beside it
 * is just a number the shopper has to trust.
 */

export type CorrectionKind =
  | 'price_differed'
  | 'quantity_differed'
  | 'package_differed'
  | 'unreported_substitute'
  | 'never_purchased';

export interface CorrectionDraft {
  kind: CorrectionKind;
  actualCents?: number;
  actualQuantity?: number;
  actualSizeLabel?: string;
  substituteTitle?: string;
  note?: string;
}

interface Props {
  item: ReconciledItem;
  /** The receipt line the engine matched, when it found one. */
  matchedLine?: ReceiptLine | undefined;
  currency: CurrencyCode;
  onSubmit: (draft: CorrectionDraft) => void;
  onClose: () => void;
}

type Mode = 'menu' | CorrectionKind;

export function CorrectionSheet({ item, matchedLine, currency, onSubmit, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('menu');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [size, setSize] = useState('');
  const [substitute, setSubstitute] = useState('');

  const submit = (draft: CorrectionDraft): void => {
    onSubmit(draft);
    onClose();
  };

  return (
    <View style={styles.sheet}>
      {/* The evidence, before any control. */}
      <View style={styles.evidence}>
        <Evidence
          label="PLANNED"
          value={item.productName}
          amount={formatMoney(item.expectedCents, currency)}
        />
        <Evidence
          label="RECEIPT"
          value={
            matchedLine ? matchedLine.productName || matchedLine.rawText : 'No confident match'
          }
          amount={matchedLine ? formatMoney(matchedLine.chargedPriceCents, currency) : '—'}
          muted={!matchedLine}
        />
      </View>

      {mode === 'menu' ? (
        <>
          <Text style={styles.label}>YOUR CORRECTION</Text>
          <View style={styles.grid}>
            <Action label="Price differed" onPress={() => setMode('price_differed')} />
            <Action label="Quantity differed" onPress={() => setMode('quantity_differed')} />
            <Action label="Different package" onPress={() => setMode('package_differed')} />
            <Action
              label="I bought a substitute"
              onPress={() => setMode('unreported_substitute')}
            />
            <Action
              label="I didn’t buy this"
              tone="amber"
              onPress={() => submit({ kind: 'never_purchased' })}
            />
          </View>
          <JuvaPressable
            onPress={onClose}
            feedback="tap"
            accessibilityRole="button"
            accessibilityLabel="Close corrections"
            style={styles.dismiss}
          >
            <Text style={styles.dismissText}>CLOSE</Text>
          </JuvaPressable>
        </>
      ) : null}

      {mode === 'price_differed' ? (
        <Field
          label="WHAT WERE YOU ACTUALLY CHARGED?"
          value={price}
          onChange={setPrice}
          placeholder="0.00"
          keyboard="decimal-pad"
          accessibilityLabel={`Actual charged price for ${item.productName}`}
          onSubmit={() => {
            const cents = decimalToCents(price);
            if (cents !== null && cents > 0) submit({ kind: 'price_differed', actualCents: cents });
          }}
          onCancel={() => setMode('menu')}
        />
      ) : null}

      {mode === 'quantity_differed' ? (
        <Field
          label="HOW MANY DID YOU ACTUALLY BUY?"
          value={quantity}
          onChange={setQuantity}
          placeholder="1"
          keyboard="number-pad"
          accessibilityLabel={`Actual quantity for ${item.productName}`}
          onSubmit={() => {
            const next = Number(quantity);
            if (Number.isFinite(next) && next > 0) {
              submit({
                kind: 'quantity_differed',
                actualQuantity: next,
                ...(matchedLine === undefined
                  ? {}
                  : { actualCents: matchedLine.chargedPriceCents }),
              });
            }
          }}
          onCancel={() => setMode('menu')}
        />
      ) : null}

      {mode === 'package_differed' ? (
        <View style={styles.panel}>
          <Text style={styles.label}>WHAT SIZE DID YOU BUY?</Text>
          <TextInput
            value={size}
            onChangeText={setSize}
            placeholder="e.g. 0.5 gal"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoFocus
            accessibilityLabel={`Actual pack size for ${item.productName}`}
          />
          <TextInput
            value={price}
            onChangeText={setPrice}
            placeholder="Price you paid for it"
            placeholderTextColor={colors.muted}
            keyboardType="decimal-pad"
            style={styles.input}
            accessibilityLabel="Price paid for that size"
          />
          <View style={styles.row}>
            <Action
              label="Save"
              tone="ink"
              onPress={() => {
                const cents = decimalToCents(price);
                submit({
                  kind: 'package_differed',
                  actualSizeLabel: size.trim(),
                  ...(cents !== null && cents > 0 ? { actualCents: cents } : {}),
                });
              }}
            />
            <Action label="Back" onPress={() => setMode('menu')} />
          </View>
        </View>
      ) : null}

      {mode === 'unreported_substitute' ? (
        <View style={styles.panel}>
          <Text style={styles.label}>WHAT DID YOU BUY INSTEAD?</Text>
          <TextInput
            value={substitute}
            onChangeText={setSubstitute}
            placeholder="Product name"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoFocus
            accessibilityLabel={`Substitute bought instead of ${item.productName}`}
          />
          <TextInput
            value={price}
            onChangeText={setPrice}
            placeholder="Price you paid"
            placeholderTextColor={colors.muted}
            keyboardType="decimal-pad"
            style={styles.input}
            accessibilityLabel="Price paid for the substitute"
          />
          <View style={styles.row}>
            <Action
              label="Save"
              tone="ink"
              onPress={() => {
                const cents = decimalToCents(price);
                if (substitute.trim() === '') return;
                submit({
                  kind: 'unreported_substitute',
                  substituteTitle: substitute.trim(),
                  ...(cents !== null && cents > 0 ? { actualCents: cents } : {}),
                });
              }}
            />
            <Action label="Back" onPress={() => setMode('menu')} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Evidence({
  label,
  value,
  amount,
  muted,
}: {
  label: string;
  value: string;
  amount: string;
  muted?: boolean;
}) {
  return (
    <View style={styles.evidenceRow}>
      <Text style={styles.evidenceLabel}>{label}</Text>
      <View style={styles.evidenceBody}>
        <Text style={[styles.evidenceValue, muted === true && styles.evidenceMuted]}>{value}</Text>
      </View>
      <Text style={[styles.evidenceAmount, muted === true && styles.evidenceMuted]}>{amount}</Text>
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

function Field(props: {
  label: string;
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
  sheet: { gap: 8 },
  evidence: { gap: 4 },
  evidenceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 30 },
  evidenceLabel: { ...type.label, fontSize: 8, color: colors.muted, width: 62 },
  evidenceBody: { flex: 1 },
  evidenceValue: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
  evidenceAmount: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  evidenceMuted: { color: colors.muted },
  panel: { gap: 8, paddingTop: spacing.xs },
  label: { ...type.label, fontSize: 9, color: colors.muted, marginTop: spacing.xs },
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
