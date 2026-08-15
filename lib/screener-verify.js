'use strict';
// SCREENER — INTRADAY FILL-VERIFICATION CHANNEL (screener-verify-v1).
//
// WHY THIS EXISTS. The swing actionable lane abstains BY CONSTRUCTION: lib/maturity.js
// caps every non-Day-Trade grade at `promising` without fill verification, and
// lib/strategy-contracts.fillVerifiedFor derives that ONLY from
// `summary.fillVerification[id]` — produced by lib/episode-ledger.deriveFillVerified
// over a strategy's own canonical episodes. No non-Day-Trade module emitted one
// (lib/episode-ledger was an orphan), so the derivation had nothing to read and the
// registry declared the fact as PROMOTION_CEILING (blocked, 2026-08-11). The sanctioned
// lift recorded there is exactly this module: a per-strategy canonical episode stream on
// an INTRADAY-VERIFIED basis (cf. op=gapgoverify), reduced into scoreboard/summary.json
// as fillVerification[id]. A daily-bar next-open reconstruction was deliberately
// REJECTED as fill verification — this channel observes real 5-minute bars instead.
//
// SCOPE. The screener's PROMOTED cohort only: Early:large picks from the frozen daily
// ledger (picks/<date>.json, written by op=track). Breakout/Setup and small/micro rows
// keep logging as excluded controls; verifying them adds nothing to the promoted claim.
//
// v1 FROZEN contract — EOD decision, next-session stop-entry through the published level:
//   signal   the logged pick day (op=track runs post-close; dataCutoffSession = that day)
//   trigger  the pick's LOGGED `entry` field — the published decision-time entry level.
//            (The Early pivot itself is not in the frozen record and is NEVER recomputed
//            post-hoc: a recomputed decision is a different decision.)
//   entry    on the FIRST trading session AFTER the signal day (the contract's
//            fillPolicy is next-session; exec-v1 BREAKOUT_STOP is next-session-only):
//            buy-stop at the trigger, verified on 5-minute bars — a bar OPEN at/above
//            the trigger is a gap-through and fills at the WORSE open; a bar HIGH
//            touching the trigger fills at the trigger; an open beyond the 5% chase
//            ceiling is a GAP-SKIP (refused, never chased); a session that never trades
//            the trigger is an honest NO_FILL. Adverse exec-v1 entry-side slippage is
//            charged on every fill.
//   exit     time exit at the close of the 5th session after the entry session — the
//            contract's promotion metric ('5d'). No stop/target: the frozen pick record
//            carries none, and inventing them post-hoc would grade a plan nobody logged.
//   costs    liquidity tier fails closed to 'small' (ADV is not in the pick record —
//            unknown liquidity must never earn the cheapest tier). The entry leg is
//            inside the fill price; the exit leg is charged at resolution.
//   no bars fail closed: a partial or absent 5-minute session is 'invalid-data'
//            (TRUNCATED_HISTORY), never imputed and never a false NO_FILL. A
//            'no-trigger' claim is EXHAUSTIVE, so it additionally requires a COMPLETE
//            session (bars through the final 5-min bar AND the ET close settled) —
//            an in-progress or truncated session defers, then goes invalid-data.
//   calendar the entry session must be verifiably the FIRST trading session after the
//            signal. The ticker's own feed cannot tell a weekend from a one-day
//            provider hole (which would silently grade the WRONG session), so the
//            claim is checked against SPY daily bars — the repo's standard trading
//            calendar. Unverifiable ⇒ defer, then invalid-data; never graded.
//   reopen   FILLED episodes still OPEN when their signal date ages past the resolve
//            window are reopened from the rollup index (oldest first, bounded) so the
//            resolved count never preferentially loses slow resolutions; whatever
//            stays deferred is counted, never dropped silently.
//
// Episodes are canonical (lib/episode-ledger.makeEpisode), stamped fillBasis
// 'intraday-verified' — a member of VERIFIED_FILL_BASES: every fill/no-fill/gap-skip
// here is a real observation of the published trigger on intraday bars, not a
// reconstruction. Persistence is one immutable-per-key day shard per SIGNAL date
// (episodes/screener/<date>.json — the repo's daily-ledger convention; no cross-day
// read-modify-write) plus a compact rollup (episodes/screener/rollup.json) that the
// Scoreboard reduction reads. Verification accrues PROSPECTIVELY: nothing here can
// promote anything today — deriveFillVerified fails closed below its resolved minimum,
// and every other maturity gate still applies on top.

