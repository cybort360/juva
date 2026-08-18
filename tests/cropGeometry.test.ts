import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampRectWithin,
  containBox,
  displayRectToImageRect,
  isMeaningfulCrop,
} from '../src/utils/cropGeometry';

test('a tall receipt is letterboxed horizontally, not stretched', () => {
  // A 1000x3000 receipt in a 300x600 box: height is the binding constraint.
  const box = containBox({ width: 1000, height: 3000 }, { width: 300, height: 600 });
  assert.equal(box.scale, 0.2);
  assert.equal(box.width, 200);
  assert.equal(box.height, 600);
  assert.equal(box.x, 50, 'centred horizontally');
  assert.equal(box.y, 0);
});

test('a wide image is letterboxed vertically', () => {
  const box = containBox({ width: 1000, height: 500 }, { width: 300, height: 600 });
  assert.equal(box.scale, 0.3);
  assert.equal(box.y, 225);
  assert.equal(box.x, 0);
});

test('a degenerate size never produces a divide-by-zero scale', () => {
  const box = containBox({ width: 0, height: 0 }, { width: 300, height: 600 });
  assert.equal(box.scale, 1);
  assert.equal(box.width, 0);
});

test('the full display box maps back to the whole image', () => {
  const image = { width: 1000, height: 3000 };
  const box = containBox(image, { width: 300, height: 600 });
  const rect = displayRectToImageRect(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    box,
    image,
  );
  assert.deepEqual(rect, { originX: 0, originY: 0, width: 1000, height: 3000 });
});

test('the letterbox offset is subtracted before scaling', () => {
  const image = { width: 1000, height: 3000 };
  const box = containBox(image, { width: 300, height: 600 });
  // A selection starting exactly at the image's left edge is image x=0, not x=250.
  const rect = displayRectToImageRect({ x: 50, y: 0, width: 100, height: 300 }, box, image);
  assert.equal(rect.originX, 0, 'the 50pt letterbox is not part of the image');
  assert.equal(rect.width, 500);
  assert.equal(rect.height, 1500);
});

test('trimming the bottom third maps to the bottom third of the source', () => {
  const image = { width: 1000, height: 3000 };
  const box = containBox(image, { width: 300, height: 600 });
  // Keep the top two thirds: display y 0..400 of 600.
  const rect = displayRectToImageRect({ x: 50, y: 0, width: 200, height: 400 }, box, image);
  assert.equal(rect.originY, 0);
  assert.equal(rect.height, 2000, 'the footer third is excluded');
});

test('a crop rounds outward so a selected pixel row is never shaved off', () => {
  const image = { width: 100, height: 100 };
  const box = containBox(image, { width: 100, height: 100 });
  const rect = displayRectToImageRect({ x: 10.7, y: 10.7, width: 20.2, height: 20.2 }, box, image);
  assert.equal(rect.originX, 10, 'origin floors');
  assert.equal(rect.originY, 10);
  assert.equal(rect.width, 21, 'extent ceils');
  assert.equal(rect.height, 21);
});

test('a drag past the edge is clamped inside the image', () => {
  const image = { width: 100, height: 100 };
  const box = containBox(image, { width: 100, height: 100 });
  const rect = displayRectToImageRect({ x: -30, y: -30, width: 400, height: 400 }, box, image);
  assert.equal(rect.originX, 0);
  assert.equal(rect.originY, 0);
  assert.equal(rect.width, 100, 'never wider than the source');
  assert.equal(rect.height, 100);
});

test('a rectangle starting past the far edge still yields a valid crop', () => {
  const image = { width: 100, height: 100 };
  const box = containBox(image, { width: 100, height: 100 });
  const rect = displayRectToImageRect({ x: 500, y: 500, width: 10, height: 10 }, box, image);
  assert.ok(rect.originX < image.width);
  assert.ok(rect.width >= 1, 'a zero-width crop would be rejected by the native cropper');
  assert.ok(rect.originX + rect.width <= image.width);
});

test('clamping keeps a rectangle inside its bounds without resizing it', () => {
  const bounds = { x: 0, y: 0, width: 200, height: 400 };
  const clamped = clampRectWithin({ x: -50, y: 380, width: 100, height: 100 }, bounds, 40);
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 300, 'pushed up so it fits rather than overflowing');
  assert.equal(clamped.width, 100);
  assert.equal(clamped.height, 100);
});

test('clamping respects the minimum size', () => {
  const bounds = { x: 0, y: 0, width: 200, height: 400 };
  const clamped = clampRectWithin({ x: 10, y: 10, width: 5, height: 5 }, bounds, 40);
  assert.equal(clamped.width, 40);
  assert.equal(clamped.height, 40);
});

test('a rectangle larger than its bounds fills them', () => {
  const bounds = { x: 10, y: 10, width: 100, height: 100 };
  const clamped = clampRectWithin({ x: 0, y: 0, width: 500, height: 500 }, bounds, 40);
  assert.equal(clamped.width, 100);
  assert.equal(clamped.height, 100);
  assert.equal(clamped.x, 10);
  assert.equal(clamped.y, 10);
});

test('a whole-image selection is not treated as a crop worth re-encoding', () => {
  const image = { width: 1000, height: 3000 };
  assert.equal(
    isMeaningfulCrop({ originX: 0, originY: 0, width: 1000, height: 3000 }, image),
    false,
  );
});

test('trimming a footer counts as a meaningful crop', () => {
  const image = { width: 1000, height: 3000 };
  assert.equal(
    isMeaningfulCrop({ originX: 0, originY: 0, width: 1000, height: 2200 }, image),
    true,
  );
});
