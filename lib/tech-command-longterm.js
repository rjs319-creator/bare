'use strict';
// LONG-TERM TECHNOLOGY INVESTMENT BOARD — tech-command-longterm-v1.
//
// A DISTINCT model, not a re-labelled swing score. Horizon ~6–36 months, different
// features (growth, growth acceleration, margin trajectory, valuation against
// growth, multi-quarter trend, QQQ- and subsector-relative leadership), a different
// action vocabulary, and a different failure mode (thesis breakage, not a stop).
//
// HONEST DATA CEILING. The providers this app is entitled to (Finnhub company
// metrics + daily candles) supply growth, margins, P/E and shares outstanding. They
// do NOT supply free-cash-flow quality, cash conversion, ROIC, net cash/debt,
// stock-based compensation, dilution history, customer/product concentration or
// capital intensity. Those factors are declared UNAVAILABLE by name and reduce the
// data-completeness grade; they are never estimated, proxied or quietly dropped.
//
// ANALYST REVISIONS are PIT_UNPROVEN. Until the estimates audit proves that
// revision values AND their publication timestamps are genuinely point-in-time,
// revisions carry weight ZERO, are labeled as current context, and cannot lift an
// action or contribute promotion evidence.
//
// Pure: inputs in, frozen board out.

const EV = require('./tech-command-evidence');

const LONGTERM_VIEW_VERSION = 'tech-command-longterm-v1';
const HOLD_MONTHS = Object.freeze({ min: 6, max: 36 });

const ACTIONS = Object.freeze([
  'ACCUMULATE', 'WATCH_VALUATION', 'HOLD', 'THESIS_WEAKENING', 'REDUCE', 'EXIT_THESIS_BROKEN', 'INSUFFICIENT_DATA',
]);
const ACTION_RANK = Object.freeze({
  ACCUMULATE: 0, WATCH_VALUATION: 1, HOLD: 2, THESIS_WEAKENING: 3, REDUCE: 4, EXIT_THESIS_BROKEN: 5, INSUFFICIENT_DATA: 6,
});

// Factors the model WANTS but cannot get from the configured providers. Named so
// the page can show exactly what a long-term reader is missing.
const UNAVAILABLE_FACTORS = Object.freeze([
  { factor: 'free-cash-flow quality', reason: 'no cash-flow-statement feed is configured' },
  { factor: 'cash conversion', reason: 'no cash-flow-statement feed is configured' },
  { factor: 'return on invested capital', reason: 'invested-capital components are not in the configured metrics feed' },
  { factor: 'net cash / debt', reason: 'balance-sheet detail is not in the configured metrics feed' },
  { factor: 'stock-based compensation', reason: 'not in the configured metrics feed' },
  { factor: 'share-count dilution history', reason: 'only a current share count is available; no history to difference' },
  { factor: 'customer / product concentration', reason: 'requires filing text extraction that is not run on this surface' },
  { factor: 'capital intensity', reason: 'capex is not in the configured metrics feed' },
]);

const MIN_COVERAGE_FOR_ACTION = 0.45;   // below this the verdict is INSUFFICIENT_DATA
const RICH_PEG = 3.0;                   // P/E ÷ EPS-growth above this = valuation tension
const CHEAP_PEG = 1.2;

const num = v => (Number.isFinite(v) ? v : null);
const clamp1 = v => Math.max(-1, Math.min(1, v));

/**
 * @param {{candidates: Array, universe: object, regime?: object, now?: Date, limit?: number}} input
 *   candidates: [{ ticker, fundamentals, trend, context, revisions }]
 *     fundamentals — lib/fundamentals fetchFundamentals shape (or null)
 *     trend        — lib/longterm longTermRead shape (or null)
 *     context      — { rsVsQqq126, rsVsSubsector126, subsectorRank, subsectorCount, asOf }
 *     revisions    — optional { period, strongBuy, buy, hold, sell, strongSell, prev }
 */
