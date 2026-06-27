# Intraday Research Rig

An offline, event-driven **intraday** backtester for short-term US small/mid-cap
strategies — the one capability the app's daily harness lacks. Lives under `research/`
(already excluded from Vercel deploys); it feeds *validated* results back to the app,
it is not imported by it.

## Why this exists (scope decision)

A data-feasibility probe (2026-06-27) found that **FMP Starter — the tier you already
pay for — serves historical intraday bars** (5-min ~5yr deep, 1-min ~2yr), full
regular sessions, **and retains delisted names** (SIVB/FRC bars exist up to their
collapse). So intraday backtesting is *survivorship-free and feasible with no new data
spend* — which is why this rig is worth building, while the biotech-catalyst / FDA /
news-event ideas stay shelved (those feeds are still blocked on this tier).

This is deliberately **not** a rebuild of the existing rigorous cross-sectional rig
(`research/*.js`, purged walk-forward, deflation). That already exists and works. This
adds only the missing piece: **path-dependent intrabar execution**.

## First mandate: validate the live Day Trade screener

The shipped Day Trade screener (`lib/daytrade.js`) selects names on daily bars and
shows a 1:2 stop/target plan, but its track record uses a **daily-bar forward-return
proxy** — it can't see whether the stop or the target was hit first inside a session.
Experiment 01 replays the *exact same* point-in-time selection (`daytrade.py` is a
faithful port) and executes each pick on **real 5-min bars** with conservative
intrabar fills + costs, to test whether the stated edge survives honest execution or
whether the stops leak (as the app's daily "exits" study warned).

## Layout

```
config.py                       # universe, window, costs, hold horizon (dataclass)
src/intraday/
  fmp.py                        # daily + intraday OHLCV, disk-cached, survivorship-free
  daytrade.py                   # faithful port of lib/daytrade.js (selection + levels)
  execution.py                  # event-driven intrabar stop/target sim, realistic fills
  metrics.py                    # win rate + Wilson LB, expectancy, R-multiples, PF
experiments/
  01_validate_daytrade.py       # the first experiment (selection -> intraday execution)
tests/                          # pytest: daytrade port + execution sim (network-free)
data/                           # gitignored cache + outputs
```

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add your FMP_API_KEY
pytest -q                       # network-free unit tests
python experiments/01_validate_daytrade.py
```

## Honesty rules (inherited from the project)

- Backtests REJECT bad ideas; they do not anoint winners.
- Out-of-sample split + Wilson lower bound on every win rate (no small-sample mirages).
- Costs (slippage + commission) modelled from day one; intrabar ties resolved against
  the strategy (assume stop fills before target).
- No lookahead: select on day T's close, enter at T+1 open.
- Reproducible: every FMP response cached under `data/cache/`.

## Not yet built (intentionally)

`backtesting.py`/`optuna` integration, multi-strategy sweeps, Deflated-Sharpe/PBO,
and any biotech-catalyst/news strategy (data-blocked). Add only once Experiment 01
proves the data path and the engine on a real, shipped signal.
```
