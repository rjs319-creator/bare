// WHY NOW — the per-ticker composer.
//
// Takes the signals the app ALREADY computes for a ticker (Apex breakout tier,
// Ghost accumulation, conviction sleeve, second-order read-through, macro regime)
// and reasons them into one honest answer: the case FOR the name right now, the
// case AGAINST, and — critically — the app's own logged TRACK RECORD for each
// firing signal class. No fabricated probabilities: "confidence" is always a real
// Scoreboard row (win rate + excess-vs-benchmark on resolved picks) or an explicit
// "not enough resolved yet". This is the inverse of a black-box 0-100 score.
//
// Pure + deterministic (no I/O) so it unit-tests cleanly; the route (whynow-routes)
// does the gathering and hands the extracted facts here.

// A signal's track record is trustworthy only once enough picks in its class have
// resolved. Below this we surface the sample but label it PENDING, never a verdict.
const MIN_RESOLVED = 15;
// Prefer the 1-week horizon (resolves fast, fills the ledger sooner); fall back to
// the 1-month horizon if the 1-week bucket is empty.
const TRACK_HORIZONS = ['5d', '21d'];
const HORIZON_LABEL = { '5d': '1-week', '21d': '1-month', '63d': '3-month' };

// Normalize a Scoreboard group (section:tier) into an honest track-record line.
// `group` = { picks, horizons: { '5d': summarizeReturns(...), ... } } | undefined.
function trackFor(group) {
  if (!group || !group.horizons) return null;
  for (const hk of TRACK_HORIZONS) {
    const s = group.horizons[hk];
    if (s && s.excessN) {
      return {
        horizon: HORIZON_LABEL[hk] || hk,
        resolved: s.excessN,
        winRate: s.winRate,
        avgExcess: s.avgExcess,          // avg return minus the benchmark, same window
        beatBenchRate: s.beatMktRate,    // % of resolved picks that beat their benchmark
        pending: s.excessN < MIN_RESOLVED,
      };
    }
  }
  // Logged but nothing resolved on any tracked horizon yet.
  const logged = group.picks || 0;
  return logged ? { horizon: null, resolved: 0, winRate: null, avgExcess: null, beatBenchRate: null, pending: true } : null;
}

// Regime → the one durable, backtested lever: the app's research found the breakout
// edge INVERTS in macro risk-off. So risk-off is a hard caution on any new long,
// regardless of how many bullish signals fire.
function regimeContext(macro) {
  if (!macro) return null;
  if (macro.riskOff) {
    const vix = macro.vix ? ` (VIX ${macro.vix.level}, ${macro.vix.pctile}th pctile)` : '';
    return { side: 'against', key: 'macro', label: 'Macro risk-off',
      detail: `The tape is risk-off${vix}. The one lever this app validated across regimes is: don't open new longs into risk-off — the breakout edge goes negative here.`,
      veto: true };
  }
  if (macro.riskOn) {
    return { side: 'context', key: 'macro', label: 'Supportive tape',
      detail: 'Macro regime is risk-on — a tailwind for long setups, not an edge on its own.', veto: false };
  }
  return { side: 'context', key: 'macro', label: 'Neutral tape',
    detail: 'Macro regime is neutral.', veto: false };
}

