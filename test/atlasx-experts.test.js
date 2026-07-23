'use strict';
// ATLAS-X experts + router — isolated unit tests over synthetic inputs.
// Covers both lib/atlasx-experts.js and lib/atlasx-router.js. No network, no
// fixtures on disk; every input is hand-built so a failure localizes to logic.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessExperts, assessRedTapeReversal,
} = require('../lib/atlasx-experts');
const { routeExperts, shrinkHierarchy } = require('../lib/atlasx-router');
const { validateExpertAssessment, validateRouterAssessment, EXPERTS } = require('../lib/atlasx-contracts');
const cfg = require('../lib/atlasx-config');
const { VERSIONS } = cfg;

// ── synthetic builders ───────────────────────────────────────────────────────
function series(spec) {
  return spec.map((s, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: s.o == null ? s.c : s.o,
    high: s.h == null ? s.c : s.h,
    low: s.l == null ? s.c : s.l,
    close: s.c,
    volume: s.v == null ? 1e6 : s.v,
  }));
}

// A compression candidate: wide/noisy early history that contracts into a tight,
// quiet base at the end → low realized-vol percentile (coiled).
function coiledCandles(n = 150) {
  const spec = [];
  for (let i = 0; i < n; i++) {
    const late = i > n - 30;
    const wob = late ? 0.4 : 3;
    const c = 100 + Math.sin(i / 3) * (late ? 0.3 : 2.5);
    spec.push({ c, h: c + wob, l: c - wob, v: late ? 3e5 : 2e6 });
  }
  return series(spec);
}

// A flat SPY series (no meaningful day change) for the non-risk-off default.
function flatSpy(n = 30) {
  return series(Array.from({ length: n }, () => ({ c: 400 })));
}

// A red SPY tape: last bar down ~1.2% on the day.
function redSpy(n = 30) {
  const spec = Array.from({ length: n }, () => ({ c: 400 }));
  spec[n - 1] = { c: 400 * (1 - 0.012) };
  return series(spec);
}

// Transition artifact that screams "compression → expansion" and nothing else.
function compressionTransition() {
  return {
    version: VERSIONS.transition,
    asOf: '2026-05-01',
    scores: {
      compressionToExpansion: 0.9,
      breakoutAcceptance: 0.1, breakoutRejection: 0.05,
      firstPullback: 0.1, distributionOnset: 0.0, exhaustion: 0.0,
    },
    dominantTransition: 'compressionToExpansion',
    features: {
      compressionPct: 0.9, wasCompressed: true, expansionNow: true, volAccel: 0.7,
      ret5: 0.02, ret10: 0.03, ret20: 0.01, brokeOut: false,
      pullbackDepth: 0.2, higherLowFrac: 0.5, closeLocRecent: 0.6,
    },
  };
}

// Residual artifact with a small/neutral 20-session residual (not yet a leader).
function neutralResidual() {
  const h = (residual) => ({ raw: 0, spy: 0, sector: 0, expected: 0, residual, partial: false });
  return {
    version: VERSIONS.residual,
    asOf: '2026-05-01',
    coverage: { spy: true, sector: true, stockBars: 150 },
    beta: 1, vol: 0.01, residualAccel: 0.0, degenerate: false,
    byHorizon: { 1: h(0), 3: h(0), 5: h(0), 10: h(0), 20: h(0), 63: h(0) },
  };
}

