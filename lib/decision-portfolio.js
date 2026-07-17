// PORTFOLIO-AWARE FINAL RANKING (spec §8).
//
// THE GAP THIS FILLS: `rankSignals` sorts every signal independently on its own merit,
// so the board could hand you ten names that are really one bet — same sector, same
// archetype, same underlying at three horizons. A per-signal sort cannot see that, because
// concentration is a property of the SET, not of any member. `lib/allocation.js` does
// portfolio math, but across strategy SLEEVES (how much capital each engine gets), never
// across the individual names on the board.
//
// This is DECISION SUPPORT AND RANKING ONLY — it selects and explains, it never sizes a
// position or places an order (the spec is explicit about that boundary).
//
// WHAT IT HONESTLY CANNOT DO: the spec asks to exclude names "highly correlated with a
// stronger selection". The app has no pairwise TICKER return-correlation matrix —
// `lib/redundancy.js` measures correlation between ALGORITHMS, which is a different thing
// and cannot be borrowed here without lying about what was measured. So correlation is
// proxied by SECTOR and by strategy ARCHETYPE, and every such exclusion says so in its
// own detail string. We do not label a sector cap as a measured correlation.
//
// UNKNOWN IS NEVER A VIOLATION. A missing sector, a missing dollar-volume, or an unknown
// net EV admits the name — consistent with `executionQuality` (unknown liquidity is
// neutral, not thin) and `decision-costs` (unknown tier is cheapest, not worst). We
// exclude on measured evidence or not at all.
//
// Pure: ranked signals in → a selection + an audited exclusion list out. No network.

'use strict';

const METHOD = 'portfolio-v1';

// Caps. Deliberately loose: this demotes concentration, it does not run a risk model.
const DEFAULTS = {
  size: 10,           // the spec's Top 10 / Top 20 output — a CEILING, never a quota
  maxPerSector: 3,    // sector/industry concentration
  maxPerFamily: 4,    // one archetype (trend/reversion/event/…) must not own the book
  minDollarVol: 2e6,  // matches decision.js LIQ.minDollarVol — one liquidity floor, not two
  // NO FORCED QUOTA. Caps push down the ranked list, and without a floor the freed slots
  // fill with whatever is left — on a homogeneous tape that means junk. Observed on the
  // live board: capping Tech/trend promoted a composite-3.6 name into slot 10, which is
  // strictly worse than holding 9 names and cash. This is the same lesson the Quick Hit
  // tab already learned (quality-gated, no forced quota).
  //
  // HONEST: 50 is a disclosed product floor, not a validated threshold — the app has no
  // evidence for a "right" cutoff (it has no durable edge to calibrate one against). It
  // is deliberately blunt: reject the obviously-not-a-trade, decide nothing finer.
  minScore: 50,
};

const EXCLUSION_LABEL = {
  'sector-cap': 'Sector cap reached',
  'family-cap': 'Strategy already well represented',
  'duplicate-underlying': 'Same underlying already selected',
  liquidity: 'Insufficient liquidity',
  'net-ev': 'Net expected value below threshold',
  'quality-floor': 'Below the quality floor — slot left unfilled',
  'not-a-position': 'Market context, not a tradeable position',
  size: 'Below the cut for this book size',
};

// Strategy archetypes that are CONTEXT, not positions. `sectorStrength` emits a row so the
// board can show what is leading — it has no entry, no stop, and cannot be held. It must
// never occupy a slot in a book of things you would actually own.
const NON_POSITION_FAMILIES = new Set(['context']);

// Sector PLACEHOLDERS that mean "we don't know", not "a sector called ?".
//
// Caught on the live board: exposure came back {Technology:3, "Health Care":3, "?":2} —
// the feed emits a literal '?' string, so two unrelated names with no sector were being
// capped against each other as if they shared one. That silently contradicts the rule this
// module states everywhere else (unknown is never a violation) — a null sector was
// correctly admitted while a '?' sector was not, purely by which placeholder the upstream
// adapter happened to use.
const UNKNOWN_SECTORS = new Set(['?', '-', '', 'n/a', 'na', 'unknown', 'null', 'undefined']);
const knownSector = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s && !UNKNOWN_SECTORS.has(s.toLowerCase()) ? s : null;
};

const fmtDollar = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B`
  : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M`
    : `$${Math.round(v / 1e3)}K`);

