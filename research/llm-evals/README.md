# LLM golden-set regression (`research/llm-evals/`)

Zero-dependency regression harness for the app's Claude prompt families. It exists because
`PROMPT_VERSION` bumps and prompt edits were previously unverified: nothing checked that a
changed prompt still produced schema-valid, *grounded* output (numbers and source indexes
that actually exist in the input). GitHub-scan proposal #7 (`docs/GITHUB-RESOURCE-SCAN-2026-10-02.md`).

## What is under test

| Family | Production module | Model | Transport | Request builder used by the eval |
|---|---|---|---|---|
| `evidence-extract` | `lib/evidence-extract.js` | Haiku 4.5 | forced `submit_events` | `buildExtractRequest` (the function `callExtract` sends) |
| `earnings-tone` | `lib/earnings-tone.js` (`scoreTone`, transcript path) | Haiku 4.5 | forced `submit_tone` | `buildToneRequest` |
| `pulse-narrative` | `lib/pulse2-ticks.js` (`runPulse2Refine`) | Fable 5.1 | `buildFableRequest` (strict tool, `auto`, fallback beta) | `buildFableRequest` + `buildRefineMessages` |
| `bear-case` | `lib/bearcase.js` | Haiku 4.5 | forced `submit_bear_cases` | `buildBearRequest` |
| `gameplan-reflection` | `lib/gameplan.js` | Sonnet 4.6 | forced `submit_game_plan` | `buildGameplanRequest` |

Every adapter in `families.js` calls the **same pure builder the production code calls**, so
the eval exercises the exact request shape (model id, tool, `tool_choice`, system prompt,
user turn). `checkRequestShape` additionally pins the transport invariants: Haiku/Sonnet
sites must send a forced `tool_choice` and no `betas`/`output_config`; Fable sites must send
`auto` + `strict:true` + the server-side-fallback beta + `output_config.effort` and no
`thinking` block. (The web-search path of earnings tone, `scoreToneViaSearch`, is not
evaluable offline and is out of scope.)

## Cases

`cases/<family>.json` — 20–22 frozen cases per family, **all synthetic**. Companies, tickers
and headlines are fictional (`fixtureNote` says so in every file). A case is

```json
{ "id": "ee-004", "input": { ...what the production builder takes... , "expect": { ...live-mode expectations... } },
  "golden": { "expectPass": true|false, "note": "...", "output": { ...a frozen tool input... } } }
```

`golden` is optional. Positive goldens are plausible good outputs; **negative controls**
(`expectPass:false`) are deliberately wrong outputs (invented figure, out-of-range source
index, hedge phrase, off-enum value, too many drivers). Dry mode requires at least one
negative control per family so the assertions are proven able to fail — the "tests that
couldn't fail hid 5 defects" lesson applied to the LLM layer.

Fixtures are frozen: never edit an existing case's input; add a new id.

## Assertions (`assertions.js`, pure, shared with the promptfoo shim)

- `schema` — output validates against the tool's `input_schema` (tiny draft-07 subset checker in `schema-check.js`: type/required/enum/items).
- `sourceIndexes ⊆ inputs`, `index ⊆ items`, `tickers ⊆ inputs` — nothing cites what it was not shown.
- `numbersVerbatim` — every numeric token in a claim/contrarian line/bear case/driver appears
  verbatim in the text that was cited or shown (comma-insensitive; the one tolerated rewrite is
  a two-digit year vs a four-digit one). `12` is *not* grounded by `$0.12`.
- `numberFieldGrounded` — `quantitativeMagnitude` / `surpriseMagnitude` must be null or in the cited text.
- family caps — `MAX_EVENTS`, `MAX_CASES`, `MAX_DRIVERS`, `MAX_PREDICTIONS`, ≤3 lean/avoid/watch items.
- `noHedging` — "could go either way" and friends are banned in bear cases.
- `expect.*` — per-case expectations for live mode (event count/type, tone sign, duplicate pairs, all setups covered, open predictions resolved).
- optional `llm-rubric` — Haiku grades the whole output against the family's criterion using the
  vendored autoevals ClosedQA template (`lib/llm-judge.js`). Only with `--rubric`.

## Running

```sh
node research/llm-evals/run.js --dry          # fixtures + request shapes + golden assertions; NO API. Runs in node --test.
node research/llm-evals/run.js --live         # calls the API through the real builders; writes results/<family>.latest.json
node research/llm-evals/run.js --live --family bear-case --limit 5     # bounded spend
node research/llm-evals/run.js --live --rubric                          # + Haiku llm-rubric per case
node research/llm-evals/run.js --live --bless                           # write results/<family>.baseline.json
node research/llm-evals/run.js --emit-promptfoo                         # regenerate promptfooconfig.yaml
```

Gating env vars:

- `ANTHROPIC_API_KEY` — required for `--live` and `--rubric`; never read in dry mode.
- Nothing else. The runner records its own spend in the cost ledger (`lib/llm-usage.js`)
  under call sites `llm-evals:<family>` and `llm-judge`, so a live run shows up in `op=health`.

Cost: the `pulse-narrative` family runs on Fable 5.1 ($10/$50 per MTok) — use `--family` and
`--limit` when iterating; a full 5-family run is on the order of a few dollars. Never run
`--live` in CI on every push; run it when a prompt or `PROMPT_VERSION` changes.

## The PROMPT_VERSION bump gate

A prompt family's identity is its `PROMPT_VERSION` (today only `evidence-extract` stamps one —
`extract-v1` — on every event it emits; the other families should gain one when first
changed). The rule:

1. Before editing a prompt or tool schema, make sure `results/<family>.baseline.json` exists
   for the current version (`--live --bless` on the unchanged prompt). Commit it.
2. Edit the prompt. Add cases that exercise the change (new ids; the old cases stay).
3. `node research/llm-evals/run.js --dry` must pass (shapes, goldens).
4. `node research/llm-evals/run.js --live --family <f>` must **not** regress: exit code 1 when
   `passRate < baseline.passRate − tolerance` (default `0.05`, `--tolerance` to override — but
   lowering it is a review conversation, not a flag flip).
5. Only then bump `PROMPT_VERSION`, re-run `--live --bless` for the new version and commit the
   new baseline together with the bump. The baseline file records `promptVersion`, so a
   baseline from an older version is visibly stale.

A bump without a passing live run is the failure mode this directory exists to prevent: the
prospective evidence ledgers key on `PROMPT_VERSION`, so a silently worse extractor
contaminates every study downstream.

## promptfoo (optional, not a dependency)

`promptfooconfig.yaml` is generated and lists every case with `vars: { family, caseId }`.
`promptfoo-provider.js` is a custom provider that runs the case through `runCaseLive` (same
builders, same assertions) and `promptfoo-assert.js` unpacks the verdict, so promptfoo's UI,
diffing and history can be used later with

```sh
npx promptfoo@latest eval -c research/llm-evals/promptfooconfig.yaml
```

without adding it to `package.json`. The test suite asserts the committed yaml matches
`--emit-promptfoo` output, so add cases → regenerate → commit.

## Files

- `run.js` — CLI + exported `runDry` / `runLive` / `compareToBaseline` / `emitPromptfoo`.
- `families.js` — the five adapters + `checkRequestShape`.
- `assertions.js`, `schema-check.js` — pure checks.
- `cases/*.json` — frozen fixtures. `results/*.baseline.json` — blessed pass rates (committed); `results/*.latest.json` — local (gitignored).
- `promptfooconfig.yaml`, `promptfoo-provider.js`, `promptfoo-assert.js` — optional promptfoo shim.
- `test/llm-evals-dry.test.js` — what CI runs.
