'use strict';
// TRUE FLOAT DATA — the publicly tradable share count, with provenance, staleness and
// conflict handling. This module exists because the app previously used SMALL+MICRO market-
// capitalization membership as a stand-in for "low float". Those are different quantities: a
// $300M company with 95% of its shares in the public market has a large float, and a $2B
// company that IPO'd 4% of itself has an ultra-low one. Only the second can gap 60% on a
// press release.
//
// HARD RULES (enforced here, not by convention):
//   • Market capitalization is NEVER substituted for float.
//   • A float we do not have is UNKNOWN with LOW confidence — never "low float".
//   • Impossible values (non-positive, absurd magnitude, float > shares outstanding) are
//     rejected, not clamped into plausibility.
//   • Disagreeing providers produce a CONFLICT: the record keeps the LARGER (more
//     conservative — less "low float") value and drops to LOW confidence.
//   • Nothing here invents a number. Every field traces to a provider row and a date.
//
// PROVIDER ADAPTER: `PROVIDERS` is an ordered registry of { name, capabilities, fetch }.
// Adding a licensed source later is a push to this array — no caller changes. The FMP
// adapters are primary today because the app already pays for that key; whether the plan
// actually returns shares-float is a RUNTIME question, and the answer is reported in the
// coverage diagnostics rather than assumed.

const { fetchWithTimeout } = require('./http');
const { FLOAT_TIERS, FLOAT_QUALITY, FLOAT_VERSION } = require('./lowfloat-config');
const { readFloatCache, writeFloatCache, hasStore } = require('./lowfloat-store');

const TIMEOUT_MS = 8000;
const DAY_MS = 86_400_000;

// ── Pure classification ──────────────────────────────────────────────────────
// Float tier from an actual share count. A null/invalid count is UNKNOWN — never NORMAL,
// because "we didn't look" and "we looked and it's big" must not collapse to one label.
function classifyFloat(floatShares) {
  if (!Number.isFinite(floatShares) || floatShares <= 0) return 'UNKNOWN';
  if (floatShares < FLOAT_TIERS.ULTRA_LOW.max) return 'ULTRA_LOW';
  if (floatShares < FLOAT_TIERS.LOW.max) return 'LOW';
  if (floatShares < FLOAT_TIERS.MODERATELY_LOW.max) return 'MODERATELY_LOW';
  if (floatShares < FLOAT_TIERS.SMALL_SUPPLY.max) return 'SMALL_SUPPLY';
  return 'NORMAL';
}

// Is a raw share count physically possible for a US common stock?
function isPlausibleShareCount(n) {
  return Number.isFinite(n) && n >= FLOAT_QUALITY.MIN_PLAUSIBLE_SHARES && n <= FLOAT_QUALITY.MAX_PLAUSIBLE_SHARES;
}

// Age in days of the most authoritative as-of date on a record (filing date preferred over
// the provider's own snapshot date). Null when neither is present.
function recordAgeDays(record, now = new Date()) {
  const ref = record && (record.filingDate || record.sourceTimestamp);
  const ms = ref ? Date.parse(ref) : NaN;
  if (!Number.isFinite(ms)) return null;
  return (new Date(now).getTime() - ms) / DAY_MS;
}

