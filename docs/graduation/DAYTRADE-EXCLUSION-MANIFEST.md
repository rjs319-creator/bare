# Day Trade Exclusion Manifest — Graduation League pass (2026-08-12)

The following paths are Day Trade scope. They were **enumerated but not audited,
benchmarked, retrained, copied, called, or modified** by the graduation-league
pass. No Day Trade candidate list, label, outcome, portfolio, training set, or
research conclusion was used as evidence, universe, feature, filter, target,
baseline, or ensemble member for any non-DT strategy.

- `lib/daytrade.js`, `lib/daytrade-actionability.js`, `lib/daytrade-alerts.js`,
  `lib/daytrade-config.js`, `lib/daytrade-decision-policy.js`,
  `lib/daytrade-early-state.js`, `lib/daytrade-scan-runner.js`
- `lib/intraday-{actionability,backlog,capture,continuation,costs,data,dataset,discovery,features,labels,outcomes,schema,training,validation}.js`
- `lib/lowfloat-{alerts,config,pipeline,routes,store}.js`, `lib/low-float-ignition.js`
- `lib/ignition-live.js`, `lib/ignition-live-config.js`, `lib/ignition-live-routes.js`
- `lib/tech-command-daytrade.js`, `lib/runner-capture.js`, `lib/runner-dud.js`
- `api/tracker.js` DT ops: `daytrade*`, `discover`, `lifecycle*`, `survival`,
  `datasetgrade`, `datasetsurvival`, `lowfloat*`, `intraday*`, `largemover*`,
  `positionsize`, `ignitionlive`, `ignitionreplay`, `ignitionleadtime`,
  `floatprobe`, `quoteprobe`, `feed`, `model*` (train/promote/challenger/rollback/status)
- `/feed/daytrade.md` and `/feed/daytrade.json` rewrites (`vercel.json`)
- `.github/workflows/daytrade-scan.yml`
- `public/js/lowfloat.js`, `public/js/ignition-live.js`

Verification: `git diff --stat` for this pass touches none of the paths above.

Shared infrastructure that non-DT code imports from DT modules (feature helpers,
config constants, schemas) is documented as "DT → non-DT influence crossings" in
`STRATEGY-CENSUS-2026-08-12.md` and was left byte-identical; isolating those
imports without changing DT behavior is future work with its own test plan.
