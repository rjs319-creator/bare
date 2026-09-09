# llm-ledgers — does ANY LLM-produced signal in this app show positive out-of-sample evidence? (2026-09-09)

Sources: /tmp/alpha-swarm/scoreboard.json + maturity.json (13:03 UTC), and read-only ops pulled after verifying
their handlers contain no writes (op=alerts lib/alerts-routes.js:234, op=challengereval lib/challenger-routes.js:287,
op=stbull lib/stbull-routes.js:72, op=dualreadbook lib/dualread-routes.js:168, op=techev, op=hypotheses, op=evidence,
op=forecastboard). NOT pulled (writer handlers): op=gameplan (lib/gameplan-routes.js:100, 3 writes), op=bearcase
(lib/bearcase-routes.js:36), op=predict (lib/predict-routes.js:49), op=calibration (lib/calibration.js:210).
All scoreboard records below are PROSPECTIVE (written by the daily *tick/*log ops before outcomes; cost-net vs SPY,
date-clustered CI95, 4 chronological blocks). "n" = resolved picks, "dates" = independent decision dates.

## Verdict

**No LLM-produced signal has a positive cost-net record with a date-level CI clear of zero on ≥20 independent dates.**
The nearest is CrossAsset:Lead at 5d (+1.94%, CI [0.06, 4.91], 25 dates, 4/4 blocks) — the prior pass showed it is
sector beta (+0.17% vs sector; the model's "Weak" tier out-performed "Lead"; one risk-on window; app FDR q 0.20).
Several LLM signals are significantly NEGATIVE. Most LLM outputs are never scored at all.

## Ranked inventory

| # | Component (model) | LLM decides… on… | Graded where | Prospective record | Call |
|---|---|---|---|---|---|
| 1 | CrossAsset (Haiku 4.5 + web_search, lib/crossasset.js) | names ≤8 "levered" tickers + LEAD/INLINE/WEAK lag label from a macro theme | scoreboard CrossAsset:* (1m contract) | Lead 5d +1.94 [0.06,4.91] 25d 4/4; 1m +3.48 [0.89,8.21] 17d 3/4; Inline 1d −0.79 [−1.89,−0.03] 21d; Weak 1m +4.90 (11d). maturity: promising, 63 resolved, 17 dates | nominal positive = sector/theme beta; label adds nothing (Weak ≥ Lead) |
| 2 | Alerts Fable review A/B (Fable 5.1, lib/alerts-fable.js) | re-reads each social post: direction, credibility, pump risk | op=alerts `fableEdge` paired hit-rate vs mechanical direction (lib/alerts-routes.js:250-277) | n=424 paired, Fable 47.9% vs bot 46.9%, LB90 43.9%, 168 overrides at 50.6%; adaptive policy FROZEN, promoted:false. Whole xalerts strategy: validation INCONCLUSIVE 3/25 dates, weight 0 | no margin (+1.0pt, LB below base); hit-rate only, not cost-net excess |
| 3 | stbull AVOID (LLM-tagged StockTwits bull-ratio, lib/stbull-routes.js) | flags crowded bullish names to AVOID | own prospective ledger | 11 ledger days, 7/50 resolved dates, running mean +0.018% 5d excess (wrong sign for an AVOID prior) | too early; trending wrong way |
| 4 | Challenger decision (Haiku event-surprise `challenger-events` is one input, lib/challenger-routes.js) | four-outcome trade read from 18 sources | op=challengereval rankquality | n=1026: IC −0.08, t −2.57 SIGNIFICANT, rho −0.40 (top bucket −2.61%, 23% win vs base 38%); promotion 2/11 criteria, PBO 0.70 | INVERTED — the score ranks losers first |
| 5 | Evidence/thesis engine (Haiku extraction, lib/evidence-extract.js → Evidence:EV_*) | news/docs → structured events → thesis strength | scoreboard Evidence:* ; maturity `thesis` | EV_MODERATE 1d −0.79 [−1.44,−0.20] 20 effN 0/4; 1m −7.57 [−19.95,−2.27] 9d 0/4; EV_STRONG 5d −0.22 [−2.80,0.98] 13d; thesis pooled −6.1% over 52, CI [−19.95,−2.27] | NEGATIVE; the "stronger evidence" tier is not better than moderate |
| 6 | SecondWave (Haiku, lib/secondwave.js) | reflexive-attention forecast: Primed/Early/Faded | scoreboard SecondWave:* | Primed 5d −5.41 [−9.54,−1.85] 20d 1/4; 1m −8.96 [−17.89,−0.02] 7 effN; Early 1d −1.61 [−2.82,−0.76] 26d 0/4; Faded 5d −1.85 (24d, 0/4) | NEGATIVE across tiers |
| 7 | Biotech AI (Haiku interprets a verified-event bundle, lib/biotech-ai.js) | catalyst archetype/verdict from cited sources | scoreboard Biotech:* (XBI bench) | Watch 1d −1.44 [−2.60,−0.35] 34d 0/4; Emerging 5d −5.04 [−11.18,−0.67] 10d 0/4; Hot n=8 | negative/thin |
| 8 | Anomaly (Haiku, lib/anomaly.js) | "what's being repriced" explanation | scoreboard Anomaly:Explained | n=18, 9 dates, 5d −3.85 [−9.53,4.45]; maturity "promising" on 9 resolved / 4 dates at 1m (+0.55, CI [−25,38]) | ungradeable — the `promising` label rests on 4 dates |
| 9 | ReadThrough (Sonnet 5, lib/readthrough.js) | second-order beneficiaries of a mover | scoreboard ReadThrough:* | n≤8, ≤4 dates, all negative point estimates (5d −5.45 / −7.43) | ungradeable |
| 10 | ToneShift / Tone (Haiku, lib/toneshift.js, lib/earnings-tone.js) | earnings-call language delta / tone | scoreboard ToneShift:*, Tone:* | n=1–5, ≤5 dates | ungradeable (transcripts plan-gated) |
| 11 | Gridlock events (Haiku, lib/gridlock-events.js) | physical-constraint event extraction | scoreboard Gridlock:Tracked | n=10, 1 date | ungradeable |
| 12 | Dual-read Fable narrative (Fable 5.1, lib/dualread-fable.js) | stance/setup-class narrative over the mechanical quadrant | **NOT scored** — op=dualreadbook grades the MECHANICAL quadrant only (byQuadrant: every quadrant +2.5..+13% at 21d, n=20–76, gross-of-nothing note says cost-net; all-positive = universe drift, not selection); the LLM `stance` field is never read by any grader (grep lib/dualread-routes.js: none) | display only |
| 13 | Game plan (Opus 4.8, lib/gameplan.js + gameplan-reflection.js) | daily tone (bullish/bearish) + headline | own reflection ledger: toneRecord right/wrong/flat vs SPY N sessions (lib/gameplan-reflection.js:124) — a hit-count, no cost, no CI, no benchmark beyond sign; served only through the writer op (not pulled) | display/prompt-feedback only |
| 14 | Bear case (Haiku, lib/bearcase.js) | adversarial read per Today pick | none (explicitly "not a rank input"; bearcasetick is a writer) | never scored |
| 15 | Predict suite (Haiku, lib/predict-routes.js) | falsifiable macro/stock predictions | own auto-graded correct/incorrect record (op=predict is a writer → not pulled). lib/feedback-digest.js:31-37 carries an INVERTED/NOISE verdict branch for its conviction score | hit-rate only; memory: feedback loop dormant until ≥15/class |
| 16 | Options-flow Fable layer (lib/optionsflow-fable.js), pulse2 refine (Haiku), universe curation (Fable), narrative tags (api/screener.js, apex `tag_narrative`) | analysis prose / editorial refine / universe tail curation / narrative tag | none of the LLM outputs is graded (narrative win-rate-by-tag exists in apex drift but promotion gate ≥30 signals/tag never reached) | display only |
| — | Attention (mechanical, not LLM) | — | disabled | −2.1% over 378 / 22 dates | included only because the prior pass flagged its score as inverted |
| — | Tech-command evidence (op=techev) | NOT LLM (SEC/npm/GitHub facts) | scorecard all arms COLLECTING, 0 resolved per arm | n/a |

Research registry (op=hypotheses): 43 trials, 0 confirmed, 24 no-edge, 2 provisional, 25 in the graveyard; the LLM-adjacent
trials (peer-underreaction-formula, alphagen-compact-formulas, nsl-novel-engines, quiet-accumulation) are all no-edge/retired.

## Plain summary
- Positive, CI clear of zero, ≥20 dates: **none** (CrossAsset:Lead is the only nominal candidate and is beta).
- Significantly negative: challenger-decision score (inverted, n=1026), Evidence/thesis, SecondWave (all tiers), Biotech:Watch 1d, CrossAsset:Inline 1d.
- Flat / no margin: Alerts Fable review (+1.0pt hit-rate, n=424, frozen), stbull (7/50).
- Ungradeable (n<20 or ≤5 dates): Anomaly, ReadThrough, Tone/ToneShift, Gridlock.
- Never scored at all: dual-read narrative, bear case, options-flow analysis, pulse refine, universe curation, narrative tags, game plan (sign hit-count only), predict (hit-count only).
Pattern: where an LLM output IS graded prospectively it is flat or negative; where it looks good it is either
unscored, thin, or a beta exposure. The only LLM layer with a proper paired A/B (alerts) shows no margin.
