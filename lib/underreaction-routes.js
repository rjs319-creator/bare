'use strict';
// 📰 NEWS UNDERREACTION routes — folded into api/tracker.js (no new function).
//
//   op=underreaction     compute + return candidate states from the LATEST evidence
//                        snapshot (read-only; expensive, rate-limited)
//   op=underreactionlog  (cron/privileged) compute, persist latest, roll the seen-
//                        fingerprint window, append FRESH_* candidates to the ledger
//
// PROSPECTIVE-ONLY by construction: states are computed exclusively for events the
// evidence engine ingested live (lib/evidence-routes), from their ORIGINAL publish
// timestamps. There is no backfill op and none may be added — replaying present-day
// LLM interpretations onto old dates is exactly the leakage this design forbids.
// Events extracted before the publishedAt field existed report INSUFFICIENT_DATA
// ('no-publish-timestamp') rather than a guessed age.

const { nowET } = require('./stats');
const S = require('./store');
const { mapLimit } = require('./map-limit');
const { fetchDailyHistory } = require('./screener');
const { benchFor } = require('./readthrough');
const { classifyUnderreaction, priceReaction, eventFingerprint, UNDERREACTION_VERSION, POLICY } = require('./underreaction');

const LATEST_PATH = 'underreaction/latest.json';
const SEEN_PATH = 'underreaction/seen.json';       // rolling fingerprint window (repeat detection)
const MAX_TICKERS = 14;                            // matches the evidence tick's own bound
const FETCH_CONCURRENCY = 4;
const FRESH_STATES = new Set(['FRESH_POSITIVE_UNDERREACTION', 'FRESH_NEGATIVE_UNDERREACTION']);
const SECTION = 'Underreaction';