const S = require('./store');
const EL = require('./episode-ledger');
const MS = require('./market-session');
const { selectEntrySession, fetchFmp5min } = require('./gapgo-verify');
const { perSideSlippagePct, EXECUTION_POLICY_VERSION } = require('./execution-policy');
const { roundTripCostPct } = require('./costs');

const SCREENER_VERIFY_VERSION = 'screener-verify-v1';
const FILL_BASIS = 'intraday-verified';     // must be a member of EL.VERIFIED_FILL_BASES
const COHORT = Object.freeze({ section: 'screener', tier: 'Early', scope: 'large' });

const CHASE_CEILING_PCT = 5;       // refuse fills beyond trigger×1.05 (premove-trigger-v1 gap refusal)
const HOLD_SESSIONS = 5;           // contract promotionMetric '5d' — time exit at the 5th close after entry
const SESSION_START = '09:30';
const SESSION_END = '16:00';
const MIN_SESSION_BARS = 30;       // a graded session must be substantially complete…
const MAX_FIRST_BAR = '09:30';     // …and start at the open, or an early cross could be missed
const COMPLETE_LAST_BAR = '15:55'; // a no-trigger claim needs bars through the final 5-min bar…
const EARLY_CLOSE_LAST_BAR = '12:55'; // …(12:55 on 13:00 early-close sessions)
const SESSION_COMPLETE_MIN = 16 * 60 + 5; // 16:05 ET — regular close + settle (omega-ab precedent)
const LOOKBACK_DAYS = 8;           // calendar window of pick days to (re)try for entry grading
const RESOLVE_LOOKBACK_DAYS = 21;  // calendar window of shards scanned for open-episode resolution
const UNAVAILABLE_AFTER_DAYS = 5;  // only after this is a bars miss terminal (before: retry)
const FETCH_CAP = 25;              // bounded FMP 5-min calls per run
const RESOLVE_CAP = 25;            // bounded daily-candle fetches per run
const REOPEN_SHARD_CAP = 10;       // beyond-window shards with rollup-known OPEN fills reloaded per run (oldest first)
const DEEP_HISTORY_AFTER_DAYS = 75;// reopened episodes older than this need '1y' daily history, not '3mo'
const COST_TIER_FALLBACK = 'small';// pick records carry no ADV — never assume the cheapest tier

const EPISODE_PREFIX = 'episodes/screener/';
const SHARD_RE = /^episodes\/screener\/\d{4}-\d{2}-\d{2}\.json$/;
const ROLLUP_DOC = 'episodes/screener/rollup.json';

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

