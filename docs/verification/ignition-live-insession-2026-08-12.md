# IGNITION Live — first in-session verification

**Verdict: GREEN**

- Date: 2026-08-12 (Wednesday, regular trading day, no holiday)
- Verification time: ~11:00 AM ET (15:00 UTC), ~90 minutes after open
- Target: `https://market-news-app-chi.vercel.app` (prod alias only — no deployment URLs used)
- Subject: IGNITION Live (PR #312, merged 2026-08-11, commit `a0d4e71`), confirmed as an
  ancestor of current `origin/main` (`773fcc5`)
- Source read before testing: `lib/ignition-live-routes.js`, `lib/ignition-live.js`

## Check 1 — `op=ignitionlive`

```
curl -sS 'https://market-news-app-chi.vercel.app/api/tracker?op=ignitionlive'
```

Result: HTTP 200.

```json
{
  "ok": true,
  "ignitionLiveVersion": "ignition-live-v1",
  "schemaVersion": "lowfloat-schema-v1",
  "sessionDate": "2026-08-12",
  "snapshotGeneratedAt": "2026-08-12T14:56:50.247Z",
  "snapshotAgeMinutes": 4,
  "snapshotStale": false,
  "regime": "risk-on",
  "universeRanked": 617,
  "defaultSort": "opportunityScore desc — deliberately NOT percent change"
}
```

- `views.length` = 250, `alerts.length` = 3.
- Sample view (top of board, sorted desc by `opportunityScore`):

```json
{"ticker":"FGL","ignitionScore":47,"opportunityScore":25,"stage":"CONFIRMING",
 "extensionRisk":11,"extensionLabel":"NORMAL","catalystGrade":"B",
 "supplyPressureScore":85,"floatTier":"ULTRA_LOW","doNotChasePrice":0.84,
 "haltStatus":"UNKNOWN — no halt/LULD feed on this stack",
 "dataQuality":{"quality":"MEDIUM","feed":"DELAYED","note":"5-minute completed-bar resolution — never real-time on this stack"},
 "attention":{"rankNow":11,"rank5mAgo":12,"rank10mAgo":12,"rank20mAgo":6,"velocity":-0.25,"surge":false}}
```

Programmatic checks against all 250 views:

| Check | Result |
|---|---|
| Sorted by `opportunityScore` descending | **PASS** — verified strictly non-increasing across all 250 |
| All 10 required fields present on every view (`ignitionScore`, `opportunityScore`, `stage`, `extensionRisk`, `extensionLabel`, `catalystGrade`, `supplyPressureScore`, `doNotChasePrice`, `dataQuality`, `haltStatus`) | **PASS** — 0 missing across 250 views |
| `haltStatus` contains `'UNKNOWN'` on every view | **PASS** — 0 violations |
| Rule-4: `extensionLabel === 'PARABOLIC_EXIT_BIAS'` AND `opportunityScore > 40` | **PASS** — 0 violations found |
| `floatTier === 'UNKNOWN'` AND `supplyPressureScore > 0` | **PASS** — 0 violations found |
| `snapshotAgeMinutes` | **PASS** — 4 minutes (≤ 20, well within freshness bound) |

No red flags. Check 1: **PASS**.

## Check 2 — `op=ignitionreplay&date=2026-08-12`

```
curl -sS 'https://market-news-app-chi.vercel.app/api/tracker?op=ignitionreplay&date=2026-08-12'
```

Result: `ok:true`, `frameCount: 18`.

```
frame at 2026-08-12T13:20:48.136Z  views: 0   alerts: 0   (premarket, before 13:30 UTC open)
frame at 2026-08-12T13:25:53.330Z  views: 0   alerts: 0
frame at 2026-08-12T13:30:58.872Z  views: 15  alerts: 0   (open)
frame at 2026-08-12T13:36:04.085Z  views: 15  alerts: 1
frame at 2026-08-12T13:41:08.218Z  views: 15  alerts: 3
frame at 2026-08-12T13:46:16.944Z  views: 15  alerts: 0
frame at 2026-08-12T13:56:12.470Z  views: 15  alerts: 4
frame at 2026-08-12T14:01:20.188Z  views: 15  alerts: 1
frame at 2026-08-12T14:06:27.917Z  views: 15  alerts: 1
frame at 2026-08-12T14:11:25.529Z  views: 15  alerts: 5
frame at 2026-08-12T14:16:31.115Z  views: 15  alerts: 5
frame at 2026-08-12T14:21:32.834Z  views: 15  alerts: 1
frame at 2026-08-12T14:26:33.878Z  views: 15  alerts: 4
frame at 2026-08-12T14:31:37.166Z  views: 15  alerts: 3
frame at 2026-08-12T14:36:41.000Z  views: 15  alerts: 4
frame at 2026-08-12T14:41:43.583Z  views: 15  alerts: 2
frame at 2026-08-12T14:46:48.139Z  views: 15  alerts: 4
frame at 2026-08-12T14:56:50.247Z  views: 15  alerts: 3
```

`frameCount = 18 >= 2`. Frames accrue at roughly 5–10 minute spacing since ~13:20 UTC (premarket)
and are consistently populated from the 13:30 UTC open onward — matches the expected ~10 min
scheduled cadence plus GitHub Actions jitter, which the workflow's own header comment
acknowledges ("real cadence is ~5–15 min with jitter"; `.github/workflows/daytrade-scan.yml`
lines 25–27). Cross-checked against Actions logs (see Check 4): the `Low-float ignition tick`
step self-skips scheduled runs that don't land on a `minute % 10 == 0` boundary
(`daytrade-scan.yml` lines 116–120), so wall-clock frame spacing is uneven but never violates
the ≥10-min self-skip contract. Check 2: **PASS**.

## Check 3 — Attention rank history

Across the 250 views in the Check 1 snapshot:

- 250 / 250 views carry an `attention` object with a numeric `rankNow`.
- 206 / 250 views have `rank5mAgo` / `rank10mAgo` populated (the remainder are names that
  weren't present in a prior scan yet — expected, not a defect).
- 206 / 250 views have `velocity` populated, consistent with the above.
- Sample:

```json
{"version":"attention-rank-v1","rankNow":11,"rank5mAgo":12,"rank10mAgo":12,"rank20mAgo":6,
 "velocity":-0.25,"velocityWindowMin":20,"acceleration":1.26,"surge":false,
 "turnoverVelocityPerMin":0.0049,"universeRanked":617,
 "basis":"nearest-stamp lookback at ~20-minute window; scan cadence ~10 min"}
```

Not all-null; rank history is populating correctly on names present across consecutive scans.
Check 3: **PASS**.

## Check 4 — GitHub Actions cross-check

`gh`-equivalent access used via the GitHub MCP tools (no `gh` CLI in this environment).

Latest 5 runs of `daytrade-scan.yml`:

| run_id | status | event | started_at |
|---|---|---|---|
| 31610035350 | in_progress | workflow_dispatch | 2026-08-12T15:01:34Z |
| 31609563251 | success | workflow_dispatch | 2026-08-12T14:56:31Z |
| 31608875864 | success | schedule | 2026-08-12T14:49:05Z |
| 31608638343 | success | workflow_dispatch | 2026-08-12T14:46:27Z |
| 31608167733 | success | workflow_dispatch | 2026-08-12T14:41:24Z |

Job log excerpt from run `31609563251` (matches the snapshot read in Check 1 —
`generatedAt: 2026-08-12T14:56:50.247Z`), step "Low-float ignition tick":

```
manual dispatch — running regardless of the 10-minute gate
{"ok":true,"skipped":null,"reason":null,"candidatesRanked":250,"alertsEmitted":10,
 "events":0,"snapshots":{"discovery":"written","ignition":"written","continuation":"written"},
 "elapsedMs":9660,"quotes":4710,"volume":true,"discovered":617,"float":119,"bars":60}
```

Note: the workflow's `jq` summary filter (`daytrade-scan.yml` lines 132–139) extracts
`{ok, skipped, reason, candidatesRanked, alertsEmitted, events, snapshots, elapsedMs, quotes,
volume, discovered, float, bars}` from the `op=lowfloattick` response — it does **not**
separately surface a top-level `ignitionLive` key in the printed CI summary, so that exact
field name specified in the task brief is not visible in the trimmed log. This is a logging
choice, not a defect: `snapshots.ignition: "written"` confirms the ignition snapshot write
succeeded with `ok:true` and `candidatesRanked:250`, and the live-read in Check 1 directly
confirms `views.length = 250` on that same snapshot (`generatedAt` matches exactly). Treating
this corroboration as sufficient rather than a gap requiring a code change, per the brief's
no-code-changes instruction.

Also confirmed the 10-minute self-skip gate is live and working: the scheduled run at
`14:49:05Z` (event=`schedule`) completed its "Low-float ignition tick" step in 0 seconds
(`14:49:23Z → 14:49:23Z`, `minute 49 % 10 != 0` → skip), exactly matching the gate logic at
`daytrade-scan.yml` lines 116–120.

Check 4: **PASS** (with the logging-visibility note above; no evidence of any `ok:false`).

## Check 5 — Dilution + alerts (informational)

Dilution label distribution across the 250 views in the Check 1 snapshot:

```
UNKNOWN:  222   (expected — only records with explosionPotentialScore >= 45 get EDGAR enrichment per-tick)
LOW:       19
MODERATE:   6
HIGH:       1
EXTREME:    2
```

Alerts present in the snapshot (`alerts[]`, 3 total):

```json
{"id":"ignition|BQ|PARABOLIC_WARNING","ticker":"BQ","state":"PARABOLIC_WARNING",
 "message":"BQ: PARABOLIC — do not chase, exit bias. Ignition 46/100, Opportunity 1/100, stage PARABOLIC, extension 82/100."}
{"id":"ignition|FRTT|ATTENTION_SURGE","ticker":"FRTT","state":"ATTENTION_SURGE",
 "message":"FRTT: attention surging. Attention #228 → #18. Ignition 31/100, Opportunity 25/100, stage BREAKOUT, extension 22/100."}
{"id":"ignition|LIFE|ATTENTION_SURGE","ticker":"LIFE","state":"ATTENTION_SURGE",
 "message":"LIFE: attention surging. Attention #263 → #24. Ignition 21/100, Opportunity 25/100, stage CONFIRMING, extension 7/100."}
```

Note the `BQ` `PARABOLIC_WARNING` alert (`opportunityScore: 1`) is itself a live example of
rule-4 behavior working as intended — parabolic extension correctly suppressing opportunity
score, well under the 40-point ceiling checked for violations in Check 1. This is informational
only; per the task brief, a quiet-tape alert count is not graded as a failure either way.

## Overall verdict: GREEN

Checks 1–3 all pass cleanly: the snapshot is fresh (4 minutes old), sorted correctly, carries
every required field with no rule-4 violations and no float/supply-pressure inconsistency,
replay frames are accruing through the session, and attention rank history is populating for
returning names. Check 4 (GitHub Actions) corroborates the same write via CI logs, modulo a
minor logging-visibility note (not a defect) documented above. Check 5 is informational and
unremarkable for a quiet mid-morning tape.

No code was modified as part of this verification. No privileged ops were invoked (this
session holds no `CRON_SECRET`).
