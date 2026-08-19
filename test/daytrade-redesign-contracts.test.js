'use strict';
// REDESIGN CONTRACTS (spec tests 8, 18, 19, 20, 21, 22, 23, 28, 29, 30, 31):
//   live plan uses the current validated quote · capture stores the LIVE plan · UI never
//   labels prior-session change as today · tiered costs replace the flat 10bp · episode
//   dedup in top-K · testEpisodes counts distinct episodes · session-clustered uncertainty
//   ≥ naive · board-tick health fails on persistence/alert failure · public reads cannot
//   mutate · scheduler board failure is visible · the full e2e chain through pure units.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('8. computeLivePlan prices the entry from the current VALIDATED quote, labeled; stale quote falls back to the completed close', () => {
  const { computeLivePlan } = require('../lib/daytrade-actionability');
  const now = '2026-07-08T14:31:00.000Z';
  const f = { dailyAtr: 1, last: 100, nowSinceOpen: 61, orComplete: true, openingRange: { high: 99.5, low: 98 }, completedAsOf: '2026-07-08T14:25:00.000Z' };
  const fresh = computeLivePlan(f, { now, quote: { price: 100.6, asOf: '2026-07-08T14:30:40.000Z' } });
  assert.equal(fresh.entry, 100.6, 'entry = validated quote, not the bar close');
  assert.equal(fresh.entryBasis, 'validated-quote');
  assert.equal(fresh.quoteAsOf, '2026-07-08T14:30:40.000Z');
  assert.equal(fresh.barAsOf, '2026-07-08T14:25:00.000Z');
  assert.ok(fresh.computedAt && fresh.expiresAt, 'plan carries calculation timestamps');
  const stale = computeLivePlan(f, { now, quote: { price: 100.6, asOf: '2026-07-08T14:10:00.000Z' } });
  assert.equal(stale.entry, 100, 'stale quote → last COMPLETED close, labeled');
  assert.equal(stale.entryBasis, 'completed-bar-close');
});

test('18. immutable capture stores the LIVE plan in force; the daily plan is separate provenance', () => {
  const { buildSnapshot } = require('../lib/lifecycle-capture');
  const record = {
    ticker: 'CAP', state: 'ACTIONABLE_NOW', updatedAt: '2026-07-08T14:35:00.000Z',
    history: [{ reasonCode: 'ACTIONABLE_CONFIRMED', at: '2026-07-08T14:35:00.000Z' }],
    activePlan: { basis: 'live-intraday', entry: 101.2, stop: 100.1, target: 103.4, rr: 2, trigger: 101, frozen: true, computedAt: '2026-07-08T14:30:00.000Z', expiresAt: '2026-07-08T16:30:00.000Z' },
    lastMetrics: { last: 101.3 },
  };
  const pick = { entry: 98, stop: 96, target: 104, rr: 2, orb: { trigger: 97.5, atr: 1 } };   // stale daily plan
  const snap = buildSnapshot({ record, ev: { session: 'regular' }, pick, at: '2026-07-08T14:35:00.000Z' });
  assert.equal(snap.plan.entry, 101.2, 'captured plan = the ACTIVE live plan in force');
  assert.equal(snap.plan.basis, 'live-intraday');
  assert.equal(snap.plan.frozen, true);
  assert.equal(snap.dailyPlan.entry, 98, 'daily plan preserved separately as provenance');
  assert.equal(snap.dailyPlan.trigger, 97.5);
  // Without a live plan, the snapshot's plan is honestly the daily detection basis.
  const noLive = buildSnapshot({ record: { ...record, activePlan: undefined }, ev: {}, pick, at: record.updatedAt });
  assert.equal(noLive.plan.basis, 'daily-detection');
});

test('19. the UI cannot label a prior-session percent change as "today" (source contract)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  // Every daychg number ships with a data-dt-chglabel sibling the live updater rewrites.
  assert.ok(src.includes('data-dt-chglabel'), 'change label node exists');
  assert.match(src, /dayChangePct != null \? 'today' : '\(prior session\)'/, 'bestCard labels stale change as prior-session until live data');
  assert.match(src, /labelEl\.textContent = 'today \(live\)'/, 'live overwrite fixes the label WITH the number');
  // The actionable card has a live price node for the 30s poller.
  const bestCard = src.slice(src.indexOf('const bestCard'), src.indexOf('const bestSubtitle'));
  assert.ok(bestCard.includes('data-dt-price'), 'actionable cards carry a live price node');
  assert.ok(bestCard.includes('wrong if'), 'actionable cards state what would make them wrong');
});

