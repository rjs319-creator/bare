'use strict';
// Public pricing/product page monitoring — ONLY explicitly configured official company
// URLs (registry-validated hosts, preventing SSRF). Stores a normalized content hash and
// a bounded before/after line diff when the page changes; never the raw HTML. Known page
// noise (scripts, styles, tags, timestamps, tracking params, whitespace) is stripped
// before hashing so cosmetic churn does not register as a product change.

const { guardedFetch, adapterResult } = require('./common');
const SCHEMA = require('../schema');
const REGISTRY = require('../registry');

const MAX_DIFF_LINES = 30;
const MAX_LINE_LEN = 160;
const EXCERPT_CAP = 4000;

// Deterministic text normalization: tags/scripts out, dates and long numbers masked,
// whitespace collapsed — the residue is the page's substantive copy.
function normalizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, '<date>')
    .replace(/\b(19|20)\d{2}\b/g, '<year>')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .join('\n');
}

// Bounded line diff: which lines appeared/disappeared, capped hard.
function boundedDiff(prevText, nextText) {
  const prev = new Set(String(prevText || '').split('\n'));
  const next = new Set(String(nextText || '').split('\n'));
  const clip = (l) => l.slice(0, MAX_LINE_LEN);
  const added = [...next].filter((l) => !prev.has(l)).slice(0, MAX_DIFF_LINES).map(clip);
  const removed = [...prev].filter((l) => !next.has(l)).slice(0, MAX_DIFF_LINES).map(clip);
  return { added, removed, truncated: added.length >= MAX_DIFF_LINES || removed.length >= MAX_DIFF_LINES };
}

// prevSnapshots: { [mappingId]: { hash, excerpt } } from the series store.
async function collectPricing({ mappings, prevSnapshots = {}, now = new Date(), fetchImpl = null } = {}) {
  const retrievedAt = now.toISOString();
  const day = retrievedAt.slice(0, 10);
  const observations = [];
  const errors = [];
  const nextSnapshots = {};
  const perEntity = {};
  for (const m of mappings) {
    // Only a mapping that validates (official-company host) may grant its own host.
    let host = null;
    try { host = new URL(m.sourceUrl).hostname.toLowerCase(); } catch { host = null; }
    const grantsHost = host && REGISTRY.isCompanyHost(host, m.domain) ? [host] : [];
    if (!grantsHost.length && !REGISTRY.isAllowedUrl(m.sourceUrl)) {
      errors.push(`${m.mappingId}: sourceUrl host not on the company domain — refused`);
      perEntity[m.mappingId] = { ok: false };
      continue;
    }
    const r = await guardedFetch(m.sourceUrl, { fetchImpl, retries: 1, expectJson: false, headers: { Accept: 'text/html' }, extraAllowedHosts: grantsHost });
    if (!r.ok) {
      errors.push(`${m.mappingId}: ${r.error} (${r.category})`);
      perEntity[m.mappingId] = { ok: false };
      continue;
    }
    const normalized = normalizeHtml(r.body);
    const hash = SCHEMA.contentHash(normalized);
    const prev = prevSnapshots[m.mappingId] || null;
    nextSnapshots[m.mappingId] = { hash, excerpt: normalized.slice(0, EXCERPT_CAP), at: retrievedAt };
    perEntity[m.mappingId] = { ok: true, changed: !!(prev && prev.hash !== hash) };
    if (!prev || prev.hash === hash) continue; // first sight or unchanged — no change event
    const diff = boundedDiff(prev.excerpt, normalized.slice(0, EXCERPT_CAP));
    observations.push(SCHEMA.makeObservation({
      source: 'pricing', ticker: m.ticker, entity: m.mappingId,
      metric: 'pageChange', effectiveDate: day, value: hash.slice(0, 16), unit: 'content-hash',
      sourceUrl: m.sourceUrl, publicAt: retrievedAt,
      basis: 'live', mappingId: m.mappingId, mappingVersion: m.version,
      detail: { prevHash: prev.hash.slice(0, 16), diff, note: 'first observed changed vs prior snapshot; page content is company-published' },
      retrievedAt,
    }));
  }
  return { ...adapterResult({ source: 'pricing', observations, errors, coverage: { day, perEntity } }), nextSnapshots };
}

module.exports = { collectPricing, normalizeHtml, boundedDiff, MAX_DIFF_LINES, EXCERPT_CAP };
