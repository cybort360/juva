import { env } from '@/config/runtimeEnv';
import type { CurrencyCode, ExtractedReceiptLine, ReceiptExtraction } from '@/domain/types';
import { reportHandled } from '@/services/monitoring';

import { readPageBase64, type ReceiptPage } from './receiptImages';

const REQUEST_TIMEOUT_MS = 45_000;

type ApiLine = Omit<ExtractedReceiptLine, 'barcode' | 'unitPriceCents' | 'discountCents'> & {
  barcode: string | null;
  unitPriceCents: number | null;
  discountCents: number | null;
};

interface ApiPayload {
  merchant: string | null;
  currency: CurrencyCode;
  totalCents: number | null;
  receiptDiscountCents: number | null;
  confidence: number;
  lines: ApiLine[];
}

export function isReceiptExtractionAvailable(): boolean {
  return env.apiBaseUrl !== undefined;
}

/**
 * Optional receipt extraction, server-side only.
 *
 * The OpenRouter key never exists on the device: the app posts to Juva's own API,
 * which holds the credential and speaks to the provider. That boundary is also
 * where the model's remit is enforced — it transcribes what is printed and has no
 * field in which to express an opinion about savings.
 *
 * Nothing here logs image data, a page URI or a response body. The base64 string
 * exists for the duration of one request and is not retained.
 */
async function postPages(pages: readonly ReceiptPage[]): Promise<ReceiptExtraction> {
  const apiBaseUrl = env.apiBaseUrl;
  if (!apiBaseUrl) {
    throw new Error(
      'Receipt AI is not configured. Enter the receipt total manually for this trip.',
    );
  }

  const images = await Promise.all(
    pages.map(async (page) => `data:image/jpeg;base64,${await readPageBase64(page)}`),
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}/v1/extract/receipt`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    });

    const payload = (await response.json()) as { data?: ApiPayload; error?: string };
    if (!response.ok || !payload.data) throw new Error(payload.error ?? 'Receipt analysis failed.');

    const data = payload.data;
    return {
      currency: data.currency,
      confidence: data.confidence,
      ...(data.merchant === null ? {} : { merchant: data.merchant }),
      ...(data.totalCents === null ? {} : { totalCents: data.totalCents }),
      ...(data.receiptDiscountCents === null
        ? {}
        : { receiptDiscountCents: data.receiptDiscountCents }),
      lines: data.lines.map((line) => ({
        rawText: line.rawText,
        productName: line.productName,
        chargedPriceCents: line.chargedPriceCents,
        quantity: line.quantity,
        kind: line.kind,
        ...(line.barcode === null ? {} : { barcode: line.barcode }),
        ...(line.unitPriceCents === null ? {} : { unitPriceCents: line.unitPriceCents }),
        ...(line.discountCents === null ? {} : { discountCents: line.discountCents }),
      })),
    };
  } catch (caught) {
    reportHandled('receipt.extraction_failed', { pageCount: pages.length });
    if (caught instanceof Error && caught.name === 'AbortError') {
      throw new Error('Receipt analysis timed out. Enter the receipt total manually.');
    }
    throw caught;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extracts one receipt, which may span several pages.
 *
 * Pages are sent together because a long receipt's total is on the last page
 * while its items are on the first — extracting them separately would produce two
 * partial receipts that neither reconcile nor sum.
 */
export async function extractReceipt(pages: readonly ReceiptPage[]): Promise<ReceiptExtraction> {
  if (pages.length === 0) throw new Error('Add at least one receipt photo first.');
  return postPages(pages);
}
