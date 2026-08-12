// SOURCE ADAPTERS — normalize each screener's native pick shape into the canonical
// Signal input consumed by lib/decision.js makeSignal(). Pure (JSON in → array out),
// so they're unit-testable and the op=today route stays a thin orchestrator.
//
// The `section`/`tier` on each signal are the SAME keys the Scoreboard groups by
// (section:tier → realized excess), so expectancyFor() resolves a live track record.
// `evidenceFamilies` is the honest independent-evidence view (#3) — e.g. a breakout
// name that is ALSO under quiet accumulation carries priceTrend + volumeAccum.

'use strict';

const { isTradeEligible } = require('./strategy-gate');

const clampConf = (v, def = 55) => {
  const n = +v;
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(100, n));
};

// Event awareness (#8) — classify an upcoming earnings date relative to the trade
// horizon: 'passed' (already reported), 'binary' (the print falls INSIDE the hold
// window → gap risk the user must know about), or 'scheduled' (beyond the window,
// informational). Calendar-day risk windows per horizon.
const EARN_WINDOW = { intraday: 3, swing: 21, position: 75, portfolio: 120 };
function classifyEarnings(inDays, when, horizon) {
  if (inDays == null || !Number.isFinite(+inDays)) return null;
  const d = +inDays;
  if (d < 0) return { type: 'earnings', inDays: d, when: when || null, kind: 'passed' };
  const win = EARN_WINDOW[horizon] ?? 21;
  return { type: 'earnings', inDays: d, when: when || null, kind: d <= win ? 'binary' : 'scheduled' };
}

// ── Breakout / Opportunities pool (from /api/screener) — swing ──────────────
// Carries breakout structure (priceTrend) AND, when present, the Ghost accumulation
// tier (volumeAccum) + fundamental acceleration (fundamentalsRevisions) on one name.
function fromScreener(json) {
  const results = (json && json.results) || [];
  const universeScope = (json && json.scope) || null;
  return results.filter(r => r && r.levels && r.status && r.levels.entry > 0).map(r => {
    // A screener row can carry evidence produced by OTHER engines (Ghost's accumulation
    // read, the insider feed). `sources` stays ['screener'] — that is which ADAPTER made
    // the signal — but `evidenceOrigins` records which ENGINE each family actually came
    // from, so the redundancy model can charge Ghost's confirmation against the screener
    // it re-ranks. Without this the two look like one source carrying two independent
    // families, which measurement proved false (overlap 0.80, return corr 0.96).
    const fams = ['priceTrend'];
    const origins = { priceTrend: 'screener' };
    const gt = r.ghost && r.ghost.tier;
    if (gt === 'GHOST' || gt === 'STALKING') { fams.push('volumeAccum'); origins.volumeAccum = 'ghost'; }
    const f = r.factors || {};
    if ((f.revAccel ?? 0) > 3 || (r.fundamentals && (r.fundamentals.revGrowth ?? 0) >= 25)) {
      fams.push('fundamentalsRevisions'); origins.fundamentalsRevisions = 'fundamentals';
    }
    if ((r.insider && (r.insider.net?.value ?? 0)) > 1e5) { fams.push('insider'); origins.insider = 'insider'; }
    const fd = r.fundamentals || {};
    return {
      source: 'screener', section: 'screener', tier: r.status,
      horizon: 'swing', side: 'long',
      ticker: r.ticker, company: r.company, sector: r.sector,
      price: r.price, entry: r.levels.entry, stop: r.levels.stop, target: r.levels.target, rr: r.levels.rr,
      rawConfidence: clampConf(r.quant?.score ?? r.ghost?.score, 60),
      setup: r.status,
      evidenceFamilies: fams,
      evidenceOrigins: origins,
      liquidity: { dollarVol: f.dollarVol, price: r.price },
      event: classifyEarnings(fd.earningsInDays, fd.earningsDate, 'swing'),
      catalyst: r.narrative || null,
      scoringVersion: 'screener-v2',
      universeScope,
      // DEDUP MARKER (defect #1): a production Setup/Breakout row that ALSO fired the
      // Emerging Leader detector is represented by THIS one signal. The emerging read
      // is carried as metadata (evidence origin note) — no extra family, no confidence
      // boost — so the standalone-Emerging research lane can exclude it (no double
      // count) while the evidence origin is still retained on the production signal.
      ...(r.emergingLeader ? { alsoEmergingLeader: true } : {}),
    };
  });
}

