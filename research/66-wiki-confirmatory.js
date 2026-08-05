'use strict';
// ── momentum-wiki-2014-2018 — the ONE-SHOT confirmatory evaluation ───────────
// Implements research/PREREGISTRATION-MOMENTUM-WIKI-2026-08.md §3 EXACTLY.
// Refusals (all fail closed, no ICs computed):
//   * registry entry missing/not-open, or holdout momentum-wiki-2014-2018-era
//     missing/already opened
//   * wiki-era panel missing, audit artifact missing, audit criticals > 0, or
//     audit datasetHash ≠ panel datasetHash
//   * an evidence record already exists (ONE evaluation ever)
// A successful run computes the six preregistered gates per horizon, writes ONE
// append-only evidence record, and prints the verdict. Opening the holdout in
// the registry is then a separate reviewed diff — irreversible.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REG = require('../lib/research/hypothesis-registry');
const COHORT = require('./lib/cohort');
const EX = require('../lib/research/execution');
const RUN58 = require('./58-momentum-horizons-confirmatory');
const pit = require('./lib/pit');

const HYP_ID = 'momentum-wiki-2014-2018';
const HOLDOUT_ID = 'momentum-wiki-2014-2018-era';
const DATA_DIR = process.env.WIKI_ERA_DATA_DIR || path.join(__dirname, 'data', 'wiki-era');
const PANEL_PATH = path.join(DATA_DIR, 'panel-features-v3.json');
const COHORT_PATH = path.join(DATA_DIR, 'cohort-eligibility-v3.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit-research-data.json');
const EVIDENCE_PATH = path.join(DATA_DIR, 'evidence-momentum-wiki-2014-2018.json');
const HORIZONS = [63, 126];
const MIN_NAMES_PER_DATE = 30;
const TOP_DECILE = 0.10;

// Deterministic LCG so the shuffled control is reproducible (no Math.random).
function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
function shuffled(arr, rnd) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const spearman = (xs, ys) => {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j + 2) / 2; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length, my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
};

// Per-date ICs for a view of the panel. view: rows filter (sensitivity).
function perDateICs(panel, eligibleDates, h, { excludeFlagged = false } = {}) {
  const byDate = new Map();
  for (const ym of Object.keys(panel)) {
    for (const r of panel[ym]) {
      if (!eligibleDates.has(r.dt)) continue;
      if (r.m121 == null || r[`f${h}`] == null) continue;
      if (excludeFlagged && r[`x${h}`]) continue;
      if (!byDate.has(r.dt)) byDate.set(r.dt, []);
      byDate.get(r.dt).push(r);
    }
  }
  const ics = [], dropped = [];
  for (const [dt, rows] of [...byDate.entries()].sort()) {
    if (rows.length < MIN_NAMES_PER_DATE) { dropped.push({ dt, n: rows.length }); continue; }
    const ic = spearman(rows.map((r) => r.m121), rows.map((r) => r[`f${h}`]));
    if (ic != null) ics.push({ dt, ic, n: rows.length });
  }
  return { ics, dropped, byDate };
}

// Shuffled control: permute the FEATURE within each date, keep labels in place.
function shuffledControl(byDate, h, rnd) {
  const ics = [];
  for (const [, rows] of [...byDate.entries()].sort()) {
    if (rows.length < MIN_NAMES_PER_DATE) continue;
    const feats = shuffled(rows.map((r) => r.m121), rnd);
    const ic = spearman(feats, rows.map((r) => r[`f${h}`]));
    if (ic != null) ics.push(ic);
  }
  return ics;
}

