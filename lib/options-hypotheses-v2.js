'use strict';
// OPTIONS FALSE-POSITIVE HYPOTHESIS LEDGER.
//
// "Unusual options activity" has many BENIGN explanations that look identical on a delayed
// chain. The v2 engine already rejects some of them implicitly (spread footprints, hedge
// footprints). This module makes the whole set EXPLICIT and, crucially, makes each one
// carry a VERDICT with evidence:
//
//   SUPPORTED  — the data actively supports this benign explanation
//   UNRESOLVED — the data cannot rule it in or out (the honest default on delayed chains)
//   REFUTED    — the data actively rules it out
//
// The load-bearing design decision: UNRESOLVED is NOT "clear". An unrefuted benign
// explanation is preserved as dissent and reduces evidence strength. That is the opposite
// of the usual scanner behaviour, which quietly assumes every large print is a directional
// bet unless proven otherwise.
//
// Nothing here fabricates evidence: hypotheses that need data this source mode does not
// have (opening/closing, buyer/seller, linked legs) are marked NOT_TESTABLE with the
// capability that would be required.
//
// Pure; the scan time and all chain rows are injected.

const HYPOTHESES_VERSION = 'options-hypotheses-v2';

const VERDICT = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  UNRESOLVED: 'UNRESOLVED',
  REFUTED: 'REFUTED',
  NOT_TESTABLE: 'NOT_TESTABLE',
});

// Every benign explanation the mission enumerates, plus what each one needs to be decided.
const CATALOG = Object.freeze([
  { id: 'closing', statement: 'The activity CLOSED existing positions rather than opening new ones.', requires: 'trade-level open/close flags (OPRA) or next-session open-interest change' },
  { id: 'roll', statement: 'The activity ROLLED an existing position to a new strike or expiry.', requires: 'linked-order data, or paired near/far expiry volume with matching size' },
  { id: 'spread', statement: 'The prints are LEGS OF A SPREAD, not a directional position.', requires: 'complex-order (linked-leg) data; only a footprint is inferable from a chain' },
  { id: 'hedge', statement: 'The activity is a PORTFOLIO or INDEX HEDGE, not a view on this name.', requires: 'positioning data; only put-share and far-OTM concentration are inferable' },
  { id: 'overwrite', statement: 'The calls were WRITTEN against stock (a covered-call overwrite), not bought.', requires: 'aggressor side on a synchronized NBBO' },
  { id: 'eventVol', statement: 'The trade is an EVENT-VOLATILITY position around a scheduled catalyst, not a directional bet.', requires: 'an earnings/event calendar and the expiry relative to it' },
  { id: 'corpAction', statement: 'A DIVIDEND, SPLIT, or other corporate action mechanically drove the activity.', requires: 'a corporate-action calendar' },
  { id: 'staleQuote', statement: 'The prints are STALE, CROSSED, or otherwise UNUSABLE quotes.', requires: 'quote timestamps and a two-sided book' },
]);

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const isNum = v => v != null && Number.isFinite(v);

const mk = (id, verdict, evidence, extra = {}) => {
  const c = CATALOG.find(x => x.id === id);
  return { id, statement: c.statement, requires: c.requires, verdict, evidence: evidence || [], ...extra };
};

/**
 * Build the hypothesis ledger for one ticker's activity. Pure.
 *
 * @param {object} p
 * @param {Array}  p.contracts     retained contract rows ({ side, strike, volume, openInterest, bid, ask, lastPrice, lastTradeTs, expiry, dte, estNotional, underlying })
 * @param {object} p.capabilities  { hasOpenClose, hasAggressor, hasLinkedLegs } from the provider mode
 * @param {object} p.earnings      { nextDate, daysUntil }
 * @param {object} p.corpAction    { exDivDate, splitDate, daysUntil }
 * @param {boolean} p.isIndex
 * @param {number} p.nowMs
 * @param {object} p.oiChange      { [contractSymbol]: deltaOI } from the NEXT session, when known
 */
