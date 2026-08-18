/**
 * Probes whether a provider/model can actually do receipt extraction.
 *
 * Documentation frequently lists a model without saying whether it accepts images or
 * honours `json_schema`, and both are hard requirements here. Rather than guess, this
 * sends a synthetic receipt whose values are known and checks four things in order:
 *
 *   1. reachable   — the endpoint accepted an authenticated request at all
 *   2. multimodal  — it accepted image content without rejecting the request shape
 *   3. structured  — the reply parsed as JSON and matched the real schema's required keys
 *   4. faithful    — the transcription contains the planted values, so it read the picture
 *                    rather than inventing a plausible receipt
 *
 * (4) is the one that matters most. A model can pass 1–3 and still hallucinate a receipt,
 * which is exactly the failure Juva must never ship: a fabricated line becomes a price,
 * and a price becomes a saving.
 *
 * Uses the same schema object production sends, imported rather than copied, so this
 * cannot drift from the real request.
 *
 *   npm --prefix services/api run probe                       # model from .env
 *   npm --prefix services/api run probe -- deepseek-v4-flash glm-5.2
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractionEndpoint } from '../src/openrouter.js';
import { receiptSchema } from '../src/schemas.js';

/**
 * A receipt with values chosen to be unmistakable.
 *
 * Deliberately not round numbers a model would guess: 3.49/4.99/2.17 and a total of 10.65
 * that only adds up if all three lines were actually read. The coupon line is negative so
 * the probe also reveals whether signs survive.
 */
const PLANTED = {
  merchant: 'GROVE MARKET',
  lines: [
    { text: 'WHL MLK 1GAL', cents: 349 },
    { text: 'LRG EGGS 12CT', cents: 499 },
    { text: 'SALES TAX', cents: 217 },
  ],
  coupon: -100,
  totalCents: 1065,
};

