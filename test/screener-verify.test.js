'use strict';
// SCREENER INTRADAY FILL-VERIFICATION CHANNEL (screener-verify-v1) — the sanctioned
// PROMOTION_CEILING exit path. These tests pin the honesty properties the channel
// exists to provide: a fill only exists when the published trigger demonstrably
// traded on real 5-minute bars, refusals and misses are recorded episodes (never
// silences), slippage is adverse, the entry session is strictly after the decision,
// and the Scoreboard reduction fails closed to byte-identical behavior with no data.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SV = require('../lib/screener-verify');
const EL = require('../lib/episode-ledger');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

// One synthetic regular session of 5-minute bars (09:30..15:55), flat at `px` unless
// overridden per-bar by mutate(t, bar).
function session(px = 100, mutate = null) {
  const bars = [];
  for (let m = 570; m < 960; m += 5) {
    const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const b = { t, open: px, high: px, low: px, close: px };
    if (mutate) mutate(t, b);
    bars.push(b);
  }
  return bars;
}

const PICK = { ticker: 'ABCD', date: '2026-08-10', ts: Date.parse('2026-08-10T21:30:00Z'), entry: 100, signalVersion: 'screener-v2' };
const SEL = { status: 'ok', entrySession: '2026-08-11' };

// ── resolveEntryFromBars — Arrange / Act / Assert ───────────────────────────

test('fills at the trigger when a bar HIGH touches it (stop-entry honesty)', () => {
  const bars = session(99, (t, b) => { if (t === '10:35') b.high = 100.4; });
  const r = SV.resolveEntryFromBars(bars, { trigger: 100 });
  assert.equal(r.status, 'filled');
  assert.equal(r.reason, 'stop-trigger');
  assert.equal(r.referencePrice, 100);
  assert.equal(r.at, '10:35');
});

test('a bar OPEN through the trigger fills at the WORSE open, never the trigger', () => {
  const bars = session(99, (t, b) => { if (t >= '11:00') { b.open = 101.2; b.high = 101.5; b.low = 100.9; b.close = 101; } });
  const r = SV.resolveEntryFromBars(bars, { trigger: 100 });
  assert.equal(r.status, 'filled');
  assert.equal(r.reason, 'gap-through-trigger');
  assert.equal(r.referencePrice, 101.2, 'conservative: worse of trigger and the crossing bar open');
});

test('an open beyond the chase ceiling is a GAP-SKIP — refused, never chased', () => {
  const bars = session(99, (t, b) => { if (t === '09:30') { b.open = 106; b.high = 107; b.low = 105; b.close = 106; } });
  const r = SV.resolveEntryFromBars(bars, { trigger: 100 });
  assert.equal(r.status, 'gap-skip');
  assert.equal(r.at, '09:30');
});

test('returns no-trigger when the published level never trades in the session', () => {
  const r = SV.resolveEntryFromBars(session(99), { trigger: 100 });
  assert.equal(r.status, 'no-trigger');
});

test('slippage is ADVERSE — the verified fill is worse than the observed print', () => {
  const bars = session(99, (t, b) => { if (t === '10:00') b.high = 100.5; });
  const r = SV.resolveEntryFromBars(bars, { trigger: 100, slippagePct: 0.002 });
  assert.equal(r.status, 'filled');
  assert.ok(r.fill > r.referencePrice, 'a long pays up');
  assert.equal(r.fill, +(100 * 1.002).toFixed(4));
});

test('a partial or late-starting session is insufficient-bars, never a false NO_FILL', () => {
  // A feed that starts at 10:00 could have missed an early trigger cross.
  const late = session(99).filter(b => b.t >= '10:00');
  assert.equal(SV.resolveEntryFromBars(late, { trigger: 100 }).status, 'insufficient-bars');
  const tiny = session(99).slice(0, 10);
  assert.equal(SV.resolveEntryFromBars(tiny, { trigger: 100 }).status, 'insufficient-bars');
  assert.equal(SV.resolveEntryFromBars(null, { trigger: 100 }).status, 'insufficient-bars');
});

