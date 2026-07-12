// SOURCE ADAPTERS — normalize each screener's native pick shape into the canonical
// Signal input consumed by lib/decision.js makeSignal(). Pure (JSON in → array out),
// so they're unit-testable and the op=today route stays a thin orchestrator.
//
// The `section`/`tier` on each signal are the SAME keys the Scoreboard groups by
// (section:tier → realized excess), so expectancyFor() resolves a live track record.
// `evidenceFamilies` is the honest independent-evidence view (#3) — e.g. a breakout
// name that is ALSO under quiet accumulation carries priceTrend + volumeAccum.

'use strict';

const clampConf = (v, def = 55) => {
  const n = +v;
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(100, n));
};

// ── Breakout / Opportunities pool (from /api/screener) — swing ──────────────
// Carries breakout structure (priceTrend) AND, when present, the Ghost accumulation
// tier (volumeAccum) + fundamental acceleration (fundamentalsRevisions) on one name.
function fromScreener(json) {
  const results = (json && json.results) || [];
  return results.filter(r => r && r.levels && r.status && r.levels.entry > 0).map(r => {
    const fams = ['priceTrend'];
    const gt = r.ghost && r.ghost.tier;
    if (gt === 'GHOST' || gt === 'STALKING') fams.push('volumeAccum');
    const f = r.factors || {};
    if ((f.revAccel ?? 0) > 3 || (r.fundamentals && (r.fundamentals.revGrowth ?? 0) >= 25)) fams.push('fundamentalsRevisions');
    if ((r.insider && (r.insider.net?.value ?? 0)) > 1e5) fams.push('insider');
    return {
      source: 'screener', section: 'screener', tier: r.status,
      horizon: 'swing', side: 'long',
      ticker: r.ticker, company: r.company, sector: r.sector,
      price: r.price, entry: r.levels.entry, stop: r.levels.stop, target: r.levels.target, rr: r.levels.rr,
      rawConfidence: clampConf(r.quant?.score ?? r.ghost?.score, 60),
      setup: r.status,
      evidenceFamilies: fams,
      liquidity: { dollarVol: f.dollarVol, price: r.price },
      catalyst: r.narrative || null,
      scoringVersion: 'screener-v1',
    };
  });
}

// ── Gap & Go (op=gapgo) — intraday continuation off an unscheduled gap ───────
function fromGapGo(json) {
  const items = [...((json && json.strong) || []), ...((json && json.moderate) || [])];
  return items.filter(g => g && g.plan && g.plan.trigger > 0).map(g => ({
    source: 'gapgo', section: 'GapGo', tier: g.tier,
    horizon: 'intraday', side: 'long',
    ticker: g.ticker, sector: g.sector, price: g.last,
    entry: g.plan.trigger, stop: g.plan.stop, target: g.plan.target, rr: g.plan.rr,
    rawConfidence: clampConf(g.continuationScore, 55),
    setup: 'gap-continuation',
    evidenceFamilies: ['priceTrend', 'catalystForcedFlow'],
    liquidity: { dollarVol: g.avgDollarVol, price: g.last },
    event: g.nextEarnings ? { type: 'earnings', when: g.nextEarnings, kind: g.earningsCheck === 'clear' ? 'passed' : 'binary' } : null,
    catalyst: g.cause && g.cause !== 'OTHER' ? g.cause : 'gap-up',
    scoringVersion: 'gapgo-v1',
  }));
}

// ── Day Trade (op=daytrade) — intraday rel-strength / ORB ────────────────────
function fromDayTrade(json) {
  const items = (json && json.bestOpportunities) || [];
  return items.filter(d => d && d.entry > 0 && d.stop > 0).map(d => ({
    source: 'daytrade', section: 'daytrade', tier: d.tier,
    horizon: 'intraday', side: 'long',
    ticker: d.ticker, sector: d.sector, price: d.last,
    entry: d.entry, stop: d.stop, target: d.target, rr: d.rr,
    rawConfidence: clampConf(d.relScore, 50),
    setup: d.source || 'intraday',
    evidenceFamilies: ['priceTrend'],
    liquidity: { price: d.last },            // dollarVol not exposed → execution stays neutral
    catalyst: d.catalyst && d.catalyst !== '?' ? d.catalyst : null,
    scoringVersion: 'daytrade-v1',
  }));
}