// ── PURE entry resolver ──────────────────────────────────────────────────────
// bars: [{ t:'HH:MM', open, high, low, close }] ascending, one regular session.
// Mirrors exec-v1 BREAKOUT_STOP semantics, observed on real 5-minute bars: gap-through
// fills at the WORSE open, a touch fills at the trigger, an open beyond the chase
// ceiling before any fill is a refusal. Adverse slippage moves the fill AGAINST the buyer.
function resolveEntryFromBars(bars, { trigger, chaseCeilingPct = CHASE_CEILING_PCT, slippagePct = 0, sessionDate = null } = {}) {
  if (!Number.isFinite(trigger) || trigger <= 0) return { version: SCREENER_VERIFY_VERSION, status: 'invalid-trigger' };
  const session = (bars || []).filter(b => b && b.t >= SESSION_START && b.t < SESSION_END
    && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close));
  // Completeness guard: a feed that starts mid-session or covers a fragment could miss
  // an early trigger cross and mint a FALSE no-fill — refused, never guessed.
  if (session.length < MIN_SESSION_BARS || session[0].t > MAX_FIRST_BAR) {
    return { version: SCREENER_VERIFY_VERSION, status: 'insufficient-bars', bars: session.length };
  }
  const ceiling = trigger * (1 + chaseCeilingPct / 100);
  const base = { version: SCREENER_VERIFY_VERSION, trigger: +trigger.toFixed(4), ceiling: +ceiling.toFixed(4), slippagePct: +slippagePct.toFixed(6) };
  for (const b of session) {
    if (b.open >= ceiling) return { ...base, status: 'gap-skip', at: b.t, open: b.open };
    let ref = null, reason = null;
    if (b.open >= trigger) { ref = b.open; reason = 'gap-through-trigger'; }        // worse open
    else if (b.high >= trigger) { ref = trigger; reason = 'stop-trigger'; }         // touched
    if (ref != null) {
      return { ...base, status: 'filled', at: b.t, referencePrice: +ref.toFixed(4), fill: +(ref * (1 + slippagePct)).toFixed(4), reason };
    }
  }
  // A no-trigger claim is EXHAUSTIVE — only a COMPLETE session can prove the level
  // never traded. A feed truncated mid-session (or an in-progress session fetched by a
  // manual run) could still trigger later, so it must defer upstream, never mint an
  // immutable false NO_FILL. Early-close sessions (13:00 ET) end at their own last bar.
  const requiredLastBar = MS.EARLY_CLOSES.has(sessionDate) ? EARLY_CLOSE_LAST_BAR : COMPLETE_LAST_BAR;
  const lastBar = session[session.length - 1];
  if (lastBar.t < requiredLastBar) {
    return { ...base, status: 'incomplete-session', bars: session.length, lastBar: lastBar.t };
  }
  return { ...base, status: 'no-trigger' };
}

// ── PURE ET session-completeness ─────────────────────────────────────────────
// Bars through 15:55 can exist while the 15:55 bar is still FORMING, so a no-trigger
// verdict also needs the entry session to be over on the ET wall clock. Mirrors
// omega-ab's isCompletedSessionBar (audit 2026-08-14): a strictly-prior ET date is
// complete; the current ET date only after the close settles. DST-correct via
// lib/market-session etParts.
function isEtSessionComplete(sessionDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || ''))) return false;
  const { date, minutes } = MS.etParts(now);
  if (sessionDate < date) return true;
  if (sessionDate > date) return false;
  return minutes >= SESSION_COMPLETE_MIN;
}

// ── PURE trading-calendar hole check ─────────────────────────────────────────
// Calendar dates strictly between the signal date and the candidate entry session.
// Non-empty ⇒ the candidate is NOT provably the first trading session after the
// signal: the market traded on a day the ticker feed skipped (provider hole — or a
// halt, indistinguishable here), so grading that candidate would grade the WRONG
// session. The caller supplies SPY daily-bar dates, the repo's standard calendar.
function entrySessionCalendarHoles(calendarDates, signalDate, entrySession) {
  return [...new Set((calendarDates || []).filter(cd =>
    typeof cd === 'string' && cd > signalDate && cd < entrySession))].sort();
}

