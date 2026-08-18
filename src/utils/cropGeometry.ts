/**
 * Geometry for the receipt crop tool.
 *
 * Kept pure and separate from the component because this is the part that can be
 * wrong without looking wrong: a scale error crops a different region than the one
 * the shopper drew, and since cropping is how a receipt footer full of card digits
 * gets removed, a silent off-by-scale is a privacy failure rather than a cosmetic
 * one. All of it is testable arithmetic.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle `cropPage` expects, in source-image pixels. */
export interface ImageCropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Where a contain-fitted image actually sits inside its container.
 *
 * `resizeMode="contain"` letterboxes, so the image's on-screen origin is not the
 * container's origin. Every display-to-image conversion depends on this offset.
 */
export interface ContainBox extends Rect {
  /** Display pixels per image pixel. */
  scale: number;
}

export function containBox(image: Size, container: Size): ContainBox {
  if (image.width <= 0 || image.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 1 };
  }
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
    scale,
  };
}

/**
 * Holds a rectangle inside `bounds`, preserving its size where possible.
 *
 * Size is clamped before position so a rectangle larger than its bounds ends up
 * filling them rather than hanging off one edge.
 */
export function clampRectWithin(rect: Rect, bounds: Rect, minSize: number): Rect {
  const width = Math.max(minSize, Math.min(rect.width, bounds.width));
  const height = Math.max(minSize, Math.min(rect.height, bounds.height));
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - width));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - height));
  return { x, y, width, height };
}

/**
 * Converts the rectangle the shopper drew into source-image pixels.
 *
 * Rounds outward — floor the origin, ceil the extent — so the crop never excludes a
 * pixel row the shopper had inside their selection. Erring inward could shave the
 * top off a line of text they meant to keep.
 *
 * The result is clamped to the image, because a drag that ran a fraction past the
 * edge must not produce an out-of-bounds rectangle the native cropper would reject.
 */
export function displayRectToImageRect(rect: Rect, box: ContainBox, image: Size): ImageCropRect {
  if (box.scale <= 0) {
    return { originX: 0, originY: 0, width: image.width, height: image.height };
  }
  const rawX = Math.floor((rect.x - box.x) / box.scale);
  const rawY = Math.floor((rect.y - box.y) / box.scale);
  const originX = Math.max(0, Math.min(rawX, image.width - 1));
  const originY = Math.max(0, Math.min(rawY, image.height - 1));
  const width = Math.max(1, Math.min(Math.ceil(rect.width / box.scale), image.width - originX));
  const height = Math.max(1, Math.min(Math.ceil(rect.height / box.scale), image.height - originY));
  return { originX, originY, width, height };
}

/** Whether a crop would actually change anything worth re-encoding the file for. */
export function isMeaningfulCrop(rect: ImageCropRect, image: Size, tolerance = 2): boolean {
  return (
    rect.originX > tolerance ||
    rect.originY > tolerance ||
    rect.width < image.width - tolerance ||
    rect.height < image.height - tolerance
  );
}