// ── Standalone Emerging Leader (from /api/screener results) — swing SHADOW ───
// Defect #1: api/screener.js admits `emergingLeader` names into the candidate
// buffer even when they carry NO classic base-pattern status — but fromScreener
// (correctly, for production) requires `r.status`, so every standalone Emerging
// Leader was silently discarded before the board, supervisor, ledger, research
// capture and OMEGA funnel. This adapter captures exactly those stranded rows
// with an explicit identity, routed to the Swing Research/Shadow lane.
//
// SHADOW CONTRACT (registry `emergingleader`, maturity shadow): standalone rows
// are research inventory — captured, retained, graded prospectively — and MUST
// NOT originate or boost an actionable production recommendation. Promotion is a
// registry maturity flip ONLY (strategy-gate); no UI flag or option can do it,
// which is why the gated live adapter (fromEmergingLeader) consults the registry
// and nothing else.
//
// Fail-closed mapping: rows with an invalid trade plan or unknown liquidity are
// reported in `dropped` with reason codes, never admitted with imputed fields.
// Rows that also carry a production status are excluded here — the screener
// signal already represents them (deduplication, no double-counting).
function mapEmergingLeaderRows(json, opts = {}) {
  const results = (json && json.results) || [];
  const universeScope = opts.universeScope || (json && json.scope) || null;
  const decisionCutoff = (json && (json.dataCutoff || (json.freshness && json.freshness.decisionSession))) || null;
  const rows = [];
  const dropped = [];
  for (const r of results) {
    if (!r || !r.emergingLeader) continue;
    if (r.status) { dropped.push({ ticker: r.ticker, reason: 'duplicate-production-signal' }); continue; }
    if (!r.ticker) continue;
    if (!(r.levels && r.levels.entry > 0 && r.levels.stop > 0)) { dropped.push({ ticker: r.ticker, reason: 'invalid-trade-plan' }); continue; }
    const dollarVol = r.factors && Number.isFinite(r.factors.dollarVol) ? r.factors.dollarVol : null;
    if (dollarVol == null) { dropped.push({ ticker: r.ticker, reason: 'missing-liquidity' }); continue; }
    const fd = r.fundamentals || {};
    rows.push({
      source: 'emergingleader', section: 'EmergingLeader', tier: 'EmergingLeader',
      horizon: 'swing', side: 'long',
      ticker: r.ticker, company: r.company, sector: r.sector,
      price: r.price,
      entry: r.levels.entry, stop: r.levels.stop, target: r.levels.target, rr: r.levels.rr,
      rawConfidence: clampConf(r.quant && r.quant.score, 55),
      setup: 'EmergingLeader',
      evidenceFamilies: ['priceTrend'],
      evidenceOrigins: { priceTrend: 'emergingleader' },
      liquidity: { dollarVol, price: r.price },
      event: classifyEarnings(fd.earningsInDays, fd.earningsDate, 'swing'),
      catalyst: null,
      scoringVersion: 'emergingleader-v1',
      universeScope,
      research: {
        standalone: true, shadow: true,
        universeScope, decisionCutoff,
        lastBarDate: r.lastBarDate || null,
        quant: r.quant || null,
        pct: r.pct || null,
        factors: r.factors ? { mom21: r.factors.mom21, mom63: r.factors.mom63, mom126: r.factors.mom126, dollarVol } : null,
        missing: [
          ...(r.fundamentals ? [] : ['fundamentals']),
          ...(r.insider ? [] : ['insider']),
          ...(decisionCutoff ? [] : ['decisionCutoff']),
        ],
      },
    });
  }
  return { rows, dropped };
}

// The gated live-board surface. While the registry keeps `emergingleader` at
// shadow this returns [] — standalone Emerging Leaders can neither create a
// Today's Pick nor raise conviction on one. Promotion (registry maturity →
// 'production') makes this return the mapped rows with no code change.
function fromEmergingLeader(json, opts = {}) {
  if (!isTradeEligible('emergingleader', opts.registry)) return [];
  return mapEmergingLeaderRows(json, opts).rows;
}