// Build a fully-valid expert assessment for router-only tests.
function assessment(expert, { applicability, direction }) {
  return Object.freeze({
    expert,
    applicability,
    stage: 'test',
    contributions: {},
    entryIntent: { action: 'WAIT_BREAKOUT' },
    invalidation: { note: 'test' },
    target: { note: 'test' },
    uncertainty: 0.5,
    maturity: 'accruing',
    direction,
    version: VERSIONS.experts,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

test('compression candidate routes to compressionRelease (highest weight)', () => {
  // Arrange
  const candles = coiledCandles();
  const input = {
    candles, spy: flatSpy(), sector: flatSpy(),
    residual: neutralResidual(), transition: compressionTransition(), path: null,
    ctx: { regime: 'neutral', riskOff: false, catalyst: null, asOf: '2026-05-01' },
  };
  // Act
  const { assessments } = assessExperts(input);
  const router = routeExperts({ expertAssessments: assessments, ctx: input.ctx });
  // Assert
  assert.equal(router.selectedExpert, 'compressionRelease');
  for (const id of EXPERTS) {
    if (id === 'compressionRelease') continue;
    assert.ok(router.weights.compressionRelease > router.weights[id], `compressionRelease should beat ${id}`);
  }
});

test('redTapeReversal applicability is 0 when not risk-off, >0 only when risk-off', () => {
  const candles = coiledCandles();
  const off = assessRedTapeReversal({ candles, spy: redSpy(), ctx: { riskOff: false, regime: 'neutral' } });
  const on = assessRedTapeReversal({ candles, spy: redSpy(), ctx: { riskOff: true, regime: 'risk-off' } });

  assert.equal(off.applicability, 0);
  assert.ok(on.applicability > 0);
  // The config flag is what makes risk-off mandatory.
  assert.equal(cfg.PERMITTED.redTapeRequiresRiskOff, true);
});

test('opposite experts are not both high-weighted (no false confirmation)', () => {
  const bull = assessment('breakoutContinuation', { applicability: 0.85, direction: 'bullish' });
  const bear = assessment('redTapeReversal', { applicability: 0.8, direction: 'bearish' });

  const router = routeExperts({ expertAssessments: { breakoutContinuation: bull, redTapeReversal: bear }, ctx: {} });

  assert.equal(router.selectedExpert, 'breakoutContinuation');
  // The opposing expert is suppressed, never co-equal → not averaged into agreement.
  assert.ok(router.weights.redTapeReversal < router.weights.breakoutContinuation * 0.5);
});

test('small-n performance cell shrinks toward its parent estimate', () => {
  // parent (byRegimeSetup) settles near ~0.05; child cell has a big raw value but
  // tiny n, so its shrunk estimate must land BETWEEN the two, near the parent.
  const cells = {
    global: { n: 500, incrementalValue: 0.02 },
    byRegime: { n: 300, incrementalValue: 0.04 },
    byRegimeSetup: { n: 120, incrementalValue: 0.05 },
    byRegimeSetupLiq: { n: 3, incrementalValue: 0.40 },
  };
  const s = shrinkHierarchy(cells);
  const childRaw = 0.40;
  const parent = s.parent;

  assert.ok(parent != null);
  assert.ok(s.shrunk > Math.min(parent, childRaw), 'shrunk above the lower of {parent, child}');
  assert.ok(s.shrunk < Math.max(parent, childRaw), 'shrunk below the higher of {parent, child}');
  // With n=3 vs K, it should sit much closer to the parent than to the raw child.
  assert.ok(Math.abs(s.shrunk - parent) < Math.abs(s.shrunk - childRaw));
});

test('two correlated experts do not receive full duplicate credit', () => {
  const comp = assessment('compressionRelease', { applicability: 0.7, direction: 'bullish' });
  const brk = assessment('breakoutContinuation', { applicability: 0.7, direction: 'bullish' });

  const soloComp = routeExperts({ expertAssessments: { compressionRelease: comp }, ctx: {} });
  const soloBrk = routeExperts({ expertAssessments: { breakoutContinuation: brk }, ctx: {} });
  const both = routeExperts({ expertAssessments: { compressionRelease: comp, breakoutContinuation: brk }, ctx: {} });

  const standaloneSum = soloComp.weights.compressionRelease + soloBrk.weights.breakoutContinuation;
  const combinedSum = both.weights.compressionRelease + both.weights.breakoutContinuation;

  assert.ok(combinedSum < standaloneSum, `combined ${combinedSum} should be < standalone sum ${standaloneSum}`);
});

test('every assessment passes validateExpertAssessment; router passes validateRouterAssessment', () => {
  const candles = coiledCandles();
  const ctx = {
    regime: 'neutral', riskOff: true, sector: 'XLK', sectorEtf: 'XLK', liqTier: 'large',
    catalyst: { type: 'earnings', tsUnix: Date.parse('2026-04-28T00:00:00Z') / 1000, surprise: 0.6 },
    asOf: '2026-05-01',
  };
  const { assessments } = assessExperts({
    candles, spy: redSpy(), sector: flatSpy(),
    residual: neutralResidual(), transition: compressionTransition(), path: null, ctx,
  });

  for (const id of EXPERTS) {
    const res = validateExpertAssessment(assessments[id]);
    assert.ok(res.ok, `${id} invalid: ${res.errors.join('; ')}`);
    assert.equal(assessments[id].version, VERSIONS.experts);
  }

  const router = routeExperts({ expertAssessments: assessments, ctx });
  const rres = validateRouterAssessment(router);
  assert.ok(rres.ok, `router invalid: ${rres.errors.join('; ')}`);
  assert.equal(router.version, VERSIONS.router);
});

test('catalystDrift is unknown (not neutral) when no catalyst is supplied', () => {
  const { assessments } = assessExperts({
    candles: coiledCandles(), spy: flatSpy(), sector: flatSpy(),
    residual: neutralResidual(), transition: compressionTransition(), path: null,
    ctx: { regime: 'neutral', riskOff: false, catalyst: null, asOf: '2026-05-01' },
  });
  const cd = assessments.catalystDrift;
  assert.equal(cd.applicability, 0);
  assert.equal(cd.maturity, 'experimental');
  assert.match(String(cd.target.note), /unknown/i);
});

test('eventDislocation stays experimental and does not inherit Gap&Go evidence', () => {
  // Build candles with a fresh +8% gap at the last bar.
  const base = coiledCandles(140);
  const prev = base[base.length - 1].close;
  base.push(...series([{ o: prev * 1.08, c: prev * 1.08, h: prev * 1.09, l: prev * 1.07, v: 5e6 }]));
  const { assessments } = assessExperts({
    candles: base, spy: flatSpy(), sector: flatSpy(),
    residual: neutralResidual(), transition: compressionTransition(), path: null,
    ctx: { regime: 'neutral', riskOff: false, catalyst: null, asOf: '2026-05-01' },
  });
  const ed = assessments.eventDislocation;
  assert.equal(ed.maturity, 'experimental');
  assert.ok(ed.applicability > 0);
  assert.match(String(ed.target.note), /validated independently/i);
});
