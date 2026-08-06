'use strict';
// TECHNOLOGY LEADERSHIP & READ-THROUGH MAP — tech-command-readthrough-v1.
//
// Answers: is this move company-specific or group-wide, which peers confirm or
// contradict it, who has not reacted yet, and who reports next.
//
// EDGE PROVENANCE IS THE POINT. Two kinds of edge exist and they never blend:
//
//   DIRECT (verified)  — co-membership in a subsector, established by the
//     classification source itself (provider sector/industry, or the labeled
//     overlay). "These two are both classified Semiconductors by <source> as of
//     <date>" is a fact this app can stand behind.
//
//   INFERRED (research-only) — supply-chain / customer / competitor links that came
//     from the app's existing LLM read-through engine, or statistical lead-lag from
//     the peer-propagation graph. These are carried through with their mechanism,
//     their origin and confidence, are flagged researchOnly:true, and can never
//     originate or size a trade.
//
// This module invents nothing. An edge with no source is not emitted.
//
// Pure: inputs in, frozen map out.

const READTHROUGH_VERSION = 'tech-command-readthrough-v1';

const RELATIONSHIP_TYPES = Object.freeze([
  'subsector-peer', 'benchmark-constituent', 'supplier', 'customer',
  'competitor', 'tollbooth', 'substitute', 'partner', 'statistical-lead-lag',
]);
const DIRECT_TYPES = Object.freeze(new Set(['subsector-peer', 'benchmark-constituent']));

const num = v => (Number.isFinite(v) ? v : null);

/**
 * @param {{universe: object, moves: Object<string, object>, inferredEdges?: Array,
 *          groupMoves?: Object<string, number>, earningsByTicker?: Object<string, object>,
 *          now?: Date, maxPeers?: number}} input
 *   moves: { TICKER: { pctChange, rsVsQqq, rsVsSubsector, relVol, asOf } }
 *   inferredEdges: [{ from, to, type, mechanism, source, asOf, confidence, directness }]
 *   groupMoves: { subsectorId: medianPctChange }
 */