function json(res, code, obj, sMaxAge) {
  if (sMaxAge) res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=60`);
  return res.status(code).json(obj);
}

// Fingerprints seen within the stale-lookback window, from the rolling seen doc.
function recentFingerprints(seenDoc, date) {
  const cutoff = new Date(new Date(date) - POLICY.staleLookbackDays * 864e5).toISOString().slice(0, 10);
  const out = new Set();
  for (const [fp, d] of Object.entries((seenDoc && seenDoc.byFingerprint) || {})) {
    if (d >= cutoff) out.add(fp);
  }
  return out;
}

async function computeStates({ date }) {
  const snap = await S.readLatestEvidence();
  if (!snap || !Array.isArray(snap.results) || !snap.results.length) {
    return { ok: false, reason: 'no-evidence-snapshot', date, records: [] };
  }
  const seenDoc = await S.readJSON(SEEN_PATH, null).catch(() => null);
  const seen = recentFingerprints(seenDoc, date);

  // One primary event per cluster, capped tickers — the same bound as the tick.
  const perTicker = snap.results.filter(r => r && r.ticker && Array.isArray(r.clusters) && r.clusters.length).slice(0, MAX_TICKERS);

  const spy = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyCandles = (spy && spy.candles) || [];
  const sectorCache = new Map();
  const sectorCandlesFor = async sector => {
    const etf = benchFor(sector);
    if (!etf) return [];
    if (!sectorCache.has(etf)) {
      const r = await fetchDailyHistory(etf, '1y').catch(() => null);
      sectorCache.set(etf, (r && r.candles) || []);
    }
    return sectorCache.get(etf);
  };

  const records = [];
  const rows = await mapLimit(perTicker, FETCH_CONCURRENCY, async r => {
    const hist = await fetchDailyHistory(r.ticker, '1y').catch(() => null);
    return { r, candles: (hist && hist.candles) || [] };
  });
  for (const row of rows) {
    if (!row) continue;
    const { r, candles } = row;
    const sectorCandles = await sectorCandlesFor(r.sector);
    for (const cl of r.clusters) {
      const event = cl.primary;
      if (!event) continue;
      const fp = eventFingerprint(event);
      const reaction = event.publishedAt
        ? priceReaction({ bars: candles, benchBars: spyCandles, sectorBars: sectorCandles, publishedAt: event.publishedAt, asOf: date })
        : null;
      const state = classifyUnderreaction(event, reaction, { isRepeated: fp ? seen.has(fp) : false });
      records.push({
        ...state,
        fingerprint: fp,
        company: r.company, sector: r.sector, price: r.price,
        eventType: event.eventType, claim: event.claim, direction: event.direction,
        materialityScore: event.materialityScore, noveltyScore: event.noveltyScore,
        sourceType: event.sourceType, primarySourceCount: event.primarySourceCount,
        detectedAt: event.detectedAt,
      });
    }
  }

  const counts = {};
  for (const rec of records) counts[rec.state] = (counts[rec.state] || 0) + 1;
  return {
    ok: true, version: UNDERREACTION_VERSION, date,
    evidenceDate: snap.date || null, tickers: perTicker.length, records, counts,
    honesty: 'Prospective-only. No historical backfill exists or is permitted; probabilities unlock only after matured prospective outcomes support out-of-fold calibration.',
    researchOnly: true,
  };
}

async function runUnderreaction(req, res) {
  try {
    const { date } = nowET();
    const out = await computeStates({ date });
    if (!out.ok) {
      const cached = await S.readJSON(LATEST_PATH, null).catch(() => null);
      if (cached) return json(res, 200, { ...cached, stale: true, reason: out.reason }, 60);
    }
    return json(res, 200, out, 300);
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

async function runUnderreactionLog(req, res) {
  try {
    const { date, isMarketClosed } = nowET();
    if (isMarketClosed) return json(res, 200, { ok: true, skipped: 'market-closed', date });
    const out = await computeStates({ date });
    if (!out.ok) return json(res, 200, { ok: false, reason: out.reason, date });
    await S.writeJSON(LATEST_PATH, out, 0);

    // Roll the seen-fingerprint window forward (repeat detection for future days).
    const seenDoc = await S.readJSON(SEEN_PATH, null).catch(() => null) || { byFingerprint: {} };
    const cutoff = new Date(new Date(date) - POLICY.staleLookbackDays * 2 * 864e5).toISOString().slice(0, 10);
    const byFingerprint = {};
    for (const [fp, d] of Object.entries(seenDoc.byFingerprint || {})) if (d >= cutoff) byFingerprint[fp] = d;
    for (const rec of out.records) if (rec.fingerprint && !byFingerprint[rec.fingerprint]) byFingerprint[rec.fingerprint] = date;
    await S.writeJSON(SEEN_PATH, { byFingerprint, updatedAt: new Date().toISOString() }, 0);

    // Immutable day ledger — write once; re-runs never rewrite a recorded day.
    const existing = await S.readJSON(`${S.UNDERREACTION_LEDGER}${date}.json`, null).catch(() => null);
    if (existing) return json(res, 200, { ok: true, date, persisted: false, reason: 'already-recorded', picks: (existing.picks || []).length });

    const picks = out.records
      .filter(rec => FRESH_STATES.has(rec.state) && Number.isFinite(rec.price))
      .map(rec => ({
        date, ts: new Date().toISOString(),
        ticker: rec.ticker, section: SECTION, tier: rec.state,
        sector: rec.sector || null, bench: rec.sector ? benchFor(rec.sector) : null,
        entry: rec.price, score: rec.gap, signalVersion: UNDERREACTION_VERSION,
        short: rec.state === 'FRESH_NEGATIVE_UNDERREACTION',
        publishedAt: rec.publishedAt, fingerprint: rec.fingerprint,
      }));
    await S.writeUnderreactionDay(date, { picks, version: UNDERREACTION_VERSION });
    return json(res, 200, { ok: true, date, persisted: true, picks: picks.length, counts: out.counts });
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

module.exports = { runUnderreaction, runUnderreactionLog, computeStates, SECTION };
