import { StyleSheet, Text, View } from 'react-native';

import type { Freshness } from '@/domain/types';
import { colors } from '@/theme/colors';
import { type } from '@/theme/type';

/**
 * `demo` deliberately reads DEMO, never LIVE. Price provenance is part of the
 * product promise, so it is rendered from the observation rather than inferred.
 */
const map: Record<Freshness, { text: string; bg: string }> = {
  live: { text: 'LIVE', bg: colors.forestSoft },
  recent: { text: 'RECENT', bg: colors.blueSoft },
  older: { text: 'OLDER', bg: colors.amberSoft },
  verify: { text: 'VERIFY', bg: colors.redSoft },
  demo: { text: 'DEMO', bg: colors.paperStrong },
};

export function FreshnessBadge({ value }: { value: Freshness }) {
  const tone = map[value];
  return (
    <View style={[styles.base, { backgroundColor: tone.bg }]}>
      <Text style={styles.text}>{tone.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 9 },
  text: { ...type.label, color: colors.ink, fontSize: 9, letterSpacing: 0.8 },
});