function buildLongTermBoard({ candidates, universe, regime = null, now = new Date(), limit = 5 } = {}) {
  const nowIso = new Date(now).toISOString();
  const byTicker = (universe && universe.byTicker) || {};
  const warnings = [];
  const list = (candidates || []).filter(c => c && c.ticker && byTicker[String(c.ticker).toUpperCase()]);
  if (!candidates || !candidates.length) warnings.push('No long-term candidate inputs were available this cycle.');

  const rows = list.map(c => buildRow(c, byTicker[String(c.ticker).toUpperCase()], regime, nowIso));
  rows.sort((a, b) => (ACTION_RANK[a.action] - ACTION_RANK[b.action])
    || ((b.score ?? -Infinity) - (a.score ?? -Infinity))
    || a.ticker.localeCompare(b.ticker));

  const featured = rows.filter(r => r.action === 'ACCUMULATE' || r.action === 'WATCH_VALUATION').slice(0, limit);
  const byAction = {};
  for (const a of ACTIONS) byAction[a] = rows.filter(r => r.action === a).map(r => r.ticker);

  return Object.freeze({
    schema: LONGTERM_VIEW_VERSION,
    generatedAt: nowIso,
    horizonMonths: HOLD_MONTHS,
    modelNote: 'A separate long-term model. Its inputs, actions and failure modes differ from the swing board; the two never share a score.',
    scoreLabel: 'long-term quality/expectations score (uncalibrated, relative)',
    probability: null,
    probabilityNote: 'This score is NOT a return probability. No out-of-sample calibration artifact exists for it.',
    revisionsStatus: 'PIT_UNPROVEN',
    revisionsNote: 'Analyst revisions are displayed as CURRENT context only. Weight zero: their point-in-time integrity (values AND publication timestamps) has not been proven by the estimates audit.',
    unavailableFactors: UNAVAILABLE_FACTORS,
    rows: Object.freeze(rows),
    featured: Object.freeze(featured),
    byAction: Object.freeze(byAction),
    counts: Object.freeze({ total: rows.length, ...Object.fromEntries(ACTIONS.map(a => [a, byAction[a].length])) }),
    empty: featured.length === 0,
    emptyReason: featured.length === 0
      ? 'No technology names currently offer an attractive enough expectations/risk balance to accumulate. Picks are never forced.'
      : null,
    warnings: Object.freeze(warnings),
  });
}