// Economic gate: exec-engine-v1 top-decile long by m121, next-open entry.
function costGate(panel, eligibleDates, h, datasetHash) {
  const cacheDir = path.join(DATA_DIR, 'cache');
  const barsMemo = new Map();
  const loadBars = (sym) => {
    if (barsMemo.has(sym)) return barsMemo.get(sym);
    let out = null;
    try { out = pit.priceSeries(JSON.parse(fs.readFileSync(path.join(cacheDir, `${sym}.json`), 'utf8')).price); } catch { out = null; }
    barsMemo.set(sym, out);
    return out;
  };
  const byDate = new Map();
  for (const ym of Object.keys(panel)) for (const r of panel[ym]) {
    if (!eligibleDates.has(r.dt) || r.m121 == null) continue;
    if (!byDate.has(r.dt)) byDate.set(r.dt, []);
    byDate.get(r.dt).push(r);
  }
  const fills = [];
  for (const [dt, rows] of [...byDate.entries()].sort()) {
    if (rows.length < MIN_NAMES_PER_DATE) continue;
    const ranked = [...rows].sort((a, b) => b.m121 - a.m121);
    const top = ranked.slice(0, Math.max(1, Math.floor(ranked.length * TOP_DECILE)));
    for (const r of top) {
      const bars = loadBars(r.cs || r.s);
      if (!bars) continue;
      const dMs = Date.parse(dt);
      let idx = -1; for (let k = 0; k < bars.length; k++) { if (bars[k].ms <= dMs) idx = k; else break; }
      if (idx < 0) continue;
      fills.push(EX.executableOutcome({ bars, decisionIdx: idx, horizonSessions: h, adv: r.adv }));
    }
  }
  const evidence = EX.buildCostEvidence({
    fills, strategyId: `momentum-wiki-m121-top-decile-long-${h}s`, datasetHash,
    horizonSessions: h, generatedAt: new Date().toISOString(),
  });
  const check = EX.verifyCostEvidence(evidence);
  const pass = !!(check.valid && Number.isFinite(evidence.net) && evidence.net > 0
    && Number.isFinite(evidence.doubledCostNet) && evidence.doubledCostNet > 0
    && Number.isFinite(evidence.stressedLiquidityNet) && evidence.stressedLiquidityNet > 0);
  return { pass, evidence, check };
}

