'use strict';
// UNIFIED DECISION ENGINE routes (op=today) — folded into api/tracker.js (no new
// Serverless Function). Server-authoritative: ranks every screener's picks into ONE
// canonical, validated, horizon-bucketed table via lib/decision.js, so the client
// only renders (no client/server scoring skew). Self-fetches the already-cached
// source endpoints (the warm cron keeps them fresh), then CDN-caches its own result.
//
//   op=today          : the ranked command-center payload
//   op=today&log=1     : also persist today's snapshot (warm-cron) so tomorrow can
//                        compute the new/upgraded/downgraded/failed/expired lanes

const { internalHeaders } = require('./auth');
const { hasStore, readJSON, writeJSON } = require('./store');
const { nowET, isMarketHoliday } = require('./stats');
const LB = require('./research/live-bridge');
const RS = require('./research/store');
const D = require('./decision');
const N = require('./decision-normalizers');
const PF = require('./decision-portfolio');
const { enrichFreshness, DATA_TRUST_LEGEND } = require('./provenance');
const SCHEMA_VERSION = D.SCHEMA_VERSION;

const RO = require('./remaining-edge-origins');
const OD = require('./opportunity-density');
const FM = require('./failure-model');
const EL = require('./eligibility');
const DG = require('./data-gates');

// Which pulled payload feeds each normalized signal source — the join the pre-ranking data
// gate needs (a signal's `source` is a strategy id; the freshness evidence lives on the
// payload it was normalized from). AI leads share their own per-key payloads.
const SOURCE_PAYLOAD_KEY = Object.freeze({
  screener: 'screener', emergingleader: 'screener', ghost: 'screener',
  gapgo: 'gapgo', daytrade: 'daytrade', coil: 'coil', gapdown: 'gapdown',
  biotech: 'biotech', coremo: 'coremo', downday: 'downday', optionsflow: 'optionsflow',
  readthrough: 'rt', anomaly: 'an', secondwave: 'sw', crossasset: 'ca', toneshift: 'ts',
});

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SNAP_PATH = 'today/latest.json';
const ORIGINS_PATH = 'today/origins.json';
const OPP_LOG_PATH = 'today/opportunity-log.json';
const PARITY_PREFIX = 'today/parity/';   // write-once per day: the served-board hash
const OPP_LOG_MAX = 180; // ~6 months of daily decisions for the no-trade-vs-high-opp evaluation

// One self-fetch of a cached endpoint. Never throws — a dead source contributes
// nothing + a freshness warning (error ≠ empty, per the app's honesty premise).
async function pull(path) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { path, ok: false, status: r.status, ms: Date.now() - t0, data: null };
    return { path, ok: true, status: 200, ms: Date.now() - t0, data: await r.json() };
  } catch (e) {
    return { path, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0, data: null };
  }
}

