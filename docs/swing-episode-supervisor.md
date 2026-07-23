# Swing Episode Supervisor (`swing-supervisor-v1`)

**Status: SHADOW / accountability layer.** This system makes every published swing pick durable and
honestly accountable. It does **not** claim predictive edge. A better lifecycle and explanation
system improves accountability and usability; it does not by itself prove additional alpha, and
nothing here promotes any strategy out of shadow.

## The product requirement it enforces

> Once the app displays a swing pick, that pick must never disappear without an explanation. It
> stays visible and is re-evaluated against its original thesis, entry plan, subsequent price, market/
> sector conditions, and the algorithm's evolving record until it reaches a documented terminal state.

The mechanism is a daily evaluation **union**:

```
evaluation universe = current swing candidates  ∪  all previously-published non-terminal episodes
```

A pick is re-evaluated even when no current source emits it, it falls below a display cutoff, a
different source now emits it, or the regime changed. It can only leave the board through a
documented terminal state — never by vanishing.

## Root causes it fixes (confirmed against source in the audit)

1. **Current-candidate-only evaluation** — `buildToday` (`lib/decision-routes.js`) built both active
   AND terminal lanes only from today's source signals; the terminal loop iterated today's `all` and
   looked up `prevMap`, never iterating `prevMap` for dropped ids. The persisted snapshot
   (`today/latest.json`) stored no levels/price, so a dropped pick could not even be graded. → picks
   vanished silently. Fixed by the Supervisor union + a levels-carrying immutable origin.
2. **Unstable identity** — the signal id `${source}:${horizon}:${TICKER}` was source-dependent, side-
   less, and reusable. Fixed by `lib/swing-identity.js`: a source-stable `slotKey` + a durable
   `episodeId` embedding ticker/side/horizon/family/version/first-decision-date/setup-generation.
3. **Age defects** — the origin store's `bars` counter advanced only on days the signal was present,
   froze on absent days, and could double-count. Fixed by `lib/swing-sessions.js`: age is **derived**
   from actual bar dates (idempotent, gap-proof, weekend/holiday-aware by construction).
4. **Origin store not an episode system** — stored price geometry only, never joined back for
   disappeared names, reused stale origins within 90 days. Fixed by the immutable episode schema +
   the union + the re-entry policy.
5. **OMEGA hidden Avoid + no ledger join-back** — see `lib/omega-swing-routes.js` / `public/js/omega-swing.js`.
6. **Uniform "model health" sold as adaptive ranking** — a single global scalar that is order-
   preserving. Replaced by `lib/swing-router.js` (algorithm-specific, shrunk, evidence-gated) and
   honest copy in `public/js/opportunities.js`.

## Architecture — small pure modules + thin impure edges

| Module | Responsibility |
|---|---|
| `lib/swing-sessions.js` | Session aging from bar dates (idempotent, gap-proof, holiday-aware) |
| `lib/swing-identity.js` | `slotKey` (stable lookup) + `episodeId` (durable identity) + re-entry policy |
| `lib/swing-episode.js` | Frozen origin + mutable assessment + append-only transitions |
| `lib/swing-evaluate.js` | Next-open fill, leakage-safe barrier, returns/MFE/MAE/excess/momentum/MA/RS/extension/remaining-R:R/consumed% |
| `lib/swing-lifecycle.js` | Deterministic 5-axis state machine (lifecycle/thesis/action/execution/outcome) + reason codes |
| `lib/swing-explain.js` | Reason codes + measured numbers → plain-language explanation |
| `lib/swing-router.js` | Per-algorithm shrunk performance tilt from resolved episodes (shadow) |
| `lib/swing-supervisor.js` | Pure union engine → episodes, transitions, terminals, 7 sections |
| `lib/swing-store.js` | Persistence via `readJSON`/`writeJSON` + the hash-chained `immutable-ledger` |
| `lib/swing-supervisor-routes.js` | `op=swingmonitor` / `op=swinggrade`; fetch sources + candles, persist |
| `public/js/swing-supervisor.js` | Pure renderer of the server-authoritative board |

### Multi-dimensional state (never one collapsed enum)

