// Locks the ephemeral-edge-factory preregistration and the pure engine
// semantics — above all the MULTIPLICITY property: planted signal survives the
// 200-trial deflation, pure noise does not.
const test = require('node:test');
const assert = require('node:assert');
const REG = require('../lib/research/hypothesis-registry');
const E = require('../lib/ephemeral');

test('registered, valid, confirmatory, holdout sealed, frozen tokens present', () => {
  const h = REG.find('ephemeral-edge-factory');
  assert.ok(h, 'missing');
  assert.ok(REG.validateHypothesis(h).valid);
  assert.equal(h.mode, 'confirmatory');
  assert.equal(h.status, 'open');
  assert.match(h.stoppingRule, /2026-12-01/);
  assert.match(h.primaryMetric, /≥200 resolved/);
  assert.match(h.primaryMetric, /DATE-CLUSTERED/);
  const untouched = new Set(REG.untouchedHoldouts().map((x) => x.id));
  assert.ok(untouched.has('ephemeral-live-prospective'));
});

test('grammar: exactly 200 frozen cells, no same-feature contradictions', () => {
  const g = E.grammar();
  assert.equal(g.length, 200);
  for (const c of g) {
    const feats = c.conds.map((x) => x.k);
    assert.equal(new Set(feats).size, feats.length, `contradictory cell ${c.id}`);
  }
});

test('zScoreByDate: cross-sectional per-day frame, thin days fail closed', () => {
  const rows = [];
  for (let s = 0; s < 30; s++) rows.push({ sym: `T${s}`, date: '2026-08-01', f: { gap1: s, ret5: 0, relVol: 1, dist20: 0, rangePos: 0.5 }, z: {}, fwd: {} });
  rows.push({ sym: 'X', date: '2026-08-02', f: { gap1: 5, ret5: 0, relVol: 1, dist20: 0, rangePos: 0.5 }, z: {}, fwd: {} });
  E.zScoreByDate(rows);
  const day1 = rows.filter((r) => r.date === '2026-08-01');
  assert.ok(day1[29].z.gap1 > 1.5, 'extreme name must z-score high vs its own day');
  assert.equal(rows[30].z.gap1, null, 'a 1-name day cannot define a cross-section');
});

// Synthetic panel: 40 names × 120 days. Under `planted`, rows with gap1-z high
// get a POSITIVE forward excess (a real dislocation); otherwise labels are
// deterministic pseudo-noise. The factory must find the planted cell and must
// find NOTHING in pure noise — the whole multiplicity point.
function syntheticRows({ planted }) {
  const rows = [];
  const noise = (s, d, k) => (((s * 37 + d * 101 + k * 13) % 97) / 97 - 0.5);   // deterministic, mean ~0
  for (let d = 0; d < 120; d++) {
    const date = `2026-${String(1 + Math.floor(d / 28)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`;
    for (let s = 0; s < 40; s++) {
      const f = { gap1: noise(s, d, 1) * 4, ret5: noise(s, d, 2) * 10, relVol: 1 + noise(s, d, 3), dist20: noise(s, d, 4) * 6, rangePos: 0.5 + noise(s, d, 5) };
      rows.push({ sym: `T${s}`, date, f, z: {}, fwd: {} });
    }
  }
  E.zScoreByDate(rows);
  for (const r of rows) {
    const base = noise(r.sym.charCodeAt(1), r.date.charCodeAt(8), 7) * 2;       // ±1% pseudo-noise
    const boost = planted && r.z.gap1 != null && r.z.gap1 > E.Z_THRESHOLD ? 3.5 : 0;
    r.fwd = { 2: +(base + boost).toFixed(4), 5: +(base + boost).toFixed(4) };
  }
  return rows;
}

test('evaluateGrammar: a planted dislocation survives 200-trial deflation', () => {
  const { survivors, trials } = E.evaluateGrammar(syntheticRows({ planted: true }));
  assert.equal(trials, 200);
  assert.ok(survivors.length >= 1, 'planted edge must survive');
  assert.ok(survivors.some((c) => c.id.includes('gap1:hi') && c.dir === 1), `survivors must include the planted cell: ${survivors.map((c) => c.id).join(',')}`);
});

test('evaluateGrammar: pure noise produces ZERO survivors (the multiplicity guard)', () => {
  const { survivors } = E.evaluateGrammar(syntheticRows({ planted: false }));
  assert.equal(survivors.length, 0, `noise survivors: ${survivors.map((c) => `${c.id}@${c.dsr}`).join(',')}`);
});

test('currentFirings: one pick per symbol, capped with overflow recorded', () => {
  const rows = syntheticRows({ planted: true });
  const { survivors } = E.evaluateGrammar(rows);
  const latest = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const f = E.currentFirings(rows, survivors, latest);
  assert.ok(f.picks.length <= E.MAX_PICKS_PER_TICK);
  assert.equal(new Set(f.picks.map((p) => p.sym)).size, f.picks.length);
  assert.ok(typeof f.overflow === 'number');
});

test('resolvePick: next-open entry, SPY-excess, cost charged, direction signed', () => {
  const DAY = 86_400_000;
  const mk = (closes, opens) => closes.map((c, i) => ({ ms: i * DAY, date: `2026-08-${String(i + 1).padStart(2, '0')}`, open: opens[i], high: c, low: opens[i], close: c, volume: 1000 }));
  const bars = mk([100, 100, 104, 106, 108], [100, 100, 100, 104, 106]);
  const spy = mk([100, 100, 100, 100, 100], [100, 100, 100, 100, 100]);
  const pick = { sym: 'T', date: '2026-08-02', dir: 1, horizon: 2 };
  const r = E.resolvePick(pick, bars, spy);
  assert.equal(r.entryDate, '2026-08-03');
  // long: entry next open (08-03 @100) → +2 sessions close (08-05 @108):
  // (108/100 − 1)×100 − 0 SPY − 0.62 cost = 7.38
  assert.ok(Math.abs(r.netExcessPct - 7.38) < 1e-6, `${r.netExcessPct}`);
  const shortPick = { ...pick, dir: -1 };
  assert.ok(E.resolvePick(shortPick, bars, spy).netExcessPct < 0, 'short side must invert');
  assert.equal(E.resolvePick({ ...pick, date: '2026-08-04' }, bars, spy), null, 'unmatured stays open');
});
