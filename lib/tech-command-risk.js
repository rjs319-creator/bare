'use strict';
// TECHNOLOGY RISK MAP — tech-command-risk-v1.
//
// Several apparently-different recommendations across three horizons can quietly
// be one concentrated AI/semiconductor bet. This section makes that visible.
//
// INFORMATIONAL ONLY. The app's governed portfolio sizing lives in
// lib/decision-portfolio and is fed exclusively by sizing-eligible signals. This
// module does not produce weights and does not authorize positions; when no
// governed weights are supplied it says so rather than inventing any.
//
// Pure: selected rows in, frozen map out.

const RISK_VERSION = 'tech-command-risk-v1';

// Subsectors that ride the same AI capex cycle. Named explicitly so the grouping
// is auditable rather than implied.
const AI_THEME_SUBSECTORS = Object.freeze(new Set([
  'ai-infrastructure', 'ai-applications', 'semiconductors', 'semiconductor-equipment',
  'memory', 'servers-networking', 'datacenter-infrastructure',
]));
const SEMI_SUBSECTORS = Object.freeze(new Set(['semiconductors', 'semiconductor-equipment', 'memory']));
const MEGA_CAP_USD = 200e9;

const CONCENTRATION_WARN_PCT = 50;
const EARNINGS_CLUSTER_DAYS = 10;

const pctOf = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

/**
 * @param {{selections: Array, universe: object, context?: Object<string, object>,
 *          governedWeights?: Object<string, number>|null, now?: Date}} input
 *   selections: [{ ticker, horizon, action, side }] — every name the page is
 *               currently surfacing with a non-avoid action, across all horizons.
 */
function buildRiskMap({ selections, universe, context = {}, governedWeights = null, now = new Date() } = {}) {
  const nowIso = new Date(now).toISOString();
  const byTicker = (universe && universe.byTicker) || {};
  const rows = (selections || []).filter(s => s && s.ticker && byTicker[String(s.ticker).toUpperCase()]);
  const uniqueTickers = [...new Set(rows.map(r => String(r.ticker).toUpperCase()))];
  const n = uniqueTickers.length;

  const subsectorCounts = {};
  let aiCount = 0, semiCount = 0, megaCount = 0;
  const earnings = [];
  const betas = [];
  const rateCorrs = [];
  const liquidity = [];
  for (const t of uniqueTickers) {
    const u = byTicker[t];
    const ctx = context[t] || {};
    subsectorCounts[u.subsector] = (subsectorCounts[u.subsector] || 0) + 1;
    if (AI_THEME_SUBSECTORS.has(u.subsector)) aiCount++;
    if (SEMI_SUBSECTORS.has(u.subsector)) semiCount++;
    if ((u.marketCap || 0) >= MEGA_CAP_USD) megaCount++;
    if (Number.isFinite(ctx.earningsInDays)) earnings.push({ ticker: t, inDays: ctx.earningsInDays, date: ctx.earningsDate || null });
    if (Number.isFinite(ctx.betaVsQqq)) betas.push(ctx.betaVsQqq);
    if (Number.isFinite(ctx.rateCorrelation)) rateCorrs.push(ctx.rateCorrelation);
    if (Number.isFinite(ctx.dollarVolume)) liquidity.push({ ticker: t, dollarVolume: ctx.dollarVolume });
  }

  const topSubsector = Object.entries(subsectorCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const earningsCluster = earnings.filter(e => e.inDays != null && e.inDays >= 0 && e.inDays <= EARNINGS_CLUSTER_DAYS);
  const longs = rows.filter(r => r.side !== 'short').length;
  const shorts = rows.filter(r => r.side === 'short').length;
  const avg = a => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null);

  const warnings = [];
  const aiPct = pctOf(aiCount, n);
  const semiPct = pctOf(semiCount, n);
  const megaPct = pctOf(megaCount, n);
  const topPct = topSubsector ? pctOf(topSubsector[1], n) : null;
  if (aiPct != null && aiPct >= CONCENTRATION_WARN_PCT) warnings.push(`${aiPct}% of the surfaced names ride the same AI capex cycle — these are not independent ideas.`);
  if (semiPct != null && semiPct >= CONCENTRATION_WARN_PCT) warnings.push(`${semiPct}% sit in semiconductors or semi equipment — one SOX drawdown hits all of them.`);
  if (megaPct != null && megaPct >= 70) warnings.push(`${megaPct}% are mega-caps — the book is effectively long QQQ.`);
  if (earningsCluster.length >= 3) warnings.push(`${earningsCluster.length} names report inside ${EARNINGS_CLUSTER_DAYS} sessions — event risk is clustered.`);
  if (n > 0 && shorts === 0 && longs === n) warnings.push('Every surfaced name is long — there is no offsetting exposure if technology sells off.');

  return Object.freeze({
    schema: RISK_VERSION,
    generatedAt: nowIso,
    informationalOnly: true,
    sizingNote: governedWeights
      ? 'Governed executable weights were supplied by the portfolio system and are shown as-is.'
      : 'No governed executable weights are available on this surface, so no position sizes are shown. This map describes overlap, not allocation.',
    names: n,
    byHorizon: Object.freeze({
      daytrade: rows.filter(r => r.horizon === 'daytrade').length,
      swing: rows.filter(r => r.horizon === 'swing').length,
      longterm: rows.filter(r => r.horizon === 'longterm').length,
    }),
    concentration: Object.freeze({
      bySubsector: Object.freeze(Object.entries(subsectorCounts)
        .map(([subsector, count]) => ({ subsector, label: (byTicker[uniqueTickers.find(t => byTicker[t].subsector === subsector)] || {}).subsectorLabel || subsector, count, pct: pctOf(count, n) }))
        .sort((a, b) => b.count - a.count)),
      topSubsectorPct: topPct,
      aiThemePct: aiPct,
      semiconductorPct: semiPct,
      megaCapPct: megaPct,
    }),
    exposure: Object.freeze({
      longs, shorts,
      averageBetaVsQqq: avg(betas),
      averageRateCorrelation: avg(rateCorrs),
      betaCoverage: `${betas.length}/${n} names had a computable beta`,
    }),
    earningsConcentration: Object.freeze({
      within: EARNINGS_CLUSTER_DAYS,
      names: Object.freeze(earningsCluster.sort((a, b) => a.inDays - b.inDays)),
      count: earningsCluster.length,
    }),
    liquidity: Object.freeze({
      thinnest: Object.freeze(liquidity.sort((a, b) => a.dollarVolume - b.dollarVolume).slice(0, 5)),
      coverage: `${liquidity.length}/${n} names had a measurable dollar volume`,
    }),
    portfolioWideInvalidation: Object.freeze([
      'SMH loses its own 50-day while QQQ holds — the semiconductor leg breaks first',
      'technology breadth (% above the 50-day) falls below the narrow threshold while the index holds up',
      'an AI-capex guidance cut from any hyperscaler, which reprices the whole cluster at once',
    ]),
    overlapWarnings: Object.freeze(warnings),
    empty: n === 0,
  });
}

module.exports = { RISK_VERSION, AI_THEME_SUBSECTORS, SEMI_SUBSECTORS, CONCENTRATION_WARN_PCT, EARNINGS_CLUSTER_DAYS, buildRiskMap };