// ── Coil Radar (op=coil) — volatility compression → abnormal move, swing ─────
function fromCoil(json) {
  const items = (json && json.picks) || [];
  return items.filter(c => c && c.entry > 0 && c.stop > 0).map(c => ({
    source: 'coil', section: 'coil', tier: c.band || 'coil',
    horizon: 'swing', side: 'long',
    ticker: c.ticker, company: c.company, sector: c.sector, price: c.price,
    entry: c.entry, stop: c.stop, target: c.target, rr: c.rr,
    rawConfidence: clampConf(40 + (c.decile || 5) * 4, 55),  // decile 10 → ~80
    setup: 'coil',
    evidenceFamilies: ['priceTrend'],
    liquidity: { price: c.price },
    scoringVersion: 'coil-v1',
  }));
}

// ── The 5 AI-reasoning screeners — cross-cutting LEADS (position horizon) ────
// Non-price angles (read-through, no-news accumulation, second-leg, cross-asset,
// tone-shift). No entry/stop/target → they surface as research leads, not triggers,
// and rank modestly (lifecycle stays 'detected', execution neutral).
const AI_MAP = {
  rt: { section: 'ReadThrough', family: 'crossAsset', pick: i => i.moved && i.moved.alreadyMoved === false, tk: i => i.beneficiary_ticker, note: i => i.mechanism || i.thesis, score: i => i.directness, tier: 'Fresh' },
  an: { section: 'Anomaly', family: 'volumeAccum', pick: i => i.classification === 'ACCUMULATION', tk: i => i.ticker, note: i => i.thesis, score: i => i.confidence, tier: 'ACCUMULATION' },
  sw: { section: 'SecondWave', family: 'crossAsset', pick: i => i.classification === 'PRIMED', tk: i => i.ticker, note: i => i.catalyst || i.thesis, score: i => i.virality, tier: 'PRIMED' },
  ca: { section: 'CrossAsset', family: 'crossAsset', pick: i => i.classification === 'LEAD', tk: i => i.ticker, note: i => i.lead_asset, score: i => i.confidence, tier: 'LEAD' },
  ts: { section: 'ToneShift', family: 'fundamentalsRevisions', pick: i => i.shift === 'BRIGHTENING', tk: i => i.ticker, note: i => i.change, score: i => i.confidence, tier: 'BRIGHTENING' },
};
function fromAiScreeners(sources) {
  const out = [];
  for (const [key, cfg] of Object.entries(AI_MAP)) {
    const items = (sources && sources[key] && sources[key].items) || [];
    for (const i of items) {
      if (!cfg.pick(i)) continue;
      const tk = cfg.tk(i);
      if (!tk) continue;
      out.push({
        source: key === 'rt' ? 'readthrough' : key === 'an' ? 'anomaly' : key === 'sw' ? 'secondwave' : key === 'ca' ? 'crossasset' : 'toneshift',
        section: cfg.section, tier: cfg.tier,
        horizon: 'position', side: 'long',
        ticker: String(tk).toUpperCase(),
        rawConfidence: clampConf(cfg.score(i), 45),
        setup: 'ai-lead',
        evidenceFamilies: [cfg.family],
        catalyst: String(cfg.note(i) || '').slice(0, 160) || null,
        scoringVersion: `${cfg.section}-v1`,
      });
    }
  }
  return out;
}

// Leading / weakening sectors from /api/sectors (changePct). Returns the header view
// + a per-sector-name strength score in [-1,1] to stamp onto signals.
function sectorStrength(json) {
  const rows = ((json && json.sectors) || []).map(s => ({ name: s.name, changePct: +s.changePct }))
    .filter(s => Number.isFinite(s.changePct)).sort((a, b) => b.changePct - a.changePct);
  const byName = {};
  const n = rows.length;
  rows.forEach((s, i) => { byName[s.name] = n > 1 ? +(1 - (2 * i) / (n - 1)).toFixed(2) : 0; }); // top→+1, bottom→-1
  return { rows, byName, leading: rows.slice(0, 3), weakening: rows.slice(-3).reverse() };
}

module.exports = { fromScreener, fromGapGo, fromDayTrade, fromCoil, fromAiScreeners, sectorStrength, AI_MAP };