// Greedy admission down the incoming rank. The rank is already the engine's full verdict
// (validated expectancy × confidence × regime × execution × evidence × cost); this layer
// only ever REMOVES for a set-level reason, never re-orders on a new opinion of merit.
function buildPortfolio(ranked, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const rows = Array.isArray(ranked) ? ranked.filter(Boolean) : [];
  const selected = [];
  const excluded = [];
  const bySector = new Map();   // sector → [tickers]
  const byFamily = new Map();   // strategyFamily → [tickers]
  const byTicker = new Map();   // ticker → the horizon already selected

  const drop = (s, reason, detail, blockedBy) => excluded.push({
    id: s.id, ticker: s.ticker, horizon: s.horizon, score: s.score,
    sector: s.sector || null, strategyFamily: s.strategyFamily || null,
    reason, label: EXCLUSION_LABEL[reason], detail,
    blockedBy: blockedBy || null,
  });

  for (const s of rows) {
    // ── not a candidate at all
    if (NON_POSITION_FAMILIES.has(s.strategyFamily)) {
      drop(s, 'not-a-position', `${s.strategyFamily} rows describe the tape — there is no position to hold`);
      continue;
    }
    if (Number.isFinite(s.score) && s.score < cfg.minScore) {
      drop(s, 'quality-floor', `composite ${s.score} is under the ${cfg.minScore} floor — the slot is better left empty than filled`);
      continue;
    }

    // ── measured, name-level vetoes (properties of the name, not the set)
    const dv = s.liquidity && Number.isFinite(s.liquidity.dollarVol) ? s.liquidity.dollarVol : null;
    if (dv != null && dv < cfg.minDollarVol) {
      drop(s, 'liquidity', `${fmtDollar(dv)}/day is below the ${fmtDollar(cfg.minDollarVol)} tradeable floor`);
      continue;
    }
    // Costs exceed the entire target move ⇒ there is no trade here to rank.
    const net = s.cost && s.cost.known ? s.cost.netMovePct : null;
    if (net != null && net <= 0) {
      drop(s, 'net-ev', `net expected move ${net}% after the ${s.cost.roundTripPct}% round trip — costs exceed the target`);
      continue;
    }

    // ── set-level constraints
    //
    // The size check comes FIRST among these: once the book is full, "there was no slot"
    // is the true reason a name was dropped. Testing the caps first would label a name
    // 'sector-cap' when the book had already closed — a reason that reads as "your sector
    // was crowded" when in fact nothing could have got in. The excluded panel exists to
    // explain real trade-offs, so it must not attribute a decision to a constraint that
    // was not the binding one.
    if (selected.length >= cfg.size) {
      drop(s, 'size', `ranked #${s.rank ?? '—'} — the book was already full at ${cfg.size}`);
      continue;
    }
    if (byTicker.has(s.ticker)) {
      drop(s, 'duplicate-underlying',
        `${s.ticker} is already selected at the ${byTicker.get(s.ticker)} horizon — a second entry doubles the same bet`,
        [s.ticker]);
      continue;
    }
    const sec = knownSector(s.sector);
    const secHeld = sec ? (bySector.get(sec) || []) : [];
    if (sec && secHeld.length >= cfg.maxPerSector) {
      drop(s, 'sector-cap',
        `${sec} already holds ${secHeld.length} of a max ${cfg.maxPerSector} — sector-proxied concentration, not a measured correlation`,
        [...secHeld]);
      continue;
    }
    const fam = s.strategyFamily || null;
    const famHeld = fam ? (byFamily.get(fam) || []) : [];
    if (fam && famHeld.length >= cfg.maxPerFamily) {
      drop(s, 'family-cap',
        `the ${fam} archetype already holds ${famHeld.length} of a max ${cfg.maxPerFamily} — these names tend to win and lose together`,
        [...famHeld]);
      continue;
    }
    selected.push({ ...s, portfolioRank: selected.length + 1 });
    byTicker.set(s.ticker, s.horizon);
    if (sec) bySector.set(sec, [...secHeld, s.ticker]);
    if (fam) byFamily.set(fam, [...famHeld, s.ticker]);
  }

  const exposure = {};
  for (const [sec, list] of bySector) exposure[sec] = list.length;
  const familyExposure = {};
  for (const [fam, list] of byFamily) familyExposure[fam] = list.length;

  return {
    method: METHOD,
    caps: { ...cfg },
    selected,
    excluded,
    exposure,
    familyExposure,
    // The book can legitimately come in UNDER `size` — that is the design, not a bug, and
    // the UI must be able to say so rather than imply the tape offered nothing.
    unfilled: Math.max(0, cfg.size - selected.length),
    // Honest disclosure the UI can render verbatim rather than re-derive.
    note: 'Concentration is proxied by sector and strategy archetype. The app has no pairwise ticker-correlation matrix, so no exclusion here claims a measured correlation.',
  };
}

module.exports = { METHOD, DEFAULTS, EXCLUSION_LABEL, buildPortfolio };
