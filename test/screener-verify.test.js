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

// ── FINDING 5 — a no-trigger verdict is only provable on a COMPLETE session ──
// A partial (in-progress or truncated) entry session used to mint an immutable false
// NO_FILL: the completeness guard checked bar count + session START but never the END.

test('morning-only bars can never claim no-trigger: incomplete-session, not a false NO_FILL', () => {
  // 42 bars starting at 09:30 — passes the old count+start guard, ends at 12:55.
  const morning = session(99).filter(b => b.t < '13:00');
  const r = SV.resolveEntryFromBars(morning, { trigger: 100, sessionDate: '2026-08-11' });
  assert.equal(r.status, 'incomplete-session');
});

test('a full session (bars through 15:55) still resolves an honest no-trigger', () => {
  const r = SV.resolveEntryFromBars(session(99), { trigger: 100, sessionDate: '2026-08-11' });
  assert.equal(r.status, 'no-trigger');
});

test('a 13:00 early-close session is complete at its own final bar (12:55)', () => {
  const early = session(99).filter(b => b.t < '13:00');
  // 2026-11-27 is in market-session EARLY_CLOSES; the same bars on a normal date stay unprovable.
  assert.equal(SV.resolveEntryFromBars(early, { trigger: 100, sessionDate: '2026-11-27' }).status, 'no-trigger');
  assert.equal(SV.resolveEntryFromBars(early, { trigger: 100, sessionDate: '2026-11-30' }).status, 'incomplete-session');
});

test('a fill observed in a truncated session is still a fill (only the exhaustive claim needs completeness)', () => {
  const morning = session(99, (t, b) => { if (t === '10:35') b.high = 100.4; }).filter(b => b.t < '13:00');
  const r = SV.resolveEntryFromBars(morning, { trigger: 100, sessionDate: '2026-08-11' });
  assert.equal(r.status, 'filled');
});