function buildHypotheses({
  contracts = [], capabilities = {}, earnings = null, corpAction = null,
  isIndex = false, nowMs = 0, oiChange = null,
} = {}) {
  const rows = contracts || [];
  const out = [];

  const totalNotional = rows.reduce((s, c) => s + (c.estNotional || 0), 0) || 0;
  const putNotional = rows.filter(c => c.side === 'put').reduce((s, c) => s + (c.estNotional || 0), 0);
  const putShare = totalNotional ? putNotional / totalNotional : null;

  // ── closing ──
  // Volume ≤ OI is CONSISTENT with closing; volume far above OI argues against it. The
  // decisive evidence is next-session OI change, which only exists after the fact.
  const volLeOi = rows.filter(c => isNum(c.volume) && isNum(c.openInterest) && c.openInterest > 0 && c.volume <= c.openInterest);
  const volGgOi = rows.filter(c => isNum(c.volume) && isNum(c.openInterest) && c.volume > Math.max(2 * c.openInterest, 1));
  if (oiChange && Object.keys(oiChange).length) {
    const rose = Object.values(oiChange).filter(v => isNum(v) && v > 0).length;
    const fell = Object.values(oiChange).filter(v => isNum(v) && v < 0).length;
    out.push(rose > fell
      ? mk('closing', VERDICT.REFUTED, [`open interest ROSE on ${rose} of ${rose + fell} tracked contracts the next session — new positions were opened`])
      : mk('closing', VERDICT.SUPPORTED, [`open interest FELL on ${fell} of ${rose + fell} tracked contracts the next session — consistent with closing`]));
  } else if (capabilities.hasOpenClose) {
    out.push(mk('closing', VERDICT.UNRESOLVED, ['provider reports open/close flags but none were attached to these rows']));
  } else if (volGgOi.length >= Math.max(1, rows.length * 0.5)) {
    out.push(mk('closing', VERDICT.UNRESOLVED, [
      `${volGgOi.length}/${rows.length} contracts traded well above standing open interest, which ARGUES AGAINST pure closing`,
      'but delayed chains carry no open/close flag, so closing cannot be ruled out today',
    ]));
  } else {
    out.push(mk('closing', VERDICT.UNRESOLVED, [
      volLeOi.length ? `${volLeOi.length}/${rows.length} contracts traded at or below standing open interest — fully consistent with closing` : 'no open-interest comparison available',
      'delayed chains carry no open/close flag',
    ]));
  }

  // ── roll ──
  // A roll shows up as similar size in a near expiry and a farther one on the same side.
  const byExpiry = new Map();
  for (const c of rows) {
    const k = `${c.side}|${c.expiry || '?'}`;
    byExpiry.set(k, (byExpiry.get(k) || 0) + (c.volume || 0));
  }
  const rollPairs = [];
  const entries = [...byExpiry.entries()];
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const [ka, va] = entries[a], [kb, vb] = entries[b];
      if (ka.split('|')[0] !== kb.split('|')[0]) continue;         // same side
      if (ka.split('|')[1] === kb.split('|')[1]) continue;         // different expiry
      if (!va || !vb) continue;
      const ratio = Math.min(va, vb) / Math.max(va, vb);
      if (ratio >= 0.7) rollPairs.push({ a: ka, b: kb, ratio: round(ratio) });
    }
  }
  out.push(capabilities.hasLinkedLegs
    ? mk('roll', VERDICT.UNRESOLVED, ['linked-order data is available but no linkage was attached to these rows'])
    : rollPairs.length
      ? mk('roll', VERDICT.SUPPORTED, [`${rollPairs.length} same-side expiry pair(s) show closely matched volume (ratio ≥0.7) — a roll footprint`], { pairs: rollPairs.slice(0, 3) })
      : mk('roll', VERDICT.UNRESOLVED, ['no matched near/far same-side volume pairs found, but a roll cannot be ruled out without linked-order data']));

  // ── spread ──
  const sameExpiryPairs = [];
  const byExp = new Map();
  for (const c of rows) {
    const k = c.expiry || '?';
    if (!byExp.has(k)) byExp.set(k, []);
    byExp.get(k).push(c);
  }
  for (const [exp, list] of byExp) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const va = list[a].volume || 0, vb = list[b].volume || 0;
        if (!va || !vb) continue;
        if (Math.min(va, vb) / Math.max(va, vb) >= 0.85) sameExpiryPairs.push({ expiry: exp, strikes: [list[a].strike, list[b].strike] });
      }
    }
  }
  out.push(capabilities.hasLinkedLegs
    ? mk('spread', VERDICT.UNRESOLVED, ['complex-order data is configured but no package was attached to these rows'])
    : sameExpiryPairs.length
      ? mk('spread', VERDICT.SUPPORTED, [`${sameExpiryPairs.length} same-expiry contract pair(s) share near-identical volume — a spread/multi-leg FOOTPRINT (not a confirmed spread)`], { pairs: sameExpiryPairs.slice(0, 3) })
      : mk('spread', VERDICT.UNRESOLVED, ['no matched same-expiry volume pairs, but without linked-leg data a spread cannot be ruled out']));

  // ── hedge ──
  const farOtmPutNotional = rows
    .filter(c => c.side === 'put' && isNum(c.strike) && isNum(c.underlying) && c.underlying > 0 && (c.underlying - c.strike) / c.underlying > 0.20)
    .reduce((s, c) => s + (c.estNotional || 0), 0);
  const farOtmPutShare = totalNotional ? farOtmPutNotional / totalNotional : null;
  if (isIndex && isNum(putShare) && putShare >= 0.6) {
    out.push(mk('hedge', VERDICT.SUPPORTED, [`index/ETF flow that is ${Math.round(putShare * 100)}% puts by notional is usually portfolio hedging`]));
  } else if (isNum(farOtmPutShare) && farOtmPutShare >= 0.4) {
    out.push(mk('hedge', VERDICT.SUPPORTED, [`${Math.round(farOtmPutShare * 100)}% of notional sits in puts more than 20% out of the money — a protective-hedge footprint`]));
  } else if (isNum(putShare) && putShare <= 0.15) {
    out.push(mk('hedge', VERDICT.REFUTED, [`only ${Math.round(putShare * 100)}% of notional is in puts — inconsistent with a protective hedge`]));
  } else {
    out.push(mk('hedge', VERDICT.UNRESOLVED, ['put share and strike placement are not decisive; positioning data would be required']));
  }

  // ── overwrite ── needs the aggressor side, which delayed chains do not have.
  out.push(capabilities.hasAggressor
    ? mk('overwrite', VERDICT.UNRESOLVED, ['aggressor data is available but was not attached to these rows'])
    : mk('overwrite', VERDICT.NOT_TESTABLE, ['delayed chains cannot establish whether calls were BOUGHT or WRITTEN — a covered-call overwrite is indistinguishable from a call purchase here']));

  // ── event volatility ──
  if (earnings && (isNum(earnings.daysUntil) || earnings.nextDate)) {
    const days = isNum(earnings.daysUntil) ? earnings.daysUntil : null;
    const expiriesAfterEvent = rows.filter(c => isNum(c.dte) && days != null && c.dte >= days).length;
    if (days != null && days <= 21 && expiriesAfterEvent >= Math.max(1, rows.length * 0.5)) {
      out.push(mk('eventVol', VERDICT.SUPPORTED, [`earnings/event in ${days}d and ${expiriesAfterEvent}/${rows.length} contracts expire AFTER it — an event-volatility position is at least as likely as a directional bet`], { daysUntilEvent: days }));
    } else if (days != null && days > 45) {
      out.push(mk('eventVol', VERDICT.REFUTED, [`next scheduled event is ${days}d away — too distant to explain this activity`], { daysUntilEvent: days }));
    } else {
      out.push(mk('eventVol', VERDICT.UNRESOLVED, [`next event in ${days != null ? days + 'd' : 'unknown'} — event positioning cannot be ruled in or out`]));
    }
  } else {
    out.push(mk('eventVol', VERDICT.UNRESOLVED, ['no earnings/event calendar evidence for this name — event positioning cannot be excluded']));
  }

  // ── corporate action ──
  if (corpAction && (corpAction.exDivDate || corpAction.splitDate)) {
    const d = isNum(corpAction.daysUntil) ? corpAction.daysUntil : null;
    out.push(d != null && d >= 0 && d <= 7
      ? mk('corpAction', VERDICT.SUPPORTED, [`a corporate action (${corpAction.exDivDate ? 'ex-dividend' : 'split'}) falls within ${d}d — dividend-capture and adjustment flow can fully explain unusual call volume`])
      : mk('corpAction', VERDICT.REFUTED, ['the nearest corporate action is outside the window that would mechanically drive this activity']));
  } else {
    out.push(mk('corpAction', VERDICT.UNRESOLVED, ['no corporate-action calendar is wired to this deployment — dividend/split-driven flow cannot be excluded']));
  }

  // ── stale / crossed / unusable quotes ──
  const bad = [];
  for (const c of rows) {
    if (c.bid == null || c.ask == null) { bad.push('missing two-sided quote'); continue; }
    if (c.ask <= c.bid) { bad.push('crossed or locked quote'); continue; }
    const mid = (c.bid + c.ask) / 2;
    if (mid > 0 && (c.ask - c.bid) / mid > 0.25) bad.push('spread wider than 25% of mid');
    if (c.lastTradeTs && nowMs) {
      const ts = c.lastTradeTs < 1e12 ? c.lastTradeTs * 1000 : c.lastTradeTs;
      if ((nowMs - ts) / 3_600_000 > 30) bad.push('last print older than 30h vs the snapshot');
    }
  }
  const badShare = rows.length ? bad.length / rows.length : 0;
  out.push(badShare >= 0.5
    ? mk('staleQuote', VERDICT.SUPPORTED, [`${bad.length} quality defects across ${rows.length} contracts (${[...new Set(bad)].join('; ')}) — the "activity" may be a data artifact`])
    : badShare > 0
      ? mk('staleQuote', VERDICT.UNRESOLVED, [`${bad.length} quality defect(s) across ${rows.length} contracts (${[...new Set(bad)].join('; ')})`])
      : mk('staleQuote', VERDICT.REFUTED, [`all ${rows.length} contracts carry fresh, two-sided, reasonably tight quotes`]));

  const supported = out.filter(h => h.verdict === VERDICT.SUPPORTED);
  const refuted = out.filter(h => h.verdict === VERDICT.REFUTED);
  const unresolved = out.filter(h => h.verdict === VERDICT.UNRESOLVED);
  const notTestable = out.filter(h => h.verdict === VERDICT.NOT_TESTABLE);

  return {
    version: HYPOTHESES_VERSION,
    hypotheses: out,
    counts: { supported: supported.length, refuted: refuted.length, unresolved: unresolved.length, notTestable: notTestable.length, total: out.length },
    supportedIds: supported.map(h => h.id),
    // Only actively REFUTED hypotheses count toward "we ruled it out". UNRESOLVED and
    // NOT_TESTABLE do not — that asymmetry is the whole point of the ledger.
    refutedFraction: round(refuted.length / out.length, 3),
    // The single sentence a card must show when benign explanations survive.
    caveat: supported.length
      ? `${supported.length} benign explanation(s) are actively SUPPORTED by the data (${supported.map(h => h.id).join(', ')}) — this activity should not be read as a directional bet.`
      : unresolved.length + notTestable.length > 0
        ? `${unresolved.length + notTestable.length} benign explanation(s) could not be ruled out on this data source. Unresolved is NOT clear.`
        : 'All catalogued benign explanations were actively refuted on this data.',
  };
}