// ── Standalone Ghost quiet accumulation (from /api/screener ghostTop) — swing ─
// Phase 1 of the pre-move redesign (docs/premove-transition-v2.md): `ghostTop` is
// scored over the FULL scanned cross-section, but only names that also sat in the
// breakout `results` buffer ever reached the decision/learning paths — stranding
// every standalone quiet-accumulation candidate. This adapter consumes exactly
// those stranded rows: ghostTop names NOT already represented by `results`.
//
// SHADOW CONTRACT: these rows feed the shadow pre-move inventory and the Ghost
// full-candidate observation record ONLY. They are NOT added to the op=today
// board merge — standalone Ghost must not originate or boost a production pick
// merely because Ghost's registry entry is production; the standalone population
// has no validated track record of its own yet.
//
// Fail-closed: rows with unknown decision price or unknown dollar-volume are
// dropped (reported in `dropped`), never admitted with imputed liquidity. A row
// whose ticker is also in `results` is excluded — the screener adapter already
// carries Ghost's read as `evidenceOrigins.volumeAccum`, and a second signal
// would let Ghost confirm itself.
function mapGhostTopRows(json, { universeScope = null } = {}) {
  const ghostTop = (json && json.ghostTop) || [];
  const inResults = new Set(((json && json.results) || []).map(r => r && r.ticker).filter(Boolean));
  const rows = [];
  const dropped = [];
  for (const r of ghostTop) {
    if (!r || !r.ticker || !r.ghost) continue;
    const tier = r.ghost.tier;
    if (tier !== 'GHOST' && tier !== 'STALKING') continue;          // Watch/PASS = observation only, not a signal
    if (inResults.has(r.ticker)) continue;                          // already represented by Breakout — no self-confirmation
    const dollarVol = Number.isFinite(r.dollarVol) ? r.dollarVol
      : (r.factors && Number.isFinite(r.factors.dollarVol) ? r.factors.dollarVol : null);
    if (!Number.isFinite(r.price) || r.price <= 0) { dropped.push({ ticker: r.ticker, reason: 'missing-decision-price' }); continue; }
    if (dollarVol == null) { dropped.push({ ticker: r.ticker, reason: 'missing-liquidity' }); continue; }
    const lv = r.levels || null;
    const fd = r.fundamentals || {};
    rows.push({
      source: 'ghost', section: 'Ghost', tier,
      horizon: 'swing', side: 'long',
      ticker: r.ticker, company: r.company, sector: r.sector,
      price: r.price,
      entry: lv && lv.entry > 0 ? lv.entry : null,
      stop: lv && lv.stop > 0 ? lv.stop : null,
      target: lv && lv.target > 0 ? lv.target : null,
      rr: lv ? lv.rr : null,
      rawConfidence: clampConf(r.ghost.score, 55),
      setup: 'standalone quiet accumulation',
      evidenceFamilies: ['volumeAccum'],
      evidenceOrigins: { volumeAccum: 'ghost' },
      liquidity: { dollarVol, price: r.price },
      event: classifyEarnings(fd.earningsInDays, fd.earningsDate, 'swing'),
      catalyst: null,                                               // never inferred from a text label
      scoringVersion: 'ghost-v1',
      // Pre-move provenance: standalone rows are shadow inventory, not board input.
      premove: {
        standalone: true,
        shadow: true,
        universeScope: universeScope || (json && json.scope) || null,
        universeSize: (json && json.scannedCount) ?? null,
        dataCutoff: r.dataCutoff || null,
        ghost: { pillars: r.ghost.pillars || null, strongPillars: r.ghost.strongPillars || [], score: r.ghost.score },
        featureSnapshot: r.featureSnapshot || null,
        missing: [
          ...(lv ? [] : ['levels']),
          ...(r.fundamentals ? [] : ['fundamentals']),
          ...(r.insider ? [] : ['insider']),
        ],
      },
    });
  }
  return { rows, dropped };
}

