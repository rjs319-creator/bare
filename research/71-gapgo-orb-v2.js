'use strict';
// EXPERIMENT B — GAP & GO v2 (next-session ORB), redesign Phase 11.
//
// THE HYPOTHESIS (frozen): an EOD gap-up decision, entered on the NEXT exchange session's
// 30-minute opening-range breakout, produces positive cost-net R in the TAKE cohort and
// beats the CONTROL cohort (the same rules with take:false), on both the full and the
// liquid universes, with honest no-fill / gap-through accounting.
//
// PRODUCTION PARITY. The trade is resolved by the SHIPPED resolver
// (lib/gapgo-verify.resolveOrbFromBars, gapgo-orb-verify-v2) — the same function the live
// channel uses. This runner supplies bars and cohorts; it does not re-implement the rules,
// so the study cannot drift from what the app actually grades.
//
// THE RULES IT INHERITS (from the shipped resolver, not restated as new policy):
//   • the opening range is the first 30 minutes of the ENTRY session;
//   • entry is a stop order at the OR high, filled at the trigger when touched;
//   • an open ABOVE the chase ceiling is a gap-skip (refused, never chased);
//   • an open through the trigger fills at the WORSE open;
//   • the stop is the OR low, the target is 2R, the time exit is the session close;
//   • when the fill bar also spans the stop, it resolves to the STOP (5-minute bars
//     cannot order ticks — the conservative reading).
//
// EXCHANGE-CALENDAR DISCIPLINE. The entry session is the EXACT next session from the
// market calendar. If that session's bars are missing, the episode is INVALID (counted as
// attrition) — a later session is NEVER substituted, which is the specific error the v1
// channel made in the other direction (it graded the decision session itself).
//
// DATA REALITY (checked at runtime, never assumed): the local 5-minute cache was collected
// per EVENT DAY, so it contains the gap session but not the following session. When the
// next-session bars are absent the run reports BLOCKED_DATA with full attrition and
// records that in the experiment registry. Nothing is imputed and no result is fabricated.
// Point `--barsDir` at a directory of `TICKER_YYYY-MM-DD.json` 5-minute files (ascending,
// regular session) to run it for real.
//
// Usage: node research/71-gapgo-orb-v2.js [--barsDir research/data/intra5] [--minGapPct 5]

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const GV = require('../lib/gapgo-verify');
const { calendarSessionsBetween } = require('../lib/swing-sessions');

const STUDY_ID = 'B-gapgo-orb-v2-2026-08';
const STUDY_VERSION = 'gapgo-orb-v2-study-v1';
const OUT_DIR = path.join(K.DATA_DIR, 'gapgo-orb-v2');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const BARS_DIR = args.barsDir ? path.resolve(args.barsDir) : path.join(K.DATA_DIR, 'intra5');
const MIN_GAP_PCT = Number.isFinite(+args.minGapPct) ? +args.minGapPct : 5;      // STRONG gap (TAKE)
const MODERATE_GAP_PCT = 3;                                                       // CONTROL cohort
const MIN_ADV = 1e7;
const LIQUID_ADV = 5e7;
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 4000);
const VARIATIONS_ATTEMPTED = 2;    // full universe and liquid subset — declared before the run