function buildRow(c, u, regime, nowIso) {
  const f = c.fundamentals || null;
  const t = c.trend || null;
  const ctx = c.context || null;
  const items = [];

  // ── Growth ────────────────────────────────────────────────────────────────
  if (f && f.revGrowth != null) {
    items.push(EV.makeEvidence({
      family: 'fundamental-quality', label: 'Revenue growth (TTM YoY)', value: f.revGrowth,
      strength: clamp1(f.revGrowth / 30), quality: 'medium', source: 'finnhub company metrics',
    }));
  }
  if (f && f.epsGrowth != null) {
    items.push(EV.makeEvidence({
      family: 'fundamental-quality', label: 'EPS growth (TTM YoY)', value: f.epsGrowth,
      strength: clamp1(f.epsGrowth / 40), quality: 'medium', source: 'finnhub company metrics',
    }));
  }
  if (f && f.revAccel != null) {
    items.push(EV.makeEvidence({
      family: 'fundamental-quality', label: 'Revenue growth acceleration', value: f.revAccel,
      strength: clamp1(f.revAccel / 15), quality: 'medium', source: 'finnhub quarterly series',
      direction: f.revAccel >= 0 ? 'supporting' : 'contradicting',
    }));
  }
  if (f && f.epsAccel != null) {
    items.push(EV.makeEvidence({
      family: 'fundamental-quality', label: 'EPS growth acceleration', value: f.epsAccel,
      strength: clamp1(f.epsAccel / 20), quality: 'medium', source: 'finnhub quarterly series',
      direction: f.epsAccel >= 0 ? 'supporting' : 'contradicting',
    }));
  }
  // ── Margin trajectory ─────────────────────────────────────────────────────
  if (f && f.marginExpanding != null) {
    items.push(EV.makeEvidence({
      family: 'fundamental-quality', label: 'Operating-margin trajectory',
      value: f.opMarginTTM, strength: f.marginExpanding ? 0.5 : -0.5, quality: 'medium',
      source: 'finnhub company metrics',
      detail: f.opMarginTTM != null && f.opMarginBase != null ? `${f.opMarginTTM}% vs ${f.opMarginBase}% baseline` : null,
      direction: f.marginExpanding ? 'supporting' : 'contradicting',
    }));
  }
  // ── Valuation vs growth ───────────────────────────────────────────────────
  const peg = (f && f.pe != null && f.epsGrowth != null && f.epsGrowth > 0) ? +(f.pe / f.epsGrowth).toFixed(2) : null;
  if (peg != null) {
    items.push(EV.makeEvidence({
      family: 'valuation-expectations', label: 'P/E relative to EPS growth', value: peg,
      strength: peg >= RICH_PEG ? -0.7 : peg <= CHEAP_PEG ? 0.6 : 0.1, quality: 'medium',
      source: 'finnhub company metrics',
      direction: peg >= RICH_PEG ? 'contradicting' : 'supporting',
      detail: `P/E ${f.pe} ÷ EPS growth ${f.epsGrowth}%`,
    }));
  } else if (f && f.pe != null) {
    items.push(EV.makeEvidence({
      family: 'valuation-expectations', label: 'P/E (no positive growth to compare against)',
      value: f.pe, strength: -0.2, quality: 'low', source: 'finnhub company metrics', direction: 'contradicting',
    }));
  }
  // ── Long-term trend + relative leadership ─────────────────────────────────
  if (t && t.composite != null && !t.insufficient) {
    items.push(EV.makeEvidence({
      family: 'price-trend', label: 'Long-term daily trend structure', value: t.score,
      strength: clamp1(t.composite), quality: 'high', source: 'lib/longterm longTermRead',
      detail: (t.reasons || []).slice(0, 3).join('; '),
    }));
  }
  if (ctx && ctx.rsVsQqq126 != null) {
    items.push(EV.makeEvidence({
      family: 'relative-strength', label: 'Relative strength vs QQQ (126 sessions)', value: ctx.rsVsQqq126,
      strength: clamp1(ctx.rsVsQqq126 / 20), quality: 'medium', source: 'daily candles', asOf: ctx.asOf,
    }));
  }
  if (ctx && ctx.rsVsSubsector126 != null) {
    items.push(EV.makeEvidence({
      family: 'relative-strength', label: `Relative strength vs ${u.subsectorLabel}`, value: ctx.rsVsSubsector126,
      strength: clamp1(ctx.rsVsSubsector126 / 20), quality: 'medium', source: 'daily candles', asOf: ctx.asOf,
    }));
  }
  // ── Analyst revisions — DISPLAY ONLY, weight zero by family policy ────────
  const revisions = c.revisions ? summarizeRevisions(c.revisions) : null;
  if (revisions) {
    items.push(EV.makeEvidence({
      family: 'analyst-revisions', label: 'Street recommendation trend (PIT_UNPROVEN)',
      value: revisions.netScore, strength: clamp1(revisions.netScore / 3), quality: 'low',
      source: 'finnhub recommendation trends', detail: revisions.summary,
    }));
  }
  if (regime && regime.states) {
    items.push(EV.makeEvidence({
      family: 'market-regime', label: 'Technology regime', strength: regime.states.leadership === 'leading' ? 0.3 : regime.states.leadership === 'lagging' ? -0.3 : 0,
      quality: 'low', source: 'tech-command-regime', asOf: regime.generatedAt, detail: regime.classification,
    }));
  }

  const composed = EV.composeEvidence(items, {
    expectedFamilies: ['fundamental-quality', 'valuation-expectations', 'price-trend', 'relative-strength'],
  });

  const coverage = composed.coveragePct / 100;
  const action = deriveAction({ composed, coverage, peg, trend: t, fundamentals: f });

  return Object.freeze({
    ticker: String(c.ticker).toUpperCase(),
    company: u.company || null,
    subsector: u.subsector,
    subsectorLabel: u.subsectorLabel,
    action,
    score: composed.score,
    scoreLabel: composed.scoreLabel,
    evidenceQuality: composed.evidenceQuality,
    dataCompletenessPct: composed.coveragePct,
    // ── The thesis, in words ─────────────────────────────────────────────────
    coreThesis: buildThesis(u, f, t, peg),
    marketExpects: peg == null
      ? 'Not derivable: no P/E and positive-growth pair is available for this name.'
      : peg >= RICH_PEG
        ? `A rich multiple relative to trailing growth (P/E ÷ growth = ${peg}) — the price already embeds continued high growth.`
        : peg <= CHEAP_PEG
          ? `A modest multiple relative to trailing growth (P/E ÷ growth = ${peg}) — expectations look subdued.`
          : `A multiple broadly in line with trailing growth (P/E ÷ growth = ${peg}).`,
    couldExceedExpectations: buildUpside(f, u),
    growthProfile: f ? { revGrowth: num(f.revGrowth), epsGrowth: num(f.epsGrowth), revAccel: num(f.revAccel), epsAccel: num(f.epsAccel) } : null,
    qualityProfile: f ? { netMargin: num(f.netMargin), operatingMargin: num(f.opMarginTTM), operatingMarginBaseline: num(f.opMarginBase), marginExpanding: f.marginExpanding ?? null } : null,
    valuation: { pe: f ? num(f.pe) : null, peToGrowth: peg, tension: peg != null && peg >= RICH_PEG },
    longTermTrend: t ? { trend: t.trend, score: num(t.score), reasons: (t.reasons || []).slice(0, 4), factors: t.factors || null } : null,
    techContext: ctx ? Object.freeze({ ...ctx }) : null,
    secularExposure: u.subsectorLabel,
    secularExposureBasis: u.classification ? u.classification.basis : null,
    // ── Proof points & risks ─────────────────────────────────────────────────
    nextProofPoints: buildProofPoints(f),
    thesisRisks: buildRisks(f, t, peg),
    bearCase: composed.contradicting.map(e => e.label),
    longTermInvalidation: buildInvalidation(u, t),
    // ── Revisions (display only) ─────────────────────────────────────────────
    revisions: revisions ? Object.freeze({ ...revisions, status: 'PIT_UNPROVEN', affectsRanking: false }) : null,
    // ── Provenance ───────────────────────────────────────────────────────────
    latestDataAsOf: (ctx && ctx.asOf) || null,
    earningsDate: f ? f.earningsDate || null : null,
    unavailableFactors: UNAVAILABLE_FACTORS,
    evidence: composed,
    supporting: composed.supporting,
    contradicting: composed.contradicting,
    probability: null,
    lastEvaluatedAt: nowIso,
  });
}