// The gated adapter surface. Standalone Ghost is SHADOW: it returns rows for the
// pre-move inventory but op=today's board assembly must never pass them into the
// merge. (Mirrors the fromOptionsFlow pattern: pure mapping kept separate so a
// future validated promotion needs no rewrite.)
function fromGhostTop(json, opts = {}) {
  return mapGhostTopRows(json, opts).rows;
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
// DOWNSTREAM DECISION SAFETY. A Day Trade candidate may become a Today LONG only when it is a
// genuinely live, valid setup — never a stale prior-session row promoted on its within-pool
// percentile. So this requires the canonical actionability envelope: ACTIONABLE_NOW (or a
// confirmed REVERSAL_RECLAIM), current-session freshness, and a valid thesis + plan. Older
// payloads without the envelope fall back to requiring current-session freshness. `relScore`
// is a WITHIN-POOL PERCENTILE, not a probability — it is carried as `percentile`/`note`, and
// confidence is a modest fixed base so a high percentile can never masquerade as high conviction.
const DT_ACTIONABLE_STATES = new Set(['ACTIONABLE_NOW', 'REVERSAL_RECLAIM']);
function daytradeIsLive(d) {
  if (d.lifecycleState != null || d.actionable != null) {
    // Canonical envelope present — require it to be actionable and not invalidated.
    return (d.actionable === true || DT_ACTIONABLE_STATES.has(d.lifecycleState))
      && d.currentSessionFresh !== false && d.thesisValid !== false && d.planValid !== false;
  }
  // Legacy fallback: at minimum the name must be a current-session bar, never prior-session.
  return d.barIsToday === true || !!(d.freshness && d.freshness.freshnessStatus === 'FRESH_TODAY');
}
function fromDayTrade(json) {
  const items = (json && json.bestOpportunities) || [];
  return items.filter(d => d && d.entry > 0 && d.stop > 0 && daytradeIsLive(d)).map(d => ({
    source: 'daytrade', section: 'daytrade', tier: d.tier,
    horizon: 'intraday', side: 'long',
    ticker: d.ticker, sector: d.sector, price: d.currentPrice ?? d.last,
    entry: d.entry, stop: d.stop, target: d.target, rr: d.rr,
    // Confidence is NOT the relScore percentile — a within-pool ordering is not a probability.
    // Actionability is the qualifier (the gate above); conviction stays a modest base.
    rawConfidence: 55,
    percentile: Number.isFinite(+d.relScore) ? +d.relScore : null,
    note: Number.isFinite(+d.relScore) ? `Rel-strength percentile ${d.relScore}/100 within today's Day Trade pool (ordering, not probability)` : null,
    setup: d.source || 'intraday',
    lifecycleState: d.lifecycleState || null,
    evidenceFamilies: ['priceTrend'],
    // Measured dollar-volume when the canonical card carries it — unknown stays null and
    // the cost model charges the CONSERVATIVE tier (never the cheapest, defect #13).
    liquidity: { dollarVol: Number.isFinite(d.avgDollarVol) ? d.avgDollarVol : undefined, price: d.currentPrice ?? d.last },
    catalyst: d.catalyst && d.catalyst !== '?' ? d.catalyst : null,
    scoringVersion: 'daytrade-v2',
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

// ── Gap-Down continuation (op=gapdown) — intraday SHORTS ────────────────────
// The one short-side source: it makes the command center actionable in risk-off
// (where longs stand down and shorts are favored — the app's validated lever).
function fromGapDown(json) {
  const items = [...((json && json.strong) || []), ...((json && json.moderate) || [])];
  return items.filter(g => g && g.plan && g.plan.trigger > 0).map(g => ({
    source: 'gapdown', section: 'GapDown', tier: g.tier,
    horizon: 'intraday', side: 'short',
    ticker: g.ticker, sector: g.sector, price: g.last,
    entry: g.plan.trigger, stop: g.plan.stop, target: g.plan.target, rr: g.plan.rr,
    rawConfidence: clampConf(g.continuationScore, 50),
    setup: 'gap-down continuation',
    evidenceFamilies: ['priceTrend', 'catalystForcedFlow'],
    liquidity: { dollarVol: g.avgDollarVol, price: g.last },
    event: g.nextEarnings ? { type: 'earnings', when: g.nextEarnings, kind: 'binary' } : null,
    catalyst: 'gap-down',
    scoringVersion: 'gapdown-v1',
  }));
}

// ── Biotech Radar (op=biotech) — catalyst-driven runners, swing LEADS ───────
// FDA/data-driven; XBI-benchmarked. No published entry/stop/target → surfaces as a
// catalyst lead (lifecycle 'detected', execution neutral), ranks modestly.
function fromBiotech(json) {
  const items = (json && json.items) || [];
  return items.filter(b => b && (b.tier === 'Hot' || b.tier === 'Emerging') && b.ticker).map(b => ({
    source: 'biotech', section: 'Biotech', tier: b.tier,
    horizon: 'swing', side: 'long',
    ticker: b.ticker, sector: b.sector || 'Health Care', price: b.last,
    rawConfidence: clampConf(b.score, 55),
    setup: b.classification ? `biotech · ${b.classification}` : 'biotech',
    evidenceFamilies: ['catalystForcedFlow', ...((b.relVol ?? 0) >= 1.5 ? ['volumeAccum'] : [])],
    liquidity: { price: b.last },
    catalyst: b.catalyst_timing || b.classification || null,
    scoringVersion: 'biotech-v1',
  }));
}

// ── Core Momentum (op=core) — the PORTFOLIO-horizon sleeve ──────────────────
// A quarterly-rebalanced, equal-weighted 12-1 momentum book. These are multi-month
// factor holdings, so they populate the decision engine's `portfolio` horizon (which
// was otherwise empty). Confidence is the book's own cross-sectional RANK expressed as
// a universe percentile — an honest relative ordering, not a probability. No intraday
// entry/stop: the "invalidation" is the quarterly rebalance dropping the name.
function fromCoreMomentum(json, topN = 20) {
  const book = (json && json.book) || [];
  if (!book.length) return [];
  const n = book.length;
  return book.filter(x => x && x.ticker).slice(0, topN).map(x => {
    const rank = Number.isFinite(x.rank) ? x.rank : null;
    const pctile = rank ? Math.round((1 - (rank - 1) / n) * 100) : null; // #1 → ~100th
    return {
      source: 'coremo', section: 'CoreMomentum', tier: 'Core',
      horizon: 'portfolio', side: 'long',
      ticker: x.ticker, sector: x.sector || null, price: x.price ?? null,
      rawConfidence: clampConf(pctile, 60),
      setup: 'core momentum · quarterly hold',
      evidenceFamilies: ['priceTrend'],
      // BUG FIX (quant-redesign-3): marketCap was passed in the dollarVol slot, scoring
      // these names as ~1000x more liquid than they trade. Daily dollar-volume is not
      // exposed by op=core, so liquidity is honestly UNKNOWN here (execution stays
      // neutral; the eligibility layer treats unknown liquidity as not-sizable).
      liquidity: { price: x.price ?? null },
      catalyst: null,
      note: pctile != null ? `Top ${100 - pctile}% of the momentum universe (rank ${rank}/${n})` : null,
      percentile: pctile,
      scoringVersion: 'coremo-v1',
    };
  });
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

// ── Down-Day Mode (op=downday) — the mean-reversion source ──────────────────
// ADAPTER COVERAGE (#1): `downday` was in decision.js SOURCE_FAMILY but had no adapter,
// so the whole meanReversion family was declared and never actually emitted — the board
// carried breakouts and momentum and literally nothing that fires against them.
//
// Both sides are real signals: `bounces` are oversold LONGS, `fades` are overheated
// SHORTS. Levels come from the engine's own `signals` block, so these rows are fully
// cost-chargeable (unlike the lead-only sources).
function fromDownDay(json) {
  const j = json || {};
  // RED-TAPE CONDITION GATE (non-daytrade backlog 2026-08): Down-Day's own contract and
  // ledger are red-tape-conditional — the bounce edge is flat/negative off a red tape and
  // is never ledgered there. Rows carry the condition so eligibility can fail them closed
  // as actionable on non-red sessions (they stay fully visible as research controls).
  const tapeRed = !!(j.tape && j.tape.down === true);
  const rows = [...(Array.isArray(j.bounces) ? j.bounces : []), ...(Array.isArray(j.fades) ? j.fades : [])];
  return rows.filter(r => r && r.ticker && r.signals && !r.signals.expired
    && r.signals.entry > 0 && r.signals.stop > 0 && r.signals.target > 0).map((r) => {
    const s = r.signals;
    return {
      source: 'downday', section: 'DownDay', tier: r.tier || r.bucket || 'WATCH',
      conditionGate: { required: 'red-tape', met: tapeRed },
      // The engine's own horizon is a ~3-day hold — days, not the same session. Never
      // intraday: mixing horizons is the one thing the decision engine refuses to do.
      horizon: 'swing',
      side: s.side === 'short' || r.side === 'short' ? 'short' : 'long',
      ticker: r.ticker, sector: r.sector || null, price: r.price ?? null,
      entry: s.entry, stop: s.stop, target: s.target, rr: s.rr ?? null,
      rawConfidence: clampConf(r.score, 50),
      setup: r.bucket || null,
      note: r.label || null,
      evidenceFamilies: ['meanReversion'],
      liquidity: { dollarVol: r.dollarVol ?? undefined, price: r.price ?? null },
      scoringVersion: 'downday-v1',
    };
  });
}

// ── Unusual options flow (op=optionsflow) — the options-positioning source ───
// THE HIGHEST-VALUE ADAPTER, because of what it is NOT: every other source on the board
// reads the price series (priceTrend) or its volume (volumeAccum). The measured
// redundancy model showed exactly why that matters — ghost x screener correlate 0.96,
// so stacking more price-derived screeners buys almost no independent evidence. Options
// positioning is the first family here that is not derived from the tape at all, so when
// it merges onto a screener row it contributes a genuinely independent confirmation.
//
// It emits NO levels on purpose: positioning is EVIDENCE, not a trade plan. That flows
// through correctly — decision-costs reports `known:false` and charges no cost penalty
// rather than inventing a target to charge against.
const OF_MIN_CONVICTION = 10; // |score| below this is noise, not a read
function fromOptionsFlow(json) {
  // SAFETY GATE (centrally enforced): options flow is a SHADOW confirmation overlay.
  // Free delayed Yahoo chains cannot establish whether a trade was opening/closing/
  // bought/sold/hedged, so mechanical call=bullish / put=bearish positioning must NOT
  // originate or boost a LIVE trade until it earns promotion (strategy-gate). While it
  // is shadow, this normalizer emits nothing into the live board — the flow is still
  // scanned, graded and shown in its own section, but it can neither create a Today's
  // Pick nor raise conviction on one. Re-enabling is a single data change: flip
  // `optionsflow` maturity to 'production' in the registry once the gate is met — no
  // code or UI wording change can do it. This preserves the (already-tested) mapping
  // logic below so promotion needs no rewrite.
  if (!isTradeEligible('optionsflow')) return [];
  return mapOptionsFlowRows(json);
}

// Pure mapping from an options-flow payload to canonical Signal inputs — retained and
// unit-tested so promotion (flipping maturity → production) needs no rewrite. This is
// NOT wired into the live board directly; only fromOptionsFlow (gated) is. Kept
// separate so the safety gate is the single point between this logic and live trades.
function mapOptionsFlowRows(json) {
  const rows = (json && Array.isArray(json.byTicker)) ? json.byTicker : [];
  return rows.filter(r => r && r.ticker && !r.isIndex   // SPY/QQQ/GLD are the tape, not picks
    && Number.isFinite(r.score) && Math.abs(r.score) >= OF_MIN_CONVICTION
    && (r.net === 'bullish' || r.net === 'bearish')).map(r => ({
    source: 'optionsflow', section: 'OptionsFlow', tier: r.grade || 'flow',
    horizon: 'swing', side: r.net === 'bearish' ? 'short' : 'long',
    ticker: r.ticker, price: r.underlying ?? null,
    // Conviction is the MAGNITUDE of the read; direction is carried by `side`. Scaled
    // off |score| (the engine's own -100..100), floored well below the screener sources
    // because positioning is a lean, not a setup.
    rawConfidence: clampConf(35 + Math.abs(r.score) * 0.35, 45),
    setup: r.net,
    note: r.grade ? `${r.grade} options positioning` : null,
    evidenceFamilies: ['optionsPositioning'],
    liquidity: { price: r.underlying ?? null },
    scoringVersion: 'optionsflow-v1',
  }));
}

module.exports = { fromScreener, fromGhostTop, mapGhostTopRows, fromGapGo, fromDayTrade, fromCoil, fromGapDown, fromBiotech, fromCoreMomentum, fromAiScreeners, fromDownDay, fromOptionsFlow, mapOptionsFlowRows, mapEmergingLeaderRows, fromEmergingLeader, sectorStrength, classifyEarnings, AI_MAP };
