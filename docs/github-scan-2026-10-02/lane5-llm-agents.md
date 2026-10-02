# Lane 5 — LLM / agent frameworks for finance

## Lane summary
Surveyed 52 repos via `gh api repos/*` (search API was shared-rate-limited mid-run, so coverage came from named lookups + 2 successful searches) across: finance LLM/agent frameworks (FinGPT, FinRobot, FinMem, ai-hedge-fund, TradingAgents + 8 top forks, StockAgent, FinAgent x3, AlphaAgent, RD-Agent), SEC-filing stacks (edgartools, sec-parser, edgar-crawler, sec-insights, sec-edgar-mcp/toolkit), eval sets (FinanceBench, FinQA, PIXIU/FinBen, vals finance-agent, ForecastBench), eval/judge tooling (promptfoo, autoevals, deepeval, ragas, langfuse, instructor, guardrails), Anthropic repos (cookbooks, quickstarts, plugins, SDK) and 12 finance MCP servers. **Headline: nothing in the picker category survives (confirms the 2026-09-09 verdict); the real gaps the survey exposes are in the site's own LLM harness — it has zero token/cost accounting (`usage.*` never read in `lib/`), no golden-set regression eval for its 29 Claude call sites, and no LLM-as-judge/grounding check on `evidence-extract` — all of which are Node-native, cheap, and directly required by the already-preregistered EDGAR AVOID pilot (≥90% extraction agreement gate).** Finance MCP servers are usable through the Messages-API MCP connector but add round-trips that do not fit 40s Vercel calls; the FMP MCP is useful as a *reference schema*, not a runtime dependency.

## Candidates

