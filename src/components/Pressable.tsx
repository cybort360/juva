import type { ReactNode } from 'react';
import { Pressable as RNPressable, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { hapticSelect, hapticTap } from '@/motion/haptics';
import { DURATION, PRESS_SCALE, SPRING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

interface Props {
  onPress: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Style layered on while pressed, for surfaces that also change colour. */
  pressedStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  /** `select` for choices that change state, `tap` for navigation. */
  feedback?: 'tap' | 'select' | 'none' | undefined;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  accessibilityRole?: 'button' | 'radio' | 'checkbox' | 'link';
  accessibilityState?: {
    selected?: boolean;
    checked?: boolean;
    disabled?: boolean;
    /** Announced while an action is in flight, so the reader says "busy". */
    busy?: boolean;
  };
  hitSlop?: number | undefined;
  testID?: string | undefined;
}

/**
 * Juva's tactile pressable.
 *
 * Three things every touchable in the product should do, in one place:
 * shrink slightly under the finger, fire the haptic that matches the *kind* of
 * action, and expose itself properly to a screen reader.
 *
 * Under reduced motion the scale is dropped but the opacity dip stays, because
 * some acknowledgement of a press is a usability need rather than decoration.
 */
/**
 * State is published twice, deliberately.
 *
 * `accessibilityState` is what iOS and Android read. react-native-web 0.21 no
 * longer forwards it, so on web a `role="checkbox"` was reaching the DOM with no
 * `aria-checked` at all — the reader announced "checkbox" and nothing about
 * whether the item was collected. The `aria-*` props are first-class in React
 * Native too and fold back into accessibilityState on native, so both paths
 * carry the same values and neither platform is left guessing.
 */
export function JuvaPressable({
  onPress,
  children,
  style,
  pressedStyle,
  disabled = false,
  feedback = 'tap',
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  hitSlop,
  testID,
}: Props) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);

  // Only emit the attributes that actually apply to this control's role.
  const ariaState = {
    ...(accessibilityState?.checked === undefined
      ? {}
      : { 'aria-checked': accessibilityState.checked }),
    ...(accessibilityState?.selected === undefined
      ? {}
      : { 'aria-selected': accessibilityState.selected }),
    ...(accessibilityState?.busy === undefined ? {} : { 'aria-busy': accessibilityState.busy }),
    'aria-disabled': disabled || accessibilityState?.disabled === true,
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: reduced ? [] : [{ scale: 1 - pressed.value * (1 - PRESS_SCALE) }],
    opacity: 1 - pressed.value * 0.14,
  }));

  return (
    <AnimatedPressable
      testID={testID}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...accessibilityState }}
      {...ariaState}
      hitSlop={hitSlop}
      onPressIn={() => {
        pressed.value = reduced
          ? withTiming(1, { duration: DURATION.tap })
          : withSpring(1, SPRING.tactile);
      }}
      onPressOut={() => {
        pressed.value = reduced
          ? withTiming(0, { duration: DURATION.tap })
          : withSpring(0, SPRING.tactile);
      }}
      onPress={() => {
        if (disabled) return;
        if (feedback === 'select') hapticSelect();
        else if (feedback === 'tap') hapticTap();
        onPress();
      }}
      style={[style, animatedStyle, disabled && { opacity: 0.4 }, pressedStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}
