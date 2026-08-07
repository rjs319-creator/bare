'use strict';
// Frontend renderers: honest empty/partial states, no colour-only status, keyboard-
// reachable controls, source watermarks, and no HTML injection from payload strings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'tech-command-render.js')).href);

test('the render module parses as an ES module and exports every section renderer', async () => {
  const R = await load();
  for (const fn of ['renderRegime', 'renderAlignment', 'renderDaytrade', 'renderSwing', 'renderLongTerm',
    'renderEvents', 'renderReadThrough', 'renderOptions', 'renderSentiment', 'renderRisk',
    'renderHealth', 'renderDossier', 'skeleton', 'actionPill', 'freshnessBadge', 'emptyState']) {
    assert.equal(typeof R[fn], 'function', `${fn} must be exported`);
  }
});

test('a missing section renders an explicit reason, never a blank', async () => {
  const R = await load();
  assert.match(R.renderRegime(null), /regime unavailable/i);
  assert.match(R.renderDaytrade(null, {}), /unavailable/i);
  assert.match(R.renderSwing(null, {}), /unavailable/i);
  assert.match(R.renderLongTerm(null, {}), /unavailable/i);
  assert.match(R.renderEvents(null, {}, {}), /unavailable/i);
});

test('honest empty states say picks are never forced', async () => {
  const R = await load();
  const swing = R.renderSwing({ featured: [], rows: [], empty: true, emptyReason: 'No technology swing setups currently clear the execution and evidence gates. Picks are never forced.' }, {});
  assert.match(swing, /never forced/);
  const lt = R.renderLongTerm({ featured: [], rows: [], empty: true, emptyReason: 'No technology names currently offer an attractive enough expectations/risk balance.', unavailableFactors: [] }, {});
  assert.match(lt, /attractive enough/);
});

