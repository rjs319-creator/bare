'use strict';
// SHORT INTEREST OVERLAY — shadow research ops for OMEGA_SI_LEVEL_5D_TOP10.
//
//   op=sistatus    public read  — experiment status, verdict, coverage, data age, prospective progress
//   op=sisnapshot  public read  — latest point-in-time FINRA short-interest fields per universe ticker
//   op=sihealth    public read  — integrity: schema, duplicates, future-join scan, staleness, ledger hash
//   op=siwf        public read  — walk-forward folds, arm metrics, incremental CIs, p/q, robustness, verdict
//   op=siledger    public read  — paginated shadow decisions + resolved outcomes (retrospective + prospective)
//   op=siexport    public read  — CSV/JSON research export (ledger; no secrets)
//   op=sitick      PRIVILEGED   — nightly prospective logger/resolver under the FROZEN model
//
// SHADOW / weight-0. Nothing here reads from or writes into live OMEGA scoring, ranking,
// alerts, recommendations or portfolio construction. Retrospective artifacts are the
// committed bundle in lib/si-overlay/ (research/ is vercelignored); prospective rows
// accrue in Blob under si/v1/prospective/.

const fs = require('node:fs');
const path = require('node:path');
const { requireTrusted } = require('./auth');
const STORE = require('./store');
const SI = require('./research/finra-si');
const F = require('./research/si-features');
const X = require('./research/si-experiment');
const { fetchShortInterest } = require('./shortinterest');
const { logWarn } = require('./log');

const BUNDLE_DIR = path.join(__dirname, 'si-overlay');
const PROSPECTIVE_INDEX = 'si/v1/prospective/index.json';
const prospectiveKey = (date) => `si/v1/prospective/${date}.json`;
const RESOLVE_AFTER_CALENDAR_DAYS = 9;   // >= 5 sessions after decision before resolution is attempted
const PROMOTION_GATE = Object.freeze({ minResolvedDates: 100, minPositiveBlocks: 3 });

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 300) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

// Bundle reads are memoized per process; absence is an honest "not published", never a throw.
const bundleMemo = new Map();
function bundle(name) {
  if (!bundleMemo.has(name)) {
    try { bundleMemo.set(name, JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, `${name}.json`), 'utf8'))); }
    catch { bundleMemo.set(name, null); }
  }
  return bundleMemo.get(name);
}

async function readProspectiveIndex() {
  return STORE.hasStore() ? STORE.readJSON(PROSPECTIVE_INDEX, { dates: [] }) : { dates: [] };
}

function dataAgeDays(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? +(ms / 86_400_000).toFixed(1) : null;
}

// ── op=sistatus ─────────────────────────────────────────────────────────────
async function runSiStatus(req, res) {
  const result = bundle('result');
  const snapshot = bundle('snapshot');
  const idx = await readProspectiveIndex().catch(() => ({ dates: [] }));
  let prospective = { logged: idx.dates.length, resolved: 0 };
  if (STORE.hasStore() && idx.dates.length) {
    const recent = idx.dates.slice(-120);
    const docs = await Promise.all(recent.map((d) => STORE.readJSON(prospectiveKey(d), null).catch(() => null)));
    prospective.resolved = docs.filter((d) => d && d.resolved).length;
  }
  const latest = snapshot ? Object.values(snapshot.latestBySymbol || {})
    .reduce((a, r) => (!a || r.settlementDate > a.settlementDate ? r : a), null) : null;
  const warnings = [];
  if (!result) warnings.push('retrospective bundle not published');
  if (latest && dataAgeDays(latest.fetchedAt) > 21) warnings.push('FINRA snapshot older than 21 days');
  cached(res, 300);
  res.status(200).json({
    experimentId: X.EXPERIMENT_ID, version: X.SI_EXPERIMENT_VERSION,
    shadow: true, affectsLiveOmega: false,
    verdict: result ? result.verdict : 'INSUFFICIENT_DATA',
    verdictReasons: result ? result.verdictReasons : ['retrospective bundle not published'],
    retrospective: result ? {
      oosDates: result.primary.oosDates, joinedRows: result.primary.joinedRows,
      tickers: result.primary.tickers, siCoverage: result.primary.siCoverage,
      incremental: result.primary.incremental ? {
        meanPct: result.primary.incremental.meanPct,
        ci95: result.primary.incremental.bootstrap ? { lo: result.primary.incremental.bootstrap.lo, hi: result.primary.incremental.bootstrap.hi } : null,
        q: result.fdr ? result.fdr.primaryQ : null,
      } : null,
      positiveFolds: `${result.primary.positiveFolds}/${result.primary.usableFolds}`,
      generatedAt: result.generatedAt,
    } : null,
    prospective: { ...prospective, promotionGate: PROMOTION_GATE, progressPct: +(100 * Math.min(1, prospective.resolved / PROMOTION_GATE.minResolvedDates)).toFixed(1) },
    finra: latest ? {
      latestSettlementDate: latest.settlementDate, latestPublicationDate: latest.publicationDate,
      availableAt: latest.availableAt, availabilityMethod: latest.availabilityMethod,
      lastSuccessfulFetch: latest.fetchedAt, dataAgeDays: dataAgeDays(latest.fetchedAt),
    } : null,
    integrityWarnings: warnings,
  });
}