function deriveAction({ composed, coverage, peg, trend, fundamentals }) {
  if (coverage < MIN_COVERAGE_FOR_ACTION || composed.score == null) return 'INSUFFICIENT_DATA';
  const score = composed.score;
  const trendBearish = trend && trend.trend === 'bearish';
  const marginsContracting = fundamentals && fundamentals.marginExpanding === false;
  const growthNegative = fundamentals && ((fundamentals.revGrowth != null && fundamentals.revGrowth < 0)
    || (fundamentals.epsGrowth != null && fundamentals.epsGrowth < 0));

  if (trendBearish && growthNegative) return 'EXIT_THESIS_BROKEN';
  if (score <= -35) return 'REDUCE';
  if (score < 0 || (marginsContracting && trendBearish)) return 'THESIS_WEAKENING';
  if (score >= 30 && peg != null && peg >= RICH_PEG) return 'WATCH_VALUATION';
  if (score >= 30) return 'ACCUMULATE';
  return 'HOLD';
}

function summarizeRevisions(r) {
  const cur = (r.strongBuy || 0) * 2 + (r.buy || 0) - (r.sell || 0) - (r.strongSell || 0) * 2;
  const total = (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0);
  const p = r.prev || null;
  const prev = p ? (p.strongBuy || 0) * 2 + (p.buy || 0) - (p.sell || 0) - (p.strongSell || 0) * 2 : null;
  const netScore = total ? +(cur / total).toFixed(2) : null;
  const direction = prev == null ? 'unknown' : cur > prev ? 'upgrading' : cur < prev ? 'downgrading' : 'unchanged';
  return {
    period: r.period || null, analysts: total, netScore, direction,
    breakdown: { strongBuy: r.strongBuy || 0, buy: r.buy || 0, hold: r.hold || 0, sell: r.sell || 0, strongSell: r.strongSell || 0 },
    summary: `${total} analysts, net ${netScore == null ? 'n/a' : netScore}, ${direction} vs the prior period`,
  };
}

