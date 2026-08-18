import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { FileEventSink, validateBatch } from './events.js';
import {
  readFeedConfigs,
  searchConfiguredRetailerFeeds,
  searchRetailerAdapters,
  type MarketSearchRequest,
} from './market.js';
import { extractReceiptWithOpenRouter } from './openrouter.js';
import { RetailerRegistry } from './retailers/registry.js';

const port = Number(process.env.PORT ?? 8787);
const maxBodyBytes = 12 * 1024 * 1024;

/**
 * Nominatim and Overpass both require a contactable identifier. A deployment
 * that does not set one gets a clearly-marked default rather than silently
 * sending an anonymous request that those services are entitled to block.
 */
const userAgent =
  process.env.JUVA_CONTACT_USER_AGENT ??
  'Juva/0.2 (contact not configured; set JUVA_CONTACT_USER_AGENT)';

const registry = new RetailerRegistry({
  userAgent,
  ...(process.env.JUVA_RETAILER_ADAPTERS === undefined
    ? {}
    : { enabledIds: process.env.JUVA_RETAILER_ADAPTERS }),
});

function setHeaders(response: ServerResponse): void {
  response.setHeader(
    'Access-Control-Allow-Origin',
    process.env.ALLOWED_ORIGIN ?? 'http://localhost:8081',
  );
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  setHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error('Request payload is too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function validImageDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) &&
    value.length < maxBodyBytes
  );
}

/** A long receipt arrives as consecutive pages of one receipt. */
const maxReceiptImages = 8;

function validImageBatch(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maxReceiptImages &&
    value.every(validImageDataUrl)
  );
}

function validMarketRequest(value: unknown): value is MarketSearchRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MarketSearchRequest>;
  return (
    Array.isArray(candidate.concepts) &&
    candidate.concepts.length > 0 &&
    candidate.concepts.length <= 100 &&
    typeof candidate.radiusMiles === 'number' &&
    candidate.radiusMiles > 0 &&
    candidate.radiusMiles <= 50 &&
    Boolean(candidate.location) &&
    typeof candidate.currency === 'string'
  );
}

/**
 * Durable event storage.
 *
 * Append-only NDJSON: Juva's API has no database, and adding one for a funnel counter
 * would be the wrong trade. Swappable via the `EventSink` interface.
 */
const eventSink = new FileEventSink(process.env.JUVA_EVENT_LOG ?? '.data/events.ndjson');

const server = createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'juva-api',
      contactConfigured: Boolean(process.env.JUVA_CONTACT_USER_AGENT),
      activeAdapters: registry.active().map((adapter) => adapter.id),
      marketFeedsConfigured: readFeedConfigs().length > 0,
      receiptAIConfigured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL),
      providers: registry.health(),
    });
    return;
  }

  /**
   * The published capability matrix. Generated from the adapters so it cannot
   * drift from what the code actually does.
   */
  if (request.method === 'GET' && url.pathname === '/v1/retailers/capabilities') {
    sendJson(response, 200, {
      data: {
        adapters: registry.capabilityMatrix(),
        note: 'Capabilities describe the data source, not a claim of retailer coverage.',
      },
    });
    return;
  }

  /**
   * Analytics ingestion.
   *
   * Re-validates everything the client already sanitized. "The client checked" is not a
   * security property: a client is a program on someone else's device, and a bug in a
   * shipped build cannot be recalled.
   *
   * Rejections report an index and a reason, never the offending value — logging what
   * was rejected is exactly how a receipt line ends up in an error log.
   */
  if (request.method === 'POST' && url.pathname === '/v1/events') {
    try {
      const body = await readJson(request);
      const result = validateBatch(body);
      if (!result) {
        sendJson(response, 400, { error: 'A batch of 1 to 50 events is required.' });
        return;
      }
      const { stored, duplicates } = await eventSink.store(result.accepted);
      sendJson(response, 202, {
        data: {
          received: result.accepted.length + result.rejected.length,
          stored,
          duplicates,
          rejected: result.rejected,
        },
      });
    } catch {
      // The client retries; a 503 keeps the event queued rather than dropping it.
      sendJson(response, 503, { error: 'Event storage is unavailable.' });
    }
    return;
  }

  try {
    if (request.method === 'POST' && url.pathname === '/v1/market/search') {
      const body = await readJson(request);
      if (!validMarketRequest(body)) {
        sendJson(response, 400, {
          error: 'A valid grocery concepts/location request is required.',
        });
        return;
      }
      // Adapters are preferred when enabled; the authorized-feed contract remains
      // the path for retailer partnerships. Neither configured is a 503, not a
      // silent empty market.
      if (registry.hasActiveAdapters) {
        sendJson(response, 200, { data: await searchRetailerAdapters(registry, body) });
        return;
      }
      if (readFeedConfigs().length > 0) {
        sendJson(response, 200, { data: await searchConfiguredRetailerFeeds(body) });
        return;
      }
      sendJson(response, 503, {
        error:
          'No real price source is configured. Enable an adapter with JUVA_RETAILER_ADAPTERS or configure JUVA_RETAILER_FEEDS_JSON. Juva can also run in demo market mode.',
      });
      return;
    }

    /**
     * Receipt extraction.
     *
     * The images live only in this request's memory: they are passed to the
     * provider and go out of scope when the handler returns. Nothing is written to
     * disk, no temporary upload is created, and neither the images nor the
     * extracted lines are logged — an error path that echoed the body would put
     * receipt contents into a log file.
     */
    if (request.method === 'POST' && url.pathname === '/v1/extract/receipt') {
      const body = (await readJson(request)) as { images?: unknown };
      if (!validImageBatch(body.images)) {
        sendJson(response, 400, {
          error: `Between 1 and ${maxReceiptImages} base64 receipt images are required.`,
        });
        return;
      }
      const data = await extractReceiptWithOpenRouter(body.images);
      sendJson(response, 200, { data });
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    sendJson(response, 500, { error: message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Juva API listening on http://0.0.0.0:${port}`);
});
