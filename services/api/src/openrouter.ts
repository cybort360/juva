import { receiptSchema } from './schemas.js';

/**
 * The model's entire remit, stated to it directly.
 *
 * It transcribes. It does not decide whether the shopper saved money, and there is
 * no field in the schema through which it could say so if it tried. The
 * instruction to lower confidence rather than invent a value is the one that
 * matters most: a plausible wrong price would flow into a savings figure, while a
 * low-confidence gap surfaces as something the shopper is asked to confirm.
 */
const INSTRUCTION = [
  'Transcribe these photographs of a single retail receipt into structured data.',
  'The photographs are consecutive pages of the SAME receipt, in order. Merge them into one result and do not repeat lines that appear on more than one page.',
  'Record every visible line: items, coupons, discounts, fees, tax and totals. Set `kind` to describe what each line is.',
  'All money is integer cents. For a discount or coupon line, report the magnitude as a positive number and set kind to "discount".',
  'Report quantity and, where printed, the per-unit price. Never compute a per-unit price yourself.',
  'Do NOT transcribe card numbers, loyalty or account identifiers, addresses, phone numbers, names, or signatures. Skip those lines entirely.',
  'If a value is unclear, lower `confidence` rather than inventing it. A missing value is useful; a plausible wrong value is not.',
  'Do NOT judge whether the shopper saved money, whether a price was good, or whether anything was overcharged. Do not infer savings, fraud, liability or reimbursement. You transcribe only.',
].join(' ');

/** Guards against an unbounded request; the caller has already size-checked each image. */
const MAX_IMAGES = 8;

/**
 * Default provider. Any OpenAI-compatible chat-completions host works, but read the note
 * on `require_parameters` below before pointing this elsewhere.
 */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export function extractionEndpoint(): { baseUrl: string; isOpenRouter: boolean } {
  /**
   * An empty value counts as unset.
   *
   * `??` only falls back on null/undefined, so a bare `OPENROUTER_BASE_URL=` line — which
   * is what `.env.example` ships — produced an empty base URL and threw `Invalid URL`,
   * breaking receipt extraction for anyone who copied the example file without editing it.
   */
  const configured = process.env.OPENROUTER_BASE_URL?.trim();
  const baseUrl = (configured && configured.length > 0 ? configured : DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  return { baseUrl, isOpenRouter: /(^|\.)openrouter\.ai$/.test(new URL(baseUrl).hostname) };
}

export async function extractReceiptWithOpenRouter(imageDataUrls: string[]): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) throw new Error('Receipt extraction is not configured.');
  if (imageDataUrls.length === 0) throw new Error('At least one receipt image is required.');
  if (imageDataUrls.length > MAX_IMAGES) {
    throw new Error(`A receipt may span at most ${MAX_IMAGES} images.`);
  }

  const { baseUrl, isOpenRouter } = extractionEndpoint();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Attribution headers are OpenRouter's own; other hosts reject unknown headers.
        ...(isOpenRouter
          ? {
              'HTTP-Referer': process.env.OPENROUTER_APP_URL ?? 'https://juva.app',
              'X-Title': process.env.OPENROUTER_APP_NAME ?? 'Juva',
            }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: INSTRUCTION },
              ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
        response_format: { type: 'json_schema', json_schema: receiptSchema },
        /**
         * OpenRouter-only, and load-bearing where it exists.
         *
         * `require_parameters` makes OpenRouter refuse a provider that cannot honour the
         * schema, rather than silently dropping `response_format` and returning free-form
         * text. On any other host the schema is a request, not a guarantee — which is why
         * `toReceiptLines` re-derives line classification and every monetary figure is
         * computed in Juva's own code. Verify a new provider with
         * `npm --prefix services/api run probe` before trusting it.
         */
        ...(isOpenRouter ? { provider: { require_parameters: true } } : {}),
        temperature: 0,
        stream: false,
      }),
    });

    const payload = (await response.json()) as {
      error?: { message?: string };
      choices?: { message?: { content?: string } }[];
    };
    if (!response.ok) {
      // Deliberately does not include the response body: a provider echoing part
      // of the request back would put receipt content into an error string.
      throw new Error(payload.error?.message ?? `Receipt provider failed with ${response.status}.`);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('Receipt provider returned no structured content.');
    return JSON.parse(content) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}