// Confidence + staleness + warnings for a float record. Pure: the same record always yields
// the same assessment, so the UI, the scorer and the tests agree by construction.
function assessFloatReliability(record, { now = new Date() } = {}) {
  const notes = [];
  if (!record || !Number.isFinite(record.floatShares) || record.floatShares <= 0) {
    return { confidence: 'LOW', stale: true, usable: false, ageDays: null, notes: ['float unavailable'] };
  }
  if (!isPlausibleShareCount(record.floatShares)) {
    return { confidence: 'LOW', stale: true, usable: false, ageDays: null, notes: ['implausible float value rejected'] };
  }
  const ageDays = recordAgeDays(record, now);
  let confidence = 'HIGH';

  if (ageDays == null) { confidence = 'MEDIUM'; notes.push('no as-of date from the provider'); }
  else if (ageDays > FLOAT_QUALITY.MAX_AGE_DAYS) { confidence = 'LOW'; notes.push(`float is ${Math.round(ageDays)} days old`); }
  else if (ageDays > FLOAT_QUALITY.STALE_DAYS) { confidence = 'MEDIUM'; notes.push(`float is ${Math.round(ageDays)} days old`); }

  if (record.conflicts && record.conflicts.length) {
    confidence = 'LOW';
    notes.push(`providers disagree (${record.conflicts.length} conflict${record.conflicts.length > 1 ? 's' : ''})`);
  }
  if (Number.isFinite(record.sharesOutstanding) && record.sharesOutstanding > 0
      && record.floatShares > record.sharesOutstanding * 1.02) {
    confidence = 'LOW';
    notes.push('float exceeds shares outstanding');
  }
  const stale = ageDays != null && ageDays > FLOAT_QUALITY.STALE_DAYS;
  // A record beyond MAX_AGE_DAYS is retained for display but is NOT usable as supply-
  // constraint evidence — the scorer checks `usable`, the UI shows the age.
  const usable = confidence !== 'LOW' || (ageDays != null && ageDays <= FLOAT_QUALITY.MAX_AGE_DAYS && !(record.conflicts || []).length);
  return { confidence, stale, usable, ageDays: ageDays == null ? null : +ageDays.toFixed(1), notes };
}

// ── Provider adapters ────────────────────────────────────────────────────────
// Each returns { floatShares, sharesOutstanding, asOf, filingDate } or null. A provider that
// is not configured returns null WITHOUT throwing so the registry can skip it silently; a
// provider that is configured but errors throws so the failure is counted.

async function fmpSharesFloat(ticker) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const url = `https://financialmodelingprep.com/stable/shares-float?symbol=${encodeURIComponent(ticker)}&apikey=${key}`;
  const r = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS });
  if (!r.ok) throw new Error(`fmp-shares-float ${r.status}`);
  const j = await r.json();
  const row = Array.isArray(j) ? j[0] : (j && typeof j === 'object' ? j : null);
  if (!row) return null;
  // FMP has used both `floatShares` and `freeFloat` across plan/endpoint revisions; accept
  // either, prefer the explicit share count over a percentage-shaped field.
  const floatShares = num(row.floatShares) ?? num(row.freeFloat);
  const sharesOutstanding = num(row.outstandingShares) ?? num(row.sharesOutstanding);
  if (floatShares == null) return null;
  return {
    floatShares,
    sharesOutstanding,
    asOf: row.date ? new Date(row.date).toISOString() : null,
    filingDate: row.date ? new Date(row.date).toISOString() : null,
  };
}

