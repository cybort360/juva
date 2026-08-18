import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { reportHandled } from '@/services/monitoring';

/**
 * Receipt image handling.
 *
 * Two rules shape this module. Receipt images are among the most sensitive things
 * a shopper will ever hand an app — they carry what was bought, where, when and
 * sometimes a partial card number — so every image lives in a directory Juva
 * controls, and every copy made on the way to extraction is deleted afterwards
 * whether extraction succeeded or not.
 *
 * Nothing here logs a URI or image content. A file path is enough to find the
 * image on a shared device.
 */

/** Long edge, in pixels. Enough for small print, far below what a camera returns. */
const MAX_EDGE = 1600;
/** JPEG quality. Receipts are high-contrast text, which survives compression well. */
const COMPRESSION = 0.62;
/** A hard ceiling on pages, so a stuck loop cannot fill the device. */
export const MAX_PAGES = 8;

const RECEIPT_DIR = `${FileSystem.cacheDirectory ?? ''}juva-receipts/`;

export interface ReceiptPage {
  /** A file inside Juva's own receipt directory. */
  uri: string;
  width: number;
  height: number;
  /** Set once the page has been rotated or cropped by the shopper. */
  edited?: boolean;
}

async function ensureDirectory(): Promise<void> {
  const info = await FileSystem.getInfoAsync(RECEIPT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(RECEIPT_DIR, { intermediates: true });
}

/**
 * Normalises a freshly captured photo into a stored page.
 *
 * Resize and compress happen before anything is written, so the full-resolution
 * original never lands in Juva's directory at all.
 */
export async function preparePage(sourceUri: string): Promise<ReceiptPage> {
  try {
    await ensureDirectory();
    const context = ImageManipulator.manipulate(sourceUri).resize({ width: MAX_EDGE });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: COMPRESSION });
    const target = `${RECEIPT_DIR}page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await FileSystem.moveAsync({ from: saved.uri, to: target });
    return { uri: target, width: saved.width, height: saved.height };
  } catch (caught) {
    /**
     * Capture failure — out of space, a permission revoked mid-flow, a corrupt source.
     *
     * Only the operation is reported. The source URI is deliberately not included: a
     * photo library path can identify a person's device and, on some platforms, the
     * image itself.
     */
    reportHandled('receipt.capture_failed', { operation: 'prepare_page' });
    throw caught;
  }
}

/** Rotates a page by a quarter turn, replacing the stored file. */
export async function rotatePage(page: ReceiptPage, degrees: 90 | 180 | 270): Promise<ReceiptPage> {
  const context = ImageManipulator.manipulate(page.uri).rotate(degrees);
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: COMPRESSION });
  await FileSystem.deleteAsync(page.uri, { idempotent: true });
  const target = `${RECEIPT_DIR}page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await FileSystem.moveAsync({ from: saved.uri, to: target });
  return { uri: target, width: saved.width, height: saved.height, edited: true };
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Crops a page to the shopper's rectangle.
 *
 * This is also the privacy tool: cropping away the footer is how a shopper
 * removes a partial card number or a loyalty id before anything is uploaded.
 */
export async function cropPage(page: ReceiptPage, rect: CropRect): Promise<ReceiptPage> {
  const context = ImageManipulator.manipulate(page.uri).crop(rect);
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: COMPRESSION });
  await FileSystem.deleteAsync(page.uri, { idempotent: true });
  const target = `${RECEIPT_DIR}page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await FileSystem.moveAsync({ from: saved.uri, to: target });
  return { uri: target, width: saved.width, height: saved.height, edited: true };
}

/**
 * Reads a page as base64 for a single upload.
 *
 * The string is returned to the caller and never cached, written elsewhere or
 * logged. Callers are expected to drop it as soon as the request resolves.
 */
export async function readPageBase64(page: ReceiptPage): Promise<string> {
  return FileSystem.readAsStringAsync(page.uri, { encoding: FileSystem.EncodingType.Base64 });
}

/** Deletes specific pages. Idempotent, so a double delete is not an error. */
export async function deletePages(uris: readonly string[]): Promise<void> {
  await Promise.all(
    uris.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)),
  );
}

/**
 * Removes everything in Juva's receipt directory.
 *
 * Used by the explicit "delete all receipt images" control, and on a cold start to
 * clear anything a crash left behind mid-capture.
 */
export async function purgeAllPages(): Promise<void> {
  await FileSystem.deleteAsync(RECEIPT_DIR, { idempotent: true }).catch(() => undefined);
}

/**
 * Deletes retained images older than the shopper's retention window.
 *
 * Called on launch. A window of zero means "do not keep images at all", which is
 * handled at capture time rather than here.
 */
export async function purgeExpiredPages(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) {
    await purgeAllPages();
    return 0;
  }
  const info = await FileSystem.getInfoAsync(RECEIPT_DIR);
  if (!info.exists) return 0;
  const names = await FileSystem.readDirectoryAsync(RECEIPT_DIR);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const uri = `${RECEIPT_DIR}${name}`;
    const entry = await FileSystem.getInfoAsync(uri);
    // `modificationTime` is in seconds when present.
    const modified = entry.exists && entry.modificationTime ? entry.modificationTime * 1000 : 0;
    if (modified > 0 && modified < cutoff) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

/** Total bytes currently retained, for the deletion control to show honestly. */
export async function retainedBytes(): Promise<number> {
  const info = await FileSystem.getInfoAsync(RECEIPT_DIR);
  if (!info.exists) return 0;
  const names = await FileSystem.readDirectoryAsync(RECEIPT_DIR);
  let total = 0;
  for (const name of names) {
    const entry = await FileSystem.getInfoAsync(`${RECEIPT_DIR}${name}`);
    if (entry.exists && !entry.isDirectory) total += entry.size ?? 0;
  }
  return total;
}
