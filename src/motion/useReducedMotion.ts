import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Whether the shopper has asked the system to reduce motion.
 *
 * Juva leans on motion to communicate — a settling total, a drawing route — so
 * honouring this setting matters more here than in a static app. The contract
 * every animated component follows: when this is true, the *end state* renders
 * immediately and correctly. Motion is the only thing removed, never information.
 */
/**
 * RN Web's AccessibilityInfo does not implement reduce-motion, so the media query
 * is read directly there. Reading it in the state initializer rather than in an
 * effect means the very first frame already honours the setting — a screen that
 * animated once before settling down would defeat the point.
 */
function initialReducedMotion(): boolean {
  if (Platform.OS !== 'web') return false;
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface ReducedMotionState {
  reduced: boolean;
  /**
   * Whether the system has actually answered yet.
   *
   * Web resolves synchronously via `matchMedia`, so it is true from the first
   * render. Native cannot: `AccessibilityInfo.isReduceMotionEnabled()` is a
   * promise, so the first frame would otherwise assume "animate" and start a
   * reveal for someone who asked for none. Anything whose *value* would be wrong
   * mid-animation should wait for this rather than guess.
   */
  resolved: boolean;
}

export function useReducedMotionState(): ReducedMotionState {
  const [state, setState] = useState<ReducedMotionState>(() => ({
    reduced: initialReducedMotion(),
    resolved: Platform.OS === 'web',
  }));
  const setReduced = (reduced: boolean): void => setState({ reduced, resolved: true });

  useEffect(() => {
    let active = true;

    if (Platform.OS === 'web') {
      const media =
        typeof globalThis.matchMedia === 'function'
          ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
          : undefined;
      if (!media) return;
      const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduced(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return state;
}

export function useReducedMotion(): boolean {
  return useReducedMotionState().reduced;
}

/**
 * Whether a screen reader is running.
 *
 * Used to skip purely decorative animation and to make transient states
 * announceable rather than something the reader has to catch mid-flight.
 */
export function useScreenReaderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((value) => {
      if (active) setEnabled(value);
    });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setEnabled);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