test('20. tiered/observed costs replace the flat 10bp assumption in labels', () => {
  const { computeLabels } = require('../lib/intraday-labels');
  const bar = (min, o, h, l, c, v = 1e5) => ({ t: new Date(Date.parse('2026-07-08T14:30:00Z') + min * 60000).toISOString(), o, h, l, c, v });
  const bars = [bar(0, 100, 100.5, 99.8, 100.2), bar(5, 100.2, 101.9, 100.1, 101.8), bar(10, 101.8, 102.4, 101.5, 102.2)];
  const mega = computeLabels({ decisionPrice: 100, decisionAt: '2026-07-08T14:30:00Z', atr: 1.5, sessionBars: bars, costContext: { avgDollarVol: 2e9, sessionBucket: 'midday' } });
  const micro = computeLabels({ decisionPrice: 100, decisionAt: '2026-07-08T14:30:00Z', atr: 1.5, sessionBars: bars, costContext: { avgDollarVol: 1e6, sessionBucket: 'open5' } });
  assert.ok(mega.costBps < micro.costBps, `a mega-cap costs less than a micro-cap (${mega.costBps} < ${micro.costBps})`);
  assert.equal(mega.costModel.version, 'intraday-cost-v1');
  assert.equal(mega.costModel.basis, 'modeled-tier', 'no observed spread → labeled MODELED');
  assert.ok(mega.costModel.scenarios.adverse === +(mega.costModel.roundTripBps * 2).toFixed(2), 'adverse = 2× base');
  // Unknown liquidity assumes the CONSERVATIVE tier, never the cheapest.
  const unknown = computeLabels({ decisionPrice: 100, decisionAt: '2026-07-08T14:30:00Z', atr: 1.5, sessionBars: bars });
  assert.ok(unknown.costBps >= micro.costBps * 0.5, 'unknown inputs cost like the conservative tier');
  // Policy label grades the EXECUTABLE entry (next bar open), not the signal price.
  assert.equal(mega.policyLabel.entryPrice, 100.2);
  assert.equal(mega.policyLabel.policyVersion, 'daytrade-policy-v1');
});

test('21/22. top-K dedupes by episode, and testEpisodes counts DISTINCT date×ticker (never raw rows)', () => {
  const { dedupeByEpisode } = require('../lib/survival-metrics');
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ date: '2026-07-08', ticker: 'ONE', utility: i / 100, id: `ONE|${i}` });
  rows.push({ date: '2026-07-08', ticker: 'TWO', utility: 0.2, id: 'TWO|0' });
  const deduped = dedupeByEpisode(rows, r => r.utility, r => `${r.date}|${r.ticker}`);
  assert.equal(deduped.length, 2, 'one slot per episode — 40 rows of ONE collapse to its best');
  assert.equal(deduped.find(r => r.ticker === 'ONE').utility, 0.39, 'best-scored row represents the episode');

  // evaluateDatasetSurvival: many 5-min rows per ticker must not inflate testEpisodes.
  const { evaluateDatasetSurvival } = require('../lib/intraday-training');
  const synth = [];
  for (let d = 0; d < 30; d++) {
    const date = `2026-06-${String(d + 1).padStart(2, '0')}`;
    for (let j = 0; j < 6; j++) {
      for (let rep = 0; rep < 4; rep++) {   // 4 rows per ticker/day
        const up = j % 2 === 0;
        synth.push({
          id: `T${j}|${date}|${rep}`, date, ticker: `T${j}`, at: `${date}T14:${30 + rep}:00Z`,
          sessionBucket: 'midday', atRisk: true, sampleProb: 1, weight: 1,
          features: { cusum: up ? 3 : 0.5, zShock: 1, dayPct: up ? 3 : 0.5, relVol: 2, logDollarVol: 8, mom15: null, momAccel: null, residual15: null, timeOfDayRelVol: null, volAccel: null, distFromHod: null, extensionAtr: null, remainingRR: null, intervalRetPct: 1, excessPct: 1, atrPct: 0.02, extensionDayAtr: 1 },
          outcome: up ? 'SUCCESS' : 'FAILURE', labelTarget: up ? 1 : 0, labelStop: up ? 0 : 1, labelHazard: up ? 1 : 0,
          netReturn: up ? 0.01 : -0.008, timeToBarrierMin: 30, atrFrac: 0.02, costFrac: 0.001, costFracAdverse: 0.002,
          policy: { filled: true, netReturn: up ? 0.012 : -0.01, netReturnAdverse: up ? 0.01 : -0.012 },
          provenance: 'prospective-live',
        });
      }
    }
  }
  const out = evaluateDatasetSurvival(synth, { wf: { nFolds: 3, minTrainDates: 20, embargoDays: 1 } });
  assert.equal(out.status, 'evaluated');
  assert.ok(out.testRows > out.testEpisodes, 'rows exceed episodes on multi-row tickers');
  const expectedEpisodes = new Set(synth.filter(r => out.testRows && r).map(r => `${r.date}|${r.ticker}`)).size;
  assert.ok(out.testEpisodes <= expectedEpisodes, 'testEpisodes are distinct date×ticker');
  assert.equal(out.testEpisodes * 4, out.testRows, '4 rows per episode collapse to 1 test episode each');
  // The policy block reports episode-level results and promotion consumes them.
  assert.ok(out.metrics.policy, 'policy-level metric block exists');
  assert.ok(out.promotion.checks.find(c => c.gate === 'prospectiveShadow'), 'shadow gate present');
  assert.equal(out.promotion.promote, false, 'no shadow evidence → cannot promote');
});

