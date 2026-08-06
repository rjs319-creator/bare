'use strict';
// UNUSUAL OPTIONS POSITIONING — tech-command-options-v1.
//
// Reuses the app's existing options-flow rollup (lib/optionsflow rollupByTicker →
// directionState / unknownShare / OI confirmation / earnings-before-expiry) and its
// confirmation engine's judgment shape, and projects it onto the technology
// universe with the honest state vocabulary the spec requires.
//
// THE LIMITATION, STATED ONCE AND CARRIED EVERYWHERE. The configured chain feed is
// DELAYED end-of-interval data. From it we cannot establish buyer vs seller,
// opening vs closing, directional bet vs hedge, or true sweep aggressor behavior.
// Therefore:
//   • options NEVER originate a recommendation here — `canOriginate` is false and
//     `weight` is 0 on every row;
//   • options may CONFIRM, CONTRADICT or QUALIFY an independently-valid setup;
//   • the phrase "smart money" is not used;
//   • the delay and the timestamp are labeled on every row.
//
// Pure: rollup rows + setups in, frozen section out.

const OPTIONS_VERSION = 'tech-command-options-v1';

const STATES = Object.freeze([
  'CONFIRMS_BULLISH_SETUP', 'CONFIRMS_BEARISH_SETUP', 'CONTRADICTS_SETUP',
  'EVENT_POSITIONING', 'MIXED', 'DIRECTION_UNKNOWN', 'TOO_ILLIQUID', 'STALE',
]);

const MIN_CONTRACTS = 3;          // below this the row is TOO_ILLIQUID
const MIN_PREMIUM_USD = 50000;    // below this the row is TOO_ILLIQUID
const STALE_HOURS = 24;

const num = v => (Number.isFinite(v) ? v : null);

/**
 * @param {{rollup: Array, universe: object, setups?: Object<string, {direction: string, valid: boolean}>,
 *          baselines?: Object<string, {callVolBaseline: number, putVolBaseline: number}>,
 *          now?: Date, asOf?: string, delayedByMin?: number}} input
 */