// ── Pure payload assembly (testable without network) ────────────────────────
// sources: { screener, screenerSmall, gapgo, daytrade, coil, scoreboard, sectors, ai:{rt,an,sw,ca,ts} }
// prev: the previous snapshot ({ids:[{id,state,rank,score}]}) or null.
// `redundancy` (optional) = the measured model from lib/redundancy.js. Null → rankSignals
// keeps the static family prior, so op=today is unchanged until the ledgers earn a change.
// `origins` (optional) = the immutable remaining-edge origin map (today/origins.json). Null →
// rankSignals forces remainingMult 1, so the board is unchanged until origins are persisted.
function buildToday(sources = {}, prev = null, redundancy = null, origins = null, opts = {}) {
  const s = sources;
  const regime = (s.screener && s.screener.regime) || {};
  const sec = N.sectorStrength(s.sectors || {});
  // Central fail-closed eligibility (quant-redesign-3). Mode 'annotate' (default) keeps
  // the board byte-identical and only REPORTS what enforcement would change; 'enforce'
  // excludes non-trade-eligible sources BEFORE the merge (so shadow evidence can neither
  // originate a row nor boost a production row); 'off' is the legacy escape hatch.
  const mode = EL.resolveMode(opts.eligibilityMode ?? process.env.DECISION_ELIGIBILITY_MODE);

  // 1) Normalize every source → raw canonical inputs, stamped with sector strength.
  const raw = [
    ...N.fromScreener(s.screener || {}),
    ...N.fromScreener(s.screenerSmall || {}),
    // Standalone Emerging Leaders (defect #1): registry-gated. While `emergingleader`
    // is shadow this contributes NOTHING to the board; a registry promotion (and only
    // that) makes these rows join the live merge. The shadow research capture happens
    // below in `swingResearch` regardless.
    ...N.fromEmergingLeader(s.screener || {}),
    ...N.fromEmergingLeader(s.screenerSmall || {}),
    ...N.fromGapGo(s.gapgo || {}),
    ...N.fromDayTrade(s.daytrade || {}),
    ...N.fromCoil(s.coil || {}),
    ...N.fromGapDown(s.gapdown || {}),
    ...N.fromBiotech(s.biotech || {}),
    ...N.fromCoreMomentum(s.coremo || {}),
    ...N.fromDownDay(s.downday || {}),
    ...N.fromOptionsFlow(s.optionsflow || {}),
    ...N.fromAiScreeners(s.ai || {}),
  ].map(sig => ({ ...sig, sectorStrength: sig.sector != null ? (sec.byName[sig.sector] ?? null) : null }));

  // PRE-RANKING DATA GATES (Phase 8). Freshness/coverage is resolved BEFORE the merge and
  // the rank, so a stale or partial source cannot originate a fresh entry recommendation.
  // Day Trade is excluded from the gate for the same reason it is pinned in eligibility:
  // its behavior is frozen by user directive and it runs its own actionability envelope.
  const nowMs = opts.nowMs ?? Date.now();
  const gateInputs = {
    screener: s.screener, gapgo: s.gapgo, coil: s.coil, gapdown: s.gapdown,
    biotech: s.biotech, coremo: s.coremo, downday: s.downday, optionsflow: s.optionsflow,
    sectors: s.sectors, scoreboard: s.scoreboard,
    ...Object.fromEntries(['rt', 'an', 'sw', 'ca', 'ts'].map(k => [k, (s.ai || {})[k]])),
  };
  const gateSpecs = {
    ...DG.specsFromContracts(['screener', 'gapgo', 'coil', 'gapdown', 'biotech', 'coremo', 'downday', 'optionsflow']),
    rt: { horizon: 'position' }, an: { horizon: 'position' }, sw: { horizon: 'position' },
    ca: { horizon: 'position' }, ts: { horizon: 'position' },
  };
  const dataGate = opts.dataGate === null ? null
    : (opts.dataGate || DG.evaluateDataGates(gateInputs, { specs: gateSpecs, nowMs }));
  // Per-SIGNAL-SOURCE view of the same verdicts (strategy id → its payload's gate).
  const dataGatesBySource = dataGate ? Object.fromEntries(
    Object.entries(SOURCE_PAYLOAD_KEY)
      .filter(([src]) => src !== 'daytrade')
      .map(([src, key]) => [src, dataGate.perSource[key] || null])
      .filter(([, g]) => g)) : null;

  const gate = mode === 'off' ? null : EL.gateSignals(raw, {
    mode, governance: opts.governance || null, borrowFeed: opts.borrowFeed || null,
    dataGates: dataGatesBySource, nowMs,
  });
  const boardRaw = (gate && mode === 'enforce') ? gate.tradeable : raw;

  // 1b) SCORE COMPARABILITY (redesign Phase 9). Every source's raw 0–100 number is
  // converted to a within-source percentile of its OWN same-day cross-section (or shrunk
  // toward neutral when the cross-section is too thin for a percentile to mean anything)
  // BEFORE the merge and the rank — an LLM's confidence, a technical composite and a quant
  // rank are not the same quantity and were previously compared as if they were. Day Trade
  // is pinned and passes through untouched.
  const SN = require('./score-normalize');
  const normalized = SN.normalizeSignals(raw);
  // Reference map (normalizeSignals preserves order and returns new objects), so the gated
  // subsets below merge the SAME normalized rows rather than re-deriving them.
  const normByRef = new Map(raw.map((s, i) => [s, normalized[i]]));
  const withNorm = (list) => (list || []).map(s => normByRef.get(s) || s);

  // 2) Merge same (ticker,horizon) across sources (independent-evidence #3), validate.
  // `mergedAll` is ALWAYS the full ungated cross-section: the research contract must
  // observe selected AND rejected candidates, and the lanes must still report failures
  // of names enforcement excluded — gating the record would be selection bias.
  const keepNorm = () => (m) => { const { signal } = D.makeSignal(m); return m.normalized ? { ...signal, normalized: m.normalized, mergedConviction: m.mergedConviction || null } : signal; };
  const mergedAll = D.mergeSignals(normalized).map(keepNorm());
  const merged = boardRaw === raw ? mergedAll : D.mergeSignals(withNorm(boardRaw)).map(keepNorm());

  // 3) Rank against live regime + Scoreboard expectancy.
  const scoreboard = s.scoreboard || {};
  const rankedActive = D.rankSignals(merged, { regime, scoreboard, redundancy, origins });
  const all = D.rankSignals(mergedAll, { regime, scoreboard, includeInactive: true, redundancy, origins });
  // Adversarial failure model (#5) — a SHADOW read attached to each name (failure probability,
  // expected mode, drivers, size multiplier). It does NOT touch the rank: the model only binds
  // once its validation (op=failuremodel) proves the rejected names underperform. Attached after
  // ranking so the horizon/top/portfolio views inherit it.
  // Attach the eligibility verdict + THREE-CLASS label to a ranked row. The class is taken
  // verbatim from lib/eligibility (ACTIONABLE / QUALIFIED_LEAD / RESEARCH) — collapsing
  // QUALIFIED_LEAD into either neighbour is exactly the mislabel the taxonomy exists to
  // prevent (a cleared strategy with no executable plan is not an actionable trade, and it
  // is not unproven research either).
  const classify = (sig) => {
    const eligibility = gate
      ? EL.assessSignal(sig, gate.perSource[sig.source] || EL.assessSource(sig.source, {}), {
        borrowFeed: opts.borrowFeed || null,
        dataGate: dataGatesBySource ? (dataGatesBySource[sig.source] || null) : null,
      })
      : null;
    return {
      ...sig,
      ...(eligibility ? { eligibility } : {}),
      evidenceClass: eligibility ? eligibility.signalClass : null,
      signalClass: eligibility ? eligibility.signalClass : null,
      sizingEligible: eligibility ? eligibility.sizingEligible === true : null,
      sizingWeight: eligibility ? eligibility.sizingWeight : null,
      // What a user already holding this name should be told when it cannot be a fresh
      // entry (MONITOR / HOLD / INVALIDATED / DATA_STALE) — never a silent disappearance.
      retainedLabel: DG.retainedLabelFor(sig, dataGatesBySource ? dataGatesBySource[sig.source] : null),
    };
  };
  const active = rankedActive.map(sig => ({ ...classify(sig), failure: FM.assessSignal(sig, { regime }) }));

  // 4) Bucket by horizon (#2 — never mixed).
  const horizons = {};
  for (const h of D.HORIZONS) horizons[h] = active.filter(x => x.horizon === h);

  // 5) Lanes — diff against the previous snapshot (empty on day 1 → all "new").
  const prevMap = new Map(((prev && prev.ids) || []).map(x => [x.id, x]));
  const lanes = { new: [], upgraded: [], downgraded: [], failed: [], expired: [], resolved: [] };
  for (const sig of active) {
    const p = prevMap.get(sig.id);
    if (!p) { lanes.new.push(sig); continue; }
    if (sig.score >= p.score + 8) lanes.upgraded.push(sig);
    else if (sig.score <= p.score - 8) lanes.downgraded.push(sig);
  }
  const activeIds = new Set(active.map(x => x.id));
  for (const sig of all) {
    if (!prevMap.has(sig.id)) continue;                 // only report on names we were tracking
    if (sig.state === 'failed') lanes.failed.push(sig);
    else if (sig.state === 'expired' && !activeIds.has(sig.id)) lanes.expired.push(sig);
    else if (sig.state === 'resolved') lanes.resolved.push(sig);
  }

  // 6) Upcoming risk events attached to signals (#8) — binary risk (print inside the
  // hold window) first, then passed/scheduled. Deduped by ticker.
  const EK = { binary: 0, passed: 1, scheduled: 2 };
  const seenEv = new Set();
  const events = active.filter(x => x.event && (x.event.kind === 'binary' || x.event.kind === 'passed'))
    .map(x => ({ ticker: x.ticker, horizon: x.horizon, ...x.event }))
    .sort((a, b) => (EK[a.kind] ?? 3) - (EK[b.kind] ?? 3) || (a.inDays ?? 999) - (b.inDays ?? 999))
    .filter(e => (seenEv.has(e.ticker) ? false : (seenEv.add(e.ticker), true)));

  // PER-HORIZON SHORTLISTS — never one global list. A same-session exit and a quarterly
  // rebalance are answers to different questions; ranking them on one scalar was the
  // confirmed defect. Each horizon is ranked within its own outcome contract; there is NO
  // cross-horizon "best overall" score (and none is allowed until every signal converts to
  // a calibrated common capital-at-risk expected-utility measure).
  const topByHorizon = Object.fromEntries(D.HORIZONS.map(h => [h, horizons[h].slice(0, 5)]));

  // 7) Portfolio-aware selection (#8). `topByHorizon` stays the pure per-signal rank — the
  // two answer different questions ("what scored best in its horizon?" vs "what would I
  // actually hold?") and the difference between them IS the product. Nothing here re-orders
  // on merit; it only removes for set-level reasons and says exactly why.
  //
  // SIZING SET (redesign Phase 2): the book is built EXCLUSIVELY from ACTIONABLE,
  // sizing-eligible rows — in EVERY mode, including the annotate diagnostic. A research or
  // qualified-lead row can never originate a position, and because the set is filtered
  // before construction it cannot occupy a slot, shift a cap, or change another name's
  // portfolio rank either. When eligibility is 'off' there is no verdict to filter on, so
  // the legacy behavior (rank the whole active board) is preserved as the escape hatch.
  const sizingSet = gate ? active.filter(x => x.eligibility && x.eligibility.sizingEligible) : active;
  const portfolio = {
    ...PF.buildPortfolio(sizingSet, { size: 10 }),
    // Auditable proof of what the book was allowed to see.
    universe: gate ? {
      basis: 'ACTIONABLE + sizing-eligible only',
      considered: sizingSet.length,
      activeBoard: active.length,
      excludedByClass: {
        QUALIFIED_LEAD: active.filter(x => x.evidenceClass === 'QUALIFIED_LEAD').length,
        RESEARCH: active.filter(x => x.evidenceClass === 'RESEARCH').length,
      },
    } : { basis: 'eligibility off (legacy escape hatch) — the whole active board', considered: active.length },
  };

  // ── SWING RESEARCH / SHADOW LANE (defects #1 + #4) ─────────────────────────
  // Observes the swing candidates production does NOT act on, without letting any
  // of them originate or boost a production rank:
  //   • standalone Emerging Leaders (null-status; defect #1) from every scope;
  //   • micro/expanded screener rows (defect #4): the scopes are scanned and
  //     Scoreboard-logged but were never observed by the board. The screener
  //     STRATEGY is production, but these SCOPE combinations have no promoted
  //     record — so they are research observations, not candidates.
  // One deduplicated inventory across scopes: most-authoritative scope wins
  // (large > small > micro > expanded — curated lists outrank the auto-built
  // universe), duplicates and board-overlaps are RETAINED with reason codes.
  const swingResearch = (() => {
    const SCOPE_AUTHORITY = { large: 0, small: 1, biotech: 2, micro: 3, expanded: 4 };
    const activeKey = new Set(active.map(x => `${x.ticker}|${x.horizon}|${x.side}`));
    const inventory = new Map();   // key → row (most authoritative kept)
    const retained = [];           // observations kept out of the inventory, with reasons
    const droppedAll = [];
    const observe = (row, lane) => {
      const r = { ...row, researchLane: lane, shadow: true };
      const key = `${r.ticker}|${r.horizon}|${r.side || 'long'}`;
      if (activeKey.has(key)) { retained.push({ ...r, retainedReason: 'duplicate-production-board' }); return; }
      const cur = inventory.get(key);
      if (!cur) { inventory.set(key, r); return; }
      const better = (SCOPE_AUTHORITY[r.universeScope] ?? 9) < (SCOPE_AUTHORITY[cur.universeScope] ?? 9);
      const kept = better ? r : cur;
      const dup = better ? cur : r;
      kept.alsoInScopes = [...new Set([...(kept.alsoInScopes || []), dup.universeScope].filter(Boolean))];
      inventory.set(key, kept);
      retained.push({ ...dup, retainedReason: 'duplicate-lower-authority-scope' });
    };
    for (const [src, scope] of [[s.screener, 'large'], [s.screenerSmall, 'small'], [s.screenerMicro, 'micro'], [s.screenerExpanded, 'expanded']]) {
      if (!src) continue;
      const { rows, dropped } = N.mapEmergingLeaderRows(src, { universeScope: scope });
      rows.forEach(r => observe(r, 'emergingLeader'));
      dropped.forEach(d => droppedAll.push({ ...d, universeScope: scope, lane: 'emergingLeader' }));
    }
    // Micro/expanded production-pattern rows: observed as research (scope unapproved).
    for (const [src, scope] of [[s.screenerMicro, 'micro'], [s.screenerExpanded, 'expanded']]) {
      if (!src) continue;
      N.fromScreener(src).forEach(r => observe({ ...r, universeScope: r.universeScope || scope }, 'scopeObservation'));
    }
    const coverage = {
      scopes: {
        large: !!s.screener, small: !!s.screenerSmall,
        micro: !!s.screenerMicro, expanded: !!s.screenerExpanded,
      },
      missingScopeCache: ['micro', 'expanded'].filter(k => !s[k === 'micro' ? 'screenerMicro' : 'screenerExpanded']),
      freshness: Object.fromEntries([['large', s.screener], ['small', s.screenerSmall], ['micro', s.screenerMicro], ['expanded', s.screenerExpanded]]
        .filter(([, src]) => src && src.freshness)
        .map(([k, src]) => [k, { decisionSession: src.freshness.decisionSession, counts: src.freshness.counts }])),
    };
    return {
      version: 'swing-research-v1',
      shadow: true,
      inventory: [...inventory.values()],
      retained,
      dropped: droppedAll,
      coverage,
      note: 'Research/shadow observations only — none of these rows entered the production merge or altered any production rank. '
        + 'Standalone Emerging Leaders and unapproved scope/strategy combinations accrue prospective evidence here; '
        + 'promotion is a strategy-registry maturity flip gated by PROMOTION_GATE, never a UI change.',
    };
  })();
  // Daily no-trade / opportunity-density decision (#6): is the set strong enough to trade at
  // all? Built from the active board's own quality — regime AND the same-day tape are penalties
  // only, never boosters (so a bull breadth-regime can't print "Normal/100%" on a red/choppy day).
  // OPPORTUNITY DENSITY reads the SIZING set, not the display board (Phase 2 item 3): the
  // question it answers is "is there enough here to trade today?", and a research lead the
  // app may not act on cannot make the answer yes. Under 'off' this is the legacy board.
  const opportunity = OD.computeOpportunityDensity(sizingSet, { regime, tape: s.tape || null });
  // 8) Research contract (shadow). Emit the canonical Prediction records for the FULL
  // cross-section — selected AND rejected — so `lib/research/*` finally observes the live
  // path instead of only its own tests. Built from `all` (includeInactive) precisely so a
  // future learner sees the names this model turned down; training only on displayed picks
  // is the selection-bias trap. Wrapped: this is an observer, and an observer must never be
  // able to break the board it watches.
  let research = null;
  try {
    // NY market date, not UTC — a decision made at 20:00 ET belongs to that trading day.
    // The forward axis is holiday-aware (lib/stats table), so eligibleEntryTs is a real
    // session rather than a weekday guess.
    const decisionTs = nowET().date;
    // Rows carry their governance verdict into the frozen record: classify() attaches
    // the lib/eligibility assessment when the gate is loaded (no gate ⇒ rows pass
    // through unchanged and the record's eligibility field stays null — honest).
    const snapshotRows = all.map(x => (x.evidenceClass ? x : classify(x)));
    research = LB.buildDecisionSnapshot(snapshotRows, {
      decisionTs,
      sessionAxis: LB.forwardSessionAxis(decisionTs, { isHoliday: isMarketHoliday }),
      sessionAxisKind: 'exact',
      modelVersion: D.SCHEMA_VERSION,
      regime: regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral',
    });
  } catch { research = null; }
  // Governance gate report (quant-redesign-3). In 'annotate' mode this IS the shadow
  // comparison the redesign requires before enforcement can be enabled: what the top
  // list would look like under fail-closed eligibility, and exactly who drops and why.
  let governanceGate = null;
  let actionableByHorizon = null;
  let qualifiedLeadsByHorizon = null;
  let researchByHorizon = null;
  if (gate) {
    // The strictly-gated ranked board: only trade-eligible sources enter the merge, so
    // research/shadow evidence can neither originate a row here nor boost one. In
    // 'enforce' mode this IS the served board; in 'annotate' it is computed alongside.
    const gatedRanked = mode === 'enforce' ? active : (() => {
      const gatedMerged = D.mergeSignals(withNorm(gate.tradeable)).map(keepNorm());
      return D.rankSignals(gatedMerged, { regime, scoreboard, redundancy, origins });
    })();
    // THREE LANES, built from the gated (boost-free) rank so no research evidence can
    // originate a row or lift one:
    //   actionableByHorizon      — ACTIONABLE only (cleared AND sizable). Honestly EMPTY
    //                              when nothing clears; never backfilled.
    //   qualifiedLeadsByHorizon  — QUALIFIED_LEAD only (cleared evidence, not an
    //                              executable/sizable trade). A distinct lane end to end.
    //   researchByHorizon        — the FULL ungated cross-section, RESEARCH-classed.
    const gatedClassified = gatedRanked.map(x => (x.evidenceClass ? x : classify(x)));
    const laneFor = (cls) => Object.fromEntries(D.HORIZONS.map(h => [
      h, gatedClassified.filter(x => x.horizon === h && x.evidenceClass === cls).slice(0, 5),
    ]));
    actionableByHorizon = laneFor('ACTIONABLE');
    qualifiedLeadsByHorizon = laneFor('QUALIFIED_LEAD');
    // The full ungated ranked cross-section is ALWAYS served (not only under enforcement):
    // hiding research from view is not the control that matters, and the lane must exist
    // in every mode so the UI renders one shape.
    const researchRanked = mode === 'enforce'
      ? D.rankSignals(mergedAll, { regime, scoreboard, redundancy, origins }).map(classify)
      : active;
    researchByHorizon = Object.fromEntries(D.HORIZONS.map(h => [
      h, researchRanked.filter(x => x.horizon === h).slice(0, 5),
    ]));

    // SHADOW COMPARISON — the diagnostic, in BOTH directions and never a recommendation:
    //   under enforce  : what the permissive ANNOTATE board would have shown (which rows
    //                    fail-closed enforcement removed, and why) — reported, not served.
    //   under annotate : what enforcement WOULD remove from the board being served.
    const currentTop = active.slice(0, 10).map(x => x.id);
    const enforcedTop = gatedClassified.filter(x => x.evidenceClass === 'ACTIONABLE').slice(0, 10).map(x => x.id);
    const shadowComparison = mode === 'enforce'
      ? {
        direction: 'enforced-vs-annotate',
        servedTop: enforcedTop,
        annotateWouldHaveShown: currentTop,
        suppressedByEnforcement: currentTop.filter(id => !enforcedTop.includes(id)),
        servedSignals: active.length, annotateSignals: mergedAll.length,
        note: 'Diagnostic only. These rows are NOT recommendations — they are what the permissive annotate mode would have ranked before fail-closed eligibility removed them.',
      }
      : {
        direction: 'annotate-vs-enforced',
        currentTop, proposedTop: enforcedTop,
        wouldRemoveFromTop: currentTop.filter(id => !enforcedTop.includes(id)),
        currentSignals: active.length, proposedSignals: gatedClassified.length,
      };
    // Abstention is a first-class outcome, not something to infer from empty lanes:
    // when nothing is ACTIONABLE the payload says so, and the reason-code HISTOGRAM
    // covers EVERY excluded row (the excluded[] sample below is truncated to 50, so
    // without the counts a dominant rejection cause could hide entirely).
    const actionableCount = Object.values(actionableByHorizon).reduce((a, l) => a + l.length, 0);
    const rejectionReasonCounts = {};
    for (const x of gate.excluded) {
      const code = x.code || 'unspecified';
      rejectionReasonCounts[code] = (rejectionReasonCounts[code] || 0) + 1;
    }
    governanceGate = {
      mode, version: gate.version,
      diagnosticOverride: gate.diagnosticOverride,
      governanceSeen: gate.governanceSeen, governanceFresh: gate.governanceFresh,
      perSource: gate.perSource,
      classCounts: gate.classCounts,
      abstained: actionableCount === 0,
      actionableCount,
      rejectionReasonCounts,
      excludedCount: gate.excluded.length,
      excluded: gate.excluded.slice(0, 50),
      shadowComparison,
      note: mode === 'enforce'
        ? 'Fail-closed eligibility ENFORCED (default): only explicitly-production strategies with earned, fresh governance clearance and current required data can originate a live pick; shorts require observed borrow. Excluded names remain visible in the research lane and on their own tabs.'
        : 'ANNOTATE DIAGNOSTIC OVERRIDE — the ranked board is the ungated merge and must not be read as cleared recommendations. The portfolio, ensemble Book and opportunity density are still built from ACTIONABLE-only rows. Unset DECISION_ELIGIBILITY_MODE to restore fail-closed enforcement.',
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    opportunity, research, governanceGate, swingResearch,
    regime: {
      riskOn: regime.riskOn === true, bearish: regime.bearish === true,
      breadthPct: regime.breadthPct ?? null, condition: regime.condition || null,
      label: regime.bearish ? 'Risk-off' : regime.riskOn ? 'Risk-on' : 'Neutral',
    },
    sectors: { leading: sec.leading, weakening: sec.weakening },
    counts: {
      signals: active.length,
      byHorizon: Object.fromEntries(D.HORIZONS.map(h => [h, horizons[h].length])),
      // Before/after transparency: how the served cross-section splits across the three
      // safety classes, and how many rows the book was actually allowed to consider.
      byClass: gate ? {
        ACTIONABLE: active.filter(x => x.evidenceClass === 'ACTIONABLE').length,
        QUALIFIED_LEAD: active.filter(x => x.evidenceClass === 'QUALIFIED_LEAD').length,
        RESEARCH: active.filter(x => x.evidenceClass === 'RESEARCH').length,
      } : null,
      sizingEligible: gate ? sizingSet.length : null,
    },
    // PRE-RANKING data freshness/coverage verdicts (Phase 8) — the degraded-data banner
    // and the per-source reasons a source may not originate a new entry today.
    dataGate,
    horizons, topByHorizon, lanes, events, portfolio,
    // Cleared-strategies-only shortlists (fail-closed; honest-empty when nothing is
    // cleared). topByHorizon remains the full ranked cross-section in annotate mode —
    // render it as research context, never as the actionable list.
    actionableByHorizon,
    // Cleared evidence that is NOT an executable/sizable trade — a first-class lane, never
    // folded into ACTIONABLE and never into RESEARCH.
    qualifiedLeadsByHorizon,
    // The full ungated ranked cross-section per horizon, explicitly RESEARCH/lead-classed,
    // so enforcement never hides research from view.
    researchByHorizon,
    evidenceLegend: D.FAMILY_LABEL,
    strategyFamilyLegend: D.STRATEGY_FAMILY_META,
    // How the double-counting penalty was decided TODAY — asserted vs earned. Surfaced so
    // a reader can audit whether an "N families agree" chip reflects measured independence
    // or the hand-assigned 0.3 prior. Null model → explicitly says it is the prior.
    redundancy: redundancy ? {
      method: 'measured',
      version: redundancy.version,
      verdict: redundancy.verdict,
      measurablePairs: redundancy.summary.measurablePairs,
      totalPairs: redundancy.summary.totalPairs,
      avgMeasuredCredit: redundancy.summary.avgMeasuredCredit,
      avgConfirmationLift: redundancy.summary.avgConfirmationLift,
      confirmationPays: redundancy.summary.confirmationPays,
      priorCredit: redundancy.priorCredit,
      asOf: redundancy.generatedAt || null,
      note: redundancy.note,
    } : {
      method: 'prior',
      priorCredit: D.CORR_DISCOUNT,
      note: 'No measured redundancy model yet — a second agreeing screener in the same family is charged the static prior. Run op=redundancy once the ledgers have ≥8 paired dates per algorithm pair.',
    },
    // Remaining-edge model status (spec §3). Active once origins have been persisted; until
    // then every name is treated as fresh (mult 1) and the board is unchanged.
    remainingEdge: origins && Object.keys(origins).length ? {
      active: true, version: require('./remaining-edge').REMAINING_EDGE_VERSION,
      tracked: Object.keys(origins).length,
      note: 'Live candidates are ranked by how much of their advertised move is still ahead — a name that has already run is demoted, and a name with no net edge left to enter on drops off. Measured against an immutable origin snapshot per signal.',
    } : {
      active: false,
      note: 'Remaining-edge ranking is dormant — origin snapshots have not been persisted yet (they accrue on the daily cron). Names are ranked on their original score until then.',
    },
    // Adversarial failure model (#5) status — always SHADOW here: the per-name failure read is
    // attached for display + logged, but never alters the rank until op=failuremodel proves the
    // rejected group underperforms out-of-sample.
    failureModel: {
      shadow: true, version: FM.FAILURE_MODEL_VERSION,
      flagged: active.filter(x => x.failure && x.failure.failureProb >= FM.CONFIG.APPROVE_AT).length,
      note: 'Shadow: each name carries an uncalibrated failure-risk score + expected mode, but it does NOT change the ranking. Run op=failuremodel to test whether the rejected names actually underperform before it could ever bind.',
    },
  };
}

// Trim an enriched signal down to what the snapshot needs for tomorrow's diff.
const snapRow = (x) => ({ id: x.id, ticker: x.ticker, horizon: x.horizon, state: x.state, rank: x.rank, score: x.score });

// Deterministic hash of the recommendation set the user is being served — the
// display↔grading parity link. Scope: the snapRow projection (id/ticker/horizon/
// state/rank/score) of every active row, stably serialized. Freshness banners and
// prose are deliberately OUT of scope; the ranked recommendation set is what a
// later grade must be provably about. Same hash algo + stable stringify as the
// immutable ledger, so the value is reproducible from any stored snapshot.
function boardHashOf(ids) {
  const { stableStringify } = require('./immutable-ledger');
  return require('node:crypto').createHash('sha256').update(stableStringify(ids)).digest('hex');
}

async function runToday(req, res) {
  const paths = {
    screener: '/api/screener?scope=large', screenerSmall: '/api/screener?scope=small',
    // Full-scope swing coverage (defect #4): micro + expanded are OBSERVED for the
    // research/shadow lane and the deduplicated candidate inventory. They cannot
    // enter the production merge (see buildToday's swingResearch contract).
    screenerMicro: '/api/screener?scope=micro', screenerExpanded: '/api/screener?scope=expanded',
    gapgo: '/api/tracker?op=gapgo', daytrade: '/api/tracker?op=daytrade', coil: '/api/tracker?op=coil',
    gapdown: '/api/tracker?op=gapdown', biotech: '/api/tracker?op=biotech',
    coremo: '/api/tracker?op=core',
    // Adapter coverage (#1): downday supplies the meanReversion family (declared in
    // SOURCE_FAMILY but never emitted until now) and optionsflow supplies the first
    // non-price evidence family on the board.
    downday: '/api/tracker?op=downday', optionsflow: '/api/tracker?op=optionsflow',
    scoreboard: '/api/tracker?op=scoreboard', sectors: '/api/sectors', tape: '/api/tracker?op=tape',
    rt: '/api/tracker?op=readthrough', an: '/api/tracker?op=anomaly',
    sw: '/api/tracker?op=secondwave', ca: '/api/tracker?op=crossasset', ts: '/api/tracker?op=toneshift',
  };
  const keys = Object.keys(paths);
  const results = await Promise.all(keys.map(k => pull(paths[k])));
  const got = {}; keys.forEach((k, i) => { got[k] = results[i]; });

  const sources = {
    screener: got.screener.data, screenerSmall: got.screenerSmall.data,
    screenerMicro: got.screenerMicro.data, screenerExpanded: got.screenerExpanded.data,
    gapgo: got.gapgo.data, daytrade: got.daytrade.data, coil: got.coil.data,
    gapdown: got.gapdown.data, biotech: got.biotech.data,
    coremo: got.coremo.data,
    downday: got.downday.data, optionsflow: got.optionsflow.data,
    scoreboard: got.scoreboard.data, sectors: got.sectors.data, tape: got.tape.data,
    ai: { rt: got.rt.data, an: got.an.data, sw: got.sw.data, ca: got.ca.data, ts: got.ts.data },
  };
  const prev = await readJSON(SNAP_PATH, null).catch(() => null);
  // Best-effort: a missing/thin/failed model returns null → static family prior.
  const redundancy = await require('./redundancy-routes').loadRedundancyModel().catch(() => null);
  // Immutable origin snapshots for the remaining-edge model (spec §3). Absent on a cold store
  // → null → rankSignals leaves the board unchanged.
  const originsDoc = await readJSON(ORIGINS_PATH, null).catch(() => null);
  const origins = (originsDoc && originsDoc.origins) || null;
  // Earned governance state for the central eligibility gate (written daily by
  // op=maturity). Absent/stale ⇒ the gate fails CLOSED (that is the point) — but in the
  // default 'annotate' mode that verdict is report-only and the board is unchanged.
  const governance = await readJSON('governance/latest.json', null).catch(() => null);
  const payload = buildToday(sources, prev, redundancy, origins, { governance });

  // Freshness / system-health + data-trust provenance (#10 + data-trust ask): which
  // sources answered, how stale, what feed they came from, delayed vs real-time.
  const rawFresh = keys.map(k => ({
    source: k, ok: got[k].ok, ms: got[k].ms,
    asOf: got[k].data && (got[k].data.generatedAt || got[k].data.at) || null,
  }));
  const freshness = enrichFreshness(rawFresh, Date.now());
  const down = freshness.filter(f => !f.ok).map(f => f.label || f.source);
  const staleSrc = freshness.filter(f => f.stale).map(f => f.label || f.source);
  const warnings = [];
  if (down.length) warnings.push(`${down.length} source(s) unavailable: ${down.join(', ')}`);
  if (staleSrc.length) warnings.push(`${staleSrc.length} source(s) stale (>1 day): ${staleSrc.join(', ')}`);
  payload.freshness = { sources: freshness, warnings, delayedFeed: true, legend: DATA_TRUST_LEGEND, dataVersion: SCHEMA_VERSION };
  payload.configured = hasStore();

  // The parity hash rides on EVERY response (not just logged ones) so any served
  // board can later be compared against the write-once daily record.
  const activeRows = Object.values(payload.horizons).flat()
    .filter((v, i, a) => a.findIndex(z => z.id === v.id) === i);
  const activeIds = activeRows.map(snapRow);
  payload.boardHash = { algo: 'sha256(stableStringify(snapRows))', rows: activeIds.length, hash: boardHashOf(activeIds) };

  // Persist snapshot for tomorrow's lanes (cron-only, gated by ?log=1 + store).
  if (req.query.log === '1' && hasStore()) {
    const { date } = nowET();
    const active = activeRows;
    const ids = activeIds;
    try { await writeJSON(SNAP_PATH, { date, generatedAt: payload.generatedAt, ids, boardHash: payload.boardHash.hash }, 0); payload.logged = ids.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
    // WRITE-ONCE daily parity record: the first logged board of the day is THE
    // recommendation of record — later calls must not rewrite it. Graders and
    // audits can re-derive the hash from any stored snapshot and prove the row
    // set they are grading is the one that was served.
    try {
      const ppath = `${PARITY_PREFIX}${date}.json`;
      const existing = await readJSON(ppath, null).catch(() => null);
      if (existing) {
        payload.parity = { recorded: false, reason: 'already-recorded (write-once)', date, hash: existing.boardHash, matchesServed: existing.boardHash === payload.boardHash.hash };
      } else {
        await writeJSON(ppath, { version: SCHEMA_VERSION, date, generatedAt: payload.generatedAt, boardHash: payload.boardHash.hash, rows: ids.length, ids }, 0);
        payload.parity = { recorded: true, date, hash: payload.boardHash.hash, matchesServed: true };
      }
    } catch (e) { payload.parityError = String((e && e.message) || e); }
    // Advance the immutable origin store: capture new names, age existing ones, prune stale.
    // Written with cacheMaxAge 0 to avoid the read-modify-write staleness race (per store.js).
    try {
      const nextOrigins = RO.updateOrigins(origins, active, date);
      await writeJSON(ORIGINS_PATH, { version: RO.ORIGINS_VERSION, date, origins: nextOrigins }, 0);
      payload.originsTracked = Object.keys(nextOrigins).length;
    } catch (e) { payload.originsError = String((e && e.message) || e); }
    // Persist the immutable decision snapshot (research contract). WRITE-ONCE: op=today
    // runs many times a day, and a decision that the evening call can overwrite is not
    // evidence. The first logged call of the day is the record; later ones report
    // `already-recorded` and change nothing.
    try {
      const r = await RS.saveDecisionSnapshot(date, payload.research);
      payload.researchLogged = r;
    } catch (e) { payload.researchLogError = String((e && e.message) || e); }
    // Persist the no-trade/opportunity decision BEFORE outcomes are known (#6 storage rule), as a
    // rolling log so no-trade days can later be evaluated against high-opportunity ones.
    try {
      const doc = (await readJSON(OPP_LOG_PATH, null).catch(() => null)) || { days: [] };
      const o = payload.opportunity || {};
      const row = { date, generatedAt: payload.generatedAt, decision: o.decision, score: o.score,
        // Renamed (H11): stored as the honest name; older rows in this log carry the
        // deprecated `expectedBestEdgePct` key — readers must accept both.
        qualifyingCount: o.qualifyingCount, bestNetTargetMovePct: o.bestNetTargetMovePct,
        maxExposurePct: o.maxExposurePct, riskOff: o.regimeGate && o.regimeGate.riskOff };
      const days = [...(doc.days || []).filter(d => d.date !== date), row].slice(-OPP_LOG_MAX);
      await writeJSON(OPP_LOG_PATH, { version: OD.OPPORTUNITY_VERSION, days }, 0);
      payload.opportunityLogged = days.length;
    } catch (e) { payload.opportunityLogError = String((e && e.message) || e); }
  }

  // Fresh for 10 min, then serve STALE instantly for up to 24h while revalidating in the
  // background. The daily warm cron computes this once/day, so with a 24h SWR window a
  // servable copy almost always exists — users get an instant response and the slow
  // 12-source recompute happens off the critical path. (Data is EOD/delayed anyway.)
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, ...payload });
}

module.exports = { runToday, buildToday, snapRow, boardHashOf, PARITY_PREFIX };
