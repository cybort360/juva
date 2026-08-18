import { Easing } from 'react-native-reanimated';

/**
 * Juva's motion vocabulary.
 *
 * These are the durations and curves the product already moved at before
 * Reanimated arrived — the savings reveal was 850ms, the search choreography
 * stepped every 620ms — captured here so every screen shares one feel rather
 * than each re-inventing its own timing.
 *
 * The rule behind the numbers: money settles, structure snaps, status breathes.
 */
export const DURATION = {
  /** Immediate feedback on touch. Below this a press feels unacknowledged. */
  tap: 120,
  /** Structural change: a segment activating, a card selecting. */
  snap: 220,
  /** A value moving to a new value. Long enough to read the change. */
  settle: 420,
  /** A headline figure counting up. The signature Juva reveal. */
  reveal: 850,
  /** One step of the live-search choreography. */
  stage: 620,
  /** A route drawing itself, per stop. */
  draw: 380,
  /** Ambient status pulse, one half-cycle. */
  breathe: 900,
} as const;

/**
 * Curves. `settle` is the workhorse: fast departure, slow arrival, which reads as
 * a value coming to rest rather than snapping into place.
 */
export const EASING = {
  settle: Easing.out(Easing.cubic),
  snap: Easing.bezier(0.2, 0.9, 0.2, 1),
  breathe: Easing.inOut(Easing.quad),
  enter: Easing.bezier(0.16, 1, 0.3, 1),
} as const;

/** Spring for tactile, gesture-driven movement where a duration would feel wrong. */
export const SPRING = {
  /** Press feedback and small structural moves. */
  tactile: { damping: 18, stiffness: 260, mass: 0.6 },
  /** Larger surfaces settling into place. */
  surface: { damping: 22, stiffness: 180, mass: 0.9 },
} as const;

/** Scale a pressed control shrinks to. Small enough to feel, not to distract. */
export const PRESS_SCALE = 0.97;
