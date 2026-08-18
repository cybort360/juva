import { StyleSheet, Text, View } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import { colors } from '@/theme/colors';

export type ComposerMode = 'describe' | 'paste';

interface Props {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
}

/**
 * How the shopper wants to enter their basket.
 *
 * Two glyph buttons rather than a segmented control, so they sit inside the
 * composer alongside the send action instead of adding a row of chrome above it.
 * The glyphs match the ones the composer already used — this replaces decorative
 * marks with the working controls they were standing in for.
 */
export function ComposerModes({ mode, onChange }: Props) {
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      <JuvaPressable
        onPress={() => onChange('describe')}
        feedback="select"
        accessibilityRole="radio"
        accessibilityState={{ selected: mode === 'describe' }}
        accessibilityLabel="Describe what you need"
        accessibilityHint="Write a sentence and Juva interprets it"
        style={[styles.glyph, mode === 'describe' && styles.glyphActive]}
      >
        <Text style={[styles.glyphText, mode === 'describe' && styles.glyphTextActive]}>⌁</Text>
      </JuvaPressable>
      <JuvaPressable
        onPress={() => onChange('paste')}
        feedback="select"
        accessibilityRole="radio"
        accessibilityState={{ selected: mode === 'paste' }}
        accessibilityLabel="Paste or type a list"
        accessibilityHint="One item per line"
        style={[styles.glyph, mode === 'paste' && styles.glyphActive]}
      >
        <Text style={[styles.glyphText, mode === 'paste' && styles.glyphTextActive]}>≡</Text>
      </JuvaPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  glyph: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphActive: { backgroundColor: colors.ink },
  glyphText: { fontSize: 19, color: colors.ink, lineHeight: 24 },
  glyphTextActive: { color: colors.signal },
});

export const composerCopy: Record<ComposerMode, { placeholder: string; hint: string }> = {
  describe: {
    placeholder: 'Weekly groceries for two under $80',
    hint: 'Describe your grocery list',
  },
  paste: {
    placeholder: 'Milk\n2 x eggs\n3 lb tomatoes',
    hint: 'Paste or type your list, one item per line',
  },
};