// 5-minute bars for one (ticker, session), in the shape the shipped resolver expects.
function loadBars(ticker, session) {
  const f = path.join(BARS_DIR, `${ticker}_${session}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (Array.isArray(raw) ? raw : [])
      .map(b => ({ t: String(b.date || b.t || '').slice(11, 16), open: +b.open, high: +b.high, low: +b.low, close: +b.close }))
      .filter(b => b.t && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close))
      .sort((a, b) => (a.t < b.t ? -1 : 1));
  } catch { return null; }
}

async function main() {
  const t0 = Date.now();
  console.log(`[${STUDY_ID}] loading daily universe…`);
  const { dataset, spy, spyIdx, attrition: uAttr } = K.loadUniverse({ minBars: 120, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  console.log(`  ${dataset.size} names; intraday bars dir: ${BARS_DIR} (${fs.existsSync(BARS_DIR) ? fs.readdirSync(BARS_DIR).length + ' files' : 'MISSING'})`);

  const attr = K.newAttrition();
  Object.assign(attr, { noNextSessionBars: 0, entrySessionUncertain: 0, noFill: 0, gapSkip: 0, insufficientBars: 0, invalidGeometry: 0 });

  // 1) Find every EOD gap-up decision on daily bars (the decision the app logs post-close).
  const decisions = [];
  for (const [t, v] of dataset) {
    const c = v.candles;
    for (let i = 1; i < c.length - 1; i++) {
      const prev = c[i - 1], cur = c[i];
      if (!(prev.close > 0) || !(cur.open > 0)) continue;
      const gapPct = (cur.open / prev.close - 1) * 100;
      if (gapPct < MODERATE_GAP_PCT) continue;
      const adv = K.advOf(c.slice(0, i + 1), 20);
      if (adv < MIN_ADV) continue;
      // The EXACT next exchange session from the calendar — never a later one.
      const next = c[i + 1];
      if (!next) { attr.truncatedHistory++; continue; }
      const sessionsApart = calendarSessionsBetween(cur.date, next.date);
      if (!(sessionsApart === 1)) { attr.entrySessionUncertain++; continue; }
      decisions.push({
        ticker: t, decisionSession: cur.date, entrySession: next.date,
        gapPct: +gapPct.toFixed(2), adv,
        take: gapPct >= MIN_GAP_PCT,          // TAKE cohort = the frozen STRONG rule
        liquid: adv >= LIQUID_ADV,
      });
    }
  }
  console.log(`  gap decisions: ${decisions.length} (TAKE ${decisions.filter(d => d.take).length} / CONTROL ${decisions.filter(d => !d.take).length})`);

  // 2) Resolve each on the NEXT session's intraday bars, through the SHIPPED resolver.
  const episodes = [];
  for (const d of decisions) {
    const bars = loadBars(d.ticker, d.entrySession);
    if (!bars || !bars.length) { attr.noNextSessionBars++; continue; }
    const cost = K.costFractions(d.adv);
    const r = GV.resolveOrbFromBars(bars, { costPct: cost.base * 100 });
    if (r.status === 'insufficient-bars') { attr.insufficientBars++; continue; }
    if (r.status === 'invalid-geometry') { attr.invalidGeometry++; continue; }
    if (r.status === 'no-trigger') { attr.noFill++; }
    if (r.status === 'gap-skip') { attr.gapSkip++; }
    episodes.push({ ...d, status: r.status, grossR: r.grossR ?? null, netR: r.netR ?? null, costPct: cost.base * 100, costTier: cost.tier });
  }

  const filled = episodes.filter(e => Number.isFinite(e.netR));
  console.log(`  resolved episodes ${episodes.length} (filled ${filled.length}); attrition ${JSON.stringify(attr)}`);

  // 3) Verdict. With no next-session bars there is nothing to conclude — say so.
  const blocked = filled.length < 30;
  const byCohort = (rows, label) => K.summarizeByDate(
    rows.map(e => ({ date: e.entrySession, value: e.netR })), { horizonBars: 1 }) && {
    label, n: rows.length,
    stats: K.summarizeByDate(rows.map(e => ({ date: e.entrySession, value: e.netR })), { horizonBars: 1 }),
  };
  const results = blocked ? null : {
    takeAll: byCohort(filled.filter(e => e.take), 'TAKE cohort, full universe — cost-net R'),
    controlAll: byCohort(filled.filter(e => !e.take), 'CONTROL cohort, full universe — cost-net R'),
    takeLiquid: byCohort(filled.filter(e => e.take && e.liquid), 'TAKE cohort, liquid subset — cost-net R'),
    controlLiquid: byCohort(filled.filter(e => !e.take && e.liquid), 'CONTROL cohort, liquid subset — cost-net R'),
  };
  const verdict = blocked
    ? 'BLOCKED_DATA — the exact next-session 5-minute bars required by the gapgo-orb-verify-v2 contract are not present locally; nothing is concluded and nothing is imputed'
    : (results.takeAll && results.takeAll.stats.ci95.lo > 0 ? 'TAKE cohort positive in-sample (still not promotable: prospective confirmation required)' : 'NOT CONFIRMED');

  const manifest = {
    studyId: STUDY_ID, version: STUDY_VERSION, kit: K.KIT_VERSION,
    resolver: { module: 'lib/gapgo-verify.resolveOrbFromBars', version: GV.GAPGO_VERIFY_VERSION || 'gapgo-orb-verify-v2', parity: 'the shipped resolver — no rules are re-implemented here' },
    frozenConfig: {
      takeRuleGapPct: MIN_GAP_PCT, controlRuleGapPct: MODERATE_GAP_PCT, minAdvUsd: MIN_ADV, liquidAdvUsd: LIQUID_ADV,
      entrySession: 'the EXACT next exchange session (calendarSessionsBetween === 1); a missing session is INVALID, never substituted',
      execution: 'stop-entry at the 30-min OR high; gap-through fills at the worse open; open beyond the chase ceiling is a gap-skip; OR-low stop; 2R target; session-close time exit; same-bar stop wins',
      costs: 'app cost model by ADV tier, charged in R', variationsAttempted: VARIATIONS_ATTEMPTED,
    },
    dataSnapshot: { barsDir: BARS_DIR, barFiles: fs.existsSync(BARS_DIR) ? fs.readdirSync(BARS_DIR).length : 0, dailyUniverse: dataset.size },
    universeAttrition: uAttr, episodeAttrition: attr,
    counts: { decisions: decisions.length, resolved: episodes.length, filled: filled.length, take: filled.filter(e => e.take).length, control: filled.filter(e => !e.take).length },
    evidenceInheritance: 'NONE — no gapgo v1 (same-day proxy) episode is used, pooled or referenced. v2 starts from zero by contract.',
    survivorshipProvenSafe: false,
    results, verdict,
    blockers: blocked ? [{
      id: 'INTRADAY_NEXT_SESSION_BARS_MISSING',
      detail: `The 5-minute cache is keyed by EVENT day, so the session AFTER each gap is absent (${attr.noNextSessionBars} decisions had no entry-session bars). The v2 contract can only be tested on the next session, so this must be collected prospectively (the live op=gapgoverify channel does exactly that) or backfilled from an intraday vendor.`,
      resolution: 'accrue the live verified ledger, or point --barsDir at a complete intraday archive',
    }] : [],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const art = K.writeArtifact(OUT_DIR, 'result.json', manifest);
  K.recordExperiment({
    id: STUDY_ID,
    hypothesis: 'An EOD gap-up decision entered on the NEXT session 30-minute ORB produces positive cost-net R in the TAKE cohort and beats the CONTROL cohort, with honest no-fill/gap-through accounting.',
    frozenConfig: manifest.frozenConfig, dataSnapshot: manifest.dataSnapshot, codeVersion: STUDY_VERSION,
    testDates: null, variationsAttempted: VARIATIONS_ATTEMPTED,
    result: results, correctedSignificance: null,
    costStress: null,
    decision: 'NOT PROMOTED',
    reason: verdict,
    artifact: art,
  });
  console.log(`\n[${STUDY_ID}] ${verdict}`);
  console.log(`  artifact: ${art.file}`);
  return manifest;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { STUDY_ID, STUDY_VERSION, main, loadBars };