test('no-edge control: shuffled labels can NEVER promote (the gate fails closed on noise)', () => {
  const { evaluateDatasetSurvival } = require('../lib/intraday-training');
  // Same design as the episode test but labels are DECOUPLED from features via a
  // deterministic shuffle — a no-signal world. Every performance gate must fail.
  const rows = [];
  let s = 99; const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let d = 0; d < 30; d++) {
    const date = `2026-06-${String(d + 1).padStart(2, '0')}`;
    for (let j = 0; j < 8; j++) {
      const up = rand() < 0.4;   // label independent of features
      rows.push({
        id: `T${j}|${date}`, date, ticker: `T${j}`, at: `${date}T14:30:00Z`,
        sessionBucket: 'midday', atRisk: true, sampleProb: 1, weight: 1,
        features: { cusum: 1 + (j % 4), zShock: 1, dayPct: 1 + (j % 3), relVol: 2, logDollarVol: 8, mom15: null, momAccel: null, residual15: null, timeOfDayRelVol: null, volAccel: null, distFromHod: null, extensionAtr: null, remainingRR: null, intervalRetPct: 1, excessPct: 1, atrPct: 0.02, extensionDayAtr: 1 },
        outcome: up ? 'SUCCESS' : 'FAILURE', labelTarget: up ? 1 : 0, labelStop: up ? 0 : 1, labelHazard: null,
        netReturn: up ? 0.008 : -0.008, timeToBarrierMin: 30, atrFrac: 0.02, costFrac: 0.001, costFracAdverse: 0.002,
        policy: { filled: true, netReturn: up ? 0.008 : -0.01, netReturnAdverse: up ? 0.006 : -0.012 },
        provenance: 'prospective-live',
      });
    }
  }
  const out = evaluateDatasetSurvival(rows, {
    wf: { nFolds: 3, minTrainDates: 20, embargoDays: 1 },
    // Even granting a full shadow window and a logged single trial, noise must not pass.
    context: { joinLossRatio: 0, trials: 1, shadowDays: 10, shadowEpisodes: 100 },
  });
  if (out.status === 'evaluated') {
    assert.equal(out.promotion.promote, false, 'a no-signal dataset can never clear the promotion gate');
    assert.ok(out.promotion.failed.length >= 1, `failed gates: ${out.promotion.failed.join(', ')}`);
  } else {
    assert.equal(out.promotion.promote, false, 'insufficient data also fails closed');
  }
});

test('23. session-clustered uncertainty is ≥ naive row-iid uncertainty on correlated fixtures', () => {
  const { clusteredBootstrap } = require('../lib/survival-metrics');
  // 20 sessions × 30 rows; rows within a session share the session's common shock.
  const rows = [];
  let seed = 7;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let d = 0; d < 20; d++) {
    const shock = (rand() - 0.5) * 0.02;   // common within-session component
    for (let i = 0; i < 30; i++) rows.push({ date: `d${d}`, v: shock + (rand() - 0.5) * 0.002 });
  }
  const mean = sample => sample.reduce((s, r) => s + r.v, 0) / sample.length;
  const clustered = clusteredBootstrap(rows, mean, r => r.date, { B: 200, seed: 1 });
  const naive = clusteredBootstrap(rows, mean, (r, i) => rows.indexOf(r), { B: 200, seed: 1 });
  assert.ok(clustered.se != null && naive.se != null);
  assert.ok(clustered.se >= naive.se, `clustered SE (${clustered.se}) ≥ naive SE (${naive.se}) under within-session correlation`);
});