test('status is never communicated by colour alone — pills carry a glyph and a word', async () => {
  const R = await load();
  for (const a of ['TRIGGERED', 'ENTER', 'ACCUMULATE', 'READY', 'AVOID', 'EXIT_INVALIDATE', 'INSUFFICIENT_DATA']) {
    const html = R.actionPill(a);
    assert.match(html, /aria-label="Action: /, `${a} needs an accessible label`);
    assert.match(html, /role="status"/);
    // A visible word, not only a colour.
    assert.ok(/>\s*[A-Za-z]/.test(html.replace(/<span aria-hidden="true">[^<]*<\/span>/, '')), `${a} must render a word`);
  }
});

test('freshness badges carry the state name and the timestamp, not just a colour', async () => {
  const R = await load();
  const html = R.freshnessBadge('stale', '2026-08-01T12:00:00Z');
  assert.match(html, /Stale/);
  assert.match(html, /2026-08-01/);
  assert.match(R.freshnessBadge('unavailable', null), /Unavailable/);
});

test('ticker affordances are real <button>s (keyboard reachable), not clickable spans', async () => {
  const R = await load();
  const board = R.renderDaytrade({
    rows: [{ ticker: 'AAAA', company: 'A Inc', subsectorLabel: 'Semiconductors', action: 'TRIGGERED', lifecycleState: 'ACTIONABLE_NOW', price: 100 }],
    sourceEngine: 'daytrade-early-runner-v2 (frozen)', sourceGeneratedAt: '2026-08-05T14:00:00Z', transitions: [],
  }, { expertMode: false });
  assert.match(board, /<button class="tc-ticker-btn[^"]*" data-ticker="AAAA"/);
  assert.ok(!/<span[^>]*data-ticker=/.test(board), 'a clickable span is not keyboard reachable');
});

test('the day-trade card states that technology annotations do not modify the decision', async () => {
  const R = await load();
  const board = R.renderDaytrade({
    rows: [{
      ticker: 'AAAA', action: 'TRIGGERED', lifecycleState: 'ACTIONABLE_NOW',
      techAnnotations: { rsVsQqqPct: 5, rsVsSubsectorPct: 2, subsectorBenchmark: 'SMH', note: 'Annotation only — these numbers are displayed beside the frozen Day Trade decision and do not modify it.' },
    }],
    sourceGeneratedAt: '2026-08-05T14:00:00Z', transitions: [],
  }, {});
  assert.match(board, /do not modify it/);
});

test('the options section always shows what the delayed data cannot tell you', async () => {
  const R = await load();
  const html = R.renderOptions({
    rows: [], empty: true, emptyReason: 'none',
    liveOrderFlowNote: 'No real-time licensed options feed is configured. This page does not have institutional options order flow and does not claim to.',
    delayedByMin: 15,
  });
  assert.match(html, /buyer vs seller/i);
  assert.match(html, /cannot originate a recommendation/i);
  assert.match(html, /does not have institutional options order flow/i);
});

test('the social section states that a missing mention is not a zero mention', async () => {
  const R = await load();
  const html = R.renderSentiment({ rows: [], empty: true, emptyReason: 'none', windowDays: 14, trustNote: null });
  assert.match(html, /no observation/i);
  assert.match(html, /not zero mentions/i);
  assert.match(html, /Attention, NOT sentiment/);
});

test('the health section always ships the evidence ladder and the probability policy', async () => {
  const R = await load();
  const html = R.renderHealth({
    generatedAt: '2026-08-05T14:00:00Z', servedFrom: 'persisted-snapshot',
    dataHealth: { sources: { daytrade: { state: 'fresh', asOf: '2026-08-05T14:00:00Z', note: 'x' } }, unavailable: [] },
    disclosures: {
      evidenceLadder: [{ level: 'heuristic', meaning: 'a documented rule', applies: ['long-term board'] }],
      probabilityPolicy: 'A number is labeled a probability only with a calibration artifact.',
      noAlphaClaim: 'Nothing on this page is a claim of new predictive edge.',
    },
    warnings: [],
  });
  assert.match(html, /Evidence ladder/);
  assert.match(html, /calibration artifact/);
  assert.match(html, /claim of new predictive edge/);
  assert.match(html, /persisted-snapshot/);
});

test('payload strings are escaped — a hostile company name cannot inject markup', async () => {
  const R = await load();
  const board = R.renderDaytrade({
    rows: [{ ticker: 'AAAA', company: '<img src=x onerror="alert(1)">', action: 'WATCH', lifecycleState: 'WATCHING' }],
    sourceGeneratedAt: '2026-08-05T14:00:00Z', transitions: [],
  }, {});
  assert.ok(!board.includes('<img src=x'), 'unescaped markup reached the DOM string');
  assert.ok(board.includes('&lt;img'));
});

test('the skeleton announces itself to assistive technology', async () => {
  const R = await load();
  const s = R.skeleton();
  assert.match(s, /aria-busy="true"/);
  assert.match(s, /aria-live="polite"/);
});

test('the dossier surfaces contradictions and closes accessibly', async () => {
  const R = await load();
  const html = R.renderDossier({
    found: true, ticker: 'AAAA', company: 'A Inc', subsectorLabel: 'Semiconductors', conclusion: 'x',
    contradictions: ['Long-term constructive but the swing setup is below its invalidation.'],
    intraday: { action: 'AVOID' }, swing: { action: 'EXIT_INVALIDATE' }, longterm: { action: 'ACCUMULATE' },
    whyItMattersNow: ['because'], relativeStrength: {}, dataTimestamps: {}, evidenceMaturity: {},
    invalidationConditions: [], stateTransitions: [], supportingEvidence: [], contradictingEvidence: [],
    probabilityNote: 'No calibrated probability exists for any horizon on this page.',
  });
  assert.match(html, /Contradictions/);
  assert.match(html, /below its invalidation/);
  assert.match(html, /aria-label="Close dossier"/);
  assert.match(html, /role="region"/);
});
