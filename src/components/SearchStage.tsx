import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { LiveDot } from '@/components/LiveDot';
import { DURATION, EASING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

export type StageState = 'waiting' | 'active' | 'done';

interface Props {
  name: string;
  detail: string;
  state: StageState;
  /** Position in the list, used to stagger the initial appearance. */
  index: number;
}

/**
 * One row of the live-search choreography.
 *
 * A store "activates" by filling to ink and lifting slightly, then settles back
 * as it completes. The colour transition is interpolated on the UI thread so the
 * rhythm stays even while the optimizer is working on the JS thread — the exact
 * situation where a JS-driven animation would stutter and make a fast search look
 * broken.
 */
export function SearchStage({ name, detail, state, index }: Props) {
  const reduced = useReducedMotion();
  const activation = useSharedValue(0);
  const entered = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      entered.value = 1;
      return;
    }
    entered.value = withDelay(
      index * 70,
      withTiming(1, { duration: DURATION.snap, easing: EASING.enter }),
    );
  }, [entered, index, reduced]);

  useEffect(() => {
    const target = state === 'active' ? 1 : 0;
    activation.value = reduced
      ? target
      : withTiming(target, { duration: DURATION.snap, easing: EASING.snap });
  }, [state, activation, reduced]);

  const rowStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      activation.value,
      [0, 1],
      ['rgba(255,255,255,0.55)', colors.ink],
    ),
    borderColor: interpolateColor(activation.value, [0, 1], [colors.border, colors.ink]),
    transform: [
      { translateY: (1 - entered.value) * 8 - activation.value * 2 },
      { scale: reduced ? 1 : 0.99 + entered.value * 0.01 },
    ],
    opacity: entered.value,
  }));

  const nameStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      activation.value,
      [0, 1],
      [state === 'done' ? colors.ink : colors.muted, colors.white],
    ),
  }));

  const detailStyle = useAnimatedStyle(() => ({
    color: interpolateColor(activation.value, [0, 1], [colors.muted, 'rgba(255,255,255,0.6)']),
  }));

  return (
    <Animated.View
      style={[styles.task, rowStyle]}
      accessibilityRole="progressbar"
      accessibilityLabel={`${name}: ${state === 'done' ? 'complete' : state === 'active' ? detail : 'waiting'}`}
    >
      <View style={styles.taskLeft}>
        <LiveDot active={state === 'active'} />
        <View style={styles.labels}>
          <Animated.Text style={[styles.taskName, nameStyle]} allowFontScaling>
            {name}
          </Animated.Text>
          <Animated.Text style={[styles.taskDetail, detailStyle]} allowFontScaling>
            {state === 'done' ? 'complete' : detail}
          </Animated.Text>
        </View>
      </View>
      <Text style={[styles.taskState, state === 'done' && styles.taskDone]}>
        {state === 'done' ? '✓' : state === 'active' ? '●' : '○'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  task: {
    minHeight: 66,
    borderRadius: 20,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
  },
  taskLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  labels: { flex: 1 },
  taskName: { ...type.bodySmall, fontWeight: '900' },
  taskDetail: { ...type.bodySmall, fontSize: 12 },
  taskState: { ...type.body, color: colors.line, fontWeight: '900' },
  taskDone: { color: colors.signalDeep },
});
