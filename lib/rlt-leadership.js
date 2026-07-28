// ═══════════════════════════════════════════════════════════════════════════
// RLT within-sector leadership — cross-sectional peer ranking features.
//
// The MAIN early-discovery feature is CHANGE in relative leadership (rank
// velocity/acceleration), not an already-high rank. Positive absolute return,
// positive market residual, positive sector residual, peer rank and rank
// change are kept as SEPARATE features — never collapsed into one opaque
// number — so a stock whose rank rose only because every peer collapsed is
// distinguishable from one producing positive absolute AND residual returns.
//
// Pure module: no I/O. Cross-sectional by construction — call once per scan.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, HORIZONS, LEADERSHIP } = require('./rlt-config');
const R = require('./rlt-residual');

const HIST_SESSIONS = 15;          // percentile history depth
const PRIMARY_HORIZON = 10;        // horizon whose percentile drives velocity

function fin(v) { return Number.isFinite(v) ? v : null; }

/**
 * Build leadership features for every eligible universe row.
 *
 * @param universe   result of rlt-universe.buildPeerUniverse
 * @param spyBars    SPY candles (any accepted format)
 * @param sectorBarsFor (sectorName) → sector-ETF candles or [] — never throws
 * @returns { version, asOf, byTicker, historyByGroup }
 */