// ── op=sisnapshot ───────────────────────────────────────────────────────────
async function runSiSnapshot(req, res) {
  const snapshot = bundle('snapshot');
  if (!snapshot) { noStore(res); return res.status(200).json({ ok: false, reason: 'snapshot bundle not published' }); }
  // If the live app-side cache has a NEWER settlement, surface that fact honestly —
  // the bundled full-field rows still come from the research downloader.
  let liveSettlement = null;
  try { const live = await fetchShortInterest(); liveSettlement = live && live.settlementDate; } catch { /* optional */ }
  const rows = Object.entries(snapshot.latestBySymbol || {}).map(([ticker, r]) => ({
    ticker, settlementDate: r.settlementDate, publicationDate: r.publicationDate,
    availableAt: r.availableAt, availabilityMethod: r.availabilityMethod,
    daysToCover: r.dtc, shortInterest: r.si, previousShortInterest: r.prevSi,
    changePercent: r.changePercent,   // diagnostic only — never a model input
    revisionFlag: r.revisionFlag, revisionRisk: r.revisionRisk,
    crowding: Number.isFinite(r.dtc) && r.dtc >= F.CROWDED_DTC ? `Extreme crowding: >=7 DTC` : 'Normal',
    fetchedAt: r.fetchedAt, sourceHash: r.sourceHash,
  })).sort((a, b) => a.ticker.localeCompare(b.ticker));
  cached(res, 600);
  res.status(200).json({ generatedAt: snapshot.generatedAt, source: snapshot.source, newerLiveSettlement: liveSettlement && rows[0] && liveSettlement > rows[0].settlementDate ? liveSettlement : null, rows });
}

