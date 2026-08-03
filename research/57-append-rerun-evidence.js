'use strict';
// Step 57 — append the panel-v3.2 frozen-model rerun evidence for
// nonlinear-ml-panel (GBM vs Ridge) and pead-sue (time-series SUE), naming the
// records they supersede. Prior records stay immutable.
//
//   node research/57-append-rerun-evidence.js
//
// Numbers below are transcribed from the frozen reruns executed against
// panel-v3.2 (fully observed 21s cohorts only; cohort filter 48→47 dates):
//   PANEL_FILE=research/data/panel-features-v3.json \
//   COHORT_FILE=research/data/cohort-eligibility-v3.json \
//     research/intraday/.venv/bin/python research/28-mlrank.py
//   SUE_LABELS=v3 node --env-file=research/.env research/24-sue.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EL = require('../lib/research/evidence-log');

const DATA = path.join(__dirname, 'data');
const panel = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features-v3.json'), 'utf8'));
const ledger = JSON.parse(fs.readFileSync(path.join(DATA, 'cohort-eligibility-v3.json'), 'utf8'));
const datasetHash = `${panel.panelVersion}:${panel.datasetHash.slice(0, 16)}`;
let codeVersion = 'git:unknown';
try { codeVersion = `git:${execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()}`; } catch { /* recorded as unknown */ }
const dirty = (() => { try { return execSync('git status --porcelain', { cwd: __dirname }).toString().trim().length > 0; } catch { return true; } })();
if (dirty) codeVersion += '+dirty';
const mode = dirty ? 'exploratory' : 'confirmatory';

const deps = {
  readJSON: async (p, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p.replace(/^research\//, '')), 'utf8')); } catch { return dflt; } },
  writeJSON: async (p, obj) => {
    const f = path.join(DATA, p.replace(/^research\//, ''));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  },
};
const sha16 = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

async function main() {
  const last21 = ledger.byHorizon['21'].lastFullyObservedCohortDate;

  // ── nonlinear-ml-panel (GBM vs Ridge, frozen params, eligible cohorts) ─────
  {
    const prior = await EL.loadEvidence(deps, 'nonlinear-ml-panel');
    const metrics = {
      gbmMeanIC: -0.0026, ridgeMeanIC: -0.0203, deltaIC: 0.0177, deltaT: 4.25,
      pboProxy: 0.18, winPaths: 0.82,
      wfGbmSharpe: 0.04, wfGbmDSR: 0.22, dsrBar: 0.95,
      cohort: { eligibleDates: 47, excludedPartialDates: 1, ledgerHash: ledger.ledgerHash, latestEvaluatedDecisionDate: last21 },
      priorV31Comparison: { deltaIC: 0.0196, deltaT: 4.9, pboProxy: 0.11, wfGbmDSR: 0.16, wfGbmSharpe: -0.08 },
      supersedesRecordIds: prior.map((r) => r.recordId),
    };
    const rec = EL.makeEvidenceRecord({
      hypothesisId: 'nonlinear-ml-panel', datasetHash,
      periodStart: '2022-06', periodEnd: last21, horizon: '21d',
      codeVersion, manifestHash: sha16(metrics), metrics,
      verdict: 'not-confirmed', mode, generatedAt: new Date().toISOString(),
      note: `panel-v3.2 rerun, frozen params, FULLY OBSERVED 21s cohorts only (48→47 dates; the May-2026 3-delisting partial cohort excluded). CPCV GBM−Ridge delta +0.0177 t 4.25 PBO 18% — relative nonlinearity persists — but the pre-declared binding gate stays walk-forward DSR: 0.22 << 0.95 (WF Sharpe +0.04). No live ML. Supersedes ${prior.length} prior records (retained immutable).${dirty ? ' EXPLORATORY: dirty worktree.' : ''}`,
    });
    if (!rec.ok) throw new Error(rec.errors.join('; '));
    console.log('nonlinear-ml-panel:', (await EL.appendEvidence(deps, rec.record)).reason, rec.record.recordId);
  }

  // ── pead-sue (time-series SUE, frozen study, v3 labels) ────────────────────
  {
    const prior = await EL.loadEvidence(deps, 'pead-sue');
    const metrics = {
      pooledIC: 0.0041, monthlyMeanIC: 0.011, tStat: 1.56, decileSpread: 0.0009,
      compositeDelta: -0.0113, bar: 0.005,
      perYear: { 2021: 0.1173, 2022: -0.0157, 2023: 0.0159, 2024: -0.001, 2025: -0.0237 },
      niRobustnessIC: 0.0048,
      cohortCompliance: `grid ends 2025-09; every 63-session window closes well inside the fully observed 63s boundary ${ledger.byHorizon['63'].lastFullyObservedCohortDate}`,
      supersedesRecordIds: prior.map((r) => r.recordId),
    };
    const rec = EL.makeEvidenceRecord({
      hypothesisId: 'pead-sue',
      // The SUE study consumes the price cache + secmaster directly (its own
      // dataset scheme), re-verified after the v3.2 repairs.
      datasetHash: 'panel-cache+secmaster-v3:a7174511f547e2b0',
      periodStart: '2021-07', periodEnd: '2025-09', horizon: '63d',
      codeVersion, manifestHash: sha16(metrics), metrics,
      verdict: 'not-confirmed', mode, generatedAt: new Date().toISOString(),
      note: `Frozen SUE study reproduced byte-for-byte after the v3.2 repairs (repairs do not touch its inputs): pooled IC 0.0041 t 1.56, composite delta −0.0113 vs +0.005 bar. SUE remains NOT confirmed and hurts the composite. Supersedes ${prior.length} prior records (retained immutable).${dirty ? ' EXPLORATORY: dirty worktree.' : ''}`,
    });
    if (!rec.ok) throw new Error(rec.errors.join('; '));
    console.log('pead-sue:', (await EL.appendEvidence(deps, rec.record)).reason, rec.record.recordId);
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