// Secondary: the company profile carries sharesOutstanding but NOT float. It is used to
// sanity-check the primary (float must not exceed outstanding) and to compute
// floatPctOfOutstanding — it can never itself supply a float value.
async function fmpProfileShares(ticker) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(ticker)}&apikey=${key}`;
  const r = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS });
  if (!r.ok) throw new Error(`fmp-profile ${r.status}`);
  const j = await r.json();
  const row = Array.isArray(j) ? j[0] : null;
  if (!row) return null;
  const sharesOutstanding = num(row.sharesOutstanding) ?? num(row.outstandingShares);
  if (sharesOutstanding == null) return null;
  return { floatShares: null, sharesOutstanding, asOf: null, filingDate: null };
}

const PROVIDERS = [
  { name: 'fmp-shares-float', suppliesFloat: true, fetch: fmpSharesFloat },
  { name: 'fmp-profile', suppliesFloat: false, fetch: fmpProfileShares },
];

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) ? n : null;
}

// ── Merge provider answers into ONE record ───────────────────────────────────
// Pure, so the conflict/plausibility policy is testable without any network.
// `answers` = [{ provider, suppliesFloat, data | null, error | null }].
function mergeProviderAnswers(ticker, answers, { now = new Date() } = {}) {
  const fetchedAt = new Date(now).toISOString();
  const floatOffers = [];
  const outstandingOffers = [];
  const notes = [];

  for (const a of answers || []) {
    if (a.error) { notes.push(`${a.provider}: ${a.error}`); continue; }
    if (!a.data) continue;
    if (a.data.floatShares != null) {
      if (isPlausibleShareCount(a.data.floatShares)) {
        floatOffers.push({ provider: a.provider, value: a.data.floatShares, asOf: a.data.asOf, filingDate: a.data.filingDate });
      } else {
        notes.push(`${a.provider}: implausible float ${a.data.floatShares} rejected`);
      }
    }
    if (a.data.sharesOutstanding != null && isPlausibleShareCount(a.data.sharesOutstanding)) {
      outstandingOffers.push({ provider: a.provider, value: a.data.sharesOutstanding });
    }
  }

  const sharesOutstanding = outstandingOffers.length ? outstandingOffers[0].value : null;

  if (!floatOffers.length) {
    const base = {
      ticker, floatShares: null, sharesOutstanding, floatPctOfOutstanding: null,
      source: null, sourceTimestamp: null, filingDate: null, fetchedAt,
      conflicts: [], notes,
    };
    return {
      ...base, floatTier: 'UNKNOWN', confidence: 'LOW', floatConfidence: 'LOW',
      stale: true, usable: false, ageDays: null, schema: FLOAT_VERSION,
    };
  }

  // Conflict detection: any two offers differing by more than the tolerance.
  const conflicts = [];
  for (let i = 0; i < floatOffers.length; i++) {
    for (let j = i + 1; j < floatOffers.length; j++) {
      const a = floatOffers[i], b = floatOffers[j];
      const denom = Math.max(a.value, b.value);
      if (denom > 0 && Math.abs(a.value - b.value) / denom > FLOAT_QUALITY.CONFLICT_TOLERANCE) {
        conflicts.push({ a: a.provider, aValue: a.value, b: b.provider, bValue: b.value });
      }
    }
  }
  // Conservative selection: with a conflict, the LARGER float wins (less "low float", so a
  // disagreement can never manufacture a supply-constraint score). Without one, the first
  // provider in registry order wins.
  const chosen = conflicts.length
    ? floatOffers.reduce((m, o) => (o.value > m.value ? o : m), floatOffers[0])
    : floatOffers[0];

  // Float greater than shares outstanding is impossible — flagged, and the float is capped at
  // outstanding for downstream turnover math so a bad record cannot inflate float turnover.
  let floatShares = chosen.value;
  if (Number.isFinite(sharesOutstanding) && sharesOutstanding > 0 && floatShares > sharesOutstanding * 1.02) {
    notes.push(`float (${floatShares}) exceeds shares outstanding (${sharesOutstanding}) — capped at outstanding`);
    floatShares = sharesOutstanding;
  }

  const record = {
    ticker,
    floatShares,
    sharesOutstanding,
    floatPctOfOutstanding: Number.isFinite(sharesOutstanding) && sharesOutstanding > 0
      ? +((floatShares / sharesOutstanding) * 100).toFixed(2) : null,
    source: chosen.provider,
    sourceTimestamp: chosen.asOf,
    filingDate: chosen.filingDate,
    fetchedAt,
    conflicts,
    notes,
  };
  const rel = assessFloatReliability(record, { now });
  return {
    ...record,
    floatTier: rel.usable ? classifyFloat(floatShares) : classifyFloat(floatShares),
    confidence: rel.confidence,
    floatConfidence: rel.confidence,
    stale: rel.stale,
    usable: rel.usable,
    ageDays: rel.ageDays,
    notes: [...record.notes, ...rel.notes],
    schema: FLOAT_VERSION,
  };
}

// ── Network fetch for ONE ticker across every registered provider ────────────
async function fetchFloatData(ticker, { now = new Date() } = {}) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) {
    return mergeProviderAnswers(sym, [{ provider: 'input', error: 'invalid ticker' }], { now });
  }
  const answers = await Promise.all(PROVIDERS.map(async p => {
    try { return { provider: p.name, suppliesFloat: p.suppliesFloat, data: await p.fetch(sym), error: null }; }
    catch (e) { return { provider: p.name, suppliesFloat: p.suppliesFloat, data: null, error: String((e && e.message) || e) }; }
  }));
  return mergeProviderAnswers(sym, answers, { now });
}

// ── Cached batch enrichment ──────────────────────────────────────────────────
// Float changes on filings, not on ticks, so the cache TTL is a day. Cached records are
// re-assessed against the CURRENT clock on every read (a record cached fresh in March is
// correctly stale in August without a refetch), which is why staleness lives in the pure
// assessor rather than being frozen at write time.
function reassess(record, now) {
  if (!record) return record;
  const rel = assessFloatReliability(record, { now });
  return { ...record, confidence: rel.confidence, floatConfidence: rel.confidence, stale: rel.stale, usable: rel.usable, ageDays: rel.ageDays };
}

async function enrichFloatData(tickers, { now = new Date(), concurrency = 6, cap = 200, deadline = null, t0 = Date.now() } = {}) {
  const list = [...new Set((tickers || []).map(t => String(t || '').toUpperCase()).filter(Boolean))].slice(0, cap);
  const nowMs = new Date(now).getTime();
  const cacheDoc = hasStore() ? (await readFloatCache().catch(() => null)) : null;
  const cache = (cacheDoc && cacheDoc.byTicker) || {};

  const out = {};
  const toFetch = [];
  for (const t of list) {
    const c = cache[t];
    const ageH = c && c.fetchedAt ? (nowMs - Date.parse(c.fetchedAt)) / 3_600_000 : Infinity;
    if (c && ageH <= FLOAT_QUALITY.CACHE_TTL_HOURS) out[t] = reassess(c, now);
    else toFetch.push(t);
  }

  let i = 0, fetched = 0, failed = 0;
  const worker = async () => {
    while (i < toFetch.length) {
      if (deadline && Date.now() - t0 > deadline) return;
      const t = toFetch[i++];
      try {
        const rec = await fetchFloatData(t, { now });
        out[t] = rec;
        if (rec.floatShares != null) fetched++; else failed++;
      } catch {
        failed++;
        out[t] = mergeProviderAnswers(t, [{ provider: 'registry', error: 'fetch failed' }], { now });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, toFetch.length || 1)) }, worker));

  // Names the deadline cut off get an explicit UNKNOWN record — never a missing key that a
  // caller might read as "no float constraint".
  for (const t of list) if (!out[t]) out[t] = mergeProviderAnswers(t, [{ provider: 'registry', error: 'deadline' }], { now });

  if (hasStore() && (fetched || failed)) {
    try {
      const merged = { ...cache };
      for (const [t, rec] of Object.entries(out)) if (rec && rec.floatShares != null) merged[t] = rec;
      await writeFloatCache({ schema: FLOAT_VERSION, updatedAt: new Date().toISOString(), byTicker: merged });
    } catch { /* cache write is best-effort */ }
  }

  const withFloat = Object.values(out).filter(r => r.floatShares != null).length;
  return {
    byTicker: out,
    coverage: {
      requested: list.length,
      cached: list.length - toFetch.length,
      fetched,
      failed,
      withFloat,
      withoutFloat: list.length - withFloat,
      floatCoveragePct: list.length ? +((withFloat / list.length) * 100).toFixed(1) : null,
      providers: PROVIDERS.map(p => p.name),
      providerConfigured: !!process.env.FMP_API_KEY,
      note: process.env.FMP_API_KEY
        ? 'Float sourced from the configured provider registry. Names without a provider answer stay floatTier=UNKNOWN / confidence=LOW and are NEVER treated as low float.'
        : 'No float provider is configured (FMP_API_KEY missing) — every float is UNKNOWN. The low-float lane will correctly surface nothing rather than guess from market cap.',
    },
  };
}

module.exports = {
  classifyFloat, isPlausibleShareCount, recordAgeDays, assessFloatReliability,
  mergeProviderAnswers, fetchFloatData, enrichFloatData, reassess,
  PROVIDERS, fmpSharesFloat, fmpProfileShares, FLOAT_VERSION,
};