function buildOptionsSection({ rollup, universe, setups = {}, baselines = {}, now = new Date(), asOf = null, delayedByMin = 15 } = {}) {
  const nowIso = new Date(now).toISOString();
  const byTicker = (universe && universe.byTicker) || {};
  const stale = asOf ? (new Date(now).getTime() - Date.parse(asOf)) / 3600000 > STALE_HOURS : true;

  const rows = (rollup || [])
    .filter(r => r && r.ticker && byTicker[String(r.ticker).toUpperCase()])
    .map(r => {
      const t = String(r.ticker).toUpperCase();
      const u = byTicker[t];
      const setup = setups[t] || null;
      const base = baselines[t] || null;
      const contracts = num(r.contracts) ?? 0;
      const premium = num(r.totalPremium) ?? 0;
      const illiquid = contracts < MIN_CONTRACTS || premium < MIN_PREMIUM_USD;

      let state;
      if (stale) state = 'STALE';
      else if (illiquid) state = 'TOO_ILLIQUID';
      else if (r.earningsBeforeExpiry) state = 'EVENT_POSITIONING';
      else if (r.directionState === 'MIXED') state = 'MIXED';
      else if (r.directionState === 'DIRECTION_UNKNOWN' || !r.directionState) state = 'DIRECTION_UNKNOWN';
      else if (!setup || !setup.valid) state = 'DIRECTION_UNKNOWN';
      else {
        const bull = r.directionState === 'PROVISIONAL_BULLISH';
        const bear = r.directionState === 'PROVISIONAL_BEARISH';
        const agrees = (setup.direction === 'long' && bull) || (setup.direction === 'short' && bear);
        state = agrees ? (bull ? 'CONFIRMS_BULLISH_SETUP' : 'CONFIRMS_BEARISH_SETUP') : 'CONTRADICTS_SETUP';
      }

      const callVsBaseline = base && base.callVolBaseline > 0 && num(r.callVolume) != null
        ? +(r.callVolume / base.callVolBaseline).toFixed(2) : null;
      const putVsBaseline = base && base.putVolBaseline > 0 && num(r.putVolume) != null
        ? +(r.putVolume / base.putVolBaseline).toFixed(2) : null;

      return Object.freeze({
        ticker: t, company: u.company, subsector: u.subsector, subsectorLabel: u.subsectorLabel,
        state,
        stateExplanation: explainState(state, r, setup),
        // Raw honest reads from the existing engine.
        directionState: r.directionState || 'DIRECTION_UNKNOWN',
        directionLabel: r.directionLabel || 'Direction unknown',
        unknownShare: num(r.unknownShare),
        suspectedMultiLeg: num(r.suspectedMultiLeg),
        contracts, totalPremiumUsd: premium,
        callPremiumUsd: num(r.callPremium), putPremiumUsd: num(r.putPremium),
        callVolumeVsBaseline: callVsBaseline, putVolumeVsBaseline: putVsBaseline,
        oiConfirmedContracts: num(r.oiConfirmedContracts) ?? 0,
        oiConfirmationNote: (r.oiConfirmedContracts || 0) > 0
          ? 'Next-session open interest rose on at least one of these contracts — the position was opened, not just traded.'
          : 'No next-session open-interest confirmation — these prints may be closing or intraday round-trips.',
        strikeConcentration: r.topContract ? { strike: num(r.topContract.strike), side: r.topContract.side, expiry: r.topContract.expiry || null } : null,
        earningsBeforeExpiry: r.earningsBeforeExpiry === true,
        earningsInDays: num(r.earningsInDays),
        impliedVol: num(r.iv ?? r.impliedVolatility),
        ivVsRv: num(r.ivRv),
        skew: num(r.skew),
        termStructure: r.termStructure || null,
        expectedMovePct: num(r.expectedMovePct),
        // Governance — invariant, on every row.
        weight: 0,
        canOriginate: false,
        researchOnly: true,
        dataQuality: 'delayed',
        delayedByMin,
        asOf: asOf || null,
        disclosure: `Delayed option-chain data${asOf ? ` as of ${asOf}` : ''}. Buyer vs seller, opening vs closing, bet vs hedge and true sweep aggression are NOT determinable from this feed. This is not order flow and it is not "smart money".`,
      });
    })
    .sort((a, b) => (b.totalPremiumUsd || 0) - (a.totalPremiumUsd || 0));

  const byState = Object.fromEntries(STATES.map(s => [s, rows.filter(r => r.state === s).map(r => r.ticker)]));

  return Object.freeze({
    schema: OPTIONS_VERSION,
    generatedAt: nowIso,
    asOf: asOf || null,
    stale,
    delayedByMin,
    liveOrderFlow: false,
    liveOrderFlowNote: 'No real-time licensed options feed is configured. This page does not have institutional options order flow and does not claim to.',
    rows: Object.freeze(rows),
    byState: Object.freeze(byState),
    counts: Object.freeze({ total: rows.length, ...Object.fromEntries(STATES.map(s => [s, byState[s].length])) }),
    weight: 0,
    empty: rows.length === 0,
    emptyReason: rows.length === 0
      ? 'No technology names cleared the unusual-options thresholds this cycle (or the chain feed was unavailable).'
      : null,
  });
}

function explainState(state, r, setup) {
  switch (state) {
    case 'CONFIRMS_BULLISH_SETUP': return 'Delayed chain activity leans bullish and agrees with the independent long price setup. Confirmation only — it did not create the setup.';
    case 'CONFIRMS_BEARISH_SETUP': return 'Delayed chain activity leans bearish and agrees with the independent short price setup. Confirmation only.';
    case 'CONTRADICTS_SETUP': return 'Delayed chain activity leans against the independent price setup — treat the setup as lower quality until they agree.';
    case 'EVENT_POSITIONING': return `Earnings fall before the option expiry${r && r.earningsInDays != null ? ` (${r.earningsInDays} days)` : ''} — this is event positioning and hedging, which cannot be read directionally.`;
    case 'MIXED': return 'Two-sided activity — no defensible lean.';
    case 'TOO_ILLIQUID': return `Below the liquidity floor (${MIN_CONTRACTS} contracts / $${MIN_PREMIUM_USD / 1000}k premium) — not interpretable.`;
    case 'STALE': return 'The chain snapshot is older than the freshness window — shown as history, not a current read.';
    default: return setup && setup.valid
      ? 'Direction is not determinable from delayed data.'
      : 'No independent price setup to confirm — this is raw activity, not a confirmation.';
  }
}

module.exports = { OPTIONS_VERSION, STATES, MIN_CONTRACTS, MIN_PREMIUM_USD, STALE_HOURS, buildOptionsSection, explainState };