// ── op=sihealth ─────────────────────────────────────────────────────────────
async function runSiHealth(req, res) {
  const result = bundle('result');
  const ledger = bundle('ledger');
  const checks = { ok: true, issues: [] };
  const push = (sev, what) => { checks.issues.push({ severity: sev, what }); if (sev === 'error') checks.ok = false; };
  if (!result) push('error', 'result bundle missing');
  if (!ledger) push('error', 'ledger bundle missing');
  let futureJoins = 0, missingLastBar = 0, unresolved = 0, dupKeys = 0;
  if (ledger && Array.isArray(ledger.rows)) {
    const seen = new Set();
    for (const r of ledger.rows) {
      if (r.siAvailableAt && r.decisionDate && r.siAvailableAt > r.decisionDate) futureJoins++;
      if (!r.lastBarDate) missingLastBar++;
      if (r.outcomeStatus !== 'RESOLVED_RETROSPECTIVE' && r.outcomeStatus !== 'RESOLVED') unresolved++;
      const k = `${r.decisionDate}|${r.ticker}`;
      if (seen.has(k)) dupKeys++; else seen.add(k);
    }
    if (futureJoins) push('error', `${futureJoins} future-join violations (siAvailableAt > decisionDate)`);
    if (missingLastBar) push('error', `${missingLastBar} ledger rows missing lastBarDate`);
    if (dupKeys) push('error', `${dupKeys} duplicate decision/ticker ledger rows`);
    if (unresolved) push('warn', `${unresolved} unresolved ledger outcomes`);
    // Mutation check: the committed ledger must hash to the value stamped at run time.
    const expect = result && result.integrity && result.integrity.ledgerSha256;
    if (expect) {
      const got = SI.sourceHash(JSON.stringify(ledger));
      if (got !== expect) push('error', 'ledger bundle hash mismatch — shadow ledger was mutated after the run');
    }
  }
  if (result) {
    const h = result.dataSnapshot && result.dataSnapshot.siHealth;
    if (h && h.invalid) push('warn', `${h.invalid} invalid FINRA rows dropped at ingest (${JSON.stringify(h.invalidReasons)})`);
    if (h && h.duplicates) push('warn', `${h.duplicates} duplicate FINRA rows dropped at ingest`);
    if ((result.primary.siCoverage || 0) < 0.6) push('error', `SI coverage ${result.primary.siCoverage} below 0.60`);
    if (result.dataSnapshot.missingLastBarDate) push('info', `${result.dataSnapshot.missingLastBarDate} name-dates excluded at reconstruction because the series' last bar was not the decision bar`);
  }
  const snapshot = bundle('snapshot');
  const latest = snapshot ? Object.values(snapshot.latestBySymbol || {}).reduce((a, r) => (!a || r.settlementDate > a.settlementDate ? r : a), null) : null;
  if (latest && dataAgeDays(latest.fetchedAt) > 21) push('warn', `FINRA data age ${dataAgeDays(latest.fetchedAt)} days`);
  cached(res, 300);
  res.status(200).json({ experimentId: X.EXPERIMENT_ID, ...checks, ledgerRows: ledger ? ledger.rows.length : 0, generatedAt: new Date().toISOString() });
}

// ── op=siwf ─────────────────────────────────────────────────────────────────
async function runSiWf(req, res) {
  const result = bundle('result');
  const sensitivity = bundle('sensitivity');
  if (!result) { noStore(res); return res.status(200).json({ ok: false, verdict: 'INSUFFICIENT_DATA', reason: 'retrospective bundle not published' }); }
  cached(res, 600);
  res.status(200).json({
    experimentId: X.EXPERIMENT_ID, shadow: true, affectsLiveOmega: false,
    verdict: result.verdict, verdictReasons: result.verdictReasons,
    frozenConfig: result.frozenConfig,
    folds: result.primary.folds,
    arms: result.primary.arms, meanIC: result.primary.meanIC,
    incremental: result.primary.incremental, portfolio: result.primary.portfolio,
    fdr: result.fdr,
    robustness: sensitivity ? sensitivity.results : result.robustness,
    discrepancyInvestigation: result.discrepancyInvestigation || null,
    reproductionCheck: result.reproductionCheck || null,
    limitations: result.limitations,
    generatedAt: result.generatedAt,
  });
}

// ── op=siledger ─────────────────────────────────────────────────────────────
async function runSiLedger(req, res) {
  const ledger = bundle('ledger');
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const scope = req.query.scope === 'prospective' ? 'prospective' : 'retrospective';
  if (scope === 'prospective') {
    const idx = await readProspectiveIndex().catch(() => ({ dates: [] }));
    const dates = idx.dates.slice().sort().reverse().slice(offset, offset + Math.min(limit, 30));
    const docs = STORE.hasStore() ? (await Promise.all(dates.map((d) => STORE.readJSON(prospectiveKey(d), null).catch(() => null)))).filter(Boolean) : [];
    noStore(res);
    return res.status(200).json({ scope, total: idx.dates.length, offset, days: docs });
  }
  if (!ledger) { noStore(res); return res.status(200).json({ ok: false, reason: 'ledger bundle not published' }); }
  cached(res, 600);
  res.status(200).json({
    scope, experimentId: ledger.experimentId, runId: ledger.runId, modelVersion: ledger.modelVersion,
    provenance: ledger.provenance, total: ledger.rows.length, offset, limit,
    rows: ledger.rows.slice(offset, offset + limit),
  });
}

