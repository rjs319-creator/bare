'use strict';
// Market Pulse v2 — the REGIME STACK and CROSS-ASSET renderers, checked in the actual
// HTML the user sees. These lock the honesty rules at the render boundary, where a
// well-behaved backend can still be undone by a renderer that drops a caveat.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'pulse2-render.js')).href);

const rs = require('../lib/pulse2-regime-stack');
const ca = require('../lib/pulse2-cross-asset');

const bars = (n, start, drift = 0) => Array.from({ length: n }, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, close: start * (1 + (drift * i) / (n - 1)) }));

const marketState = {
  indexes: {
    SPY: { available: true, dayReturnPct: 0.9, aboveVWAP: true, rangeExpansion: 1.1 },
    QQQ: { available: true, dayReturnPct: 1.2, aboveVWAP: true },
    IWM: { available: true, dayReturnPct: -0.5, aboveVWAP: false },
    RSP: { available: true, dayReturnPct: 0.2, aboveVWAP: true },
  },
  breadth: { available: true, pctAbove50dma: 40 },
  participation: { equalVsCapPct: -0.7, smallVsLargePct: -1.4 },
  sectors: { available: true },
};

test('renderRegimeStack shows THREE separate layers and no combined regime score', async () => {
  const R = await load();
  const stack = rs.buildRegimeStack({ marketState, now: new Date('2026-08-13T18:00:00Z') });
  const html = R.renderRegimeStack(stack);
  assert.match(html, /Intraday/);
  assert.match(html, /Tactical \(1–4 weeks\)/);
  assert.match(html, /Strategic \(1–6 months\)/);
  assert.match(html, /no composite regime score/i, 'the renderer must carry the no-composite note');
  // No single combined regime VALUE is rendered anywhere — only the three layer states.
  assert.doesNotMatch(html, /Overall regime[:\s]*[A-Z]/, 'no combined regime verdict may be rendered');
  assert.doesNotMatch(html, /Regime score[:\s]*\d/, 'no numeric regime score may be rendered');
});

test('renderRegimeStack renders contradicting observations, not just supporting ones', async () => {
  const R = await load();
  const stack = rs.buildRegimeStack({ marketState, now: new Date('2026-08-13T18:00:00Z') });
  const html = R.renderRegimeStack(stack);
  assert.match(html, /Supporting/);
  assert.match(html, /Contradicting/);
  assert.match(html, /contested/i);
  assert.match(html, /Small caps/i, 'the lagging-small-caps contradiction must reach the DOM');
});

test('renderRegimeStack renders the falsifiable flip condition for each layer', async () => {
  const R = await load();
  const stack = rs.buildRegimeStack({ marketState, now: new Date('2026-08-13T18:00:00Z') });
  assert.match(R.renderRegimeStack(stack), /Would flip it:/);
});

test('an UNAVAILABLE layer renders its reason and the inputs it would need', async () => {
  const R = await load();
  const stack = rs.buildRegimeStack({ marketState, macroInputs: null, now: new Date('2026-08-13T18:00:00Z') });
  const html = R.regimeLayerRow(stack.layers.strategic);
  assert.match(html, /UNAVAILABLE/);
  assert.match(html, /NOT wired to a provider/i);
  assert.match(html, /Inputs it would need/i);
  assert.doesNotMatch(html, />neutral</i);
});

test('a missing regime stack renders an honest empty state, never a neutral regime', async () => {
  const R = await load();
  const html = R.renderRegimeStack(null);
  assert.match(html, /no market-state tick has persisted a regime stack yet/i);
  assert.doesNotMatch(html, /TRENDING|RISK_SEEKING|EXPANSION/);
});

test('a horizon conflict is rendered prominently', async () => {
  const R = await load();
  const stack = rs.buildRegimeStack({
    marketState,
    crossAsset: { rows: {
      credit: { available: true, changePct: -0.8, source: 'HYG vs LQD' },
      volCurve: { available: true, contango: false, slope: -2, source: '^VIX' },
      dollar: { available: true, changePct: 0.9, source: 'UUP' },
      rates2y: { available: true, changePct: 0.4, source: 'SHY' },
    } },
    now: new Date('2026-08-13T18:00:00Z'),
  });
  const html = R.renderRegimeStack(stack);
  assert.match(html, /Horizon conflict/i);
  assert.match(html, /fighting the tactical horizon/i);
});

test('renderCrossAsset names every PROXY and carries the proxy disclosure', async () => {
  const R = await load();
  const m = ca.buildCrossAssetMatrix({
    dailyByTicker: { SPY: bars(60, 500, 0.03), HYG: bars(60, 78, 0.02), LQD: bars(60, 110, 0.005), GLD: bars(60, 240, 0.05), UUP: bars(60, 28, 0.04) },
    equityChangePct: 0.8, lookback: 20,
  });
  const html = R.renderCrossAsset(m);
  assert.match(html, /HYG/);
  assert.match(html, /GLD/);
  assert.match(html, /ETF PROXIES/);
  assert.match(html, /Proxy<\/th>/);
});

test('renderCrossAsset exposes the confirmation DENOMINATOR, not just the ratio', async () => {
  const R = await load();
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { SPY: bars(60, 500, 0.03), HYG: bars(60, 78, 0.02), LQD: bars(60, 110, 0.005) }, equityChangePct: 0.8 });
  const html = R.renderCrossAsset(m);
  assert.match(html, /of \d+ MEASURED legs/);
  assert.match(html, /excluded from the ratio/);
});

test('renderCrossAsset lists contradicting legs rather than burying them', async () => {
  const R = await load();
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { SPY: bars(60, 500, 0.03), GLD: bars(60, 240, 0.06), UUP: bars(60, 28, 0.05) }, equityChangePct: 0.8, lookback: 20 });
  const html = R.renderCrossAsset(m);
  assert.match(html, /Contradicting:/);
  assert.match(html, /gold/i);
});

test('a total cross-asset failure renders DEGRADED, never "no cross-asset signal"', async () => {
  const R = await load();
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: {}, equityChangePct: 0.8 });
  const html = R.renderCrossAsset(m);
  assert.match(html, /DEGRADED data state/i);
  assert.match(html, /does NOT mean the cross-asset legs are quiet or in agreement/i);
  // A failed matrix must never render a confirmation count that reads as agreement.
  assert.doesNotMatch(html, /confirming/i);
});

test('renderShell mounts both new sections and stays a single HTML string', async () => {
  const R = await load();
  const stack = rs.buildRegimeStack({ marketState, now: new Date('2026-08-13T18:00:00Z') });
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { SPY: bars(60, 500, 0.03) }, equityChangePct: 0.8 });
  const html = R.renderShell({ payload: { regimeStack: stack, crossAsset: m, marketState }, novice: false });
  assert.equal(typeof html, 'string');
  assert.match(html, /Regime stack/);
  assert.match(html, /Cross-asset confirmation/);
});

test('renderShell degrades gracefully when the payload predates this release', async () => {
  const R = await load();
  const html = R.renderShell({ payload: { marketState }, novice: false });
  assert.match(html, /no market-state tick has persisted a regime stack yet/i);
  assert.match(html, /no cross-asset matrix has persisted yet/i);
});