function main() {
  // ── refusals ───────────────────────────────────────────────────────────────
  const hyp = REG.HYPOTHESES.find((h) => h.id === HYP_ID);
  if (!hyp) throw new Error(`registry entry ${HYP_ID} missing — preregistration is a prerequisite`);
  if (hyp.status !== 'open') throw new Error(`registry entry ${HYP_ID} status is '${hyp.status}' — a closed hypothesis is never re-run`);
  const holdout = REG.HOLDOUTS.find((h) => h.id === HOLDOUT_ID);
  if (!holdout) throw new Error(`holdout ${HOLDOUT_ID} missing from the registry`);
  if (holdout.openedAt) { console.log(`HOLDOUT_ALREADY_OPENED at ${holdout.openedAt} — no further evaluation is permitted, ever.`); return; }
  if (fs.existsSync(EVIDENCE_PATH)) { console.log(`EVIDENCE RECORD EXISTS (${EVIDENCE_PATH}) — one evaluation ever; the verdict stands.`); return; }
  if (!fs.existsSync(PANEL_PATH)) { console.log('REFUSED: wiki-era panel missing — run research/64-wiki-era-build.js (adapt, then build).'); return; }
  if (!fs.existsSync(AUDIT_PATH)) { console.log(`REFUSED: audit artifact missing — run RESEARCH_DATA_DIR=${path.relative(process.cwd(), DATA_DIR)} npm run audit:research first.`); return; }
  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  const criticals = audit.critical || [];
  if (criticals.length) { console.log(`REFUSED: audit has ${criticals.length} critical finding(s) — fix the panel first. No ICs computed.`); return; }
  const doc = JSON.parse(fs.readFileSync(PANEL_PATH, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(COHORT_PATH, 'utf8'));
  if (!audit.datasetHash || audit.datasetHash !== doc.datasetHash) { console.log('REFUSED: audit ran against a different datasetHash — re-run the audit on the current panel.'); return; }

  const trials = REG.familyTrials('swing-ranking');
  console.log(`momentum-wiki-2014-2018 one-shot evaluation — panel ${doc.datasetHash.slice(0, 16)}…, family trials (BH denominator) = ${trials}`);

  const rnd = lcg(20260804);
  const results = {};
  let allPass = true;
  for (const h of HORIZONS) {
    const elig = COHORT.eligibilityMapForHorizon(ledger, h);
    const inc = perDateICs(doc.panel, elig.eligibleDates, h, { excludeFlagged: false });
    const exc = perDateICs(doc.panel, elig.eligibleDates, h, { excludeFlagged: true });
    const controlVals = shuffledControl(inc.byDate, h, rnd);
    const controlMean = controlVals.length ? controlVals.reduce((a, b) => a + b, 0) / controlVals.length : null;
    const icVals = inc.ics.map((x) => x.ic);
    const gates = RUN58.confirmatoryGates(inc.ics, { control: controlMean, trials });
    const gatesExc = RUN58.confirmatoryGates(exc.ics, { control: controlMean, trials });
    const sensitivityPass = !!(gates.checks && gatesExc.checks
      && gates.checks.positiveHacT && gatesExc.checks.positiveHacT
      && gates.checks.qPassesFdr && gatesExc.checks.qPassesFdr);
    const cost = costGate(doc.panel, elig.eligibleDates, h, doc.datasetHash);
    const pass = !!(gates.checks && Object.values(gates.checks).every(Boolean)
      && sensitivityPass && cost.pass);
    allPass = allPass && pass;
    results[h] = {
      dates: inc.ics.length, droppedBelowFloor: inc.dropped.length,
      meanIC: icVals.length ? +(icVals.reduce((a, b) => a + b, 0) / icVals.length).toFixed(4) : null,
      gates, sensitivity: { includeAll: gates.checks, excludeFlagged: gatesExc.checks, pass: sensitivityPass },
      cost: { pass: cost.pass, net: cost.evidence.net, doubledCostNet: cost.evidence.doubledCostNet, stressedLiquidityNet: cost.evidence.stressedLiquidityNet, fills: cost.evidence.fills, noFills: cost.evidence.noFills, artifactHash: cost.evidence.artifactHash },
      pass,
    };
    console.log(`h=${h}: dates=${results[h].dates} meanIC=${results[h].meanIC} pass=${pass}`);
  }

  const verdict = allPass ? 'pass-provisional' : 'not-confirmed';
  const record = {
    schema: 'ConfirmatoryEvidenceRecord', hypothesisId: HYP_ID, holdoutId: HOLDOUT_ID,
    preregistration: 'research/PREREGISTRATION-MOMENTUM-WIKI-2026-08.md',
    datasetHash: doc.datasetHash, panelVersion: doc.panelVersion,
    survivorship: doc.manifest && doc.manifest.survivorship ? doc.manifest.survivorship.status : null,
    verdictCeiling: 'pass-provisional (survivorship-reduced) — NEVER promotion evidence',
    familyTrialsAtEvaluation: trials,
    minNamesPerDate: MIN_NAMES_PER_DATE,
    results, verdict,
    evaluatedAt: new Date().toISOString(),
  };
  record.recordHash = crypto.createHash('sha256').update(JSON.stringify({ ...record, recordHash: undefined })).digest('hex');
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(record, null, 2));
  console.log(`\nVERDICT: ${verdict}${verdict === 'pass-provisional' ? ' (survivorship-reduced — see ceiling)' : ''}`);
  console.log(`evidence record written: ${EVIDENCE_PATH} (${record.recordHash.slice(0, 16)}…)`);
  console.log(`NEXT (reviewed diff): open holdout ${HOLDOUT_ID} in lib/research/hypothesis-registry.js and set the registry entry status per deriveStatus.`);
}

module.exports = { HYP_ID, HOLDOUT_ID, HORIZONS, MIN_NAMES_PER_DATE, TOP_DECILE, DATA_DIR, EVIDENCE_PATH, perDateICs, shuffledControl, costGate, spearman, lcg };
if (require.main === module) main();