function buildReadThrough({ universe, moves = {}, inferredEdges = [], groupMoves = {}, earningsByTicker = {}, now = new Date(), maxPeers = 6 } = {}) {
  const nowIso = new Date(now).toISOString();
  const byTicker = (universe && universe.byTicker) || {};
  const bySubsector = (universe && universe.bySubsector) || {};

  // ── Group state ───────────────────────────────────────────────────────────
  const groups = Object.entries(bySubsector)
    .filter(([, tickers]) => (tickers || []).length)
    .map(([subsector, tickers]) => {
      const observed = tickers.map(t => moves[t]).filter(Boolean);
      const changes = observed.map(m => num(m.pctChange)).filter(v => v != null);
      const median = changes.length ? [...changes].sort((a, b) => a - b)[Math.floor(changes.length / 2)] : null;
      const upCount = changes.filter(v => v > 0).length;
      return {
        subsector,
        label: (byTicker[tickers[0]] && byTicker[tickers[0]].subsectorLabel) || subsector,
        members: tickers.length,
        observed: observed.length,
        medianPctChange: median == null ? null : +median.toFixed(2),
        breadthUpPct: changes.length ? Math.round((upCount / changes.length) * 100) : null,
        coverage: tickers.length ? Math.round((observed.length / tickers.length) * 100) : 0,
        externalMedian: num(groupMoves[subsector]),
      };
    })
    .sort((a, b) => (b.medianPctChange ?? -Infinity) - (a.medianPctChange ?? -Infinity));

  const groupByIdmap = Object.fromEntries(groups.map(g => [g.subsector, g]));

  // ── Inferred edges, kept apart and validated for provenance ───────────────
  const inferred = (inferredEdges || [])
    .filter(e => e && e.from && e.to && e.mechanism && e.source)
    .map(e => Object.freeze({
      from: String(e.from).toUpperCase(), to: String(e.to).toUpperCase(),
      type: RELATIONSHIP_TYPES.includes(e.type) ? e.type : 'partner',
      mechanism: String(e.mechanism).slice(0, 240),
      source: e.source, asOf: e.asOf || null,
      confidence: e.confidence || 'unknown',
      directness: num(e.directness),
      status: 'inferred',
      researchOnly: true,
      note: 'Inferred relationship — research only. It cannot originate, confirm or size a trade.',
    }));
  const inferredByTicker = {};
  for (const e of inferred) {
    (inferredByTicker[e.from] = inferredByTicker[e.from] || []).push(e);
    (inferredByTicker[e.to] = inferredByTicker[e.to] || []).push(e);
  }

  // ── Per-mover read-through ────────────────────────────────────────────────
  const movers = Object.entries(moves)
    .filter(([t]) => byTicker[t])
    .map(([ticker, m]) => {
      const u = byTicker[ticker];
      const g = groupByIdmap[u.subsector] || null;
      const peers = (bySubsector[u.subsector] || []).filter(p => p !== ticker);
      const peerRows = peers
        .map(p => ({ ticker: p, company: byTicker[p] ? byTicker[p].company : null, move: moves[p] || null }))
        .filter(r => r.move)
        .sort((a, b) => (num(b.move.pctChange) ?? -Infinity) - (num(a.move.pctChange) ?? -Infinity));

      const self = num(m.pctChange);
      const groupMedian = g ? g.medianPctChange : null;
      const idiosyncratic = (self != null && groupMedian != null) ? +(self - groupMedian).toFixed(2) : null;
      const scope = idiosyncratic == null ? 'unknown'
        : Math.abs(idiosyncratic) >= Math.abs(groupMedian ?? 0) && Math.abs(idiosyncratic) >= 1.5 ? 'company-specific'
          : Math.abs(groupMedian ?? 0) >= 1.0 ? 'group-wide' : 'mixed';

      const confirming = peerRows.filter(r => self != null && num(r.move.pctChange) != null && Math.sign(r.move.pctChange) === Math.sign(self)).slice(0, maxPeers);
      const contradicting = peerRows.filter(r => self != null && num(r.move.pctChange) != null && Math.sign(r.move.pctChange) === -Math.sign(self)).slice(0, maxPeers);
      const notYetReacted = peerRows.filter(r => Math.abs(num(r.move.pctChange) ?? 0) < 0.5).slice(0, maxPeers);

      const betaCheck = (num(m.rsVsQqq) != null && num(m.rsVsSubsector) != null)
        ? ((m.rsVsQqq <= 0 && m.rsVsSubsector <= 0)
          ? 'The move is QQQ/subsector beta — the name is not outperforming either benchmark.'
          : (m.rsVsSubsector > 0 ? 'The name is outperforming its own subsector — genuine relative leadership.' : 'The name beats QQQ but not its subsector — the group is doing the work.'))
        : 'Relative-strength inputs incomplete — cannot separate beta from leadership.';

      const nextReporter = [...peers, ticker]
        .map(p => ({ ticker: p, ...(earningsByTicker[p] || {}) }))
        .filter(x => x.earningsDate)
        .sort((a, b) => String(a.earningsDate).localeCompare(String(b.earningsDate)))[0] || null;

      return Object.freeze({
        ticker, company: u.company, subsector: u.subsector, subsectorLabel: u.subsectorLabel,
        pctChange: self, relVol: num(m.relVol),
        rsVsQqq: num(m.rsVsQqq), rsVsSubsector: num(m.rsVsSubsector),
        groupMedianPctChange: groupMedian,
        idiosyncraticPct: idiosyncratic,
        scope,
        scopeExplanation: scope === 'company-specific'
          ? 'Most of the move is not explained by the group — treat it as company news until proven otherwise.'
          : scope === 'group-wide'
            ? 'The whole group is moving — this is a sector event, not a single-name story.'
            : scope === 'mixed' ? 'Part group, part company-specific.' : 'Not enough peer coverage to attribute the move.',
        betaCheck,
        confirmingPeers: Object.freeze(confirming),
        contradictingPeers: Object.freeze(contradicting),
        notYetReacted: Object.freeze(notYetReacted),
        // DIRECT edges — verified by the classification source itself.
        directEdges: Object.freeze(peers.slice(0, maxPeers).map(p => ({
          from: ticker, to: p, type: 'subsector-peer',
          mechanism: `both classified ${u.subsectorLabel}`,
          source: u.classification.source, asOf: u.classification.asOf,
          confidence: u.classification.approximate ? 'approximate' : 'provider-verified',
          status: 'direct', researchOnly: false,
        }))),
        inferredEdges: Object.freeze((inferredByTicker[ticker] || []).slice(0, maxPeers)),
        nextGroupReporter: nextReporter,
        asOf: m.asOf || null,
      });
    })
    .sort((a, b) => Math.abs(b.pctChange ?? 0) - Math.abs(a.pctChange ?? 0));

  return Object.freeze({
    schema: READTHROUGH_VERSION,
    generatedAt: nowIso,
    groups: Object.freeze(groups),
    movers: Object.freeze(movers.slice(0, 25)),
    edgeCounts: Object.freeze({
      direct: movers.reduce((s, m) => s + m.directEdges.length, 0),
      inferred: inferred.length,
    }),
    relationshipPolicy: 'DIRECT edges come from the classification source (subsector co-membership) and are verifiable. INFERRED edges (supplier/customer/competitor/lead-lag) come from the app\'s existing research engines, are labeled research-only, and never affect any action.',
    empty: movers.length === 0,
    emptyReason: movers.length === 0 ? 'No technology price moves were observable this cycle.' : null,
  });
}

module.exports = { READTHROUGH_VERSION, RELATIONSHIP_TYPES, DIRECT_TYPES, buildReadThrough };