test('29. public reads cannot mutate lifecycle state (writer-authority contracts)', async () => {
  // api/tracker: the board tick + model governance ops are PRIVILEGED; op=daytrade is not a mutator.
  const tracker = fs.readFileSync(path.join(ROOT, 'api/tracker.js'), 'utf8');
  assert.match(tracker, /'daytradeboardtick'/, 'board tick is a privileged op');
  assert.match(tracker, /'modeltrain', 'modelpromote', 'modelchallenger', 'modelpromotelive', 'modelrollback'/, 'model governance ops are privileged');
  // screener-routes: alerts/persist/capture live ONLY under the mutate flag, and the public
  // route calls the computation with mutate:false.
  const sr = fs.readFileSync(path.join(ROOT, 'lib/screener-routes.js'), 'utf8');
  assert.match(sr, /computeDaytradeBoard\(\{ t0: Date\.now\(\), mutate: false, source: 'page' \}\)/, 'public op=daytrade is read-only');
  const mutBlock = sr.slice(sr.indexOf('MUTATION BLOCK'), sr.indexOf('POST-VALIDATION catalyst'));
  assert.ok(mutBlock.includes('if (mutate)'), 'mutation block is authority-gated');
  assert.ok(mutBlock.includes('emitDaytradeAlerts') && mutBlock.includes('saveLifecycleDay'), 'alerts + persistence live inside the gated block');
  // op=lifecycle is a read-only view (the old competing writer is gone).
  const lr = fs.readFileSync(path.join(ROOT, 'lib/lifecycle-routes.js'), 'utf8');
  const runLifecycleSrc = lr.slice(lr.indexOf('async function runLifecycle('), lr.indexOf('async function runLifecycleGrade('));
  assert.ok(!runLifecycleSrc.includes('saveLifecycleDay('), 'op=lifecycle no longer writes lifecycle state');
  assert.ok(runLifecycleSrc.includes('read-only-view'));
  // Functional: with no store, runLifecycle serves the read-only view without touching state.
  const { runLifecycle } = require('../lib/lifecycle-routes');
  let out = null;
  const res = { setHeader: () => {}, status: c => ({ json: p => { out = { code: c, ...p }; } }), json: p => { out = { code: 200, ...p }; } };
  await runLifecycle({ query: {} }, res);
  assert.equal(out.mode, 'read-only-view');
});

test('28/30. board-tick failure is VISIBLE: non-200 on persistence/alert failure, and the scheduler checks it', () => {
  const sr = fs.readFileSync(path.join(ROOT, 'lib/screener-routes.js'), 'utf8');
  const tickSrc = sr.slice(sr.indexOf('const BOARD_TICK_LEASE_KEY'), sr.indexOf('// op=daytradetick'));
  assert.ok(tickSrc.includes('failed ? 500 : 200'), 'a failed tick returns non-200');
  assert.ok(tickSrc.includes("tick.persisted !== true") && tickSrc.includes('alertError'), 'persistence and alert failures fail the tick');
  assert.ok(tickSrc.includes('boardtick-health'), 'a per-tick health record is written');
  // Scheduler: the board tick is authenticated, its failures are not swallowed.
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/daytrade-scan.yml'), 'utf8');
  // Anchored on the scan JOB rather than a step title: the scheduler now polls in a loop
  // and shares one authenticated `call` helper, so the per-step slice no longer exists.
  // The guarantees are unchanged and still asserted here.
  const scanJob = yml.slice(yml.indexOf('  scan:'), yml.indexOf('  postclose:'));
  assert.ok(scanJob.includes('op=daytradeboardtick'), 'scheduler drives the authenticated tick');
  assert.ok(scanJob.includes('Authorization: Bearer $CRON_SECRET'), 'tick is authenticated');
  assert.ok(!scanJob.includes('|| true'), 'failures are no longer swallowed');
  assert.ok(scanJob.includes('exit 1'), 'a failed iteration fails the workflow visibly');
  // A transient 5xx must not cost the rest of the polling window, so the loop continues —
  // but the failure is counted and surfaced, never dropped.
  assert.ok(/failures=\$\(\(failures\+1\)\)/.test(scanJob), 'iteration failures are counted');
  assert.ok(scanJob.includes('::error::'), 'each failure is annotated');
});

