# Catalyst–Flow Ranker — operator runbook

Status: **RESEARCH / SHADOW, weight 0.** Nothing in this runbook can start a live trade;
"live" is refused in code (`lib/catalyst-flow/serving.js resolveMode()`) until every
promotion gate is recorded PASSED **and** a manual registry change is made.

Companion docs: preregistration/schema/result → `docs/catalyst-flow-ranker.md`;
final report → `research/results/catalyst_flow_report.md`; data gaps → `docs/blocked-on-data.md` §9.

## 1. Ingest (event ledger + features)

```bash
node research/88-catalyst-flow-ledger.js     # append-only PIT event ledger + reference ingestion
node research/89-catalyst-flow-features.js   # frozen feature snapshots, targets, grades, manifests
```

- Both steps are **append-only**: vendor revisions append a new version keyed by
  `eventRevision`; nothing overwrites an earlier observation.
- Outputs + coverage manifests land in `research/data/catalyst-flow/` (git-ignored).
- The ledger stamps `pitClass` from what it measured. Do not hand-edit it: family A is
  `RECONSTRUCTED_EXPLORATORY` until a provider-timestamped consensus source exists.

## 2. Train (offline Python — never in a request path)

```bash
python3 -m venv research/catalyst_flow/.venv
research/catalyst_flow/.venv/bin/pip install -r research/catalyst_flow/requirements.txt
brew install libomp    # macOS: LightGBM's OpenMP runtime
research/catalyst_flow/.venv/bin/python research/catalyst_flow/train_lambdamart.py --arm E2_CATALYST_RANKER
```

- LightGBM missing ⇒ the trainer **exits with the setup command**; it never silently
  substitutes another model.
- Every run appends to `research/data/catalyst-flow/trials.jsonl` (the DSR trial registry)
  and writes `model-meta.json` with dataset SHA-256, config, and cutoffs. Do not delete
  trials to make DSR look better — the deflation uses the full registry by design.

## 3. Score / evaluate

```bash
node research/90-catalyst-flow-arms.js       # locked arms E0–E3, paired ablations, FDR, DSR
node research/91-catalyst-flow-publish.js    # build the versioned daily artifact (add --publish to upload)
node research/92-catalyst-flow-report.js     # regenerate research/results/catalyst_flow_report.{json,md}
```

- Arms always run on **identical eligible cohorts**; if a data source is absent the arm
  reports `INSUFFICIENT_DATA` — never a verdict on alpha.
- The artifact is validated against `lib/catalyst-flow/artifact.js` before serving; a
  stale artifact (decision date too old) serves as `STALE`, not as fresh ranks.

## 4. Shadow-monitor

- UI: **Research Lab → ⚡ Catalyst–Flow (research)** tab; API: `/api/tracker?op=catalystflow`
  (read-only; serving never trains).
- Watch on each refresh: `state` (`INSUFFICIENT_DATA`/`RESEARCH`/`SHADOW`), the
  signed-options coverage flag, data-quality warnings, and abstention (`NO TRADE` is a
  normal, valid output — most dates abstain by design).
- Prospective evidence accrues only via the append-only artifacts; the promotion clock
  needs **≥ 50 prospective shadow decision dates** with stable coverage.

## 5. Rollback

- Kill the surface: set `CATALYST_FLOW_ENABLED=false` (default) — the app builds and runs
  with every catalyst variable absent.
- Bad artifact: delete/replace the artifact at `CATALYST_FLOW_PREDICTIONS_PATH` and re-run
  step 3; the serving layer fail-closes on schema validation, it never patches in place.
- Bad model: retrain from a prior dataset snapshot (hashes in `model-meta.json` identify
  exactly what any artifact was built from). History is append-only, so rollback is
  re-pointing, never rewriting.

## 6. Promotion (explicit, manual, two-stage)

1. All historical gates in `lib/catalyst-flow/config.js PROMOTION_GATES` recorded PASSED on
   **immutable PIT evidence** (today: 6 of 7 fail — see the final report). Passing them
   justifies only `PROMOTE_TO_PROSPECTIVE_SHADOW`.
2. Then ≥ 50 append-only prospective shadow dates with positive cost-net sector-relative
   alpha, stable coverage, no timestamp-reconstruction failures, no material collapse vs
   the locked historical estimate.
3. Only then: a **manual, reviewed registry/config change** may assign nonzero weight.
   No automated path exists on purpose; do not add one.
