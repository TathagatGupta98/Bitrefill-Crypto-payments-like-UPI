import { config, requireConfig } from './config.js';

const TIMEOUT_MS = 15_000;
const MAX_TRIES = 4;
const MAX_WAIT_MS = 30_000;

export class BitrefillError extends Error {
  constructor(status, body, path) {
    const detail = body?.message || body?.error || (typeof body === 'string' && body) || 'request failed';
    super(`Bitrefill ${path} -> ${status || 'network error'}: ${detail}`);
    this.name = 'BitrefillError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.code = body?.error_code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => 1000 * 2 ** attempt;

// The docs only promise X-RateLimit-Reset (Unix seconds); Retry-After is honoured if present.
function rateLimitWaitMs(headers, attempt) {
  const retryAfter = Number(headers.get('retry-after'));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_WAIT_MS);
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (reset > 0) return Math.min(Math.max(reset * 1000 - Date.now(), 0), MAX_WAIT_MS);
  return backoffMs(attempt);
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function request(method, path, body) {
  requireConfig(['BITREFILL_API_KEY']);

  // A 5xx or timeout on a POST may still have created the invoice, so only GETs retry on those.
  // A 429 was rejected outright, so it is safe to retry for every method.
  const canRetryFailure = method === 'GET';

  for (let attempt = 0; ; attempt++) {
    const hasTriesLeft = attempt < MAX_TRIES - 1;
    let res;
    try {
      res = await fetch(`${config.BITREFILL_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.BITREFILL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (canRetryFailure && hasTriesLeft) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new BitrefillError(0, err.message, path);
    }

    if (res.status === 429 && hasTriesLeft) {
      await sleep(rateLimitWaitMs(res.headers, attempt));
      continue;
    }
    if (res.status >= 500 && canRetryFailure && hasTriesLeft) {
      await sleep(backoffMs(attempt));
      continue;
    }

    const json = parseBody(await res.text());
    if (!res.ok) throw new BitrefillError(res.status, json, path);
    // Ping returns its message at the top level, without the usual `data` envelope.
    return json?.data ?? json;
  }
}

function withQuery(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  return query ? `${path}?${query}` : path;
}

export const ping = () => request('GET', '/ping');
export const getBalance = () => request('GET', '/accounts/balance');
export const searchProducts = (q, params) => request('GET', withQuery('/products/search', { q, ...params }));
export const getProduct = (id, params) => request('GET', withQuery(`/products/${encodeURIComponent(id)}`, params));
export const createInvoice = (body) => request('POST', '/invoices', body);
export const getInvoice = (id) => request('GET', `/invoices/${encodeURIComponent(id)}`);
export const getOrder = (id) => request('GET', `/orders/${encodeURIComponent(id)}`);