/**
 * Evidence STRENGTH — the replacement for a numeric directional "confidence" that reads
 * like a probability. It is an ordinal band plus explicit component coverage.
 * Deliberately has no 0–100 scale and no percent sign.
 */
const STRENGTH = Object.freeze(['NONE', 'WEAK', 'MODERATE', 'STRONG']);

function evidenceStrength({ hypotheses = null, componentCoverage = null, directionState = null, independentPriceConfirmation = false, sourceMode = 'DELAYED_CHAIN' } = {}) {
  const reasons = [];
  const h = hypotheses;

  if (!h) {
    return { band: 'NONE', reasons: ['no false-positive hypothesis ledger was built — evidence strength cannot be assessed'], componentCoverage: componentCoverage ?? null, isProbability: false, scale: STRENGTH };
  }
  if (h.counts.supported > 0) {
    reasons.push(`${h.counts.supported} benign explanation(s) actively supported by the data`);
    return { band: 'NONE', reasons, componentCoverage, isProbability: false, scale: STRENGTH, note: h.caveat };
  }

  let idx = 1;   // WEAK is the floor once nothing benign is actively supported
  reasons.push('no benign explanation is actively supported by the data');

  if (h.refutedFraction >= 0.5) { idx++; reasons.push(`${Math.round(h.refutedFraction * 100)}% of catalogued benign explanations were actively REFUTED`); }
  else reasons.push(`only ${Math.round(h.refutedFraction * 100)}% of benign explanations could be actively refuted — the rest remain open`);

  if (isNumLocal(componentCoverage) && componentCoverage >= 0.8) { idx++; reasons.push(`anomaly component coverage ${Math.round(componentCoverage * 100)}%`); }
  else if (isNumLocal(componentCoverage)) reasons.push(`anomaly component coverage is only ${Math.round(componentCoverage * 100)}% — sparse-evidence score`);
  else reasons.push('anomaly component coverage unknown');

  if (independentPriceConfirmation) { idx++; reasons.push('an INDEPENDENT price trigger has been reached'); }
  else reasons.push('no independent price confirmation');

  if (sourceMode === 'DELAYED_CHAIN') {
    idx = Math.min(idx, 2);   // delayed chains cannot reach STRONG, whatever else lines up
    reasons.push('delayed chain source: buyer/seller and open/close are unobservable, so evidence strength is capped at MODERATE');
  }
  if (!directionState || directionState === 'UNKNOWN' || directionState === 'DIRECTION_UNKNOWN' || directionState === 'MIXED') {
    reasons.push('direction is UNKNOWN or MIXED — the strength below describes the ACTIVITY evidence, not a direction');
  }

  return {
    band: STRENGTH[Math.max(0, Math.min(idx, STRENGTH.length - 1))],
    reasons,
    componentCoverage: componentCoverage ?? null,
    isProbability: false,
    scale: STRENGTH,
    note: h.caveat,
  };
}

function isNumLocal(v) { return v != null && Number.isFinite(v); }

module.exports = { HYPOTHESES_VERSION, VERDICT, CATALOG, STRENGTH, buildHypotheses, evidenceStrength };