test('a missing/invalid trigger is refused explicitly', () => {
  assert.equal(SV.resolveEntryFromBars(session(99), { trigger: null }).status, 'invalid-trigger');
  assert.equal(SV.resolveEntryFromBars(session(99), { trigger: -1 }).status, 'invalid-trigger');
});

// ── buildEpisode — canonical episodes with decision-time honesty ─────────────

test('a verified fill becomes a VALID canonical episode on a VERIFIED basis', () => {
  const entry = { status: 'filled', at: '10:05', referencePrice: 100, fill: 100.18, reason: 'stop-trigger', trigger: 100, slippagePct: 0.0018 };
  const ep = SV.buildEpisode(PICK, SEL, entry);
  assert.equal(ep.valid, true, `episode invalid: ${ep.errors.join('; ')}`);
  assert.equal(ep.fillStatus, EL.FILL_STATUS.FILLED);
  assert.ok(EL.VERIFIED_FILL_BASES.includes(ep.fillBasis));
  assert.equal(ep.fillVerified, true);
  assert.equal(ep.exitReason, EL.EXIT_REASON.OPEN, 'unresolved fill stays honestly open');
  assert.equal(ep.entryPrice, 100.18);
  assert.equal(ep.identity.strategyId, 'screener');
  assert.equal(ep.identity.policyTier, 'Early');
  assert.equal(ep.identity.scope, 'large');
  // Decision-time honesty: the entry is strictly after the decision, on the expected session.
  assert.ok(ep.actualEntryTs > ep.decisionTs);
  assert.equal(ep.actualEntryTs.slice(0, 10), ep.expectedEntrySession);
});

test('a session that never traded the trigger is an HONEST NO_FILL episode, not an absence', () => {
  const ep = SV.buildEpisode(PICK, SEL, { status: 'no-trigger', trigger: 100 });
  assert.equal(ep.fillStatus, EL.FILL_STATUS.NO_FILL);
  assert.equal(ep.attritionReason, EL.ATTRITION.NO_FILL);
  assert.equal(ep.fillVerified, false, 'a no-fill can never claim a verified fill');
  assert.equal(ep.entryPrice, null, 'no price is ever fabricated for an unfilled plan');
});