- **lifecycle**: NEW · WAITING_FOR_TRIGGER · ENTERABLE · TRIGGERED · THESIS_INTACT · WEAKENING ·
  EXTENDED · VALID_BUT_DISPLACED · NO_FILL · INVALIDATED · TARGET_HIT · EXPIRED · DATA_STALE · CLOSED
- **thesis**: STRENGTHENING · INTACT · WEAKENING · BROKEN · COMPLETED · UNKNOWN_STALE
- **action**: ENTER_NOW · WAIT_FOR_BREAKOUT · WAIT_FOR_PULLBACK · HOLD_MANAGE · TIGHTEN_RISK ·
  DO_NOT_CHASE · DO_NOT_ENTER · EXIT_INVALIDATE · NO_ACTION_STALE
- **execution**: SUGGESTED · WAITING · FILLED · NO_FILL · GAP_SKIP · STOPPED · TARGET_REACHED · TIME_EXIT
- **outcome**: PENDING · WIN · LOSS · EXPIRED_POSITIVE · EXPIRED_NEGATIVE · NO_FILL · UNRESOLVED

Reason codes (stable, machine-readable): RANK_CUTOFF, SOURCE_DROPPED, SOURCE_UNAVAILABLE, DATA_STALE,
STOP_BREACH, TARGET_REACHED, ENTRY_NOT_TRIGGERED, GAP_BEYOND_MAX_ENTRY, MAX_HOLD_REACHED, TREND_BREAK,
RS_DETERIORATION, SECTOR_ROLLOVER, REGIME_RISK_OFF, VOLUME_FADE, BREAKOUT_FAILURE, EXCESSIVE_EXTENSION,
EDGE_CONSUMED, RISK_REWARD_INADEQUATE, STRONGER_CANDIDATES, THESIS_STILL_INTACT, SCORE_IMPROVED, …

## Storage keys & schemas

- `swing/episodes.json` — singleton map of every episode (union universe); re-frozen on read, capped.
- `swing/board.json` — last served sectioned board (instant UI serve).
- `swing/resolved.json` — bounded log of resolved unique episodes (router + shadow survival input).
- immutable-ledger stream `swing` — hash-chained, append-once; one `swing-monitor-batch` entry per pass.

## Scheduling — warm chain (idempotent)

`lib/warm-chains.js` → `swing: ['op=swingmonitor&log=1', 'op=swinggrade']`, registered in `ROOT_CHAINS`.
Ordered (monitor writes what grade reads), each step idempotent per session (age derived from bars;
a transition appends only on a real state change), so a budget-skip or double-dispatch cannot double-
age or double-log. **Wired from day one** — the earlier `op=lifecycle`/`op=survival` ops were left
unwired and never aged; this must not repeat.

## Point-in-time / anti-bias guarantees

Next-session executable fills (never the signal-day close); gap-beyond-max-entry is a NO-FILL, not a
chase; both-barriers-in-one-bar resolves pessimistically to the stop; original entry/stop/targets are
immutable (management levels are separate advisory fields); missing data yields nulls, never fabricated
numbers; retired/dropped picks keep being observed (false-retirement measurement); one grade per unique
episode (never per daily snapshot).

## OMEGA integration (shadow preserved)

AVOID transitions now render under a collapsed "No Longer Actionable" section with a derived reason;
the prospective `omega/live` ledger is joined back into the live screen and re-scored (funnel-
displacement carry-forward); `op=omegalog` no longer drops AVOID. Maturity stays `statusOf('omega')`,
probabilities remain evidence bands (never percentages), the survivorship-free `no-edge` verdict is
unchanged, and promotability is untouched.

## What remains in shadow / limitations

- The whole Supervisor is accountability plumbing, **weight-0**; it never originates or boosts a live trade.
- The algorithm router tilts only inside a narrow shrinkage band and is neutral below the per-algorithm
  sample threshold — it needs resolved episodes to accrue before it does anything.
- The competing-risk survival estimates are surfaced as **experimental scores**, not probabilities, and
  extend the existing `lib/challenger-survival.js` (shadow) rather than duplicating it.
- Data provider: free Yahoo daily bars. Sector benchmark depends on the ETF map; a name with no mapped
  sector simply has a null `excessVsSector`. A stale/absent feed yields `DATA_STALE` (last state retained).
