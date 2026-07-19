'use strict';
// WARM CHAINS — ordered cron work that runs in ITS OWN invocation.
//
// THE BUG THIS FIXES (found in the Vercel logs, 2026-07-17):
//
//   [warm] track ok 12731ms · narrative 103ms · apexlog 6847ms · ghostlog 10165ms
//   [warm] archive skipped:budget 51800ms elapsed
//   [warm] done {"elapsedMs":55001, skipped:[archive,intracapture,cern,edgelog,...]}
//
// api/warm.js awaited ~22s of cache warming plus ~30s of ledger stages, so by the time
// it reached its fire-and-forget section it had ~3s of a 55s drain ceiling left. Every
// ORDERED chain there was written as `firstKick.then(() => next()).then(() => next())`
// — and a `.then()` only fires while WARM'S OWN event loop is alive. Warm returned at
// 55.0s, ~3s after dispatching the first link. So:
//
//   • the 2nd+ link of every chain never fired (redundancy rebuild, the op=today
//     re-prime, evolvescore→evolveresolve, ignitionlog, omegalog, alignedlog,
//     universecompile, pulserefine, the OMEGA-Ensemble prime);
//   • the 7 awaited tail stages (archive, intracapture, cern, edgelog, alertsgrade,
//     alertsassess, fadetick) were budget-skipped EVERY run;
//   • the 3 decoupled tick chains were created past the 50s mark and drained for ~3s.
//
// None of it errored. Health reported ok:true / healthy:true, because a budget skip was
// classed as "deferred, self-heals next run" — a premise that is false when it is
// skipped every single run. This is why so much of this app has needed manual triggering.
//
// THE FIX — put the ordering INSIDE the callee, not in the caller.
//
// Every step here is an HTTP call to another Vercel function, which gets its OWN 60s
// budget and runs to completion INDEPENDENTLY of whoever dispatched it. So a chain
// executed inside an `op=warmchain` invocation survives warm's death: warm only has to
// get the request out of the door. Warm still awaits for REPORTING, but its report being
// truncated no longer means the work was lost.
//
// A chain hands off to the next with `@name`, which DISPATCHES a fresh warmchain
// invocation rather than inlining those steps — so each link gets a full budget instead
// of eating its parent's remainder. A parent that dies mid-handoff does not stop the
// child: it is already its own invocation.
//
// Pure + injectable (`call` + `now`): the runner never touches the network or the wall
// clock itself, so the ordering and the budget are unit-testable — which matters here
// precisely because the cron cannot be triggered by hand (it is 401 without CRON_SECRET
// and fires once a day).

// Soft budget for one chain invocation. Under the 60s function wall with headroom, so a
// long chain records honest skips instead of being killed mid-step (a hard kill is a 504
// and writes no report at all).
const CHAIN_DEADLINE_MS = 48000;

// ORDER MATTERS inside a chain; chains themselves are independent of each other.
const CHAINS = {
  // The day's ledger writes. `track` must land before the redundancy rebuild reads the
  // ledger, and `narrative` before `apexlog` stamps signals with the current tag — hence
  // one ordered chain, handing off to the decision layer once the picks are written.
  // `op=runmanifest` runs LAST in this invocation (before handing off to @decision):
  // by then track/apexlog/ghostlog have written today's ledger files, so the manifest
  // pins their real content hashes + the deploy SHA into the immutable `runs` chain.
  ledger: ['op=track', 'op=narrative', 'op=apexlog', 'op=ghostlog', 'op=runmanifest', '@decision'],

  // The decision layer, deliberately SPLIT across two invocations.
  //
  // today&log=1 writes tomorrow's lane diff, then the redundancy model is rebuilt. Both
  // are slow (~11s) and `op=redundancy&force=1` is the one op here whose cost is genuinely
  // unknown — it refetches candles for every ticker in the ledger history (214 and
  // growing). Putting the re-prime and the ensemble behind it in the SAME invocation made
  // the chain ~47s against a 48s deadline, so one slow rebuild would budget-skip
  // op=ensemble — reintroducing exactly the starvation this file exists to remove.
  // Handing off buys the re-prime a fresh budget instead of gambling on the remainder.
  decision: ['op=today&log=1', 'op=redundancy&force=1', '@reprime'],

  // The re-prime MUST follow the rebuild: op=today's CDN copy still carries the previous
  // model's credits until it is refetched, and op=ensemble is a projection of op=today, so
  // it primes last or it caches a board scored on the old model.
  // op=challengerlog logs the shadow board AFTER today+ensemble are fresh (self-fetches the
  // warm cached endpoints). op=challengerresolve is candle-heavy so it rides ticks3 instead.
  reprime: ['op=today', 'op=ensemble', 'op=challengerlog', 'op=orbitlog', '@evolve'],

  // EVOLVE: log predictions, resolve matured ones (this is what applies the uniqueness
  // weighting + DSR survivors to the live perf ledger), then prime the tab.
  evolve: ['op=evolvescore&log=1', 'op=evolveresolve', 'op=evolve', '@postdecision'],

  // Everything else that only needs op=today to be fresh. One chain rather than three
  // roots so they cannot race the decision layer.
  postdecision: ['op=ignitionlog', 'op=ignition', 'op=omegalog', 'op=omega'],

  // The capture/tail stages that were budget-skipped on EVERY run — including op=archive,
  // which is step 1 of the backtest roadmap and has therefore not been capturing.
  capture: ['op=archive', 'op=intracapture', 'op=cerntick', 'op=edgelog', 'op=alertsgrade', 'op=alertsassess', 'op=fadetick'],

  // Screener + event resolve/learn/log ticks (order-independent within the chain).
  ticks1: ['op=trendtick', 'op=daytradetick', 'op=confluencetick', 'op=coiltick', 'op=gapgotick', 'op=downdaytick', 'op=gapdowntick'],
  // Ordered pairs: timinglog→tune, dualreadlog→tune, then brief after predict+crowd.
  ticks2: ['op=timinglog', 'op=timingtune', 'op=dualreadlog', 'op=dualreadtune', 'op=predicttick', 'op=crowdtick', 'op=brieftick'],
  // Leaderboard (heavy), then core build→log→drift (ordered), then the cheap ones.
  ticks3: ['op=leaderboardtick&src=confluence', 'op=corebuild', 'op=corelog', 'op=coredrift', 'op=attentiontick', 'op=tonetick&limit=6', 'op=challengerresolve', 'op=orbitresolve'],

  aligned: ['op=aligned', 'op=alignedlog'],
  // Security master refresh rides the once-daily heavy-build lane. Slow-changing, so a
  // budget-skip on a busy day self-heals next run (it re-reads all sources from scratch).
  universe: ['op=universescan&cursor=1&limit=150', 'op=universescan&cursor=1&limit=150', 'op=universecompile', 'op=secmasterbuild'],
  pulse: ['op=pulse&force=1', 'op=pulserefine&force=1'],
};