// ── PURE canonical-episode builder ───────────────────────────────────────────
// pick: a frozen picks/<date>.json Early:large row. sel: selectEntrySession result.
// entry: resolveEntryFromBars result (or {status:'bars-unavailable'}). resolution:
// optional { exitPrice, exitTs } once the 5-session horizon has elapsed.
// Decision fields are COPIED from the pick, never recomputed.
function buildEpisode(pick, sel, entry, { tier = COST_TIER_FALLBACK, resolution = null } = {}) {
  const F = EL.FILL_STATUS, A = EL.ATTRITION;
  const statusMap = {
    filled: { fill: F.FILLED },
    'no-trigger': { fill: F.NO_FILL, attrition: A.NO_FILL },
    'gap-skip': { fill: F.GAP_SKIP, attrition: A.GAP_SKIP },
    'insufficient-bars': { fill: F.INVALID_DATA, attrition: A.TRUNCATED_HISTORY },
    'incomplete-session': { fill: F.INVALID_DATA, attrition: A.TRUNCATED_HISTORY },
    'bars-unavailable': { fill: F.INVALID_DATA, attrition: A.TRUNCATED_HISTORY },
    'invalid-trigger': { fill: F.INVALID_DATA, attrition: A.NO_HISTORY },
    'no-entry-session': { fill: F.INVALID_DATA, attrition: A.MISSING_ENTRY_SESSION },
    'entry-session-uncertain': { fill: F.INVALID_DATA, attrition: A.MISSING_ENTRY_SESSION },
    'entry-session-unverifiable': { fill: F.INVALID_DATA, attrition: A.MISSING_ENTRY_SESSION },
  };
  const st = (sel && sel.status !== 'ok') ? statusMap[sel.status] : statusMap[entry && entry.status];
  const m = st || { fill: F.INVALID_DATA, attrition: A.TRUNCATED_HISTORY };
  const entrySession = sel && sel.status === 'ok' ? sel.entrySession : null;
  const filled = m.fill === F.FILLED;
  const slip = entry && Number.isFinite(entry.slippagePct) ? entry.slippagePct : null;
  const resolved = filled && resolution && Number.isFinite(resolution.exitPrice) && resolution.exitTs;
  const gross = resolved ? ((resolution.exitPrice - entry.fill) / entry.fill) * 100 : null;
  // Exit-leg friction only: the entry leg is already inside the adverse-slipped fill.
  const exitLegPct = roundTripCostPct(tier) / 2;
  return EL.makeEpisode({
    identity: {
      strategyId: 'screener', scoringVersion: pick.signalVersion || 'screener-v2', side: 'long',
      policyTier: COHORT.tier, scope: COHORT.scope, horizon: 'swing', metric: '5d',
      executionPolicyVersion: EXECUTION_POLICY_VERSION, labelVersion: SCREENER_VERIFY_VERSION,
    },
    ticker: pick.ticker,
    decisionTs: pick.ts ? new Date(pick.ts).toISOString() : `${pick.date}T21:30:00.000Z`,
    informationCutoff: pick.date,
    expectedEntrySession: entrySession,
    actualEntryTs: filled ? `${entrySession}T${entry.at}` : null,
    fillStatus: m.fill,
    // The CHANNEL's basis: every status here (fill, no-fill, gap-skip, invalid-data) was
    // resolved against — or honestly refused for lack of — real intraday bars. Never a
    // daily-bar reconstruction. INVALID_DATA episodes cannot verify anything regardless
    // (fillVerified requires FILLED), so the uniform stamp cannot overclaim.
    fillBasis: FILL_BASIS,
    attritionReason: m.attrition || null,
    entryPrice: filled ? entry.fill : null,
    entryPriceSource: filled ? `${entry.reason} @5-min bar ${entry.at} (published trigger ${entry.trigger})` : null,
    slippageAssumptionPct: slip != null ? slip * 100 : null,
    timeExitSessions: HOLD_SESSIONS,
    exitReason: resolved ? EL.EXIT_REASON.TIME : undefined,
    exitPrice: resolved ? resolution.exitPrice : null,
    exitTs: resolved ? resolution.exitTs : null,
    transactionCostPct: filled ? roundTripCostPct(tier) : null,
    grossReturnPct: resolved ? +gross.toFixed(3) : null,
    netReturnPct: resolved ? +(gross - exitLegPct).toFixed(3) : null,
    dataLineage: { channel: SCREENER_VERIFY_VERSION, barSource: 'fmp-5min', trigger: entry && entry.trigger != null ? entry.trigger : (Number.isFinite(+pick.entry) ? +pick.entry : null), costTier: tier },
    evaluatorVersion: SCREENER_VERIFY_VERSION,
  });
}

// ── PURE time-exit lookup ────────────────────────────────────────────────────
// candles: daily [{date, close}] ascending. Exit = the close of the HOLD_SESSIONS-th
// bar AFTER the entry session. null until that bar exists (still open — honest).
function timeExitFromDaily(candles, entrySession, holdSessions = HOLD_SESSIONS) {
  const rows = (candles || []).filter(c => c && typeof c.date === 'string' && Number.isFinite(c.close));
  const i = rows.findIndex(c => c.date === entrySession);
  if (i < 0) return null;
  const exitBar = rows[i + holdSessions];
  if (!exitBar) return null;
  return { exitPrice: exitBar.close, exitTs: exitBar.date };
}