// Build the ordered signal list from the extracted per-ticker facts. Each entry:
//   { side:'for'|'against'|'context', key, label, detail, track }
function buildSignals(facts) {
  const { apex, ghost, conviction, insider, readThrough = [], macro, trackByKey = {} } = facts;
  const out = [];

  // Ghost accumulation — quiet pre-breakout buying (has a Scoreboard track record).
  if (ghost && (ghost.tier === 'GHOST' || ghost.tier === 'STALKING')) {
    const strong = Array.isArray(ghost.strongPillars) && ghost.strongPillars.length
      ? `, strong on ${ghost.strongPillars.join(' / ')}` : '';
    out.push({ side: 'for', key: `Ghost:${ghost.tier}`,
      label: ghost.tier === 'GHOST' ? 'Quiet accumulation (Ghost)' : 'Early accumulation (Stalking)',
      detail: `Ghost Accumulation Index ${ghost.score}/100${strong} — smart-money footprint before an obvious breakout.`,
      track: trackFor(trackByKey[`Ghost:${ghost.tier}`]) });
  }

  // Apex — confirmed breakout momentum. Tracked via model DRIFT, not the Scoreboard,
  // so we show the composite honestly with no fabricated win rate.
  if (apex && (apex.tier === 'apex' || apex.tier === 'loaded')) {
    out.push({ side: 'for', key: `Apex:${apex.tier}`,
      label: apex.tier === 'apex' ? 'Confirmed breakout (Apex)' : 'Breakout setup (Loaded)',
      detail: `Apex composite ${apex.score}/100 across momentum, structure, fundamentals and supply.`,
      track: null, note: 'Tracked live via Apex model drift (Custom tab), not the Scoreboard.' });
  }

  // Conviction sleeve — top-quintile, regime-gated long-eligible.
  if (conviction && conviction.sleeveA) {
    out.push({ side: 'for', key: 'Conviction:sleeveA',
      label: 'Top-quintile conviction',
      detail: `Ranks in the top ${conviction.pctile != null ? 100 - conviction.pctile : 20}% of the full cross-section on the regime-gated conviction model, and the regime gate allows longs.`,
      track: null });
  }

  // Insider — a confirmation FLAG only (research: real signal, not additive to a
  // momentum composite). Surface cluster open-market buying if present.
  if (insider && insider.clusterBuy) {
    out.push({ side: 'context', key: 'insider', label: 'Insider cluster buying',
      detail: 'Multiple insiders bought in the open market recently — a confirmation flag, not a standalone edge.',
      track: null });
  }

  // Read-through — is this name a second-order beneficiary of someone else's catalyst
  // that hasn't repriced yet? Fresh (un-moved) is the edge; already-moved is demoted.
  for (const rt of readThrough) {
    const moved = rt.moved && rt.moved.alreadyMoved;
    const fresh = rt.moved && rt.moved.alreadyMoved === false;
    const tier = fresh ? 'Fresh' : moved ? 'Moved' : 'Unknown';
    out.push({
      side: fresh ? 'for' : moved ? 'against' : 'context',
      key: `ReadThrough:${tier}`,
      label: fresh ? `Fresh read-through off ${rt.trigger_ticker}` : moved ? `Read-through already moved (${rt.trigger_ticker})` : `Read-through off ${rt.trigger_ticker}`,
      detail: `${rt.link_type ? rt.link_type + ' link — ' : ''}${rt.thesis || 'economically linked to a mover.'}${moved ? ' Already repriced today — the lag edge is gone.' : fresh ? " Hasn't repriced yet." : ''}`,
      track: trackFor(trackByKey[`ReadThrough:${tier}`]),
    });
  }

  // Regime — always last so the veto reads as the final word.
  const rg = regimeContext(macro);
  if (rg) out.push({ ...rg, track: null });

  return out;
}

// Roll the signals into a single honest verdict. Risk-off vetoes to 'caution'
// regardless of bullish count (the validated lever). Otherwise the strength of the
// FOR case sets the level. 'quiet' = nothing fired → we say so plainly.
function verdictOf(signals) {
  const forCount = signals.filter(s => s.side === 'for').length;
  const veto = signals.some(s => s.veto);
  const anyFired = signals.some(s => s.side === 'for' || s.side === 'against');
  if (!anyFired) {
    return { level: 'quiet', headline: 'No active signals',
      summary: "This name isn't on any of the app's screens right now — no accumulation, breakout, or read-through flag. Nothing to act on here today." };
  }
  if (veto) {
    return { level: 'caution', headline: forCount ? 'Constructive setup, wrong tape' : 'Caution',
      summary: forCount
        ? `${forCount} bullish signal${forCount > 1 ? 's' : ''} fired, but the macro tape is risk-off — the app's one validated rule says wait rather than open a new long here.`
        : 'The macro tape is risk-off; the app avoids new longs in this regime.' };
  }
  if (forCount >= 2) {
    return { level: 'constructive', headline: 'Multiple signals aligned',
      summary: `${forCount} independent signals point the same way and the tape isn't fighting it. Confirm each against its track record below before sizing.` };
  }
  if (forCount === 1) {
    return { level: 'watch', headline: 'One signal firing',
      summary: 'A single signal is active. Worth a look, but one flag is a watch, not a thesis — check its track record and wait for confirmation.' };
  }
  return { level: 'caution', headline: 'Signals lean against',
    summary: 'The active signals lean against a new long here.' };
}

const DISCLAIMER = 'Composed from the app’s own signals and their logged forward track records — not advice, and never a fabricated probability. Every case below traces to a specific signal you can audit on its tab.';

// Top-level: facts in → the full WHY NOW payload.
function composeWhyNow(facts) {
  const signals = buildSignals(facts || {});
  return {
    ticker: (facts && facts.ticker) || null,
    verdict: verdictOf(signals),
    forCase: signals.filter(s => s.side === 'for'),
    againstCase: signals.filter(s => s.side === 'against'),
    context: signals.filter(s => s.side === 'context'),
    signals,
    regime: (facts && facts.macro) ? facts.macro.regime : null,
    disclaimer: DISCLAIMER,
  };
}

module.exports = { composeWhyNow, buildSignals, verdictOf, trackFor, regimeContext, MIN_RESOLVED, DISCLAIMER };