// ── op=siexport ─────────────────────────────────────────────────────────────
const EXPORT_FIELDS = [
  'experimentId', 'runId', 'modelVersion', 'decisionDate', 'decisionTime', 'lastBarDate', 'ticker',
  'baselineRank', 'augmentedRank', 'baselineSelected', 'augmentedSelected', 'omegaScore', 'r10',
  'siSettlementDate', 'siPublicationDate', 'siAvailableAt', 'siFetchedAt', 'siLogDtc', 'siCrowded7',
  'revisionFlag', 'revisionRisk', 'entryDate', 'entryOpen', 'exitDate', 'exitClose',
  'rawReturn', 'benchmarkReturn', 'residualReturn', 'cost', 'netResidualReturn', 'outcomeStatus', 'sourceHash',
];
async function runSiExport(req, res) {
  const ledger = bundle('ledger');
  if (!ledger) { noStore(res); return res.status(200).json({ ok: false, reason: 'ledger bundle not published' }); }
  const fmt = req.query.format === 'json' ? 'json' : 'csv';
  cached(res, 600);
  if (fmt === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="omega-si-shadow-ledger.json"');
    return res.status(200).json({ experimentId: ledger.experimentId, provenance: ledger.provenance, rows: ledger.rows });
  }
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [EXPORT_FIELDS.join(',')];
  for (const r of ledger.rows) lines.push(EXPORT_FIELDS.map((f) => esc(r[f])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="omega-si-shadow-ledger.csv"');
  res.status(200).send(lines.join('\n') + '\n');
}

// ── op=sitick (PRIVILEGED) — prospective logger + resolver under the frozen model ──
// Logs today's top-10 for BOTH arms before outcomes exist (write-once per date), and
// resolves matured pending days. Decisions are never rewritten after outcomes resolve —
// resolution only fills the outcome fields of already-stamped rows.
async function runSiTick(req, res) {
  if (!requireTrusted(req, res)) return;
  noStore(res);
  if (!STORE.hasStore()) return res.status(503).json({ ok: false, reason: 'no blob store configured' });
  const model = bundle('model');
  if (!model || !model.baseline || !model.augmented) return res.status(200).json({ ok: false, reason: 'frozen model bundle not published' });

  const { fetchDailyHistory } = require('./screener');
  const O = require('./omega-swing');
  const { SECTOR_ETF } = require('./omega-backfill');
  const { SECTOR_OF } = require('./universe');
  const { roundTripCostPct } = require('./costs');
  const SECTOR_SUPPLEMENT = {
    MSTR: 'Technology', BABA: 'Consumer Discretionary', MRVL: 'Technology',
    SNAP: 'Communication Services', GME: 'Consumer Discretionary',
    AMC: 'Communication Services', SHOP: 'Technology',
  };
  const sectorOf = (t) => SECTOR_OF[t] || SECTOR_SUPPLEMENT[t] || null;
  const universe = model.universe || [];
  const report = { logged: null, resolved: [], skipped: [], errors: [] };

  const spyDoc = await fetchDailyHistory('SPY', '2y').catch(() => null);
  if (!spyDoc || !spyDoc.candles || !spyDoc.candles.length) return res.status(200).json({ ok: false, reason: 'no SPY history' });
  const spy = spyDoc.candles;
  const today = spy[spy.length - 1].date;

  const idx = await readProspectiveIndex().catch(() => ({ dates: [] }));

  // Bounded fetch helper with small concurrency.
  const histories = new Map();
  const getHist = async (t) => {
    if (!histories.has(t)) histories.set(t, await fetchDailyHistory(t, '2y').then((d) => (d && d.candles) || null).catch(() => null));
    return histories.get(t);
  };
  const mapLimit = async (items, limit, fn) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k]); }
    }));
  };

  // ── 1) Log today's decisions (write-once) ──
  if (idx.dates.includes(today)) {
    report.skipped.push(`${today} already logged`);
  } else {
    const live = await fetchShortInterest().catch(() => null);
    const avail = live && live.settlementDate ? SI.availabilityFor(live.settlementDate) : null;
    const siUsable = avail && avail.availableAt <= today;
    const sectorCandles = {};
    await mapLimit([...new Set(Object.values(SECTOR_ETF))], 4, async (etf) => { sectorCandles[etf] = await getHist(etf); });
    await mapLimit(universe, 6, getHist);
    const rows = [];
    for (const t of universe) {
      const candles = histories.get(t);
      if (!candles || candles.length < 220) continue;
      if (candles[candles.length - 1].date !== today) continue;   // lastBarDate must be the decision bar
      const etf = SECTOR_ETF[sectorOf(t)];
      const sec = etf && sectorCandles[etf] ? sectorCandles[etf] : null;
      let card = null;
      try {
        card = O.evaluateCandidate({ ticker: t, candles, bench: { spy, sector: sec }, ctx: { regime: { riskOn: F.spyRegime(spy).riskOn, bearish: F.spyRegime(spy).bearish } } });
      } catch (e) { report.errors.push(`${t}: ${e.message}`); }
      if (!card || !Number.isFinite(card.score)) continue;
      const siRec = siUsable && live.bySymbol && live.bySymbol[t]
        ? { settlementDate: live.settlementDate, dtc: live.bySymbol[t].dtc, si: live.bySymbol[t].si, adv: live.bySymbol[t].adv, revisionFlag: null, revisionRisk: false, fetchedAt: live.fetchedAt, sourceHash: null, ...avail }
        : null;
      rows.push({
        ticker: t, lastBarDate: today, sector: sectorOf(t), si: siRec, dtc: siRec ? siRec.dtc : null,
        score: card.score, utility: card.utility,
        pPositive: card.pred.pPositive, p3pct: card.pred.p3pct, p5pct: card.pred.p5pct,
        expResid10: card.pred.expResidual10,
        r10: card.features.r10, distFrom52High: card.features.distFrom52High, relVol5: card.features.relVol5,
        costTier: 'liquid',
      });
    }
    if (rows.length < 20) {
      report.skipped.push(`${today}: only ${rows.length} evaluable names — not logged`);
    } else {
      const regime = F.spyRegime(spy);
      const featured = F.attachSiFeatures(rows).map((r) => ({
        ...r, regRiskOn: regime.riskOn ? 1 : 0, regBearish: regime.bearish ? 1 : 0,
        ...Object.fromEntries((model.sectors || []).map((s) => [`sec_${s}`, r.sector === s ? 1 : 0])),
      }));
      const score = (arm) => (r) => X.ridgePredict(model[arm].model, X.designVector(r, model[arm].prep));
      const topB = X.topK(featured, score('baseline'), 10);
      const topC = X.topK(featured, score('augmented'), 10);
      const ranksB = X.rankMap(featured, score('baseline')), ranksC = X.rankMap(featured, score('augmented'));
      const setB = new Set(topB.map((r) => r.ticker)), setC = new Set(topC.map((r) => r.ticker));
      const doc = {
        experimentId: X.EXPERIMENT_ID, runId: 'prospective', modelVersion: X.SI_EXPERIMENT_VERSION,
        modelFrozenAt: model.frozenAt, decisionDate: today, decisionTime: `${today} session close (US/Eastern)`,
        createdAt: new Date().toISOString(), provenance: 'prospective_frozen_shadow',
        evaluated: featured.length, resolved: false,
        rows: featured.filter((r) => setB.has(r.ticker) || setC.has(r.ticker)).map((r) => ({
          ticker: r.ticker, lastBarDate: r.lastBarDate,
          baselineRank: ranksB.get(r.ticker) ?? null, augmentedRank: ranksC.get(r.ticker) ?? null,
          baselineSelected: setB.has(r.ticker), augmentedSelected: setC.has(r.ticker),
          omegaScore: r.score, r10: r.r10,
          siSettlementDate: r.si ? r.si.settlementDate : null, siPublicationDate: r.si ? r.si.publicationDate : null,
          siAvailableAt: r.si ? r.si.availableAt : null, siFetchedAt: r.si ? r.si.fetchedAt : null,
          siLogDtc: r.siLogDtc, siCrowded7: r.siCrowded7,
          revisionFlag: r.si ? r.si.revisionFlag : null, revisionRisk: r.si ? r.si.revisionRisk : null,
          sourceHash: r.si ? r.si.sourceHash : null,
          entryDate: null, entryOpen: null, exitDate: null, exitClose: null,
          rawReturn: null, benchmarkReturn: null, residualReturn: null,
          cost: roundTripCostPct('liquid'), netResidualReturn: null, outcomeStatus: 'PENDING',
        })),
      };
      await STORE.writeJSON(prospectiveKey(today), doc, 0);
      await STORE.writeJSON(PROSPECTIVE_INDEX, { dates: [...idx.dates, today].sort() }, 0);
      idx.dates.push(today);
      report.logged = { date: today, evaluated: featured.length, rows: doc.rows.length, siUsable: !!siUsable };
    }
  }

  // ── 2) Resolve matured pending days ──
  const matured = idx.dates.filter((d) => Date.parse(today) - Date.parse(d) >= RESOLVE_AFTER_CALENDAR_DAYS * 86_400_000);
  const spyIdx = new Map(spy.map((b, i) => [b.date, i]));
  for (const d of matured.slice(-30)) {
    try {
      const doc = await STORE.readJSON(prospectiveKey(d), null);
      if (!doc || doc.resolved) continue;
      const si = spyIdx.get(d);
      if (si == null || si + 5 > spy.length - 1) continue;
      const spyRet = spy[si + 5].close / spy[si + 1].open - 1;
      let pending = 0;
      const rows = [];
      for (const r of doc.rows) {
        const candles = await getHist(r.ticker);
        const idxMap = candles ? new Map(candles.map((b, i) => [b.date, i])) : null;
        const i = idxMap ? idxMap.get(d) : null;
        if (i == null || i + 5 > candles.length - 1) { pending++; rows.push(r); continue; }
        const e = candles[i + 1], x = candles[i + 5];
        if (!e || !(e.open > 0) || !x || !(x.close > 0)) { pending++; rows.push({ ...r, outcomeStatus: 'UNRESOLVABLE' }); continue; }
        const raw = (x.close / e.open - 1) * 100;
        const bench = spyRet * 100;
        const residual = raw - bench;
        rows.push({
          ...r, entryDate: e.date, entryOpen: e.open, exitDate: x.date, exitClose: x.close,
          rawReturn: +raw.toFixed(4), benchmarkReturn: +bench.toFixed(4), residualReturn: +residual.toFixed(4),
          netResidualReturn: +(residual - r.cost).toFixed(4), outcomeStatus: 'RESOLVED',
        });
      }
      if (!pending) {
        // Decisions are untouched — only outcome fields were filled.
        await STORE.writeJSON(prospectiveKey(d), { ...doc, rows, resolved: true, resolvedAt: new Date().toISOString() }, 0);
        report.resolved.push(d);
      }
    } catch (e) { report.errors.push(`resolve ${d}: ${e.message}`); logWarn('sitick resolve failed', { date: d, error: e.message }); }
  }

  res.status(200).json({ ok: true, today, ...report });
}

module.exports = { runSiStatus, runSiSnapshot, runSiHealth, runSiWf, runSiLedger, runSiExport, runSiTick, EXPORT_FIELDS, PROMOTION_GATE };