// Only these are dispatched by warm. The rest are reached via `@` from their parent — a
// chain that is BOTH a root and nested would run twice; one that is neither never runs.
// Both mistakes are asserted against in test/warm-chains.test.js.
const ROOT_CHAINS = ['ledger', 'capture', 'ticks1', 'ticks2', 'ticks3', 'aligned', 'universe', 'pulse'];

const pathFor = (step) => (step.startsWith('@')
  ? `/api/tracker?op=warmchain&name=${step.slice(1)}`
  : `/api/tracker?${step}`);

// Run one named chain. `call(path) -> {ok, status}` and `now()` are injected so this is
// testable without a network or a wall clock.
async function runChain(name, { call, now = Date.now, deadlineMs = CHAIN_DEADLINE_MS } = {}) {
  const steps = CHAINS[name];
  if (!steps) return { ok: false, name, error: `unknown chain "${name}"`, steps: [], skipped: [], complete: false };

  const started = now();
  const done = [];
  const skipped = [];

  for (const step of steps) {
    const elapsed = now() - started;
    if (elapsed > deadlineMs) {
      // Do not START new work past the budget — record it instead. The next run picks it
      // up (each tick re-resolves everything still open), and the skip is NAMED so chronic
      // starvation is visible rather than reported as a healthy deferral.
      done.push({ op: step, status: 'skipped:budget', elapsedMs: elapsed });
      skipped.push(step);
      continue;
    }
    const t0 = now();
    try {
      const r = await call(pathFor(step));
      const ms = now() - t0;
      if (step.startsWith('@')) {
        // A nested chain runs in its own invocation, but this parent AWAITED it, so its
        // body IS here — propagate the child's real outcome (its steps' failures/skips)
        // rather than rubber-stamping "dispatched". A warmchain returns HTTP 200 even when
        // its steps failed, so trusting the status alone would bury the decision/evolve
        // pipeline's failures one level down — the exact blind spot being closed.
        const b = r && r.body;
        if (b && typeof b === 'object') {
          // Attribute failures/skips to the NAMED child steps, not to the @step itself, so
          // the report says "decision/op=redundancy" once — not that plus a bare "@decision".
          const childFails = (b.failed || []).map(f => `${step.slice(1)}/${f}`);
          const childSkips = (b.skipped || []).map(s => `${step.slice(1)}/${s}`);
          childSkips.forEach(s => skipped.push(s));
          done.push({ op: step, status: 'ok', ms, childFails, childSkips });
        } else {
          // No body ⇒ the child was killed/timed out before responding. Unknown, not a
          // failure — honest, and warm's own report will show the root as truncated.
          done.push({ op: step, status: 'dispatched', ms });
        }
      } else {
        done.push({ op: step, status: r && r.ok === false ? `http:${(r && r.status) || '?'}` : 'ok', ms });
      }
    } catch (e) {
      // One bad feed must never cost the rest of the chain.
      done.push({ op: step, status: 'error', error: String((e && e.message) || e).slice(0, 160) });
    }
  }

  const OK = new Set(['ok', 'dispatched', 'skipped:budget']);
  const failed = done.filter(s => !OK.has(s.status));
  const nestedFailNames = done.flatMap(s => s.childFails || []);
  // `failed` transitively includes a nested chain's own failed steps (name-prefixed), so a
  // redundancy-rebuild failure deep under `ledger` reaches warm, not just the child's log.
  const allFailed = [...failed.map(s => s.op), ...nestedFailNames];
  return {
    ok: allFailed.length === 0 && skipped.length === 0,
    name,
    steps: done,
    skipped,
    complete: skipped.length === 0,
    failed: allFailed,
    elapsedMs: now() - started,
  };
}

module.exports = { CHAINS, ROOT_CHAINS, CHAIN_DEADLINE_MS, pathFor, runChain };
