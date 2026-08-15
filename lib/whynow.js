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

// Which Scoreboard section each signal class maps to, for the per-section decile join
// (does this signal class's OWN scorer actually rank its winners?). Apex + the conviction
// sleeve both score the breakout screener's cross-section, so they map to 'screener'.
const SIGNAL_SECTION = { Ghost: 'Ghost', Apex: 'screener', Conviction: 'screener', ReadThrough: 'ReadThrough' };
function sectionOf(key) { return SIGNAL_SECTION[String(key || '').split(':')[0]] || null; }

// Build the ordered signal list from the extracted per-ticker facts. Each entry:
//   { side:'for'|'against'|'context', key, label, detail, track, rankQuality? }
function buildSignals(facts) {
  const { apex, ghost, conviction, insider, readThrough = [], macro, trackByKey = {}, sectionDecile = null } = facts;
  const out = [];

  // Ghost accumulation — RETIRED (registry `rejected` 2026-08-13: duplicate of the
  // screener, measured independence credit 0.248). A retired strategy may not add
  // verdict weight; the read stays visible as labeled context with its historical
  // track record, and returns to the for-column only via a registry transition.
  if (ghost && (ghost.tier === 'GHOST' || ghost.tier === 'STALKING')) {
    const ghostEligible = (() => { try { return require('./strategy-gate').isTradeEligible('ghost'); } catch { return false; } })();
    const strong = Array.isArray(ghost.strongPillars) && ghost.strongPillars.length
      ? `, strong on ${ghost.strongPillars.join(' / ')}` : '';
    out.push({ side: ghostEligible ? 'for' : 'context', key: `Ghost:${ghost.tier}`,
      label: ghost.tier === 'GHOST' ? 'Quiet accumulation (Ghost)' : 'Early accumulation (Stalking)',
      detail: `Ghost Accumulation Index ${ghost.score}/100${strong} — price/volume accumulation footprint (unverified proxy, not confirmed institutional flow).`,
      track: trackFor(trackByKey[`Ghost:${ghost.tier}`]),
      note: ghostEligible ? undefined : 'Retired strategy (registry: rejected — duplicate of the screener) — shown as context, adds no verdict weight.' });
  }

  // Apex — registry-SHADOW (demoted 2026-08-12, zero-weight frozen benchmark). A
  // shadow model's read may not add 'for' weight to the verdict; it stays visible as
  // labeled research context only, and returns to the 'for' column only via a
  // registry re-promotion (never a code edit here).
  if (apex && (apex.tier === 'apex' || apex.tier === 'loaded')) {
    const apexEligible = (() => { try { return require('./strategy-gate').isTradeEligible('custom'); } catch { return false; } })();
    out.push({ side: apexEligible ? 'for' : 'context', key: `Apex:${apex.tier}`,
      label: apex.tier === 'apex' ? 'Confirmed breakout (Apex)' : 'Breakout setup (Loaded)',
      detail: `Apex composite ${apex.score}/100 across momentum, structure, fundamentals and supply.`,
      track: null, note: apexEligible ? 'Tracked live via Apex model drift (Custom tab), not the Scoreboard.' : 'Shadow benchmark (registry: zero weight) — shown as context, adds no verdict weight.' });
  }

  // Conviction sleeve — registry-FROZEN SHADOW BENCHMARK: "no user-facing badge or
  // rank may consume it". Context only while shadow.
  if (conviction && conviction.sleeveA) {
    const convEligible = (() => { try { return require('./strategy-gate').isTradeEligible('conviction'); } catch { return false; } })();
    out.push({ side: convEligible ? 'for' : 'context', key: 'Conviction:sleeveA',
      label: 'Top-quintile conviction',
      detail: `Ranks in the top ${conviction.pctile != null ? 100 - conviction.pctile : 20}% of the full cross-section on the regime-gated conviction model, and the regime gate allows longs.`,
      track: null, note: convEligible ? undefined : 'Shadow benchmark (registry: zero weight) — shown as context, adds no verdict weight.' });
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

  // Attach each signal's per-section decile verdict — the honest "does this signal class's
  // own score actually rank its winners?" read, distinct from its win-rate track record.
  if (sectionDecile) {
    for (const s of out) {
      const sec = sectionOf(s.key);
      if (sec && sectionDecile[sec]) s.rankQuality = sectionDecile[sec];
    }
  }
  return out;
}

// ── Full model coverage (#5 — "all model signals, incl. neutral / stale / unavailable")
// The signal list above only shows lenses that FIRED. Honest coverage also reports the
// lenses that were checked and came back QUIET, and those with NO DATA — so the page
// says "here is every model we ran and what each one said", never hiding a silent lens.
const COVERAGE_CLASSES = [
  { key: 'apex', label: 'Breakout momentum (Apex)' },
  { key: 'ghost', label: 'Quiet accumulation (Ghost)' },
  { key: 'conviction', label: 'Conviction sleeve' },
  { key: 'insider', label: 'Insider activity' },
  { key: 'readThrough', label: 'Read-through beneficiary' },
  { key: 'macro', label: 'Macro regime' },
];
// status: 'active' (firing), 'clear' (checked, nothing), 'unavailable' (no data for this name).
function coverageOf(facts) {
  const f = facts || {};
  const entry = (key, label, status, detail) => ({ key, label, status, detail });
  return COVERAGE_CLASSES.map(({ key, label }) => {
    if (key === 'apex') {
      if (!f.apex) return entry(key, label, 'unavailable', 'Not in the breakout screen’s universe today.');
      if (f.apex.tier === 'apex' || f.apex.tier === 'loaded') return entry(key, label, 'active', `Apex ${f.apex.score}/100 (${f.apex.tier}).`);
      return entry(key, label, 'clear', `Scanned — no breakout tier (Apex ${f.apex.score ?? '—'}/100).`);
    }
    if (key === 'ghost') {
      if (!f.ghost) return entry(key, label, 'unavailable', 'No accumulation read for this name today.');
      if (f.ghost.tier === 'GHOST' || f.ghost.tier === 'STALKING') return entry(key, label, 'active', `Ghost ${f.ghost.score}/100 (${f.ghost.tier}).`);
      return entry(key, label, 'clear', `Scanned — no accumulation footprint (Ghost ${f.ghost.score ?? '—'}/100).`);
    }
    if (key === 'conviction') {
      if (!f.conviction) return entry(key, label, 'unavailable', 'Not scored on the conviction model today.');
      return f.conviction.sleeveA
        ? entry(key, label, 'active', 'Top-quintile, regime-gate allows longs.')
        : entry(key, label, 'clear', `Scored but below the top sleeve${f.conviction.pctile != null ? ` (${f.conviction.pctile}th pctile)` : ''}.`);
    }
    if (key === 'insider') {
      if (!f.insider) return entry(key, label, 'unavailable', 'No insider filings loaded for this name.');
      return f.insider.clusterBuy
        ? entry(key, label, 'active', 'Recent open-market cluster buying (context flag).')
        : entry(key, label, 'clear', 'Checked — no recent cluster buying.');
    }
    if (key === 'readThrough') {
      const rt = f.readThrough || [];
      if (!rt.length) return entry(key, label, 'clear', 'Not flagged as a second-order beneficiary today.');
      const fresh = rt.some(r => r.moved && r.moved.alreadyMoved === false);
      return entry(key, label, 'active', fresh ? 'Fresh read-through (hasn’t repriced yet).' : 'Read-through link — already moved.');
    }
    // macro
    if (!f.macro) return entry(key, label, 'unavailable', 'Macro regime not loaded.');
    if (f.macro.riskOff) return entry(key, label, 'active', 'Risk-off — a hard caution on new longs (the validated lever).');
    return entry(key, label, 'clear', f.macro.riskOn ? 'Risk-on tape — supportive backdrop.' : 'Neutral tape.');
  });
}

// Roll the signals into a single honest verdict. Risk-off vetoes to 'caution'
// regardless of bullish count (the validated lever). Otherwise the strength of the
// FOR case sets the level. 'quiet' = nothing fired → we say so plainly.
// Effective FOR count for the verdict: signals that share a Scoreboard SECTION
// score the same underlying cross-section (Apex + Conviction both rank the
// breakout screener), so they collapse to ONE vote — correlated screeners must
// not read as multiple confirmations.
function dedupedForCount(signals) {
  const seen = new Set();
  let n = 0;
  for (const s of signals) {
    if (s.side !== 'for') continue;
    const sec = sectionOf(s.key);
    const bucket = sec || s.key;
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    n += 1;
  }
  return n;
}

function verdictOf(signals) {
  const forCount = dedupedForCount(signals);
  const rawForCount = signals.filter(s => s.side === 'for').length;
  const veto = signals.some(s => s.veto);
  const anyFired = signals.some(s => s.side === 'for' || s.side === 'against');
  if (!anyFired) {
    // SCREENER-SCOPED language only: absence from the screener panels is not a
    // verdict on the ticker — the lookup's primary recommendation (from the
    // direct price/structure read) is a separate surface and may still be live.
    return { level: 'quiet', headline: 'No screener signals',
      summary: "This name isn't on any of the app's screener panels right now — no accumulation, breakout, or read-through flag. That is a statement about the screeners, not about the primary recommendation above." };
  }
  if (veto) {
    return { level: 'caution', headline: forCount ? 'Constructive setup, wrong tape' : 'Caution',
      summary: forCount
        ? `${forCount} bullish signal${forCount > 1 ? 's' : ''} fired, but the macro tape is risk-off — the app's one validated rule says wait rather than open a new long here.`
        : 'The macro tape is risk-off; the app avoids new longs in this regime.' };
  }
  if (forCount >= 2) {
    const collapsed = rawForCount > forCount ? ` (${rawForCount} raw flags, correlated ones counted once)` : '';
    return { level: 'constructive', headline: 'Multiple signals aligned',
      summary: `${forCount} separate signal families point the same way${collapsed} and the tape isn't fighting it. Separate models can still share inputs — confirm each against its track record below before sizing.` };
  }
  if (forCount === 1) {
    const collapsed = rawForCount > 1 ? `${rawForCount} flags fired but they score the same underlying cross-section, so they count as one signal. ` : 'A single signal is active. ';
    return { level: 'watch', headline: 'One signal firing',
      summary: `${collapsed}Worth a look, but one flag is a watch, not a thesis — check its track record and wait for confirmation.` };
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
    coverage: coverageOf(facts || {}),
    regime: (facts && facts.macro) ? facts.macro.regime : null,
    disclaimer: DISCLAIMER,
  };
}

module.exports = { composeWhyNow, buildSignals, verdictOf, dedupedForCount, trackFor, regimeContext, coverageOf, COVERAGE_CLASSES, sectionOf, SIGNAL_SECTION, MIN_RESOLVED, DISCLAIMER };