// ── Rollup projection + Scoreboard reduction ─────────────────────────────────
// Compact projection: exactly what deriveFillVerified consumes (fillStatus, exitReason,
// fillBasis, fillVerified) plus display context. Keeps the rollup bounded.
function projectEpisode(e) {
  return {
    episodeId: e.episodeId, ticker: e.ticker,
    date: (e.informationCutoff || '').slice(0, 10) || null,
    entrySession: e.expectedEntrySession || null,
    fillStatus: e.fillStatus, fillBasis: e.fillBasis, fillVerified: e.fillVerified === true,
    exitReason: e.exitReason || null,
    entryPrice: e.entryPrice, exitPrice: e.exitPrice, netReturnPct: e.netReturnPct,
    attritionReason: e.attritionReason || null, valid: e.valid !== false,
  };
}

async function readEpisodeRollup() {
  return S.readJSON(ROLLUP_DOC, null);
}

// The reduction the Scoreboard summary calls (apex-routes). FAIL CLOSED: with no
// accrued episodes (absent/empty/unreadable rollup) it returns null and the summary is
// BYTE-IDENTICAL to the pre-pipeline summary — every consumer (maturity, governance,
// eligibility) behaves exactly as before. Only real accrued episodes change anything,
// and even then only through episode-ledger's own fail-closed deriveFillVerified.
function fillVerificationForSummary(rollup) {
  const eps = rollup && Array.isArray(rollup.episodes) ? rollup.episodes.filter(Boolean) : [];
  if (!eps.length) return null;
  return {
    screener: {
      ...EL.deriveFillVerified(eps),
      channel: SCREENER_VERIFY_VERSION,
      cohort: `${COHORT.tier}:${COHORT.scope}`,
      episodes: eps.length,
      updatedAt: (rollup && rollup.updatedAt) || null,
    },
  };
}

