'use strict';
// ALPACA PAPER CLIENT — raw `fetch` against the three paper endpoints the paper-execution
// ledger needs (orders, positions, account). No SDK: the surface is four calls and the
// repo keeps runtime deps minimal.
//
// SAFETY RAILS (all three must hold or the client refuses to construct):
//   1. ALPACA_KEY_ID and ALPACA_SECRET_KEY are both set;
//   2. ALPACA_PAPER === '1' — an explicit, documented switch (docs/paper-execution.md);
//   3. the key id looks like a PAPER key (Alpaca paper keys start with `PK`; live keys with
//      `AK`). The base URL is a constant — there is no way to point this module at the live
//      API, and a live key is rejected before any request is built.
//
// Retries are bounded (MAX_ATTEMPTS) and only for transport errors / 429 / 5xx. Every
// response is shape-checked at the boundary: an order must carry string id/symbol/status,
// a listing must be an array. Never trust vendor JSON.

const PAPER_BASE_URL = 'https://paper-api.alpaca.markets/v2';
const PAPER_KEY_RE = /^PK[A-Z0-9]{8,}$/;
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
// Alpaca's REST answers in well under a second; 15s is ample headroom and still leaves
// room for several calls inside one tick's function budget. Unmeasured against a real
// account yet (no keys) — revisit once the first ledger days exist.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 300;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const LIST_LIMIT = 500;   // Alpaca's documented max for GET /v2/orders

class AlpacaConfigError extends Error { constructor(reason) { super(`alpaca-paper disabled: ${reason}`); this.name = 'AlpacaConfigError'; this.code = 'ALPACA_DISABLED'; } }
class AlpacaHttpError extends Error { constructor(status, path, body) { super(`alpaca-paper ${path}: HTTP ${status}${body ? ` — ${body}` : ''}`); this.name = 'AlpacaHttpError'; this.status = status; } }
class AlpacaResponseError extends Error { constructor(msg) { super(`alpaca-paper response: ${msg}`); this.name = 'AlpacaResponseError'; } }

// paperConfig(env) → { enabled, reason, keyId, secretKey } — pure, never throws.
function paperConfig(env = process.env) {
  const keyId = (env && typeof env.ALPACA_KEY_ID === 'string' && env.ALPACA_KEY_ID.trim()) || null;
  const secretKey = (env && typeof env.ALPACA_SECRET_KEY === 'string' && env.ALPACA_SECRET_KEY.trim()) || null;
  if (!keyId || !secretKey) return { enabled: false, reason: 'ALPACA_KEY_ID / ALPACA_SECRET_KEY not set', keyId: null, secretKey: null };
  if (!env || env.ALPACA_PAPER !== '1') return { enabled: false, reason: 'ALPACA_PAPER is not "1"', keyId: null, secretKey: null };
  if (!PAPER_KEY_RE.test(keyId)) return { enabled: false, reason: 'ALPACA_KEY_ID does not look like a paper key (PK…) — live keys are refused', keyId: null, secretKey: null };
  return { enabled: true, reason: null, keyId, secretKey };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (json) => (json && typeof json === 'object' && typeof json.message === 'string' ? json.message : '');
const isDuplicateClientId = (status, msg) => status === 422 && /client_order_id/i.test(msg) && /unique|duplicate|exists/i.test(msg);

function assertOrderShape(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.symbol !== 'string' || typeof o.status !== 'string') {
    throw new AlpacaResponseError('order shape invalid (id/symbol/status must be strings)');
  }
  return o;
}
function assertArray(v, what) {
  if (!Array.isArray(v)) throw new AlpacaResponseError(`expected an array of ${what}`);
  return v;
}

function createAlpacaPaperClient({ env = process.env, fetchImpl = globalThis.fetch, sleep = defaultSleep, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const cfg = paperConfig(env);
  if (!cfg.enabled) throw new AlpacaConfigError(cfg.reason);
  const headers = { 'APCA-API-KEY-ID': cfg.keyId, 'APCA-API-SECRET-KEY': cfg.secretKey, accept: 'application/json' };

  // One attempt: resolves { status, json } for ANY HTTP status; throws only on transport failure.
  async function once(method, url, body) {
    const init = { method, headers: body ? { ...headers, 'content-type': 'application/json' } : headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body) init.body = JSON.stringify(body);
    const res = await fetchImpl(url, init);
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  // Bounded retry on transport errors and retryable statuses; other statuses return as-is.
  async function request(method, path, { query = null, body = null } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : '';
    const url = `${PAPER_BASE_URL}${path}${qs}`;
    let last = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const r = await once(method, url, body);
        if (!RETRY_STATUSES.has(r.status)) return r;
        last = new AlpacaHttpError(r.status, path, messageOf(r.json));
      } catch (e) {
        last = e;
      }
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    throw last;
  }

  async function readJson(method, path, opts) {
    const r = await request(method, path, opts);
    if (r.status < 200 || r.status >= 300) throw new AlpacaHttpError(r.status, path, messageOf(r.json));
    return r.json;
  }

  return {
    baseUrl: PAPER_BASE_URL,
    keyIdSuffix: cfg.keyId.slice(-4),
    account: () => readJson('GET', '/account'),
    clock: () => readJson('GET', '/clock'),
    listPositions: async () => assertArray(await readJson('GET', '/positions'), 'positions'),
    // Orders for the day (nested so bracket/OCO legs ride along). `after` is an ISO instant.
    listOrders: async ({ after = null, status = 'all', limit = LIST_LIMIT, nested = true } = {}) => {
      const list = assertArray(await readJson('GET', '/orders', { query: { status, limit, nested, after, direction: 'asc' } }), 'orders');
      return list.map(assertOrderShape);
    },
    getOrderByClientId: async (clientOrderId) => assertOrderShape(await readJson('GET', '/orders:by_client_order_id', { query: { client_order_id: clientOrderId } })),
    // placeOrder(body) → { ok:true, order, duplicate } | { ok:false, status, error }.
    // A duplicate client_order_id is the idempotency signal: the order already exists, so it
    // is looked up and returned as ok — the tick that placed it may have lost its response.
    placeOrder: async function placeOrder(body) {
      const r = await request('POST', '/orders', { body });
      if (r.status >= 200 && r.status < 300) return { ok: true, order: assertOrderShape(r.json), duplicate: false };
      const msg = messageOf(r.json);
      if (isDuplicateClientId(r.status, msg) && body && body.client_order_id) {
        const existing = await this.getOrderByClientId(body.client_order_id);
        return { ok: true, order: existing, duplicate: true };
      }
      return { ok: false, status: r.status, error: (msg || `HTTP ${r.status}`).slice(0, 200) };
    },
    // Close the whole position at market, cancelling its open legs first. 404 = no position.
    closePosition: async (symbol) => {
      if (!SYMBOL_RE.test(String(symbol || ''))) throw new TypeError(`closePosition: invalid symbol ${JSON.stringify(symbol)}`);
      const r = await request('DELETE', `/positions/${symbol}`, { query: { cancel_orders: true } });
      if (r.status >= 200 && r.status < 300) return { ok: true, order: assertOrderShape(r.json) };
      return { ok: false, status: r.status, error: (messageOf(r.json) || `HTTP ${r.status}`).slice(0, 200) };
    },
  };
}

module.exports = {
  PAPER_BASE_URL, PAPER_KEY_RE, REQUEST_TIMEOUT_MS, MAX_ATTEMPTS, LIST_LIMIT,
  paperConfig, createAlpacaPaperClient, AlpacaConfigError, AlpacaHttpError, AlpacaResponseError,
};