function buildLeadership({ universe, spyBars = [], sectorBarsFor = () => [] } = {}) {
  const asOf = universe.asOf;
  const rows = universe.rows.filter(r => r.eligible);

  // 1. Per-ticker residual bundle + daily residual series (PIT, as-of betas).
  const perTicker = new Map();
  for (const r of rows) {
    const sectorBars = r.sector ? (sectorBarsFor(r.sector) || []) : [];
    const bundle = R.residualBundle({ bars: r.bars, spyBars, sectorBars, asOf });
    const series = R.residualDailySeries({
      bars: r.bars, spyBars, sectorBars, asOf,
      beta: bundle.beta, sectorLoading: bundle.sectorLoading, sectorBetaMkt: bundle.sectorBetaMkt,
      window: 63 + HIST_SESSIONS + 12,
    });
    const rolling = R.rollingSums(series, 'residual', PRIMARY_HORIZON, HIST_SESSIONS);
    perTicker.set(r.ticker, { row: r, bundle, series, rolling });
  }

  // 2. Percentile HISTORY per peer group at the primary horizon.
  //    For each session date, rank each member's rolling h-residual within its group.
  const historyByGroup = {};
  const groupMembers = new Map();
  for (const r of rows) {
    if (!groupMembers.has(r.peerGroupId)) groupMembers.set(r.peerGroupId, []);
    groupMembers.get(r.peerGroupId).push(r.ticker);
  }
  const pctileHistory = new Map();   // ticker → [{date, pctile}]
  for (const [gid, members] of groupMembers) {
    const byDate = new Map();        // date → [{ticker, value}]
    for (const t of members) {
      for (const pt of perTicker.get(t).rolling) {
        if (!byDate.has(pt.date)) byDate.set(pt.date, []);
        byDate.get(pt.date).push({ ticker: t, value: pt.value });
      }
    }
    const dates = [...byDate.keys()].sort();
    historyByGroup[gid] = dates;
    for (const date of dates) {
      const entries = byDate.get(date);
      const values = entries.map(e => e.value);
      for (const e of entries) {
        const p = R.percentileWithTies(values, e.value);
        if (p == null) continue;
        if (!pctileHistory.has(e.ticker)) pctileHistory.set(e.ticker, []);
        pctileHistory.get(e.ticker).push({ date, pctile: p });
      }
    }
  }

  // 3. Today's cross-sectional percentiles per horizon (sector-aware residual,
  //    market-only residual and RAW return ranked separately).
  const todayValues = new Map();     // gid → h → {resid:[], mkt:[], raw:[]}
  for (const [, { row, bundle }] of perTicker) {
    if (!todayValues.has(row.peerGroupId)) todayValues.set(row.peerGroupId, {});
    const g = todayValues.get(row.peerGroupId);
    for (const h of HORIZONS) {
      const bh = bundle.byHorizon[h] || {};
      if (!g[h]) g[h] = { resid: [], mkt: [], raw: [] };
      g[h].resid.push(fin(bh.residual));
      g[h].raw.push(fin(bh.raw));
      const mkt = (fin(bh.raw) != null && fin(bh.spy) != null && Number.isFinite(bundle.beta))
        ? bh.raw - bundle.beta * bh.spy : null;
      g[h].mkt.push(mkt);
    }
  }

  // 4. Assemble per-ticker leadership features.
  const byTicker = {};
  for (const [ticker, { row, bundle }] of perTicker) {
    const g = todayValues.get(row.peerGroupId) || {};
    const perHorizon = {};
    for (const h of HORIZONS) {
      const bh = bundle.byHorizon[h] || {};
      const vals = g[h] || { resid: [], mkt: [], raw: [] };
      const resid = fin(bh.residual);
      const raw = fin(bh.raw);
      const mkt = (raw != null && fin(bh.spy) != null && Number.isFinite(bundle.beta))
        ? raw - bundle.beta * bh.spy : null;
      const pct = resid != null ? R.percentileWithTies(vals.resid, resid) : null;
      perHorizon[h] = {
        raw, marketResidual: mkt, sectorResidual: resid,
        residualPartial: bh.partial === true,
        pctile: pct,
        pctileUncertainty: R.percentileUncertainty(pct, row.peerGroupSize),
        marketPctile: mkt != null ? R.percentileWithTies(vals.mkt, mkt) : null,
        rawPctile: raw != null ? R.percentileWithTies(vals.raw, raw) : null,
      };
    }

    // Rank velocity / acceleration from the primary-horizon percentile history.
    const hist = (pctileHistory.get(ticker) || []).slice(-HIST_SESSIONS);
    const p = hist.map(x => x.pctile);
    const last = p.length ? p[p.length - 1] : null;
    const at = (back) => (p.length > back ? p[p.length - 1 - back] : null);
    const delta = (back) => (last != null && at(back) != null ? last - at(back) : null);
    const vel3 = delta(3), vel5 = delta(5), vel10 = delta(10);
    // Acceleration: velocity now minus velocity one step earlier (3-session basis).
    const prevVel3 = (at(1) != null && at(4) != null) ? at(1) - at(4) : null;
    const accel = (vel3 != null && prevVel3 != null) ? vel3 - prevVel3 : null;

    let aboveMedianStreak = 0;
    for (let i = p.length - 1; i >= 0; i--) {
      if (p[i] > LEADERSHIP.medianPct) aboveMedianStreak++;
      else break;
    }
    const aboveTopQuintile = p.filter(x => x >= LEADERSHIP.topQuintile).length;

    const agreeHorizons = [5, 10, 21];
    const positives = agreeHorizons.map(h => perHorizon[h] && perHorizon[h].sectorResidual)
      .filter(v => v != null);
    const crossHorizonAgreement = positives.length
      ? positives.filter(v => v > 0).length / positives.length : null;

    const ph = perHorizon[PRIMARY_HORIZON] || {};
    byTicker[ticker] = Object.freeze({
      ticker,
      peerGroupId: row.peerGroupId,
      groupingLevel: row.groupingLevel,
      groupingFallback: row.groupingFallback,
      peerGroupSize: row.peerGroupSize,
      beta: bundle.beta,
      sectorLoading: bundle.sectorLoading,
      betaObs: bundle.betaObs,
      betaShrunk: bundle.betaShrunk,
      betaBasis: R.BETA_BASIS,
      byHorizon: Object.freeze(perHorizon),
      // Kept-separate evidence axes (NEVER collapsed):
      positiveAbsolute: ph.raw != null ? ph.raw > 0 : null,
      positiveMarketResidual: ph.marketResidual != null ? ph.marketResidual > 0 : null,
      positiveSectorResidual: ph.sectorResidual != null ? ph.sectorResidual > 0 : null,
      pctile: ph.pctile ?? null,
      pctileUncertainty: ph.pctileUncertainty ?? null,
      // A high rank earned while the stock itself went nowhere = peers collapsed.
      leaderOnPeerWeaknessOnly:
        ph.pctile != null && ph.raw != null
          ? (ph.pctile >= LEADERSHIP.upperTercile && ph.raw <= 0) : null,
      rankVel3: vel3, rankVel5: vel5, rankVel10: vel10,
      rankAccel: accel,
      pctileHistory: Object.freeze(hist),
      aboveMedianStreak,
      aboveTopQuintileCount: aboveTopQuintile,
      crossHorizonAgreement,
      rawVsResidualGap: (ph.rawPctile != null && ph.pctile != null) ? ph.rawPctile - ph.pctile : null,
      marketVsSectorGap: (ph.marketPctile != null && ph.pctile != null) ? ph.marketPctile - ph.pctile : null,
    });
  }

  // Residual daily series exposed so downstream feature construction (path
  // quality, persistence) reuses the SAME betas instead of refitting.
  const seriesByTicker = {};
  for (const [ticker, { series }] of perTicker) seriesByTicker[ticker] = series;

  return Object.freeze({
    version: VERSIONS.features,
    asOf,
    primaryHorizon: PRIMARY_HORIZON,
    histSessions: HIST_SESSIONS,
    byTicker: Object.freeze(byTicker),
    historyByGroup: Object.freeze(historyByGroup),
    seriesByTicker: Object.freeze(seriesByTicker),
  });
}

module.exports = { buildLeadership, HIST_SESSIONS, PRIMARY_HORIZON };