function receiptSvg(): string {
  const rows = PLANTED.lines
    .map(
      (line, i) =>
        `<text x="24" y="${150 + i * 46}" font-family="monospace" font-size="26" fill="#000">${line.text}</text>` +
        `<text x="330" y="${150 + i * 46}" font-family="monospace" font-size="26" fill="#000" text-anchor="end">${(line.cents / 100).toFixed(2)}</text>`,
    )
    .join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="420" viewBox="0 0 380 420">
  <rect width="380" height="420" fill="#fff"/>
  <text x="24" y="60" font-family="monospace" font-size="30" fill="#000">${PLANTED.merchant}</text>
  <text x="24" y="96" font-family="monospace" font-size="22" fill="#000">48 JAY ST</text>
  ${rows}
  <text x="24" y="288" font-family="monospace" font-size="26" fill="#000">MFR COUPON</text>
  <text x="330" y="288" font-family="monospace" font-size="26" fill="#000" text-anchor="end">-1.00</text>
  <text x="24" y="344" font-family="monospace" font-size="28" fill="#000">TOTAL</text>
  <text x="330" y="344" font-family="monospace" font-size="28" fill="#000" text-anchor="end">${(PLANTED.totalCents / 100).toFixed(2)}</text>
</svg>`;
}

/** Renders the synthetic receipt to a base64 JPEG data URL. */
function receiptDataUrl(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'juva-probe-'));
  try {
    const svgPath = path.join(dir, 'receipt.svg');
    const pngPath = path.join(dir, 'receipt.png');
    writeFileSync(svgPath, receiptSvg());
    execFileSync('rsvg-convert', [svgPath, '-o', pngPath]);
    return `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`;
  } catch (error) {
    throw new Error(
      `Could not render the probe image. rsvg-convert is required (brew install librsvg). ${
        error instanceof Error ? error.message : ''
      }`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ProbeResult {
  model: string;
  reachable: boolean;
  multimodal: boolean;
  structured: boolean;
  faithful: boolean;
  /** Short, human-readable outcome. Never contains a key. */
  note: string;
}

const REQUIRED_TOP = [
  'merchant',
  'currency',
  'totalCents',
  'receiptDiscountCents',
  'confidence',
  'lines',
];

async function probe(model: string, imageDataUrl: string): Promise<ProbeResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  // Resolved by the same function production uses, so the probe cannot test a different
  // endpoint than the one that will actually be called.
  const { baseUrl, isOpenRouter } = extractionEndpoint();
  const result: ProbeResult = {
    model,
    reachable: false,
    multimodal: false,
    structured: false,
    faithful: false,
    note: '',
  };
  if (!apiKey) {
    result.note = 'OPENROUTER_API_KEY is not set in services/api/.env';
    return result;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe this receipt into the required structured shape. Integer cents. Do not invent values.',
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: { type: 'json_schema', json_schema: receiptSchema },
        ...(isOpenRouter ? { provider: { require_parameters: true } } : {}),
        temperature: 0,
        stream: false,
      }),
    });

    const raw = (await response.json()) as {
      error?: { message?: string };
      choices?: { message?: { content?: string } }[];
    };

    if (!response.ok) {
      const message = raw.error?.message ?? `HTTP ${response.status}`;
      // A 4xx that names the image or the schema tells us which capability is missing.
      result.reachable = response.status !== 401 && response.status !== 403;
      result.note = message.slice(0, 160);
      if (/image|vision|multimodal|content.*type/i.test(message)) {
        result.note = `no image support: ${result.note}`;
      } else if (/response_format|json_schema|schema|structured/i.test(message)) {
        result.multimodal = true;
        result.note = `no structured-output support: ${result.note}`;
      }
      return result;
    }

    result.reachable = true;
    result.multimodal = true;

    const content = raw.choices?.[0]?.message?.content;
    if (!content) {
      result.note = 'accepted the request but returned no content';
      return result;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // The clearest signal that response_format was ignored.
      result.note = `returned prose, not JSON — schema was not honoured: ${content.slice(0, 80)}`;
      return result;
    }

    const missing = REQUIRED_TOP.filter((key) => !(key in parsed));
    if (missing.length > 0) {
      result.note = `JSON missing required keys: ${missing.join(', ')}`;
      return result;
    }
    result.structured = true;

    // Did it read the picture? Check the planted amounts appear somewhere in the reply.
    const flat = JSON.stringify(parsed);
    const found = PLANTED.lines.filter((line) => flat.includes(String(line.cents))).length;
    const sawTotal = flat.includes(String(PLANTED.totalCents));
    result.faithful = found >= 2 && sawTotal;
    result.note = result.faithful
      ? `read ${found}/${PLANTED.lines.length} planted lines and the ${PLANTED.totalCents}c total`
      : `structured but unfaithful — found ${found}/${PLANTED.lines.length} lines, total ${sawTotal ? 'yes' : 'NO'}. Treat as hallucinating.`;
    return result;
  } catch (error) {
    result.note =
      error instanceof Error && error.name === 'AbortError'
        ? 'timed out after 60s'
        : `request failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`;
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const models = process.argv.slice(2);
  const fromEnv = process.env.OPENROUTER_MODEL;
  const targets = models.length > 0 ? models : fromEnv ? [fromEnv] : [];

  if (targets.length === 0) {
    console.error(
      'No model to probe. Set OPENROUTER_MODEL in services/api/.env, or pass model ids:\n' +
        '  npm --prefix services/api run probe -- deepseek-v4-flash glm-5.2',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`endpoint: ${extractionEndpoint().baseUrl}`);
  console.log(`probing ${targets.length} model(s) with a synthetic receipt\n`);

  const image = receiptDataUrl();
  const results: ProbeResult[] = [];
  for (const model of targets) {
    process.stdout.write(`  ${model} … `);
    const result = await probe(model, image);
    results.push(result);
    console.log(result.faithful ? 'USABLE' : 'not usable');
    console.log(
      `    reachable=${result.reachable} image=${result.multimodal} schema=${result.structured} faithful=${result.faithful}`,
    );
    console.log(`    ${result.note}\n`);
  }

  const usable = results.filter((entry) => entry.faithful);
  if (usable.length === 0) {
    console.log('No probed model can do receipt extraction. Typed receipt totals still work.');
    process.exitCode = 1;
    return;
  }
  console.log(`Usable: ${usable.map((entry) => entry.model).join(', ')}`);
  console.log('Set the chosen one as OPENROUTER_MODEL in services/api/.env.');
}

void main();