test('31. end-to-end: discovery evidence → Stage-2 features → lifecycle → alert → capture → strictly-after label', () => {
  const { buildIntradayFeatures } = require('../lib/intraday-features');
  const { stage2EvFor, LIFECYCLE_CFG } = require('../lib/daytrade-actionability');
  const { advanceLifecycle, STATES } = require('../lib/opportunity-lifecycle');
  const { buildAlert } = require('../lib/daytrade-alerts');
  const { buildSnapshot } = require('../lib/lifecycle-capture');
  const { computeLabels } = require('../lib/intraday-labels');

  // A full rising session (same fixture family as intraday-features.test.js).
  const bar = (etHHMM, o, h, l, c, v) => {
    const [H, M] = etHHMM.split(':').map(Number);
    return { t: `2026-07-08T${String(H + 4).padStart(2, '0')}:${String(M).padStart(2, '0')}:00.000Z`, o, h, l, c, v };
  };
  const session = [
    bar('09:30', 100, 100.6, 99.9, 100.4, 2000), bar('09:35', 100.4, 100.9, 100.2, 100.7, 2000),
    bar('09:40', 100.7, 101.0, 100.5, 100.8, 2000), bar('09:45', 100.8, 101.0, 100.6, 100.9, 2000),
    bar('09:50', 100.9, 101.0, 100.7, 100.95, 2000), bar('09:55', 100.95, 101.0, 100.8, 101.0, 2000),
    bar('10:00', 101.0, 101.6, 101.0, 101.5, 2200), bar('10:05', 101.5, 102.0, 101.4, 101.9, 2400),
    bar('10:10', 101.9, 102.3, 101.8, 102.2, 2400), bar('10:15', 102.2, 102.6, 102.1, 102.5, 2600),
    bar('10:20', 102.5, 102.9, 102.4, 102.8, 2600), bar('10:25', 102.8, 103.1, 102.7, 103.0, 2800),
    bar('10:30', 103.0, 103.2, 102.9, 103.0, 2800), bar('10:35', 103.0, 103.6, 102.9, 103.5, 3000),
    bar('10:40', 103.5, 104.2, 103.4, 104.0, 3200),
  ];
  const NOW = '2026-07-08T14:35:00.000Z';   // 10:35 ET — 10:30 bar just completed
  const prior = session.map(b => ({ ...b, v: b.v / 2, t: b.t.replace('2026-07-08', '2026-07-07') }));
  const spy = session.map(b => ({ ...b, o: 500, h: 500.2, l: 499.8, c: 500 }));

  // 1) Discovery evidence merged onto the pick (Stage-A found it).
  const pick = { ticker: 'E2E', candidateDate: '2026-07-08', discovery: { cusum: 5, z: 3, quoteAsOf: NOW } };
  // 2) Stage-2 features (completed bars) + evaluation.
  const f = buildIntradayFeatures({ todayBars: session, priorSessions: [prior], spyTodayBars: spy, now: NOW, dailyAtr: 1.5 });
  assert.equal(f.triggerConfirmed, true);
  const ev = stage2EvFor(pick, f, { now: NOW, quote: { price: 103.0, asOf: NOW } });
  assert.ok(ev.livePlan, 'a live plan was minted');
  // 3) Lifecycle: the evaluation drives ACTIONABLE_NOW under the production config.
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.ACTIONABLE_NOW);
  // 4) Alert: the transition emits a confirmed-trigger alert with the plan.
  const alert = buildAlert({ ticker: 'E2E', from: 'ARMED', to: rec.state, at: NOW, reasonCode: 'ACTIONABLE_CONFIRMED', setupId: rec.setupId, card: { livePlan: ev.livePlan, triggerConfirmed: true, aboveVwap: true } }, { now: NOW });
  assert.equal(alert.kind, 'entry');
  assert.match(alert.actionability, /signal gate/, 'alert claims the SIGNAL gate, not an execution gate');
  // 5) Capture: the snapshot stores the live plan in force.
  const withPlan = { ...rec, activePlan: { ...ev.livePlan, setupId: rec.setupId } };
  const snap = buildSnapshot({ record: withPlan, ev: { session: 'regular', ...ev }, pick, at: NOW });
  assert.equal(snap.plan.basis, 'live-intraday');
  assert.equal(snap.plan.entry, ev.livePlan.entry);
  // 6) Label: strictly-after bars only — the decision bar can never label itself.
  const label = computeLabels({ decisionPrice: snap.decisionPrice, decisionAt: NOW, atr: snap.atr ?? 1.5, sessionBars: session, costContext: { avgDollarVol: 5e7, sessionBucket: 'midday' } });
  assert.ok(label, 'label computed from forward bars');
  assert.equal(label.forwardBars, 1, 'only the strictly-after 10:40 bar labels the 10:35 decision');
  assert.equal(label.policyLabel.entryPrice, 103.5, 'policy label enters at the next bar open (executable), not the signal price');
});