| Repo | Stars | Last push | License | Lang | What it does | Fit | Verdict |
|---|---|---|---|---|---|---|---|
| promptfoo/promptfoo | 25.6k | 2026-10-01 | MIT | TS | Prompt/agent eval CLI: golden tests, `llm-rubric`, `factuality`, `context-faithfulness`, `g-eval`, MCP provider | Regression eval for 29 Claude call sites (`lib/fable-call.js`, `evidence-extract`, `tone-routes`, `pulse-enrich`); pain point "tests that couldn't fail" | ADOPT (dev-dep, offline) |
| braintrustdata/autoevals | 1.0k | 2026-10-01 | MIT | TS+Py | Vendorable LLM-judge scorers (Factuality, ClosedQA, Summary, JSON diff) with YAML prompt templates, Anthropic provider | Runtime judge for extraction agreement in the EDGAR AVOID pilot; `evidence-consensus.js` | PORT (vendor 3 templates, ~200 lines) |
| anthropics/claude-cookbooks | 53.1k | 2026-09-28 | MIT | nb | `observability/usage_cost_api`, `cost_optimization`, `tool_evaluation` (XML golden tasks), `evals/agentic_search` | Cost ledger pattern; eval format | REFERENCE |
| patronus-ai/financebench | 367 | 2024-12 | none (data CC?) | nb/JSONL | 150 open 10-K QA pairs with evidence page + text | Golden set to QA the site's filing-section extraction | RESEARCH-ONLY |
| dgunning/edgartools | 2.8k | 2026-10-01 | MIT | Py | Typed 8-K items, Form 4, XBRL, 20+ forms; MCP server | Reference for an 8-K **item-typed** event schema (site already has item numbers in `lib/edgar.js:148` but no typed payload) | REFERENCE/PORT (schema only) |
| alphanome-ai/sec-parser | 294 | 2026-06 | MIT | Py | 10-K/10-Q HTML → semantic tree (sections, tables) | Section-scoped extraction so Haiku sees only Item 1A/7, not the whole filing | PORT (small; Node `htmlparser2`-free regex port feasible) |
| imbenrabi/Financial-Modeling-Prep-MCP-Server | 149 | 2026-07 | Apache-2.0 | TS | 250+ FMP tools, toolsets, hosted | Tool-schema reference for FMP endpoints the site lacks (bulk quotes, transcripts absent anyway) | REFERENCE |
| stefanoamorelli/sec-edgar-mcp | 362 | 2026-10-01 | AGPL-3.0 | Py | EDGAR MCP (CIK, 10-K/8-K sections, XBRL, Form 3/4/5) + **promptfoo eval suite for tools** | Eval-pattern reference; AGPL blocks vendoring | REFERENCE |
| ferdousbhai/investor-agent | 347 | 2026-09 | MIT | TS | 7-tool MCP on Cloudflare Workers (yfinance-style data) | Shows Node MCP on serverless; data already wired | REJECT (duplicate data) |
| forecastingresearch/forecastbench(+datasets) | 87/40 | 2026-09-30 | MIT/CC-BY-SA | Py/JSON | Contamination-free LLM forecasting benchmark, Brier-scored, human baselines | Prompt pattern for calibrated-probability output in `gameplan-reflection` | REFERENCE |
| microsoft/RD-Agent | 14.8k | 2026-09-30 | MIT | Py | RD-Agent(Q): LLM proposes factors, Qlib backtests, loops; `fin_factor_report` extracts factors from papers | Hypothesis-generation front-end to the preregistered registry (offline) | RESEARCH-ONLY |
| RndmVariableQ/AlphaAgent | 418 | 2026-07 | none | Py | DSL factor zoo + LLM factor mining (A-shares) | Same as above, worse (no license, CN data) | REJECT |
| TauricResearch/TradingAgents | 109k | 2026-09-29 | Apache-2.0 | Py | Multi-agent debate trader | Already audited/adopted (PRs #382-389) | REFERENCE (done) |
| virattt/ai-hedge-fund | 63.8k | 2026-10-01 | MIT | Py | Persona agents; now hash-chained paper-trade ledger + backtester | Picker; ledger idea already built (provenance spine) | REJECT |
| AI4Finance-Foundation/FinRobot | 8.1k | 2026-09-28 | Apache-2.0 | Py | Lead+5 pipeline+bull/bear/judge agents, 10-K→PDF report | Bear/judge already built; report gen not wanted | REJECT |
| AI4Finance-Foundation/FinGPT | 21.3k | 2026-09-23 | MIT | nb | Fine-tuned sentiment/forecaster LoRAs | Fine-tuning is out of stack; forecaster = picker | REJECT |
| vals-ai/finance-agent | 161 | 2026-09 | MIT | Py | Finance agent benchmark (EDGAR+web tools); platform gated | Gated data; harness idea covered by promptfoo | REJECT |
| alpacahq/alpaca-mcp-server | 1.0k | 2026-09 | MIT | Py | Trading + data MCP | No brokerage; data duplicated | REJECT |
| OpenBB-finance/OpenBB | 73.7k | 2026-10-01 | custom | Py | Data platform with MCP | Python, data duplicated | REJECT |
| langfuse/langfuse | 35.3k | 2026-10-02 | custom (MIT core) | TS | LLM tracing/cost platform | Self-host/cloud overkill; a Blob ledger suffices | REJECT |

Also screened (32 more, all REJECT): FinMem, Stockagent, 6 FinAgent namesakes, 8 TradingAgents forks, sec-insights, FinQA, PIXIU/FinBen, finBERT, ECTSum, financial-datasets/polygon/octagon/yfinance/akshare MCPs, edgar-crawler, sec-edgar-toolkit, sec-downloader, instructor(-js), deepeval, ragas, guardrails, vectara hallucination-leaderboard, openai/evals, claude-quickstarts, claude-plugins-official, modelcontextprotocol/servers — reasons in the last section.

## Top proposals

### 1. ADOPT promptfoo as the LLM regression harness (effort S)
- **Build:** `research/llm-evals/promptfooconfig.yaml` + one golden `tests/*.yaml` per prompt family (evidence-extract, earnings tone, pulse narrative, bear case, gameplan reflection). Cases = 20-40 frozen headline sets with expected typed events; assertions = `is-json`/schema, `javascript` (sourceIndexes ⊆ inputs, numbers appear verbatim in a cited headline), and `llm-rubric` graded by `claude-haiku-4-5-20251001`. Run via `npx promptfoo eval` in `npm run eval:llm` (devDependency only — nothing ships to Vercel).
- **Plugs in:** reuses `buildFableRequest`/parsers exported from `lib/fable-call.js`; a tiny custom provider file calls the site's own request builders so the eval tests the *exact* request shape, not a re-typed prompt.
- **Why:** `PROMPT_VERSION` bumps are currently unverified; the EDGAR pilot's stop rule ("disagreement >10%") has no instrument. Fixes the "tests that couldn't fail hid 5 defects" lesson for the LLM layer.
- **Risk:** promptfoo is a large dev-dep (fine, offline); eval runs cost real tokens — cap with `maxConcurrency` and Haiku; never run in CI on every push, run on prompt changes.
- **Measured:** pass-rate per prompt family stored in `research/llm-evals/results/*.json`; a drop blocks the `PROMPT_VERSION` bump.

### 2. PORT autoevals' Factuality/ClosedQA templates as an in-pipeline extraction judge (effort S-M)
- **Build:** `lib/llm-judge.js` — vendor `templates/factuality.yaml` + `closed_q_a.yaml` (MIT) as JS string constants, run through `callFableTool`-style Haiku call with a strict `submit_grade` tool returning `{choice, rationale}`; map choices to 0/0.4/0.6/1 as autoevals does. Apply as **shadow-only second reader** on a 10% sample of `evidence-extract` outputs: judge asks "is each event supported verbatim by the cited headlines?" Store `judge/v1/YYYY-MM-DD.json` in Blob (writeChecked) with agreement rate.
- **Fix found en route:** `lib/evidence-extract.js:124` returns `{events: [], called:true}` for refusal/empty/failed alike — the judge ledger needs `refused` surfaced from `callFableTool` so the >10% disagreement/data-gap stop rule can be computed honestly.
- **Plugs in:** `evidence-consensus.js` reads agreement; `hypothesis-registry` gate for the EDGAR AVOID pilot consumes "≥90% extraction agreement."
- **Risk:** doubles Haiku spend on sampled tickers (bounded by sample); judge shares model family (mitigate: judge uses Haiku, extraction uses Haiku → also run a 2% Fable 5.1 adjudication slice).
- **Measured:** agreement rate per `PROMPT_VERSION`, by event type; promotion gate for extraction prompts.

### 3. ADOPT a token/cost ledger in `fable-call.js` (effort S)
- **Build:** every response already carries `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`; none is read. Add `recordUsage({callSite, model, usage})` into a daily Blob doc `llm/usage/YYYY-MM-DD.json` (append-safe: per-callSite counters, union on RMW per the Blob-lag rule) with a static price table (Haiku 4.5 $1/$5, Fable 5.1 $10/$50 per MTok, cache read discount). Expose in `op=health` and cap: the pilot spec's stop rule is "> $200/mo" and today it is unmeasurable. Pattern from cookbook `observability/usage_cost_api.ipynb` (Admin API is curl-only; per-response usage is simpler and needs no admin key).
- **Risk:** none material; prices hardcoded → constants file, bump with model changes.
- **Measured:** $/day per call site; alarms on a 2x day-over-day jump (cheap detector of fan-out bugs like the 2,800-fetch swingsearchgrade incident).

### 4. PORT sec-parser's section segmentation + edgartools' 8-K item typing (effort M, RESEARCH-first)
- **Build:** `lib/edgar-sections.js` — regex/heading segmentation of 10-K/10-Q/8-K HTML into Items (sec-parser's heuristics are ~1k lines Python; the Item-boundary subset ports in ~200 lines Node). Feed only Item 1A/7/2.02/8.01 text to Haiku with a ≤5-type strict event tool (dilution, going-concern, restatement, guidance-cut, auditor-change) — exactly the preregistered EDGAR AVOID pilot's schema stage. Use FinanceBench's 150 QA pairs (evidence_page + text) as the **offline golden set** for the sectioner: does the extracted Item contain the annotated evidence string? Target ≥95% before any prospective ledger.
- **Plugs in:** `lib/edgar.js` (already has item numbers + full-text search), `dilution-filings.js` as template for the write-once ledger; `research/` for the FinanceBench check.
- **Risk:** EDGAR HTML heterogeneity; 10-K size vs 200K Haiku context (sectioning solves this); FinanceBench license unstated (use offline only, never redistribute).
- **Measured:** sectioner recall on FinanceBench; downstream events enter the registry as weight-0 shadow AVOID flags with the existing q≤0.10 retrospective gate.

### 5. RESEARCH-ONLY: RD-Agent(Q)-style hypothesis generation into the registry (effort M, offline)
- **Build:** offline `research/hypothesis-miner.js`: Fable 5.1 reads the FINDINGS-LEDGER and proposes ≤5 *falsifiable* hypotheses/month in the registry's declaration schema; humans pick; the purged walk-forward harness tests. Borrow RD-Agent's propose→implement→evaluate→feedback loop; replace Qlib with the site's panel; no Python, no live wiring.
- **Risk:** garbage-in; cap proposals and log every one as declared so the FDR/BH count stays honest.
- **Measured:** survival rate of LLM- vs human-proposed hypotheses; expect ~0 — the value is a cheap, documented negative.

### MCP servers verdict
The Messages API MCP connector (`mcp_servers:[{type:'url',url,name}]` + `tools:[{type:'mcp_toolset', mcp_server_name}]`, beta `mcp-client-2025-11-20`) would let Claude call the hosted FMP MCP or an HTTP sec-edgar-mcp without hand-rolled fetchers, but each tool round-trip is a server-side loop inside one 40s-bounded Vercel request, caches invalidate on tool-set changes, and the site already memoises these fetchers in Node. **Do not adopt at runtime.** Use the FMP MCP's tool manifest as a free, typed catalogue of FMP endpoints when extending `lib/fmp-client.js`.

## Rejected / noise
- TradingAgents forks (CN/crypto/GUI/Dashboard): localisation and UI only; core already audited.
- ai-hedge-fund: persona pickers; its new hash-chained paper ledger duplicates the provenance spine.
- FinRobot/FinGPT/FinMem/StockAgent/FinAgent*: pickers, fine-tunes or simulators — "LLM picks stocks."
- AlphaAgent: unlicensed, Tushare/A-share only; RD-Agent covers the idea with MIT.
- sec-insights: 2025 LlamaIndex demo (Python/TS), RAG chat over filings — chat is not the product.
- Finance MCP servers (alpaca, yfinance, polygon, financial-datasets, octagon, akshare, investor-agent): duplicate already-wired vendors or paid APIs; runtime fit poor on Vercel.
- langfuse/deepeval/ragas/guardrails/instructor: platform-scale or Python; strict tools + a Blob usage doc cover the need.
- sec-edgar-mcp/-toolkit, edgar-crawler, ECTSum: AGPL/GPL — reference only.
- claude-quickstarts financial-data-analyst: Next.js chart chat demo; plugins-official has no finance plugin.