test('gap-skip and unavailable-bars are counted attrition, never imputed fills', () => {
  const skip = SV.buildEpisode(PICK, SEL, { status: 'gap-skip', trigger: 100 });
  assert.equal(skip.fillStatus, EL.FILL_STATUS.GAP_SKIP);
  assert.equal(skip.attritionReason, EL.ATTRITION.GAP_SKIP);
  const gone = SV.buildEpisode(PICK, { status: 'bars-unavailable' }, { status: 'bars-unavailable' });
  assert.equal(gone.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.equal(gone.attritionReason, EL.ATTRITION.TRUNCATED_HISTORY);
  const noSession = SV.buildEpisode(PICK, { status: 'entry-session-uncertain' }, null);
  assert.equal(noSession.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.equal(noSession.attritionReason, EL.ATTRITION.MISSING_ENTRY_SESSION);
});

test('resolution stamps the contract time exit and charges the EXIT leg net of the fill', () => {
  const entry = { status: 'filled', at: '10:05', referencePrice: 100, fill: 100.18, reason: 'stop-trigger', trigger: 100, slippagePct: 0.0018 };
  const ep = SV.buildEpisode(PICK, SEL, entry, { resolution: { exitPrice: 103, exitTs: '2026-08-18' } });
  assert.equal(ep.valid, true, `episode invalid: ${ep.errors.join('; ')}`);
  assert.equal(ep.exitReason, EL.EXIT_REASON.TIME);
  assert.equal(ep.exitPrice, 103);
  assert.ok(Number.isFinite(ep.grossReturnPct) && Number.isFinite(ep.netReturnPct));
  assert.ok(ep.netReturnPct < ep.grossReturnPct, 'the exit-side friction must be charged (entry side is inside the fill)');
  // One resolved episode is real evidence but must NOT verify the strategy (fails closed).
  assert.equal(EL.deriveFillVerified([ep]).fillVerified, false);
});

// ── timeExitFromDaily ────────────────────────────────────────────────────────

test('time exit is the close of the 5th session AFTER the entry session', () => {
  const candles = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19']
    .map((date, i) => ({ date, close: 100 + i }));
  const r = SV.timeExitFromDaily(candles, '2026-08-11');
  assert.deepEqual(r, { exitPrice: 105, exitTs: '2026-08-18' });
});

test('time exit is null (still open) until the horizon has actually elapsed', () => {
  const candles = ['2026-08-11', '2026-08-12', '2026-08-13'].map((date, i) => ({ date, close: 100 + i }));
  assert.equal(SV.timeExitFromDaily(candles, '2026-08-11'), null);
  assert.equal(SV.timeExitFromDaily(candles, '2026-08-10'), null, 'a missing entry bar never resolves against a guessed one');
  assert.equal(SV.timeExitFromDaily(null, '2026-08-11'), null);
});

// ── rollup projection + Scoreboard reduction ─────────────────────────────────

test('the rollup projection carries exactly what deriveFillVerified consumes', () => {
  const entry = { status: 'filled', at: '10:05', referencePrice: 100, fill: 100.18, reason: 'stop-trigger', trigger: 100, slippagePct: 0.0018 };
  const full = SV.buildEpisode(PICK, SEL, entry, { resolution: { exitPrice: 103, exitTs: '2026-08-18' } });
  const p = SV.projectEpisode(full);
  for (const k of ['fillStatus', 'fillBasis', 'fillVerified', 'exitReason']) assert.ok(k in p, `projection missing ${k}`);
  // The derivation over projections must agree with the derivation over full episodes.
  assert.deepEqual(EL.deriveFillVerified([p]), EL.deriveFillVerified([full]));
});

test('fillVerificationForSummary fails closed: no episodes ⇒ null ⇒ absent summary key', () => {
  assert.equal(SV.fillVerificationForSummary(null), null);
  assert.equal(SV.fillVerificationForSummary({ episodes: [] }), null);
});

test('fillVerificationForSummary reduces accrued episodes through deriveFillVerified', () => {
  const entry = { status: 'filled', at: '10:05', referencePrice: 100, fill: 100.18, reason: 'stop-trigger', trigger: 100, slippagePct: 0.0018 };
  const eps = [SV.projectEpisode(SV.buildEpisode(PICK, SEL, entry, { resolution: { exitPrice: 103, exitTs: '2026-08-18' } }))];
  const fv = SV.fillVerificationForSummary({ episodes: eps, updatedAt: '2026-08-19T00:00:00Z' });
  assert.ok(fv && fv.screener);
  assert.equal(fv.screener.fillVerified, false, 'one resolved episode must not verify (fails closed below the minimum)');
  assert.deepEqual({ fillVerified: fv.screener.fillVerified, resolved: fv.screener.resolved }, { fillVerified: false, resolved: 1 });
  assert.equal(fv.screener.channel, SV.SCREENER_VERIFY_VERSION);
  assert.equal(fv.screener.cohort, 'Early:large');
});

// ── cohort + contract pins ───────────────────────────────────────────────────

test('the verified cohort IS the registry-promoted policy cohort (Early:large), nothing wider', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'screener');
  assert.deepEqual([SV.COHORT.tier], entry.policyTiers, 'verifying a non-policy tier would verify a cohort the promoted claim does not cover');
  assert.deepEqual([SV.COHORT.scope], entry.policyScopes);
  assert.equal(SV.COHORT.section, 'screener');
});

test('the hold horizon is the contract promotion metric (5d), not an invented exit', () => {
  const SC = require('../lib/strategy-contracts');
  assert.equal(`${SV.HOLD_SESSIONS}d`, SC.CONTRACTS.screener.promotionMetric);
});