// ── op=swingverify — accrue the verified channel (cron/manual-with-bearer) ───
async function runScreenerVerify(req, res, overrides) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  // Injection seam (tests only — production callers pass exactly (req, res)).
  const deps = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  const fetch5min = deps.fetch5min || fetchFmp5min;
  const fetchDaily = deps.fetchDaily || require('./screener').fetchDailyHistory;
  const now = deps.now != null ? new Date(deps.now) : new Date();
  const todayMs = now.getTime();
  const dates = [];
  for (let d = 1; d <= RESOLVE_LOOKBACK_DAYS; d++) dates.push(isoDate(todayMs - d * 86400000));
  const windowSet = new Set(dates);

  // Prior rollup, read ONCE per run: rebuilt from ALL shards every run, it is the index
  // of episodes older than the scan window — used below to reopen stranded OPEN fills.
  const priorRollup = await readEpisodeRollup().catch(() => null);

  // SPY daily bars — the repo's standard trading calendar — fetched at most once per
  // run, only when Phase 1 actually has an entry session to verify.
  let calendarDates; // undefined = not fetched yet, null = unavailable this run
  const getCalendar = async () => {
    if (calendarDates !== undefined) return calendarDates;
    const hist = await fetchDaily('SPY', '3mo').catch(() => null);
    const cds = hist && Array.isArray(hist.candles)
      ? hist.candles.map(c => c && c.date).filter(cd => typeof cd === 'string') : [];
    calendarDates = cds.length ? cds : null;
    return calendarDates;
  };

  // Load pick days (entry-grading window) + episode shards (resolution window) ONCE;
  // all mutation happens in memory and each touched shard is written exactly once —
  // a shard read-modify-write never straddles phases (the Blob read-back-lag rule).
  const shards = {};   // date → shard doc (in memory)
  const pickDays = {}; // date → picks[] (Early:large only)
  await Promise.all(dates.map(async (d) => {
    const shard = await S.readJSON(`${EPISODE_PREFIX}${d}.json`, null).catch(() => null);
    if (shard && shard.episodes) shards[d] = shard;
    if (isoDate(todayMs - LOOKBACK_DAYS * 86400000) <= d) {
      const day = await S.readJSON(`picks/${d}.json`, null).catch(() => null);
      const rows = (day && Array.isArray(day.picks) ? day.picks : []).filter(p =>
        p && p.ticker && p.section === COHORT.section && p.tier === COHORT.tier && p.scope === COHORT.scope);
      if (rows.length) pickDays[d] = rows.map(p => ({ ...p, date: p.date || d }));
    }
  }));

  const touched = new Set();
  const slippagePct = perSideSlippagePct(COST_TIER_FALLBACK);

  // Phase 1 — verify entries for pending picks (bounded FMP 5-min fan-out).
  let graded = 0, unavailable = 0, deferred = 0, invalidPicks = 0, fetches = 0, capped = 0;
  let entryUnverifiable = 0, calendarUnavailable = 0;
  for (const d of Object.keys(pickDays).sort()) {
    for (const pick of pickDays[d]) {
      const shard = shards[d] || (shards[d] = { version: SCREENER_VERIFY_VERSION, date: d, episodes: {} });
      if (shard.episodes[pick.ticker]) continue;                 // append-only — never regraded
      const trigger = Number.isFinite(+pick.entry) && +pick.entry > 0 ? +pick.entry : null;
      if (trigger == null) { invalidPicks++; continue; }         // op=track guards price!=null; counted, near-impossible
      if (fetches >= FETCH_CAP) { capped++; continue; }          // bounded — the rest retry next run
      fetches++;
      const from = isoDate(Date.parse(d) + 86400000);
      const to = isoDate(Date.parse(d) + 7 * 86400000);
      const barsBySession = await fetch5min(pick.ticker, from, to);
      const ageDays = Math.round((todayMs - Date.parse(d)) / 86400000);
      if (!barsBySession) {
        if (ageDays >= UNAVAILABLE_AFTER_DAYS) {
          shard.episodes[pick.ticker] = { ...buildEpisode(pick, { status: 'bars-unavailable' }, { status: 'bars-unavailable' }), gradedAt: new Date().toISOString() };
          touched.add(d); unavailable++;
        } else deferred++;                                       // young — retry next run
        continue;
      }
      const sessions = Object.keys(barsBySession).filter(k => Array.isArray(barsBySession[k]) && barsBySession[k].length);
      const sel = selectEntrySession(sessions, d);
      if (sel.status !== 'ok') {
        if (ageDays < UNAVAILABLE_AFTER_DAYS) { deferred++; continue; } // entry session hasn't traded/landed yet
        shard.episodes[pick.ticker] = { ...buildEpisode(pick, sel, null), gradedAt: new Date().toISOString() };
        touched.add(d); graded++;
        continue;
      }
      // Entry-session integrity: selectEntrySession sees only the TICKER's bars, so its
      // gap refusal (>5 calendar days) cannot tell a weekend from a one-day provider
      // hole — and a hole silently grades the buy-stop against the WRONG session,
      // immutably. The "first trading session after the signal" claim is checked
      // against the SPY calendar; unverifiable NEVER becomes a graded episode.
      const calendar = await getCalendar();
      if (!calendar) { calendarUnavailable++; deferred++; continue; }   // cannot verify → never stamp
      const holes = entrySessionCalendarHoles(calendar, d, sel.entrySession);
      if (holes.length) {
        entryUnverifiable++;
        if (ageDays < UNAVAILABLE_AFTER_DAYS) { deferred++; continue; } // the provider may backfill the hole
        shard.episodes[pick.ticker] = {
          ...buildEpisode(pick, { status: 'entry-session-unverifiable', candidate: sel.entrySession }, null),
          missingSessions: holes, gradedAt: new Date().toISOString(),
        };
        touched.add(d); graded++;
        continue;
      }
      let entry = resolveEntryFromBars(barsBySession[sel.entrySession], { trigger, slippagePct, sessionDate: sel.entrySession });
      // A no-trigger claim is exhaustive: bars through 15:55 can exist while the final
      // bar is still forming, so the entry session must also be over on the ET clock —
      // a bearer-authorized mid-session run must never mint an immutable false NO_FILL.
      if (entry.status === 'no-trigger' && !isEtSessionComplete(sel.entrySession, now)) {
        entry = { ...entry, status: 'incomplete-session' };
      }
      if ((entry.status === 'insufficient-bars' || entry.status === 'incomplete-session')
        && ageDays < UNAVAILABLE_AFTER_DAYS) { deferred++; continue; }  // young — retry with the complete session
      shard.episodes[pick.ticker] = { ...buildEpisode(pick, sel, entry), gradedAt: new Date().toISOString() };
      touched.add(d); graded++;
    }
  }

  // Phase 2 — resolve matured OPEN fills at the 5-session time exit (daily closes are
  // durable, so this never races bar availability). Bounded candle fan-out.
  //
  // The scan window alone is survivorship-shaped: a FILLED episode still OPEN when its
  // signal date ages past RESOLVE_LOOKBACK_DAYS (e.g. across a cron outage) would never
  // be revisited — eternally OPEN, silently missing from deriveFillVerified's resolved
  // count, and preferentially missing exactly the fills that took longest to resolve.
  // The prior rollup indexes those stragglers; reopen their shards oldest-first,
  // bounded, and COUNT whatever stays deferred so nothing is dropped silently.
  let resolvedNow = 0, resolveFetches = 0, reopenedBeyondWindow = 0, deferredResolves = 0;
  const openBeyond = {}; // date → rollup-known OPEN-fill count beyond the scan window
  for (const e of (priorRollup && Array.isArray(priorRollup.episodes) ? priorRollup.episodes : [])) {
    if (!e || e.fillStatus !== EL.FILL_STATUS.FILLED) continue;
    if (e.exitReason && e.exitReason !== EL.EXIT_REASON.OPEN) continue;
    if (!e.date || windowSet.has(e.date) || shards[e.date]) continue;
    openBeyond[e.date] = (openBeyond[e.date] || 0) + 1;
  }
  const beyondDates = Object.keys(openBeyond).sort();       // oldest first — longest-stranded resolve first
  for (const bd of beyondDates.slice(REOPEN_SHARD_CAP)) deferredResolves += openBeyond[bd];
  await Promise.all(beyondDates.slice(0, REOPEN_SHARD_CAP).map(async (bd) => {
    const shard = await S.readJSON(`${EPISODE_PREFIX}${bd}.json`, null).catch(() => null);
    if (shard && shard.episodes) shards[bd] = shard;        // shards stay authoritative over the rollup
  }));
  for (const d of Object.keys(shards).sort()) {
    const isBeyondWindow = !windowSet.has(d);
    for (const [ticker, e] of Object.entries(shards[d].episodes || {})) {
      if (!e || e.fillStatus !== EL.FILL_STATUS.FILLED || (e.exitReason && e.exitReason !== EL.EXIT_REASON.OPEN)) continue;
      if (isBeyondWindow) reopenedBeyondWindow++;
      if (resolveFetches >= RESOLVE_CAP) { deferredResolves++; continue; }
      resolveFetches++;
      const range = todayMs - Date.parse(d) > DEEP_HISTORY_AFTER_DAYS * 86400000 ? '1y' : '3mo';
      const hist = await fetchDaily(ticker, range).catch(() => null);
      const resolution = timeExitFromDaily(hist && hist.candles, e.expectedEntrySession);
      if (!resolution) continue;                                 // horizon not elapsed / no bars yet — stays open
      const pick = { ticker, date: d, ts: Date.parse(e.decisionTs) || null, entry: e.dataLineage && e.dataLineage.trigger, signalVersion: e.identity && e.identity.scoringVersion };
      const entry = { status: 'filled', at: (e.actualEntryTs || '').slice(11, 16) || SESSION_START, fill: e.entryPrice, referencePrice: e.entryPrice, reason: 'stop-trigger', trigger: e.dataLineage && e.dataLineage.trigger, slippagePct: e.slippageAssumptionPct != null ? e.slippageAssumptionPct / 100 : slippagePct };
      const sel = { status: 'ok', entrySession: e.expectedEntrySession };
      const rebuilt = buildEpisode(pick, sel, entry, { resolution });
      // Preserve the original observation's provenance string (gap-through vs stop-trigger).
      shards[d].episodes[ticker] = { ...rebuilt, entryPriceSource: e.entryPriceSource || rebuilt.entryPriceSource, gradedAt: e.gradedAt || null, resolvedAt: new Date().toISOString() };
      touched.add(d); resolvedNow++;
    }
  }

  // Persist each touched shard exactly once.
  for (const d of touched) {
    shards[d].version = SCREENER_VERIFY_VERSION;
    shards[d].updatedAt = new Date().toISOString();
    await S.writeJSON(`${EPISODE_PREFIX}${d}.json`, shards[d], 0);
  }

  // Rebuild the compact rollup from ALL shards, overriding stale Blob read-backs with
  // this run's in-memory docs for the dates it just wrote.
  const rollupEpisodes = [];
  try {
    const { list } = require('@vercel/blob');
    const blobs = []; let cursor;
    do { const r = await list({ prefix: EPISODE_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
    const shardDates = blobs.filter(b => SHARD_RE.test(b.pathname)).map(b => b.pathname.slice(EPISODE_PREFIX.length, -5));
    const allDates = [...new Set([...shardDates, ...Object.keys(shards).filter(d => shards[d] && Object.keys(shards[d].episodes || {}).length)])].sort();
    for (const d of allDates) {
      const doc = shards[d] || await S.readJSON(`${EPISODE_PREFIX}${d}.json`, null).catch(() => null);
      for (const e of Object.values((doc && doc.episodes) || {})) if (e) rollupEpisodes.push(projectEpisode(e));
    }
    if (touched.size || !priorRollup) {
      await S.writeJSON(ROLLUP_DOC, { version: SCREENER_VERIFY_VERSION, updatedAt: new Date().toISOString(), count: rollupEpisodes.length, episodes: rollupEpisodes }, 0);
    }
  } catch { /* rollup rebuild is retried next run; shards remain authoritative */ }

  const statusCounts = {};
  for (const e of rollupEpisodes) statusCounts[e.fillStatus] = (statusCounts[e.fillStatus] || 0) + 1;
  const derived = EL.deriveFillVerified(rollupEpisodes);
  return res.json({
    ok: true, version: SCREENER_VERIFY_VERSION, cohort: `${COHORT.tier}:${COHORT.scope}`,
    gradedNow: graded, resolvedNow, unavailableNow: unavailable, deferred, cappedThisRun: capped, invalidPicks,
    entryUnverifiable, calendarUnavailable, reopenedBeyondWindow, deferredResolves,
    episodes: rollupEpisodes.length, statusCounts,
    fillVerification: derived,
    contract: 'FROZEN v1 verification: post-close logged Early:large pick; entry on the NEXT trading session only — buy-stop at the LOGGED published entry level, verified on 5-min bars; gap-through at the worse open; >5% open beyond trigger = gap-skip; adverse exec-v1 entry slippage (small tier — ADV unlogged fails closed); time exit at the 5th session close after entry (the 5d promotion metric); exit-leg friction charged at resolution. The verifier can never trade the session that produced the decision.',
    note: 'VERIFIED intraday channel — accrues PROSPECTIVELY. Nothing here promotes anything: fillVerification.screener reaches scoreboard/summary.json only through episode-ledger deriveFillVerified, which fails closed below its resolved minimum, and every other maturity gate still applies.',
  });
}

module.exports = {
  SCREENER_VERIFY_VERSION, FILL_BASIS, COHORT, CHASE_CEILING_PCT, HOLD_SESSIONS, REOPEN_SHARD_CAP,
  resolveEntryFromBars, isEtSessionComplete, entrySessionCalendarHoles,
  buildEpisode, timeExitFromDaily, projectEpisode,
  readEpisodeRollup, fillVerificationForSummary, runScreenerVerify,
};
