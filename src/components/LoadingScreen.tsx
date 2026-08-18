import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

/**
 * Shown while persisted state is being read. Uses the same slow breathing
 * motion as the market rail so the first frame already feels like Juva.
 */
export function LoadingScreen({ label = 'PREPARING YOUR MARKET' }: { label?: string }) {
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.logo}>JUVA</Text>
        <View style={styles.row}>
          <Animated.View style={[styles.dot, { opacity }]} />
          <Text style={styles.label}>{label}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  logo: { ...type.label, color: colors.ink, fontSize: 14, letterSpacing: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.signalDeep },
  label: { ...type.label, fontSize: 9, color: colors.muted },
});
