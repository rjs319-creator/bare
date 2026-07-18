'use strict';
// decision-sources.js — gather + normalize + rank an INDEPENDENT signal set for the
// challenger, reusing the production normalizers and ranker so the challenger is measurable
// head-to-head against op=today from the same inputs. `buildRankedSignals` is pure/testable;
// `gatherRankedSignals` is the thin async wrapper that self-fetches the cached endpoints.
//
// This does NOT touch production: op=today keeps its own gather in decision-routes.js.

const N = require('./decision-normalizers');
const { makeSignal, mergeSignals, rankSignals } = require('./decision');

// Same source list op=today consumes (decision-routes.runToday).
const SOURCE_URLS = {
  screener: '/api/screener?scope=large',
  screenerSmall: '/api/screener?scope=small',
  gapgo: '/api/tracker?op=gapgo',
  daytrade: '/api/tracker?op=daytrade',
  coil: '/api/tracker?op=coil',
  gapdown: '/api/tracker?op=gapdown',
  biotech: '/api/tracker?op=biotech',
  coremo: '/api/tracker?op=core',
  downday: '/api/tracker?op=downday',
  optionsflow: '/api/tracker?op=optionsflow',
  scoreboard: '/api/tracker?op=scoreboard',
  sectors: '/api/sectors',
  today: '/api/tracker?op=today',
  rt: '/api/tracker?op=readthrough',
  an: '/api/tracker?op=anomaly',
  sw: '/api/tracker?op=secondwave',
  ca: '/api/tracker?op=crossasset',
  ts: '/api/tracker?op=toneshift',
};

// Turn each source payload into canonical Signal INPUTS, validate via makeSignal, keep valid.
function normalizeAll(sources = {}) {
  const inputs = [];
  const push = (arr) => { for (const inp of (arr || [])) inputs.push(inp); };
  if (sources.screener) push(N.fromScreener(sources.screener));
  if (sources.screenerSmall) push(N.fromScreener(sources.screenerSmall));
  if (sources.gapgo) push(N.fromGapGo(sources.gapgo));
  if (sources.daytrade) push(N.fromDayTrade(sources.daytrade));
  if (sources.coil) push(N.fromCoil(sources.coil));
  if (sources.gapdown) push(N.fromGapDown(sources.gapdown));
  if (sources.biotech) push(N.fromBiotech(sources.biotech));
  if (sources.coremo) push(N.fromCoreMomentum(sources.coremo));
  if (sources.downday) push(N.fromDownDay(sources.downday));
  if (sources.optionsflow) push(N.fromOptionsFlow(sources.optionsflow));
  push(N.fromAiScreeners({ rt: sources.rt, an: sources.an, sw: sources.sw, ca: sources.ca, ts: sources.ts }));

  const sectors = sources.sectors ? N.sectorStrength(sources.sectors) : null;
  const signals = [];
  for (const inp of inputs) {
    if (sectors && inp.sector && sectors.byName && sectors.byName[inp.sector] != null && inp.sectorStrength == null) {
      inp.sectorStrength = sectors.byName[inp.sector];
    }
    const { signal } = makeSignal(inp);
    if (signal && signal.valid) signals.push(signal);
  }
  return { signals, sectors };
}

// Pure: normalize -> merge -> rank. `ctx`: { regime, scoreboard }.
function buildRankedSignals(sources = {}, ctx = {}) {
  const { signals, sectors } = normalizeAll(sources);
  const merged = mergeSignals(signals);
  const ranked = rankSignals(merged, { regime: ctx.regime || {}, scoreboard: ctx.scoreboard || null, includeInactive: false });
  return { ranked, sectors, count: ranked.length };
}

// Async wrapper: self-fetch the cached endpoints, then build. `fetchJSON(path)` is injected
// (returns parsed JSON or null) so this is testable without a network.
async function gatherRankedSignals(fetchJSON, opts = {}) {
  const keys = Object.keys(SOURCE_URLS);
  const results = await Promise.all(keys.map(async (k) => {
    try { return [k, await fetchJSON(SOURCE_URLS[k])]; } catch { return [k, null]; }
  }));
  const sources = Object.fromEntries(results);
  const today = sources.today || {};
  const regime = opts.regime || today.regime || {};
  const scoreboard = sources.scoreboard || null;
  const built = buildRankedSignals(sources, { regime, scoreboard });
  return { ...built, regime, sectors: built.sectors, today, density: today.opportunity || null, sources };
}

module.exports = { SOURCE_URLS, normalizeAll, buildRankedSignals, gatherRankedSignals };
