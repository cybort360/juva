import { useState } from 'react';
import { Image, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnUI, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { JuvaButton } from '@/components/JuvaButton';
import { hapticSelect } from '@/motion/haptics';
import type { CropRect, ReceiptPage } from '@/services/receiptImages';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import {
  clampRectWithin,
  containBox,
  displayRectToImageRect,
  isMeaningfulCrop,
  type Rect,
} from '@/utils/cropGeometry';

interface Props {
  page: ReceiptPage;
  pageNumber: number;
  onCancel: () => void;
  onCommit: (rect: CropRect) => void;
}

/** Smallest selection, in display points. Below this the handles overlap. */
const MIN_SIZE = 56;
/** Touch target for a corner. Larger than the visual mark, as it should be. */
const HANDLE_HIT = 44;
const HANDLE_VISUAL = 22;
/** Initial selection inset, as a fraction of the fitted image. */
const INITIAL_INSET = 0.06;

type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Free-form crop for a receipt page.
 *
 * This is the redaction tool. A receipt's footer carries card digits and a loyalty
 * id, and its header sometimes carries a name — so being able to draw an exact
 * rectangle, rather than accept a preset trim, is what lets a shopper decide
 * precisely how much of their receipt Juva is allowed to read.
 *
 * The selection is dragged on the UI thread as shared values, then read once on
 * commit and converted by tested arithmetic in `utils/cropGeometry`. Nothing about
 * the mapping is done in a worklet, because a mistake there would crop a different
 * region than the one drawn and the shopper would have no way to tell.
 */
export function CropOverlay({ page, pageNumber, onCancel, onCommit }: Props) {
  const [container, setContainer] = useState({ width: 0, height: 0 });

  const box = containBox({ width: page.width, height: page.height }, container);
  const ready = box.width > 0 && box.height > 0;

  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  /** Values captured at gesture start, so a drag is absolute rather than cumulative. */
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startW = useSharedValue(0);
  const startH = useSharedValue(0);

  /**
   * Seeds the selection from the measured layout.
   *
   * Done in the layout callback rather than an effect: the fitted box is only known
   * once the container has a size, and seeding on the same pass avoids a frame where
   * the selection is a zero-sized rectangle in the corner.
   */
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    // Compared before setting: a fresh object on every layout pass would re-render
    // even when nothing moved.
    setContainer((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
    const fitted = containBox({ width: page.width, height: page.height }, { width, height });
    if (fitted.width <= 0) return;
    const inset = Math.min(fitted.width, fitted.height) * INITIAL_INSET;
    x.value = fitted.x + inset;
    y.value = fitted.y + inset;
    w.value = fitted.width - inset * 2;
    h.value = fitted.height - inset * 2;
  };

  /** Bounds every drag is held inside: the fitted image, never the container. */
  const bounds = { x: box.x, y: box.y, width: box.width, height: box.height };

  const movePan = Gesture.Pan()
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      const nextX = startX.value + event.translationX;
      const nextY = startY.value + event.translationY;
      // Position only — a move must never resize the selection.
      x.value = Math.max(bounds.x, Math.min(nextX, bounds.x + bounds.width - w.value));
      y.value = Math.max(bounds.y, Math.min(nextY, bounds.y + bounds.height - h.value));
    });

  /**
   * One resize gesture per corner.
   *
   * Each corner moves its own two edges and leaves the opposite two fixed, which is
   * what makes the anchor feel pinned. The minimum size is enforced against the
   * fixed edge so a corner cannot be dragged through it and invert the rectangle.
   */
  const cornerPan = (corner: Corner) =>
    Gesture.Pan()
      .onStart(() => {
        startX.value = x.value;
        startY.value = y.value;
        startW.value = w.value;
        startH.value = h.value;
      })
      .onUpdate((event) => {
        const dx = event.translationX;
        const dy = event.translationY;
        const right = startX.value + startW.value;
        const bottom = startY.value + startH.value;

        if (corner === 'tl' || corner === 'bl') {
          const nextX = Math.max(bounds.x, Math.min(startX.value + dx, right - MIN_SIZE));
          x.value = nextX;
          w.value = right - nextX;
        } else {
          const maxRight = bounds.x + bounds.width;
          const nextRight = Math.min(maxRight, Math.max(right + dx, startX.value + MIN_SIZE));
          w.value = nextRight - startX.value;
        }

        if (corner === 'tl' || corner === 'tr') {
          const nextY = Math.max(bounds.y, Math.min(startY.value + dy, bottom - MIN_SIZE));
          y.value = nextY;
          h.value = bottom - nextY;
        } else {
          const maxBottom = bounds.y + bounds.height;
          const nextBottom = Math.min(maxBottom, Math.max(bottom + dy, startY.value + MIN_SIZE));
          h.value = nextBottom - startY.value;
        }
      });

  const selectionStyle = useAnimatedStyle(() => ({
    left: x.value,
    top: y.value,
    width: w.value,
    height: h.value,
  }));

  /** The four dimmed bands outside the selection, so the crop reads at a glance. */
  const shadeTop = useAnimatedStyle(() => ({ height: Math.max(0, y.value) }));
  const shadeBottom = useAnimatedStyle(() => ({ top: y.value + h.value }));
  const shadeLeft = useAnimatedStyle(() => ({
    top: y.value,
    height: h.value,
    width: Math.max(0, x.value),
  }));
  const shadeRight = useAnimatedStyle(() => ({
    top: y.value,
    height: h.value,
    left: x.value + w.value,
  }));

  /**
   * One `useAnimatedStyle` per corner, written out rather than generated.
   *
   * These are hooks, so they must be called unconditionally and in a fixed order at
   * the top level of the component — a helper returning them would be a
   * Rules-of-Hooks violation even though the call order happens to be stable.
   */
  const tlStyle = useAnimatedStyle(() => ({
    left: x.value - HANDLE_HIT / 2,
    top: y.value - HANDLE_HIT / 2,
  }));
  const trStyle = useAnimatedStyle(() => ({
    left: x.value + w.value - HANDLE_HIT / 2,
    top: y.value - HANDLE_HIT / 2,
  }));
  const blStyle = useAnimatedStyle(() => ({
    left: x.value - HANDLE_HIT / 2,
    top: y.value + h.value - HANDLE_HIT / 2,
  }));
  const brStyle = useAnimatedStyle(() => ({
    left: x.value + w.value - HANDLE_HIT / 2,
    top: y.value + h.value - HANDLE_HIT / 2,
  }));

  const corners = [
    { corner: 'tl' as Corner, style: tlStyle },
    { corner: 'tr' as Corner, style: trStyle },
    { corner: 'bl' as Corner, style: blStyle },
    { corner: 'br' as Corner, style: brStyle },
  ];

  const commit = (): void => {
    const rect = displayRectToImageRect(
      { x: x.value, y: y.value, width: w.value, height: h.value },
      box,
      { width: page.width, height: page.height },
    );
    // A selection covering the whole page is not a crop; re-encoding would lose a
    // little quality for no change.
    if (!isMeaningfulCrop(rect, { width: page.width, height: page.height })) {
      onCancel();
      return;
    }
    hapticSelect();
    onCommit(rect);
  };

  /**
   * Moves the selection from JS.
   *
   * The write happens inside a worklet rather than directly in the handler: these are
   * UI-thread values, and mutating them from render scope is what
   * `react-hooks/immutability` correctly objects to. Hopping to the UI thread also
   * means the jump lands in the same place the gestures write.
   */
  const applyRect = (next: Rect): void => {
    runOnUI((rect: Rect) => {
      x.value = rect.x;
      y.value = rect.y;
      w.value = rect.width;
      h.value = rect.height;
    })(next);
  };

  /** Snaps the selection to the top portion, the common case for a footer trim. */
  const dropFooter = (): void => {
    if (!ready) return;
    applyRect(
      clampRectWithin(
        { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height * 0.78 },
        bounds,
        MIN_SIZE,
      ),
    );
    hapticSelect();
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.kicker}>PAGE {pageNumber}</Text>
        <Text style={styles.title}>Choose what Juva reads</Text>
        <Text style={styles.copy}>
          Drag the corners. Anything outside the box is never uploaded — this is how you keep a card
          number or a loyalty id off the receipt Juva sees.
        </Text>
      </View>

      <View style={styles.stage} onLayout={measure}>
        <Image
          source={{ uri: page.uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          accessible
          accessibilityLabel={`Receipt page ${pageNumber}, being cropped`}
        />

        {ready ? (
          <>
            {/* Dimmed outside the selection. Decorative; the controls carry the semantics. */}
            <Animated.View
              pointerEvents="none"
              style={[styles.shade, styles.shadeFull, shadeTop]}
            />
            <Animated.View
              pointerEvents="none"
              style={[styles.shade, styles.shadeFull, styles.shadeToBottom, shadeBottom]}
            />
            <Animated.View
              pointerEvents="none"
              style={[styles.shade, styles.shadeToLeft, shadeLeft]}
            />
            <Animated.View
              pointerEvents="none"
              style={[styles.shade, styles.shadeToRight, shadeRight]}
            />

            <GestureDetector gesture={movePan}>
              <Animated.View
                style={[styles.selection, selectionStyle]}
                accessibilityLabel="Crop area. Use the trim and reset buttons below to adjust without dragging."
              />
            </GestureDetector>

            {corners.map(({ corner, style }) => (
              <GestureDetector key={corner} gesture={cornerPan(corner)}>
                <Animated.View style={[styles.handleHit, style]}>
                  <View style={styles.handleVisual} />
                </Animated.View>
              </GestureDetector>
            ))}
          </>
        ) : null}
      </View>

      {/*
        Dragging is invisible to a screen reader, so the two operations that matter
        most exist as ordinary buttons too.
      */}
      <View style={styles.quick}>
        <JuvaButton
          label="Drop the footer"
          variant="light"
          onPress={dropFooter}
          accessibilityHint="Selects the top of the page, excluding the footer"
          style={styles.flex}
        />
        <JuvaButton
          label="Whole page"
          variant="ghost"
          onPress={() => applyRect(bounds)}
          style={styles.flex}
        />
      </View>

      <View style={styles.actions}>
        <JuvaButton label="Use this crop" variant="signal" onPress={commit} disabled={!ready} />
        <JuvaButton label="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.paper, paddingTop: 58 },
  header: { paddingHorizontal: spacing.lg, gap: 6 },
  kicker: { ...type.label, color: colors.signalDeep },
  title: { ...type.display, color: colors.ink },
  copy: { ...type.bodySmall, color: colors.muted, lineHeight: 20 },
  stage: { flex: 1, margin: spacing.lg, borderRadius: 18, backgroundColor: colors.ink },
  shade: { position: 'absolute', backgroundColor: 'rgba(22,26,22,0.62)' },
  shadeFull: { left: 0, right: 0, top: 0 },
  shadeToBottom: { bottom: 0, height: undefined },
  shadeToLeft: { left: 0 },
  shadeToRight: { right: 0 },
  selection: { position: 'absolute', borderWidth: 2, borderColor: colors.signal },
  handleHit: {
    position: 'absolute',
    width: HANDLE_HIT,
    height: HANDLE_HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleVisual: {
    width: HANDLE_VISUAL,
    height: HANDLE_VISUAL,
    borderRadius: HANDLE_VISUAL / 2,
    backgroundColor: colors.signal,
    borderWidth: 3,
    borderColor: colors.ink,
  },
  quick: { flexDirection: 'row', gap: spacing.xs, paddingHorizontal: spacing.lg },
  flex: { flex: 1 },
  actions: { padding: spacing.lg, gap: spacing.sm },
});