test('incomplete-session builds an INVALID_DATA episode, never a NO_FILL', () => {
  const ep = SV.buildEpisode(PICK, SEL, { status: 'incomplete-session', trigger: 100 });
  assert.equal(ep.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.equal(ep.attritionReason, EL.ATTRITION.TRUNCATED_HISTORY);
});

test('isEtSessionComplete is DST-correct ET wall-clock: close + settle (omega-ab precedent)', () => {
  // 2026-08-12 is EDT (UTC-4): 19:58Z = 15:58 ET — the final bar is still forming.
  assert.equal(SV.isEtSessionComplete('2026-08-12', new Date('2026-08-12T19:58:00Z')), false);
  // 20:05Z = 16:05 ET — complete.
  assert.equal(SV.isEtSessionComplete('2026-08-12', new Date('2026-08-12T20:05:00Z')), true);
  // A prior session is complete by definition; a future one never is.
  assert.equal(SV.isEtSessionComplete('2026-08-11', new Date('2026-08-12T12:00:00Z')), true);
  assert.equal(SV.isEtSessionComplete('2026-08-13', new Date('2026-08-12T23:59:00Z')), false);
  assert.equal(SV.isEtSessionComplete(null, new Date()), false);
});

// ── FINDING 6 — the entry session must be verified against a trading calendar ─
// The ticker's own feed cannot tell a weekend from a one-day provider hole; a hole
// silently grades the buy-stop against the WRONG session, immutably.

test('weekend gap is accepted: no calendar sessions between a Friday signal and Monday entry', () => {
  const cal = ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11'];
  assert.deepEqual(SV.entrySessionCalendarHoles(cal, '2026-08-07', '2026-08-10'), []);
});

test('a one-day provider hole is detected: the calendar traded between signal and candidate entry', () => {
  const cal = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
  assert.deepEqual(SV.entrySessionCalendarHoles(cal, '2026-08-11', '2026-08-13'), ['2026-08-12']);
});

// ── op=swingverify integration battery (stubbed store + feeds; no network) ───
// Episodes are WRITE-ONCE: these tests pin that nothing questionable is ever written.

process.env.BLOB_READ_WRITE_TOKEN = 'test-token'; // hasStore() reads the env per call

// Stub @vercel/blob's list() for the rollup rebuild. CI runs dependency-free (no npm
// install) — when the module cannot resolve, the op's guarded require fails and the
// rebuild is skipped; none of the assertions below depend on the rebuilt rollup.
try {
  const blobId = require.resolve('@vercel/blob');
  require.cache[blobId] = {
    id: blobId, filename: blobId, loaded: true,
    exports: { list: async () => ({ blobs: [], cursor: undefined }) },
  };
} catch { /* dependency-free CI */ }

const S = require('../lib/store');
const clone = (x) => JSON.parse(JSON.stringify(x));
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const ROW = () => ({ ticker: 'ABCD', section: 'screener', tier: 'Early', scope: 'large', entry: 100 });
const spyCal = (ds) => ds.map((date, i) => ({ date, close: 100 + i }));
const FILLED_ENTRY = { status: 'filled', at: '10:05', referencePrice: 100, fill: 100.18, reason: 'stop-trigger', trigger: 100, slippagePct: 0.0018 };

function opHarness({ docs = {}, bars = {}, daily = {} } = {}) {
  const writes = {};
  S.readJSON = async (key, dflt) => {
    if (key in writes) return clone(writes[key]);
    return key in docs ? clone(docs[key]) : dflt;
  };
  S.writeJSON = async (key, doc) => { writes[key] = clone(doc); return { persisted: true }; };
  const deps = {
    fetch5min: async (ticker) => (ticker in bars ? clone(bars[ticker]) : null),
    fetchDaily: async (ticker) => (ticker in daily ? { candles: clone(daily[ticker]) } : null),
  };
  const res = { headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, json(x) { this.body = x; return x; } };
  return { writes, deps, res };
}

test('op: a partial entry session DEFERS — no immutable episode is written (Finding 5)', async () => {
  // Manual bearer run at 14:00 ET while the 2026-08-12 entry session is in progress:
  // FMP has only morning bars, the level has not traded YET. Old behavior: false NO_FILL.
  const { writes, deps, res } = opHarness({
    docs: { 'picks/2026-08-11.json': { picks: [ROW()] } },
    bars: { ABCD: { '2026-08-12': session(99).filter(b => b.t < '13:00') } },
    daily: { SPY: spyCal(['2026-08-10', '2026-08-11', '2026-08-12']) },
  });
  await SV.runScreenerVerify({}, res, { ...deps, now: '2026-08-12T18:00:00Z' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.gradedNow, 0);
  assert.ok(res.body.deferred >= 1, 'the pick is young — retried on a later run');
  assert.equal('episodes/screener/2026-08-11.json' in writes, false, 'nothing immutable may be minted from a partial session');
});

test('op: full-day bars that never trade the trigger become an honest immutable NO_FILL (Finding 5)', async () => {
  const { writes, deps, res } = opHarness({
    docs: { 'picks/2026-08-11.json': { picks: [ROW()] } },
    bars: { ABCD: { '2026-08-12': session(99) } },
    daily: { SPY: spyCal(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']) },
  });
  await SV.runScreenerVerify({}, res, { ...deps, now: '2026-08-13T18:00:00Z' });
  assert.equal(res.body.gradedNow, 1);
  const ep = writes['episodes/screener/2026-08-11.json'].episodes.ABCD;
  assert.equal(ep.fillStatus, EL.FILL_STATUS.NO_FILL);
});

test('op: a weekend gap grades normally against the SPY calendar (Finding 6)', async () => {
  const { writes, deps, res } = opHarness({
    docs: { 'picks/2026-08-07.json': { picks: [ROW()] } },
    bars: { ABCD: { '2026-08-10': session(99) } },
    daily: { SPY: spyCal(['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11']) },
  });
  await SV.runScreenerVerify({}, res, { ...deps, now: '2026-08-11T18:00:00Z' });
  assert.equal(res.body.gradedNow, 1);
  assert.equal(writes['episodes/screener/2026-08-07.json'].episodes.ABCD.fillStatus, EL.FILL_STATUS.NO_FILL);
});

test('op: a provider hole defers while young, then INVALID_DATA — never a graded episode (Finding 6)', async () => {
  // Ticker bars first appear 2026-08-13, but SPY traded 2026-08-12 (signal 2026-08-11):
  // grading 08-13 would grade the WRONG session. Young → defer (FMP may backfill).
  const docs = { 'picks/2026-08-11.json': { picks: [ROW()] } };
  const bars = { ABCD: { '2026-08-13': session(99) } };
  const daily = { SPY: spyCal(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17']) };

  const young = opHarness({ docs, bars, daily });
  await SV.runScreenerVerify({}, young.res, { ...young.deps, now: '2026-08-14T18:00:00Z' });
  assert.equal(young.res.body.gradedNow, 0);
  assert.ok(young.res.body.deferred >= 1);
  assert.equal('episodes/screener/2026-08-11.json' in young.writes, false);

  // Past the deferral window the hole is terminal: INVALID_DATA, entry never graded.
  const old = opHarness({ docs, bars, daily });
  await SV.runScreenerVerify({}, old.res, { ...old.deps, now: '2026-08-17T18:00:00Z' });
  const ep = old.writes['episodes/screener/2026-08-11.json'].episodes.ABCD;
  assert.equal(ep.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.equal(ep.attritionReason, EL.ATTRITION.MISSING_ENTRY_SESSION);
  assert.equal(ep.entryPrice, null, 'a hole-shifted session must never produce a graded fill');
  assert.ok(old.res.body.entryUnverifiable >= 1, 'the refusal is counted, never silent');
});

test('op: an unavailable SPY calendar fails closed — defer, never stamp (Finding 6)', async () => {
  const { writes, deps, res } = opHarness({
    docs: { 'picks/2026-08-11.json': { picks: [ROW()] } },
    bars: { ABCD: { '2026-08-12': session(99) } },
    daily: {}, // SPY daily history unavailable this run
  });
  await SV.runScreenerVerify({}, res, { ...deps, now: '2026-08-13T18:00:00Z' });
  assert.equal(res.body.gradedNow, 0);
  assert.ok(res.body.deferred >= 1);
  assert.ok(res.body.calendarUnavailable >= 1);
  // (The op may still bootstrap an empty rollup doc — pre-existing behavior. What it
  // must NEVER do is write an episode shard from an unverifiable entry session.)
  assert.equal('episodes/screener/2026-08-11.json' in writes, false, 'an unverifiable entry session mints no episode');
});

test('op: an OPEN fill beyond the 21-day window is reopened and resolved (Finding 7)', async () => {
  // Signal 30 days back — outside RESOLVE_LOOKBACK_DAYS. The rollup (rebuilt from ALL
  // shards) still knows the episode is open; the run must revisit it, not orphan it.
  const openEp = SV.buildEpisode(
    { ticker: 'ABCD', date: '2026-08-11', entry: 100, signalVersion: 'screener-v2' },
    { status: 'ok', entrySession: '2026-08-12' }, FILLED_ENTRY);
  assert.equal(openEp.exitReason, EL.EXIT_REASON.OPEN, 'precondition: the fixture is an open fill');
  const { writes, deps, res } = opHarness({
    docs: {
      'episodes/screener/2026-08-11.json': { version: SV.SCREENER_VERIFY_VERSION, date: '2026-08-11', episodes: { ABCD: openEp } },
      'episodes/screener/rollup.json': { version: SV.SCREENER_VERIFY_VERSION, episodes: [SV.projectEpisode(openEp)] },
    },
    daily: { ABCD: spyCal(['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19']) },
  });
  await SV.runScreenerVerify({}, res, { ...deps, now: '2026-09-10T18:00:00Z' });
  assert.equal(res.body.resolvedNow, 1, 'the stranded fill is resolved, not eternally OPEN');
  assert.equal(res.body.reopenedBeyondWindow, 1, 'the reopen is surfaced explicitly');
  assert.equal(res.body.deferredResolves, 0);
  const ep = writes['episodes/screener/2026-08-11.json'].episodes.ABCD;
  assert.equal(ep.exitReason, EL.EXIT_REASON.TIME);
  assert.equal(ep.exitTs, '2026-08-19', 'exit = close of the 5th session after the entry session');
  assert.ok(Number.isFinite(ep.netReturnPct));
});

test('op: beyond-window reopening is bounded oldest-first and overflow is COUNTED, never silent (Finding 7)', async () => {
  const docs = {}; const rollupEps = [];
  for (let i = 0; i <= SV.REOPEN_SHARD_CAP; i++) {
    const d = addDays('2026-06-01', i), t = `T${i}`;
    const ep = SV.buildEpisode({ ticker: t, date: d, entry: 100, signalVersion: 'screener-v2' },
      { status: 'ok', entrySession: addDays(d, 1) }, FILLED_ENTRY);
    docs[`episodes/screener/${d}.json`] = { version: SV.SCREENER_VERIFY_VERSION, date: d, episodes: { [t]: ep } };
    rollupEps.push(SV.projectEpisode(ep));
  }
  docs['episodes/screener/rollup.json'] = { version: SV.SCREENER_VERIFY_VERSION, episodes: rollupEps };
  const { deps, res } = opHarness({ docs, daily: {} }); // no daily bars → nothing can resolve
  await SV.runScreenerVerify({}, res, { ...deps, now: '2026-09-10T18:00:00Z' });
  assert.equal(res.body.reopenedBeyondWindow, SV.REOPEN_SHARD_CAP, 'the oldest CAP dates are reopened');
  assert.equal(res.body.deferredResolves, 1, 'the overflow episode is counted for the next run');
  assert.equal(res.body.resolvedNow, 0);
});