function buildThesis(u, f, t, peg) {
  const parts = [];
  parts.push(`${u.company || u.ticker} is classified ${u.subsectorLabel}`);
  if (f && f.revGrowth != null) parts.push(`growing revenue ${f.revGrowth}% year over year`);
  if (f && f.marginExpanding === true) parts.push('with operating margin above its own baseline');
  else if (f && f.marginExpanding === false) parts.push('with operating margin below its own baseline');
  if (t && t.trend) parts.push(`in a ${t.trend} multi-quarter price trend`);
  if (peg != null) parts.push(`at ${peg}× P/E-to-growth`);
  return parts.join(', ') + '.';
}

function buildUpside(f, u) {
  const out = [];
  if (f && f.revAccel != null && f.revAccel > 0) out.push('revenue growth is already re-accelerating — a further quarter of acceleration would break the deceleration narrative');
  if (f && f.marginExpanding === true) out.push('operating leverage is showing up in margins ahead of the growth print');
  if (['ai-infrastructure', 'ai-applications', 'semiconductors', 'datacenter-infrastructure'].includes(u.subsector)) {
    out.push('demand in this group is capacity-constrained rather than demand-constrained, so upside surprises tend to be supply-driven');
  }
  if (!out.length) out.push('No specific upside driver is identifiable from the data available on this surface.');
  return out;
}

function buildProofPoints(f) {
  const out = [];
  if (f && f.earningsDate) out.push({ what: 'Next earnings report', when: f.earningsDate, inDays: f.earningsInDays ?? null });
  out.push({ what: 'Next revenue-growth print vs the current TTM rate', when: f && f.earningsDate ? f.earningsDate : 'next quarterly report', inDays: f ? (f.earningsInDays ?? null) : null });
  out.push({ what: 'Next operating-margin print vs its multi-year baseline', when: f && f.earningsDate ? f.earningsDate : 'next quarterly report', inDays: f ? (f.earningsInDays ?? null) : null });
  return out;
}

function buildRisks(f, t, peg) {
  const out = [];
  if (peg != null && peg >= RICH_PEG) out.push('Multiple compression: the price embeds growth that must actually arrive.');
  if (f && f.epsAccel != null && f.epsAccel < 0) out.push('EPS growth is decelerating — the second derivative has already turned.');
  if (f && f.marginExpanding === false) out.push('Operating margin is below its own baseline — costs are outrunning revenue.');
  if (t && t.trend === 'bearish') out.push('The multi-quarter price trend is already bearish — the market is voting against the thesis.');
  if (!out.length) out.push('No dominant risk is visible in the data available on this surface — that is a coverage limit, not an all-clear.');
  return out;
}

function buildInvalidation(u, t) {
  return [
    'two consecutive quarters of decelerating revenue growth',
    'operating margin falling below its multi-year baseline and staying there',
    `sustained relative-strength loss versus ${u.benchmark || 'its subsector benchmark'} and QQQ`,
    t && t.factors && t.factors.sma200 ? `a durable break of the 200-day (${t.factors.sma200}) without reclaim` : 'a durable break of the long-term moving-average structure',
  ];
}

module.exports = {
  LONGTERM_VIEW_VERSION, HOLD_MONTHS, ACTIONS, ACTION_RANK, UNAVAILABLE_FACTORS,
  MIN_COVERAGE_FOR_ACTION, RICH_PEG, CHEAP_PEG,
  buildLongTermBoard, buildRow, deriveAction, summarizeRevisions,
};
