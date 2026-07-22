  import { esc, fmtMoney, timeAgo } from './format.js';
  import { startLivePrices as startScreenerLive, stopLivePrices as stopScreenerLive, LIVE_SCREENERS } from './live-price.js';
  import { startFlowBadges, setFlowNav, FLOW_BADGE_TABS } from './flow-badge.js';
  import { initCommandPalette, openPalette, revealTicker } from './command-palette.js';
import { initTickerLookup, openTickerLookup } from './ticker-lookup.js';
  import { loadOpportunities, mountOpportunitiesTab, whyNowBadge } from './opportunities.js';
  import { loadQuickHit } from './quickhit.js';
  import { loadCommandCenter } from './today.js';
  import { loadEvolve } from './evolve.js';
  import { loadEnsemble } from './omega-ensemble.js';
  import { loadIgnition } from './ignition.js';
  import { loadOmega } from './omega-swing.js';
  import { loadOrbitLab } from './orbit-lab.js';
  import { loadLeaderboard } from './leaderboard.js';
  import { LEARN, LEARN_GROUPS } from './learn-data.js';

  // Tapping a "💰 flow" badge on any screener card jumps to the Options tab.
  setFlowNav(() => showTab('options'));

  // ── App tabs with a "Markets" hub (Screener / Rotation / Sectors) ──
  const TAB_GROUPS = {
    // Seven decision-purpose workspaces. Candidates & Portfolio are ordered by holding
    // horizon (see SUB_HZ dividers). Markets = macro/context; Predict = the forecast &
    // prediction-market read. Unproven overlays live in the Research Lab; the honest
    // report cards live in Evidence.
    home:       ['today', 'ensemble', 'start', 'quickhit'],
    candidates: ['daytrade', 'gapgo', 'ignition', 'gapdown', 'opportunities', 'omega', 'aligned', 'screener', 'custom', 'ghost', 'coil', 'downday', 'confluence', 'trendrider', 'fade', 'biotech'],
    positions:  ['coremo', 'momentum', 'putsell', 'picks'],
    markets:    ['rotation', 'sectors', 'news', 'pulse', 'evolve'],
    predict:    ['gameplan', 'brief', 'forecast', 'crowd', 'sharp', 'alerts'],
    proof:      ['scoreboard', 'evidence', 'baselines', 'leaderboard', 'coreperf'],
    lab:        ['events', 'readthrough', 'anomaly', 'secondwave', 'crossasset', 'toneshift', 'xalerts', 'options', 'backtest', 'edge', 'orbitlab'],
  };
  // Holding-horizon of each candidate/position sub-tab → drives the horizon dividers
  // in the sub-nav so the app is visibly separated by time horizon (the spec ask).
  const SUB_HZ = {
    daytrade: 'intraday', gapgo: 'intraday', gapdown: 'intraday',
    ignition: 'intraday',
    opportunities: 'swing', omega: 'swing', aligned: 'swing', screener: 'swing', custom: 'swing', ghost: 'swing', coil: 'swing', downday: 'swing', confluence: 'swing', trendrider: 'swing', fade: 'swing', biotech: 'swing',
    coremo: 'portfolio', momentum: 'portfolio', putsell: 'portfolio', picks: 'portfolio',
  };
  const HZ_DIVIDER = { intraday: '⏱ Intraday · same-day', swing: '📅 Swing · days–weeks', portfolio: '💼 Portfolio · weeks–months' };
  const TOP_TABS = Object.keys(TAB_GROUPS);
  const SECTION_IDS = Object.values(TAB_GROUPS).flat();
  const SUB_LABEL = {
    today: '🏠 Today', ensemble: '🎯 OMEGA Ensemble', start: '📘 Guide',
    quickhit: '⚡ Quick Hit', opportunities: '⭐ Opportunities', omega: '💠 OMEGA-Swing', aligned: '🎯 Dual Confirmed', screener: '🔎 Breakout', custom: '🧠 Adaptive Momentum', coremo: '📈 Core Momentum', daytrade: '⚡ Day Trade', gapgo: '🚀 Gap & Go', ignition: '🔥 Ignition', downday: '🪁 Down-Day Mode', coil: '🧬 Coil Radar', confluence: '⚙️ Confluence', ghost: '👻 Ghost', trendrider: '🚦 Trend Rider', fade: '🔥 Overheated', gapdown: '🐻 Gap-Down',
    rotation: '🔄 Rotation', sectors: '📊 Sectors', momentum: '🔥 Momentum', news: '📰 News', options: '⚡ Options', putsell: '💰 Options Moves', picks: '⭐ Picks',
    pulse: '📡 Market Pulse', evolve: '🧬 EVOLVE', readthrough: '🔗 Read-Through', anomaly: '🕵️ Stealth', biotech: '🧬 Biotech', secondwave: '🌊 Second Wave', crossasset: '🌐 Cross-Asset', toneshift: '🎚️ Tone Shift', gameplan: '🗞️ Game Plan', brief: '🧭 Brief', forecast: '🔮 Forecast', crowd: '🎲 Crowd', sharp: '🕵️ Sharp Money', alerts: '🔔 Alerts',
    backtest: '🧪 Backtest', events: '⚡ Events (CERN)', edge: '📓 Edge Book', orbitlab: '🛰️ ORBIT (shadow)',
    leaderboard: '🏆 Algo Leaderboard', scoreboard: '📋 Scoreboard', evidence: '🎖️ Evidence', baselines: '🧪 Baselines', coreperf: '📈 Core Performance', xalerts: '🐦 Trade Alerts',
  };
  // Plain-English "what is this tab?" hovers for a novice investor — one line per
  // sub-tab, shown when you hover the tab button.
  const SECTION_HELP = {
    today: 'Your daily home base: the market mood and where to start.',
    ensemble: 'Every screener combined into ONE portfolio-aware book. Correlated screeners are counted once (not seven times), trading costs are charged against each target, and names are dropped when they add duplicate risk — with the reason shown. It composes the existing engines and computes no score of its own, so it is allowed to hand you fewer than 10 names, or none.',
    start: 'A beginner’s guide to what everything in this app means.',
    quickhit: 'The Top 5 plays across large, small AND micro caps — one fast shortlist with links to where each lives.',
    opportunities: 'The best setups across all the screeners, gathered in one ranked list.',
    aligned: 'Stocks that are a BUY on both horizons at once — the short-term signal AND the ~1-year trend both point up. The strongest agreement of the dual read.',
    putsell: 'Options Moves — AI-screened options-strategy setups from full-market price action. First strategy: cash-secured put selling (quality uptrends pulled back to support, with a suggested strike below support). More strategies coming.',
    screener: 'Stocks breaking out of chart patterns (classic breakout setups).',
    custom: 'A momentum model that adapts its scoring to the current market regime.',
    coremo: 'Steady, confirmed uptrends with the strongest 12-month momentum.',
    daytrade: 'Short-term setups for same-day trading, with a live entry-timing grade.',
    gapgo: 'Stocks gapping up on news and continuing — the one validated event edge.',
    omega: 'OMEGA-SWING — liquid names with early-to-middle-stage momentum likely to keep rising over the next 5–10 trading days. Sector- and market-relative, ranked by expected utility, with an entry plan and invalidation for each. Not a chaser of already-vertical moves; won’t force picks in weak regimes.',
    ignition: 'One acceleration-ranked view over all the momentum scanners: catch names whose price AND volume are speeding up (up 10% and accelerating beats up 60% and slowing), with a catalyst tag, ignition score, and stage. EOD/daily data — no real-time or LULD halt prediction.',
    downday: 'What to trade when the market is red: oversold-bounce longs + overheated shorts, with the honest proof that chasing strength on down days loses.',
    coil: 'Names coiling in tight compression before a potential explosive move.',
    confluence: 'Stocks flagged by several screeners at once (agreement = higher conviction).',
    ghost: 'Quiet accumulation — big money building a position before the breakout.',
    trendrider: 'Ride established uptrends; the model drops names once they stop trending.',
    fade: 'Overheated names that may be due to pull back (short/caution ideas).',
    gapdown: 'Stocks gapping DOWN hard on news and continuing lower — short setups (the mirror of Gap & Go). Best off red days; mind borrow costs.',
    orbitlab: 'ORBIT & ORBIT-ML — experimental residual-drift ranking systems running in shadow (zero weight, never affect the live rank). Shown here to accrue an honest out-of-sample track record; currently grade C with no durable edge.',
    rotation: 'Which sectors money is rotating into and out of, week over week.',
    sectors: 'Sector performance heatmap — what’s leading and lagging.',
    momentum: 'Strong-buy and strong-sell momentum calls right now.',
    news: 'Market-moving headlines, summarized.',
    options: 'Unusual options activity — where the big option bets are landing.',
    picks: 'Your saved / tracked picks.',
    pulse: 'What the crowd is buzzing about on social + finance media (attention, not advice).',
    evolve: 'An adaptive engine that composes the app’s own screeners, learns which one works in which market regime, and only surfaces names where a CALIBRATED probability of a large upside move clears an honest guardrail — split by Fast/Swing/Position horizon. It’s allowed to show nothing.',
    readthrough: 'Second-order “who benefits and hasn’t moved yet” — names linked to today’s gappers by supply chain or competition.',
    anomaly: 'Stocks quietly climbing on volume with NO news — the AI investigates each for a hidden catalyst (possible stealth accumulation).',
    biotech: 'Biotech names that just started running (micro→large cap), scored 0–100 with a catalyst-aware model — the AI finds WHY each is moving (FDA/data/M&A/deal) or flags it Unknown, and the score penalizes dilution & pump-and-dump traps.',
    secondwave: 'Stocks with a first move up that the crowd hasn’t piled into yet — the AI forecasts which are primed for a reflexive second wave of buyers.',
    crossasset: 'US stocks levered to a move in another asset (a commodity, an overnight foreign market, crypto, or rates) that they haven’t caught up to yet.',
    toneshift: 'Companies whose latest earnings call sounded more confident (or more cautious) than last quarter — a language shift before the numbers catch up.',
    gameplan: 'A plain-English daily game plan for the market.',
    brief: 'A concise market brief — the current stance and why.',
    forecast: 'Falsifiable market predictions, auto-graded against real prices.',
    crowd: 'Prediction-market odds on macro events.',
    sharp: 'Signs of “smart money” positioning worth a look.',
    alerts: 'Auto-caught events — sharp-money flags and stance flips.',
    backtest: 'Test the models against history: does the edge hold up over time?',
    events: 'CERN — the forced-selling event engine (index changes, lockups, fire-sales).',
    edge: 'The Edge Book: two independent strategy sleeves and their beat-the-market rate.',
    leaderboard: 'A leaderboard ranking the app’s own algorithms by track record.',
    scoreboard: 'The honest report card: how every signal type has actually performed vs the market.',
    evidence: 'How much to trust each strategy — a Validated/Promising/Experimental grade earned from its own track record, and which unproven ones live in the Research Lab.',
    baselines: 'Does each strategy actually beat a DUMB baseline? Compares every strategy vs SPY, its sector, a random/equal-weight pick, and simple momentum / 52-week-high / relative-volume rank screens.',
    coreperf: 'Quarterly performance of the Core Momentum model vs the market.',
    xalerts: 'Ranked trade alerts scraped from social accounts, graded on forward returns.',
  };
  const topOf = sec => TOP_TABS.find(t => TAB_GROUPS[t].includes(sec));

  // Mark each section as a switchable screen
  SECTION_IDS.forEach(id => document.getElementById(id)?.classList.add('tabbable'));

  let hubSub = { home: 'today', candidates: 'opportunities', positions: 'coremo', markets: 'rotation', predict: 'gameplan', proof: 'scoreboard', lab: 'events' };
  try { const hs = JSON.parse(localStorage.getItem('hubSub')); if (hs) hubSub = { ...hubSub, ...hs }; } catch {}
  // Sanitize stored hubSub: after the nav regrouping a saved sub may no longer
  // belong to its group (e.g. markets→screener). Reset any stale entry to the
  // group's first section so the sub-nav and active section stay in sync.
  Object.keys(hubSub).forEach(top => {
    if (!TAB_GROUPS[top] || !TAB_GROUPS[top].includes(hubSub[top])) {
      if (TAB_GROUPS[top]) hubSub[top] = TAB_GROUPS[top][0]; else delete hubSub[top];
    }
  });

  let currentTop = (() => {
    const h = (location.hash || '').replace('#', '');
    if (SECTION_IDS.includes(h)) { const t = topOf(h); if (TAB_GROUPS[t].length > 1) hubSub[t] = h; return t; }
    if (TOP_TABS.includes(h)) return h;
    try { const s = localStorage.getItem('activeTab'); if (TOP_TABS.includes(s)) return s; if (SECTION_IDS.includes(s)) return topOf(s); } catch {}
    return 'home';    // first-time visitors land on the Today command center (📘 Guide sits beside it in the home sub-nav)
  })();

  // ── NOVICE "how to use" guides ────────────────────────────────────────────
  // One plain-English entry per screener/strategy tab that lacks an inline guide.
  // Four beginner questions: what it finds · how to read a card · what to do now ·
  // the honest catch. Injected once at the top of each section by injectHowto()
  // (tabs that already have their own inline guide — trendrider/daytrade/coil/
  // confluence/gapgo/gapdown/fade/aligned/putsell — are deliberately omitted).
  const HOWTO = {
    omega: {
      what: `A shortlist of liquid stocks with <b>early-to-middle-stage momentum</b> that's likely to keep rising over the next <b>5–10 trading days</b>. It looks for sustainable continuation — strong relative strength, real multi-day volume, a smooth trend, a fresh catalyst, and a good entry — <b>not</b> stocks that already went vertical.`,
      read: `Cards are grouped into <b>💠 Prime</b> (best), <b>🟢 Qualified</b>, and <b>👁 Watch</b> (wait for a trigger). Each shows a <b>Stage</b> (Early/Confirmed/Continuation), an <b>entry recommendation</b> (Buy now / on breakout / on pullback), expected 5- and 10-day <b>sector- & market-relative</b> return, the odds of a ≥3% and ≥5% move, and an <b>invalidation</b> price. Names are ranked by expected utility (reward vs downside), not win rate.`,
      act: `Prefer <b>Prime</b> with a "Buy now" entry. Enter in the shown entry zone, place your stop at the <b>invalidation</b>, aim for the target zones, and use the <b>suggested size</b> (sized so a stop-out costs ~1% of your account). Hold ~1–2 weeks.`,
      catch: `Uses <b>end-of-day data</b> — entry levels are next-session positioning, not live triggers. The probabilities are a <b>baseline</b> until the walk-forward confirms them, and the app's own research found no durable edge on this data beyond avoiding weak markets — so check the <b>OMEGA section on the Scoreboard</b> to see if it's actually working. Zero Prime picks on a given day is normal.`,
    },
    ignition: {
      what: `One list that ranks every momentum candidate by how fast it's <b>speeding up</b> — price AND volume accelerating — not by how much it's already moved. A stock up 10% and accelerating ranks <b>above</b> one up 60% and slowing down.`,
      read: `Higher <b>Ignition Score</b> = stronger acceleration + a fresh catalyst + a clean trend. The <b>Stage</b> tells you where the move is: 👁 Watch (early) → 🔥 Ignition → 🚀 Pressure → ⚠️ Extended (already run — be careful). Sort and filter with the dropdowns.`,
      act: `An <b>early-momentum watchlist</b>. Prefer Watch/Ignition (room left to run) over Extended; check the catalyst is real and fresh, confirm on a chart, and size so a stop-out costs ~1% of your account.`,
      catch: `This uses <b>end-of-day daily data</b> — it can't see intraday ticks, predict an LULD halt, or measure sub-minute moves (those need a live feed the app doesn't have). And chasing momentum isn't proven forward edge — check the 🔥 Momentum Ignition section on the <b>Scoreboard</b> to see if it's actually working.`,
    },
    custom: {
      what: `Stocks that just broke OUT to new highs, scored 0–100 by a four-part model (trend, momentum, volume, fundamentals) that re-weights itself for the current market mood.`,
      read: `Higher score and higher tier (<b>Apex &gt; Loaded &gt; Watch</b>) mean more of the four parts agree. The strip up top shows the market "regime" the model is using right now.`,
      act: `Treat it as a watchlist. Confirm the breakout on a chart, then buy near the shown <b>entry</b> with the shown <b>stop</b>; size so a stop-out costs only ~1% of your account.`,
      catch: `Breakouts get chopped up in sideways or falling markets, so the model steps back in risk-off. The app's own tests rate this edge as <b>weak</b> — research, not advice.`,
    },
    ghost: {
      what: `QUIET stocks that look like they're being <b>accumulated before</b> a breakout — the opposite of chasing a move that already happened. Scored /100 across six clues, including real insider buying.`,
      read: `Tier <b>GHOST &gt; STALKING &gt; WATCH</b>. The pillar chips show which clues fired (relative strength, accumulation, smart-money flow, insider buys, catalyst).`,
      act: `Use it as an <b>early</b> watchlist. These are "getting ready," not "going now" — set an alert and wait for the actual breakout to confirm before buying.`,
      catch: `"Quiet accumulation" is a guess about intent, and many names never break out. Insider buying is rare in big caps. A lead to watch, not a buy signal.`,
    },
    downday: {
      what: `A tool that only switches on when the market is <b>RED</b>. It hunts oversold stocks that tend to bounce, flags overheated ones to avoid — or honestly tells you to sit out.`,
      read: `Tiers <b>WATCH → EMERGING → CONFIRMED</b> (earlier turns often beat late ones). Each shows a bounce entry with a stop.`,
      act: `For quick <b>mean-reversion bounces</b>, not long holds. Only act if the setup and your own chart agree; on a truly ugly tape, the honest move is cash.`,
      catch: `Catching a falling knife is risky — bounces fail when the market keeps dropping. Backtests only validated the sharp V-reversal type, not buying strong names on red days.`,
    },
    opportunities: {
      what: `The app's <b>combined shortlist</b> — the strongest names it sees right now, pulled from across all the screeners into one ranked list.`,
      read: `Sorted best-first. Each card shows why it made the list and its levels. Names that appear here <i>and</i> on other tabs are the highest-conviction.`,
      act: `The easiest place to start. Work from the <b>top</b> down, confirm on a chart, size small, and prefer names backed by more than one signal.`,
      catch: `A shortlist is only as good as its inputs — check the 🏆 Scoreboard to see which signals have actually been working before trusting them.`,
    },
    screener: {
      what: `The classic scan — stocks <b>breaking above a base to new highs</b> while stronger than the overall market.`,
      read: `Each card shows the criteria that passed (accumulation, volume, resistance break) plus an entry, stop, and target.`,
      act: `Watchlist. Wait for the breakout to hold, confirm on a chart, then enter with the shown stop.`,
      catch: `This app's own research found the volume-surge and tight-base filters are <b>dead</b> — only the relative-strength/trend part carries a weak edge. Don't over-trust the pattern.`,
    },
    coremo: {
      what: `A cleaner momentum list — names ranked mainly by how <b>strong and steady</b> their uptrend is, filtered for quality.`,
      read: `Higher rank = a stronger, steadier trend.`,
      act: `A trend-following watchlist. Buy <b>pullbacks</b> within the uptrend rather than extended spikes, and keep a stop under the trend.`,
      catch: `Momentum is the one factor with (weak) edge here, but it mean-reverts hard in risk-off — respect the regime light.`,
    },
    momentum: {
      what: `Names flagged as momentum leaders today — stocks whose trend and strength stand out right now.`,
      read: `The list itself is the signal; each name is a current leader.`,
      act: `Watchlist. Strongest when it agrees with the Screener or Ghost; combine with the regime and a chart before acting.`,
      catch: `"Strong today" often means "already extended." Don't chase — wait for a pullback and confirm.`,
    },
    rotation: {
      what: `Which <b>sectors</b> money is flowing into and out of (tech, energy, financials…) — the market's leadership.`,
      read: `Sectors near the top are leading; near the bottom are lagging.`,
      act: `Use it as context: hunt for stocks in the <b>leading</b> sectors and avoid fighting a sector that's being sold.`,
      catch: `This is a backdrop, not a buy list, and leadership can rotate quickly.`,
    },
    options: {
      what: `Unusually large or aggressive <b>options bets</b> — sometimes a clue that big money is positioning for a move.`,
      read: `Each row shows the ticker, the bullish/bearish lean, and how unusual the activity is.`,
      act: `A lead to investigate, not a trade — see if the flow lines up with a price setup on another tab.`,
      catch: `Options flow is noisy and often just hedging, not conviction. This uses free data with real gaps — treat it as a hint only.`,
    },
    pulse: {
      what: `A plain-English distillation of what traders are <b>buzzing about</b> right now, gathered from social/video chatter and ranked by popularity and how fast it's spreading.`,
      read: `Top items are the loudest and fastest-rising topics and tickers.`,
      act: `Awareness — know what the crowd is watching. Cross-check any ticker against a real signal tab before acting.`,
      catch: `Popular ≠ profitable. By the time something is loud the move may be done, and hype is often a <b>fade</b> signal.`,
    },
    readthrough: {
      what: `The <b>second-order</b> play — when a stock makes a big move, this finds other companies with a direct business link that <b>haven't moved yet</b>.`,
      read: `Each card shows the mover, the linked beneficiary, the named connection, and how <b>direct</b> the link is (higher = tighter).`,
      act: `A watchlist for catch-up trades. Favor the most direct links and check the beneficiary hasn't already jumped.`,
      catch: `The market often prices these in fast. On the Scoreboard it's measured vs the beneficiary's sector — check that "Fresh" names actually beat already-"Moved" ones first.`,
    },
    anomaly: {
      what: `Stocks moving on unusual <b>volume with no obvious news</b> — then an AI investigates whether it looks like quiet accumulation, an explained move, or just noise.`,
      read: `Each is labeled <b>Accumulation / Explained / Noise</b> with the AI's reasoning. Accumulation (no clear reason) is the interesting bucket.`,
      act: `A lead to dig into — unexplained volume sometimes precedes news. Confirm on a chart; don't buy on the label alone.`,
      catch: `"No news I could find" isn't "no news exists," and many anomalies are nothing. Benchmarked vs sector on the Scoreboard.`,
    },
    biotech: {
      what: `Early-stage <b>biotech</b> names showing runner characteristics, scored /100 with awareness of catalysts (biotech moves on trial and FDA news).`,
      read: `Tier <b>Hot &gt; Emerging &gt; Watch</b> with an AI reason. Measured against the biotech index (XBI), not just the S&P.`,
      act: `A specialist watchlist. Biotech is binary and headline-driven — size <b>tiny</b> and know the catalyst dates.`,
      catch: `A single trial result can gap a biotech 50% overnight — enormous risk. Only money you can fully lose; beginners should mostly just watch.`,
    },
    secondwave: {
      what: `Stocks that had a first move and may get a reflexive <b>second leg</b> as attention builds — catching early movers before the crowd piles in.`,
      read: `Tier <b>Primed &gt; Early &gt; Faded</b>. "Primed" means the setup for a second leg still looks intact.`,
      act: `A continuation watchlist. Check the name hasn't already faded and use a tight stop — these are momentum bets.`,
      catch: `Most first moves don't get a clean second leg. Sector-benchmarked on the Scoreboard — verify Primed actually beats Faded before leaning on it.`,
    },
    crossasset: {
      what: `When commodities, crypto, or overnight futures make a big move, this maps it to US stocks that <b>should follow but haven't caught up yet</b>.`,
      read: `Tier <b>Lead &gt; Inline &gt; Weak</b> — "Lead" means the stock is still lagging the cross-asset signal (the opportunity).`,
      act: `A catch-up watchlist. Check the linkage makes sense and the stock hasn't already moved.`,
      catch: `Cross-asset links are loose and can break. Sector-benchmarked on the Scoreboard — confirm it works before trusting it.`,
    },
    toneshift: {
      what: `Compares a company's latest <b>earnings-call tone</b> to last quarter — is management sounding more upbeat (Brightening) or more cautious (Darkening)?`,
      read: `Labeled <b>Brightening / Stable / Darkening</b> with the reasoning. The bet: a brightening tone should lead the price.`,
      act: `A fundamental lead to pair with a price setup — brightening tone <i>plus</i> a technical breakout is stronger than either alone.`,
      catch: `Tone is a soft, AI-read signal that can misfire and only fires around earnings. Sector-benchmarked — check Brightening actually beats Darkening.`,
    },
    gameplan: {
      what: `A once-a-day, plain-English <b>game plan</b> — the day's setups, key levels, and what to watch, pulled together for you.`,
      read: `Read it top-to-bottom like a morning briefing.`,
      act: `Use it to orient before the session, then drill into the specific tabs for the actual picks and levels.`,
      catch: `It's a summary, not a signal — the honest track records live on the 🏆 Scoreboard.`,
    },
    brief: {
      what: `A short brief that combines the app's signals into one "here's the picture" read, showing where they <b>agree and disagree</b>.`,
      read: `Look for <b>agreement</b> — views or names that several signals share are the highest quality.`,
      act: `Orientation. Treat the agreement as your shortlist and skip the conflicted calls.`,
      catch: `A synthesis is only as good as its parts — verify on the Scoreboard.`,
    },
    forecast: {
      what: `The app's directional <b>forecast</b> for the market — a probabilistic view of the tape, not a promise.`,
      read: `Shown as odds or a leaning with the reasoning, never a certainty.`,
      act: `Use it as backdrop for sizing and risk — lean in when the forecast and the regime agree, ease off when they don't.`,
      catch: `Short-term market forecasting is close to random. Treat any single call with heavy skepticism.`,
    },
    crowd: {
      what: `What the betting/prediction markets and the broad crowd <b>expect</b> — a read on consensus.`,
      read: `Higher numbers = the crowd is more confident in that outcome.`,
      act: `Context. Knowing the consensus helps you notice when you're just agreeing with everyone (already priced in).`,
      catch: `The crowd is often right but rarely gives an edge — the edge is spotting when it's wrong, which is hard.`,
    },
    sharp: {
      what: `A read on where the "<b>sharp</b>" / informed money appears to be positioned, versus the general crowd.`,
      read: `It highlights where smart money <b>diverges</b> from the crowd — the divergence is the interesting part.`,
      act: `Context and confirmation — sharp-money agreement can add conviction to a setup you found elsewhere.`,
      catch: `"Sharp money" is inferred, not certain, and is often already reflected in the price. A hint, not a trade.`,
    },
    alerts: {
      what: `Notable market <b>alerts</b> the app surfaces so you don't miss unusual activity.`,
      read: `Scan for anything relevant to names you're already watching.`,
      act: `Awareness — follow up on a real signal tab before acting on any alert.`,
      catch: `Alerts flag activity, not opportunity — always confirm before trading.`,
    },
  };

  // Render one collapsed "how to use" panel from the config (author-trusted HTML,
  // no user input → intentional <b>/<i> tags are kept, not escaped).
  function howtoPanel(key) {
    const h = HOWTO[key];
    if (!h) return '';
    return `<details class="tr-howto tr-howto-auto">
      <summary class="tr-howto-head">📖 New here? How to use this tab — plain English</summary>
      <ol>
        <li><b>What it finds.</b> ${h.what}</li>
        <li><b>How to read a card.</b> ${h.read}</li>
        <li><b>What to do now.</b> ${h.act}</li>
        <li><b>The catch.</b> ${h.catch}</li>
      </ol>
      <a class="howto-start-link" data-howto-start role="button" tabindex="0">📘 New to the whole app? Read the full <b>Start Here</b> beginner's guide →</a>
    </details>`;
  }

  // Inject the guide once as the section's first child — a SIBLING above the render
  // container, so a tab re-rendering its own `${sub}-container` never wipes it.
  function injectHowto(sub) {
    try {
      if (!HOWTO[sub]) return;
      const sec = document.getElementById(sub);
      if (!sec || sec.querySelector(':scope > .tr-howto-auto')) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = howtoPanel(sub);
      const node = wrap.firstElementChild;
      if (node) {
        // Wire the "Start Here" link to jump to the full beginner guide (keyboard-accessible).
        const link = node.querySelector('[data-howto-start]');
        if (link) {
          // 'start' is both a group key (default sub 'today') and the beginner-guide
          // section id — pin the sub so showTab lands on the guide, not on 'today'.
          const goStart = e => { e.preventDefault(); e.stopPropagation(); hubSub.start = 'start'; showTab('start'); };
          link.addEventListener('click', goStart);
          link.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') goStart(e); });
        }
        sec.insertBefore(node, sec.firstChild);
      }
    } catch { /* non-fatal — guide is a nicety */ }
  }

  function renderHubSubnav(top, sub) {
    const el = document.getElementById('hub-subnav');
    if (!el) return;
    const group = TAB_GROUPS[top] || [];
    if (group.length <= 1) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    let lastHz = null;
    const parts = group.map(s => {
      let divider = '';
      const hz = SUB_HZ[s];
      if (hz && hz !== lastHz) { divider = `<div class="hub-sub-div">${HZ_DIVIDER[hz] || ''}</div>`; lastHz = hz; }
      return divider + `<button class="hub-sub-btn ${s === sub ? 'active' : ''}" data-sub="${s}"${SECTION_HELP[s] ? ` title="${esc(SECTION_HELP[s])}"` : ''}>${SUB_LABEL[s] || s}</button>`;
    });
    el.innerHTML = `<div class="hub-sub">` + parts.join('') + `</div>`;
    el.querySelectorAll('.hub-sub-btn').forEach(b => b.onclick = () => showTab(b.dataset.sub));
  }

  window.showTab = showTab; // let ES-module views (today.js) deep-link to a tab
  function showTab(id, opts = {}) {
    let top, sub;
    if (TOP_TABS.includes(id)) { top = id; sub = TAB_GROUPS[id].length > 1 ? (hubSub[id] || TAB_GROUPS[id][0]) : TAB_GROUPS[id][0]; }
    else if (SECTION_IDS.includes(id)) { top = topOf(id); sub = id; if (TAB_GROUPS[top].length > 1) hubSub[top] = id; }
    else { top = 'home'; sub = TAB_GROUPS.home[0]; }
    currentTop = top;
    try { localStorage.setItem('activeTab', top); localStorage.setItem('hubSub', JSON.stringify(hubSub)); } catch {}

    SECTION_IDS.forEach(s => document.getElementById(s)?.classList.toggle('tab-active', s === sub));
    document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === top));
    injectHowto(sub); // prepend the novice "how to use" guide once (no-op if already there / no config)
    renderHubSubnav(top, sub);
    if (typeof updateTapeBadge === 'function') updateTapeBadge(top === 'candidates' ? sub : null);
    if (sub === 'quickhit' && typeof ensureQuickHit === 'function') ensureQuickHit();
    if (sub === 'opportunities' && typeof ensureOpportunities === 'function') { ensureOpportunities(); syncOppScope(); }
    if (sub === 'screener' && typeof ensureScreener === 'function') ensureScreener();
    if (sub === 'backtest' && typeof ensureBacktest === 'function') ensureBacktest();
    if (sub === 'custom' && typeof ensureCustom === 'function') ensureCustom();
    if (sub === 'coremo' && typeof ensureCoreMomentum === 'function') ensureCoreMomentum();
    if (sub === 'coreperf' && typeof ensureCorePerf === 'function') ensureCorePerf();
    if (sub === 'ghost' && typeof ensureGhost === 'function') ensureGhost();
    if (sub === 'events' && typeof ensureCern === 'function') ensureCern();
    if (sub === 'edge' && typeof ensureEdge === 'function') ensureEdge();
    if (sub === 'orbitlab' && typeof ensureOrbitLab === 'function') ensureOrbitLab();
    if (sub === 'evidence' && typeof ensureEvidence === 'function') ensureEvidence();
    if (sub === 'baselines' && typeof ensureBaselines === 'function') ensureBaselines();
    if (sub === 'today' && typeof ensureToday === 'function') ensureToday();
    if (sub === 'rotation' && typeof ensureRotationDW === 'function') ensureRotationDW();
    if (sub === 'fade' && typeof ensureFade === 'function') ensureFade();
    if (sub === 'trendrider' && typeof ensureTrendRider === 'function') ensureTrendRider();
    if (sub === 'daytrade' && typeof ensureDaytrade === 'function') ensureDaytrade();
    if (sub === 'gapgo' && typeof ensureGapGo === 'function') ensureGapGo();
    if (sub === 'ignition' && typeof ensureIgnition === 'function') ensureIgnition();
    if (sub === 'omega' && typeof ensureOmega === 'function') ensureOmega();
    if (sub === 'downday' && typeof ensureDownDay === 'function') ensureDownDay();
    if (sub === 'gapdown' && typeof ensureGapDown === 'function') ensureGapDown();
    if (sub === 'aligned' && typeof ensureAligned === 'function') ensureAligned();
    if (sub === 'putsell' && typeof ensurePutSell === 'function') ensurePutSell();
    if (sub === 'coil' && typeof ensureCoil === 'function') ensureCoil();
    if (sub === 'confluence' && typeof ensureConfluence === 'function') ensureConfluence();
    if (sub === 'xalerts' && typeof ensureXalerts === 'function') ensureXalerts();
    if (sub === 'leaderboard' && typeof ensureLeaderboard === 'function') ensureLeaderboard();
    if (sub === 'momentum' && typeof ensureMomentum === 'function') ensureMomentum();
    if (sub === 'options' && typeof ensureOptions === 'function') ensureOptions();
    if (sub === 'picks' && typeof ensurePicks === 'function') ensurePicks();
    if (sub === 'pulse' && typeof ensurePulse === 'function') ensurePulse();
    if (sub === 'evolve' && typeof ensureEvolve === 'function') ensureEvolve();
    if (sub === 'ensemble' && typeof ensureEnsemble === 'function') ensureEnsemble();
    if (sub === 'readthrough' && typeof ensureReadThrough === 'function') ensureReadThrough();
    if (sub === 'anomaly' && typeof ensureAnomaly === 'function') ensureAnomaly();
    if (sub === 'biotech' && typeof ensureBiotech === 'function') ensureBiotech();
    if (sub === 'secondwave' && typeof ensureSecondWave === 'function') ensureSecondWave();
    if (sub === 'crossasset' && typeof ensureCrossAsset === 'function') ensureCrossAsset();
    if (sub === 'toneshift' && typeof ensureToneShift === 'function') ensureToneShift();
    if (sub === 'gameplan' && typeof ensureGamePlan === 'function') ensureGamePlan();
    if (sub === 'brief' && typeof ensureBrief === 'function') ensureBrief();
    if (sub === 'forecast' && typeof ensureForecast === 'function') ensureForecast();
    if (sub === 'crowd' && typeof ensureCrowd === 'function') ensureCrowd();
    if (sub === 'sharp' && typeof ensureSharp === 'function') ensureSharp();
    if (sub === 'alerts' && typeof ensureAlerts === 'function') ensureAlerts();

    // Live intraday price overlay on the stock screeners (daily-bar signals, live price).
    if (LIVE_SCREENERS.has(sub)) startScreenerLive(document.getElementById(sub)); else stopScreenerLive();
    if (FLOW_BADGE_TABS.has(sub)) startFlowBadges(document.getElementById(sub));

    const act = document.querySelector('.mobile-top-tabs .mtt-item.active');
    if (act) act.scrollIntoView({ inline: 'center', block: 'nearest', behavior: opts.instant ? 'auto' : 'smooth' });
    if (!opts.noScroll) window.scrollTo({ top: 0, behavior: opts.instant ? 'auto' : 'smooth' });
    try { history.replaceState(null, '', '#' + sub); } catch {}
  }

  // Shared market-tape badge across all screener tabs (op=tape, cached ~5 min).
  const TAPE_INFO = {
    trending: ['📈', 'Trending tape', 'clean directional market'],
    choppy: ['🌊', 'Choppy / ranging tape', 'low trend efficiency — whippy'],
    mixed: ['🤝', 'Mixed tape', 'no tape clearly favors a style'],
    riskoff: ['🛑', 'Risk-off tape', 'defensive market'],
  };
  // Each screener's strategy STYLE and the tape it works best in. The badge tells
  // you whether today's tape FITS the screener you're looking at (condition-aware
  // per screener): trend/breakout/momentum favor trending tapes; mean-reversion
  // (Fade) favors choppy tapes — the opposite.
  const SCREENER_STYLE = { screener: 'breakout', custom: 'momentum', coremo: 'momentum', daytrade: 'momentum', confluence: 'adaptive', ghost: 'breakout', trendrider: 'trend', fade: 'meanrev' };
  const STYLE = {
    breakout: { favor: 'trending', name: 'breakouts', good: 'have the wind at their back', bad: 'fail more often (false breakouts) — be selective' },
    momentum: { favor: 'trending', name: 'momentum setups', good: 'tend to follow through', bad: 'stall and reverse — be selective, tighten stops' },
    trend: { favor: 'trending', name: 'trend-following', good: 'is in its element', bad: 'gets chopped up — stand down (see the traffic light)' },
    meanrev: { favor: 'choppy', name: 'fades / mean-reversion', good: 'are in their element (price reverts in ranges)', bad: 'is dangerous — never fade a strong trend' },
    adaptive: null,   // Confluence adapts internally (★ marks in-element strategies)
  };
  let _tapeCache = null, _tapeAt = 0;
  async function updateTapeBadge(sub) {
    // Per-screener trust badge (same shared header area as the tape badge).
    const trust = document.getElementById('trust-badge');
    if (trust) { const h = sub ? trustBadgeHTML(sub) : ''; trust.innerHTML = h; trust.style.display = h ? '' : 'none'; }
    const el = document.getElementById('tape-badge');
    if (!el) return;
    if (!sub) { el.style.display = 'none'; return; }
    el.style.display = '';
    const render = () => {
      const t = _tapeCache;
      if (!t || !t.ok) { el.innerHTML = `<span class="tb-desc">Reading the market tape…</span>`; return; }
      const [ic, lbl, desc] = TAPE_INFO[t.condition] || TAPE_INFO.mixed;
      // Per-screener fit: does this tape suit the active screener's style?
      let fit = '';
      const sty = STYLE[SCREENER_STYLE[sub]];
      if (sty && t.condition !== 'mixed') {
        if (t.condition === 'riskoff') fit = `<span class="tb-fit bad">⚠ risk-off — stand down on new longs</span>`;
        else if (t.condition === sty.favor) fit = `<span class="tb-fit good">✓ ${sty.name} ${sty.good}</span>`;
        else fit = `<span class="tb-fit bad">⚠ ${sty.name} ${sty.bad}</span>`;
      } else if (SCREENER_STYLE[sub] === 'confluence' || SCREENER_STYLE[sub] === 'adaptive') {
        fit = `<span class="tb-fit">this screener adapts to the tape automatically</span>`;
      }
      el.innerHTML = `<span class="tb-ic">${ic}</span><span><b class="learn-term" data-learn="tape">${lbl}</b> <span class="tb-desc">— ${desc}</span>${fit}</span>`
        + `<span class="tb-reg"><span class="learn-term" data-learn="regime">${(t.regime || '').toUpperCase()}</span>${t.efficiency != null ? ` · <span class="learn-term" data-learn="trendEff">trend-eff ${t.efficiency}</span>` : ''}</span>`;
    };
    render();
    if (!_tapeCache || Date.now() - _tapeAt > 5 * 60 * 1000) {
      try { const r = await fetch('/api/tracker?op=tape'); _tapeCache = await r.json(); _tapeAt = Date.now(); render(); } catch {}
    }
  }

  // Header, top-strip and bottom-bar tabs all switch screens (every size)
  document.querySelectorAll('[data-tab]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.tab); });
  });

  // Deep links / notification clicks (e.g. /#momentum or /#rotation)
  window.addEventListener('hashchange', () => {
    const id = (location.hash || '').replace('#', '');
    if (SECTION_IDS.includes(id) || TOP_TABS.includes(id)) showTab(id);
  });

  document.body.classList.add('tabs');
  // NOTE: the initial showTab() is deferred to the END of this script (see bottom).
  // Its tab-switch dispatch calls the lazy-loaders (ensureScreener/ensureBacktest/…),
  // whose `let` flags are declared further down — calling it here threw a TDZ error
  // ("Cannot access 'btLoaded' before initialization") for anyone whose last sub-tab
  // used a loader. Deferring to the end (still before first paint — parse-blocking
  // inline script) means every loader is initialized when the boot tab is shown.

  // ── Live clock & market status ──
  function updateClock() {
    const now = new Date();
    document.getElementById('live-clock').textContent =
      now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay(), h = et.getHours(), m = et.getMinutes();
    const mins = h * 60 + m;
    const isWeekday = day >= 1 && day <= 5;
    const isOpen = isWeekday && mins >= 570 && mins < 960; // 9:30–16:00 ET
    const el = document.getElementById('market-status');
    const txt = document.getElementById('market-status-text');
    el.className = 'market-status ' + (isOpen ? 'open' : 'closed');
    txt.textContent = isOpen ? 'Markets Open' : 'Markets Closed';
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ── System health banner — surfaces stale data or a failed daily cron run ──
  async function checkHealth() {
    let d; try { d = await fetch('/api/tracker?op=health').then(r => r.json()); } catch { return; }
    if (!d || !d.ok) return;
    const warns = [];
    if (d.data && d.data.stale) warns.push(`⚠️ Market data is ${d.data.ageDays}d stale (last EOD ${esc(d.data.spyDate || '—')}) — prices may be behind.`);
    // Only warn on REAL failures. Budget-deferred ticks (steps skipped because the cron
    // hit its time budget) are best-effort work that self-heals on the next run — they
    // are NOT errors, so exclude them from the count and the list. Real failures = stages
    // that errored (not merely deferred) plus any cache-warm fetch failures.
    if (d.lastRun && !d.lastRun.ok) {
      const deferred = new Set(d.lastRun.budgetSkipped || []);
      const realFailed = (d.lastRun.failed || []).filter(s => !deferred.has(s));
      const warmFailPaths = (d.lastRun.warmFails || []).map(w => (w && w.path) || '').filter(Boolean);
      const nReal = realFailed.length + warmFailPaths.length;
      if (nReal > 0) {
        const names = realFailed.concat(warmFailPaths).slice(0, 4).join(', ');
        warns.push(`⚠️ Last data refresh had ${nReal} failed step${nReal === 1 ? '' : 's'}${d.failStreak > 1 ? ` (${d.failStreak} runs in a row)` : ''}: ${esc(names || 'cache warms')}.`);
      }
      // else: only budget-deferred steps — nothing broke; suppressed.
    }
    if (!warns.length) return;
    const page = document.querySelector('.page'); if (!page) return;
    const bar = document.createElement('div');
    bar.className = 'health-banner';
    bar.innerHTML = warns.join('<br>') + ` <button class="health-x" aria-label="dismiss">✕</button>`;
    bar.querySelector('.health-x').addEventListener('click', () => bar.remove());
    page.insertBefore(bar, page.firstChild);
  }
  checkHealth();

  // ── News feeds ──
  document.getElementById('refresh-btn').addEventListener('click', fetchAll);
  // Persistent "Start Here" header button → the beginner guide. 'start' is both a
  // group key (default sub 'today') and the guide's section id, so pin the sub first.
  document.getElementById('starthere-btn')?.addEventListener('click', () => { hubSub.start = 'start'; showTab('start'); });
  fetchAll();
  setInterval(fetchAll, 4 * 60 * 60 * 1000);

  function fetchAll() {
    fetchFeed('stocks', 'stocks-list');
    fetchFeed('market', 'market-list');
    document.getElementById('last-updated').textContent =
      `Updated ${new Date().toLocaleTimeString()}`;
  }

  const summaryCache = {};

  async function summarize(article, id) {
    const btn = document.querySelector(`[data-id="${id}"]`);
    const box = document.getElementById(`summary-${id}`);
    if (summaryCache[id]) {
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      btn.textContent = box.style.display === 'none' ? '✦ Summarize' : '✦ Hide';
      return;
    }
    btn.disabled = true; btn.textContent = 'Summarizing…';
    try {
      const res = await fetch('/api/news', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: article.title, description: article.description, content: article.content }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      summaryCache[id] = data.summary;
      box.textContent = data.summary;
      box.style.display = 'block';
      btn.textContent = '✦ Hide';
    } catch {
      box.textContent = 'Could not generate summary. Please try again.';
      box.style.display = 'block';
      btn.textContent = '✦ Summarize';
    }
    btn.disabled = false;
  }

  async function fetchFeed(type, listId) {
    const el = document.getElementById(listId);
    el.innerHTML = `<div class="status"><div class="spinner"></div><p>Loading…</p></div>`;
    try {
      const res = await fetch(`/api/news?type=${type}`);
      const data = await res.json();
      if (data.status === 'error') {
        if (data.code === 'rateLimited') {
          showError(el, '⏳ NewsAPI daily limit reached (100 req/day free plan). Articles will reload automatically in a few hours.');
        } else {
          showError(el, data.message || data.error);
        }
        return;
      }
      const articles = (data.articles || []).filter(a => a.title && a.title !== '[Removed]').slice(0, 10);
      if (!articles.length) { showError(el, 'No articles found.'); return; }
      el.innerHTML = '';
      articles.forEach((a, i) => {
        const time = a.publishedAt
          ? new Date(a.publishedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        const card = document.createElement('div');
        card.className = 'news-card fade-in';
        card.style.animationDelay = `${i * 40}ms`;
        const cardId = `${type}-${i}`;
        card.innerHTML = `
          <div class="n-rank">${String(i + 1).padStart(2, '0')}</div>
          <div class="n-content">
            <div class="n-meta">
              <span class="n-source">${esc(a.source?.name || 'Unknown')}</span>
              ${time ? `<span class="n-time">${time}</span>` : ''}
            </div>
            <div class="n-title"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></div>
            ${a.description ? `<div class="n-desc">${esc(a.description)}</div>` : ''}
            <button class="summarize-btn" data-id="${cardId}">✦ Summarize</button>
            <div class="ai-summary" id="summary-${cardId}"></div>
          </div>`;
        card.querySelector('.summarize-btn').addEventListener('click', () => summarize(a, cardId));
        el.appendChild(card);
      });
    } catch { showError(el, 'Network error. Please try again.'); }
  }

  function showError(el, msg) {
    el.innerHTML = `<div class="status error"><p>${esc(msg)}</p></div>`;
  }

  // ── Sector Heatmap ──
  const sectorContainer = document.getElementById('sector-heatmap-container');

  function sectorStyle(pct) {
    const v = parseFloat(pct);
    if (v >= 1.5) return { bg: '#041a0e', border: '#10d98a66', col: '#10d98a' };
    if (v >= 0.5) return { bg: '#04150b', border: '#10d98a33', col: '#4dc88a' };
    if (v >= 0)   return { bg: 'var(--card)', border: 'var(--border)', col: '#5d7a9e' };
    if (v >= -0.5) return { bg: '#150a0a', border: '#ef505033', col: '#b87070' };
    return { bg: '#1e0606', border: '#ef505066', col: '#ef5050' };
  }

  function renderSectorHeatmap(sectors) {
    const chips = sectors.map(s => {
      const st = sectorStyle(s.changePct);
      const sign = s.changePct >= 0 ? '+' : '';
      return `<div class="sector-tile" style="background:${st.bg};border-color:${st.border}">
        <div class="st-sym" style="color:${st.col}">${esc(s.symbol)}</div>
        <div class="st-name">${esc(s.name)}</div>
        <div class="st-pct" style="color:${st.col}">${sign}${s.changePct}%</div>
      </div>`;
    }).join('');
    sectorContainer.innerHTML = `<div class="sector-grid fade-in">${chips}</div>`;
    document.getElementById('sector-time').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  async function loadSectorHeatmap() {
    try {
      const res = await fetch('/api/sectors');
      const data = await res.json();
      if (data.sectors?.length) renderSectorHeatmap(data.sectors);
    } catch {}
  }
  loadSectorHeatmap();
  setInterval(loadSectorHeatmap, 5 * 60 * 1000);


  // ── Price tracking ──
  const PRICE_KEY = 'pick_price_history';
  const savePriceHist = (t, p) => {
    const h = JSON.parse(localStorage.getItem(PRICE_KEY) || '{}');
    if (!h[t]) h[t] = { firstDate: new Date().toISOString().slice(0,10), firstPrice: p };
    h[t].lastDate = new Date().toISOString().slice(0,10);
    h[t].lastPrice = p;
    localStorage.setItem(PRICE_KEY, JSON.stringify(h));
  };
  const getPriceHist = t => JSON.parse(localStorage.getItem(PRICE_KEY) || '{}')[t] || null;
  const daysBetween  = d => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);

  async function enrichWithPrices(picks) {
    const tickers = picks.map(p => p.ticker).join(',');
    try {
      const res = await fetch(`/api/price?tickers=${encodeURIComponent(tickers)}`);
      const prices = await res.json();
      for (const p of picks) {
        const q = prices[p.ticker];
        if (q?.price) { p._price = q; savePriceHist(p.ticker, q.price); }
      }
    } catch {}
    return picks;
  }

  function buildPriceRow(p) {
    const q = p._price;
    if (!q) return '';
    const up = parseFloat(q.changePct) >= 0;
    const sign = up ? '+' : '';
    const cls  = up ? 'up' : 'down';
    const hist = getPriceHist(p.ticker);
    let sinceHtml = '';
    if (hist?.firstPrice && hist.firstDate !== new Date().toISOString().slice(0,10)) {
      const pct  = ((parseFloat(q.price) - parseFloat(hist.firstPrice)) / parseFloat(hist.firstPrice) * 100);
      const days = daysBetween(hist.firstDate);
      sinceHtml = `<span class="since-tag ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% since picked (${days}d)</span>`;
    }
    let ahHtml = '';
    if (q.afterHours) {
      const ahUp = parseFloat(q.afterHours.changePct) >= 0;
      const tag = q.afterHours.session === 'pre' ? 'PRE' : 'AH';
      ahHtml = `<span class="since-tag ${ahUp ? 'up' : 'down'}">${tag} $${q.afterHours.price} ${ahUp ? '+' : ''}${q.afterHours.changePct}%</span>`;
    }
    return `<div class="price-row">
      <div class="price-tag">
        <span class="p-label">Price</span>
        <span class="p-val">$${q.regularPrice || q.price}</span>
        <span class="p-chg ${cls}">${sign}${q.changePct}% today</span>
      </div>${ahHtml}${sinceHtml}
    </div>`;
  }

  // Swing-structure trade levels for a pick card (entry / next resistance / stop
  // + risk-per-share and reward:risk). Picks with R:R < 2:1 are dropped server-side.
  function buildLevelsRow(p) {
    const lv = p.levels;
    if (!lv) return '';
    return `<div class="alert-targets" style="margin-top:8px">
        <div class="at-box"><div class="at-label">Entry</div><div class="at-val entry">$${p.price ?? lv.entry}</div></div>
        <div class="at-box"><div class="at-label">${targetLabel(lv)}</div><div class="at-val target">$${lv.resistance}</div></div>
        <div class="at-box"><div class="at-label">Stop</div><div class="at-val stop">$${lv.stop}</div></div>
      </div>${rrLineHTML(lv)}`;
  }

  function buildOptionsSignal(signal) {
    if (!signal || signal.toLowerCase().includes('none')) return '';
    const lower = signal.toLowerCase();
    const cls = lower.includes('bull') || lower.includes('call') ? 'bullish'
              : lower.includes('bear') || lower.includes('put')  ? 'bearish' : 'neutral';
    const icon = cls === 'bullish' ? '⬆' : cls === 'bearish' ? '⬇' : '◆';
    return `<div class="options-signal ${cls}">${icon} ${esc(signal)}</div>`;
  }

  function buildFactorBars(factors) {
    const LABELS = {
      newsSentiment:'News Sentiment', fundamentals:'Fundamentals',
      sectorTailwind:'Sector Tailwind', macroAlignment:'Macro Alignment',
      technicalMomentum:'Technical Mom.', riskReward:'Risk/Reward',
      relativeStrength:'Rel. Strength', catalystClarity:'Catalyst',
      valuation:'Valuation', institutionalSignal:'Inst. Signal',
    };
    return `<div class="factor-bars">${Object.entries(factors || {}).map(([k, v]) => {
      const cls = v >= 8 ? 'hi' : v >= 5 ? 'mid' : 'lo';
      return `<div class="fb-row">
        <span class="fb-label">${LABELS[k] || k}</span>
        <div class="fb-track"><div class="fb-fill ${cls}" style="width:${v*10}%"></div></div>
        <span class="fb-val ${cls}">${v}</span>
      </div>`;
    }).join('')}</div>`;
  }

  // ── Stock Picks ──
  const picksContainer   = document.getElementById('picks-container');
  const picksRefreshBtn  = document.getElementById('picks-refresh-btn');
  const picksGenTime     = document.getElementById('picks-gen-time');
  const picksSourceCount = document.getElementById('picks-source-count');

  picksRefreshBtn.addEventListener('click', fetchPicks);
  // Lazy-load: only fetch when the Picks tab opens (it hits a ~20s LLM endpoint).
  let picksLoaded = false;
  function ensurePicks() { if (picksLoaded) return; picksLoaded = true; fetchPicks(); setInterval(fetchPicks, 4 * 60 * 60 * 1000); }

  async function fetchPicks() {
    picksRefreshBtn.disabled = true;
    picksContainer.innerHTML = skeletonGrid(6);
    try {
      const res = await fetch('/api/picks');
      const data = await res.json();
      if (data.error) { showPicksError(data.error); return; }
      await enrichWithPrices([...(data.shortTerm || []), ...(data.longTerm || []), ...(data.watch || [])]);
      renderPicks(data);
    } catch { showPicksError('Could not load picks. Please try again.'); }
    finally { picksRefreshBtn.disabled = false; }
  }

  function renderPicks(data) {
    const { shortTerm = [], longTerm = [], watch = [], generatedAt, sourceCount, articleCount, fundamentalsEnabled } = data;
    if (generatedAt) picksGenTime.textContent = `Generated ${new Date(generatedAt).toLocaleTimeString()}`;
    if (sourceCount) picksSourceCount.textContent = `· ${articleCount ? articleCount + ' articles · ' : ''}${sourceCount} sources`;

    picksContainer.innerHTML = '';
    picksContainer.appendChild(buildPickTrack('short', shortTerm, fundamentalsEnabled));
    picksContainer.appendChild(buildPickTrack('long', longTerm, fundamentalsEnabled));
    if (watch.length) picksContainer.appendChild(buildPickTrack('watch', watch, fundamentalsEnabled));
  }

  const PICK_TRACK_META = {
    short: { title: '⚡ Short-Term', sub: 'days–weeks · confirmed by a technical breakout + volume' },
    long: { title: '🏛 Long-Term', sub: '6–12 months · confirmed by fundamentals (rev growth · expanding margin · valuation)' },
    watch: { title: '👀 Watchlist', sub: 'AI news ideas not yet confirmed by a technical or fundamental screen — watch, don’t chase' },
  };
  function buildPickTrack(track, list, fundamentalsEnabled) {
    const short = track === 'short';
    const wrap = document.createElement('div');
    wrap.className = 'pick-track';
    const meta = PICK_TRACK_META[track] || PICK_TRACK_META.watch;
    wrap.innerHTML = `<div class="pick-track-head"><span class="ptk-title ${track}">${meta.title}</span><span class="ptk-sub">${meta.sub}</span><span class="ptk-cnt">${list.length}</span></div>`;

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'picks-status';
      empty.innerHTML = `<p>${short
        ? 'No picks currently clear the technical breakout + volume criteria.'
        : (fundamentalsEnabled
            ? 'No picks currently clear the long-term fundamental bar — positive revenue growth, positive &amp; expanding operating margin, and reasonable valuation vs sector (meme-spike names excluded).'
            : 'Fundamentals data unavailable — the long-term track needs the data API.')}</p>`;
      wrap.appendChild(empty);
      return wrap;
    }

    const grid = document.createElement('div');
    grid.className = 'picks-grid';
    list.forEach((p, idx) => grid.appendChild(buildPickCard(p, idx, track)));
    wrap.appendChild(grid);
    return wrap;
  }

  // Short-term highlight: the technical breakout read.
  function buildTechBadge(p) {
    const t = p.tech;
    if (!t) return '';
    const st = t.status;
    const cls = st === 'Breakout' ? 'breakout' : st === 'Early' ? 'early' : 'setup';
    const label = st === 'Breakout' ? '🚀 Breakout' : st === 'Early' ? '🌱 Early' : '⏳ Setup';
    const bits = [];
    if (t.volSurge != null) bits.push(`Vol ${t.volSurge}×`);
    if (t.rsVsSpy63 != null) bits.push(`RS ${t.rsVsSpy63 >= 0 ? '+' : ''}${t.rsVsSpy63}%`);
    if (t.baseWeeks != null) bits.push(`${t.baseWeeks}wk base`);
    return `<div class="pc-tech"><span class="pc-tech-badge ${cls}">${label}</span><span class="pc-tech-bits">${bits.join(' · ')}</span></div>`;
  }

  // Long-term highlight: the fundamentals that earned the slot.
  function buildFundBlock(p) {
    const f = p.fundamentals;
    if (!f) return '';
    const peGood = f.pe != null && f.sectorPE != null && f.pe <= f.sectorPE;
    const rows = [
      `<div class="fundrow"><span>Revenue growth</span><b class="${f.revGrowth > 0 ? 'pos' : 'neg'}">${f.revGrowth > 0 ? '+' : ''}${f.revGrowth}%</b></div>`,
      `<div class="fundrow"><span>Operating margin</span><b class="pos">${f.opMarginTTM}%${f.marginExpanding ? ' <span class="fund-exp">▲ expanding</span>' : ''}</b></div>`,
      `<div class="fundrow"><span>P/E vs sector</span><b class="${peGood ? 'pos' : 'neu'}">${f.pe} <small>vs ~${f.sectorPE}</small></b></div>`,
    ];
    if (f.netMargin != null) rows.push(`<div class="fundrow"><span>Net margin</span><b>${f.netMargin}%</b></div>`);
    const run = p.recentRun;
    if (run && run.m1 != null) rows.push(`<div class="fundrow"><span>1-mo move</span><b class="${run.m1 >= 0 ? 'pos' : 'neg'}">${run.m1 >= 0 ? '+' : ''}${run.m1}%</b></div>`);
    return `<div class="pc-fund"><div class="pc-fund-h">📊 Fundamentals — 6–12mo thesis</div>${rows.join('')}</div>`;
  }

  // Quality badges shown on every pick so nothing is hidden — which real screens
  // (if any) the AI idea has cleared.
  function buildQualityBadges(p) {
    const q = p.quality || {};
    const b = [];
    if (q.tech) b.push(`<span class="pc-qb tech">✓ ${q.tech === 'Breakout' ? 'Breakout' : q.tech === 'Early' ? 'Early trend' : 'Setup'}</span>`);
    if (q.fund) b.push(`<span class="pc-qb fund">✓ Fundamentals</span>`);
    if (q.meme) b.push(`<span class="pc-qb meme">⚠ Extended</span>`);
    if (!q.tech && !q.fund) b.push(`<span class="pc-qb watch">👀 Unconfirmed</span>`);
    return b.length ? `<div class="pc-qbadges">${b.join('')}</div>` : '';
  }
  function buildPickCard(p, idx, track) {
    const short = track === 'short';
    const ratingClass = p.overallRating >= 8 ? 'strong-buy' : p.overallRating >= 6 ? 'buy' : 'moderate';
    const card = document.createElement('div');
    card.className = 'pick-card fade-in';
    card.dataset.ticker = p.ticker;
    card.style.animationDelay = `${idx * 50}ms`;
    card.innerHTML = `
        <div class="pc-rank-col">
          <div class="pc-rank-num">#${idx + 1}</div>
          <div class="pc-circle ${ratingClass}">${p.overallRating}</div>
          <div class="pc-label ${ratingClass}">${esc(p.ratingLabel)}</div>
        </div>
        <div class="pc-body">
          <div class="pc-title-row">
            <span class="pc-ticker">${esc(p.ticker)}</span>
            <span class="pc-company">${esc(p.company)}</span>
            <span class="pc-sector">${esc(p.sector)}</span>
            ${p.sourceCoverage ? `<span class="pc-src">📡 ${p.sourceCoverage}</span>` : ''}
          </div>
          ${buildQualityBadges(p)}
          ${short ? buildOptionsSignal(p.optionsSignal) : ''}
          ${buildPriceRow(p)}
          ${short ? buildTechBadge(p) : buildFundBlock(p)}
          ${buildLevelsRow(p)}
          <div class="pc-thesis">${esc(p.thesis)}</div>
          ${short ? buildFactorBars(p.factors) : ''}
          <div class="pc-risk"><span>⚠</span><span>${esc(p.keyRisk)}</span></div>
          ${chartToggleMarkup()}
        </div>`;
    wireChartToggle(card, p.ticker);
    return card;
  }

  function showPicksError(msg) {
    picksContainer.innerHTML = `<div class="picks-status error"><p>${esc(msg)}</p></div>`;
  }


  // ── Options Flow ──
  const optionsContainer  = document.getElementById('options-container');
  const optionsRefreshBtn = document.getElementById('options-refresh-btn');
  const optionsGenTime    = document.getElementById('options-gen-time');
  const optionsMeta       = document.getElementById('options-meta');

  optionsRefreshBtn.addEventListener('click', () => fetchOptions(true));
  // Lazy-load: only fetch when the Options tab opens.
  let optionsLoaded = false;
  function ensureOptions() { if (optionsLoaded) return; optionsLoaded = true; fetchOptions(false); }

  // ── 🛠️ Unusual Options Flow (quantitative — op=optionsflow + op=optionsperf) ──
  let optionsFlowAll = [];
  // ticker -> baseline overlay from the server (op=optionsflow byTicker): is today's
  // option volume abnormal vs THIS name's own archived history? Powers the 🔊 badge.
  let ofBaseline = {};
  // ticker -> latest earnings-call tone (op=tone): { tone, reason, tier, date }. Powers
  // the 🎙 chip on Screener cards. Loaded once, lazily; re-renders when it arrives.
  let toneMap = {};
  let toneLoaded = false;
  function ensureToneMap(onLoad) {
    if (toneLoaded) return;
    toneLoaded = true;
    fetch('/api/tracker?op=tone').then(r => r.json()).then(d => {
      if (d && d.byTicker) { toneMap = d.byTicker; if (typeof onLoad === 'function') onLoad(); }
    }).catch(() => {});
  }
  // A 🎙 tone chip for a pick card: green/red/grey by bucket, with the reason on hover.
  function toneChip(ticker) {
    const t = toneMap[ticker];
    if (!t || t.tone == null) return '';
    const cls = t.tier === 'Bullish' ? 'bull' : t.tier === 'Bearish' ? 'bear' : 'neu';
    const sign = t.tone > 0 ? '+' : '';
    return `<span class="scr-tone ${cls}" title="Earnings-call tone ${sign}${t.tone}/10 (${esc(t.tier || '')}): ${esc(t.reason || '')}${t.callDate ? ' — call ' + esc(String(t.callDate).slice(0,10)) : ''}">🎙 ${sign}${t.tone}</span>`;
  }
  // ticker -> fast-vs-sticky attention (op=attention): { class, note, presence, ... }.
  let attnMap = {};
  let attnLoaded = false;
  function ensureAttnMap(onLoad) {
    if (attnLoaded) return;
    attnLoaded = true;
    fetch('/api/tracker?op=attention').then(r => r.json()).then(d => {
      if (d && d.byTicker) { attnMap = d.byTicker; if (typeof onLoad === 'function') onLoad(); }
    }).catch(() => {});
  }
  // 📈 Sticky (positive) / ⚡ Fast-hype (caution) chip. Building attention is not shown.
  function attnChip(ticker) {
    const a = attnMap[ticker];
    if (!a || (a.class !== 'Sticky' && a.class !== 'Fast')) return '';
    const sticky = a.class === 'Sticky';
    return `<span class="scr-attn ${sticky ? 'sticky' : 'fast'}" title="${esc(a.note || '')}">${sticky ? '📈 Sticky' : '⚡ Fast hype'}</span>`;
  }
  const ofFilters = { type: '', sentiment: '', ticker: '', money: '', minPrem: 0, aggr: '' };
  let ofSort = (() => { try { return localStorage.getItem('ofSort') || 'premium'; } catch { return 'premium'; } })();
  let ofNovice = (() => { try { return localStorage.getItem('ofNovice') !== 'pro'; } catch { return true; } })();
  let ofView = (() => { try { return localStorage.getItem('ofView') === 'contracts' ? 'contracts' : 'ticker'; } catch { return 'ticker'; } })();
  // The FOUR coordinated views (step 10). Default is decision-oriented (Swing Confirmations).
  const OF_PRIMARY = [
    ['confirmations', '✅ Swing Confirmations'],
    ['contradictions', '⚠️ Contradictions & Risk'],
    ['raw', '📊 Raw Activity'],
    ['income', '🅿️ Income & Entry'],
  ];
  const OF_PRIMARY_IDS = OF_PRIMARY.map(v => v[0]);
  let ofPrimaryView = (() => { try { const v = localStorage.getItem('ofPrimaryView'); return OF_PRIMARY_IDS.includes(v) ? v : 'confirmations'; } catch { return 'confirmations'; } })();
  let ofDecisions = [];   // per-ticker deterministic decision records (from op=optionsflow)
  // Confluence cross-reference: ticker -> [{icon,label,route,color,title}] of the
  // app's OWN screeners that currently flag the same name. Built lazily.
  let ofConfluence = null;
  let ofConfLoaded = false;
  let ofRouteWired = false;
  // ticker -> Fable-5 trade plan (op=optionsassess, served on op=optionsflow):
  // { bias, conviction, interpretation, entry, invalidation, vehicle, timeframe,
  //   catalyst, caution, agrees }. Powers the 🧠 per-card plan + the desk read.
  let ofAnalyses = {};
  let ofDeskRead = '';

  async function fetchOptions(refresh) {
    optionsRefreshBtn.disabled = true;
    optionsContainer.innerHTML = skeletonGrid(4);
    try {
      const res = await fetch('/api/tracker?op=optionsflow' + (refresh ? '&refresh=1' : ''));
      const data = await res.json();
      if (!data.ok) { showOptionsError(data.error || 'No options flow available right now.'); return; }
      optionsFlowAll = data.signals || [];
      ofBaseline = {};
      (data.byTicker || []).forEach(r => { if (r && r.ticker) ofBaseline[r.ticker] = { abnormalVsNormal: !!r.abnormalVsNormal, baselineNote: r.baselineNote || '', optVol: r.baseline && r.baseline.optVol }; });
      ofAnalyses = data.analyses || {};
      ofDeskRead = data.deskRead || '';
      ofDecisions = data.decisions || [];
      renderOptionsFlowShell(data);
      applyOptionsView();
      loadOptionsPerf();
      wireOfRoute();
      loadOptionsConfluence(refresh);
    } catch { showOptionsError('Could not load options flow. Please try again.'); }
    finally { optionsRefreshBtn.disabled = false; }
  }

  const OF_SEL = 'padding:7px 9px;border:1px solid #333;border-radius:6px;background:#14171f;color:#e5e7eb;font-size:0.82rem';
  // Client-side aggregation (mirrors lib/optionsflow rollupByTicker/flowSummary so
  // the rollup respects the active filters).
  const OF_INDEX = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'VXX', 'UVXY', 'TLT', 'HYG', 'GLD', 'SLV', 'XLF', 'XLE', 'XLK', 'SMH']);
  const OF_GRADE_BANDS = [[60, 'Very Bullish'], [25, 'Bullish'], [8, 'Slightly Bullish'], [-7, 'Neutral'], [-24, 'Slightly Bearish'], [-59, 'Bearish'], [-100, 'Very Bearish']];
  // Bull/bear grade for a set of contracts (mirrors lib/optionsflow flowGrade):
  // -100..+100 sentiment score, weighting aggressive OTM directional bets more.
  function ofGrade(contracts) {
    let bull = 0, bear = 0, tot = 0;
    (contracts || []).forEach(c => {
      const w = (c.premium || 0) * (1 + (c.kind === 'sweep' ? 0.25 : 0) + (c.moneyness === 'OTM' ? 0.15 : 0));
      if (c.side === 'call') bull += w; else bear += w; tot += w;
    });
    const score = tot > 0 ? Math.round(((bull - bear) / tot) * 100) : 0;
    let label = 'Neutral'; for (const [thr, lbl] of OF_GRADE_BANDS) { if (score >= thr) { label = lbl; break; } }
    return { score, label };
  }
  function ofGradeColor(score) { return score >= 8 ? 'var(--green)' : score <= -8 ? 'var(--red)' : 'var(--text-dim)'; }
  function ofGradeBadge(score, label) {
    const emoji = score >= 8 ? '🟢' : score <= -8 ? '🔴' : '⚪';
    return `<span class="cx-tierbadge" style="color:${ofGradeColor(score)};border-color:currentColor;font-weight:600">${emoji} ${label} ${score > 0 ? '+' : ''}${score}</span>`;
  }
  function ofSummary(sigs) {
    let call = 0, put = 0; sigs.forEach(s => { if (s.side === 'call') call += s.premium; else put += s.premium; });
    const total = call + put;
    const g = ofGrade(sigs);
    return { totalPremium: total, callPremium: call, putPremium: put, bullishPct: total ? Math.round(100 * call / total) : 50, score: g.score, grade: g.label, tickerCount: new Set(sigs.map(s => s.ticker)).size };
  }
  function ofRollup(sigs) {
    const m = new Map();
    sigs.forEach(s => {
      let r = m.get(s.ticker);
      if (!r) { r = { ticker: s.ticker, underlying: s.underlying, undChgPct: s.undChgPct, isIndex: OF_INDEX.has(s.ticker), callPremium: 0, putPremium: 0, contracts: [], sweep: 0, block: 0, large: 0 }; m.set(s.ticker, r); }
      if (s.side === 'call') r.callPremium += s.premium; else r.putPremium += s.premium;
      r.contracts.push(s); r[s.kind] = (r[s.kind] || 0) + 1;
      // EARNINGS PRESERVATION (phase 6): the per-contract signals carry the
      // earnings-before-expiry read from the server. Carry the strongest one up to the
      // ticker row here so the ⚠ warning can NEVER disappear when the browser
      // reaggregates raw activity (it used to be rebuilt from scratch and lost).
      if (s.earningsBeforeExpiry) r.earningsBeforeExpiry = true;
      if (s.earningsInDays != null && (r.earningsInDays == null || s.earningsInDays < r.earningsInDays)) r.earningsInDays = s.earningsInDays;
    });
    const out = [...m.values()].map(r => {
      r.totalPremium = r.callPremium + r.putPremium;
      r.bullishPct = r.totalPremium ? Math.round(100 * r.callPremium / r.totalPremium) : 50;
      r.net = r.bullishPct >= 60 ? 'bullish' : r.bullishPct <= 40 ? 'bearish' : 'mixed';
      const g = ofGrade(r.contracts); r.score = g.score; r.grade = g.label;
      r.contracts.sort((a, b) => b.premium - a.premium);
      r.topContract = r.contracts[0] || null;
      r.maxScore = Math.max(0, ...r.contracts.map(c => c.score || 0));
      r.minDte = Math.min(Infinity, ...r.contracts.map(c => c.dte ?? Infinity));
      r.maxVolOi = Math.max(0, ...r.contracts.map(c => c.volOi || 0));
      return r;
    });
    out.sort((a, b) => b.totalPremium - a.totalPremium);
    return out;
  }
  // Active filters, shared by the view + CSV export. (The flow feed is front-month
  // only — all contracts are near-dated — so we filter by moneyness, not expiry.)
  function ofFilteredItems() {
    let items = optionsFlowAll;
    if (ofFilters.type) items = items.filter(s => s.kind === ofFilters.type);
    if (ofFilters.sentiment) items = items.filter(s => s.sentiment === ofFilters.sentiment);
    if (ofFilters.ticker) items = items.filter(s => (s.ticker || '').includes(ofFilters.ticker));
    if (ofFilters.money) items = items.filter(s => s.moneyness === ofFilters.money);
    if (ofFilters.minPrem) items = items.filter(s => (s.premium || 0) >= ofFilters.minPrem);
    if (ofFilters.aggr) items = items.filter(s => s.aggressor === ofFilters.aggr);
    return items;
  }
  function ofSortContracts(arr) {
    const a = [...arr];
    if (ofSort === 'score') a.sort((x, y) => (y.score || 0) - (x.score || 0));
    else if (ofSort === 'expiry') a.sort((x, y) => (x.dte || 0) - (y.dte || 0));
    else if (ofSort === 'voloi') a.sort((x, y) => (y.volOi || 0) - (x.volOi || 0));
    else a.sort((x, y) => (y.premium || 0) - (x.premium || 0));
    return a;
  }
  function ofSortRollup(arr) {
    const a = [...arr];
    if (ofSort === 'score') a.sort((x, y) => (y.maxScore || 0) - (x.maxScore || 0));
    else if (ofSort === 'expiry') a.sort((x, y) => (x.minDte ?? Infinity) - (y.minDte ?? Infinity));
    else if (ofSort === 'voloi') a.sort((x, y) => (y.maxVolOi || 0) - (x.maxVolOi || 0));
    else a.sort((x, y) => (y.totalPremium || 0) - (x.totalPremium || 0));
    return a;
  }
  function exportOptionsCsv() {
    const items = ofSortContracts(ofFilteredItems());
    const cols = ['ticker', 'side', 'type', 'strike', 'expiry', 'dte', 'volume', 'openInterest', 'volOi', 'bid', 'ask', 'lastPrice', 'aggressor', 'premium', 'iv', 'underlying', 'undChgPct', 'moneyness', 'kind', 'sentiment', 'score'];
    const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [cols.join(','), ...items.map(s => cols.map(c => cell(s[c])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'options-flow-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // One-sentence plain-English read of the whole tape, for Simple mode.
  function ofPlainSummary(sm) {
    const bull = sm.bullishPct >= 58, bear = sm.bullishPct <= 42;
    const lean = bull ? 'leaning bullish' : bear ? 'leaning bearish' : 'mixed / two-sided';
    const col = bull ? 'var(--green)' : bear ? 'var(--red)' : 'var(--text-dim)';
    return `<div class="cx-narrative" style="margin-bottom:10px">💡 <b>Bottom line:</b> today's big options bets are <b style="color:${col}">${lean}</b> — ${sm.bullishPct}% of the unusual premium is in <b>calls</b> (bets on up) vs ${100 - sm.bullishPct}% in <b>puts</b> (bets on down), across ${sm.tickerCount} stock${sm.tickerCount === 1 ? '' : 's'}. Each card below is one stock: <span style="color:var(--green)">green</span> = call-heavy, <span style="color:var(--red)">red</span> = put-heavy.</div>`;
  }
  function ofSummaryBar(sm) {
    return `<div class="rot-panel">${ofNovice ? ofPlainSummary(sm) : ''}<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px">`
      + `<div class="rot-head" style="margin:0">💰 ${ofUsd(sm.totalPremium)} unusual options premium <span class="dt-dim" style="font-weight:400">· ${sm.tickerCount} tickers</span></div>`
      + `<div>Market grade: ${ofGradeBadge(sm.score, sm.grade)}</div></div>`
      + `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:8px">`
      + `<div style="width:${sm.bullishPct}%;background:var(--green)"></div><div style="width:${100 - sm.bullishPct}%;background:var(--red)"></div></div>`
      + `<div class="dt-dim" style="font-size:0.72rem;display:flex;justify-content:space-between;margin-top:3px"><span>▲ calls ${ofUsd(sm.callPremium)}</span><span>puts ${ofUsd(sm.putPremium)} ▼</span></div></div>`;
  }

  // ── Confluence cross-reference ───────────────────────────────────────────────
  // Joins each options-flow ticker against the app's own screeners so you can see
  // when unusual options activity lines up with a Breakout, a Ghost accumulation
  // setup, top conviction, or a live day-trade mover. Pure client-side join over
  // data the app already serves — this is what ties the separate tools together.
  function buildConfluence(screener, daytrade, coil) {
    const map = {};
    const add = (tk, sig) => { if (tk) (map[tk] || (map[tk] = [])).push(sig); };
    (screener?.results || []).forEach(c => {
      const tk = c.ticker;
      if (c.status === 'Breakout' && c.qualifies)
        add(tk, { icon: '🔥', label: 'Breakout', route: 'screener', color: 'var(--green)', title: 'Also a current candidate in the Breakout screener' });
      const gt = c.ghost?.tier;
      if (gt === 'GHOST' || gt === 'STALKING')
        add(tk, { icon: '👻', label: gt === 'GHOST' ? 'Ghost' : 'Stalking', route: 'ghost', color: '#a78bfa', title: 'Showing quiet accumulation in the Ghost Accumulation screener' });
      if (c.conviction && (c.conviction.sleeveA || c.conviction.pctile >= 80))
        add(tk, { icon: '🎯', label: 'Top conviction', route: 'custom', color: '#06c4d4', title: 'Top-quintile conviction in the Adaptive Momentum model' });
    });
    // Day-trade movers, enriched with each name's relative volume (RVOL) — the
    // "unusually heavy volume" leg of the wishlist, shown right on the badge.
    const rvol = {};
    [...(daytrade?.momentumLiquid || []), ...(daytrade?.explosiveSmall || [])].forEach(x => {
      if (!x.ticker) return;
      rvol[x.ticker] = Math.max(rvol[x.ticker] || 0, x.relVol || 0);
    });
    Object.keys(rvol).forEach(tk => {
      const rv = rvol[tk];
      const rvTxt = rv >= 1.5 ? ` ${rv}× vol` : '';
      add(tk, { icon: '🚀', label: 'Day-trade mover' + rvTxt, route: 'daytrade', color: 'var(--amber,#f59e0b)', title: `Live mover in the Day Trade screener${rv ? ` — trading ${rv}× its average volume today` : ''}` });
    });
    (coil?.picks || []).forEach(p => {
      add(p.ticker, { icon: '🌀', label: 'Coil', route: 'coil', color: '#e879f9', title: 'A volatility-contracted "coil" in the Coil Radar — quiet compression before a potential break' });
    });
    return map;
  }

  async function loadOptionsConfluence(force) {
    if (ofConfLoaded && !force) return;
    ofConfLoaded = true;
    try {
      const [scr, dt, coil] = await Promise.all([
        fetch('/api/screener?scope=large').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=daytrade').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=coil&scope=large&limit=24').then(r => r.json()).catch(() => null),
      ]);
      ofConfluence = buildConfluence(scr, dt, coil);
      if (document.getElementById('of-grid')) applyOptionsView(); // re-decorate now that the join is ready
    } catch { /* badges are an enhancement — ignore failures */ }
  }

  function ofConfluenceHTML(ticker) {
    const sigs = ofConfluence && ofConfluence[ticker];
    if (!sigs || !sigs.length) return '';
    const badge = s => `<span class="of-conf cx-tierbadge" data-of-route="${s.route}" title="${esc(s.title)}" style="color:${s.color};border-color:currentColor;cursor:pointer">${s.icon} ${esc(s.label)}</span>`;
    return `<div class="of-conf-row" style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">${sigs.map(badge).join('')}</div>`;
  }

  // ── 🧠 Fable-5 trade analysis (op=optionsassess) ─────────────────────────────
  const OF_VEHICLE = { shares: '📈 Own shares (simplest)', call_option: '🎟 Long calls (leveraged, decays)', put_option: '🎟 Long puts (leveraged, decays)', spread: '🎯 Defined-risk spread', avoid: '🚫 Avoid / no trade' };
  const OF_TIMEFRAME = { intraday: 'intraday', swing: 'swing (days–weeks)', position: 'position (weeks–months)' };
  function ofBiasChip(bias) {
    const col = bias === 'bullish' ? 'var(--green)' : bias === 'bearish' ? 'var(--red)' : 'var(--text-dim)';
    const lbl = bias === 'bullish' ? '▲ Bullish' : bias === 'bearish' ? '▼ Bearish' : '● Neutral';
    return `<span class="cx-tierbadge" style="color:${col};border-color:currentColor">${lbl}</span>`;
  }
  function ofClarityChip(c) {
    const col = c === 'clear' ? 'var(--green)' : c === 'mixed' ? 'var(--amber,#f0a832)' : 'var(--text-dim)';
    const lbl = c === 'clear' ? 'Clear evidence' : c === 'mixed' ? 'Mixed evidence' : 'Thin evidence';
    return `<span class="cx-tierbadge" title="How clearly the shown flow reads — clear = aggressive same-direction prints on a reliable quote; mixed = two-sided/conflicting; thin = one lone print, unreliable quote, or wide/illiquid. Evidence quality, NOT a probability of profit." style="color:${col};border-color:currentColor">🔎 ${lbl}</span>`;
  }
  // The per-ticker AI trade plan block, rendered on both Simple and Pro cards when
  // op=optionsassess has run. Stock-specific — replaces the generic "what you could do".
  function ofAiPlanHTML(ticker) {
    const a = ofAnalyses[ticker];
    if (!a) return '';
    const refine = (a.agrees === false)
      ? ` <span class="dt-dim" title="Fable's read differs from the raw call/put lean — it weighs the aggressor, DTE and tape, not just which side traded" style="font-size:0.72rem">↔ refines the raw lean</span>`
      : '';
    const caution = a.caution ? `<div class="of-warn" style="margin-top:6px">⚠ ${esc(a.caution)}</div>` : '';
    return `<div class="of-action" style="border-left-color:#a78bfa">`
      + `<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-bottom:5px">`
      + `<b style="color:#a78bfa">🧠 AI read</b> ${ofBiasChip(a.bias)} ${ofClarityChip(a.evidenceClarity)}${refine}</div>`
      + (a.interpretation ? `<div style="line-height:1.55">${esc(a.interpretation)}</div>` : '')
      + `<div style="margin-top:4px"><b>🛠 Lower-risk expression:</b> ${OF_VEHICLE[a.vehicle] || esc(a.vehicle)}${a.timeframe ? ` · <span class="dt-dim">${OF_TIMEFRAME[a.timeframe] || esc(a.timeframe)}</span>` : ''}</div>`
      + caution
      + `<div class="dt-dim" style="font-size:0.7rem;margin-top:6px">Grounded explanation of the shown flow — it invents no price levels, catalysts, or probability, and cannot promote this overlay to a live signal. Levels come from your chart; confirm with the Track Record below.</div></div>`;
  }
  // The desk read — one AI summary of the day's most tradeable flow, atop the grid.
  function ofDeskReadHTML() {
    if (!ofDeskRead) return '';
    return `<div class="cx-narrative" style="margin-bottom:12px;border-left:3px solid #a78bfa;padding-left:10px">🧠 <b style="color:#a78bfa">Desk read:</b> ${esc(ofDeskRead)}</div>`;
  }

  // One delegated handler on the persistent container: tap a badge → jump to that screener.
  function wireOfRoute() {
    if (ofRouteWired) return;
    ofRouteWired = true;
    optionsContainer.addEventListener('click', e => {
      const b = e.target.closest('.of-conf');
      if (b && b.dataset.ofRoute && typeof showTab === 'function') showTab(b.dataset.ofRoute);
    });
  }

  function renderOptionsFlowShell(data) {
    if (optionsGenTime) optionsGenTime.textContent = data.generatedAt ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : '';
    if (optionsMeta) optionsMeta.textContent = `· ${data.count} unusual signals across ${data.universe} liquid names`;
    const vtab = (id, lbl, on) => `<button id="${id}" class="dt-btn" style="border-radius:0;border:none;${on ? 'background:#06c4d4;color:#001' : 'background:transparent'}">${lbl}</button>`;
    const shadowBanner =
      `<div class="dt-note" style="margin-bottom:12px;border-left:3px solid var(--amber,#f0a832);padding:8px 10px;background:rgba(240,168,50,0.07)">`
      + `<b>🔬 Research / shadow overlay · delayed data.</b> This is derived from <b>delayed</b>, free option-chain data (no live tick tape, no trade-level OPRA). `
      + `We <b>cannot</b> tell whether a trade opened or closed, was bought or sold, or was a hedge — so every directional read here is <b>provisional</b> `
      + `(<i>provisional bullish/bearish, mixed, or direction-unknown</i>), never proof and never "smart money". `
      + `It <b>cannot by itself create or boost a Today's Pick</b> — it only confirms, contradicts, or flags risk on an independent price setup.</div>`;
    // ── The FOUR coordinated views (primary nav) ──
    const pvBtn = (id, lbl, on) => `<button data-pv="${id}" class="dt-btn of-pv" style="border-radius:0;border:none;${on ? 'background:#06c4d4;color:#001' : 'background:transparent'}">${lbl}</button>`;
    const cCount = (ofDecisions || []).filter(d => d.view === 'confirmation').length;
    const xCount = (ofDecisions || []).filter(d => d.view === 'contradiction').length;
    const pvLabel = (id, lbl) => id === 'confirmations' && cCount ? `${lbl} (${cCount})` : id === 'contradictions' && xCount ? `${lbl} (${xCount})` : lbl;
    const primaryNav = `<div style="display:inline-flex;border:1px solid #333;border-radius:6px;overflow:hidden;flex-wrap:wrap;margin-bottom:12px">${OF_PRIMARY.map(([v, l]) => pvBtn(v, pvLabel(v, l), ofPrimaryView === v)).join('')}</div>`;
    const wirePrimaryNav = () => optionsContainer.querySelectorAll('.of-pv').forEach(b => b.addEventListener('click', () => {
      ofPrimaryView = b.dataset.pv; try { localStorage.setItem('ofPrimaryView', ofPrimaryView); } catch {}
      renderOptionsFlowShell(data);
    }));

    // Confirmations / Contradictions — the interpreted, decision-oriented views.
    if (ofPrimaryView === 'confirmations' || ofPrimaryView === 'contradictions') {
      optionsContainer.innerHTML = `<div id="of-summary" style="margin-bottom:14px"></div>` + shadowBanner + primaryNav
        + `<div id="of-decisions"></div><div id="of-perf" style="margin-top:26px"></div>`;
      const sm = document.getElementById('of-summary'); if (sm) sm.innerHTML = ofSummaryBar(ofSummary(optionsFlowAll));
      renderDecisionsView();
      wirePrimaryNav();
      loadOptionsPerf();
      return;
    }
    // Income & Entry — real listed cash-secured puts (reuses the CSP renderer inline).
    if (ofPrimaryView === 'income') {
      optionsContainer.innerHTML = `<div id="of-summary"></div>` + shadowBanner + primaryNav
        + `<div id="of-income"><div class="mom-status"><div class="mom-spinner"></div><p>Loading income &amp; entry setups…</p></div></div>`;
      wirePrimaryNav();
      loadIncomeView();
      return;
    }
    // Raw Activity — the transparent underlying measurements (existing shell, unchanged).
    optionsContainer.innerHTML =
      `<div id="of-summary" style="margin-bottom:14px"></div>`
      + shadowBanner
      + primaryNav
      + `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">`
      + `<div style="display:inline-flex;border:1px solid #333;border-radius:6px;overflow:hidden">${vtab('of-v-ticker', '📊 By ticker', ofView === 'ticker')}${vtab('of-v-contracts', '📜 All contracts', ofView === 'contracts')}</div>`
      + `<div style="display:inline-flex;border:1px solid #333;border-radius:6px;overflow:hidden">${vtab('of-m-simple', '🔰 Simple', ofNovice)}${vtab('of-m-pro', '📊 Pro', !ofNovice)}</div>`
      + `<span class="dt-dim" style="font-size:0.74rem">${ofNovice ? 'Plain-English reads' : 'Full numbers & filters'}</span></div>`
      + `<details id="of-explainer" class="dt-note" style="margin-bottom:12px"${ofNovice ? ' open' : ''}><summary style="cursor:pointer;font-weight:600">📖 New to options flow? How to read this</summary>`
      + `<div style="margin-top:8px;line-height:1.65;font-size:0.85rem">We flag contracts trading unusually heavily today (volume vs open interest, plus estimated premium), then group them by ticker. Because the data is delayed and has no trade-level tape, we describe what the activity <i>could</i> mean — never what someone "did".`
      + `<ul style="margin:8px 0;padding-left:18px">`
      + `<li><b>Calls / puts are not automatically bullish / bearish.</b> A call can be sold and a put can be a hedge. We only call activity <b>provisional bullish/bearish</b> when the last trade printed at the <b>ask</b> on a reliable quote (aggressive buying); otherwise it's <b>direction unknown</b>.</li>`
      + `<li><b>Provisional / mixed / unknown</b> = the honest directional state for a ticker. <i>Mixed</i> means bullish and bearish activity both show up; <i>unknown</i> means we can't defend a lean.</li>`
      + `<li><b>🎯 Single-stock</b> activity may reflect conviction; <b>🛡 Index/ETF</b> activity (SPY, QQQ…) is often hedging — so we separate them.</li>`
      + `<li><b>High-turnover contract</b> = volume far above open interest (new activity, not confirmed "sweep"). <b>Large estimated notional</b> = a big estimated dollar size (not a confirmed institutional "block"). These are size heuristics, not tape.</li>`
      + `<li><b>⬆ @ ask / ⬇ @ bid</b> = where the <i>last</i> print landed in the spread. @ ask supports aggressive buying; @ bid is <b>unknown</b> (could be selling, closing, a spread, or liquidity). One print, not the whole day.</li>`
      + `<li><b>Suspected spread / multi-leg</b> = coordinated contracts that look like a spread or combo. We mark these <b>ambiguous</b> rather than force a direction.</li>`
      + `<li><b>Breakeven & "needs +X%"</b> = how far the stock must move (and to what price) by expiry for a simple long option to pay — the real bar, shown for context.</li>`
      + `<li><b>⚠ ER (earnings)</b> = the company reports earnings <i>before</i> these options expire — an <b>event bet</b> where options can lose value even if the stock moves your way (volatility "crush"). Tread carefully.</li>`
      + `<li><b>Confluence badges</b> appear when the same ticker is <i>also</i> flagged by one of the app's own price/volume screeners — agreement is a stronger read than options activity alone. Tap a badge to jump there.</li>`
      + `<li><b>🧠 AI read</b> explains the activity in plain language — it does not invent levels, catalysts, or a probability, and it cannot promote this overlay to a live signal.</li></ul>`
      + `<b>Important:</b> this is a <b>research/shadow</b> overlay on <b>delayed</b> data — a provisional confirmation layer, not advice and not a standalone signal. The Track Record below shows whether the activity actually preceded moves.</div></details>`
      + `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">`
      + `<select id="of-sent" style="${OF_SEL}"><option value="">All sentiment</option><option value="bullish">▲ Bullish</option><option value="bearish">▼ Bearish</option></select>`
      + `<select id="of-type" style="${OF_SEL}"><option value="">All activity types</option><option value="sweep">⚡ High-turnover</option><option value="block">🧱 Large notional</option><option value="large">💰 Premium activity</option></select>`
      + `<input id="of-ticker" placeholder="Filter ticker (e.g. NVDA)" style="${OF_SEL};width:170px">`
      + `<select id="of-prem" style="${OF_SEL}"><option value="0">Any premium</option><option value="100000">≥ $100k</option><option value="250000">≥ $250k</option><option value="1000000">≥ $1M (est. notional)</option></select>`
      + (ofNovice ? '' :
          `<select id="of-money" style="${OF_SEL}"><option value="">All moneyness</option><option value="OTM">OTM (directional)</option><option value="ATM">ATM</option><option value="ITM">ITM</option></select>`
        + `<select id="of-aggr" style="${OF_SEL}"><option value="">Any fill</option><option value="ask">⬆ Bought at ask</option><option value="bid">⬇ Sold at bid</option></select>`
        + `<select id="of-sort" style="${OF_SEL}"><option value="premium">Sort: Premium</option><option value="score">Sort: Unusualness</option><option value="expiry">Sort: Soonest expiry</option><option value="voloi">Sort: Vol / OI</option></select>`
        + `<button id="of-csv" class="dt-btn" title="Download the filtered flow as CSV">⬇ CSV</button>`)
      + `<span id="of-count" class="dt-dim" style="font-size:0.78rem"></span></div>`
      + `<div id="of-grid"></div>`
      + `<div id="of-perf" style="margin-top:26px"></div>`;
    const t = document.getElementById('of-type'), se = document.getElementById('of-sent'), tk = document.getElementById('of-ticker');
    const pr = document.getElementById('of-prem');
    // Pro-only controls (absent in Simple mode) — guard every reference.
    const mn = document.getElementById('of-money'), so = document.getElementById('of-sort'), ag = document.getElementById('of-aggr');
    // Restore current control state (the shell is rebuilt on view/mode switches).
    t.value = ofFilters.type; se.value = ofFilters.sentiment; tk.value = ofFilters.ticker;
    pr.value = String(ofFilters.minPrem);
    if (mn) mn.value = ofFilters.money; if (so) so.value = ofSort; if (ag) ag.value = ofFilters.aggr;
    t.addEventListener('change', () => { ofFilters.type = t.value; applyOptionsView(); });
    se.addEventListener('change', () => { ofFilters.sentiment = se.value; applyOptionsView(); });
    tk.addEventListener('input', () => { ofFilters.ticker = tk.value.trim().toUpperCase(); applyOptionsView(); });
    pr.addEventListener('change', () => { ofFilters.minPrem = parseInt(pr.value, 10) || 0; applyOptionsView(); });
    if (mn) mn.addEventListener('change', () => { ofFilters.money = mn.value; applyOptionsView(); });
    if (ag) ag.addEventListener('change', () => { ofFilters.aggr = ag.value; applyOptionsView(); });
    if (so) so.addEventListener('change', () => { ofSort = so.value; try { localStorage.setItem('ofSort', ofSort); } catch {} applyOptionsView(); });
    const csv = document.getElementById('of-csv'); if (csv) csv.addEventListener('click', exportOptionsCsv);
    const setView = (v) => { ofView = v; try { localStorage.setItem('ofView', v); } catch {} renderOptionsFlowShell(data); applyOptionsView(); loadOptionsPerf(); };
    document.getElementById('of-v-ticker').addEventListener('click', () => setView('ticker'));
    document.getElementById('of-v-contracts').addEventListener('click', () => setView('contracts'));
    // Simple ⇄ Pro rebuilds the shell so the filter set + card density match the mode.
    const setMode = (novice) => {
      if (novice === ofNovice) return;
      ofNovice = novice;
      try { localStorage.setItem('ofNovice', novice ? 'novice' : 'pro'); } catch {}
      // Pro's advanced filters vanish in Simple — clear them so hidden filters
      // don't silently keep narrowing the list.
      if (novice) { ofFilters.money = ''; ofFilters.aggr = ''; }
      renderOptionsFlowShell(data); applyOptionsView(); loadOptionsPerf();
    };
    document.getElementById('of-m-simple').addEventListener('click', () => setMode(true));
    document.getElementById('of-m-pro').addEventListener('click', () => setMode(false));
    wirePrimaryNav();
  }

  // ── The four-view decision renderers (Swing Confirmations / Contradictions & Risk) ──
  const OF_ACTION = { REVIEW: ['var(--green)', '🔎 REVIEW'], WAIT: ['var(--amber,#f0a832)', '⏳ WAIT'], AVOID: ['var(--red)', '🚫 AVOID'] };
  const OF_TIER = { 'confirmed-shadow': 'Confirmed (shadow)', provisional: 'Provisional', contradiction: 'Contradiction', informational: 'Informational' };
  const OF_HORIZON_LBL = { '0-7': '0–7 DTE', '8-20': '8–20 DTE', '21-45': '21–45 DTE (swing)', '46-75': '46–75 DTE', '75+': '> 75 DTE' };

  function decisionCard(d) {
    const [acol, albl] = OF_ACTION[d.action] || OF_ACTION.WAIT;
    const setupTxt = d.setupDirection === 'long' ? '▲ Long setup' : d.setupDirection === 'short' ? '▼ Short setup' : 'No clean setup';
    const setupCol = d.setupDirection === 'long' ? 'var(--green)' : d.setupDirection === 'short' ? 'var(--red)' : 'var(--text-dim)';
    const dcol = d.optionsDirection === 'PROVISIONAL_BULLISH' ? 'var(--green)' : d.optionsDirection === 'PROVISIONAL_BEARISH' ? 'var(--red)' : 'var(--text-dim)';
    const qChip = `<span class="cx-tierbadge" style="color:var(--text-dim);border-color:#444" title="How clearly the shown options evidence reads">${esc(d.evidenceQuality)} evidence${d.oiConfirmedContracts ? ` · OI building×${d.oiConfirmedContracts}` : ''}</span>`;
    const lvl = (lbl, v) => v != null ? `<div><span class="dt-dim">${lbl}</span> <b>$${esc(String(v))}</b></div>` : '';
    const levels = d.setupValid
      ? `<div class="ps-trade" style="display:flex;gap:14px;flex-wrap:wrap;font-size:0.82rem">${lvl('Trigger', d.trigger)}${lvl('Invalidation', d.invalidation)}${lvl('Target', d.target)}${d.rr != null ? `<div><span class="dt-dim">R:R</span> <b>${d.rr}</b></div>` : ''}</div>`
      : `<div class="dt-dim" style="font-size:0.8rem">No valid stock setup — see Raw Activity for the underlying measurements.</div>`;
    const evChip = d.eventRisk !== 'none' ? `<span class="ps-earn">📅 Earnings before expiry</span>` : '';
    const horizon = d.horizonAlignment ? `<span class="ps-meta">${OF_HORIZON_LBL[d.horizonAlignment] || d.horizonAlignment}</span>` : '';
    const expert = `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:0.76rem" class="dt-dim">Expert detail</summary>
      <div class="dt-dim" style="font-size:0.76rem;line-height:1.5;margin-top:4px">
        Setup direction <b>${esc(d.setupDirection)}</b> (quality ${d.setupQuality != null ? (d.setupQuality * 100).toFixed(0) + '%' : '—'}) · options <b style="color:${dcol}">${esc(d.optionsDirectionLabel)}</b> → confirmation state <b>${esc(d.confirmationState)}</b><br>
        Evidence tier: ${OF_TIER[d.evidenceTier] || d.evidenceTier} · data ${esc(d.dataQuality)} · liquidity ${esc(d.liquidityQuality)} · maturity <b>${esc(d.researchMaturity)}</b> (weight 0)<br>
        Levels are deterministic chart math (support $${esc(String(d.support))} / resistance $${esc(String(d.resistance))}) — not from options or an LLM.
      </div></details>`;
    return `<div class="dt-card" data-ticker="${esc(d.ticker)}">
      <div class="ps-top" style="align-items:center">
        <span class="ps-tk">${esc(d.ticker)}</span>
        ${d.spot != null ? `<span class="ps-now">$${esc(String(d.spot))}</span>` : ''}
        <span class="cx-tierbadge" style="color:${setupCol};border-color:currentColor">${setupTxt}</span>
        <span class="cx-tierbadge" style="color:${acol};border-color:currentColor;font-weight:700">${albl}</span>
      </div>
      <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">${qChip}${horizon}${evChip}</div>
      ${levels}
      <div class="ps-reasons" style="margin-top:6px">${(d.reasons || []).map(esc).join(' · ')}</div>
      ${expert}
    </div>`;
  }

  function renderDecisionsView() {
    const el = document.getElementById('of-decisions'); if (!el) return;
    const isConf = ofPrimaryView === 'confirmations';
    const wantView = isConf ? 'confirmation' : 'contradiction';
    const list = (ofDecisions || []).filter(d => d.view === wantView);
    const intro = isConf
      ? 'Options evidence that <b>supports</b> a valid stock swing setup. Every price level is deterministic chart math — options only confirm the setup, they never originate a trade.'
      : 'Options evidence that <b>conflicts</b> with the price setup, looks hedge-like, carries event risk, or is too ambiguous to trade — the honest reasons to stand aside.';
    const empty = `<div class="rot-sub dt-dim">No ${isConf ? 'confirmations' : 'contradictions'} right now — that's common: most unusual flow doesn't line up cleanly with a valid setup. Check <b>Raw Activity</b> for the underlying measurements, or <b>Income &amp; Entry</b> for cash-secured puts.</div>`;
    el.innerHTML = `<div class="dt-note" style="margin-bottom:10px">${intro}</div>`
      + (list.length ? `<div class="scr-grid">${list.map(decisionCard).join('')}</div>` : empty);
  }

  async function loadIncomeView() {
    const el = document.getElementById('of-income'); if (!el) return;
    try {
      const t = await fetch('/api/tracker?op=putsell').then(r => r.json());
      renderPutSell(t, 'of-income');
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load income &amp; entry setups.</p></div>`; }
  }

  function applyOptionsView() {
    const grid = document.getElementById('of-grid'); if (!grid) return;
    const items = ofFilteredItems();
    const sm = document.getElementById('of-summary'); if (sm) sm.innerHTML = ofDeskReadHTML() + ofSummaryBar(ofSummary(items));
    const cnt = document.getElementById('of-count');
    const empty = `<div class="rot-sub dt-dim">No signals match the filters.</div>`;
    if (ofView === 'contracts') {
      if (cnt) cnt.textContent = `${items.length} contracts`;
      grid.innerHTML = items.length ? `<div class="scr-grid">${ofSortContracts(items).map(optionsFlowCard).join('')}</div>` : empty;
    } else {
      const roll = ofSortRollup(ofRollup(items));
      const single = roll.filter(r => !r.isIndex), idx = roll.filter(r => r.isIndex);
      if (cnt) cnt.textContent = `${roll.length} tickers`;
      const block = (title, rows) => rows.length ? `<div class="rot-head" style="margin:4px 0 8px">${title} <span class="dt-dim" style="font-weight:400">· ${rows.length}</span></div><div class="scr-grid" style="margin-bottom:18px">${rows.map(tickerRollupCard).join('')}</div>` : '';
      grid.innerHTML = (block('🎯 Single-stock conviction', single) + block('🛡 Index / ETF flow (often hedging)', idx)) || empty;
      grid.querySelectorAll('.of-expand').forEach(b => b.addEventListener('click', () => {
        const body = b.nextElementSibling; if (body) { const open = body.style.display !== 'none'; body.style.display = open ? 'none' : ''; b.textContent = open ? `▸ show ${b.dataset.n} contracts` : '▾ hide contracts'; }
      }));
    }
  }

  function tickerRollupCard(r) {
    const gcol = ofGradeColor(r.score);
    const tc = r.topContract;
    const beNote = (tc && tc.breakeven != null && tc.moveToBePct != null)
      ? ` Its biggest bet (the $${esc(String(tc.strike))} ${tc.side === 'call' ? 'calls' : 'puts'}) needs <b>${tc.moveToBePct > 0 ? '+' : ''}${tc.moveToBePct}%</b> to $${esc(String(tc.breakeven))} by ${esc(tc.expiry || 'expiry')} to break even.`
      : '';
    // HONEST aggregate state (from the server): provisional bullish/bearish, mixed, or
    // direction-unknown — NOT a raw call/put "bullish grade".
    const dsLabel = r.directionLabel || (r.directionState === 'PROVISIONAL_BULLISH' ? 'Provisional bullish'
      : r.directionState === 'PROVISIONAL_BEARISH' ? 'Provisional bearish'
      : r.directionState === 'MIXED' ? 'Mixed' : 'Direction unknown');
    const actionable = r.directionState === 'PROVISIONAL_BULLISH' || r.directionState === 'PROVISIONAL_BEARISH';
    // Stock-specific Fable trade plan (both modes). When present it supersedes the
    // generic "what you could do" template; fall back to that only without an AI plan.
    const aiPlan = ofAiPlanHTML(r.ticker);
    const unknownNote = r.unknownShare != null && r.unknownShare >= 0.5
      ? ` Most of the activity is direction-unknown (${Math.round(r.unknownShare * 100)}%).` : '';
    const mlNote = r.suspectedMultiLeg ? ` ${r.suspectedMultiLeg} contract${r.suspectedMultiLeg > 1 ? 's' : ''} look like part of a spread/multi-leg order.` : '';
    const narrative = ofNovice
      ? `<div class="cx-narrative" style="margin-top:8px">💡 ${esc(r.ticker)}'s unusual options activity reads <b style="color:${gcol}">${dsLabel}</b> on delayed data — ${ofUsd(r.callPremium)} in call vs ${ofUsd(r.putPremium)} in put estimated premium, across ${r.contracts.length} contract${r.contracts.length > 1 ? 's' : ''}. Calls/puts aren't automatically bullish/bearish; this is a provisional lean, not proof.${unknownNote}${mlNote}${beNote}</div>`
      : '';
    const genericAction = (ofNovice && !aiPlan) ? flowAction({ directionState: r.directionState, suspectedMultiLeg: r.suspectedMultiLeg }) : '';
    const body = `${narrative}${flowEarningsWarn(r)}${aiPlan}${genericAction}`;
    const erChip = r.earningsBeforeExpiry ? `<span class="cx-tierbadge" style="color:var(--amber,#f0a832);border-color:currentColor" title="Earnings report lands before these options expire — an event/IV-crush risk">⚠ ER ${r.earningsInDays}d</span>` : '';
    // Baseline overlay: flag names whose option volume is abnormally high vs their OWN
    // archived history — "unusual relative to normal", not just a big absolute number.
    const bl = ofBaseline[r.ticker], blAbn = bl && bl.abnormalVsNormal;
    const blChip = blAbn
      ? `<span class="cx-tierbadge" style="color:#a78bfa;border-color:currentColor" title="Option volume ${esc(bl.baselineNote || 'is unusually high')} — unusual relative to ${esc(r.ticker)}'s OWN recent history, not just an absolute size threshold">🔊 ${bl.optVol && bl.optVol.z != null ? '+' + bl.optVol.z + 'σ vol' : 'abnormal vol'}</span>`
      : '';
    const blNote = (blAbn && ofNovice)
      ? `<div class="cx-narrative" style="margin-top:6px;color:#a78bfa">🔊 <b>Unusual for this name:</b> its option volume is ${esc(bl.baselineNote || 'well above its own recent norm')} — a spike vs its own history, not just a big absolute number.</div>`
      : '';
    const aggrMark = s => s.aggressor === 'ask' ? ' <span style="color:var(--green)">⬆@ask</span>' : s.aggressor === 'bid' ? ' <span style="color:var(--red)">⬇@bid</span>' : '';
    const contractRow = s => `<div class="dt-dim" style="font-size:0.74rem;padding:2px 0">${esc(s.type)} $${esc(String(s.strike))} ${esc(s.expiry || '')} (${s.dte}d) · ${ofUsd(s.premium)} · ${OF_KIND[s.kind] || esc(s.kind)} · ${s.sentiment === 'bullish' ? '▲' : '▼'}${aggrMark(s)}${s.lastTradeTs ? ` · ${ofTime(s.lastTradeTs)}` : ''}</div>`;
    const expand = `<button class="of-expand dt-btn" data-n="${r.contracts.length}" style="margin-top:8px;font-size:0.74rem;padding:3px 8px">▸ show ${r.contracts.length} contract${r.contracts.length > 1 ? 's' : ''}</button>`
      + `<div style="display:none;margin-top:6px;border-top:1px solid #222;padding-top:6px">${r.contracts.map(contractRow).join('')}</div>`;
    return `<div class="cx-card" style="border-left:3px solid ${gcol}">`
      + `<div class="cx-top"><div><div class="cx-tk-row"><span class="cx-ticker" data-live="${esc(r.ticker)}">$${esc(r.ticker)}</span>`
      + ofGradeBadge(r.score, r.grade) + erChip + blChip + (tc ? ofAggrChip(tc) : '') + `</div>`
      + `<div class="cx-company">${r.contracts.length} unusual contract${r.contracts.length > 1 ? 's' : ''}${r.sweep ? ` · ${r.sweep}⚡` : ''}${r.block ? ` · ${r.block}🧱` : ''}${r.underlying ? ` · spot $${r.underlying}${r.undChgPct != null ? ` (${ofChg(r.undChgPct)})` : ''}` : ''}</div></div>`
      + `<div class="cx-score-col"><div class="cx-score" style="color:#06c4d4;font-size:1.05rem">${ofUsd(r.totalPremium)}</div><div class="cx-price">${r.bullishPct}% calls</div></div></div>`
      + `<div style="display:flex;height:7px;border-radius:4px;overflow:hidden;margin-top:8px"><div style="width:${r.bullishPct}%;background:var(--green)"></div><div style="width:${100 - r.bullishPct}%;background:var(--red)"></div></div>`
      + ofConfluenceHTML(r.ticker) + blNote + body + expand + `</div>`;
  }

  function ofUsd(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'k' : '$' + n; }
  const OF_KIND = { sweep: '⚡ High-turnover', block: '🧱 Large notional', large: '💰 Premium activity' };
  // Aggressor of the last print: at-ask (bought, ⬆) confirms the call=bullish /
  // put=bearish lean; at-bid (sold, ⬇) fades it. mid/none → no chip.
  function ofAggrChip(s) {
    if (!s.aggressor || s.aggressor === 'mid') return '';
    const ask = s.aggressor === 'ask';
    const col = ask ? 'var(--green)' : 'var(--red)';
    const tip = ask
      ? 'The last print lifted the ask — buyer-initiated, which backs the directional lean.'
      : 'The last print hit the bid — seller-initiated, which fades the lean (could be writing/closing). Reads the last trade, not the whole day.';
    return `<span class="cx-tierbadge" title="${esc(tip)}" style="color:${col};border-color:currentColor">${ask ? '⬆ @ ask' : '⬇ @ bid'}</span>`;
  }
  // Last-trade time (contract's own last print). Unix seconds → local HH:MM.
  function ofTime(ts) {
    if (!ts) return '';
    try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  }
  // Underlying's move on the day, colored.
  function ofChg(pct) {
    if (pct == null) return '';
    const col = pct >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${col}">${pct > 0 ? '+' : ''}${pct}%</span>`;
  }
  // Plain-English read of one signal, built deterministically — HONEST about what
  // delayed, tape-less chain data can and cannot establish (no "someone bet X").
  function flowPlainEnglish(s) {
    const optType = s.side === 'call' ? 'call options' : 'put options';
    const kindNote = s.kind === 'sweep' ? 'Volume ran far above open interest — new activity (not a confirmed sweep).'
      : s.kind === 'block' ? 'A large estimated dollar size (not a confirmed institutional block).'
        : 'A large estimated premium.';
    // Honest directional state — never "calls = bullish".
    const ds = s.directionState;
    const dirLine = ds === 'PROVISIONAL_BULLISH' ? ' The last print hit the <b>ask</b> on a reliable quote, so this leans <b>provisionally bullish</b> — buyers paying up. It could still be a hedge or spread.'
      : ds === 'PROVISIONAL_BEARISH' ? ' The last print hit the <b>ask</b> on a reliable quote, so this leans <b>provisionally bearish</b>. It could still be a hedge or spread.'
      : s.suspectedMultiLeg ? ' This looks like part of a <b>spread / multi-leg</b> order, so the direction is <b>ambiguous</b>.'
      : ' We <b>can\'t tell the direction</b> from this — it may be buying, selling, closing, hedging, or a spread.';
    const fresh = s.newOnZeroOi ? ' There was no prior open interest, so today\'s volume is entirely new.'
      : (s.volOi ? ` Volume was ${s.volOi}× the prior open interest.` : '');
    // What a simple long option would need (context only — most activity isn't a naked long).
    const be = (s.breakeven != null && s.moveToBePct != null)
      ? ` For a simple long ${s.side} to pay, ${esc(s.ticker)} would need to move <b>~${s.moveToBePct > 0 ? '+' : ''}${s.moveToBePct}%</b> to <b>$${esc(String(s.breakeven))}</b> (breakeven) by ${esc(s.expiry || 'expiry')}.`
      : '';
    return `~${ofUsd(s.premium)} (estimated) of ${esc(s.ticker)} ${optType} at the $${esc(String(s.strike))} strike traded unusually heavily, expiring ${esc(s.expiry || 'expiry')} (${s.dte} days out). ${kindNote}${dirLine}${fresh}${be}`;
  }
  // The actionable warning + plain "what you could do", honest about risk. Shared
  // by contract and ticker cards. earnings-before-expiry is the big one.
  function flowEarningsWarn(s) {
    if (!s.earningsBeforeExpiry || s.earningsInDays == null) return '';
    return `<div class="of-warn">⚠ <b>Earnings in ${s.earningsInDays}d</b> — before this option expires. That makes it an <b>event bet</b>: the option can lose value even if the stock moves your way, because volatility gets crushed after the report. Beginners: be very careful here.</div>`;
  }
  function flowAction(s) {
    // Accepts a signal (honest directionState) OR a legacy sentiment string.
    const ds = typeof s === 'object' && s ? s.directionState : (s === 'bearish' ? 'PROVISIONAL_BEARISH' : 'PROVISIONAL_BULLISH');
    if (ds === 'DIRECTION_UNKNOWN' || ds === 'MIXED' || (typeof s === 'object' && s && s.suspectedMultiLeg)) {
      return `<div class="of-action">💡 <b>What you could do:</b> the direction here is <b>${ds === 'MIXED' ? 'mixed' : 'unknown'}</b>, so this activity isn't a reason to act on its own. Use it only to sanity-check a view you already hold from price/news, and confirm with the Track Record below.</div>`;
    }
    const view = ds === 'PROVISIONAL_BEARISH' ? 'provisional bearish' : 'provisional bullish';
    const simpler = ds === 'PROVISIONAL_BEARISH'
      ? 'if your own price read agrees, the lower-risk responses are to avoid/trim or wait'
      : 'if your own price read agrees, the lower-risk expression is owning the shares — long options decay if the move is late';
    return `<div class="of-action">💡 <b>What you could do:</b> this is a <b>${view}</b> lean on delayed data, not a signal to buy the same option — ${simpler}. Confirm with the Track Record below and your own chart.</div>`;
  }
  function optionsFlowCard(s) {
    const bull = s.sentiment === 'bullish', col = bull ? 'var(--green)' : 'var(--red)';
    // Header (always): ticker · bull/bear · kind · premium.
    // Pro meta: add breakeven + the implied move required (concrete, no fluff).
    const beMeta = (s.breakeven != null) ? ` · BE $${esc(String(s.breakeven))}${s.moveToBePct != null ? ` (${s.moveToBePct > 0 ? '+' : ''}${s.moveToBePct}%)` : ''}` : '';
    const lastMeta = s.lastTradeTs ? ` · last ${ofTime(s.lastTradeTs)}` : '';
    const chgMeta = s.undChgPct != null ? ` · spot ${ofChg(s.undChgPct)}` : '';
    const techMeta = ofNovice ? '' : `<div class="cx-company">${esc(s.type)} $${esc(String(s.strike))} · ${esc(s.expiry || '?')} (${s.dte}d) · ${esc(s.moneyness)}${s.iv ? ` · IV ${s.iv}%` : ''}${beMeta}${chgMeta}${lastMeta}${s.earningsBeforeExpiry ? ` · <span style="color:var(--amber,#f0a832)">⚠ ER ${s.earningsInDays}d</span>` : ''}</div>`;
    const techVol = ofNovice ? '' : `<div class="cx-price">vol ${(s.volume || 0).toLocaleString()} · OI ${(s.openInterest || 0).toLocaleString()}${s.volOi ? ` · ${s.volOi}× OI` : ''}</div>`;
    // Body: novice → plain-English read + earnings warning + what-you-could-do;
    // pro → just the earnings warning (technical lines live in the header).
    const body = ofNovice
      ? `<div class="cx-narrative" style="margin-top:8px">💡 ${flowPlainEnglish(s)}</div>${flowEarningsWarn(s)}${flowAction(s)}`
      : flowEarningsWarn(s);
    return `<div class="cx-card" style="border-left:3px solid ${col}">`
      + `<div class="cx-top"><div>`
      + `<div class="cx-tk-row"><span class="cx-ticker" data-live="${esc(s.ticker)}">$${esc(s.ticker)}</span>`
      + `<span class="cx-tierbadge" style="color:${col};border-color:currentColor">${bull ? '▲ Bullish' : '▼ Bearish'}</span>`
      + `<span class="cx-tierbadge" style="color:var(--text-dim);border-color:#444">${OF_KIND[s.kind] || esc(s.kind)}</span>${ofAggrChip(s)}</div>`
      + techMeta
      + `</div><div class="cx-score-col"><div class="cx-score" style="color:#06c4d4;font-size:1.05rem">${ofUsd(s.premium)}</div>`
      + techVol + `</div></div>${body}${ofConfluenceHTML(s.ticker)}</div>`;
  }

  // 🧠 Desk-read A/B: does the Fable bias beat the raw call/put lean on the SAME
  // resolved calls? Stays "building" until enough AI-tagged entries mature (~a week
  // of logging), then shows the head-to-head hit rates + a promote/tracking verdict.
  function ofFableEdgeHTML(fableEdge) {
    const fe = fableEdge && (fableEdge['1w'] || fableEdge['1m']);
    if (!fe) return '';
    const head = `<div class="rot-head" style="margin-top:16px;color:#a78bfa">🧠 Desk read vs. raw lean <span class="dt-dim" style="font-weight:400;font-size:0.74rem">— does the AI bias beat call/put alone?</span></div>`;
    if (fe.fableHitRatePct == null) {
      return head + `<div class="dt-note" style="margin-top:6px">Building — ${esc(fe.verdict || '')}. Each day's 🧠 desk calls are scored against the underlying's forward move and compared head-to-head with the mechanical lean. By design it won't claim the AI helps until the sample is real.</div>`;
    }
    const win = fe.promoted;
    const col = win ? 'var(--green)' : 'var(--text-dim)';
    const ov = fe.overrideHitRatePct != null
      ? `<div class="bt-ic-row" style="opacity:.85"><span>When AI overrode the lean</span><span>${fe.overrideHitRatePct}% right · n=${fe.overrides}</span></div>` : '';
    return head
      + `<div class="rot-panel" style="margin-top:6px;border-left:3px solid ${col}">`
      + `<div class="bt-ic-row"><span>🧠 Fable desk bias</span><span>${fe.fableHitRatePct}% right (90% floor ${fe.fableHitRateLB90}%) · n=${fe.n}</span></div>`
      + `<div class="bt-ic-row"><span>⚙️ Raw call/put lean</span><span>${fe.mechHitRatePct}% right · same n</span></div>`
      + ov
      + `<div class="rot-sub" style="margin-top:8px;color:${col}">${win ? '✅ ' : '⏳ '}${esc(fe.verdict || '')}</div></div>`;
  }

  async function loadOptionsPerf() {
    const el = document.getElementById('of-perf'); if (!el) return;
    try {
      const p = await fetch('/api/tracker?op=optionsperf').then(r => r.json());
      if (!p || !p.ok) return;
      if (!p.logged) { el.innerHTML = `<div class="rot-head">📊 Options Signal Track Record</div><div class="dt-note">Gathering data — flow signals are logged daily; their forward 1-week / 1-month returns on the underlying fill in over the coming weeks. By design it won't claim an edge on a thin sample.</div>`; return; }
      const row = (lbl, h) => (h && h.n) ? `<div class="bt-ic-row"><span>${lbl}</span><span>${h.winRate}% win · ${h.avgReturnPct > 0 ? '+' : ''}${h.avgReturnPct}% avg · n=${h.n}</span></div>` : '';
      // Realized big-mover context: how often the underlying actually ran +10% / +20%
      // in the flow's favored direction within the horizon — measured from the ledger.
      const bwRow = (h) => (h && h.n && h.big10Rate != null) ? `<div class="bt-ic-row" style="opacity:.85"><span>🚀 Large-move context</span><span>&gt;10%: ${h.big10Rate}% · &gt;20%: ${h.big20Rate}% · avg peak +${h.avgMfePct}%</span></div>` : '';
      const block = (hk) => `<div class="rot-sub" style="margin-top:8px"><b>${hk === '1w' ? '1-week' : '1-month'} forward (underlying)</b></div>`
        + row('All signals', p.horizons[hk]) + bwRow(p.horizons[hk]) + row('Bullish', (p.bySentiment[hk] || {}).bullish) + row('Bearish', (p.bySentiment[hk] || {}).bearish);
      el.innerHTML = `<div class="rot-head">📊 Options Signal Track Record <span class="dt-dim">· ${p.logged} logged · ${p.resolved} resolved</span></div>`
        + `<div class="rot-panel" style="margin-top:6px">${block('1w')}${block('1m')}</div>`
        + ofFableEdgeHTML(p.fableEdge)
        + `<div class="dt-dim" style="font-size:0.74rem;margin-top:6px">${esc(p.note || '')}</div>`;
    } catch { /* leave the panel as-is on error */ }
  }

  function showOptionsError(msg) {
    optionsContainer.innerHTML = `<div class="opt-status error"><p>${esc(msg)}</p></div>`;
  }

  // Shimmer skeleton placeholder grid for loading states
  function skeletonGrid(n) {
    let c = '';
    for (let i = 0; i < n; i++) c += '<div class="skel"><div class="skel-line" style="width:42%"></div><div class="skel-line" style="width:78%"></div><div class="skel-line" style="width:60%"></div><div class="skel-line" style="width:88%"></div></div>';
    return `<div class="skel-grid">${c}</div>`;
  }

  // ── Breakout Screener (S&P 500 large-cap + small/micro-cap) ──
  const screenerContainer      = document.getElementById('screener-container');
  const screenerSmallContainer = document.getElementById('screener-small-container');
  const screenerMicroContainer = document.getElementById('screener-micro-container');
  const screenerExpandedContainer = document.getElementById('screener-expanded-container');
  const screenerRefreshBtn     = document.getElementById('screener-refresh-btn');
  const screenerGenTime        = document.getElementById('screener-gen-time');
  const screenerMeta           = document.getElementById('screener-meta');
  const screenerSmallMeta      = document.getElementById('screener-small-meta');
  const screenerMicroMeta      = document.getElementById('screener-micro-meta');
  const screenerExpandedMeta   = document.getElementById('screener-expanded-meta');

  const SCR_CRITERIA = [
    ['accumulation', 'Accum'],
    ['vcp',          'VCP'],
    ['resistance',   'Resist'],
    ['volume',       'Volume'],
    ['narrative',    'Story'],
    ['early',        'Early'],
  ];
  // Plain-English hover for each criterion chip (novice investor).
  const SCR_CRITERIA_HELP = {
    accumulation: 'Accumulation — signs that big buyers are steadily building a position (more up-volume than down-volume).',
    vcp: 'Volatility Contraction Pattern — the price swings are getting tighter, like a coiled spring before a move.',
    resistance: 'Resistance — the stock is pushing up against a price ceiling it has struggled to break before.',
    volume: 'Volume — trading activity is elevated, meaning more people are participating in the move.',
    narrative: 'Story — there’s a real-world catalyst or theme (earnings, product, sector) driving interest.',
    early: 'Early — this is an early-stage setup, before a confirmed breakout (more upside, but less certain).',
  };

  // The four hard-gate filters every surfaced candidate must pass. Shown on each
  // card so it's explicit which requirements the name cleared.
  const SCR_FILTERS = [
    ['consolidation', '4wk+ coil, range ↓'],
    ['volume',        'Vol ≥ 1.5× 50-day'],
    ['rsVsSpy',       'RS > SPY (3mo)'],
    ['aboveSmas',     'Above 50 & 200 SMA'],
  ];

  // ── Tunable per-tier quant weights with named presets ──
  // Accumulation (accum) + up/down volume (ud) carry real forward-return edge in
  // this project's research; base-quality (base) + volume-surge (vol) are DEAD, so
  // the default zeroes them and routes their weight to accum/ud. base/vol stay in
  // the panel so users can opt back into the classic breakout view (Base-heavy
  // preset). Keep SCR_DEFAULT_W in sync with DEFAULT_WEIGHTS in api/screener.js.
  const SCR_FACTORS = [
    ['rs',     'Relative Strength'],
    ['mom',    'Momentum'],
    ['trend',  'Trend Template'],
    ['volAdj', 'Vol-Adj Mom'],
    ['accum',  'Accumulation'],
    ['ud',     'Up/Down Vol'],
    ['prox',   'Proximity'],
    ['base',   'Base Quality'],
    ['vol',    'Volume Surge'],
  ];
  const SCR_DEFAULT_W = { rs: 22, mom: 20, trend: 16, volAdj: 14, accum: 12, ud: 10, prox: 6, base: 0, vol: 0 };
  const BUILTIN_PRESETS = {
    'Balanced':        { rs: 22, mom: 20, trend: 16, volAdj: 14, accum: 12, ud: 10, prox: 6, base: 0,  vol: 0 },
    'Momentum':        { rs: 26, mom: 28, trend: 12, volAdj: 12, accum: 8,  ud: 6,  prox: 8, base: 0,  vol: 0 },
    'Base-heavy':      { rs: 12, mom: 10, trend: 14, volAdj: 12, accum: 8,  ud: 6,  prox: 6, base: 24, vol: 8 },
    'Trend-following': { rs: 18, mom: 14, trend: 28, volAdj: 16, accum: 8,  ud: 4,  prox: 8, base: 4,  vol: 0 },
  };
  const TIERS = ['large', 'small', 'micro'];
  const TIER_LABEL = { large: 'Large', small: 'Small', micro: 'Micro' };

  function normTiers(s) { const o = {}; TIERS.forEach(t => o[t] = { ...SCR_DEFAULT_W, ...(s[t] || {}) }); return o; }
  function loadTierWeights() {
    try { const s = JSON.parse(localStorage.getItem('scrWeightsByTier')); if (s && s.large) return normTiers(s); } catch {}
    try { const old = JSON.parse(localStorage.getItem('scrWeights')); if (old && typeof old === 'object') { const w = { ...SCR_DEFAULT_W, ...old }; return { large: { ...w }, small: { ...w }, micro: { ...w } }; } } catch {}
    return { large: { ...SCR_DEFAULT_W }, small: { ...SCR_DEFAULT_W }, micro: { ...SCR_DEFAULT_W } };
  }
  function loadPresets() { try { const s = JSON.parse(localStorage.getItem('scrPresets')); if (s && typeof s === 'object') return s; } catch {} return {}; }

  let SCR_W = loadTierWeights();
  let SCR_PRESETS = loadPresets();
  let scrEditTier = 'large';

  const scrRaw   = { large: null, small: null, micro: null, expanded: null }; // buffered results from API
  const scrCaps  = { large: 20, small: 10, micro: 10, expanded: 10 };
  const scrConts = { large: screenerContainer, small: screenerSmallContainer, micro: screenerMicroContainer, expanded: screenerExpandedContainer };

  const scrComposite = (pct, w) => {
    const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    let s = 0; for (const k in w) s += (w[k] / sum) * ((pct && pct[k]) || 0);
    return Math.round(s);
  };
  const scrPctOf = (w, k) => { const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1; return Math.round(w[k] / sum * 100); };
  const saveW = () => { try { localStorage.setItem('scrWeightsByTier', JSON.stringify(SCR_W)); } catch {} };
  const savePresets = () => { try { localStorage.setItem('scrPresets', JSON.stringify(SCR_PRESETS)); } catch {} };

  // Identify which preset (if any) the weights match, else describe the mix.
  function weightsLabel(w) {
    const matches = p => p && SCR_FACTORS.every(([k]) => (p[k] ?? 0) === (w[k] ?? 0));
    for (const n of Object.keys(BUILTIN_PRESETS)) if (matches(BUILTIN_PRESETS[n])) return n;
    for (const n of Object.keys(SCR_PRESETS)) if (matches(SCR_PRESETS[n])) return n + ' (saved)';
    const top = SCR_FACTORS.map(([k, l]) => [l, scrPctOf(w, k)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, p]) => `${l} ${p}%`).join(' · ');
    return 'Custom — ' + top;
  }

  function rankAndRender(scope) {
    const raw = scrRaw[scope];
    if (raw == null) return; // still loading — leave spinner
    // Lazy-load earnings-call tone + attention once; re-render this scope when they
    // arrive so the 🎙 / 📈 / ⚡ chips appear without blocking the initial paint.
    ensureToneMap(() => rankAndRender(scope));
    ensureAttnMap(() => rankAndRender(scope));
    const cap = scrCaps[scope] || 10;
    const w = SCR_W[scope] || SCR_DEFAULT_W;
    const bear = !!(lastRegime && lastRegime.bearish);
    // Choppy tape (low trend efficiency) — breakouts fail there too (false
    // breakouts spike), so downgrade them, lighter than the bearish penalty.
    const choppy = !bear && lastRegime && lastRegime.condition === 'choppy';
    // Downgrade Breakout-tier scores in unfavorable tapes — confirmed breakouts
    // fail at much higher rates in downtrends AND in chop. (Setup/Early are
    // pre-breakout and left untouched.)
    let arr = raw.map(c => {
      let _score = scrComposite(c.pct, w), _downgraded = null;
      if (c.status === 'Breakout') {
        if (bear) { _score = Math.round(_score * REGIME_PENALTY); _downgraded = 'bear'; }
        else if (choppy) { _score = Math.round(_score * CHOP_PENALTY); _downgraded = 'chop'; }
      }
      return { ...c, _score, _downgraded };
    });
    arr = arr.filter(c => !isSignalDisabled('screener', c.status)); // hide tiers disabled on the scoreboard
    if (scrHC) arr = arr.filter(isHighConviction);
    if (scrEmerg) arr = arr.filter(c => c.emergingLeader);
    if (scrHideHighSI) arr = arr.filter(c => !(c.shortInterest && c.shortInterest.level === 'high'));
    if (scrMomMin > 0) arr = arr.filter(c => c.factors && c.factors.mom63 != null && c.factors.mom63 >= scrMomMin);
    const md = getModel(scope);
    // Rank purely by strength — NOT breakouts-first (breakout PF < 1 in this
    // project's research). A confirmed breakout is a badge, not a sort key.
    if (scrModelRank && md) {
      arr = arr.map(c => ({ ...c, _prob: modelProb(c) ?? -1 }));
      arr.sort((a, b) => b._prob - a._prob);
    } else {
      arr.sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;
        return (b.narrativeStrength || 0) - (a.narrativeStrength || 0);
      });
    }
    // 2:1 reward-to-risk gate with graceful fallback (never blank the section).
    const gated = rrGate(arr);
    const ranked = gated.items.slice(0, cap).map((c, i) => ({ ...c, rank: i + 1 }));
    renderScreenerList(ranked, scrConts[scope], scope, gated.fallback);
    const rb = document.getElementById('rankby-' + scope);
    if (rb) rb.innerHTML = `Ranked by: <b>${esc(weightsLabel(w))}</b>`;
  }

  function buildTunePanel() {
    const tierWrap = document.getElementById('scr-tune-tiers');
    if (tierWrap) tierWrap.innerHTML = TIERS.map(t => `<button class="scr-seg ${t === scrEditTier ? 'active' : ''}" data-tier="${t}">${TIER_LABEL[t]}</button>`).join('');

    const presetWrap = document.getElementById('scr-tune-presets');
    if (presetWrap) {
      const builtin = Object.keys(BUILTIN_PRESETS).map(n => `<button class="scr-preset" data-preset="${esc(n)}">${esc(n)}</button>`).join('');
      const custom  = Object.keys(SCR_PRESETS).map(n => `<button class="scr-preset" data-preset="${esc(n)}">${esc(n)}<span class="pdel" data-del="${esc(n)}">✕</span></button>`).join('');
      presetWrap.innerHTML = builtin + custom + `<button class="scr-preset save" id="scr-preset-save">＋ Save</button>`;
    }

    const w = SCR_W[scrEditTier];
    const wrap = document.getElementById('scr-tune-sliders');
    if (wrap) wrap.innerHTML = SCR_FACTORS.map(([k, label]) => `
      <div class="scr-w-row">
        <label>${label}</label>
        <input type="range" min="0" max="35" step="1" value="${w[k]}" data-w="${k}" />
        <span class="scr-w-val" data-wv="${k}">${scrPctOf(w, k)}%</span>
      </div>`).join('');

    wireTuneControls();
  }

  function refreshWvals() {
    const w = SCR_W[scrEditTier];
    document.querySelectorAll('[data-wv]').forEach(el => { el.textContent = scrPctOf(w, el.dataset.wv) + '%'; });
  }

  function wireTuneControls() {
    document.querySelectorAll('#scr-tune-tiers .scr-seg').forEach(b => b.onclick = () => { scrEditTier = b.dataset.tier; buildTunePanel(); });
    document.querySelectorAll('#scr-tune-sliders input[type=range]').forEach(inp => inp.oninput = () => {
      SCR_W[scrEditTier][inp.dataset.w] = +inp.value; saveW(); refreshWvals(); rankAndRender(scrEditTier);
    });
    document.querySelectorAll('#scr-tune-presets .scr-preset[data-preset]').forEach(b => b.onclick = (e) => {
      if (e.target.classList.contains('pdel')) return;
      const name = b.dataset.preset;
      const p = BUILTIN_PRESETS[name] || SCR_PRESETS[name];
      if (!p) return;
      SCR_W[scrEditTier] = { ...SCR_DEFAULT_W, ...p }; saveW(); buildTunePanel(); rankAndRender(scrEditTier);
    });
    document.querySelectorAll('#scr-tune-presets .pdel').forEach(x => x.onclick = (e) => {
      e.stopPropagation(); delete SCR_PRESETS[x.dataset.del]; savePresets(); buildTunePanel();
    });
    const save = document.getElementById('scr-preset-save');
    if (save) save.onclick = () => {
      const n = (prompt('Save current tier weights as preset named:') || '').trim();
      if (!n) return;
      SCR_PRESETS[n] = { ...SCR_W[scrEditTier] }; savePresets(); buildTunePanel();
    };
  }

  (function wireTune() {
    const t = document.getElementById('scr-tune-toggle');
    const b = document.getElementById('scr-tune-body');
    if (t) t.addEventListener('click', () => { const open = b.style.display !== 'none'; b.style.display = open ? 'none' : 'block'; t.classList.toggle('open', !open); });
    const reset = document.getElementById('scr-tune-reset');
    if (reset) reset.addEventListener('click', () => { SCR_W[scrEditTier] = { ...SCR_DEFAULT_W }; saveW(); buildTunePanel(); rankAndRender(scrEditTier); });
    const all = document.getElementById('scr-tune-all');
    if (all) all.addEventListener('click', () => { const w = { ...SCR_W[scrEditTier] }; TIERS.forEach(t2 => SCR_W[t2] = { ...w }); saveW(); TIERS.forEach(rankAndRender); });

    const exp = document.getElementById('scr-tune-export');
    if (exp) exp.addEventListener('click', async () => {
      const code = btoa(JSON.stringify({ v: 1, w: SCR_W, p: SCR_PRESETS }));
      try { await navigator.clipboard.writeText(code); } catch {}
      window.prompt('Your screener config code (copied to clipboard). Paste it on another device via Import:', code);
    });
    const imp = document.getElementById('scr-tune-import');
    if (imp) imp.addEventListener('click', () => {
      const code = (window.prompt('Paste a screener config code to import:') || '').trim();
      if (!code) return;
      try {
        const d = JSON.parse(atob(code));
        if (!d || d.v !== 1 || !d.w) throw new Error('bad');
        SCR_W = normTiers(d.w);
        SCR_PRESETS = (d.p && typeof d.p === 'object') ? d.p : SCR_PRESETS;
        saveW(); savePresets(); buildTunePanel(); TIERS.forEach(rankAndRender);
      } catch { alert('That code could not be read. Make sure you pasted the full Export code.'); }
    });

    buildTunePanel();
  })();

  // Sector/exchange filters (persisted)
  const SCR_SECTORS = ['Technology', 'Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Health Care', 'Financials', 'Industrials', 'Energy', 'Utilities', 'Real Estate', 'Materials', 'Other'];
  const loadFilters = () => { try { const f = JSON.parse(localStorage.getItem('scrFilters')); if (f) return f; } catch {} return { sector: 'all', exchange: 'all', gate: 'relaxed', mom: '0' }; };
  const saveFilters = () => { try { localStorage.setItem('scrFilters', JSON.stringify({ sector: document.getElementById('scr-filter-sector')?.value || 'all', exchange: document.getElementById('scr-filter-exchange')?.value || 'all', gate: document.getElementById('scr-gate')?.value || 'relaxed', mom: document.getElementById('scr-mom')?.value || '0' })); } catch {} };
  // Minimum trailing 3-month (mom63) return % to show — client-side filter on the
  // validated big-mover momentum signal (Big-Mover Reveal: top-quartile lift 1.41).
  let scrMomMin = +(loadFilters().mom) || 0;
  (function initFilters() {
    const sel = document.getElementById('scr-filter-sector');
    if (sel) SCR_SECTORS.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    const saved = loadFilters();
    if (sel && saved.sector) sel.value = saved.sector;
    const ex = document.getElementById('scr-filter-exchange');
    if (ex && saved.exchange) ex.value = saved.exchange;
    const gt = document.getElementById('scr-gate');
    if (gt && saved.gate) gt.value = saved.gate;
    const mm = document.getElementById('scr-mom');
    if (mm && saved.mom) mm.value = saved.mom;
    // Sector/exchange/gate re-fetch (server-side query); momentum is client-side → just re-render.
    ['scr-filter-sector', 'scr-filter-exchange', 'scr-gate'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { saveFilters(); refreshScreeners(); });
    });
    if (mm) mm.addEventListener('change', () => { scrMomMin = +mm.value || 0; saveFilters(); ['large', 'small', 'micro'].forEach(rankAndRender); });
  })();
  // ── High-Conviction filter: auto-derived from the live backtest's top edges ──
  let scrHC = false; try { scrHC = localStorage.getItem('scrHC') === '1'; } catch {}
  // Emerging-Leader filter: show only early momentum-emergence movers (server flag).
  let scrEmerg = false; try { scrEmerg = localStorage.getItem('scrEmerg') === '1'; } catch {}
  const HC_PREDICATES = {
    breakout: c => c.status === 'Breakout',
    trend:    c => !!c.aboveSma200,
    vcp:      c => !!(c.criteria && c.criteria.vcp),
    multi:    c => ((c.metrics && c.metrics.vcpContractions) || 0) >= 3,
    pocket:   c => !!(c.metrics && c.metrics.pocketPivot),
    obv:      c => !!(c.metrics && c.metrics.obvRising),
    vdu:      c => !!(c.metrics && c.metrics.vdu != null && c.metrics.vdu <= 70),
    ud:       c => !!(c.metrics && c.metrics.udVol != null && c.metrics.udVol >= 1.3),
    rs:       c => !!(c.metrics && c.metrics.rsNewHigh),
    longbase: c => !!(c.metrics && c.metrics.longBase),
  };
  const HC_LABEL = { breakout: 'Breakout', trend: 'Above 200-MA', vcp: 'VCP', multi: '2+ contractions', pocket: 'Pocket pivot', obv: 'OBV rising', vdu: 'Volume dry-up', ud: 'U/D ≥1.3', rs: 'RS new high', longbase: '7+wk base' };
  const HC_SHORT = { breakout: 'Brk', trend: '>200MA', vcp: 'VCP', multi: '2+VCP', pocket: 'PP', obv: 'OBV', vdu: 'VDU', ud: 'U/D', rs: 'RS-NH', longbase: 'LongBase' };
  const HC_DEFAULT = ['breakout', 'trend', 'vcp'];
  const HC_SCOPES = ['large', 'small', 'micro'];
  let hcWindow = '6'; try { const v = localStorage.getItem('hcWindow'); if (['3', '6', '12'].includes(v)) hcWindow = v; } catch {}

  let hcRefreshing = false;
  const loadHCMap = () => { try { const m = JSON.parse(localStorage.getItem('hcEdgesByScope')); if (m && typeof m === 'object') return m; } catch {} return {}; };
  const loadHCMeta = () => { try { const m = JSON.parse(localStorage.getItem('hcEdgesMeta')); if (m && typeof m === 'object') return m; } catch {} return {}; };
  function getHCEdges(scope) { const e = loadHCMap()[scope]; if (Array.isArray(e) && e.length) { const v = e.filter(k => HC_PREDICATES[k]); if (v.length) return v; } return HC_DEFAULT; }
  function scopeOf(c) { const t = (c.capTier || 'Large').toLowerCase(); return HC_SCOPES.includes(t) ? t : 'large'; }
  function isHighConviction(c) { return getHCEdges(scopeOf(c)).every(k => HC_PREDICATES[k](c)); }

  // ── Regime-aware auto-throttle (suppress weak signals in Risk-Off) ──
  let scrRegime = null;
  let autoThrottle = true; try { autoThrottle = localStorage.getItem('scrThrottle') !== '0'; } catch {}
  const isThrottled = () => autoThrottle && scrRegime && scrRegime.riskOn === false;

  // ── Learned factor model (per scope) ──
  let scrModelRank = false; try { scrModelRank = localStorage.getItem('scrModelRank') === '1'; } catch {}
  let scrHideHighSI = false; try { scrHideHighSI = localStorage.getItem('scrHideHighSI') === '1'; } catch {}
  const MODEL_RELIABLE = 0.53; // OOS AUC threshold to trust the model
  const loadModelMap = () => { try { const m = JSON.parse(localStorage.getItem('hcModelByScope')); if (m && typeof m === 'object') return m; } catch {} return {}; };
  function getModel(scope) { return loadModelMap()[scope] || null; }
  function storeModel(model, scope) {
    if (!model || !HC_SCOPES.includes(scope)) return;
    const m = loadModelMap(); m[scope] = model;
    try { localStorage.setItem('hcModelByScope', JSON.stringify(m)); } catch {}
    rankAndRender(scope);
  }
  // Feature order must match the server's MODEL_KEYS
  function cardFeatVec(c) {
    const m = c.metrics || {}, cr = c.criteria || {};
    return [c.status === 'Breakout' ? 1 : 0, m.rsNewHigh ? 1 : 0, c.aboveSma200 ? 1 : 0, m.obvRising ? 1 : 0, cr.vcp ? 1 : 0, m.pocketPivot ? 1 : 0, (m.vdu != null && m.vdu <= 70) ? 1 : 0, (m.udVol != null && m.udVol >= 1.3) ? 1 : 0, m.longBase ? 1 : 0];
  }
  function modelProb(c) {
    const md = getModel(scopeOf(c));
    if (!md || !md.weights) return null;
    let z = md.bias; const x = cardFeatVec(c);
    for (let j = 0; j < x.length; j++) z += md.weights[j] * x[j];
    return Math.round(1 / (1 + Math.exp(-z)) * 100);
  }

  function hcAgeText() {
    const meta = loadHCMeta(); const ats = HC_SCOPES.map(s => meta[s] && meta[s].at).filter(Boolean);
    if (!ats.length) return 'using defaults';
    const m = Math.floor((Date.now() - Math.max(...ats)) / 60000);
    if (m < 1) return 'updated just now';
    if (m < 60) return 'updated ' + m + 'm ago';
    const h = Math.floor(m / 60);
    return h < 24 ? 'updated ' + h + 'h ago' : 'updated ' + Math.floor(h / 24) + 'd ago';
  }
  function updateHCLabel() {
    const lab = { large: 'L', small: 'S', micro: 'M' };
    const parts = HC_SCOPES.map(s => `${lab[s]}: <b>${esc(getHCEdges(s).map(k => HC_SHORT[k] || k).join('·'))}</b>`);
    const el = document.getElementById('scr-hc-deftext');
    if (el) el.innerHTML = `🎯 ${hcWindow}-mo edges — ${parts.join('&nbsp; · &nbsp;')} · ${hcRefreshing ? '⏳ refreshing…' : hcAgeText()}`;
    const b = document.getElementById('scr-hc-toggle');
    if (b) b.title = 'Filter each list to its own highest-edge combo from the backtest';
  }
  function storeHCEdges(efficacy, months, scope) {
    if (!efficacy || !efficacy.features || !HC_SCOPES.includes(scope)) return;
    // Only edges that held their alpha out-of-sample (walk-forward robust).
    const robust = efficacy.features.filter(f => f.robust).sort((a, b) => b.oosLift - a.oosLift);
    let keys = robust.slice(0, 3).map(f => f.key).filter(k => HC_PREDICATES[k]);
    if (!keys.length) keys = ['breakout']; // safe fallback when nothing survives OOS
    const map = loadHCMap(); map[scope] = keys;
    const meta = loadHCMeta(); meta[scope] = { at: Date.now(), win: months || hcWindow };
    try { localStorage.setItem('hcEdgesByScope', JSON.stringify(map)); localStorage.setItem('hcEdgesMeta', JSON.stringify(meta)); } catch {}
    updateHCLabel();
    rankAndRender(scope);
  }
  async function refreshHCEdges() {
    if (hcRefreshing) return;
    hcRefreshing = true; updateHCLabel();
    // Run all three scope backtests concurrently; each list updates as it lands.
    await Promise.all(HC_SCOPES.map(async sc => {
      try { const r = await fetch('/api/backtest?scope=' + sc + '&months=' + hcWindow); const d = await r.json(); if (d && d.efficacy) storeHCEdges(d.efficacy, d.months, d.scope || sc); if (d && d.model) storeModel(d.model, d.scope || sc); } catch {}
    }));
    hcRefreshing = false; updateHCLabel();
  }
  (function initHC() {
    const b = document.getElementById('scr-hc-toggle');
    if (b) {
      b.classList.toggle('active', scrHC);
      b.addEventListener('click', () => {
        scrHC = !scrHC;
        try { localStorage.setItem('scrHC', scrHC ? '1' : '0'); } catch {}
        b.classList.toggle('active', scrHC);
        HC_SCOPES.forEach(rankAndRender);
      });
    }
    const eb = document.getElementById('scr-emerg-toggle');
    if (eb) {
      eb.classList.toggle('active', scrEmerg);
      eb.addEventListener('click', () => {
        scrEmerg = !scrEmerg;
        try { localStorage.setItem('scrEmerg', scrEmerg ? '1' : '0'); } catch {}
        eb.classList.toggle('active', scrEmerg);
        HC_SCOPES.forEach(rankAndRender);
      });
    }
    const mb = document.getElementById('scr-model-toggle');
    if (mb) {
      mb.classList.toggle('active', scrModelRank);
      mb.addEventListener('click', () => {
        scrModelRank = !scrModelRank;
        try { localStorage.setItem('scrModelRank', scrModelRank ? '1' : '0'); } catch {}
        mb.classList.toggle('active', scrModelRank);
        HC_SCOPES.forEach(rankAndRender);
      });
    }
    const sib = document.getElementById('scr-hidesi-toggle');
    if (sib) {
      sib.classList.toggle('active', scrHideHighSI);
      sib.addEventListener('click', () => {
        scrHideHighSI = !scrHideHighSI;
        try { localStorage.setItem('scrHideHighSI', scrHideHighSI ? '1' : '0'); } catch {}
        sib.classList.toggle('active', scrHideHighSI);
        HC_SCOPES.forEach(rankAndRender);
      });
    }
    const sel = document.getElementById('scr-hc-window');
    if (sel) {
      sel.value = hcWindow;
      sel.addEventListener('change', () => { hcWindow = sel.value; try { localStorage.setItem('hcWindow', hcWindow); } catch {} refreshHCEdges(); });
    }
    updateHCLabel();
    // Auto-refresh per-scope edges when stale (>6h) — deferred so the lists render
    // first, then the 3 backtests run concurrently in the background.
    const meta = loadHCMeta(); const ats = HC_SCOPES.map(s => meta[s] && meta[s].at).filter(Boolean);
    if (Date.now() - (ats.length ? Math.max(...ats) : 0) > 6 * 3600 * 1000) setTimeout(refreshHCEdges, 2500);
  })();

  // Rotation lookback window (persisted)
  let scrLookback = (() => { try { const v = localStorage.getItem('scrLookback'); if (['1M', '3M', '6M'].includes(v)) return v; } catch {} return '1M'; })();
  (function initLookback() {
    const sel = document.getElementById('rot-lookback');
    if (!sel) return;
    sel.value = scrLookback;
    sel.addEventListener('change', () => {
      scrLookback = sel.value;
      try { localStorage.setItem('scrLookback', scrLookback); } catch {}
      fetchScreenerScope('large', screenerContainer, screenerMeta, true);
    });
  })();

  // ── Strategy backtest (lazy-loaded when the sub-tab is opened) ──
  let btLoaded = false, btMonths = '6', btView = 'trades';
  function ensureBacktest() {
    if (btLoaded) return;
    btLoaded = true;
    const sel = document.getElementById('bt-months');
    if (sel) { sel.value = btMonths; sel.addEventListener('change', () => { btMonths = sel.value; runBacktest(); }); }
    const VIEW_BTN = { trades: 'bt-view-trades', walkforward: 'bt-view-wf', movers: 'bt-view-movers' };
    Object.entries(VIEW_BTN).forEach(([v, id]) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => {
        if (btView === v) return;
        btView = v;
        Object.entries(VIEW_BTN).forEach(([vv, ii]) => document.getElementById(ii)?.classList.toggle('active', vv === v));
        runBacktest();
      });
    });
    runBacktest();
  }
  async function runBacktest() {
    if (btView === 'walkforward') return runWalkForward();
    if (btView === 'movers') return runMoverStudy();
    const el = document.getElementById('backtest-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Replaying the screen across history… (a few seconds)</p></div>`;
    try {
      const res = await fetch('/api/backtest?scope=large&months=' + btMonths);
      const d = await res.json();
      if (d.error) { el.innerHTML = `<div class="mom-status error"><p>${esc(d.error)}</p></div>`; return; }
      renderBacktest(d);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Backtest failed. Please try again.</p></div>`; }
  }

  // ── Purged walk-forward harness — validates GAI's price-pillar core (rank-IC) ──
  async function runWalkForward() {
    const el = document.getElementById('backtest-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Reconstructing point-in-time GAI pillars across history & running purged walk-forward… (~10–25s)</p></div>`;
    try {
      const res = await fetch('/api/backtest?mode=walkforward&scope=large&months=' + btMonths);
      const d = await res.json();
      if (d.error) { el.innerHTML = `<div class="mom-status error"><p>${esc(d.error)}</p></div>`; return; }
      renderWalkForward(d);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Walk-forward failed. Please try again.</p></div>`; }
  }
  // ── Big-Mover Reveal — which signals actually catch the biggest movers ──────
  let btMoverScope = 'small';   // small-caps are where the biggest moves live
  async function runMoverStudy(forceRun) {
    const el = document.getElementById('backtest-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${forceRun ? 'Replaying every signal point-in-time across history & scoring against the biggest movers… (~15–40s)' : 'Loading the big-mover reveal…'}</p></div>`;
    try {
      const url = `/api/tracker?op=moverstudy&scope=${btMoverScope}` + (forceRun ? '&run=1' : '') + `&_=${Date.now()}`;
      const res = await fetch(url);
      const d = await res.json();
      if (d.error) { el.innerHTML = `<div class="mom-status error"><p>${esc(d.error)}</p></div>`; return; }
      renderMoverStudy(d);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Big-mover reveal failed. Please try again.</p></div>`; }
  }
  function renderMoverStudy(d) {
    const el = document.getElementById('backtest-container');
    const scopeSel = `<select class="scr-filter" id="ms-scope" style="max-width:150px">${[['large', 'Large-cap'], ['small', 'Small-cap'], ['micro', 'Micro-cap']].map(([v, l]) => `<option value="${v}"${v === btMoverScope ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const runBtn = `<button class="bt-view-btn" id="ms-run">▶ Run / refresh study</button>`;
    const controls = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">${scopeSel}${runBtn}<span style="font-size:0.66rem;color:var(--text-dim)">heavy — recomputes the point-in-time replay, ~15–40s</span></div>`;

    if (d.empty || !d.signals) {
      el.innerHTML = controls + `<div class="sb-empty">No study cached for <b>${esc(btMoverScope)}</b> yet. Click <b>▶ Run / refresh study</b> to build it (it replays every signal across history and scores it against the biggest movers).</div>`;
      wireMoverControls();
      return;
    }
    const intro = `<div class="bt-note">Took the <b>biggest movers</b> (forward ${d.holdSessions}-session run-up ≥ <b>${d.minMovePct}%</b>) over the last ${d.cohorts} monthly cohorts on <b>${esc(d.scope)}-cap</b> names, reconstructed every signal <b>point-in-time</b> (no look-ahead), and measured each. <b>${d.bigMovers.toLocaleString()}</b> big movers out of <b>${d.totalRecords.toLocaleString()}</b> name-dates — <b>base rate ${d.baseRatePct}%</b>.${d.cached ? '' : ' <span style="color:var(--green)">freshly computed.</span>'}</div>`;
    const legend = `<div class="bt-eff-sub" style="margin-bottom:10px"><b>Recall</b> = of the big movers, % this signal flagged. <b>Precision</b> = of this signal's firings, % that became big movers. <b>Lift</b> = precision ÷ base rate — <b>&gt;1 means real concentration of big movers</b>; ≈1 means the signal fires on everything (no edge). High recall + low lift = a trap.</div>`;
    const mc = d.momCutoff ? `<div class="bt-note" style="margin-bottom:10px">📐 <b>"Top-quartile 3-mo momentum" bar:</b> a name needed a <b>~${d.momCutoff.avgPct}%</b> trailing 3-month return on average to make the top quartile (range <b>${d.momCutoff.minPct}%</b> to <b>${d.momCutoff.maxPct}%</b> across the ${d.momCutoff.cohorts} cohorts). It's a <b>relative</b> cutoff recomputed each month, so the bar rises in strong tapes and falls in weak ones — that's why the signal keeps a stable lift across regimes.</div>` : '';
    const liftColor = l => l >= 1.3 ? 'var(--green)' : l >= 1.05 ? 'var(--amber,#f59e0b)' : 'var(--text-dim)';
    const bar = pct => `<div style="height:5px;background:var(--bg-hi);border-radius:3px;overflow:hidden;margin-top:3px"><div style="height:100%;width:${Math.min(100, pct)}%;background:var(--accent,#8a6dff)"></div></div>`;
    const rows = d.signals.map(s => `
      <div class="bt-card" style="padding:10px 12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span style="font-weight:700;font-size:0.78rem">${esc(s.label)}</span>
          <span style="font-weight:800;font-size:0.9rem;color:${liftColor(s.lift)}" title="lift = precision ÷ base rate">${s.lift}× <span style="font-size:0.6rem;color:var(--text-dim)">lift</span></span>
        </div>
        <div style="display:flex;gap:16px;font-size:0.64rem;color:var(--text-dim);margin-top:5px">
          <span style="flex:1">Recall ${s.recallPct}%${bar(s.recallPct)}</span>
          <span style="flex:1">Precision ${s.precisionPct}%${bar(s.precisionPct)}</span>
          <span style="white-space:nowrap;align-self:center">${s.fired.toLocaleString()} fires</span>
        </div>
      </div>`).join('');
    const ex = (d.examples || []).length ? `<div class="bt-note" style="margin-top:12px"><b>Biggest movers in the window & which signals caught them:</b><br>${d.examples.map(e => `<b>${esc(e.ticker)}</b> +${e.mfePct}% <span style="color:var(--text-dim)">[${e.caughtBy.length ? e.caughtBy.map(esc).join(', ') : 'none of the signals'}]</span>`).join('<br>')}</div>` : '';
    const caveat = `<div class="chart-disclaimer">⚠ In-sample, single (survivorship-biased) universe — this REVEALS which signals concentrate big movers (recall), it does NOT prove forward edge (precision is base-rate-aware but still historical). A signal with lift &gt;1.3 is a genuine lead; feed it into live weights only after a purged walk-forward confirms it. Reactive, not a guarantee. Not financial advice.</div>`;
    el.innerHTML = controls + intro + legend + mc + `<div class="bt-grid">${rows}</div>` + ex + `<div class="bt-note" style="margin-top:8px;color:var(--text-dim)">${esc(d.note)}</div>` + caveat;
    wireMoverControls();
  }
  function wireMoverControls() {
    const sel = document.getElementById('ms-scope');
    if (sel) sel.addEventListener('change', () => { btMoverScope = sel.value; runMoverStudy(false); });
    const btn = document.getElementById('ms-run');
    if (btn) btn.addEventListener('click', () => runMoverStudy(true));
  }

  function renderWalkForward(d) {
    const el = document.getElementById('backtest-container');
    const icCell = ic => ic == null ? '<span style="color:var(--text-dim)">—</span>'
      : `<span class="${ic >= 0 ? 'pos' : 'neg'}">${ic >= 0 ? '+' : ''}${ic.toFixed(3)}</span>`;
    const icBar = ic => {
      if (ic == null) return '<div class="bt-ic-bar"></div>';
      const w = Math.min(50, Math.abs(ic) * 200); // ±0.25 IC spans the half-width
      const col = ic >= 0 ? 'var(--green)' : 'var(--red)';
      const sty = ic >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
      return `<div class="bt-ic-bar"><div class="bt-ic-fill" style="${sty};background:${col}"></div></div>`;
    };

    const v = d.verdict || {};
    const verdict = `<div class="bt-verdict ${v.passed ? 'pass' : 'fail'}">${v.passed ? '✅ ' : '⚠️ '}<b>${esc(v.headline || '')}</b></div>`;

    // Per-pillar rank-IC
    const pillarRows = (d.pillarIC || []).map(p =>
      `<div class="bt-ic-row"><span>${esc(p.label)}${p.priceCore ? '' : ' <span style="color:var(--text-dim);font-weight:400">(pinned)</span>'}</span>${p.priceCore ? icCell(p.ic) : '<span style="color:var(--text-dim);font-size:0.66rem">step-4 feed</span>'}${p.priceCore ? icBar(p.ic) : '<div></div>'}</div>`
    ).join('');

    // Walk-forward OOS blocks
    const wf = d.walkforward || {};
    const foldRows = (wf.folds || []).map(f =>
      `<div class="bt-ic-row"><span>${esc(f.from)} → ${esc(f.to)} <span style="color:var(--text-dim)">(${f.n})</span></span>${icCell(f.ic)}${icBar(f.ic)}</div>`
    ).join('');

    // Ablation
    const abl = (d.composite && d.composite.ablation || []).map(a =>
      `<div class="bt-ic-row"><span>${esc(a.label)}</span>${icCell(a.marginal)}${icBar(a.marginal)}</div>`).join('');

    // Per-regime composite IC
    const reg = (d.composite && d.composite.byRegime || []).filter(r => r.n > 0).map(r =>
      `<span style="margin-right:14px">${esc(r.regime)}: ${r.ic != null ? icCell(r.ic) : '—'} <span style="color:var(--text-dim)">(${r.n})</span></span>`).join('') || '<span style="color:var(--text-dim)">single regime in window</span>';

    el.innerHTML = `
      <div class="bt-note">Reconstructed the GAI <b>price pillars</b> (RM/AF/SF/AV) point-in-time over the last ${d.months} months — <b>${(d.n||0).toLocaleString()}</b> name-dates across ${d.datesUsed} cohorts. Outcome = <b>${esc(d.returnDef)}</b> over ${d.horizonSessions} sessions. The composite is the <b>fixed</b> GAI priors (BONUS &amp; IN excluded — no price source yet), so nothing is fit/overfit; the walk-forward checks rank-IC in each out-of-sample date block.</div>
      ${verdict}
      <div class="bt-eff">
        <div class="bt-eff-head">📐 Per-pillar rank-IC (price core)</div>
        <div class="bt-eff-sub">Spearman correlation between each pillar's cross-sectional percentile and forward excess return. Composite (regime-weighted): <b>${icCell(d.composite && d.composite.ic)}</b> &nbsp;·&nbsp; by regime: ${reg}</div>
        <div class="bt-ic-row head"><span>Pillar</span><span>rank-IC</span><span></span></div>
        ${pillarRows}
      </div>
      <div class="bt-eff">
        <div class="bt-eff-head">🔬 Pillar marginal contribution (ablation)</div>
        <div class="bt-eff-sub">Composite rank-IC lost when each pillar is zeroed. Positive = the pillar adds ranking power; ≤0 = it's dead weight in this window.</div>
        <div class="bt-ic-row head"><span>Pillar</span><span>Δ rank-IC</span><span></span></div>
        ${abl}
      </div>
      <div class="bt-eff">
        <div class="bt-eff-head">🧪 Purged walk-forward — ${wf.oosBlocks || 0} out-of-sample date blocks</div>
        <div class="bt-eff-sub">The fixed composite's rank-IC in each sequential block (purge gap between blocks prevents forward-window leakage). Mean OOS: <b>${icCell(wf.meanOOS)}</b> · ${wf.positiveBlocks}/${wf.oosBlocks} positive. Ship criterion: full-sample IC &gt; ${wf.margin} AND all ≥3 blocks positive.</div>
        <div class="bt-ic-row head"><span>Block (window · n)</span><span>rank-IC</span><span></span></div>
        ${foldRows}
      </div>
      <div class="chart-disclaimer">⚠ Rank-IC measures ranking power, not tradeable P&L. Curated (survivorship-biased) universe; price-pillars only. Not financial advice.</div>`;
  }
  function renderBacktest(d) {
    const el = document.getElementById('backtest-container');
    const sgn = v => (v >= 0 ? '+' : '') + v + '%';
    const meta = { Breakout: ['breakout', '🚀 Breakout'], Setup: ['setup', '⏳ Setup'], Early: ['early', '🌱 Early'] };
    const metric = (lb, val, cls) => `<div class="bt-m"><span>${lb}</span><b class="${cls || ''}">${val}</b></div>`;
    const cards = ['Breakout', 'Setup', 'Early'].map(t => {
      const x = d.summary[t] || { n: 0 }; const [cls, label] = meta[t];
      if (!x.n) return `<div class="bt-card ${cls}"><div class="bt-tier">${label}<span class="bt-n">no trades</span></div></div>`;
      const body = [
        metric('Win', x.winRate + '%'),
        metric('Avg / trade', sgn(x.avgReturn), x.avgReturn >= 0 ? 'pos' : 'neg'),
        metric('Alpha vs SPY', sgn(x.avgAlpha), x.avgAlpha >= 0 ? 'pos' : 'neg'),
        metric('Profit factor', x.profitFactor, x.profitFactor >= 1 ? 'pos' : 'neg'),
        metric('Avg hold', x.avgHold + 'd'),
      ].join('');
      return `<div class="bt-card ${cls}"><div class="bt-tier">${label}<span class="bt-n">${x.n.toLocaleString()} trades</span></div><div class="bt-metrics">${body}</div></div>`;
    }).join('');

    // Regime split
    let regHtml = '';
    if (d.regimeSplit) {
      const on = d.regimeSplit.on || { n: 0 }, off = d.regimeSplit.off || { n: 0 };
      regHtml = `<div class="bt-regime">📊 By market regime — <b style="color:var(--green)">Risk-on (SPY&gt;200-DMA):</b> ${on.n || 0} trades · ${on.n ? on.winRate + '% win · ' + sgn(on.avgAlpha) + ' alpha' : '—'} &nbsp;|&nbsp; <b style="color:var(--red)">Risk-off:</b> ${off.n || 0} trades · ${off.n ? off.winRate + '% win · ' + sgn(off.avgAlpha) + ' alpha' : '—'}</div>`;
    }

    // Walk-forward Signal Edge (alpha, in-sample → out-of-sample)
    let effHtml = '';
    if (d.efficacy && d.efficacy.features?.length) {
      const eff = d.efficacy;
      const rows = eff.features.map(f => {
        return `<div class="bt-row bt-wf-row"><span>${esc(f.label)}</span><span class="${f.isLift >= 0 ? 'pos' : 'neg'}">${sgn(f.isLift)}</span><span class="${f.oosLift >= 0 ? 'pos' : 'neg'}">${sgn(f.oosLift)}</span><span>${f.oosWin}%</span><span>${f.robust ? '✅' : '—'}</span></div>`;
      }).join('');
      const robust = eff.features.filter(f => f.robust).slice(0, 3).map(f => f.label);
      const reco = robust.length
        ? `<div class="bt-reco">✅ Out-of-sample robust edges: <b>${robust.map(esc).join(' · ')}</b>. Only these held their alpha on unseen data — the <b>🎯 High-Conviction</b> filter now uses exactly these (per scope).</div>`
        : `<div class="bt-reco" style="background:var(--amber-dim);border-color:#f0a83233"><b style="color:var(--amber)">No edge held up out-of-sample in this window.</b> 🎯 falls back to the safest default (Breakout). A weak/choppy tape can wipe out edges — re-check after conditions improve.</div>`;
      effHtml = `<div class="bt-eff">
        <div class="bt-eff-head">📐 Signal Edge — walk-forward (alpha vs SPY)</div>
        <div class="bt-eff-sub">Edges are derived on older data (<b>in-sample</b>) and validated on more recent unseen data (<b>out-of-sample</b>, since ${eff.splitDate || '—'}). Baseline alpha: IS ${sgn(eff.baseline.is)} → OOS ${sgn(eff.baseline.oos)}. Only edges positive in BOTH are trustworthy.</div>
        <div class="bt-row bt-head bt-wf-row"><span>Signal</span><span>IS lift</span><span>OOS lift</span><span>OOS win</span><span>Robust</span></div>
        ${rows}${reco}</div>`;
    }

    // Learned factor model panel
    let modelHtml = '';
    if (d.model && d.model.weights) {
      const md = d.model, reliable = md.oosAUC >= MODEL_RELIABLE;
      const wbars = md.features.map((f, i) => {
        const w = md.weights[i];
        return `<div class="bt-row" style="grid-template-columns:1.6fr 1fr"><span>${esc(HC_LABEL[f] || f)}</span><span class="${w >= 0 ? 'pos' : 'neg'}">${w >= 0 ? '+' : ''}${w}</span></div>`;
      }).join('');
      modelHtml = `<div class="bt-eff">
        <div class="bt-eff-head">🤖 Learned factor model — logistic regression (walk-forward)</div>
        <div class="bt-eff-sub">Trained on ${md.n.toLocaleString()} in-sample signals, validated on ${md.oosN.toLocaleString()} unseen. <b>OOS AUC ${md.oosAUC}</b> · top-half alpha <b class="${md.oosTopAlpha >= 0 ? 'pos' : 'neg'}">${sgn(md.oosTopAlpha)}</b> vs bottom <b class="${md.oosBotAlpha >= 0 ? 'pos' : 'neg'}">${sgn(md.oosBotAlpha)}</b>. Learned weights:</div>
        ${wbars}
        <div class="bt-reco" style="${reliable ? '' : 'background:var(--amber-dim);border-color:#f0a83233'}">${reliable
          ? `✅ Model shows out-of-sample skill (AUC ${md.oosAUC}) — win-probabilities appear on cards; flip on <b>🤖 Model</b> in the Screener to rank by them.`
          : `<b style="color:var(--amber)">No reliable edge out-of-sample</b> (AUC ${md.oosAUC} ≈ coin-flip; top picks didn't beat bottom). Win-probabilities are hidden until the model regains skill — the walk-forward guard preventing false confidence.`}</div></div>`;
    }

    el.innerHTML = `<div class="bt-note">Replayed the live screen over the last ${d.months} months across ${d.names} names — ${d.instances.toLocaleString()} signals. Each is traded with an <b>ATR stop (${d.exits.stopATR}×) / target (${d.exits.targetATR}×)</b> and a ${d.exits.maxHold}-day time-stop; returns are measured <b>vs SPY (alpha)</b>, equal-weight, no costs.</div><div class="bt-grid">${cards}</div>${regHtml}${effHtml}${modelHtml}<div id="bt-portfolio"></div><div class="chart-disclaimer">⚠ Historical replay on a curated (survivorship-biased) universe — past performance does not guarantee future results, and this is not financial advice.</div>`;
    storeHCEdges(d.efficacy, d.months, d.scope || 'large');
    storeModel(d.model, d.scope || 'large');
    runPortfolio();
  }

  async function runPortfolio() {
    const el = document.getElementById('bt-portfolio');
    if (!el) return;
    el.innerHTML = `<div class="mom-status" style="padding:24px 0"><div class="mom-spinner"></div><p>Simulating the portfolio…</p></div>`;
    try {
      const r = await fetch('/api/backtest?mode=portfolio&scope=large&months=' + btMonths);
      const d = await r.json();
      if (d.error) { el.innerHTML = ''; return; }
      renderPortfolio(d);
    } catch { el.innerHTML = ''; }
  }

  function renderPortfolio(d) {
    const el = document.getElementById('bt-portfolio');
    const x = d.stats;
    const A = d.curve.map(p => p.v), B = d.spyCurve.map(p => p.v), all = [...A, ...B];
    const lo = Math.min(...all), hi = Math.max(...all), W = 600, H = 150, pad = 6, n = Math.max(A.length, B.length, 2);
    const xx = i => pad + (i / (n - 1)) * (W - 2 * pad);
    const yy = v => pad + (1 - (v - lo) / ((hi - lo) || 1)) * (H - 2 * pad);
    const line = (arr, col, dash) => `<polyline points="${arr.map((v, i) => xx(i).toFixed(1) + ',' + yy(v).toFixed(1)).join(' ')}" fill="none" stroke="${col}" stroke-width="1.9" ${dash ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round"/>`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px"><line x1="0" y1="${yy(1).toFixed(1)}" x2="${W}" y2="${yy(1).toFixed(1)}" stroke="#243659" stroke-width="1" stroke-dasharray="2 2"/>${line(B, '#4d6688', true)}${line(A, '#10d98a', false)}</svg>`;
    const stat = (lb, a, b, better) => `<div class="pf-stat"><span>${lb}</span><b class="${better ? 'pos' : 'neg'}">${a}</b><i>SPY ${b}</i></div>`;
    const beat = x.totalReturn > x.spyReturn;
    el.innerHTML = `<div class="pf-panel">
      <div class="bt-eff-head">💼 Portfolio simulation — top ${d.maxPos} concurrent · equal-weight · ATR exits</div>
      <div class="bt-eff-sub">${d.trades.toLocaleString()} trades · ${x.exposure}% avg invested. <span style="color:#10d98a">━ strategy</span> vs <span style="color:#7a8db0">┄ SPY buy &amp; hold</span> (start = 1.0).</div>
      <div class="pf-chart">${svg}</div>
      <div class="pf-stats">
        ${stat('Total return', x.totalReturn + '%', x.spyReturn + '%', x.totalReturn >= x.spyReturn)}
        ${stat('CAGR', x.cagr + '%', x.spyCagr + '%', x.cagr >= x.spyCagr)}
        ${stat('Sharpe', x.sharpe, x.spySharpe, x.sharpe >= x.spySharpe)}
        ${stat('Max drawdown', x.maxDD + '%', x.spyMaxDD + '%', x.maxDD >= x.spyMaxDD)}
      </div>
      <div class="bt-reco" style="${beat ? '' : 'background:var(--amber-dim);border-color:#f0a83233'}">${beat ? `✅ Beat SPY by <b>${(x.totalReturn - x.spyReturn).toFixed(1)} pts</b> over ${d.months} months at ${x.exposure}% exposure.` : `<b style="color:var(--amber)">Trailed SPY</b> by ${(x.spyReturn - x.totalReturn).toFixed(1)} pts this window — the screen's edge is modest and regime-dependent. Honest data beats false confidence.`}</div>
    </div>`;
  }

  function scrFilterQS() {
    const s = document.getElementById('scr-filter-sector')?.value || 'all';
    const e = document.getElementById('scr-filter-exchange')?.value || 'all';
    const g = document.getElementById('scr-gate')?.value || 'relaxed';
    let q = '';
    if (s !== 'all') q += '&sector=' + encodeURIComponent(s);
    if (e !== 'all') q += '&exchange=' + encodeURIComponent(e);
    if (g === 'strict') q += '&gate=strict';
    return q;
  }
  function setSectorFilter(s) {
    const sel = document.getElementById('scr-filter-sector');
    if (!sel) return;
    sel.value = s; saveFilters(); refreshScreeners();
    document.getElementById('screener')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  screenerRefreshBtn.addEventListener('click', refreshScreeners);
  // Lazy-load: only scan when the Screener tab is actually opened (ensureScreener is
  // called from showTab). Previously this fired all 3 scopes on EVERY page load — even
  // on unrelated tabs — and a non-warmed lookback/filter made each a ~23s cold scan.
  let screenerLoaded = false;
  function ensureScreener() {
    if (screenerLoaded) return;
    screenerLoaded = true;
    refreshScreeners();
    setInterval(refreshScreeners, 30 * 60 * 1000); // 30 min — daily breakouts move slowly
  }

  function refreshScreeners() {
    fetchScreenerScope('large', screenerContainer, screenerMeta, true);
    fetchScreenerScope('small', screenerSmallContainer, screenerSmallMeta, false);
    fetchScreenerScope('micro', screenerMicroContainer, screenerMicroMeta, false);
    fetchScreenerScope('expanded', screenerExpandedContainer, screenerExpandedMeta, false);
  }

  async function fetchScreenerScope(scope, container, metaEl, isMain) {
    screenerRefreshBtn.disabled = true;
    container.innerHTML = skeletonGrid(scope === 'large' ? 6 : 4);
    try {
      const res = await fetch('/api/screener?scope=' + scope + scrFilterQS() + (scope === 'large' ? '&lookback=' + scrLookback : ''));
      const data = await res.json();
      if (data.error) { container.innerHTML = `<div class="mom-status error"><p>${esc(data.error)}</p></div>`; return; }
      const { results = [], cap, rotation, scannedCount, breakoutCount, generatedAt, narrativeEnabled } = data;
      if (isMain && generatedAt) screenerGenTime.textContent = `Updated ${new Date(generatedAt).toLocaleTimeString()}`;
      if (metaEl) metaEl.textContent = `· ${scannedCount || 0} scanned · ${results.length} passed the 4-filter gate · ${breakoutCount || 0} breaking out${narrativeEnabled ? '' : ' · narrative offline'}`;
      if (cap) scrCaps[scope] = cap;
      if (scope === 'large') { lastRegime = data.regime || null; renderRotation(rotation); renderRotationTrend(data.rotationHistory); renderRegime(lastRegime); renderMomentumRegime(); }
      scrRaw[scope] = results;
      rankAndRender(scope);
      // The regime read comes with the large scope — re-rank the other scopes so
      // any already-loaded small/micro lists pick up the bearish score downgrade.
      if (scope === 'large') ['small', 'micro'].forEach(s => rankAndRender(s));
    } catch {
      container.innerHTML = `<div class="mom-status error"><p>Could not run the screener. Please try again.</p></div>`;
    } finally { screenerRefreshBtn.disabled = false; }
  }

  function renderScreenerList(results, container, scope, rrFallback) {
    if (!results.length) {
      const label = scope === 'large' ? 'large-cap' : scope === 'small' ? 'small-cap' : 'micro-cap';
      const msg = scrMomMin > 0
        ? `No ${label} names with a trailing 3-month return ≥ +${scrMomMin}% right now. Lower the Momentum filter or set it to "any" to see more setups.`
        : scrEmerg
        ? `No emerging-leader ${label} names right now — no name is at the early stage of a momentum leg (fresh RS leadership + accumulation, not yet extended). This filter is intentionally selective and stays empty rather than flag oversold-bounce/squeeze names it can't predict. Turn off 🌱 Emerging to see all setups.`
        : scrHC
        ? `No high-conviction ${label} names right now (breakout + above 200-day MA + VCP). Turn off 🎯 High-Conviction to see all setups.`
        : `No ${label} breakouts or setups clearing the filters right now — the broad tape is weak.`;
      container.innerHTML = `<div class="mom-status"><p>${msg}</p></div>`;
      return;
    }
    container.innerHTML = '';
    if (rrFallback) container.insertAdjacentHTML('beforeend', rrFallbackBanner(results.length));
    container.appendChild(buildSecBar(results));
    const grid = document.createElement('div');
    grid.className = 'scr-grid';
    results.forEach((c, idx) => grid.appendChild(buildScrCard(c, idx)));
    container.appendChild(grid);
    attachTimingLights(container, results.map(c => ({ ticker: c.ticker, stop: c.levels && c.levels.stop, target: c.levels && (c.levels.resistance ?? c.levels.target), trigger: c.levels && c.levels.entry })), 'screener-' + scope);
  }

  // Score haircut applied to long breakout candidates in a bearish regime —
  // breakouts fail at much higher rates in downtrends.
  const REGIME_PENALTY = 0.65;
  const CHOP_PENALTY = 0.80;   // lighter downgrade for choppy (vs bearish) tapes
  let lastRegime = null;

  // Prominent warning banner shown on both Screener and Momentum tabs when the
  // market regime is bearish (SPY < 200-DMA or breadth < 40%).
  function regimeBannerHTML(rg) {
    if (!rg) return '';
    if (rg.bearish) {
      const reasons = [];
      if (rg.indexAbove200 === false) reasons.push('S&P 500 is below its 200-day average');
      if (rg.breadthPct != null && rg.breadthPct < 40) reasons.push(`only ${rg.breadthPct}% of names are above their 50-day average`);
      return `<div class="regime-banner">
        <span class="rb-ic">⚠️</span>
        <div class="rb-body">
          <b>Risk-Off market — ${reasons.join(' · ')}.</b>
          Breakouts fail at much higher rates in downtrends. Breakout-tier scores are <b>downgraded ${Math.round((1 - REGIME_PENALTY) * 100)}%</b> — be selective and size down.
        </div>
      </div>`;
    }
    if (rg.condition === 'choppy') {
      return `<div class="regime-banner" style="border-color:#06c4d455;background:var(--cyan-dim)">
        <span class="rb-ic">🌊</span>
        <div class="rb-body" style="color:var(--text)">
          <b>Choppy / ranging tape</b> (low trend efficiency). Breakouts fail more often here (false breakouts), so breakout-tier scores are <b>downgraded ${Math.round((1 - CHOP_PENALTY) * 100)}%</b> — favor confirmed strength and tighter stops.
        </div>
      </div>`;
    }
    return '';
  }

  function renderRegime(rg) {
    const el = document.getElementById('screener-regime');
    if (!el) return;
    if (!rg) { el.innerHTML = ''; return; }
    const on = rg.riskOn;
    const idx = rg.indexAbove200 === true ? 'S&amp;P 500 above 200-DMA' : rg.indexAbove200 === false ? 'S&amp;P 500 below 200-DMA' : 'index trend unknown';
    const breadth = rg.breadthPct != null ? ` · ${rg.breadthPct}% of names above 50-DMA` : '';
    const note = on ? 'breakouts have the wind at their back' : 'most breakouts fail in corrections — be selective, size down';
    const chip = `<div class="scr-regime ${on ? 'on' : 'off'}"><span class="rg-dot"></span><b>${on ? 'Risk-On' : 'Risk-Off'}</b> · ${idx}${breadth} <span class="rg-note">— ${note}</span></div>`;
    el.innerHTML = regimeBannerHTML(rg) + chip;
  }

  function renderMomentumRegime() {
    const el = document.getElementById('momentum-regime');
    if (el) el.innerHTML = regimeBannerHTML(lastRegime);
  }

  function renderRotation(rotation) {
    const el = document.getElementById('screener-rotation');
    if (!el) return;
    const curSector = document.getElementById('scr-filter-sector')?.value || 'all';
    if (!rotation || !rotation.length || curSector !== 'all') { el.innerHTML = ''; return; }
    const top = rotation.filter(r => r.scanned > 0);
    const maxTilt = Math.max(1, ...top.map(r => Math.abs(r.tilt)));
    const rows = top.map(r => {
      const w = Math.round(Math.abs(r.tilt) / maxTilt * 50);
      const ow = r.tilt >= 0;
      const bar = ow ? `<div class="rot-pos" style="width:${w}%"></div>` : `<div class="rot-neg" style="width:${w}%"></div>`;
      return `
      <div class="rot-row" data-sec="${esc(r.sector)}" title="${r.breakoutShare}% of breakouts vs ${r.universeShare}% of index · ${r.hits}/${r.scanned} names">
        <span class="rot-name">${esc(r.sector)}</span>
        <div class="rot-dtrack"><div class="rot-mid"></div>${bar}</div>
        <span class="rot-val ${ow ? 'ow' : 'uw'}">${ow ? '+' : '−'}${Math.abs(r.tilt)}pp</span>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="rot-panel"><div class="rot-head">🔄 Sector Rotation — Relative</div><div class="rot-sub">Each sector's share of today's breakouts vs. its share of the index. <b style="color:var(--green)">Overweight</b> = money rotating in; <b style="color:var(--red)">underweight</b> = lagging. Tap to drill in.</div>${rows}</div>`;
    el.querySelectorAll('.rot-row').forEach(row => row.onclick = () => setSectorFilter(row.dataset.sec));
  }

  function sparkSvg(series, gMin, gMax, ow) {
    const w = 120, h = 24, pad = 2, n = series.length, range = (gMax - gMin) || 1;
    const x = i => pad + (n <= 1 ? 0 : i / (n - 1) * (w - 2 * pad));
    const y = v => pad + (1 - (v - gMin) / range) * (h - 2 * pad);
    const zeroY = y(0).toFixed(1);
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const col = ow ? '#10d98a' : '#ef5050';
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="#243659" stroke-width="1" stroke-dasharray="2 2"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function renderRotationTrend(history) {
    const el = document.getElementById('screener-rottrend');
    if (!el) return;
    const cur = document.getElementById('scr-filter-sector')?.value || 'all';
    if (!history || history.length < 2 || cur !== 'all') { el.innerHTML = ''; return; }
    const points = [...history].sort((a, b) => b.daysAgo - a.daysAgo); // oldest → newest
    const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const startDate = fmtDate(points[0]?.date), endDate = fmtDate(points[points.length - 1]?.date);
    const today = history.find(h => h.daysAgo === 0)?.tilts || {};
    const sectors = Object.keys(today).sort((a, b) => Math.abs(today[b]) - Math.abs(today[a])).slice(0, 6);
    let gMin = 0, gMax = 0;
    sectors.forEach(s => points.forEach(p => { const v = p.tilts[s] ?? 0; if (v < gMin) gMin = v; if (v > gMax) gMax = v; }));
    const rows = sectors.map(s => {
      const series = points.map(p => p.tilts[s] ?? 0);
      const cv = today[s] ?? 0, ow = cv >= 0;
      return `<div class="rot-row" data-sec="${esc(s)}">
        <span class="rot-name">${esc(s)}</span>
        <div class="rt-spark">${sparkSvg(series, gMin, gMax, ow)}</div>
        <span class="rot-val ${ow ? 'ow' : 'uw'}">${ow ? '+' : '−'}${Math.abs(cv)}pp</span>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="rot-panel"><div class="rot-head">📈 Rotation Trend${startDate ? ` <span style="font-weight:600;color:var(--text-dim);font-size:0.66rem">· since ${startDate}</span>` : ''}</div><div class="rot-sub">Sector tilt over the selected window (left = older, right = today). Above the dashed line = overweight. Replayed from daily price history.</div>${rows}<div class="rt-axis"><span>${startDate}</span><span>Today · ${endDate}</span></div></div>`;
    el.querySelectorAll('.rot-row').forEach(row => row.onclick = () => setSectorFilter(row.dataset.sec));
  }

  // ── Daily & weekly sector rotation trends (relative strength vs SPY) ──
  let rotDWLoaded = false;
  function ensureRotationDW() { if (!rotDWLoaded) { rotDWLoaded = true; loadRotationDW(); } }
  async function loadRotationDW() {
    const el = document.getElementById('screener-rotdw');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading daily &amp; weekly rotation…</p></div>`;
    try {
      const d = await fetch('/api/sectors?mode=rotation').then(r => r.json());
      renderRotationDW(d);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load rotation trends.</p></div>`; }
  }

  function rotPanel(title, sub, rows, list, cumKey, headKey, headLabel) {
    // global y-range across the shown sectors so sparklines are comparable
    let gMin = 0, gMax = 0;
    list.forEach(s => (s[cumKey] || []).forEach(v => { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }));
    const body = list.map(s => {
      const series = s[cumKey] || [];
      const inFlow = (series[series.length - 1] ?? 0) >= 0;
      const hv = s[headKey] ?? 0, hp = hv >= 0;
      return `<div class="rot-row">
        <span class="rot-name">${esc(s.name)} <span style="color:var(--text-dim);font-weight:600">${esc(s.symbol)}</span></span>
        <div class="rt-spark">${sparkSvg(series, gMin, gMax, inFlow)}</div>
        <span class="rot-val ${hp ? 'ow' : 'uw'}">${hp ? '+' : '−'}${Math.abs(hv).toFixed(2)}%</span>
      </div>`;
    }).join('');
    return `<div class="rot-panel"><div class="rot-head">${title}</div><div class="rot-sub">${sub}</div>${body}
      <div class="rt-axis"><span>${rows} ago</span><span>${headLabel}</span></div></div>`;
  }

  function renderRotationDW(d) {
    const el = document.getElementById('screener-rotdw');
    if (!el) return;
    if (!d || !d.rotation || !d.rotation.length) { el.innerHTML = ''; return; }
    // Daily: rank by cumulative excess over the window (the rotation leaders/laggards).
    const daily = [...d.rotation].sort((a, b) => b.dailyTotal - a.dailyTotal);
    const weekly = [...d.rotation].sort((a, b) => b.weeklyTotal - a.weeklyTotal);
    const dailyPanel = rotPanel('📅 Daily Rotation', `Relative strength vs SPY, cumulative over the last ${d.sessions} sessions. Rising line = money rotating <b style="color:var(--green)">in</b>. Right value = today vs SPY.`, `${d.sessions} sessions`, daily, 'dailyCum', 'daily1d', 'Today');
    const weeklyPanel = rotPanel('🗓️ Weekly Rotation', `Relative strength vs SPY, cumulative over the last ${d.weeks} weeks. Right value = this week vs SPY.`, `${d.weeks} weeks`, weekly, 'weeklyCum', 'weekly1w', 'This week');
    el.innerHTML = `<div class="rot-dw-grid">${dailyPanel}${weeklyPanel}</div>`;
  }

  function buildSecBar(results) {
    const counts = {};
    results.forEach(c => { const s = c.sector || 'Other'; counts[s] = (counts[s] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const cur = document.getElementById('scr-filter-sector')?.value || 'all';
    const bar = document.createElement('div');
    bar.className = 'sec-bar';
    if (cur !== 'all') {
      const clr = document.createElement('button');
      clr.className = 'sec-chip clear'; clr.textContent = '✕ All sectors';
      clr.onclick = () => setSectorFilter('all');
      bar.appendChild(clr);
    }
    entries.forEach(([s, n]) => {
      const b = document.createElement('button');
      b.className = 'sec-chip' + (s === cur ? ' active' : '');
      b.innerHTML = `${esc(s)} <b>${n}</b>`;
      b.onclick = () => setSectorFilter(s);
      bar.appendChild(b);
    });
    return bar;
  }

  // Label for the target box, by how the target was derived.
  function targetLabel(lv) {
    return lv && lv.targetType === 'resistance' ? 'Resistance'
         : lv && lv.targetType === 'support' ? 'Support'
         : 'Target';
  }

  // Shared risk/reward line for screener, momentum and picks cards.
  function rrLineHTML(lv) {
    if (!lv || lv.rr == null) return '';
    const ok = lv.rr >= 2;
    const why = ok ? '' : (lv.targetType === 'resistance' ? 'entering near resistance'
                          : lv.targetType === 'support'   ? 'little room to support'
                          : 'thin reward vs. risk');
    const basis = lv.stopBasis ? `stop below ${lv.stopBasis}` : '';
    return `<div class="rr-line">
        <span class="rr-risk">Risk/sh <b>$${lv.risk}</b></span>
        <span class="rr-badge ${ok ? 'ok' : 'bad'}">R:R ${Number(lv.rr).toFixed(1)}:1</span>
        ${why ? `<span class="rr-why">${why}</span>` : (basis ? `<span class="rr-basis">${basis}</span>` : '')}
      </div>`;
  }

  // 2:1 reward-to-risk gate with graceful fallback: if nothing clears 2:1, return
  // the best-available by R:R (tagged) so a section never silently goes blank.
  function rrGate(list, topN = 3) {
    const withRR = list.filter(c => c.levels && c.levels.rr != null);
    const pass = withRR.filter(c => c.levels.rr >= 2);
    if (pass.length) return { items: pass, fallback: false };
    const top = withRR.slice().sort((a, b) => b.levels.rr - a.levels.rr).slice(0, topN).map(c => ({ ...c, _belowRR: true }));
    return { items: top, fallback: top.length > 0 };
  }
  function rrFallbackBanner(n) {
    return `<div class="rr-fallback">⚠ No setups currently clear 2:1 reward-to-risk — showing the ${n} best available. Trade with caution or wait for cleaner entries.</div>`;
  }

  // Compact USD for average dollar volume: $420K / $2.1M / $18M / $1.2B.
  function fmtCompactUsd(n) {
    n = +n || 0;
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  // Liquidity / slippage hazard from 20-50d average dollar volume (ADV_USD).
  // Thresholds use the project's own validated $3M/day tradeable floor (the level
  // the stablecore + CERN-lockup feeds gate on) — below it, wide bid-ask spreads
  // and low volume cause real entry/exit slippage that erodes theoretical alpha.
  // Returns null (no badge) for liquid names so the warning stays low-profile.
  const LIQ_HIGH_USD = 500e3;   // < $500k/day = severe slippage risk
  const LIQ_CAUTION_USD = 3e6;  // < $3M/day  = thin; size carefully
  function liquidityHazard(c) {
    const adv = c && c.factors && c.factors.dollarVol;
    if (adv == null || adv <= 0) return null;
    const atrPct = (c.factors.atr != null && c.price) ? (c.factors.atr / c.price) * 100 : null;
    const atrNote = atrPct != null ? ` ATR ≈ ${atrPct.toFixed(1)}% of price (wider on volatile names).` : '';
    if (adv < LIQ_HIGH_USD) {
      return { cls: 'high', label: '⚠ Low liquidity',
        title: `Avg dollar volume only ${fmtCompactUsd(adv)}/day (below $500K). Wide bid-ask spreads and thin volume can cause severe slippage — fills may be far from quoted price, eroding theoretical edge.${atrNote}` };
    }
    if (adv < LIQ_CAUTION_USD) {
      return { cls: 'caution', label: '⚠ Thin liquidity',
        title: `Avg dollar volume ${fmtCompactUsd(adv)}/day (below the $3M tradeable floor). Fills may slip and spreads widen — size carefully and use limit orders.${atrNote}` };
    }
    return null;
  }

  function buildScrCard(c, idx) {
    // Emerging-leader admitted names have no base-pattern status (status=null) —
    // label them as such rather than defaulting to a misleading "Setup".
    const st = c.status || (c.emergingLeader ? 'Emerging' : 'Setup');
    const isBreakout = st === 'Breakout';
    const cls = st === 'Emerging' ? 'early' : st.toLowerCase(); // breakout | setup | early
    const stLabel = st === 'Breakout' ? '🚀 Breakout' : st === 'Early' ? '🌱 Early' : st === 'Emerging' ? '🌱 Emerging Leader' : '⏳ Setup';
    const up = (c.changePct ?? 0) >= 0;
    const q = c.pct || {};
    const score = c._score ?? c.quant?.score ?? 0;

    const chips = SCR_CRITERIA.map(([key, label]) => {
      const met = c.criteria && c.criteria[key];
      const help = SCR_CRITERIA_HELP[key] ? ` title="${esc(SCR_CRITERIA_HELP[key])}${met ? '' : ' (this one is NOT met for this stock)'}"` : '';
      return `<div class="scr-chip ${met ? 'met' : ''}"${help}><div class="scc-ic">${met ? '✓' : '·'}</div><span class="scc-lb">${label}</span></div>`;
    }).join('');

    // The four required hard-gate filters, each with the figure behind it.
    const f  = c.filters || {};
    const fm = c.metrics || {};
    const fDetail = {
      consolidation: fm.consoWeeks != null ? `${fm.consoWeeks}wk` : '',
      volume:        fm.volSurge != null ? `${fm.volSurge}×` : '',
      rsVsSpy:       fm.rsVsSpy63 != null ? `${fm.rsVsSpy63 >= 0 ? '+' : ''}${fm.rsVsSpy63}%` : '',
      aboveSmas:     '',
    };
    const filtersHtml = `
        <div class="scr-filters-row">
          <div class="scr-filters-label">Required filters — all must pass</div>
          <div class="scr-filters">
            ${SCR_FILTERS.map(([key, label]) => {
              const ok = !!f[key];
              const det = fDetail[key];
              return `<div class="scr-fchip ${ok ? 'pass' : 'fail'}"><span class="sf-ic">${ok ? '✓' : '✕'}</span><span class="sf-lb">${label}${det ? ` <b>${det}</b>` : ''}</span></div>`;
            }).join('')}
          </div>
        </div>`;

    // Elite-trader setup tags
    const mm = c.metrics || {};
    const tags = [];
    if (c.emergingLeader) tags.push(['emerg', '🌱 Emerging Leader']);
    if (isHighConviction(c)) tags.push(['hc', '🎯 High-Conviction']);
    const _md = getModel(scopeOf(c));
    if (_md && _md.oosAUC >= MODEL_RELIABLE) { const wp = modelProb(c); if (wp != null) tags.push(['model', `🤖 ${wp}%`]); }
    if (mm.rsNewHigh) tags.push(['rsnh', '📈 RS New High']);
    if (mm.vcpContractions >= 2) tags.push(['vcp', `VCP ${mm.vcpContractions}×`]);
    if (mm.longBase) tags.push(['lbase', `${mm.baseWeeks}wk base`]);
    if (mm.pocketPivot) tags.push(['pp', '⚡ Pocket Pivot']);
    if (mm.vdu != null && mm.vdu <= 70) tags.push(['vdu', `VDU ${mm.vdu}%`]);
    if (mm.obvRising) tags.push(['obv', 'OBV ↑']);
    if (mm.udVol != null && mm.udVol >= 1.3) tags.push(['ud', `U/D ${mm.udVol}×`]);
    const fd = c.fundamentals;
    if (fd && fd.earningsInDays != null && fd.earningsInDays >= 0 && fd.earningsInDays <= 10) tags.push(['earn', `⚠ Earnings ${fd.earningsInDays}d`]);
    // Short-interest flag — a soft AVOIDANCE badge (high SI% = significant negative
    // predictor, but short-side + regime-fragile; opt-in filter, never a hard gate).
    const si = c.shortInterest;
    if (si && si.level) {
      const lbl = si.pct != null ? `${si.pct}%` : (si.dtc != null ? `${si.dtc}d DTC` : '');
      tags.push(['si' + (si.level === 'high' ? ' hi' : ''), `🩳 ${si.level === 'high' ? 'High ' : ''}SI ${lbl}`]);
    }
    const tagsHtml = tags.length ? `<div class="scr-tags">${tags.map(([k, t]) => `<span class="scr-tag ${k}">${esc(t)}</span>`).join('')}</div>` : '';
    const liq = liquidityHazard(c);
    const liqHtml = liq ? `<div class="scr-liq ${liq.cls}" title="${esc(liq.title)}"><span class="scr-liq-ic">🩸</span>${esc(liq.label)}</div>` : '';
    const fundaHtml = (fd && (fd.epsGrowth != null || fd.revGrowth != null)) ? `<div class="scr-funda">📈 ${fd.epsGrowth != null ? `EPS <b class="${fd.epsGrowth >= 0 ? 'pos' : 'neg'}">${fd.epsGrowth >= 0 ? '+' : ''}${fd.epsGrowth}%</b>` : ''}${fd.revGrowth != null ? `${fd.epsGrowth != null ? ' · ' : ''}Rev <b class="${fd.revGrowth >= 0 ? 'pos' : 'neg'}">${fd.revGrowth >= 0 ? '+' : ''}${fd.revGrowth}%</b>` : ''}${fd.netMargin != null ? ` · Margin ${fd.netMargin}%` : ''} <span class="scr-funda-yoy">YoY</span></div>` : '';

    const qbar = (lb, v) => `<div class="scr-qf"><div class="qf-top"><span>${lb}</span><b>${v ?? 0}</b></div><div class="qf-track"><div class="qf-fill" style="width:${v ?? 0}%"></div></div></div>`;
    const quantHtml = c.pct ? `<div class="scr-quant">${qbar('Mom', q.mom)}${qbar('RS', q.rs)}${qbar('Trend', q.trend)}${qbar('V-Adj', q.volAdj)}${qbar('Base', q.base)}</div>` : '';
    const tierHtml = (c.capTier && c.capTier !== 'Large') ? `<span class="scr-tier ${c.capTier.toLowerCase()}">${esc(c.capTier)} cap</span>` : '';

    const m = c.metrics || {};
    const pivotInfo = isBreakout
      ? `+${m.pctAbovePivot}% above pivot`
      : `${m.pctBelowPivot}% below pivot`;
    const metricsHtml = `
        <span>Pivot <b>$${m.pivot}</b></span>
        <span>${esc(pivotInfo)}</span>
        <span>Vol <b>${m.volSurge}×</b></span>
        ${m.rsi != null ? `<span>RSI <b>${m.rsi}</b></span>` : ''}
        <span>Base <b>${m.baseWeeks}wk</b></span>
        ${m.adrPct != null ? `<span>ADR <b>${m.adrPct}%</b></span>` : ''}
        <span><b>${m.pctFrom52wHigh}%</b> off high</span>`;

    const lv = c.levels || {};
    const levelsHtml = `
        <div class="alert-targets">
          <div class="at-box"><div class="at-label">${isBreakout ? 'Entry' : 'Trigger'}</div><div class="at-val entry">$${lv.entry}</div></div>
          <div class="at-box"><div class="at-label">${targetLabel(lv)}</div><div class="at-val target">$${lv.resistance ?? lv.target}</div></div>
          <div class="at-box"><div class="at-label">Stop</div><div class="at-val stop">$${lv.stop}</div></div>
        </div>${rrLineHTML(lv)}`;

    const narrativeHtml = c.narrative
      ? `<div class="scr-narrative">${esc(c.narrative)}${c.narrativeStrength != null ? ` <span class="scr-narr-str">Story ${c.narrativeStrength}/10</span>` : ''}</div>`
      : '';

    const reasonsHtml = (c.reasons || []).map(r =>
      `<div class="sig-reason bull"><span class="sr-dot">▸</span><span>${esc(r)}</span></div>`
    ).join('');

    const card = document.createElement('div');
    card.className = `scr-card ${cls} fade-in`;
    card.dataset.ticker = c.ticker;
    card.style.animationDelay = `${idx * 50}ms`;
    card.innerHTML = `
        <div class="scr-top">
          <div class="scr-rank">#${c.rank}</div>
          <div class="scr-title">
            <div class="scr-tk-row">
              <span class="scr-ticker" data-live="${esc(c.ticker)}">${esc(c.ticker)}</span>
              <span class="scr-status ${cls}">${stLabel}</span>
              ${whyNowBadge(c)}
              ${tierHtml}
              ${toneChip(c.ticker)}
              ${attnChip(c.ticker)}
            </div>
            <div class="scr-company">${esc(c.company || c.ticker)}${c.sector ? ` · ${esc(c.sector)}` : ''}${c.exchange ? ` · ${esc(c.exchange)}` : ''}${c.theme ? ` · <span class="scr-theme">${esc(c.theme)}</span>` : ''}</div>
          </div>
          <div class="scr-score-col">
            <div class="scr-score${c._downgraded ? ' downgraded' : ''}">${L('score', score + '<small>/100 Q</small>')}</div>
            ${c._downgraded === 'bear' ? `<div class="scr-bear-tag" title="Bearish regime: long breakout score downgraded ${Math.round((1 - REGIME_PENALTY) * 100)}%">⚠ bear −${Math.round((1 - REGIME_PENALTY) * 100)}%</div>` : c._downgraded === 'chop' ? `<div class="scr-bear-tag" style="color:var(--cyan);background:var(--cyan-dim);border-color:#06c4d444" title="Choppy tape: breakout score downgraded ${Math.round((1 - CHOP_PENALTY) * 100)}%">🌊 chop −${Math.round((1 - CHOP_PENALTY) * 100)}%</div>` : ''}
            <div class="scr-price" data-price>$${esc(c.price)}</div>
            <div class="scr-chg ${up ? 'up' : 'down'}" data-change>${c.changePct != null ? (up ? '▲ +' : '▼ ') + c.changePct + '%' : ''}</div>
          </div>
        </div>

        <div class="scr-criteria">${chips}</div>
        ${filtersHtml}
        ${liqHtml}
        ${tagsHtml}
        ${fundaHtml}
        ${quantHtml}
        <div class="scr-metrics">${metricsHtml}</div>
        ${levelsHtml}
        ${narrativeHtml}
        <div class="sig-reasons-static">${reasonsHtml}</div>

        ${chartToggleMarkup()}
      `;
    wireChartToggle(card, c.ticker);
    return card;
  }

  function showScrError(msg) {
    screenerContainer.innerHTML = `<div class="mom-status error"><p>${esc(msg)}</p></div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Custom Screener — Apex Runner (4-pillar, regime-adaptive model)
  // A client-side scoring layer over the existing /api/screener data: no extra
  // serverless function. Module 1 of the Apex Runner v3 spec — regime-dependent
  // weight presets with hysteresis + Risk-Off threshold tightening.
  // ══════════════════════════════════════════════════════════════════════════
  const APEX_VERSION = 'v2026.Q2';
  const APEX_PRESETS = {
    RISK_ON:  { p1: 30, p2: 25, p3: 20, p4: 25 },
    NEUTRAL:  { p1: 25, p2: 25, p3: 27, p4: 23 },
    RISK_OFF: { p1: 20, p2: 25, p3: 35, p4: 20 },
  };
  const APEX_RG_LABEL = { RISK_ON: 'Risk-On', NEUTRAL: 'Neutral', RISK_OFF: 'Risk-Off' };
  const APEX_PILLAR_LABEL = { p1: 'Momentum / RS', p2: 'Technical structure', p3: 'Fundamental acceleration', p4: 'Supply / smart money' };
  // Plain-English hovers for each scoring pillar (novice investor). w## = its weight.
  const APEX_PILLAR_HELP = {
    p1: 'Momentum / Relative Strength — is the stock outrunning the market lately? Higher = stronger recent trend. (w## is how much this counts toward the score.)',
    p2: 'Technical structure — how clean the chart setup is (above key moving averages, orderly base). Higher = healthier chart.',
    p3: 'Fundamental acceleration — are revenue and earnings growth speeding up, not just positive? Higher = improving business.',
    p4: 'Supply / smart money — accumulation and buying pressure vs selling. Higher = big money leaning in.',
  };
  const APEX_KEYS = ['p1', 'p2', 'p3', 'p4'];

  let apexLoaded = false, apexState = null, apexLast = null, apexDrift = null, apexModel = null;

  // Active weights for a regime: a live Module 2 recalibration overrides the
  // static Module 1 preset when present.
  function activeWeightsFor(regime) {
    return (apexModel && apexModel.weights && apexModel.weights[regime]) || APEX_PRESETS[regime];
  }
  async function fetchApexModel() {
    try { const r = await fetch('/api/tracker?op=model'); apexModel = await r.json(); }
    catch { apexModel = null; }
  }
  let apexRecalMsg = '';
  // Manual Module 2 trigger (also auto-recommended when drift goes BROKEN).
  async function apexRecalibrate() {
    const btn = document.getElementById('cx-recal-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Recalibrating…'; }
    try {
      const res = await (await fetch('/api/tracker?op=recalibrate')).json();
      apexRecalMsg = res.error ? ('Error: ' + res.error)
        : res.refit ? '✅ Re-fit adopted — weights updated and applied forward.'
        : `Kept current weights — ${res.totalResolved || 0} resolved signals (need ≥40 per regime, beating preset out-of-sample).`;
      await fetchApexModel();
      runApex();          // rescore with the (possibly) new active weights
      fetchApexDrift();
    } catch { apexRecalMsg = 'Recalibration failed — please try again.'; }
    finally { if (btn) { btn.disabled = false; btn.textContent = '⟳ Recalibrate now'; } }
  }

  // Seed the ledger from ~12mo of history (technical pillars only — P3 synthetic),
  // then recalibrate on live + seed so Module 2 has data to chew on now.
  async function apexSeedHistory() {
    const btn = document.getElementById('cx-seed-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning ~12mo of history…'; }
    try {
      const bf = await (await fetch('/api/tracker?op=backfill')).json();
      if (!bf.ok) { apexRecalMsg = 'Backfill failed: ' + (bf.error || 'error'); }
      else {
        const st = bf.stats || {};
        const res = await (await fetch('/api/tracker?op=recalibrate&source=all')).json();
        apexRecalMsg = `Seeded ${st.signals || 0} historical signals across ${st.datesUsed || 0} dates. `
          + (res.refit ? '✅ Re-fit adopted from the seed (technical pillars only — P3 held neutral).'
                       : 'Kept presets — the seed didn’t beat them under walk-forward CV.');
      }
      await fetchApexModel();
      runApex();
      fetchApexDrift();
    } catch { apexRecalMsg = 'Seeding failed — please try again.'; }
    finally { if (btn) { btn.disabled = false; btn.textContent = '🌱 Seed from history'; } }
  }

  function apexRecalPanelHTML() {
    const m = apexModel, lastRun = m && m.lastRun;
    const flags = (m && m.active && m.active.ablationFlags) || [];
    const rows = ['RISK_ON', 'NEUTRAL', 'RISK_OFF'].map(R => {
      const w = activeWeightsFor(R), p = APEX_PRESETS[R];
      const changed = w.p1 !== p.p1 || w.p2 !== p.p2 || w.p3 !== p.p3 || w.p4 !== p.p4;
      return `<tr><td>${APEX_RG_LABEL[R]}</td><td>${p.p1}/${p.p2}/${p.p3}/${p.p4}</td><td class="${changed ? 'active' : ''}">${w.p1}/${w.p2}/${w.p3}/${w.p4}${changed ? '' : ' ='}</td></tr>`;
    }).join('');
    const lastTxt = lastRun
      ? `Last run ${new Date(lastRun.at).toLocaleDateString()} — ${lastRun.fittedAny ? 'weights updated' : 'kept presets'} (${lastRun.resolved} resolved). ` +
        Object.entries(lastRun.perRegime || {}).map(([R, d]) => `${APEX_RG_LABEL[R]} ${d.n}${d.fitted ? '✓' : ''}`).join(' · ')
      : 'No recalibration has run on this store yet.';
    const flagsHtml = flags.length
      ? `<p class="cx-mp-p" style="color:var(--amber)">⚠ ${flags.map(f => `${APEX_RG_LABEL[f.regime]} · ${esc(f.label)}: ${esc(f.note)}`).join('<br>')}</p>` : '';
    const msg = apexRecalMsg ? `<p class="cx-mp-p" style="color:var(--green)">${esc(apexRecalMsg)}</p>` : '';
    const bf = m && m.backfill;
    const seedTxt = bf
      ? `<p class="cx-mp-p" style="color:#06c4d4">🌱 History seed: ${bf.signals} reconstructed signals${bf.generatedAt ? ` (built ${new Date(bf.generatedAt).toLocaleDateString()})` : ''} — technical pillars only, Pillar 3 held neutral.</p>`
      : '';
    return `<div class="cx-mp-sec">
      <h4>Walk-forward re-optimization (Module 2)</h4>
      <p class="cx-mp-p">A coarse grid search (±10 pts from each preset, 5-pt steps) on the trailing signal ledger, maximizing Apex+Loaded profit factor — adopted only if it beats the preset on a held-out 8-week out-of-sample window, and only with ≥40 resolved signals per regime. Anti-overfit by construction; intentionally dormant until the ledger matures.</p>
      <table class="cx-preset-table"><thead><tr><th>Regime</th><th>Preset</th><th>Active</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="cx-mp-p" style="margin-top:7px">${esc(lastTxt)}</p>
      ${seedTxt}${flagsHtml}${msg}
      <button class="refresh-btn" id="cx-recal-btn" onclick="apexRecalibrate()" style="color:#f0a832">⟳ Recalibrate now</button>
      <button class="refresh-btn" id="cx-seed-btn" onclick="apexSeedHistory()" style="color:#06c4d4">🌱 Seed from history</button>
    </div>`;
  }

  // Exit-strategy evidence — which exit makes the momentum edge profitable.
  function apexExitsPanelHTML() {
    const ex = apexModel && apexModel.exits;
    if (!ex || !ex.summary) {
      return `<div class="cx-mp-sec"><h4>Exit strategy (backtested)</h4><p class="cx-mp-p">Research finding: the screener's structure stops historically <b>erode</b> these momentum setups — they get whipsawed before the ~3-month directional edge plays out. Run the study to compare exit rules on the historical Apex/Loaded selections.</p><button class="refresh-btn" id="cx-exits-btn" onclick="apexRunExits()" style="color:#06c4d4">⏱ Run exit study (~10s)</button></div>`;
    }
    const s = ex.summary;
    const order = ['time63', 'catastrophic', 'atr3', 'structure', 'time21', 'atr2', 'trail3ATR', 'ema21'];
    const label = { time63: 'Hold ~63d · no stop', time21: 'Hold ~21d · no stop', catastrophic: 'Measured target · −15% stop only', atr3: '3×ATR stop & target', atr2: '2×ATR stop & target', trail3ATR: '3×ATR chandelier trail', ema21: 'Exit on EMA-21 cross', structure: 'Structure stop (current)' };
    const rows = order.filter(k => s[k] && s[k].n).map(k => {
      const a = s[k], best = k === 'time63', cur = k === 'structure';
      return `<tr class="${best ? 'cx-ex-best' : ''}"><td>${label[k] || k}</td><td class="${a.profitFactor >= 1 ? 'cx-ex-pos' : 'cx-ex-neg'}">${a.profitFactor}</td><td>${a.winRate}%</td><td class="${a.expectancyPct >= 0 ? 'cx-ex-pos' : 'cx-ex-neg'}">${a.expectancyPct > 0 ? '+' : ''}${a.expectancyPct}%</td><td>${a.avgHold}d</td></tr>`;
    }).join('');
    const t = s.time63, st = s.structure;
    // Regime breakdown — the honest part (out-of-sample across a real bear market).
    const rg = ex.byRegime;
    const rgRow = (R, lbl) => {
      const x = rg && rg[R];
      if (!x || !x.time63 || !x.structure) return ''; // some regimes lack a full exit breakdown — skip rather than throw
      const pf = x.time63.pf;
      return `<tr><td>${lbl}</td><td class="${pf >= 1 ? 'cx-ex-pos' : 'cx-ex-neg'}">${pf}</td><td class="${x.structure.pf >= 1 ? 'cx-ex-pos' : 'cx-ex-neg'}">${x.structure.pf}</td><td>${x.time63.exp > 0 ? '+' : ''}${x.time63.exp}%</td><td>${x.time63.n}</td></tr>`;
    };
    const rgRows = rg ? rgRow('RISK_ON', 'Risk-On') + rgRow('NEUTRAL', 'Neutral') + rgRow('RISK_OFF', 'Risk-Off') : '';
    const rgTable = rgRows ? `<table class="cx-preset-table cx-ex-table"><thead><tr><th>Entry regime</th><th>time63 PF</th><th>struct PF</th><th>time63 exp</th><th>n</th></tr></thead><tbody>${rgRows}</tbody></table>` : '';
    const qP = ex.quartersProfitable, qT = ex.quartersTotal;
    const rec = (t && st) ? `<p class="cx-mp-p"><b style="color:var(--amber)">Honest finding (out-of-sample, 5y incl. the 2022 bear):</b> the structure stops <b>are</b> a leak — a time-based hold beats them almost everywhere (PF ${t.profitFactor} vs ${st.profitFactor}) — but fixing the exit does <b>not</b> create edge. Held over the full cycle, even the best exit is below breakeven (time63 PF <b>${t.profitFactor}</b>)${qP != null ? `, profitable in only <b>${qP} of ${qT}</b> quarters` : ''}. It wins in sustained uptrends and is destroyed in corrections — i.e. it's largely <b>regime timing, not a standalone edge</b>.</p>` : '';
    const verdict = rg ? `<p class="cx-mp-p"><b>What to actually do:</b> only take these long momentum setups in <b style="color:var(--green)">Risk-On</b> (Risk-Off entries are a disaster — time63 PF ${rg.RISK_OFF && rg.RISK_OFF.time63 ? rg.RISK_OFF.time63.pf : '~0.5'}); hold ~63 sessions (stops make it worse); and accept the edge is thin and disappears in choppy/correcting periods. The model's regime gate is doing the real work, not the exit.</p>` : '';
    // Market-neutral (long top decile / short bottom) — is there any selection edge?
    const ls = apexModel && apexModel.longshort && apexModel.longshort.decile;
    const lsLine = ls ? `<p class="cx-mp-p"><b>Market-neutral test</b> (long top decile / short bottom, beta removed): spread <b>${ls.overall.meanPct > 0 ? '+' : ''}${ls.overall.meanPct}%</b>/63d but <b>t-stat ${ls.overall.tStat}</b> — ${Math.abs(ls.overall.tStat) >= 2 ? 'significant' : 'not statistically significant (need t≥2)'}. Still regime-split: Risk-On ${ls.byRegime && ls.byRegime.RISK_ON ? ls.byRegime.RISK_ON.meanPct + '%' : '—'} vs Risk-Off <b style="color:var(--red)">${ls.byRegime && ls.byRegime.RISK_OFF ? ls.byRegime.RISK_OFF.meanPct + '%' : '—'}</b> (momentum crash). <b>No durable security-selection edge</b> once the market is removed — what's here is a momentum tilt, not stock-picking skill.</p>` : `<p class="cx-mp-p" style="font-size:0.62rem"><button class="refresh-btn" onclick="fetch('/api/tracker?op=longshort').then(()=>fetchApexModel()).then(()=>{if(apexLast)renderApexModelPanel(apexLast.regime,apexLast.preset,apexLast.large)})" style="color:#8a6dff">⚖ Run market-neutral (long/short) test</button></p>`;
    return `<div class="cx-mp-sec"><h4>Exit strategy (backtested · ${ex.selections} selections · ${ex.range || '5y'})</h4>${rec}
      <table class="cx-preset-table cx-ex-table"><thead><tr><th>Exit rule</th><th>PF</th><th>Win</th><th>Expect</th><th>Hold</th></tr></thead><tbody>${rows}</tbody></table>
      ${rgTable ? `<p class="cx-mp-p" style="margin-top:8px"><b>By entry regime</b> — the edge is entirely regime-conditional:</p>${rgTable}` : ''}
      ${verdict}
      ${lsLine}
      <p class="cx-mp-p" style="font-size:0.62rem">PF>1 = net-profitable. No-stop carries full per-name drawdown risk; the −15% catastrophic variant is the risk-managed compromise. In-sample backtest — directional, not a guarantee.</p>
      <button class="refresh-btn" id="cx-exits-btn" onclick="apexRunExits()" style="color:#06c4d4">↻ Re-run exit study</button></div>`;
  }
  async function apexRunExits() {
    const btn = document.getElementById('cx-exits-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏱ Running… (~10s)'; }
    try { await fetch('/api/tracker?op=exits'); await fetchApexModel(); if (apexLast) renderApexModelPanel(apexLast.regime, apexLast.preset, apexLast.large); }
    catch {}
    finally { if (btn) { btn.disabled = false; btn.textContent = '↻ Re-run exit study'; } }
  }

  // Post-earnings-drift — the most promising lead (but data-limited).
  function apexPeadPanelHTML() {
    const p = apexModel && apexModel.pead;
    if (!p || !p.h63) {
      return `<div class="cx-mp-sec"><h4>Earnings-surprise drift (PEAD)</h4><p class="cx-mp-p">Event-driven test: does a big earnings beat/miss predict the next 1–3 months of <i>market-excess</i> return? Needs a paid earnings feed.</p><button class="refresh-btn" onclick="fetch('/api/tracker?op=pead').then(()=>fetchApexModel()).then(()=>{if(apexLast)renderApexModelPanel(apexLast.regime,apexLast.preset,apexLast.large)})" style="color:#10d98a">📊 Run PEAD study</button></div>`;
    }
    const m63 = p.h63.bottomQuintileExcess, b21 = (p.h21 || {}).topQuintileExcess || {};
    const v = p.validation5y;
    // Lead with the 5-year verdict if we have it — it overrides the 1-year hint.
    const verdict = v
      ? `<p class="cx-mp-p"><b style="color:var(--red)">5-year validation: not confirmed.</b> Over ${v.events} events incl. the 2022 bear, the earnings-reaction drift is statistically zero (signed t-stat <b>${v.signed63.tStat}</b> at 63d), and the biggest reactions actually <b>reverse</b> (top quintile ${v.top63.meanPct}%, t ${v.top63.tStat}). By year, only ${v.byYear63 ? Object.entries(v.byYear63).filter(([, x]) => x.tStat >= 2).map(([y]) => y).join(', ') || 'one recent year' : 'one recent year'} showed it. The 1-year t-stat below was the <b>risk-on-window artifact</b> — same trap as the exit study. <b>No durable PEAD edge in this data.</b></p>`
      : `<p class="cx-mp-p" style="color:var(--amber)"><b>⚠ Lead, not confirmed:</b> the surprise-data plan only covers ~12 months — run the 5-year reaction validation (button) before trusting it.</p>`;
    return `<div class="cx-mp-sec"><h4>Earnings-surprise drift (PEAD)</h4>
      ${verdict}
      <p class="cx-mp-p" style="font-size:0.66rem">1-year surprise study (${p.resolvedEvents} events, ${p.coverage ? p.coverage.earliest + '→' + p.coverage.latest : ''}): misses ${m63.meanPct}% / 63d (t ${m63.tStat}); beats ${b21.meanPct != null ? '+' + b21.meanPct + '%/21d (t ' + b21.tStat + ')' : '—'}. Significant in-sample, but the 5-year test above shows it doesn't persist.</p>
      <button class="refresh-btn" onclick="fetch('/api/tracker?op=pead&mode=reaction&limit=150').then(()=>fetchApexModel()).then(()=>{if(apexLast)renderApexModelPanel(apexLast.regime,apexLast.preset,apexLast.large)})" style="color:#10d98a">↻ Re-run 5y validation</button></div>`;
  }

  function apexNarrativePanelHTML() {
    const nar = (apexModel && apexModel.narrative) || (apexDrift && apexDrift.narrative);
    const breakdown = apexDrift && apexDrift.narrativeBreakdown;
    const cur = nar
      ? `<p class="cx-mp-p">This week's dominant narrative: <b>${esc(nar.label || nar.tag)}</b> <span style="color:var(--text-dim)">(${esc(nar.tag)})</span>. ${esc(nar.summary || '')}</p>`
      : `<p class="cx-mp-p">No narrative snapshot yet — Claude tags it weekly from the news feed and stamps every logged signal.</p>`;
    const table = (breakdown && breakdown.length)
      ? `<p class="cx-mp-p" style="margin-top:7px">Win rate by narrative tag — observational; promoted to a scoring input only once a tag has ≥30 resolved signals (✓):</p>
         <table class="cx-preset-table"><thead><tr><th>Tag</th><th>Signals</th><th>Win rate</th></tr></thead><tbody>${breakdown.map(b => `<tr><td>${esc(b.tag)}</td><td>${b.n}${b.significant ? ' ✓' : ''}</td><td class="${b.significant ? 'active' : ''}">${b.winRate}%</td></tr>`).join('')}</tbody></table>`
      : '';
    return `<div class="cx-mp-sec"><h4>Market narrative (sentiment layer)</h4>${cur}${table}</div>`;
  }

  // 3-state regime from the screener's binary read.
  function apexRawRegime(rg) {
    if (!rg) return 'NEUTRAL';
    if (rg.bearish) return 'RISK_OFF';
    if (rg.riskOn) return 'RISK_ON';
    return 'NEUTRAL';
  }

  // Hysteresis: a new regime must hold 3 consecutive refreshes before the
  // active preset switches (prevents weight-flapping on choppy weeks).
  // Beyond this age the last read is stale — the tab was closed long enough that
  // the market has moved on, so there's nothing live to debounce against and a
  // persisted regime must NOT strand the tab (e.g. a day-old RISK_OFF latch).
  const APEX_REGIME_STALE_MS = 12 * 60 * 60 * 1000; // 12h
  function apexLoadState() {
    try { const s = JSON.parse(localStorage.getItem('apexRegime')); if (s && s.active) return s; } catch {}
    return { active: 'NEUTRAL', candidate: null, count: 0, log: [], at: 0 };
  }
  function apexAdvanceState(raw) {
    const st = apexLoadState();
    // Self-heal a stale latch: if the last observation is old (or predates this
    // field entirely), re-sync straight to the live read rather than debouncing
    // against an obsolete regime. This is what stops a stale RISK_OFF from
    // silently emptying the tab across sessions.
    const age = st.at ? Date.now() - st.at : Infinity;
    if (age > APEX_REGIME_STALE_MS && raw !== st.active) {
      st.log = [{ from: st.active, to: raw, at: new Date().toISOString(), resync: true }, ...(st.log || [])].slice(0, 12);
      st.active = raw; st.candidate = null; st.count = 0;
    } else if (raw === st.active) { st.candidate = null; st.count = 0; }
    else if (raw === st.candidate) {
      st.count++;
      if (st.count >= 3) {
        st.log = [{ from: st.active, to: raw, at: new Date().toISOString() }, ...(st.log || [])].slice(0, 12);
        st.active = raw; st.candidate = null; st.count = 0;
      }
    } else { st.candidate = raw; st.count = 1; }
    st.at = Date.now();
    try { localStorage.setItem('apexRegime', JSON.stringify(st)); } catch {}
    return st;
  }

  // Map a screener candidate's percentiles + fundamentals onto the 4 pillars.
  // Hard-fundamental score (0-100) — kept identical to lib/apex.js fundamentalScore.
  function apexFundamentalScore(fd) {
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    let s = 50;
    if (fd.revGrowth != null) s += clamp(fd.revGrowth * 0.8, -25, 28);
    if (fd.epsGrowth != null) s += clamp(fd.epsGrowth * 0.4, -20, 20);
    if (fd.revAccel != null) s += clamp(fd.revAccel * 0.5, -10, 12);
    if (fd.epsAccel != null) s += clamp(fd.epsAccel * 0.25, -8, 8);
    if (fd.marginExpanding === true) s += 10; else if (fd.marginExpanding === false) s -= 5;
    if (fd.netMargin != null) s += clamp(fd.netMargin * 0.4, -10, 8);
    return Math.max(0, Math.min(100, Math.round(s)));
  }
  function apexPillars(c) {
    const q = c.pct || {};
    const p1 = Math.round(((q.rs || 0) + (q.mom || 0)) / 2);                       // momentum / relative strength
    const p2 = Math.round(((q.trend || 0) + (q.base || 0) + (q.prox || 0)) / 3);   // trend + base + pivot proximity
    // Pillar 4 — accumulation + up/down volume (real edge) over dead volume-surge.
    const p4 = (q.accum != null || q.ud != null)
      ? Math.round(((q.accum || 0) + (q.ud || 0) + (q.volAdj || 0)) / 3)
      : Math.round(((q.vol || 0) + (q.volAdj || 0)) / 2);
    // Pillar 3 — hard fundamentals lead; LLM narrative is a 40% overlay.
    const narr = c.narrativeStrength != null ? Math.round((c.narrativeStrength / 10) * 100) : null;
    const fund = c.fundamentals ? apexFundamentalScore(c.fundamentals) : null;
    const p3 = (fund != null && narr != null) ? Math.round(0.6 * fund + 0.4 * narr)
             : fund != null ? fund
             : narr != null ? narr
             : 45;
    return { p1, p2, p3, p4 };
  }
  function apexComposite(pl, preset) {
    const sum = preset.p1 + preset.p2 + preset.p3 + preset.p4;
    return Math.round((pl.p1 * preset.p1 + pl.p2 * preset.p2 + pl.p3 * preset.p3 + pl.p4 * preset.p4) / sum);
  }
  // Balance rule: Apex requires no weak pillar AND a confirmed setup. Mirrors
  // lib/apex.js tierOf (keep in sync). Regime gate: in RISK_OFF the breakout edge
  // inverts (the app's one durable finding), so cap actionable tiers at 'watch' —
  // no new apex/loaded LONGS in risk-off, matching the conviction sleeve's gate.
  function apexTier(score, pl, c, regime) {
    const minP = Math.min(pl.p1, pl.p2, pl.p3, pl.p4);
    const confirmed = c.status === 'Breakout' || c.status === 'Early';
    let tier = null;
    if (score >= 72 && minP >= 45 && confirmed) tier = 'apex';
    else if (score >= 58 && minP >= 35) tier = 'loaded';
    else if (score >= 45) tier = 'watch';
    if (regime === 'RISK_OFF' && (tier === 'apex' || tier === 'loaded')) tier = 'watch';
    return tier;
  }
  // Risk-Off threshold tightening: raise the liquidity floor to 2× the base $2M
  // so only genuinely tradeable names survive. The old volSurge≥2.0 gate was
  // REMOVED — volume-surge is a confirmed-dead factor here (this app's own
  // research found rank-IC ≈ −0.004), and in a calm low-vol tape it stripped
  // EVERY candidate (max volSurge ~1.5), silently emptying the tab.
  const APEX_RISKOFF_MIN_DOLLARVOL = 4000000;
  function apexRegimeFilter(list, regime) {
    if (regime !== 'RISK_OFF') return list;
    return list.filter(c => {
      const dv = c.factors && c.factors.dollarVol;
      if (dv != null && dv < APEX_RISKOFF_MIN_DOLLARVOL) return false;
      return true;
    });
  }

  async function fetchApexScope(scope) {
    try { const r = await fetch('/api/screener?scope=' + scope); return await r.json(); }
    catch { return { error: 'fetch failed' }; }
  }

  function ensureCustom() { if (!apexLoaded) { apexLoaded = true; fetchApexModel().then(() => { runApex(); fetchApexDrift(); }); } }

  // Module 3 — live drift detection. Fetched alongside the model; refreshes the
  // health badge, banner, and the Model-panel health section when it returns.
  async function fetchApexDrift() {
    try { const r = await fetch('/api/tracker?op=drift'); apexDrift = await r.json(); }
    catch { apexDrift = null; }
    renderApexHealthBanner();
    if (apexLast) { renderApexStrip(apexLast.regime, apexLast.preset, apexLast.raw); renderApexModelPanel(apexLast.regime, apexLast.preset, apexLast.large); }
  }

  function apexHealthChip() {
    const d = apexDrift;
    if (!d || !d.configured) return '';
    const st = d.status || 'PENDING';
    if (st === 'PENDING') return `<span class="cx-health pending"><span class="cx-dot"></span>Health pending · ${d.resolvedCount || 0}/${d.minSignals || 15} resolved</span>`;
    const label = { HEALTHY: 'Model healthy', DEGRADING: 'Model trailing backtest', BROKEN: 'Edge not confirmed' }[st];
    const cmp = d.live && d.baseline && d.baseline.winRate != null ? ` · ${d.live.winRate}% vs ${d.baseline.winRate}% base` : '';
    return `<span class="cx-health ${st.toLowerCase()}" title="Live win rate vs backtest baseline over the resolved-signal window"><span class="cx-dot"></span>${label}${cmp}</span>`;
  }

  function renderApexHealthBanner() {
    const el = document.getElementById('custom-health-banner');
    if (!el) return;
    const d = apexDrift;
    if (!d || !d.configured || d.status === 'HEALTHY' || d.status === 'PENDING') { el.innerHTML = ''; return; }
    if (d.status === 'DEGRADING') {
      el.innerHTML = `<div class="regime-banner" style="border-left-color:var(--amber);border-color:#f0a83266;background:var(--amber-dim)"><span class="rb-ic">⚠️</span><div class="rb-body"><b style="color:var(--amber)">Model trailing its backtest — reduce size.</b> Live win rate ${d.live.winRate}% vs ${d.baseline.winRate}% baseline over ${d.windowCount} resolved signals. The edge is softening; trade smaller until it recovers.</div></div>`;
    } else if (d.status === 'BROKEN') {
      el.innerHTML = `<div class="regime-banner"><span class="rb-ic">🛑</span><div class="rb-body"><b>Edge not confirmed in the current market — signals informational only.</b> Live win rate ${d.live.winRate}% vs ${d.baseline.winRate}% baseline. Recalibration is recommended (Module 2 — not yet enabled).</div></div>`;
    }
  }

  function apexHealthPanelHTML() {
    const d = apexDrift;
    if (!d || !d.configured) return `<div class="cx-mp-sec"><h4>Live drift detection (Module 3)</h4><p class="cx-mp-p">The signal ledger isn't active yet (Blob storage not configured), so live health can't be measured. Once provisioned, every Apex/Loaded signal is logged daily and auto-resolved by the price feed.</p></div>`;
    const st = d.status || 'PENDING';
    const stLabel = { HEALTHY: 'Healthy', DEGRADING: 'Degrading', BROKEN: 'Broken', PENDING: 'Pending' }[st];
    const live = d.live || {}, base = d.baseline || {};
    const body = (st === 'PENDING' && !d.windowCount)
      ? `<p class="cx-mp-p">${esc(d.note || `Gathering signals — ${d.resolvedCount || 0}/${d.minSignals || 15} resolved before the model is judged. The ledger fills as the daily cron runs.`)}</p>`
      : `<p class="cx-mp-p">Status: <b class="cx-health-txt ${st.toLowerCase()}">${stLabel}</b> · ${d.windowCount} resolved signals (${d.windowMode === 'all-resolved' ? 'all-time' : 'trailing 60d'}), ${d.openCount} still open.</p>
         <table class="cx-preset-table"><thead><tr><th>Metric</th><th>Live</th><th>Backtest</th></tr></thead><tbody>
         <tr><td>Win rate</td><td class="active">${live.winRate}% ${live.winRateCI ? `<span style="color:var(--text-dim);font-weight:600">[${live.winRateCI.lo}–${live.winRateCI.hi}]</span>` : ''}</td><td>${base.winRate != null ? base.winRate + '%' : '—'}</td></tr>
         <tr><td>Profit factor</td><td class="active">${live.profitFactor}</td><td>${base.profitFactor != null ? base.profitFactor : '—'}</td></tr>
         <tr><td>Win / Loss / Expired</td><td class="active">${live.wins}/${live.losses}/${live.expired}</td><td>—</td></tr>
         </tbody></table>
         <p class="cx-mp-p" style="margin-top:7px">Baseline: ${esc(base.source || '—')}. A signal resolves <b>WIN</b> at +20% (before −8%), <b>LOSS</b> at −8% first, <b>EXPIRED</b> if neither hits within 63 sessions. The win rate's ${live.winRateCI ? live.winRateCI.level : 90}% confidence interval is shown in brackets. <b>Broken</b> (auto-recalibrates) requires the interval's <b>upper bound</b> below baseline−15 — so a small, noisy sample can't trip a false alarm; <b>Degrading</b> (a soft "reduce size" heads-up) warns earlier off the point estimate below baseline−5. Needs ≥15 resolved.</p>`;
    const forensics = (d.forensics && d.forensics.length)
      ? `<p class="cx-mp-p" style="margin-top:9px"><b>Where the losses came from</b> — ${d.failCount} losing signals grouped by dominant pillar:</p>
         <table class="cx-preset-table"><tbody>${d.forensics.map(f => `<tr><td>${esc(f.label)}</td><td>${f.count}</td><td>${f.pct}%</td></tr>`).join('')}</tbody></table>`
      : '';
    return `<div class="cx-mp-sec"><h4>Live drift detection (Module 3)</h4>${body}${forensics}</div>`;
  }

  async function runApex() {
    const scopeSel = document.getElementById('cx-scope').value;
    const container = document.getElementById('custom-container');
    const btn = document.getElementById('custom-refresh-btn');
    container.innerHTML = skeletonGrid(6);
    btn.disabled = true;
    try {
      // Large is always fetched — it carries the market-regime read.
      // 'all' now includes the free full-market 'expanded' scope.
      const fetchScopes = scopeSel === 'all' ? ['large', 'small', 'micro', 'expanded']
        : scopeSel === 'large' ? ['large'] : ['large', scopeSel];
      const datas = await Promise.all(fetchScopes.map(fetchApexScope));
      const byScope = {}; fetchScopes.forEach((s, i) => byScope[s] = datas[i]);
      const large = byScope.large;
      if (!large || large.error) {
        container.innerHTML = `<div class="mom-status error"><p>${esc((large && large.error) || 'Screener unavailable')}</p></div>`;
        return;
      }

      apexState = apexAdvanceState(apexRawRegime(large.regime));
      const regime = apexState.active, preset = activeWeightsFor(regime);

      const wanted = scopeSel === 'all' ? ['large', 'small', 'micro', 'expanded'] : [scopeSel];
      let cands = [];
      wanted.forEach(s => { const d = byScope[s]; if (d && Array.isArray(d.results)) cands.push(...d.results.map(c => ({ ...c, _scope: s }))); });
      cands = apexRegimeFilter(cands, regime);
      cands.forEach(c => { c._pl = apexPillars(c); c._apex = apexComposite(c._pl, preset); c._tier = apexTier(c._apex, c._pl, c, regime); });

      const seen = {}, deduped = [];
      cands.filter(c => c._tier).sort((a, b) => b._apex - a._apex).forEach(c => { if (!seen[c.ticker]) { seen[c.ticker] = 1; deduped.push(c); } });

      apexLast = { list: deduped, regime, preset, raw: apexRawRegime(large.regime), large };
      renderApex(apexLast);
      apexCheckNewApex(deduped); // notify on names that just entered the Apex tier
      const gt = document.getElementById('custom-gen-time');
      if (large.generatedAt) gt.textContent = `Updated ${new Date(large.generatedAt).toLocaleTimeString()}`;
      document.getElementById('custom-meta').textContent = `· ${deduped.length} names scored · ${APEX_RG_LABEL[regime]} preset · 4-pillar regime-adaptive`;
    } catch (err) {
      // Surface the real failure instead of swallowing it — a blank "try again"
      // told us nothing across several debugging rounds.
      console.error('[Apex] runApex failed:', err);
      const detail = (err && (err.message || err.name)) ? esc(String(err.message || err.name)) : 'unknown error';
      container.innerHTML = `<div class="mom-status error"><p>Could not run the Apex model — <b>${detail}</b>. Please screenshot this and reload.</p></div>`;
    } finally { btn.disabled = false; }
  }

  function renderApex(snap) {
    const { list, regime, preset, raw, large } = snap;
    renderApexStrip(regime, preset, raw);
    renderApexModelPanel(regime, preset, large);

    const container = document.getElementById('custom-container');
    const tierFilter = document.getElementById('cx-tier').value;
    let show = list;
    if (tierFilter === 'apex') show = list.filter(c => c._tier === 'apex');
    else if (tierFilter === 'loaded') show = list.filter(c => c._tier !== 'watch');

    if (!show.length) {
      const why = regime === 'RISK_OFF'
        ? ' — the breakout edge inverts in risk-off, so no new Apex/Loaded longs are surfaced (tiers are capped at Watch) and the liquidity floor tightens, by design'
        : '';
      // Don't strand the user on a stale latched regime: if the live market has
      // already flipped, say so and point at the refresh that advances hysteresis.
      const flipping = raw !== regime
        ? ` The market is now reading <b>${APEX_RG_LABEL[raw]}</b> — the regime is confirming (${apexState.count}/3 refreshes); hit ↻ Refresh a couple more times and picks return.`
        : '';
      container.innerHTML = `<div class="mom-status"><p>No names cleared the Apex model in the <b>${APEX_RG_LABEL[regime]}</b> regime${why}.${flipping} Try a broader scope or a looser tier filter.</p></div>`;
      return;
    }
    const groups = [
      ['apex', '🏆 Apex', 'Balanced strength across all four pillars + confirmed setup'],
      ['loaded', '🔥 Loaded', 'High composite — a clear edge, one pillar may lag'],
      ['watch', '👁 Watch', 'On the radar — building, not yet confirmed'],
    ];
    container.innerHTML = '';
    if (regime === 'RISK_OFF') {
      const rb = document.createElement('div');
      rb.className = 'regime-banner';
      rb.innerHTML = `<span class="rb-ic">🛑</span><div class="rb-body"><b>Risk-off regime — no new Apex/Loaded longs.</b> The breakout edge inverts in risk-off (the app's one durable, backtested finding), so actionable tiers are capped at Watch. Names below are informational only.</div>`;
      container.appendChild(rb);
    }
    container.appendChild(buildApexPortfolio(list)); // Apex+Loaded exposure + sizing (ignores tier filter)
    groups.forEach(([tier, name, sub]) => {
      const items = show.filter(c => c._tier === tier);
      if (!items.length) return;
      const head = document.createElement('div');
      head.className = 'cx-tier-head ' + tier;
      head.innerHTML = `<span class="cx-tier-name">${name}</span><span class="cx-tier-sub">${items.length} · ${sub}</span>`;
      container.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'scr-grid';
      items.forEach((c, i) => grid.appendChild(buildApexCard(c, preset, i)));
      container.appendChild(grid);
    });
    attachTimingLights(container, show.map(c => ({ ticker: c.ticker, stop: c.levels && c.levels.stop, target: c.levels && (c.levels.resistance ?? c.levels.target), trigger: c.levels && c.levels.entry })), 'custom');
  }

  // ── Portfolio exposure + equal-risk position sizing ────────────────────────
  function apexPortfolioSettings() {
    return {
      pv: parseFloat(localStorage.getItem('apexPortfolio')) || 100000,
      rk: parseFloat(localStorage.getItem('apexRiskPct')) || 1,
    };
  }
  function buildApexPortfolio(list) {
    const names = list.filter(c => c._tier === 'apex' || c._tier === 'loaded');
    const el = document.createElement('div');
    el.className = 'cx-portfolio';
    if (!names.length) return el;
    const { pv, rk } = apexPortfolioSettings();

    // Sector exposure + concentration check.
    const bySec = {};
    names.forEach(c => { const s = c.sector || 'Other'; bySec[s] = (bySec[s] || 0) + 1; });
    const secs = Object.entries(bySec).sort((a, b) => b[1] - a[1]);
    const maxShare = secs[0][1] / names.length;
    const secBars = secs.map(([s, n]) => {
      const pct = Math.round((n / names.length) * 100);
      return `<div class="cx-pf-sec"><span>${esc(s)}</span><div class="cx-pf-bar"><div style="width:${pct}%"></div></div><b>${pct}%</b></div>`;
    }).join('');

    // Equal-risk sizing: each position risks the same $ (portfolio × risk%), via
    // its entry−stop distance, capped at 20% of the portfolio per name.
    const riskBudget = pv * (rk / 100);
    const apexN = names.filter(c => c._tier === 'apex').length;
    const rrs = names.map(c => c.levels && c.levels.rr).filter(v => v != null);
    const avgRR = rrs.length ? (rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(1) : '—';
    const rows = names.slice(0, 15).map(c => {
      const lv = c.levels || {}, entry = lv.entry || c.price, stop = lv.stop;
      const rps = (entry && stop && entry > stop) ? entry - stop : null;
      let shares = null, alloc = null;
      if (rps) { shares = Math.floor(riskBudget / rps); alloc = shares * entry; if (alloc > pv * 0.2) { alloc = pv * 0.2; shares = Math.floor(alloc / entry); } }
      return `<tr><td>${esc(c.ticker)} <span class="cx-tierbadge ${c._tier}" style="font-size:0.48rem;padding:1px 4px">${c._tier}</span></td><td>$${entry ? (+entry).toFixed(2) : '—'}</td><td>$${stop ? (+stop).toFixed(2) : '—'}</td><td>${shares != null ? shares.toLocaleString() : '—'}</td><td>${alloc != null ? '$' + Math.round(alloc).toLocaleString() : '—'}</td></tr>`;
    }).join('');

    el.innerHTML = `
      <div class="cx-pf-head">📊 Portfolio · <b>${apexN}</b> Apex + <b>${names.length - apexN}</b> Loaded · avg R:R <b>${avgRR}:1</b>
        <span class="cx-pf-ctrl">Size $<input id="cx-pf-pv" type="number" value="${pv}" min="1000" step="1000"> · risk <input id="cx-pf-rk" type="number" value="${rk}" min="0.25" max="5" step="0.25">%</span>
      </div>
      ${maxShare > 0.4 ? `<div class="cx-pf-warn">⚠ Concentrated — ${Math.round(maxShare * 100)}% of names in <b>${esc(secs[0][0])}</b>. Spread risk across sectors.</div>` : ''}
      <div class="cx-pf-secs">${secBars}</div>
      <div class="cx-pf-sz-h">Equal-risk sizing · ${rk}% (<b>$${Math.round(riskBudget).toLocaleString()}</b>) risked per trade, capped 20%/name</div>
      <table class="cx-preset-table cx-pf-table"><thead><tr><th>Name</th><th>Entry</th><th>Stop</th><th>Shares</th><th>Alloc</th></tr></thead><tbody>${rows}</tbody></table>`;

    const pvI = el.querySelector('#cx-pf-pv'), rkI = el.querySelector('#cx-pf-rk');
    if (pvI) pvI.onchange = () => { localStorage.setItem('apexPortfolio', pvI.value); if (apexLast) renderApex(apexLast); };
    if (rkI) rkI.onchange = () => { localStorage.setItem('apexRiskPct', rkI.value); if (apexLast) renderApex(apexLast); };
    return el;
  }

  // ── Alert when a new name enters the Apex tier ─────────────────────────────
  function apexCheckNewApex(list) {
    const apexTickers = list.filter(c => c._tier === 'apex').map(c => c.ticker);
    let prev = null;
    try { const v = localStorage.getItem('apexSeen'); if (v != null) prev = JSON.parse(v); } catch {}
    if (Array.isArray(prev)) {                       // not the first ever load → alert on genuinely new Apex
      const seen = new Set(prev);
      list.filter(c => c._tier === 'apex' && !seen.has(c.ticker)).forEach(c => showApexNotification(c.ticker, c._apex));
    }
    try { localStorage.setItem('apexSeen', JSON.stringify(apexTickers)); } catch {}
  }
  async function showApexNotification(ticker, score) {
    if (typeof flashCards === 'function') flashCards(ticker, 'STRONG_BUY');
    if (!notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const title = `${ticker} · 🏆 New Apex`;
    const opts = {
      body: `${ticker} just entered the Apex tier${score != null ? ` (score ${score}/100)` : ''} on the Custom Screener. Tap to view.`,
      icon: '/icon.svg', badge: '/icon.svg', tag: 'apex-' + ticker, renotify: true, data: { url: '/#custom', ticker },
    };
    try { const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.ready); if (reg) await reg.showNotification(title, opts); else new Notification(title, opts); }
    catch { try { new Notification(title, opts); } catch {} }
  }

  function renderApexStrip(regime, preset, raw) {
    const el = document.getElementById('custom-strip');
    const pending = raw !== regime
      ? `<span class="cx-pending">↻ ${APEX_RG_LABEL[raw]} forming (${apexState.count}/3 refreshes)</span>` : '';
    const recal = !!(apexModel && apexModel.weights && apexModel.weights[regime]);
    const verLabel = (apexModel && apexModel.active && apexModel.active.label) || `Model ${APEX_VERSION} · base presets`;
    const nar = (apexModel && apexModel.narrative) || (apexDrift && apexDrift.narrative);
    const narChip = nar ? `<span class="cx-narrtag" title="${esc(nar.summary || '')}">🗞 ${esc(nar.label || nar.tag)}</span>` : '';
    el.innerHTML =
      `<span class="cx-badge ${regime.toLowerCase()}"><span class="cx-dot"></span>${APEX_RG_LABEL[regime]} regime</span>` +
      `<span class="cx-preset">Weights <b>${preset.p1}/${preset.p2}/${preset.p3}/${preset.p4}</b>${recal ? ' <span class="cx-recal">recalibrated</span>' : ''}</span>` +
      `<span class="cx-ver">${esc(verLabel)}</span>` + narChip + pending + apexHealthChip();
  }

  function buildApexCard(c, preset, idx) {
    const pl = c._pl, tier = c._tier;
    const up = (c.changePct ?? 0) >= 0;
    const minP = Math.min(pl.p1, pl.p2, pl.p3, pl.p4);
    const tierLabel = { apex: 'Apex', loaded: 'Loaded', watch: 'Watch' }[tier];
    const scopeTag = c._scope && c._scope !== 'large' ? ` · ${c._scope} cap` : '';

    const pill = (k, label) =>
      `<div class="cx-pill ${k}"${APEX_PILLAR_HELP[k] ? ` title="${esc(APEX_PILLAR_HELP[k])}"` : ''}><div class="cx-pill-top"><span>${label} <span class="cx-pill-wt">w${preset[k]}</span></span><b>${pl[k]}</b></div><div class="cx-pill-track"><div class="cx-pill-fill" style="width:${pl[k]}%"></div></div></div>`;

    const weakKey = APEX_KEYS.find(k => pl[k] === minP);
    const weak = minP < 45 ? `<div class="cx-weak">⚠ Weakest pillar ${minP} — ${APEX_PILLAR_LABEL[weakKey]}</div>` : '';

    const lv = c.levels || {};
    const levelsHtml = lv.entry != null
      ? `<div class="alert-targets">
          <div class="at-box"><div class="at-label">${c.status === 'Breakout' ? 'Entry' : 'Trigger'}</div><div class="at-val entry">$${lv.entry}</div></div>
          <div class="at-box"><div class="at-label">${targetLabel(lv)}</div><div class="at-val target">$${lv.resistance ?? lv.target}</div></div>
          <div class="at-box"><div class="at-label">Stop</div><div class="at-val stop">$${lv.stop}</div></div>
        </div>${rrLineHTML(lv)}` : '';

    const narr = c.narrative
      ? `<div class="cx-narrative">${esc(c.narrative)}${c.narrativeStrength != null ? ` <span class="cx-narr-str">Story ${c.narrativeStrength}/10</span>` : ''}</div>` : '';

    const card = document.createElement('div');
    card.className = `cx-card ${tier} fade-in`;
    card.dataset.ticker = c.ticker;
    card.style.animationDelay = `${idx * 45}ms`;
    card.innerHTML = `
      <div class="cx-top">
        <div>
          <div class="cx-tk-row"><span class="cx-ticker" data-live="${esc(c.ticker)}">${esc(c.ticker)}</span><span class="cx-tierbadge ${tier}">${tierLabel}</span></div>
          <div class="cx-company">${esc(c.company || c.ticker)}${c.sector ? ` · ${esc(c.sector)}` : ''}${scopeTag}${c.theme ? ` · ${esc(c.theme)}` : ''}</div>
        </div>
        <div class="cx-score-col">
          <div class="cx-score">${c._apex}<small>/100</small></div>
          <div class="cx-price">$${esc(c.price)}</div>
          <div class="cx-chg ${up ? 'up' : 'down'}">${c.changePct != null ? (up ? '▲ +' : '▼ ') + c.changePct + '%' : ''}</div>
        </div>
      </div>
      <div class="cx-pillars">
        ${pill('p1', '① Momentum/RS')}
        ${pill('p2', '② Structure')}
        ${pill('p3', '③ Fundamental')}
        ${pill('p4', '④ Smart money')}
      </div>
      ${weak}
      ${levelsHtml}
      ${narr}
      ${chartToggleMarkup()}`;
    wireChartToggle(card, c.ticker);
    return card;
  }

  function renderApexModelPanel(regime, preset, large) {
    const body = document.getElementById('cx-model-body');
    const cols = ['RISK_ON', 'NEUTRAL', 'RISK_OFF'];
    const rows = [['p1', '① Momentum / RS'], ['p2', '② Technical structure'], ['p3', '③ Fundamental acceleration'], ['p4', '④ Supply / smart money']];
    const table = `<table class="cx-preset-table"><thead><tr><th>Pillar</th>${cols.map(c => `<th class="${c === regime ? 'active' : ''}">${APEX_RG_LABEL[c]}</th>`).join('')}</tr></thead><tbody>${rows.map(([k, lb]) => `<tr><td>${lb}</td>${cols.map(c => `<td class="${c === regime ? 'active' : ''}">${APEX_PRESETS[c][k]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

    const rg = large.regime || {};
    const rgWhy = rg.indexAbove200 === true ? 'S&amp;P 500 above its 200-day average'
      : rg.indexAbove200 === false ? 'S&amp;P 500 below its 200-day average' : 'index trend unknown';
    const breadth = rg.breadthPct != null ? `, ${rg.breadthPct}% of names above their 50-day average` : '';
    const log = apexState && apexState.log || [];
    const logHtml = log.length
      ? log.map(e => `${new Date(e.at).toLocaleDateString()} ${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${APEX_RG_LABEL[e.from]} → ${APEX_RG_LABEL[e.to]}`).join('<br>')
      : 'No regime switches recorded yet on this device.';

    body.innerHTML = `
      <div class="cx-mp-sec">
        <h4>How the Apex model scores</h4>
        <p class="cx-mp-p">Every breakout candidate from the screener is graded 0–100 on four independent pillars, then blended into one composite by the active regime's weight preset. <b>Apex</b> = top composite with balanced strength across all pillars and a confirmed setup; <b>Loaded</b> = strong composite, one pillar may lag; <b>Watch</b> = building, not yet confirmed.</p>
        <p class="cx-mp-p"><b>① Momentum / RS</b> — relative strength &amp; multi-window price momentum vs peers. <b>② Technical structure</b> — trend template, base quality, proximity to pivot. <b>③ Fundamental acceleration</b> — narrative/thematic strength plus real revenue &amp; EPS growth where available. <b>④ Supply / smart money</b> — volume surge &amp; volatility-adjusted accumulation.</p>
      </div>
      <div class="cx-mp-sec">
        <h4>Regime-dependent weight presets</h4>
        <p class="cx-mp-p">Current regime: <b>${APEX_RG_LABEL[regime]}</b> — ${rgWhy}${breadth}. Risk-on tapes reward momentum &amp; squeeze mechanics; defensive tapes pay for earnings quality. A regime change must hold <b>3 consecutive refreshes</b> (hysteresis) before the preset switches — this prevents weight-flapping on choppy weeks. In Risk-Off the breakout volume gate tightens to <b>2.0×</b> and the liquidity floor doubles.</p>
        ${table}
      </div>
      ${apexPeadPanelHTML()}
      ${apexExitsPanelHTML()}
      ${apexRecalPanelHTML()}
      ${apexHealthPanelHTML()}
      ${apexNarrativePanelHTML()}
      <div class="cx-mp-sec">
        <h4>Regime switch log (this device)</h4>
        <p class="cx-log">${logHtml}</p>
      </div>
      <div class="cx-mp-sec">
        <h4>What this does NOT do</h4>
        <p class="cx-mp-p">It cannot predict regime changes — it detects and reacts with a lag of days. It reweights a fixed, inspectable pillar model; it is not a black box, and it cannot resurrect an edge the market has arbitraged away. Minimum-sample and hysteresis rules make it intentionally slow in quiet markets — by design.</p>
        <p class="cx-mp-p"><b>Survivorship bias:</b> the scan universe is today's index constituents, so the backtest/seed never see names that were delisted or removed — which modestly inflates historical win rates. A full fix needs point-in-time constituent data the current plan doesn't provide; over the ~2-year window the effect is small, but treat baseline win rates as a mild over-estimate, not gospel.</p>
      </div>`;
  }

  // Wire up the Custom Screener controls
  // How-to-use guide modal
  (() => {
    const modal = document.getElementById('cx-help-modal');
    const open = () => { modal.hidden = false; document.body.style.overflow = 'hidden'; };
    const close = () => { modal.hidden = true; document.body.style.overflow = ''; };
    document.getElementById('cx-help-btn')?.addEventListener('click', open);
    document.getElementById('cx-help-close')?.addEventListener('click', close);
    modal?.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
  })();

  // ── 📚 LEARN teaching layer — every concept in plain English (novice → expert) ──
  function renderLearn(highlight) {
    const body = document.getElementById('learn-body'); if (!body) return;
    let html = '';
    for (const g of LEARN_GROUPS) {
      html += `<div class="lrn-group-h">${g}</div>`;
      for (const [k, v] of Object.entries(LEARN)) {
        if (v.g !== g) continue;
        html += `<div class="lrn-item${k === highlight ? ' hl' : ''}" id="lrn-${k}"><h4>${v.t}</h4>`
          + `<div class="lrn-plain">${v.plain}</div>`
          + `<div class="lrn-why"><b>Why it matters:</b> ${v.why}</div>`
          + `<div class="lrn-pro"><b>How pros use it:</b> ${v.pro}</div></div>`;
      }
    }
    body.innerHTML = html;
  }
  // Wrap any label as a tap-to-learn term.
  function L(term, txt) { return `<span class="learn-term" data-learn="${term}">${txt}</span>`; }

  // Per-screener TRUST verdict (one-glance confidence, grounded in the app's own
  // validation findings) — turns the honest caveats into a glyph + expandable detail.
  const TRUST_META = {
    validated: ['#22c55e', 'Validated edge'],
    building: ['#eab308', 'Building track record'],
    confirm: ['#06c4d4', 'Confirmation tool'],
    noedge: ['#ef4444', 'No proven edge'],
  };
  const TRUST = {
    screener: { level: 'confirm', one: `Breakouts have no standalone edge in 5y tests — the ${L('regime', 'regime')} + ${L('tape', 'tape')} gates do the real work. Use it to find candidates, not as a buy signal.` },
    custom: { level: 'building', one: `The conviction ranker has real, out-of-sample selection power (top names beat SPY more often) but narrowly misses the confident-edge bar (${L('wilsonLB', 'confidence floor')} ~48%); the regime gate is the proven lever.` },
    daytrade: { level: 'confirm', one: `A ${L('regime', 'regime')}-gated movers watchlist, not a win-rate edge. Large-cap ${L('momentum', 'momentum')} doesn't beat SPY; small-cap explosive is positive-expectancy but wins <50% (a few big runners carry it).` },
    confluence: { level: 'confirm', one: `~48% win rate in 5y tests — no strategy or ${L('confluence', 'confluence')} combination confidently beats the market. A multi-strategy confirmation overlay.` },
    ghost: { level: 'building', one: `An early-${L('accumulation', 'accumulation')} watchlist. The price core is mostly weak ${L('momentum', 'momentum')} (~0.08 IC); insider/fundamentals add little. Live record still accruing.` },
    trendrider: { level: 'validated', one: `The "stand down when red" timing is validated across 5 independent selloffs — the project's strongest finding. But green = riding ${L('beta', 'beta')}, not stock-picking skill: it tells you WHEN, not WHAT.` },
    fade: { level: 'building', one: `A choppy/neutral-tape ${L('meanrev', 'mean-reversion')} fade. The selected high-conviction basket showed ~+0.9%/mo net out-of-sample (${L('beta', 'beta')}-neutral, after costs) — the most promising result, but the live ${L('backtest', 'track record')} is still building.` },
    forecast: { level: 'building', one: `AI ${L('forecast', 'falsifiable forecasts')} on the market, ${L('tape', 'tape')}/${L('regime', 'regime')}-aware and auto-graded against real prices — no self-scoring. Short-term prediction is hard; expect the live accuracy to sit near a coin flip. Educational, not a signal.` },
    crowd: { level: 'confirm', one: `A ${L('predmarket', 'prediction-market')} sentiment radar (Kalshi + Polymarket) — flags unusual volume and sharp odds swings on macro/equity contracts. It shows what the crowd is suddenly repricing (often confirming news), not a tradeable edge. The volume baseline sharpens over the first few days.` },
    sharp: { level: 'confirm', one: `Flags ${L('sharpmoney', 'informed-activity hallmarks')} — size + conviction lining up on a ${L('predmarket', 'prediction-market')} outcome. A lead to investigate, NOT proof of insider info: it surfaces statistical fingerprints, and most hits are coincidence or hedging. Speculative and educational.` },
    brief: { level: 'confirm', one: `A rule-based synthesis of three individually weak/unproven signals (${L('forecast', 'forecast')}, crowd, ${L('sharpmoney', 'sharp money')}) plus the ${L('regime', 'regime')} — which is weighted heaviest as the only proven lever. The equity translation is a mapping, not a return forecast. Read it as "what the prediction layer leans," then confirm.` },
  };
  function trustBadgeHTML(sub) {
    const tr = TRUST[sub]; if (!tr) return '';
    const [col, lbl] = TRUST_META[tr.level] || TRUST_META.confirm;
    return `<span class="trust-dot" style="background:${col}"></span><b style="color:${col}">${lbl}</b> <span class="trust-one">— ${tr.one}</span>`;
  }

  function openLearn(term) {
    const modal = document.getElementById('learn-modal'); if (!modal) return;
    renderLearn(LEARN[term] ? term : null);
    modal.hidden = false; document.body.style.overflow = 'hidden';
    if (LEARN[term]) { const el = document.getElementById('lrn-' + term); if (el) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60); }
  }
  (() => {
    const modal = document.getElementById('learn-modal');
    const close = () => { if (modal) { modal.hidden = true; document.body.style.overflow = ''; } };
    document.getElementById('learn-btn')?.addEventListener('click', () => openLearn());
    document.getElementById('learn-close')?.addEventListener('click', close);
    modal?.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal && !modal.hidden) close(); });
    // Any [data-learn] element anywhere opens the glossary at that concept.
    document.addEventListener('click', e => { const t = e.target.closest('[data-learn]'); if (t) { e.preventDefault(); openLearn(t.dataset.learn); } });
  })();

  // ── Global command palette (⌘K / Ctrl-K) ──────────────────────────────────
  // Open the Options tab filtered to a ticker (used by the palette's ticker search).
  function openOptionsForTicker(tk) {
    showTab('options');
    if (typeof ensureOptions === 'function') ensureOptions();
    let tries = 0;
    const apply = () => {
      const inp = document.getElementById('of-ticker');
      if (inp) { inp.value = tk; ofFilters.ticker = tk; if (typeof applyOptionsView === 'function') applyOptionsView(); }
      else if (tries++ < 20) setTimeout(apply, 150);
    };
    apply();
  }
  const GROUP_LABEL = { home: 'Today', candidates: 'Candidates', positions: 'Portfolio', markets: 'Markets', predict: 'Predict', proof: 'Evidence', lab: 'Research Lab' };
  initCommandPalette({
    sections: SECTION_IDS.map(id => ({ id, label: (SUB_LABEL[id] || id).replace(/^[^\w]+\s*/, ''), group: GROUP_LABEL[topOf(id)] || '' })),
    learn: Object.keys(LEARN).map(key => ({ key, label: LEARN[key].t, group: LEARN[key].g })),
    onRoute: id => showTab(id),
    onLearn: key => openLearn(key),
    onTickerOptions: openOptionsForTicker,
    onTickerLookup: openTickerLookup,
  });

  // Sections currently rendering a ticker (its cards carry data-live / data-ticker).
  // Powers the "elsewhere in the app" cross-references in the ticker-lookup modal.
  function findTickerMentions(ticker) {
    const T = (ticker || '').toUpperCase();
    const ids = new Set();
    document.querySelectorAll(`[data-live="${T}"], [data-ticker="${T}"]`).forEach(el => {
      const sec = el.closest('section.tabbable, section[id]');
      if (sec && sec.id && SECTION_IDS.includes(sec.id)) ids.add(sec.id);
    });
    return [...ids].map(id => ({ id, label: SUB_LABEL[id] || id }));
  }

  // The lookup modal delegates the grade banner + chart to the app's shared
  // renderChart (defined later, hoisted), and reuses the palette's jump-and-flash.
  initTickerLookup({ renderChart, findMentions: findTickerMentions, onReveal: revealTicker });

  // Make every stock ticker across the app clickable → opens the same lookup
  // screen as the search bar. One delegated handler: prefer the exact symbol on a
  // [data-ticker] card, else parse a known ticker-text element. Interactive
  // controls (buttons, toggles, chips, links, inputs) are left alone.
  const TK_TEXT_SELECTORS = '.pc-ticker,.al-tk,.cx-ticker,.scr-ticker,.fade-tk,.opt-ticker,.alert-ticker,.pulse-tk';
  document.addEventListener('click', e => {
    if (e.target.closest('button, a, input, select, textarea, label, [data-chart-toggle], [data-reveal], [data-sub], .tkl-chip, #tkl-modal, .cmdk-modal, .hub-sub-btn, .refresh-btn, .scr-hc')) return;
    if (window.getSelection && String(window.getSelection()).length > 3) return;   // don't hijack text selection
    let sym = null;
    const card = e.target.closest('[data-ticker]');
    if (card && card.dataset.ticker) sym = card.dataset.ticker;
    if (!sym) { const el = e.target.closest(TK_TEXT_SELECTORS); if (el) sym = el.dataset.ticker || el.textContent; }
    if (!sym) return;
    sym = String(sym).toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 8);
    if (!sym) return;
    e.preventDefault();
    openTickerLookup(sym);
  });

  // Header search affordance (desktop): a button that opens the palette.
  (() => {
    const right = document.querySelector('.header-right');
    const ref = document.getElementById('learn-btn');
    if (!right || document.getElementById('cmdk-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'hdr-btn'; btn.id = 'cmdk-btn';
    btn.title = 'Search everything (⌘K / Ctrl-K)';
    btn.textContent = '🔎 Search';
    btn.addEventListener('click', () => openPalette());
    right.insertBefore(btn, ref || right.firstChild);
  })();
  // Mobile: the Search item in the bottom nav opens the same palette.
  document.getElementById('mbn-search')?.addEventListener('click', e => { e.preventDefault(); openPalette(); });

  // ── 🏠 TODAY — guided home: read the tape, say what suits, route the novice ──
  let todayLoaded = false;
  let opportunitiesLoaded = false;
  function ensureOpportunities() {
    const el = document.getElementById('opportunities-container'); if (!el || opportunitiesLoaded) return;
    opportunitiesLoaded = true;
    mountOpportunitiesTab(el, body => {
      body.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.go)));
      const sec = document.getElementById('opportunities'); if (sec) startScreenerLive(sec);   // re-arm live prices after each (re)load
    });
  }
  // When a Quick Hit "Found in · {cap}" link navigates to ⭐ Opportunities, it stores the
  // desired cap in localStorage.oppScope. First mount reads that automatically; if the tab
  // was ALREADY mounted, re-apply by clicking its scope button (reuses the reload path).
  function syncOppScope() {
    let want; try { want = localStorage.getItem('oppScope'); } catch {}
    if (!want) return;
    const btn = document.getElementById('opportunities')?.querySelector(`.opp-scope-btn[data-scope="${want}"]`);
    if (btn && !btn.classList.contains('active')) btn.click();
  }
  let quickHitLoaded = false;
  function ensureQuickHit() {
    const el = document.getElementById('quickhit-container'); if (!el || quickHitLoaded) return;
    quickHitLoaded = true;
    const bindNav = root => root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.go)));
    loadQuickHit(el, bindNav).then(() => {
      bindNav(el);
      const sec = document.getElementById('quickhit'); if (sec) startScreenerLive(sec);   // live prices on the tickers
    });
  }
  document.getElementById('quickhit-refresh-btn')?.addEventListener('click', () => { quickHitLoaded = false; ensureQuickHit(); });
  let leaderboardLoaded = false;
  function ensureLeaderboard() {
    const el = document.getElementById('leaderboard-container'); if (!el || leaderboardLoaded) return;
    leaderboardLoaded = true;
    loadLeaderboard(el).then(() => el.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.go))));
  }
  function ensureToday() { if (!todayLoaded) { todayLoaded = true; runTodayUI(); } }
  async function runTodayUI() {
    const el = document.getElementById('today-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Reading today's market…</p></div>`;
    try {
      const [tape, dt] = await Promise.all([
        fetch('/api/tracker?op=tape').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=daytrade').then(r => r.json()).catch(() => null),
      ]);
      renderToday(tape, dt);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Today.</p></div>`; }
  }
  const TODAY_COND = { trending: ['📈', 'trending', 'A calm, directional market — a good environment for trend and breakout setups.'], choppy: ['🌊', 'choppy / ranging', 'A whippy, sideways market — trends get chopped up, so be careful.'], mixed: ['🤝', 'mixed', 'Direction is unclear right now — the safest play is patience and selectivity.'], riskoff: ['🛑', 'risk-off', 'A defensive, fearful market — new longs are risky.'] };
  const TODAY_REC = {
    riskoff: { e: '🛑', col: 'var(--red)', h: 'Best move today: usually NOT trading new longs', b: 'The market is risk-off — almost every long setup fails here. Protect your capital and wait for it to calm down.', cta: null },
    trending: { e: '📈', col: 'var(--green)', h: 'Momentum & breakouts are favored', b: 'Clean directional tape — trend and breakout setups are in their element.', cta: { l: "See today's movers →", s: 'daytrade' } },
    choppy: { e: '🌊', col: 'var(--amber,#f59e0b)', h: 'Favor mean-reversion, not breakouts', b: 'Whippy, ranging tape — breakouts fail more (false breakouts). Fades suit it; be selective with tight stops.', cta: { l: 'Open the Overheated screen →', s: 'fade' } },
    mixed: { e: '🤝', col: 'var(--amber,#f59e0b)', h: 'Be selective — no clear edge today', b: 'No tape clearly favors a style. Stick to only the highest-conviction setups and size down.', cta: { l: 'Browse the Breakout screen →', s: 'screener' } },
  };
  function renderToday(tape, dt) {
    const el = document.getElementById('today-container'); if (!el) return;
    const ok = tape && tape.ok;
    const cond = ok ? tape.condition : 'mixed', regime = ok ? tape.regime : 'neutral', eff = ok ? tape.efficiency : null;
    const [ci, clbl, cdesc] = TODAY_COND[cond] || TODAY_COND.mixed;
    const regLbl = (regime || '').toUpperCase();
    const read = `<div class="rot-panel"><div class="rot-head">${ci} Today's market read</div><div class="rot-sub">The market is <b>${L('regime', regLbl)}</b> and the tape is <b>${L('tape', clbl)}</b>${eff != null ? ` <span class="dt-dim">(${L('trendEff', 'trend-eff ' + eff)})</span>` : ''}. ${cdesc}</div></div>`;
    const r = TODAY_REC[cond] || TODAY_REC.mixed;
    const rec = `<div class="dt-note" style="border-left-color:${r.col}"><b>${r.e} ${r.h}.</b> ${r.b}${r.cta ? ` <button class="today-cta" data-go="${r.cta.s}">${r.cta.l}</button>` : ''}</div>`;
    // 🪁 Red-tape nudge → Down-Day Mode (reversion longs + shorts + the honest sit-out).
    const spyChg = ok ? tape.spyChangePct : null;
    const redTape = ok && ((spyChg != null && spyChg <= -0.4) || regime === 'risk-off' || cond === 'riskoff');
    const downNudge = redTape
      ? `<div class="dt-note" style="border-left-color:#a78bfa;background:#a78bfa14"><b>🪁 It's a red tape${spyChg != null ? ` (SPY ${spyChg >= 0 ? '+' : ''}${spyChg}%)` : ''} — momentum longs won't work today.</b> Down-Day Mode shows what actually pays on a down day: oversold-bounce longs, overheated shorts, and the honest math on why chasing strength here loses. <button class="today-cta" data-go="downday">Open Down-Day Mode →</button></div>`
      : '';
    let ideas = '';
    if (cond !== 'riskoff' && dt && dt.ok) {
      const picks = [...(dt.momentumLiquid || []), ...(dt.explosiveSmall || [])].slice(0, 4);
      if (picks.length) ideas = `<div class="rot-panel"><div class="rot-head">👀 A few names moving today</div><div class="rot-sub">Today's biggest movers on heavy volume — a starting watchlist, not advice. Tap a row to open the full Day Trade view.</div>`
        + picks.map(p => `<div class="bt-ic-row today-idea" data-go="daytrade"><span><b>${esc(p.ticker)}</b> <span style="color:var(--text-dim)">${esc(p.sector || '')}</span></span><span style="color:var(--green)">+${p.pctChange}%</span><span>RVOL ${p.relVol}×</span></div>`).join('') + `</div>`;
    }
    // 🎯 The centerpiece: the UNIFIED decision command center (op=today) — every
    // screener's picks ranked into one validated, horizon-bucketed table with an
    // honest independent-evidence count. Server-authoritative; loads independently.
    const cc = `<div id="today-cc" class="td-cc-wrap"></div>`;
    const links = `<div class="today-links"><button class="today-link" data-go="opportunities">⭐ Detailed opportunity cards</button><button class="today-link" data-go="start">📘 New here? Read the 2-min guide</button><button class="today-link" id="today-learn">📚 Learn the basics</button><button class="today-link" data-go="screener">🔎 All screeners</button></div>`;
    el.innerHTML = read + rec + downNudge + cc + ideas + links;
    el.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { if (typeof showTab === 'function') showTab(b.dataset.go); }));
    el.querySelector('#today-learn')?.addEventListener('click', () => openLearn());
    loadCommandCenter(el.querySelector('#today-cc')).then(() => {
      if (typeof startScreenerLive === 'function') startScreenerLive(el.querySelector('#today-cc')); // live prices on ticker chips
    });
    const gt = document.getElementById('today-gen-time'); if (gt && ok && tape.generatedAt) gt.textContent = new Date(tape.generatedAt).toLocaleTimeString();
    const meta = document.getElementById('today-meta'); if (meta) meta.textContent = `· ${regLbl} · ${clbl} tape`;
  }
  document.getElementById('today-refresh-btn')?.addEventListener('click', runTodayUI);
  document.getElementById('opp-refresh-btn')?.addEventListener('click', () => { opportunitiesLoaded = false; ensureOpportunities(); });
  document.getElementById('leaderboard-refresh-btn')?.addEventListener('click', () => { leaderboardLoaded = false; ensureLeaderboard(); });

  // ── 🧭 PREDICTION BRIEF — synthesis lives server-side in lib/brief.js (single
  // source of truth, shared with the validation cron). The UI just renders op=brief.
  const TONE_COL = { bull: 'var(--green)', bear: 'var(--red)', neutral: 'var(--amber,#f59e0b)' };
  const LEAN_TXT = { 1: ['▲', 'bullish', 'var(--green)'], '-1': ['▼', 'bearish', 'var(--red)'], 0: ['▬', 'neutral', 'var(--text-dim)'] };
  // ── 📡 MARKET PULSE — top-10 trending distillations from social + finance media
  // (server-side lib/pulse-routes.js via Claude web search). Ranked by popularity +
  // how fast the news is trending. Attention digest, NOT buy signals. Refreshes ~4h.
  let pulseLoaded = false, pulseRefining = false;
  function ensurePulse() { if (!pulseLoaded) { pulseLoaded = true; runPulseUI(false); } }

  // 🔥 Momentum Ignition — acceleration-ranked momentum view (loadIgnition renders op=ignition).
  let ignitionLoaded = false;
  function ensureIgnition() {
    if (!ignitionLoaded) {
      ignitionLoaded = true;
      const btn = document.getElementById('ignition-refresh-btn');
      if (btn) btn.addEventListener('click', () => loadIgnition(document.getElementById('ignition-container')));
    }
    loadIgnition(document.getElementById('ignition-container'));
  }

  // 💠 OMEGA-SWING — 5–10 day momentum continuation (loadOmega renders op=omega).
  let omegaLoaded = false;
  function ensureOmega() {
    if (!omegaLoaded) {
      omegaLoaded = true;
      const btn = document.getElementById('omega-refresh-btn');
      if (btn) btn.addEventListener('click', () => loadOmega(document.getElementById('omega-container')));
    }
    loadOmega(document.getElementById('omega-container'));
  }

  // 🛰️ ORBIT (shadow) — read-only Research Lab panel over the ORBIT + ORBIT-ML shadow
  // systems (loadOrbitLab renders op=orbit/orbithealth/orbitml/orbitmlhealth). Weight-0,
  // never affects the live rank — honest track-record accrual only.
  let orbitLabLoaded = false;
  function ensureOrbitLab() {
    if (!orbitLabLoaded) {
      orbitLabLoaded = true;
      const btn = document.getElementById('orbitlab-refresh-btn');
      if (btn) btn.addEventListener('click', () => loadOrbitLab(document.getElementById('orbitlab-container')));
    }
    loadOrbitLab(document.getElementById('orbitlab-container'));
  }

  // 🎯 OMEGA ENSEMBLE — the composed board (loadEnsemble renders the op=ensemble payload,
  // which is a pure projection of op=today + op=evolvehealth; no scoring client-side).
  let ensembleLoaded = false;
  function ensureEnsemble() {
    if (!ensembleLoaded) {
      ensembleLoaded = true;
      const btn = document.getElementById('ensemble-refresh-btn');
      if (btn) btn.addEventListener('click', () => loadEnsemble(document.getElementById('ensemble-container'), true));
    }
    loadEnsemble(document.getElementById('ensemble-container'));
  }

  // 🧬 EVOLVE — adaptive pre-move discovery (loadEvolve renders the op=evolve payload).
  let evolveLoaded = false;
  function ensureEvolve() {
    if (!evolveLoaded) {
      evolveLoaded = true;
      const btn = document.getElementById('evolve-refresh-btn');
      if (btn) btn.addEventListener('click', () => loadEvolve(document.getElementById('evolve-container')));
    }
    loadEvolve(document.getElementById('evolve-container'));
  }
  async function runPulseUI(force) {
    const el = document.getElementById('pulse-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Re-scanning' : 'Scanning'} X · StockTwits · Reddit · finance YouTube… <span class="dt-dim">(can take ~20s)</span></p></div>`;
    try {
      const p = await fetch('/api/tracker?op=pulse' + (force ? '&force=1' : '')).then(r => r.json());
      renderPulse(p);
      // STAGE 2: if we got the Haiku draft (not yet Fable-refined), upgrade it in the
      // background — the draft is already useful, and Fable sharpens the read a few sec later.
      if (p && p.ok && p.stage !== 'refined' && p.persisted) refinePulseUI(force);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Market Pulse.</p></div>`; }
  }
  async function refinePulseUI(force) {
    if (pulseRefining) return;
    pulseRefining = true;
    const chip = document.getElementById('pulse-refine-chip');
    if (chip) chip.innerHTML = `<span class="pulse-refining">🧠 Fable is sharpening the read…</span>`;
    try {
      const p = await fetch('/api/tracker?op=pulserefine' + (force ? '&force=1' : '')).then(r => r.json());
      if (p && p.ok && p.stage === 'refined') renderPulse(p);
      else if (chip) chip.innerHTML = '';   // refine failed → keep the draft, drop the chip
    } catch { const c = document.getElementById('pulse-refine-chip'); if (c) c.innerHTML = ''; }
    finally { pulseRefining = false; }
  }
  // ── Vocabularies (derived STATES from the server, rendered as visual chips) ──────────
  // Action state = the single most useful research label (never a buy/sell order).
  const PULSE_ACTION = {
    'INVESTIGATE NOW':        ['🔎', '#22c55e', 'Fresh, credible, and price has not fully reacted — worth a look now.'],
    'EMERGING — WATCH':       ['🌱', '#84cc16', 'Early and gaining attention — track it, do not chase yet.'],
    'CONFIRMED MOMENTUM':     ['✅', '#16a34a', 'Attention, price and volume agree — the move is real and underway.'],
    'WAIT FOR ENTRY':         ['⏳', '#f59e0b', 'Interesting but stretched — wait for structure / a pullback.'],
    'TOO EXTENDED':           ['🚫', '#ef4444', 'Already ran hard (well above its ATR mean) — chasing is poor R:R.'],
    'CROWDED — DO NOT CHASE': ['🫧', '#ef4444', 'Everyone already knows — crowded, high fade risk.'],
    'CONTRARIAN WATCH':       ['🎯', '#a855f7', 'There is an explicit, testable contrarian thesis here.'],
    'CONTEXT ONLY':           ['🗺️', '#9ca3af', 'Useful background — not a single-stock trade.'],
    'UNVERIFIED':             ['❓', '#eab308', 'No credible independent source yet — treat as a rumour.'],
    'STALE':                  ['🕰️', '#9ca3af', 'This snapshot is old — refresh before acting.'],
  };
  const PULSE_LIFE = {
    New: ['🆕', 'Just appeared'], Emerging: ['🌱', 'Spreading, early'], Building: ['📶', 'Gaining steam'],
    Crowded: ['🫧', 'Consensus / extended'], Fading: ['❄️', 'Losing momentum'],
  };
  const PULSE_EVID = {
    'Verified':            ['✅', 'var(--green)', '3+ independent sources'],
    'Multi-source':        ['🔗', '#60a5fa', '2+ independent sources'],
    'Single-source':       ['◐', '#f59e0b', 'One source only'],
    'Search-summary only': ['🔎', '#9ca3af', 'Based on a search summary — no direct source metadata'],
    'Conflicted':          ['⚠️', '#ef4444', 'Sources disagree on the facts'],
    'Unverified':          ['❓', '#eab308', 'No credible source'],
  };
  const PULSE_VEL = { exploding: ['🔥', '#ef4444', 'Exploding'], rising: ['📈', '#f59e0b', 'Rising'], steady: ['➡️', '#9ca3af', 'Steady'], cooling: ['❄️', '#60a5fa', 'Cooling'] };
  const PULSE_SENT = { bullish: ['var(--green)', '▲ Bullish'], bearish: ['var(--red)', '▼ Bearish'], mixed: ['var(--text-dim)', '▬ Mixed'] };
  const PULSE_CROWD = { early: ['🌱', 'var(--green)', 'Early'], building: ['📶', '#f59e0b', 'Building'], crowded: ['🫧', '#ef4444', 'Crowded'], capitulation: ['💥', '#a855f7', 'Capitulation'] };
  const PULSE_FRESH = {
    live: ['🟢', 'var(--green)', 'Live'], stale: ['🟠', '#f59e0b', 'Stale'],
    'very-stale': ['🔴', '#ef4444', 'Very stale'], cached: ['🟢', 'var(--green)', 'Cached'], unknown: ['⚪', '#9ca3af', ''],
  };

  // Which lifecycle section a card belongs in.
  function pulseSection(it) {
    if (it.category === 'macro') return 'macro';
    const a = it.actionState;
    if (a === 'CONTRARIAN WATCH') return 'contrarian';
    if (a === 'CROWDED — DO NOT CHASE' || a === 'TOO EXTENDED' || it.lifecycleState === 'Crowded') return 'crowded';
    if (a === 'CONFIRMED MOMENTUM') return 'confirmed';
    if (a === 'UNVERIFIED') return 'unverified';
    if (it.lifecycleState === 'Fading' || a === 'CONTEXT ONLY' || a === 'STALE') return 'context';
    return 'emerging';
  }
  const PULSE_SECTIONS = [
    ['emerging',   '🌱 Emerging now', 'Fresh, credibly-sourced, accelerating — and not yet fully priced. The highest-value lane for momentum traders.'],
    ['confirmed',  '✅ Confirmed momentum', 'Attention, price and volume agree. (Confirmation ≠ three flavours of the same recent price move.)'],
    ['crowded',    '🫧 Crowded & extended', 'Heavily watched and already stretched — the R:R of chasing is poor. Caution, not a short signal.'],
    ['contrarian', '🎯 Contrarian watch', 'Only names with an explicit, testable contrarian thesis.'],
    ['macro',      '🌐 Macro & market-wide', 'Rates, inflation, commodities, geopolitics, index-level themes — not forced into a ticker.'],
    ['context',    '🗺️ Context & fading', 'Background and cooling narratives.'],
    ['unverified', '❓ Unverified', 'Circulating but not yet backed by a credible independent source — treat as rumour.'],
  ];

  const pctChip = (label, v, good) => v == null ? '' :
    `<span class="pc-metric" title="${label}">${label} <b style="color:${v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text-dim)'}">${v > 0 ? '+' : ''}${v}${good ? '×' : '%'}</b></span>`;

  function pulseSourcesHTML(it) {
    const list = (it.sourceList || []).filter(s => s && s.url);
    if (list.length) {
      return `<div class="pc-sources"><b>Sources (real links):</b><ul>` + list.map(s =>
        `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.domain || s.url)}</a>` +
        `<span class="pc-src-dom">${esc(s.domain || '')}${s.publishedAt ? ' · ' + esc(s.publishedAt) : ''}${s.independent === false ? ' · echo' : ''}</span></li>`).join('') +
        `</ul></div>`;
    }
    // No structured source metadata — say so honestly, never imply a platform was scanned.
    return `<div class="pc-sources pc-nosrc">Source evidence unavailable — based on search summary.${it.sources ? ' <span class="pc-src-dom">Reported trending on: ' + esc(it.sources) + '</span>' : ''}</div>`;
  }

  function pulseProHTML(it) {
    const e = it.enrichment;
    const enrich = e ? `<div class="pc-enrich"><b>Price context</b> <span class="pc-measured" title="Measured from daily bars at snapshot time (point-in-time, not live)">measured · point-in-time</span><br>
        ${pctChip('day', e.dayReturn)} ${pctChip('3-sess', e.ret3)} ${pctChip('gap', e.gapPct)}
        ${e.atrExt != null ? `<span class="pc-metric" title="How many ATRs above the 20-session mean — high = already extended">stretch <b style="color:${e.atrExt >= 2.5 ? 'var(--red)' : e.atrExt >= 1.5 ? '#f59e0b' : 'var(--green)'}">${e.atrExt} ATR</b></span>` : ''}
        ${e.relVol != null ? pctChip('rel-vol', e.relVol, true) : ''}</div>` : '';
    const sent = PULSE_SENT[it.sentiment] || PULSE_SENT.mixed;
    const cw = it.crowding && PULSE_CROWD[it.crowding];
    const vel = PULSE_VEL[it.velocity] || PULSE_VEL.steady;
    return `<details class="pc-pro"><summary>Pro details</summary>
      <div class="pc-pro-body">
        ${enrich}
        <div class="pc-inferred"><b>Attention</b> <span class="pc-infnote" title="LLM estimates — not measured counts">inferred</span><br>
          <span class="pc-metric" style="color:${sent[0]}">${sent[1]}</span>
          <span class="pc-metric" title="Editorial prominence — an LLM estimate of how widely discussed, NOT a mention count">prominence ${it.popularity}/100</span>
          <span class="pc-metric" style="color:${vel[1]}" title="Inferred buzz trend">buzz ${vel[2]}</span>
          ${cw ? `<span class="pc-metric" style="color:${cw[1]}">crowd: ${cw[2]}</span>` : ''}
          <span class="pc-metric" title="Distinct independent domains cited">indep sources ${it.independentSources || 0}</span></div>
        ${it.contrarian ? `<div class="pc-line"><b>🎯 Contrarian read:</b> ${esc(it.contrarian)}</div>` : ''}
        ${it.invalidation ? `<div class="pc-line"><b>❌ Invalidation:</b> ${esc(it.invalidation)}</div>` : ''}
        ${it.horizon ? `<div class="pc-line"><b>⏱ Horizon:</b> ${esc(it.horizon)}</div>` : ''}
        ${it.idea ? `<div class="pc-line"><b>Detail:</b> ${esc(it.idea)}</div>` : ''}
        ${pulseSourcesHTML(it)}
      </div></details>`;
  }

  function pulseCard(it) {
    const [ae, ac, atip] = PULSE_ACTION[it.actionState] || PULSE_ACTION['CONTEXT ONLY'];
    const [le, ll] = PULSE_LIFE[it.lifecycleState] || PULSE_LIFE.Emerging;
    const [ee, ecol, etip] = PULSE_EVID[it.evidenceState] || PULSE_EVID['Search-summary only'];
    const tickers = (it.tickers || []).map(t => `<span class="pulse-tk">$${esc(t)}</span>`).join(' ')
      || (it.category === 'macro' ? '<span class="pulse-macrotag">macro theme</span>' : '');
    return `<div class="pulse-card" id="pulse-card-${it.rank}" data-section="${pulseSection(it)}">
      <div class="pc-head">
        <span class="pc-action" style="background:${ac}22;color:${ac};border-color:${ac}66" title="${atip}">${ae} ${esc(it.actionState)}</span>
        <span class="pc-life" title="Attention lifecycle stage">${le} ${esc(it.lifecycleState)}</span>
        <span class="pc-evid" style="color:${ecol}" title="${etip}">${ee} ${esc(it.evidenceState)}</span>
      </div>
      <div class="pc-title">${esc(it.headline)}</div>
      ${tickers ? `<div class="pc-tks">${tickers}</div>` : ''}
      ${it.whatChanged ? `<div class="pc-changed"><b>What changed:</b> ${esc(it.whatChanged)}</div>` : ''}
      ${it.whyItMatters ? `<div class="pc-why"><b>Why it matters:</b> ${esc(it.whyItMatters)}</div>` : (it.whyMoves ? `<div class="pc-why"><b>Why it matters:</b> ${esc(it.whyMoves)}</div>` : '')}
      ${it.traderRead ? `<div class="pc-trader"><b>Trader read:</b> ${esc(it.traderRead)}</div>` : ''}
      ${it.noviceTranslation ? `<div class="pc-novice">🔰 <b>Plain English:</b> ${esc(it.noviceTranslation)}</div>` : ''}
      ${it.primaryRisk ? `<div class="pc-risk">⚠️ <b>Risk:</b> ${esc(it.primaryRisk)}</div>` : (it.caution ? `<div class="pc-risk">⚠️ ${esc(it.caution)}</div>` : '')}
      ${pulseProHTML(it)}
    </div>`;
  }

  // "The tape in 20 seconds" — up to four one-line reads that link to their card.
  function pulseTape(items) {
    const tiles = [];
    const link = (it, label, val, cls) => it ? `<a class="pt-tile ${cls}" href="#pulse-card-${it.rank}"><span class="pt-lbl">${label}</span><span class="pt-val">${esc(val)}</span></a>` : '';
    const dominant = items[0];
    const emerging = items.find(x => (x.lifecycleState === 'Emerging' || x.lifecycleState === 'New') && (x.evidenceState === 'Verified' || x.evidenceState === 'Multi-source'))
      || items.find(x => x.lifecycleState === 'Emerging' || x.lifecycleState === 'New');
    const accel = items.filter(x => x.velocity === 'exploding').sort((a, b) => b.popularity - a.popularity)[0];
    const crowd = items.find(x => x.actionState === 'TOO EXTENDED' || x.actionState === 'CROWDED — DO NOT CHASE');
    tiles.push(link(dominant, '🏆 Dominant narrative', dominant ? dominant.headline : '', 'pt-dom'));
    tiles.push(link(emerging, '🌱 Newest credible catalyst', emerging ? emerging.headline : '', 'pt-emg'));
    tiles.push(link(accel, '🔥 Strongest acceleration', accel ? accel.headline : '', 'pt-acc'));
    tiles.push(link(crowd, '🫧 Biggest chase risk', crowd ? crowd.headline : '', 'pt-crw'));
    return tiles.filter(Boolean).join('');
  }

  function pulseRecentlyChanged(list) {
    if (!list || !list.length) return '';
    const rows = list.slice(0, 8).map(t =>
      `<li><b>${esc(t.headline || '')}</b> <span class="pr-move">${esc(t.from || '·')} → ${esc(t.to || '')}</span></li>`).join('');
    return `<details class="pulse-recent"><summary>🔄 Recently changed (${list.length})</summary><ul>${rows}</ul></details>`;
  }

  function renderPulse(p) {
    const el = document.getElementById('pulse-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      el.innerHTML = `<div class="mom-status error"><p>Market Pulse is warming up${p && p.error ? ' — ' + esc(p.error) : ''}. Try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('pulse-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;

    const items = p.items;
    const [fe, fc, fl] = PULSE_FRESH[p.freshness] || PULSE_FRESH.unknown;
    const ageStr = p.ageMins == null ? '' : (p.ageMins >= 120 ? Math.round(p.ageMins / 60) + 'h' : p.ageMins + 'm') + ' old';
    const lkgStr = p.lastKnownGood ? ' · showing last-known-good' : '';
    const isStale = p.freshness === 'stale' || p.freshness === 'very-stale' || !!p.stale;
    const staleWarn = isStale
      ? `<span class="pulse-stalewarn">${fe} ${fl} snapshot${ageStr ? ' · ' + ageStr : ''}${lkgStr} — refresh before acting</span>`
      : '';
    const feedState = p.stage === 'refined' ? '🧠 Fable-refined' : (p.refineFailed ? '📝 draft (refine unavailable)' : '<span id="pulse-refine-chip">📝 draft — sharpening…</span>');

    // Filter chips (section-level show/hide).
    const present = new Set(items.map(pulseSection));
    const chips = [['all', 'All']].concat(PULSE_SECTIONS.filter(s => present.has(s[0])).map(s => [s[0], s[1].replace(/^\S+\s/, '')]))
      .map(([k, lbl]) => `<button class="pulse-fchip${k === 'all' ? ' active' : ''}" data-filter="${k}">${esc(lbl)}</button>`).join('');

    const sectionsHTML = PULSE_SECTIONS.map(([key, title, desc]) => {
      const secItems = items.filter(it => pulseSection(it) === key);
      if (!secItems.length) return '';
      return `<div class="pulse-sec" data-sec="${key}">
        <div class="pulse-sec-head"><h3>${title} <span class="pulse-sec-n">${secItems.length}</span></h3><p>${desc}</p></div>
        <div class="pulse-grid">${secItems.map(pulseCard).join('')}</div></div>`;
    }).join('');

    el.innerHTML = `
      <div class="dt-note pulse-note"><b>📡 Attention lifecycle.</b> ${feedState} · <span title="Feed freshness" style="color:${fc}">${fe} ${fl}</span> ${staleWarn}
        <div class="pulse-counts">✅ ${p.verifiedThemes != null ? p.verifiedThemes : '—'} verified · ❓ ${p.unverifiedThemes != null ? p.unverifiedThemes : '—'} unverified themes</div>
        <div class="pulse-disc">${esc(p.disclaimer || '')}</div></div>
      <div class="pulse-tape"><div class="pulse-tape-title">⏱ The tape in 20 seconds</div><div class="pulse-tape-grid">${pulseTape(items)}</div></div>
      ${pulseRecentlyChanged(p.recentlyChanged)}
      <div class="pulse-filters">${chips}</div>
      <div class="pulse-sections">${sectionsHTML}</div>`;

    // Wire filter chips (pure show/hide, no refetch).
    el.querySelectorAll('.pulse-fchip').forEach(btn => btn.onclick = () => {
      const f = btn.dataset.filter;
      el.querySelectorAll('.pulse-fchip').forEach(b => b.classList.toggle('active', b === btn));
      el.querySelectorAll('.pulse-sec').forEach(sec => { sec.style.display = (f === 'all' || sec.dataset.sec === f) ? '' : 'none'; });
    });
    const rb = document.getElementById('pulse-refresh-btn');
    if (rb) rb.onclick = () => runPulseUI(true);
  }

  // ── 🔗 READ-THROUGH — second-order beneficiaries of today's gappers (server-side
  // lib/readthrough-routes.js via Fable 5). "Who benefits and hasn't moved yet?" — a
  // relational lead-lag a per-stock model can't see. Names that already repriced today
  // are demoted (the edge is the lag). A LEAD to forward-track, NOT a buy signal.
  // ── Predict-tab feedback loop (Layer 1 + 2, server: lib/calibration.js) ──────────────
  // op=calibration grades every CLASS of each novel screener by its live track record —
  // 1-week forward EXCESS vs its own sector ETF, Wilson-bounded so small samples can't lie.
  // The cards stamp that record (Layer 1) and auto-feature PROVEN classes / dim + rank-last
  // DUD classes (Layer 2). Fetched once per session and cached in memory.
  let _calib = null, _calibPromise = null;
  async function loadCalibration() {
    if (_calib) return _calib;
    if (!_calibPromise) {
      _calibPromise = fetch('/api/tracker?op=calibration')
        .then(r => r.json())
        .then(j => (_calib = (j && j.sections) ? j : { sections: {}, minResolved: 15 }))
        .catch(() => (_calib = { sections: {}, minResolved: 15 }));
    }
    return _calibPromise;
  }
  // Mirror of each route's server-side tierFor (lib/<x>-routes.js) — the calibration doc is
  // keyed by the LEDGER tier, so a card maps its own class field to that tier to look it up.
  // Keep these in sync with the routes' tierFor if a class label ever changes.
  const PREDICT_TIER = {
    ReadThrough: it => (!it.moved || it.moved.alreadyMoved == null) ? 'Unknown' : it.moved.alreadyMoved ? 'Moved' : 'Fresh',
    Anomaly:     it => it.classification === 'ACCUMULATION' ? 'Accumulation' : it.classification === 'EXPLAINED' ? 'Explained' : 'Noise',
    Biotech:     it => it.tier || (it.score >= 75 ? 'Hot' : it.score >= 60 ? 'Emerging' : 'Watch'),
    SecondWave:  it => it.classification === 'PRIMED' ? 'Primed' : it.classification === 'EARLY' ? 'Early' : 'Faded',
    CrossAsset:  it => it.classification === 'LEAD' ? 'Lead' : it.classification === 'INLINE' ? 'Inline' : 'Weak',
    ToneShift:   it => it.shift === 'BRIGHTENING' ? 'Brightening' : it.shift === 'DARKENING' ? 'Darkening' : 'Stable',
  };
  const CALIB_VRANK = { PROVEN: 0, CALIBRATING: 1, DUD: 2 };
  // Mirror of lib/calibration.js ATTR_SPEC.conviction.key — the per-item field holding the
  // AI's 1–5 conviction. Used by Layer 3b to rank within a class once that score proves out.
  const PREDICT_CONV = { ReadThrough: 'directness', Anomaly: 'confidence', Biotech: 'confidence', SecondWave: 'virality', CrossAsset: 'confidence', ToneShift: 'confidence' };
  function calibFor(section, it) {
    const sec = _calib && _calib.sections && _calib.sections[section];
    const tf = PREDICT_TIER[section];
    if (!sec || !tf) return null;
    const cm = sec.classes || sec;   // new {classes,attributes} shape; tolerate an older flat cache
    return cm[tf(it)] || null;
  }
  // Layer 3: does the AI's own conviction score (directness/confidence/virality) order realized
  // excess? Read the rank-IC verdict for a screener and render a one-line headline for its note.
  function convAttr(section) {
    const sec = _calib && _calib.sections && _calib.sections[section];
    return (sec && sec.attributes && sec.attributes.conviction) || null;
  }
  function convictionLine(section) {
    const c = convAttr(section);
    if (!c) return '';
    const label = esc(c.label), ic = `${c.rankIC > 0 ? '+' : ''}${c.rankIC}`;
    if (c.verdict === 'CALIBRATED')
      return `<span class="conv conv-good" title="Rank-IC ${ic} over ${c.n} resolved picks — the AI's ${label} score has ordered realized excess vs sector (higher ${label} → more excess). Cards within each class are now sorted by it.">🎯 AI ${label} predicts · IC ${ic} (n${c.n}) · ranking by it</span>`;
    if (c.verdict === 'INVERTED')
      return `<span class="conv conv-bad" title="Rank-IC ${ic} over ${c.n} — higher ${label} did WORSE. The scale is backwards here, so higher-${label} picks are now sorted LAST.">⚠️ AI ${label} INVERTED · IC ${ic} (n${c.n}) · down-ranked</span>`;
    if (c.verdict === 'NOISE')
      return `<span class="conv conv-cal" title="Rank-IC ${ic} over ${c.n} — the AI's ${label} score hasn't ordered excess. Treat the conviction dots as descriptive, not a ranking.">🎯 AI ${label}: no edge yet · IC ${ic} (n${c.n})</span>`;
    return `<span class="conv conv-cal" title="Not enough resolved picks yet to test whether the AI's ${label} predicts (${c.n}/${c.minN}).">🎯 ${label} check: calibrating ${c.n}/${c.minN}</span>`;
  }
  // Sort picks by Layer 2 first (PROVEN classes float up, DUD sink), then — ONLY when the
  // screener's conviction has proven predictive (Layer 3b) — order within a class by that
  // conviction: CALIBRATED ranks higher-conviction first, INVERTED ranks it last. When the
  // conviction is NOISE / still CALIBRATING, the server's own rank is preserved (stable sort).
  function calibSort(section, items) {
    const rank = it => CALIB_VRANK[(calibFor(section, it) || {}).verdict || 'CALIBRATING'];
    const cv = convAttr(section);
    const dir = cv && cv.verdict === 'CALIBRATED' ? 1 : cv && cv.verdict === 'INVERTED' ? -1 : 0;
    const key = PREDICT_CONV[section];
    return [...items].sort((a, b) => {
      const pr = rank(a) - rank(b);
      if (pr !== 0 || !dir || !key) return pr;                 // Layer 2 primary; else keep order
      const ca = a[key], cb = b[key];
      if (!Number.isFinite(ca) || !Number.isFinite(cb)) return 0;
      return (cb - ca) * dir;                                  // Layer 3b: within-class conviction
    });
  }
  // Layer-1 badge: the class's real, sector-relative track record on this card.
  function calibBadge(c) {
    if (!c || !c.n) return '';
    if (c.verdict === 'PROVEN')
      return `<span class="calib calib-good" title="This class has beaten its sector on ${c.n} resolved pick${c.n === 1 ? '' : 's'} (1-week excess). Wilson 90% floor ${c.lo}% · avg excess ${c.avgExcess > 0 ? '+' : ''}${c.avgExcess}%. Auto-featured.">✅ beats sector ${c.beatRate}% · n${c.n}</span>`;
    if (c.verdict === 'DUD')
      return `<span class="calib calib-bad" title="This class has failed to beat its sector on ${c.n} resolved picks — best-case only ${c.hi}% · avg excess ${c.avgExcess > 0 ? '+' : ''}${c.avgExcess}%. Auto-dimmed and sorted last.">⚠️ lags sector · ${c.beatRate}% · n${c.n}</span>`;
    return `<span class="calib calib-cal" title="Not enough resolved picks yet to grade this class (${c.n}/${c.min}). It's being tracked — the loop stays neutral until the sample matures, so it never acts on noise.">◷ calibrating ${c.n}/${c.min}</span>`;
  }
  // Per-card visual state driven by the class verdict, falling back to the screener's own
  // "good class" heuristic while a class is still calibrating. Returns { dim, feat }.
  function calibState(section, it, isGoodClass) {
    const c = calibFor(section, it);
    if (c && c.verdict === 'PROVEN') return { dim: false, feat: true, c };
    if (c && c.verdict === 'DUD') return { dim: true, feat: false, c };
    return { dim: !isGoodClass, feat: false, c };
  }
  const CALIB_LEGEND = '<span class="calib-legend">🔄 <b>Self-tuning:</b> each class shows its live record vs its own sector; classes that prove they can’t beat it are dimmed &amp; sorted last, and proven ones are featured — automatically, once enough picks resolve.</span>';

  // ── Live price + 3-session trend for predict-tab lead cards ─────────────────────────
  // Cards render a placeholder <span class="pulse-live" data-ptick="TICKER">; after render
  // we batch-fetch /api/price?spark=1 (live quote + last ~4 daily closes) and fill in the
  // current price, today's %, and a 3-session sparkline. Makes each lead concrete: where is
  // it now, and which way has it been going. One-shot per render (leads refresh slowly).
  const priceBar = ticker => `<div class="pulse-pricebar"><span class="pulse-live" data-ptick="${esc(ticker)}"></span></div>`;
  function predictPriceHTML(q) {
    const pct = parseFloat(q.changePct);
    const col = pct > 0 ? 'var(--green)' : pct < 0 ? 'var(--red)' : 'var(--text-dim)';
    const dot = `<span class="live-dot live-${(q.marketState || 'CLOSED').toLowerCase()}"></span>`;
    const ext = q.afterHours ? ` <span class="live-ext">${q.afterHours.session === 'pre' ? 'pre' : 'aft'} $${esc(q.afterHours.price)}</span>` : '';
    const px = `<span class="pulse-px">${dot}$${esc(q.price)} <span style="color:${col}">${pct > 0 ? '+' : ''}${esc(q.changePct)}%</span>${ext}</span>`;
    const s = Array.isArray(q.spark) ? q.spark : [];
    if (s.length < 2) return px;
    const mn = Math.min(...s), mx = Math.max(...s), up = s[s.length - 1] >= s[0];
    const chg = s[0] ? ((s[s.length - 1] - s[0]) / s[0]) * 100 : 0;
    const trend = `<span class="pulse-spark" title="Last ${s.length} daily closes: ${s.map(v => '$' + v).join(' → ')}">${sparkSvg(s, mn, mx, up)}</span>`
      + `<span class="pulse-spark-chg" style="color:${up ? 'var(--green)' : 'var(--red)'}">3-sess ${chg > 0 ? '+' : ''}${chg.toFixed(1)}%</span>`;
    return px + trend;
  }
  async function hydratePredictPrices(container) {
    if (!container) return;
    const els = [...container.querySelectorAll('[data-ptick]')];
    const tickers = [...new Set(els.map(e => (e.dataset.ptick || '').toUpperCase()).filter(Boolean))];
    if (!tickers.length) return;
    const quotes = {};
    for (let i = 0; i < tickers.length; i += 12) {           // /api/price caps at 12/call
      const chunk = tickers.slice(i, i + 12);
      try {
        const d = await fetch('/api/price?spark=1&tickers=' + encodeURIComponent(chunk.join(','))).then(r => r.json());
        if (d && !d.error) Object.assign(quotes, d);
      } catch { /* offline / rate-limited — leave the card without a live price */ }
    }
    for (const el of els) {
      const q = quotes[(el.dataset.ptick || '').toUpperCase()];
      if (q) el.innerHTML = predictPriceHTML(q);
    }
  }

  let readthroughLoaded = false;
  function ensureReadThrough() { if (!readthroughLoaded) { readthroughLoaded = true; runReadThroughUI(false); } }
  async function runReadThroughUI(force) {
    const el = document.getElementById('readthrough-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Rebuilding the read-through graph… <span class="dt-dim">(Fable 5 reasons the beneficiaries — can take ~60s)</span>' : 'Loading read-through graph…'}</p></div>`;
    try {
      // Two-stage: a manual Refresh first regenerates the raw Fable graph (Stage 1, slow),
      // then re-enriches (Stage 2). A normal open just hits the fast serve/enrich path.
      if (force) await fetch('/api/tracker?op=readthroughtick').then(r => r.json()).catch(() => {});
      const [p] = await Promise.all([
        fetch('/api/tracker?op=readthrough' + (force ? '&force=1' : '')).then(r => r.json()),
        loadCalibration(),
      ]);
      renderReadThrough(p);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Read-Through.</p></div>`; }
  }
  const RT_LINK = { supplier: ['🔧', 'Supplier'], customer: ['🛒', 'Customer'], tollbooth: ['🛣️', 'Toll-booth'], substitute: ['🔀', 'Substitute'], input_cost: ['⛽', 'Input cost'], partner: ['🤝', 'Partner'] };
  function renderReadThrough(p) {
    const el = document.getElementById('readthrough-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      const why = p && p.error ? ' — ' + esc(p.error) : (p && !(p.items || []).length ? ' — no read-throughs from the latest gappers yet' : '');
      el.innerHTML = `<div class="mom-status error"><p>Read-Through is warming up${why}. It builds off the day's Gap & Go movers — try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('readthrough-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· ${p.triggerDate ? 'from ' + esc(p.triggerDate) + ' gappers · ' : ''}updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;
    const dots = n => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));
    const trig = (p.triggers || []).map(t => `<span class="pulse-tk">$${esc(t.ticker)}${t.gapPct != null ? ' +' + t.gapPct + '%' : ''}</span>`).join(' ');
    const card = it => {
      const [le, ll] = RT_LINK[it.link_type] || RT_LINK.partner;
      const mv = it.moved || {};
      const { dim, feat, c } = calibState('ReadThrough', it, mv.alreadyMoved === false);
      const tape = mv.alreadyMoved === true
        ? `<span class="rt-tape rt-moved" title="Already moved ${mv.movedPct}% today — likely priced in">⚪ moved ${mv.movedPct > 0 ? '+' : ''}${mv.movedPct}%</span>`
        : mv.alreadyMoved === false
          ? `<span class="rt-tape rt-fresh" title="Hasn't repriced yet (${mv.movedPct != null ? mv.movedPct + '% today' : 'flat'})">🟢 not yet moved${mv.movedPct != null ? ' (' + (mv.movedPct > 0 ? '+' : '') + mv.movedPct + '%)' : ''}</span>`
          : `<span class="rt-tape rt-unknown" title="Tape unavailable">◽ tape n/a</span>`;
      return `<div class="pulse-card${dim ? ' rt-dim' : ''}${feat ? ' calib-feat' : ''}">
        <div class="pulse-top">
          <span class="pulse-head"><b>$${esc(it.beneficiary_ticker)}</b> ${esc(it.beneficiary_name || '')}</span>
          ${tape}
        </div>
        ${priceBar(it.beneficiary_ticker)}
        ${c ? `<div class="pulse-calib">${calibBadge(c)}</div>` : ''}
        <div class="pulse-meta">
          <span class="rt-link" title="${esc(ll)} relationship">${le} ${esc(ll)}</span>
          <span class="rt-from">← $${esc(it.trigger_ticker)}</span>
          <span class="rt-direct" title="Directness of the link (5 = single-name dependency)">${dots(it.directness)}</span>
        </div>
        <div class="pulse-idea"><b>Link:</b> ${esc(it.mechanism)}</div>
        <div class="pulse-why">${esc(it.thesis)}</div>
        ${it.caution ? `<div class="pulse-caution">⚠️ ${esc(it.caution)}</div>` : ''}
      </div>`;
    };
    el.innerHTML = `
      <div class="dt-note" style="border-left-color:#14b8a6"><b>🔗 Second-order read-throughs.</b> ${esc(p.disclaimer || '')} ${p.stale ? '<b>(showing last snapshot — refresh to update)</b>' : ''} ${CALIB_LEGEND} ${convictionLine('ReadThrough')}</div>
      ${trig ? `<div class="rt-triggers">Off today's movers: ${trig}</div>` : ''}
      <div class="pulse-grid">${calibSort('ReadThrough', p.items).map(card).join('')}</div>`;
    hydratePredictPrices(el);
    const rb = document.getElementById('readthrough-refresh-btn');
    if (rb) rb.onclick = () => runReadThroughUI(true);
  }

  // ── 🕵️ STEALTH (ANOMALY-FIRST) — names moving up on volume with NO news; an AI
  // investigator (server-side lib/anomaly-routes.js, Sonnet 5 + web search) classifies
  // each as ACCUMULATION (no catalyst found — possible stealth buying), EXPLAINED (a
  // public reason exists — priced), or NOISE. A LEAD to forward-track, not a buy signal.
  let anomalyLoaded = false;
  function ensureAnomaly() { if (!anomalyLoaded) { anomalyLoaded = true; runAnomalyUI(false); } }
  async function runAnomalyUI(force) {
    const el = document.getElementById('anomaly-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Re-scanning for unexplained movers & investigating… <span class="dt-dim">(the AI web-searches each — ~50s)</span>' : 'Loading the anomaly scan…'}</p></div>`;
    try {
      if (force) await fetch('/api/tracker?op=anomalytick').then(r => r.json()).catch(() => {});
      const [p] = await Promise.all([fetch('/api/tracker?op=anomaly').then(r => r.json()), loadCalibration()]);
      renderAnomaly(p);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the Stealth scan.</p></div>`; }
  }
  const ANOM_CLASS = { ACCUMULATION: ['🕵️', 'var(--green)', 'Accumulation'], EXPLAINED: ['📰', 'var(--text-dim)', 'Explained'], NOISE: ['🌫️', 'var(--text-dim)', 'Noise'] };
  function renderAnomaly(p) {
    const el = document.getElementById('anomaly-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      const why = p && p.error ? ' — ' + esc(p.error) : (p && p.ok ? ' — no unexplained movers on the latest tape' : '');
      el.innerHTML = `<div class="mom-status error"><p>Stealth scan is warming up${why}. It looks for names moving on volume with no news — try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('anomaly-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· ${p.asOf ? 'as of ' + esc(p.asOf) + ' · ' : ''}updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;
    const dots = n => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));
    const cand = t => (p.candidates || []).find(c => c.ticker === t) || {};
    const card = it => {
      const [ce, cc, cl] = ANOM_CLASS[it.classification] || ANOM_CLASS.NOISE;
      const c = cand(it.ticker);
      const move = c.pct5d != null ? `<span class="anom-move">+${c.pct5d}% / ${c.relVol}x vol</span>` : '';
      const { dim, feat, c: cal } = calibState('Anomaly', it, it.classification === 'ACCUMULATION');
      return `<div class="pulse-card${dim ? ' rt-dim' : ''}${feat ? ' calib-feat' : ''}">
        <div class="pulse-top">
          <span class="pulse-head"><b>$${esc(it.ticker)}</b> ${move}</span>
          <span class="anom-class" style="color:${cc}" title="${esc(cl)}">${ce} ${esc(cl)} <span class="anom-conf" title="Confidence">${dots(it.confidence)}</span></span>
        </div>
        ${priceBar(it.ticker)}
        ${cal ? `<div class="pulse-calib">${calibBadge(cal)}</div>` : ''}
        <div class="pulse-idea"><b>${it.classification === 'ACCUMULATION' ? 'No catalyst found:' : 'Reason:'}</b> ${esc(it.reason_found)}</div>
        <div class="pulse-why">${esc(it.thesis)}</div>
        ${it.caution ? `<div class="pulse-caution">⚠️ ${esc(it.caution)}</div>` : ''}
      </div>`;
    };
    el.innerHTML = `
      <div class="dt-note" style="border-left-color:#8b5cf6"><b>🕵️ Unexplained movers.</b> ${esc(p.disclaimer || '')} ${p.stale ? '<b>(showing last snapshot — refresh to update)</b>' : ''} ${CALIB_LEGEND} ${convictionLine('Anomaly')}</div>
      <div class="anom-meta">Scanned the tape → ${p.detected != null ? p.detected + ' movers, ' : ''}${p.noNews != null ? p.noNews + ' with no news' : ''} → investigated ${(p.items || []).length}.</div>
      <div class="pulse-grid">${calibSort('Anomaly', p.items).map(card).join('')}</div>`;
    hydratePredictPrices(el);
    const rb = document.getElementById('anomaly-refresh-btn');
    if (rb) rb.onclick = () => runAnomalyUI(true);
  }

  // ── 🧬 BIOTECH RADAR — biotech names that just started running (micro→large), scored 0–100
  // by a catalyst-aware model (server-side lib/biotech-routes.js). An AI investigator (Haiku +
  // web search) finds WHY each is moving — or flags it Unknown — and the score penalizes
  // dilution risk & pump-and-dump traps. Benchmarked vs XBI, the biotech ETF.
  let biotechLoaded = false;
  function ensureBiotech() { if (!biotechLoaded) { biotechLoaded = true; runBiotechUI(false); } }
  async function runBiotechUI(force) {
    const el = document.getElementById('biotech-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Re-scanning biotech for early runners & investigating each… <span class="dt-dim">(the AI web-searches each — ~50s)</span>' : 'Loading the biotech scan…'}</p></div>`;
    try {
      if (force) await fetch('/api/tracker?op=biotechtick').then(r => r.json()).catch(() => {});
      const [p] = await Promise.all([fetch('/api/tracker?op=biotech').then(r => r.json()), loadCalibration()]);
      renderBiotech(p);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the Biotech Radar.</p></div>`; }
  }
  // Catalyst class → [emoji, colour, label] for the reason chip.
  const BIO_CLASS = {
    FDA: ['💊', 'var(--green)', 'FDA / Regulatory'], DATA: ['🧪', 'var(--green)', 'Clinical Data'],
    MA: ['🤝', 'var(--green)', 'M&A / Buyout'], PARTNER: ['🔗', 'var(--text)', 'Partnership'],
    ANALYST: ['📈', 'var(--text-dim)', 'Analyst'], SYMPATHY: ['🌊', 'var(--text-dim)', 'Sympathy'],
    FINANCING: ['💧', 'var(--red)', 'Financing / Dilution'], STEALTH: ['🕵️', 'var(--text)', 'Stealth (no news)'],
    NOISE: ['🌫️', 'var(--text-dim)', 'Noise'],
  };
  const bioTierColor = t => t === 'Hot' ? '#10b981' : t === 'Emerging' ? '#eab308' : 'var(--text-dim)';
  function renderBiotech(p) {
    const el = document.getElementById('biotech-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      const why = p && p.error ? ' — ' + esc(p.error) : (p && p.ok ? ' — no biotech runners on the latest tape' : '');
      el.innerHTML = `<div class="mom-status error"><p>Biotech Radar is warming up${why}. It scans ~200 biotech names for early runners — try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('biotech-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· ${p.asOf ? 'as of ' + esc(p.asOf) + ' · ' : ''}updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;
    const dots = n => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));
    const card = it => {
      const [ce, cc, cl] = BIO_CLASS[it.classification] || BIO_CLASS.NOISE;
      const { dim, feat, c: cal } = calibState('Biotech', it, it.tier === 'Hot');
      const tc = bioTierColor(it.tier);
      const move = `<span class="anom-move">+${it.pct5d}% / ${it.relVol}x vol${it.runAge != null ? ` · day ~${it.runAge}` : ''}${it.adrDaysConsumed != null ? ` · ${it.adrDaysConsumed} ADR-days` : ''}</span>`;
      // Evidence + timing chips (Fable B1/B8): reaction-to-catalyst vs running-into-a-binary.
      const evChip = it.evidence ? `<span class="bio-chip" title="Evidence grade">${it.evidence === 'Verified' ? '✅ Verified' : it.evidence === 'Inferred' ? '≈ Inferred' : '❔ Unconfirmed'}</span>` : '';
      const tmChip = it.catalyst_timing === 'Ahead'
        ? `<span class="bio-chip bio-warn" title="Running INTO a dated binary event — holding through it risks a large gap either way">⚠️ binary ahead</span>`
        : it.catalyst_timing === 'Behind' ? `<span class="bio-chip" title="Reacting to a catalyst already out — no pending binary event">↩︎ reaction</span>` : '';
      const subChip = it.subsector ? `<span class="bio-chip">${esc(it.subsector)}</span>` : '';
      const dilChip = it.dilution_risk && it.dilution_risk !== 'None' ? `<span class="bio-chip${it.dilution_risk === 'High' ? ' bio-warn' : ''}" title="Dilution / offering risk">💧 ${esc(it.dilution_risk)} dilution risk</span>` : '';
      // Trap-flag row (Fable B6).
      const fl = it.flags || {};
      const flags = [fl.dilutionHigh ? '💧 offering risk' : '', fl.serialSpiker ? '🔁 serial spike-fade' : '', fl.penny ? '💵 sub-$2' : '', fl.overextended ? '📛 overextended' : ''].filter(Boolean);
      const flagRow = flags.length ? `<div class="bio-flags">${flags.map(f => `<span class="bio-flag">${f}</span>`).join('')}</div>` : '';
      return `<div class="pulse-card${dim ? ' rt-dim' : ''}${feat ? ' calib-feat' : ''}">
        <div class="pulse-top">
          <span class="pulse-head"><b>$${esc(it.ticker)}</b> ${move}</span>
          <span class="bio-score" style="color:${tc};border-color:${tc}" title="Biotech Radar score (0–100; 100 = highest conviction)">${it.score}<span class="bio-score-max">/100</span> · ${esc(it.tier)}</span>
        </div>
        ${priceBar(it.ticker)}
        ${cal ? `<div class="pulse-calib">${calibBadge(cal)}</div>` : ''}
        <div class="pulse-idea"><span style="color:${cc}">${ce} <b>${esc(cl)}</b></span> — ${esc(it.reason)}</div>
        <div class="bio-chips">${evChip}${tmChip}${dilChip}${subChip}<span class="anom-conf" title="AI confidence">${dots(it.confidence)}</span></div>
        ${it.thesis ? `<div class="pulse-why">${esc(it.thesis)}</div>` : ''}
        ${it.bear_case ? `<div class="pulse-caution" style="border-left-color:#ef4444">🐻 <b>Bear:</b> ${esc(it.bear_case)}</div>` : ''}
        ${it.caution ? `<div class="pulse-caution">⚠️ ${esc(it.caution)}</div>` : ''}
        ${flagRow}
      </div>`;
    };
    el.innerHTML = `
      <div class="dt-note" style="border-left-color:#10b981"><b>🧬 Biotech Radar.</b> ${esc(p.disclaimer || '')} ${p.stale ? '<b>(showing last snapshot — refresh to update)</b>' : ''} ${CALIB_LEGEND} ${convictionLine('Biotech')}</div>
      <div class="anom-meta">Scanned ~200 biotech names → ${p.detected != null ? p.detected + ' early runners' : ''}${p.regime ? ' · macro ' + esc(p.regime) : ''}${p.etfPct5d != null ? ' · XBI 5d ' + (p.etfPct5d > 0 ? '+' : '') + p.etfPct5d + '%' : ''} → scored + investigated ${(p.items || []).length}.</div>
      <div class="pulse-grid">${calibSort('Biotech', p.items).map(card).join('')}</div>`;
    hydratePredictPrices(el);
    const rb = document.getElementById('biotech-refresh-btn');
    if (rb) rb.onclick = () => runBiotechUI(true);
  }

  // ── 🌊 SECOND WAVE — first-leg movers the crowd hasn't piled into yet; an AI forecasts
  // a reflexive SECOND wave (server-side lib/secondwave-routes.js, Sonnet 5 + web search).
  // PRIMED = fresh story, crowd light; EARLY = needs a trigger; FADED = already crowded.
  let secondwaveLoaded = false;
  function ensureSecondWave() { if (!secondwaveLoaded) { secondwaveLoaded = true; runSecondWaveUI(false); } }
  async function runSecondWaveUI(force) {
    const el = document.getElementById('secondwave-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Re-scanning first-leg movers & forecasting second waves… <span class="dt-dim">(the AI gauges the crowd — ~50s)</span>' : 'Loading the second-wave scan…'}</p></div>`;
    try {
      if (force) await fetch('/api/tracker?op=secondwavetick').then(r => r.json()).catch(() => {});
      const [p] = await Promise.all([fetch('/api/tracker?op=secondwave').then(r => r.json()), loadCalibration()]);
      renderSecondWave(p);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the Second Wave scan.</p></div>`; }
  }
  const SW_CLASS = { PRIMED: ['🌊', 'var(--green)', 'Primed'], EARLY: ['🌱', '#f59e0b', 'Early'], FADED: ['🥱', 'var(--text-dim)', 'Faded'] };
  function renderSecondWave(p) {
    const el = document.getElementById('secondwave-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      const why = p && p.error ? ' — ' + esc(p.error) : (p && p.ok ? ' — no first-leg movers on the latest tape' : '');
      el.innerHTML = `<div class="mom-status error"><p>Second Wave is warming up${why}. It looks for early movers the crowd hasn’t found yet — try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('secondwave-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· ${p.asOf ? 'as of ' + esc(p.asOf) + ' · ' : ''}updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;
    const dots = n => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));
    const cand = t => (p.candidates || []).find(c => c.ticker === t) || {};
    const card = it => {
      const [ce, cc, cl] = SW_CLASS[it.classification] || SW_CLASS.EARLY;
      const c = cand(it.ticker);
      const move = c.ret10 != null ? `<span class="anom-move">+${c.ret10}% / ${c.relVol}x vol</span>` : '';
      const { dim, feat, c: cal } = calibState('SecondWave', it, it.classification === 'PRIMED');
      return `<div class="pulse-card${dim ? ' rt-dim' : ''}${feat ? ' calib-feat' : ''}">
        <div class="pulse-top">
          <span class="pulse-head"><b>$${esc(it.ticker)}</b> ${move}</span>
          <span class="anom-class" style="color:${cc}" title="${esc(cl)}">${ce} ${esc(cl)} <span class="anom-conf" title="Virality potential">${dots(it.virality)}</span></span>
        </div>
        ${priceBar(it.ticker)}
        ${cal ? `<div class="pulse-calib">${calibBadge(cal)}</div>` : ''}
        <div class="pulse-idea"><b>Catalyst:</b> ${esc(it.catalyst)}</div>
        <div class="pulse-meta"><span class="sw-crowd">Crowd: ${esc(it.crowd_state || '—')}</span></div>
        <div class="pulse-why">${esc(it.thesis)}</div>
        ${it.caution ? `<div class="pulse-caution">⚠️ ${esc(it.caution)}</div>` : ''}
      </div>`;
    };
    el.innerHTML = `
      <div class="dt-note" style="border-left-color:#0ea5e9"><b>🌊 Reflexive second waves.</b> ${esc(p.disclaimer || '')} ${p.stale ? '<b>(showing last snapshot — refresh to update)</b>' : ''} ${CALIB_LEGEND} ${convictionLine('SecondWave')}</div>
      <div class="anom-meta">${p.detected != null ? 'Found ' + p.detected + ' first-leg movers → ' : ''}forecast ${(p.items || []).length}.</div>
      <div class="pulse-grid">${calibSort('SecondWave', p.items).map(card).join('')}</div>`;
    hydratePredictPrices(el);
    const rb = document.getElementById('secondwave-refresh-btn');
    if (rb) rb.onclick = () => runSecondWaveUI(true);
  }

  // ── 🌐 CROSS-ASSET — US stocks levered to a move in another asset (commodity / overnight
  // foreign market / crypto / rates) they haven't caught up to. Server-side (Haiku 5 + web
  // search) sweeps the tells; our tape confirms the stock is still lagging. LEAD = lagging.
  let crossassetLoaded = false;
  function ensureCrossAsset() { if (!crossassetLoaded) { crossassetLoaded = true; runCrossAssetUI(false); } }
  async function runCrossAssetUI(force) {
    const el = document.getElementById('crossasset-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Sweeping commodities, overnight markets, crypto & rates… <span class="dt-dim">(~45s)</span>' : 'Loading the cross-asset scan…'}</p></div>`;
    try {
      if (force) await fetch('/api/tracker?op=crossassettick').then(r => r.json()).catch(() => {});
      const [p] = await Promise.all([fetch('/api/tracker?op=crossasset').then(r => r.json()), loadCalibration()]);
      renderCrossAsset(p);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the Cross-Asset scan.</p></div>`; }
  }
  const CA_CLASS = { LEAD: ['🌐', 'var(--green)', 'Lead (lagging)'], INLINE: ['🔗', 'var(--text-dim)', 'Inline'], WEAK: ['🌫️', 'var(--text-dim)', 'Weak'] };
  function renderCrossAsset(p) {
    const el = document.getElementById('crossasset-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      const why = p && p.error ? ' — ' + esc(p.error) : (p && p.ok ? ' — no clear cross-asset leads right now' : '');
      el.innerHTML = `<div class="mom-status error"><p>Cross-Asset is warming up${why}. It maps commodity/overnight/crypto moves to lagging US stocks — try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('crossasset-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· ${p.asOf ? 'as of ' + esc(p.asOf) + ' · ' : ''}updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;
    const dots = n => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));
    const card = it => {
      const [ce, cc, cl] = CA_CLASS[it.classification] || CA_CLASS.WEAK;
      const mv = it.movedPct != null ? `<span class="anom-move" style="color:${it.movedPct >= 0 ? 'var(--green)' : 'var(--red)'}">today ${it.movedPct > 0 ? '+' : ''}${it.movedPct}%</span>` : '';
      const { dim, feat, c: cal } = calibState('CrossAsset', it, it.classification === 'LEAD');
      return `<div class="pulse-card${dim ? ' rt-dim' : ''}${feat ? ' calib-feat' : ''}">
        <div class="pulse-top">
          <span class="pulse-head"><b>$${esc(it.ticker)}</b> ${mv}</span>
          <span class="anom-class" style="color:${cc}" title="${esc(cl)}">${ce} ${esc(cl)} <span class="anom-conf">${dots(it.confidence)}</span></span>
        </div>
        ${priceBar(it.ticker)}
        ${cal ? `<div class="pulse-calib">${calibBadge(cal)}</div>` : ''}
        <div class="pulse-idea"><b>Tell:</b> ${esc(it.lead_asset)}</div>
        <div class="pulse-meta"><span class="sw-crowd">${esc(it.linkage)}</span></div>
        <div class="pulse-why">${esc(it.thesis)}</div>
        ${it.caution ? `<div class="pulse-caution">⚠️ ${esc(it.caution)}</div>` : ''}
      </div>`;
    };
    el.innerHTML = `
      <div class="dt-note" style="border-left-color:#f97316"><b>🌐 Cross-asset tells.</b> ${esc(p.disclaimer || '')} ${p.stale ? '<b>(showing last snapshot — refresh to update)</b>' : ''} ${CALIB_LEGEND} ${convictionLine('CrossAsset')}</div>
      <div class="pulse-grid">${calibSort('CrossAsset', p.items).map(card).join('')}</div>`;
    hydratePredictPrices(el);
    const rb = document.getElementById('crossasset-refresh-btn');
    if (rb) rb.onclick = () => runCrossAssetUI(true);
  }

  // ── 🎚️ TONE SHIFT — earnings-call language DELTA vs the prior quarter (server-side
  // lib/toneshift-routes.js, Haiku 5 + web search). BRIGHTENING = more confident than last
  // quarter; DARKENING = more cautious. A slower swing-horizon lead, forward-tracked.
  let toneshiftLoaded = false;
  function ensureToneShift() { if (!toneshiftLoaded) { toneshiftLoaded = true; runToneShiftUI(false); } }
  async function runToneShiftUI(force) {
    const el = document.getElementById('toneshift-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${force ? 'Comparing recent calls to last quarter’s tone… <span class="dt-dim">(~45s)</span>' : 'Loading the tone-shift scan…'}</p></div>`;
    try {
      if (force) await fetch('/api/tracker?op=toneshifttick').then(r => r.json()).catch(() => {});
      const [p] = await Promise.all([fetch('/api/tracker?op=toneshift').then(r => r.json()), loadCalibration()]);
      renderToneShift(p);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the Tone Shift scan.</p></div>`; }
  }
  const TS_CLASS = { BRIGHTENING: ['📈', 'var(--green)', 'Brightening'], STABLE: ['➖', 'var(--text-dim)', 'Stable'], DARKENING: ['📉', 'var(--red)', 'Darkening'] };
  function renderToneShift(p) {
    const el = document.getElementById('toneshift-container');
    if (!el) return;
    if (!p || !p.ok || !(p.items || []).length) {
      const why = p && p.error ? ' — ' + esc(p.error) : (p && p.ok ? ' — no recent reporters to compare yet' : '');
      el.innerHTML = `<div class="mom-status error"><p>Tone Shift is warming up${why}. It compares recent earnings calls to last quarter — try Refresh in a moment.</p></div>`;
      return;
    }
    const gt = document.getElementById('toneshift-gen-time');
    if (gt && p.generatedAt) gt.textContent = `· ${p.asOf ? 'as of ' + esc(p.asOf) + ' · ' : ''}updated ${p.ageMins != null && p.ageMins < 90 ? (p.ageMins + 'm ago') : new Date(p.generatedAt).toLocaleString()}`;
    const dots = n => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));
    const card = it => {
      const [ce, cc, cl] = TS_CLASS[it.shift] || TS_CLASS.STABLE;
      const { dim, feat, c: cal } = calibState('ToneShift', it, it.shift === 'BRIGHTENING');
      return `<div class="pulse-card${dim ? ' rt-dim' : ''}${feat ? ' calib-feat' : ''}">
        <div class="pulse-top">
          <span class="pulse-head"><b>$${esc(it.ticker)}</b></span>
          <span class="anom-class" style="color:${cc}" title="${esc(cl)}">${ce} ${esc(cl)} <span class="anom-conf">${dots(it.confidence)}</span></span>
        </div>
        ${priceBar(it.ticker)}
        ${cal ? `<div class="pulse-calib">${calibBadge(cal)}</div>` : ''}
        <div class="pulse-idea"><b>Change:</b> ${esc(it.change)}</div>
        <div class="pulse-why">${esc(it.thesis)}</div>
        ${it.caution ? `<div class="pulse-caution">⚠️ ${esc(it.caution)}</div>` : ''}
      </div>`;
    };
    el.innerHTML = `
      <div class="dt-note" style="border-left-color:#a855f7"><b>🎚️ Earnings tone shifts.</b> ${esc(p.disclaimer || '')} ${p.stale ? '<b>(showing last snapshot — refresh to update)</b>' : ''} ${CALIB_LEGEND} ${convictionLine('ToneShift')}</div>
      <div class="pulse-grid">${calibSort('ToneShift', p.items).map(card).join('')}</div>`;
    hydratePredictPrices(el);
    const rb = document.getElementById('toneshift-refresh-btn');
    if (rb) rb.onclick = () => runToneShiftUI(true);
  }

  // ── 🗞️ DAILY GAME PLAN — news + sentiment + the app's own signals synthesized
  // (server-side, lib/gameplan.js) into one succinct plan + predictions, tiered
  // novice↔pro, building on a rolling multi-day narrative. UI just renders op=gameplan.
  let gameplanLoaded = false;
  function ensureGamePlan() { if (!gameplanLoaded) { gameplanLoaded = true; runGamePlanUI(false); } }
  const GP_TONE_COL = { 'risk-off': 'var(--red)', cautious: 'var(--amber,#f59e0b)', neutral: 'var(--text-dim)', constructive: '#3b82f6', 'risk-on': 'var(--green)' };
  const GP_CONF_COL = { high: 'var(--green)', medium: 'var(--amber,#f59e0b)', low: 'var(--text-dim)' };
  async function runGamePlanUI(refresh) {
    const el = document.getElementById('gameplan-container'); if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>${refresh ? 'Rebuilding today’s game plan from the latest headlines… (this can take ~30s)' : 'Loading today’s game plan…'}</p></div>`;
    try {
      const g = await fetch(`/api/tracker?op=gameplan${refresh ? '&refresh=1' : ''}`).then(r => r.json()).catch(() => null);
      if (!g || !g.ok) { el.innerHTML = `<div class="mom-status error"><p>Could not build the game plan${g && g.error ? ' — ' + esc(g.error) : ''}.</p><button class="dt-btn" id="gp-retry">Try rebuild</button></div>`; const b = document.getElementById('gp-retry'); if (b) b.onclick = () => runGamePlanUI(true); return; }
      renderGamePlan(g);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the game plan.</p></div>`; }
  }
  function gpList(items, col) {
    if (!items || !items.length) return `<div class="rot-sub dt-dim">—</div>`;
    return `<ul class="gp-list" style="margin:4px 0 0;padding-left:18px">${items.map(x => `<li style="margin:3px 0">${esc(x)}</li>`).join('')}</ul>`;
  }
  function renderGamePlan(g) {
    const el = document.getElementById('gameplan-container'); if (!el) return;
    const s = g.sentiment || {}; const col = GP_TONE_COL[s.tone] || GP_TONE_COL.neutral;
    const when = g.generatedAt ? new Date(g.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : g.date;
    const inp = g.inputs || {};
    // Hero: sentiment + headline
    const hero = `<div class="rot-panel" style="border-left:4px solid ${col}">`
      + `<div class="rot-head" style="font-size:1.05rem;color:${col};text-transform:capitalize">${esc(s.tone || 'neutral')} · ${esc(s.oneLiner || '')}</div>`
      + `<div class="rot-sub" style="font-size:1rem;margin-top:6px"><b>${esc(g.headline || '')}</b></div>`
      + `<div class="rot-sub dt-dim" style="margin-top:6px">${esc(when)} · regime <b>${esc(inp.regime || '?')}</b>${inp.vix != null ? ` · VIX ${(+inp.vix).toFixed(1)}` : ''} · ${inp.headlineCount || 0} headlines · ${esc(g.model || '')}</div></div>`;
    // Novice / Pro toggle
    const tiers = `<div class="rot-panel" style="margin-top:12px"><div class="gp-tier-tabs" style="display:flex;gap:8px;margin-bottom:8px">`
      + `<button class="dt-btn gp-tier-btn gp-active" data-tier="novice">👶 Plain English</button>`
      + `<button class="dt-btn gp-tier-btn" data-tier="pro">🎯 Pro</button></div>`
      + `<div class="rot-sub gp-tier-body" data-tier="novice">${esc(g.novice || '')}</div>`
      + `<div class="rot-sub gp-tier-body" data-tier="pro" style="display:none">${esc(g.pro || '')}</div></div>`;
    // Drivers
    const drivers = `<div class="rot-head" style="margin-top:14px">📰 What’s moving the tape</div><div class="rot-panel" style="margin-top:6px">`
      + (g.drivers || []).map(d => `<div class="gp-driver" style="padding:6px 0;border-bottom:1px solid var(--border,#222)">`
        + `<div><b>${esc(d.story || '')}</b></div>`
        + `<div class="rot-sub" style="margin-top:2px">↳ ${esc(d.soWhat || '')}</div>`
        + ((d.tickers && d.tickers.length) ? `<div class="dt-dim" style="font-size:0.78rem;margin-top:2px">${d.tickers.map(t => esc(t)).join(' · ')}</div>` : '')
        + `</div>`).join('') + `</div>`;
    // Game plan: lean / avoid / watch
    const gp = g.gamePlan || {};
    const plan = `<div class="rot-head" style="margin-top:14px">🧭 The plan</div><div class="rot-panel" style="margin-top:6px">`
      + `<div class="rot-sub"><b style="color:var(--green)">Lean into</b></div>${gpList(gp.lean)}`
      + `<div class="rot-sub" style="margin-top:8px"><b style="color:var(--red)">Avoid / fade</b></div>${gpList(gp.avoid)}`
      + `<div class="rot-sub" style="margin-top:8px"><b style="color:var(--amber,#f59e0b)">Watch next</b></div>${gpList(gp.watch)}</div>`;
    // Predictions
    const preds = `<div class="rot-head" style="margin-top:14px">🔮 Calls for the coming days</div><div class="rot-panel" style="margin-top:6px">`
      + (g.predictions || []).map(p => `<div style="padding:6px 0;border-bottom:1px solid var(--border,#222)">`
        + `<div><span style="color:${GP_CONF_COL[p.confidence] || 'var(--text-dim)'};font-weight:600;text-transform:uppercase;font-size:0.72rem">${esc(p.confidence || '')}</span> <span class="dt-dim" style="font-size:0.78rem">· ${esc(p.horizon || '')}</span></div>`
        + `<div style="margin-top:2px"><b>${esc(p.call || '')}</b></div>`
        + `<div class="rot-sub dt-dim" style="margin-top:2px">${esc(p.rationale || '')}</div></div>`).join('') + `</div>`;
    // Narrative + refresh
    const narr = g.narrativeUpdate ? `<div class="dt-note" style="margin-top:12px"><b>📖 Running narrative:</b> ${esc(g.narrativeUpdate)}</div>` : '';
    const foot = `<div style="margin-top:12px;display:flex;align-items:center;gap:10px">`
      + `<button class="dt-btn" id="gp-refresh">🔄 Rebuild from latest news</button>`
      + `<span class="dt-dim" style="font-size:0.78rem">A synthesis of the day’s news + the app’s own signals — not financial advice. Predictions are falsifiable hypotheses, not guarantees.</span></div>`;
    el.innerHTML = hero + tiers + drivers + plan + preds + narr + foot;
    // wire tier toggle + refresh
    el.querySelectorAll('.gp-tier-btn').forEach(btn => btn.onclick = () => {
      el.querySelectorAll('.gp-tier-btn').forEach(b => b.classList.toggle('gp-active', b === btn));
      el.querySelectorAll('.gp-tier-body').forEach(b => b.style.display = b.dataset.tier === btn.dataset.tier ? '' : 'none');
    });
    const rb = document.getElementById('gp-refresh'); if (rb) rb.onclick = () => runGamePlanUI(true);
  }

  let briefLoaded = false;
  function ensureBrief() { if (!briefLoaded) { briefLoaded = true; runBriefUI(); } }
  async function runBriefUI() {
    const el = document.getElementById('brief-container'); if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Synthesizing forecasts, the crowd &amp; sharp money…</p></div>`;
    try {
      const b = await fetch('/api/tracker?op=brief').then(r => r.json()).catch(() => null);
      if (!b || !b.ok) { el.innerHTML = `<div class="mom-status error"><p>Could not build the brief.</p></div>`; return; }
      renderBrief(b);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not build the brief.</p></div>`; }
  }
  function briefSignalRow(s, b) {
    const [ar, lbl, c] = LEAN_TXT[s.sign] || LEAN_TXT[0];
    let detail = '';
    if (s.name === 'Forecast') detail = b.topFc ? `${esc(b.topFc.claim || b.topFc.text || '')}` : 'no open forecasts';
    else if (s.name === 'Crowd') detail = b.topMover ? `${esc((b.topMover.title || '').slice(0, 48))} ${b.topMover.movePts ? '· ' + b.topMover.movePts + 'pt move' : ''}` : 'quiet';
    else detail = b.sharpCount ? `${b.sharpCount} flagged informed bet${b.sharpCount > 1 ? 's' : ''}` : 'no active signal';
    return `<div class="bt-ic-row brief-sig" data-go="${s.go}"><span><b>${s.name}</b> <span style="color:${c}">${ar} ${lbl}</span></span>`
      + `<span class="dt-dim" style="text-align:right;max-width:60%">${detail}</span></div>`;
  }
  function renderBrief(b) {
    const el = document.getElementById('brief-container'); if (!el) return;
    const regLbl = (b.regime || '').toUpperCase();
    const col = TONE_COL[b.tone] || TONE_COL.neutral;
    const TL = b.themeLabels || {};
    // Hero stance
    const hero = `<div class="rot-panel" style="border-left:4px solid ${col}"><div class="rot-head" style="font-size:1.05rem;color:${col}">🧭 ${esc(b.stance)}</div>`
      + `<div class="rot-sub">Next 1–3 weeks. Market is <b>${L('regime', regLbl)}</b>, tape <b>${L('tape', b.cond)}</b>${b.efficiency != null ? ` <span class="dt-dim">(${L('trendEff', 'eff ' + b.efficiency)})</span>` : ''}. Synthesized from the three signals below — regime weighted heaviest (the proven lever).</div></div>`;
    // The three signals
    const signals = `<div class="rot-head" style="margin-top:14px">The three signals <span class="dt-dim">· tap to drill in</span></div>`
      + `<div class="rot-panel" style="margin-top:6px">${b.sigs.map(s => briefSignalRow(s, b)).join('')}</div>`;
    // Agreement
    const agreeCol = b.agree >= 2 ? 'var(--green)' : b.activeCount >= 2 ? 'var(--amber,#f59e0b)' : 'var(--text-dim)';
    const agreeNote = b.activeCount === 0 ? 'No directional signal active right now.' : b.agree >= 2 ? 'Independent signals agree — higher conviction.' : 'Signals diverge — lower conviction, stay selective.';
    const agree = `<div class="dt-note" style="border-left-color:${agreeCol}"><b style="color:${agreeCol}">🤝 ${b.agree} of ${b.sigs.length} signals align.</b> ${agreeNote}</div>`;
    // Equity translation
    const chip = (x, cls) => `<span class="brief-eq ${cls}"><b>${esc(x.etf)}</b> ${esc(x.name)} <span class="dt-dim">· ${esc(x.why)}</span></span>`;
    let equity = `<div class="rot-head" style="margin-top:14px">📊 What it implies for stocks</div>`;
    if (b.favored.length || b.pressured.length) {
      equity += `<div class="rot-panel" style="margin-top:6px">`;
      if (b.favored.length) equity += `<div class="rot-sub" style="margin-bottom:6px"><b style="color:var(--green)">Favored:</b><br>${b.favored.map(x => chip(x, 'eq-fav')).join(' ')}</div>`;
      if (b.pressured.length) equity += `<div class="rot-sub"><b style="color:var(--red)">Pressured:</b><br>${b.pressured.map(x => chip(x, 'eq-pre')).join(' ')}</div>`;
      equity += `</div>`;
    } else equity += `<div class="dt-note">No clear sector tilt from the current signals.</div>`;
    if (b.themes.length) equity += `<div class="rot-sub dt-dim" style="margin-top:6px">Themes in play: ${b.themes.map(t => TL[t] || t).join(' · ')}.</div>`;
    // Validation track record — does the stance actually precede SPY moves?
    const v = b.validation || {};
    let track = `<div class="rot-head" style="margin-top:16px">📊 Does it work? <span class="dt-dim">· stance vs forward SPY, auto-graded</span></div>`;
    if (v.overall && v.overall.n >= 8) {
      const o = v.overall, lo = o.wilsonLo;
      const tc = lo != null && lo >= 50 ? 'var(--green)' : (o.rate >= 50 ? 'var(--amber,#f59e0b)' : 'var(--red)');
      const bh = [5, 10, 21].map(h => { const x = v.byHorizon[h]; return x && x.n ? `${h}d ${Math.round(x.hits / x.n * 100)}% (${x.n})` : null; }).filter(Boolean).join(' · ');
      const comps = [['regimeScore', 'Regime'], ['fcLean', 'Forecast'], ['crowdLean', 'Crowd'], ['sharpLean', 'Sharp']]
        .map(([k, lbl]) => { const c = v.byComponent[k]; return c && c.n >= 5 ? `<div class="bt-ic-row"><span>${lbl}</span><span style="color:${Math.round(c.hits / c.n * 100) >= 50 ? 'var(--green)' : 'var(--text-dim)'}">${Math.round(c.hits / c.n * 100)}%</span><span class="dt-dim">n=${c.n}</span></div>` : ''; }).join('');
      track += `<div class="dt-note" style="border-left-color:${tc}"><b style="color:${tc}">Stance hit rate: ${o.rate}%</b> of ${o.n} resolved calls (${L('wilsonLB', 'floor ' + (lo != null ? lo + '%' : '—'))}).${bh ? ` <span class="dt-dim">By horizon: ${bh}.</span>` : ''}</div>`;
      if (comps) track += `<div class="rot-panel" style="margin-top:6px"><div class="rot-sub" style="margin-bottom:4px"><b>Which signal carries it?</b> <span class="dt-dim">(hit rate vs forward SPY)</span></div>${comps}</div>`;
    } else {
      track += `<div class="dt-note">⏳ <b>Track record building.</b> ${v.logged || 0} daily stance${(v.logged || 0) === 1 ? '' : 's'} logged${v.n ? `, ${v.n} resolved` : ''} — the hit rate shows once ≥8 mature (first resolves 5 trading days after logging). Every stance is graded against real SPY moves, never self-scored.</div>`;
    }
    const trust = `<div class="trust-badge" style="margin-top:10px">${trustBadgeHTML('brief')}</div>`;
    const caveat = `<div class="fade-caveats" style="margin-top:12px"><p>⚠️ <b>A synthesis, not advice.</b> This blends signals that are themselves weak/unproven — the equity translation is rule-based, not a forecast of returns. Read it as "what the prediction layer is leaning," then confirm with your own work.</p></div>`;
    el.innerHTML = hero + signals + agree + equity + track + trust + caveat;
    el.querySelectorAll('[data-go]').forEach(r => r.addEventListener('click', () => showTab(r.dataset.go)));
    const gt = document.getElementById('brief-gen-time'); if (gt && b.generatedAt) gt.textContent = new Date(b.generatedAt).toLocaleTimeString();
  }
  document.getElementById('brief-refresh-btn')?.addEventListener('click', runBriefUI);

  // ── 🔮 FORECAST — falsifiable AI predictions, auto-graded against real prices ──
  let forecastLoaded = false;
  function ensureForecast() { if (!forecastLoaded) { forecastLoaded = true; runForecastUI(); } }
  async function runForecastUI() {
    const el = document.getElementById('forecast-container'); if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading forecasts &amp; the auto-graded track record…</p></div>`;
    try {
      const [pred, tape] = await Promise.all([
        fetch('/api/tracker?op=predict').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=tape').then(r => r.json()).catch(() => null),
      ]);
      renderForecast(pred, tape);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load forecasts.</p></div>`; }
  }
  const FC_COND = { trending: ['📈', 'trending'], choppy: ['🌊', 'choppy'], mixed: ['🤝', 'mixed'], riskoff: ['🛑', 'risk-off'] };
  const FC_STATUS = { pending: ['⏳', 'var(--text-dim)', 'pending'], correct: ['✓', 'var(--green)', 'correct'], incorrect: ['✗', 'var(--red)', 'missed'] };
  function fcCard(p) {
    const conf = p.confidence ? `<span class="dt-dim">· conviction ${p.confidence}/10</span>` : '';
    const rat = p.rationale ? `<div class="rot-sub" style="margin-top:4px">${esc(p.rationale)}</div>` : '';
    return `<div class="rot-panel" style="margin-top:8px"><div class="bt-ic-row" style="border:0;padding:0 0 4px">`
      + `<span><b>${esc(p.claim)}</b></span><span style="color:var(--text-dim)">${FC_STATUS.pending[0]} ${FC_STATUS.pending[2]}</span></div>`
      + `<div class="rot-sub">${esc(p.text)} ${conf}</div>${rat}</div>`;
  }
  function renderForecast(pred, tape) {
    const el = document.getElementById('forecast-container'); if (!el) return;
    if (!pred || !pred.ok) { el.innerHTML = `<div class="mom-status error"><p>Forecasts unavailable right now.</p></div>`; return; }
    const tok = tape && tape.ok;
    const regime = tok ? tape.regime : (pred.open[0]?.regime || 'neutral');
    const cond = tok ? tape.condition : 'mixed';
    const [ci, clbl] = FC_COND[cond] || FC_COND.mixed;
    const banner = `<div class="rot-panel"><div class="rot-head">${ci} The tape these calls are made into</div>`
      + `<div class="rot-sub">Market is <b>${L('regime', (regime || '').toUpperCase())}</b>, tape is <b>${L('tape', clbl)}</b>${tok && tape.efficiency != null ? ` <span class="dt-dim">(${L('trendEff', 'trend-eff ' + tape.efficiency)})</span>` : ''}. Every forecast below is ${L('forecast', 'falsifiable')} and graded automatically when its deadline passes.</div></div>`;

    // Honest auto-graded track record + trust badge.
    const n = pred.resolvedCount || 0;
    let track;
    if (n >= 5) {
      const acc = pred.accuracy, lo = pred.wilsonLo;
      const col = lo != null && lo >= 50 ? 'var(--green)' : (acc >= 50 ? 'var(--amber,#f59e0b)' : 'var(--red)');
      const bh = [5, 10, 21].map(h => { const b = pred.byHorizon[h]; return b && b.n ? `${h}d ${Math.round(b.correct / b.n * 100)}% (${b.n})` : null; }).filter(Boolean).join(' · ');
      track = `<div class="dt-note" style="border-left-color:${col}"><b>📊 Auto-graded accuracy: <span style="color:${col}">${acc}%</span></b> of ${n} resolved calls beat their bar `
        + `<span class="dt-dim">(${L('wilsonLB', 'floor ' + (lo != null ? lo + '%' : '—'))})</span>.${bh ? ` <span class="dt-dim">By horizon: ${bh}.</span>` : ''}</div>`;
    } else {
      track = `<div class="dt-note"><b>📊 Track record building.</b> ${n} call${n === 1 ? '' : 's'} resolved so far — accuracy shows once ≥5 have matured. Every call is graded against real prices, never self-scored.</div>`;
    }
    const trust = `<div class="trust-badge" style="margin-top:8px">${trustBadgeHTML('forecast')}</div>`;

    // Calibration — is the AI's stated confidence honest? (when it says 7/10, ~70%?)
    const cal = pred.calibration || {};
    let calib = `<div class="rot-head" style="margin-top:16px">📐 ${L('calibration', 'Is its confidence honest?')} <span class="dt-dim">· stated vs actual hit rate</span></div>`;
    if (cal.n >= 8) {
      const vCol = cal.verdict === 'well-calibrated' ? 'var(--green)' : 'var(--amber,#f59e0b)';
      const vTxt = cal.verdict === 'overconfident' ? `overconfident — it claims ${cal.meanStated}% but hits ${cal.meanActual}%`
        : cal.verdict === 'underconfident' ? `underconfident — it claims ${cal.meanStated}% but hits ${cal.meanActual}%`
        : `well-calibrated — claims ${cal.meanStated}%, hits ${cal.meanActual}%`;
      const rows = (cal.buckets || []).filter(b => b.n).map(b => {
        const off = b.actual - b.stated;
        const oc = Math.abs(off) <= 10 ? 'var(--green)' : 'var(--text-dim)';
        return `<div class="bt-ic-row"><span>${b.label} conf</span><span class="dt-dim">says ${b.stated}%</span><span style="color:${oc}">hits ${b.actual}% <span class="dt-dim">(n=${b.n})</span></span></div>`;
      }).join('');
      calib += `<div class="dt-note" style="border-left-color:${vCol}"><b style="color:${vCol}">Verdict: ${vTxt}.</b> <span class="dt-dim">${L('brier', 'Brier ' + cal.brier)} (lower is better; 0.25 = no skill).</span></div>`
        + `<div class="rot-panel" style="margin-top:6px"><div class="rot-sub" style="margin-bottom:4px"><b>By confidence bucket</b> <span class="dt-dim">— green = within 10pts of honest</span></div>${rows}</div>`;
    } else {
      calib += `<div class="dt-note">⏳ <b>Calibration building.</b> ${cal.n || 0} graded call${(cal.n || 0) === 1 ? '' : 's'} with a stated confidence — the stated-vs-actual breakdown shows once ≥8 resolve. It checks whether "7/10" really means ~70%.</div>`;
    }

    // Open (pending) predictions.
    const open = pred.open || [];
    const openHtml = open.length
      ? `<div class="rot-head" style="margin-top:14px">🔮 Open forecasts <span class="dt-dim">· generated ${pred.lastGenerated || '—'}</span></div>` + open.map(fcCard).join('')
      : `<div class="dt-note" style="margin-top:14px">No open forecasts yet — a fresh weekly batch is generated automatically. Check back shortly.</div>`;

    // Recently graded.
    const recent = pred.recent || [];
    const recentHtml = recent.length
      ? `<div class="rot-head" style="margin-top:14px">🧾 Recently graded</div>` + recent.map(r => {
          const [gl, gc, gt] = FC_STATUS[r.status] || FC_STATUS.pending;
          const mv = r.actualPct != null ? `<span class="dt-dim">${r.actualPct > 0 ? '+' : ''}${r.actualPct}%</span>` : '';
          return `<div class="bt-ic-row"><span><b>${esc(r.claim)}</b></span><span style="color:${gc}">${gl} ${gt}</span><span>${mv}</span></div>`;
        }).join('')
      : '';

    const caveat = `<div class="fade-caveats" style="margin-top:14px"><p>⚠️ <b>Educational, not signals.</b> Short-term market prediction is genuinely hard — expect the live accuracy to hover near a coin flip. The point is the honest scoreboard: ${L('forecast', 'falsifiable calls')} you can learn from, not tips to trade.</p></div>`;

    el.innerHTML = banner + track + trust + calib + openHtml + recentHtml + caveat;
    const gt = document.getElementById('forecast-gen-time'); if (gt && pred.lastGenerated) gt.textContent = pred.lastGenerated;
  }
  document.getElementById('forecast-refresh-btn')?.addEventListener('click', runForecastUI);

  // ── 🎲 CROWD — unusual activity in real-money prediction markets (Kalshi + Poly) ──
  let crowdLoaded = false;
  function ensureCrowd() { if (!crowdLoaded) { crowdLoaded = true; runCrowdUI(); } }
  async function runCrowdUI() {
    const el = document.getElementById('crowd-container'); if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning Kalshi &amp; Polymarket for unusual activity…</p></div>`;
    try {
      const d = await fetch('/api/tracker?op=crowd').then(r => r.json()).catch(() => null);
      renderCrowd(d);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load prediction-market data.</p></div>`; }
  }
  const VENUE_COL = { Kalshi: '#14b8a6', Polymarket: '#8b5cf6' };
  function crowdRow(m) {
    const col = VENUE_COL[m.venue] || '#14b8a6';
    const heatCol = m.heat >= 80 ? 'var(--red)' : m.heat >= 65 ? 'var(--amber,#f59e0b)' : 'var(--text-dim)';
    const prob = Math.round((m.prob || 0) * 100);
    const chips = (m.reasons || []).map(r => `<span class="crowd-chip">${esc(r)}</span>`).join('');
    const title = m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="crowd-link">${esc(m.title)}</a>` : esc(m.title);
    return `<div class="rot-panel crowd-row" style="margin-top:8px">`
      + `<div class="crowd-head"><span class="crowd-venue" style="background:${col}22;color:${col}">${esc(m.venue)}</span>`
      + `<span class="crowd-heat" style="color:${heatCol}">🔥 ${m.heat}</span></div>`
      + `<div class="crowd-title">${title}</div>`
      + `<div class="rot-sub"><b>${prob}%</b> implied odds <span class="dt-dim">· ${esc(m.group || '')}</span> ${chips}</div></div>`;
  }
  function renderCrowd(d) {
    const el = document.getElementById('crowd-container'); if (!el) return;
    if (!d || !d.ok) { el.innerHTML = `<div class="mom-status error"><p>Prediction-market data unavailable right now.</p></div>`; return; }
    const c = d.counts || {};
    const baseTxt = d.baselineReady
      ? `Volume is judged against each market's own ${d.baselineDays}-day baseline.`
      : `Building the volume baseline (day ${d.baselineDays || 0} of 3) — for now, unusual is driven by sharp odds swings; volume z-scores sharpen in a few days.`;
    const banner = `<div class="rot-panel"><div class="rot-head">🎲 What the crowd is repricing</div>`
      + `<div class="rot-sub">Scanned <b>${c.scanned || 0}</b> ${L('predmarket', 'prediction-market')} contracts (Kalshi ${c.kalshi || 0} · Polymarket ${c.polymarket || 0}). ${baseTxt}</div></div>`;
    const trust = `<div class="trust-badge" style="margin-top:8px">${trustBadgeHTML('crowd')}</div>`;
    const unusual = d.unusual || [];
    let body;
    if (unusual.length) {
      body = `<div class="rot-head" style="margin-top:14px">⚡ Unusual activity <span class="dt-dim">· ${unusual.length} flagged</span></div>` + unusual.map(crowdRow).join('');
    } else {
      const top = (d.top || []).slice(0, 6);
      body = `<div class="dt-note" style="margin-top:14px">😴 Nothing unusual right now — no big volume bursts or odds swings on the macro board. The most active contracts:</div>` + top.map(crowdRow).join('');
    }
    // 📊 Crowd-leads study — does a themed swing precede the implicated sector's move?
    const cs = d.crowdStudy || {};
    const CS_THEME = { ratecut: 'Rate cuts → Real Estate', ratehike: 'Rate hikes → Financials', inflation: 'Inflation → Energy', recession: 'Recession → Staples', volatility: 'Volatility → S&P' };
    let study = `<div class="rot-head" style="margin-top:16px">📊 Does the crowd lead? <span class="dt-dim">· swing vs the sector's next move</span></div>`;
    if (cs.n >= 8) {
      const lo = cs.wilsonLo, col = lo != null && lo >= 50 ? 'var(--green)' : (cs.rate >= 53 ? 'var(--amber,#f59e0b)' : 'var(--red)');
      const verdict = lo != null && lo >= 50 ? 'the crowd leads — swings precede the sector move' : cs.rate >= 53 ? 'suggestive, but not proven (floor below 50%)' : 'no lead — the move is already priced in';
      const bh = [5, 10, 21].map(h => { const x = cs.byHorizon[h]; return x && x.n ? `${h}d ${Math.round(x.hits / x.n * 100)}% (${x.n})` : null; }).filter(Boolean).join(' · ');
      const themes = Object.entries(cs.byTheme || {}).filter(([, t]) => t.n >= 3).map(([k, t]) => `<div class="bt-ic-row"><span>${CS_THEME[k] || k}</span><span style="color:${Math.round(t.hits / t.n * 100) >= 50 ? 'var(--green)' : 'var(--text-dim)'}">${Math.round(t.hits / t.n * 100)}%</span><span class="dt-dim">n=${t.n}</span></div>`).join('');
      study += `<div class="dt-note" style="border-left-color:${col}"><b style="color:${col}">Sector moved as implied ${cs.rate}%</b> of ${cs.n} graded swings <span class="dt-dim">(${L('wilsonLB', 'floor ' + (lo != null ? lo + '%' : '—'))})</span>. <b style="color:${col}">Verdict: ${verdict}.</b>${bh ? ` <span class="dt-dim">By horizon: ${bh}.</span>` : ''}</div>`;
      if (themes) study += `<div class="rot-panel" style="margin-top:6px"><div class="rot-sub" style="margin-bottom:4px"><b>By theme</b> <span class="dt-dim">(hit rate)</span></div>${themes}</div>`;
    } else {
      study += `<div class="dt-note">⏳ <b>Study building.</b> ${cs.pending || 0} themed swing${(cs.pending || 0) === 1 ? '' : 's'} logged${cs.n ? `, ${cs.n} graded` : ''} — the lead/no-lead verdict shows once ≥8 mature. Each tests whether a swing (e.g. rate-cut odds → Real Estate) precedes the sector's real move at 5/10/21 days.</div>`;
    }
    const caveat = `<div class="fade-caveats" style="margin-top:14px"><p>⚠️ <b>A sentiment radar, not a signal.</b> A volume burst or odds swing usually means the crowd is repricing a <i>known</i> catalyst (often after the news) — it tells you what macro events are in play, not what to trade. Real money, but not a stock edge.</p></div>`;
    el.innerHTML = banner + trust + body + study + caveat;
    const gt = document.getElementById('crowd-gen-time'); if (gt && d.generatedAt) gt.textContent = new Date(d.generatedAt).toLocaleTimeString();
  }
  document.getElementById('crowd-refresh-btn')?.addEventListener('click', runCrowdUI);

  // ── 🕵️ SHARP MONEY — informed-activity hallmarks (shares op=crowd's data) ──────
  let sharpLoaded = false;
  function ensureSharp() { if (!sharpLoaded) { sharpLoaded = true; runSharpUI(); } }
  async function runSharpUI() {
    const el = document.getElementById('sharp-container'); if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning for size + conviction fingerprints…</p></div>`;
    try {
      const d = await fetch('/api/tracker?op=crowd').then(r => r.json()).catch(() => null);
      renderSharp(d);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load prediction-market data.</p></div>`; }
  }
  function sharpRow(m, flagged) {
    const col = VENUE_COL[m.venue] || '#e11d48';
    const sCol = m.sharp >= 60 ? 'var(--red)' : m.sharp >= 45 ? 'var(--amber,#f59e0b)' : 'var(--text-dim)';
    const prob = Math.round((m.prob || 0) * 100);
    const tells = (m.tells || []).map(t => `<span class="crowd-chip">${esc(t)}</span>`).join('');
    const title = m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="crowd-link">${esc(m.title)}</a>` : esc(m.title);
    const days = m.daysToClose != null ? (m.daysToClose < 1 ? '<1d' : Math.round(m.daysToClose) + 'd') : '—';
    return `<div class="rot-panel crowd-row" style="margin-top:8px${flagged ? ';border-color:#e11d48aa' : ''}">`
      + `<div class="crowd-head"><span class="crowd-venue" style="background:${col}22;color:${col}">${esc(m.venue)}</span>`
      + `<span class="crowd-heat" style="color:${sCol}">🕵️ ${m.sharp}</span></div>`
      + `<div class="crowd-title">${title}</div>`
      + `<div class="rot-sub"><b>${fmtMoney(m.notional)}</b> traded 24h · <b>${prob}%</b> odds <span class="dt-dim">· resolves ${days}</span></div>`
      + (tells ? `<div style="margin-top:5px">${tells}</div>` : '') + `</div>`;
  }
  function renderSharp(d) {
    const el = document.getElementById('sharp-container'); if (!el) return;
    if (!d || !d.ok) { el.innerHTML = `<div class="mom-status error"><p>Prediction-market data unavailable right now.</p></div>`; return; }
    const c = d.counts || {};
    const oiTxt = d.oiBaseline ? 'Open-interest build (new money) is active.' : 'Open-interest tracking warms up after the first daily snapshot.';
    const banner = `<div class="rot-panel"><div class="rot-head">🕵️ Informed-activity scan</div>`
      + `<div class="rot-sub">Looking for ${L('sharpmoney', 'sharp-money hallmarks')} — real size lining up with conviction (cheap longshots being loaded, volume exceeding open positions, fresh ${L('predmarket', 'open interest')}, late surges). Scanned <b>${c.scanned || 0}</b> contracts. ${oiTxt}</div></div>`;
    const trust = `<div class="trust-badge" style="margin-top:8px">${trustBadgeHTML('sharp')}</div>`;
    const sharp = d.sharp || [];
    let body;
    if (sharp.length) {
      body = `<div class="rot-head" style="margin-top:14px">🚩 Flagged — size + conviction <span class="dt-dim">· ${sharp.length}</span></div>` + sharp.map(m => sharpRow(m, true)).join('');
    } else {
      const top = (d.sharpTop || []).slice(0, 5);
      body = `<div class="dt-note" style="border-left-color:#e11d48;margin-top:14px">🟢 <b>No clear sharp-money signal right now.</b> Nothing combines real size with a conviction pattern — which is the normal state. Below are the closest candidates (below the bar), shown for context:</div>`
        + top.map(m => sharpRow(m, false)).join('');
    }
    // Durable history — flagged events logged by the daily cron, persist after the live flag fades.
    const ev = d.recentEvents || [];
    let history = '';
    if (ev.length) {
      history = `<div class="rot-head" style="margin-top:16px">🗂 Recent sharp events <span class="dt-dim">· auto-logged, last ${ev.length}</span></div>`
        + ev.map(e => {
            const col = VENUE_COL[e.venue] || '#e11d48';
            const when = (e.date || '').slice(5);   // MM-DD
            const tells = (e.tells || []).slice(0, 2).map(t => `<span class="crowd-chip">${esc(t)}</span>`).join('');
            const title = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" class="crowd-link">${esc(e.title)}</a>` : esc(e.title);
            return `<div class="rot-panel crowd-row" style="margin-top:8px"><div class="crowd-head">`
              + `<span class="crowd-venue" style="background:${col}22;color:${col}">${esc(e.venue)} · ${when}</span>`
              + `<span class="crowd-heat" style="color:var(--text-dim)">peak 🕵️ ${e.peakSharp || e.sharp}</span></div>`
              + `<div class="crowd-title">${title}</div>`
              + `<div class="rot-sub"><b>${fmtMoney(e.notional)}</b> · ${Math.round((e.prob || 0) * 100)}% odds ${tells}</div></div>`;
          }).join('');
    }
    // 📊 Validation — does sharp money actually predict? (resolved bets vs outcome)
    const v = d.sharpValidation || {};
    const TELL_LBL = { longshot: '🎯 Longshot conviction', oibuild: '📈 OI build (new money)', size: '💰 Size > open positions', volume: '💧 Large volume', latesurge: '⏰ Late surge', move: '⚡ Sharp odds move' };
    let predict = `<div class="rot-head" style="margin-top:16px">📊 Does it predict? <span class="dt-dim">· flagged bets vs actual outcome</span></div>`;
    if (v.n >= 5) {
      const lo = v.wilsonLo, col = lo != null && lo >= 50 ? 'var(--green)' : (v.rate >= 50 ? 'var(--amber,#f59e0b)' : 'var(--red)');
      const verdict = lo != null && lo >= 50 ? 'a real edge — sharp money is beating chance' : v.rate >= 53 ? 'promising, but not yet proven (floor below 50%)' : 'no edge so far — near a coin flip';
      const tells = Object.entries(TELL_LBL).map(([k, lbl]) => { const t = v.byTell[k]; return t && t.n >= 3 ? `<div class="bt-ic-row"><span>${lbl}</span><span style="color:${Math.round(t.hits / t.n * 100) >= 50 ? 'var(--green)' : 'var(--text-dim)'}">${Math.round(t.hits / t.n * 100)}%</span><span class="dt-dim">n=${t.n}</span></div>` : ''; }).join('');
      predict += `<div class="dt-note" style="border-left-color:${col}"><b style="color:${col}">When flagged, the bet's side won ${v.rate}%</b> of ${v.n} resolved cases <span class="dt-dim">(${L('wilsonLB', 'floor ' + (lo != null ? lo + '%' : '—'))})</span>. <b style="color:${col}">Verdict: ${verdict}.</b></div>`;
      if (tells) predict += `<div class="rot-panel" style="margin-top:6px"><div class="rot-sub" style="margin-bottom:4px"><b>Which tell carries it?</b> <span class="dt-dim">(hit rate by hallmark)</span></div>${tells}</div>`;
    } else {
      predict += `<div class="dt-note">⏳ <b>Validation building.</b> ${v.pending || 0} flagged bet${(v.pending || 0) === 1 ? '' : 's'} awaiting settlement${v.n ? `, ${v.n} resolved` : ''} — the hit rate shows once ≥5 settle (each resolves when its Kalshi contract finalizes). Every bet is graded against the real outcome, never self-scored.</div>`;
    }
    const caveat = `<div class="fade-caveats" style="margin-top:14px"><p>⚠️ <b>Hallmarks, not proof.</b> This flags statistical fingerprints of informed betting — it does <i>not</i> detect actual insider trading, and most hits are coincidence, hedging, or rumor. A lead to investigate, never a signal to follow. Real money, real markets — but speculative.</p></div>`;
    el.innerHTML = banner + trust + predict + body + history + caveat;
    const gt = document.getElementById('sharp-gen-time'); if (gt && d.generatedAt) gt.textContent = new Date(d.generatedAt).toLocaleTimeString();
  }
  document.getElementById('sharp-refresh-btn')?.addEventListener('click', runSharpUI);

  // ── 🔔 ALERTS — durable Predict feed + unread badge + opt-in browser notifications ──
  const ALERT_ICON = { sharp: '🕵️', stance: '🧭', crowd: '🎲' };
  const ALERT_COL = { high: 'var(--red)', med: 'var(--amber,#f59e0b)', low: 'var(--text-dim)' };
  let alertsLoaded = false, alertItems = [];
  const getSeen = () => { try { return +localStorage.getItem('notifySeen') || 0; } catch { return 0; } };
  const setSeen = t => { try { localStorage.setItem('notifySeen', String(t)); } catch {} };
  // Refresh the unread count + paint a badge on every Predict nav button.
  function paintAlertBadge() {
    const seen = getSeen();
    const unread = alertItems.filter(i => Date.parse(i.ts) > seen).length;
    document.querySelectorAll('[data-tab="predict"]').forEach(el => {
      let b = el.querySelector('.nav-badge');
      if (unread > 0) { if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; el.appendChild(b); } b.textContent = unread > 9 ? '9+' : unread; b.style.display = ''; }
      else if (b) b.style.display = 'none';
    });
    const sb = document.querySelector('#hub-subnav .hub-sub-btn[data-sub="alerts"]');
    if (sb && !sb.querySelector('.nav-badge') && unread > 0) { const s = document.createElement('span'); s.className = 'nav-badge'; s.textContent = unread > 9 ? '9+' : unread; sb.appendChild(s); }
    else if (sb && sb.querySelector('.nav-badge')) sb.querySelector('.nav-badge').style.display = unread > 0 ? '' : 'none';
  }
  async function fetchAlerts() {
    try { const d = await fetch('/api/tracker?op=alertfeed').then(r => r.json()); if (d && d.ok) alertItems = d.items || []; } catch {}
    return alertItems;
  }
  function maybeNotify(items) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const seen = getSeen();
    items.filter(i => Date.parse(i.ts) > seen).slice(0, 3).forEach(i => {
      try { new Notification(i.title, { body: i.detail || '', tag: i.id }); } catch {}
    });
  }
  function ensureAlerts() { if (!alertsLoaded) { alertsLoaded = true; runAlertsUI(); } else runAlertsUI(); }
  async function runAlertsUI() {
    const el = document.getElementById('alerts-container'); if (!el) return;
    if (!alertItems.length) el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading alerts…</p></div>`;
    await fetchAlerts();
    renderAlerts();
    setSeen(Date.now());   // viewing the tab marks all read
    paintAlertBadge();
  }
  function renderAlerts() {
    const el = document.getElementById('alerts-container'); if (!el) return;
    const seen = getSeen();
    const notifyState = ('Notification' in window) ? Notification.permission : 'unsupported';
    const notifyBtn = notifyState === 'granted'
      ? `<span class="dt-dim">🔔 Browser notifications on</span>`
      : notifyState === 'unsupported' ? `<span class="dt-dim">Browser notifications not supported here</span>`
      : `<button class="today-cta" id="alerts-notify-btn">🔔 Enable browser notifications</button>`;
    const head = `<div class="rot-panel"><div class="rot-head">🔔 Auto-caught events</div><div class="rot-sub">Sharp-money flags, Brief stance flips, and major crowd swings are logged here automatically by the daily scan — so you catch them without watching the tabs. ${notifyBtn}</div></div>`;
    let body;
    if (!alertItems.length) {
      body = `<div class="dt-note" style="margin-top:12px">🟢 <b>No alerts yet.</b> When sharp money flags an informed bet, the Brief flips direction, or the crowd repricing spikes, it shows up here. The scan runs daily.</div>`;
    } else {
      body = `<div class="rot-head" style="margin-top:14px">Recent</div>` + alertItems.map(i => {
        const unread = Date.parse(i.ts) > seen;
        const col = ALERT_COL[i.sev] || 'var(--text-dim)';
        return `<div class="rot-panel crowd-row alert-row${unread ? ' alert-unread' : ''}" data-go="${i.go || ''}" style="margin-top:8px;border-left:3px solid ${col}">`
          + `<div class="crowd-head"><span><b>${ALERT_ICON[i.type] || '🔔'} ${esc(i.title)}</b></span><span class="dt-dim" style="white-space:nowrap">${timeAgo(i.ts)}</span></div>`
          + (i.detail ? `<div class="rot-sub">${esc(i.detail)}</div>` : '') + `</div>`;
      }).join('');
    }
    const caveat = `<div class="fade-caveats" style="margin-top:14px"><p>⚠️ Alerts flag <b>events worth a look</b>, not trades. Sharp money = ${L('sharpmoney', 'hallmarks')} (not proof); a stance flip is a synthesis turning, not a signal. Browser notifications fire while this site is open in your browser.</p></div>`;
    el.innerHTML = head + body + caveat;
    el.querySelectorAll('.alert-row[data-go]').forEach(r => { if (r.dataset.go) r.addEventListener('click', () => showTab(r.dataset.go)); });
    el.querySelector('#alerts-notify-btn')?.addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch {}
      renderAlerts();
    });
  }
  document.getElementById('alerts-refresh-btn')?.addEventListener('click', runAlertsUI);
  // Background: fetch the feed shortly after boot so the unread badge shows before opening Predict.
  setTimeout(() => { fetchAlerts().then(items => { paintAlertBadge(); maybeNotify(items); }); }, 2500);

  // ── Simple / Expert mode — progressive disclosure (Simple hides dense surfaces) ──
  function applyUiMode(m) {
    const expert = m === 'expert';
    document.body.classList.toggle('expert', expert);
    document.body.classList.toggle('simple', !expert);
    const btn = document.getElementById('mode-btn');
    if (btn) btn.textContent = expert ? '🎓 Expert' : '🌱 Simple';
  }
  let uiMode = (() => { try { return localStorage.getItem('uiMode') === 'expert' ? 'expert' : 'simple'; } catch { return 'simple'; } })();
  applyUiMode(uiMode);   // Simple by default (novice-first); the choice persists
  document.getElementById('mode-btn')?.addEventListener('click', () => {
    uiMode = uiMode === 'expert' ? 'simple' : 'expert';
    try { localStorage.setItem('uiMode', uiMode); } catch {}
    applyUiMode(uiMode);
    // If we just hid the tab the user is on (Research), bounce to a visible one.
    if (uiMode === 'simple' && currentTop === 'lab' && typeof showTab === 'function') showTab('candidates');
  });

  document.getElementById('custom-refresh-btn').addEventListener('click', () => { runApex(); fetchApexDrift(); });
  document.getElementById('cx-scope').addEventListener('change', runApex);
  document.getElementById('cx-tier').addEventListener('change', () => { if (apexLast) renderApex(apexLast); });
  document.getElementById('cx-model-toggle').addEventListener('click', () => {
    const b = document.getElementById('cx-model-body');
    const open = b.style.display !== 'none';
    b.style.display = open ? 'none' : 'block';
    const arr = document.querySelector('#cx-model-toggle .ct-arrow');
    if (arr) arr.style.transform = open ? '' : 'rotate(180deg)';
  });

  // ── Ghost Accumulation Index (GAI) — quiet-accumulation screener ──────────
  // Purely presentational: the 6-pillar scoring runs server-side in lib/ghost.js
  // and ships on each candidate as c.ghost. No scorer duplicated here → no drift.
  let ghostLoaded = false, ghostLast = null;
  const GHOST_PILLAR_ORDER = ['RM', 'AF', 'AV', 'SF', 'BONUS', 'IN'];
  const GHOST_PILLAR_SHORT = { RM: '① Rel. strength', AF: '② Accum. footprint', AV: '③ Accum. vacuum', SF: '④ Smart flow', BONUS: '⑤ Catalyst', IN: '⑥ Insider' };
  // Plain-English hovers for each Ghost pillar (novice investor).
  const GHOST_PILLAR_HELP = {
    RM: 'Relative strength — is the stock quietly outperforming the market? Higher = leading.',
    AF: 'Accumulation footprint — steady buying pressure (more up-volume than down-volume) even without a breakout yet.',
    AV: 'Accumulation vacuum — a quiet, low-supply base. (Deliberately low-weighted — the app’s research found this factor weak.)',
    SF: 'Smart flow — up/down volume and volume-adjusted signs of informed buying.',
    BONUS: 'Catalyst — a fundamental or news reason for the accumulation (earnings acceleration, story).',
    IN: 'Insider — real open-market buying by company insiders (Form 4 filings). A genuine confirmation flag.',
  };
  const GHOST_RG_LABEL = { 'risk-on': 'Risk-On', 'neutral': 'Neutral', 'risk-off': 'Risk-Off' };
  const GHOST_TIER_CSS = { GHOST: 'apex', STALKING: 'loaded', WATCH: 'watch' }; // reuse existing card colors

  async function fetchGhostScope(scope) {
    try { const r = await fetch('/api/screener?scope=' + scope); return await r.json(); }
    catch { return { error: 'fetch failed' }; }
  }

  function ensureGhost() { if (!ghostLoaded) { ghostLoaded = true; runGhost(); } }

  async function runGhost() {
    const scopeSel = document.getElementById('gh-scope').value;
    const container = document.getElementById('ghost-container');
    const btn = document.getElementById('ghost-refresh-btn');
    container.innerHTML = skeletonGrid(6);
    btn.disabled = true;
    try {
      // Large is always fetched — it carries the regime read used for the strip.
      // 'all' now includes the free full-market 'expanded' scope.
      const fetchScopes = scopeSel === 'all' ? ['large', 'small', 'micro', 'expanded']
        : scopeSel === 'large' ? ['large'] : ['large', scopeSel];
      const datas = await Promise.all(fetchScopes.map(fetchGhostScope));
      const byScope = {}; fetchScopes.forEach((s, i) => byScope[s] = datas[i]);
      const large = byScope.large;
      if (!large || large.error) {
        container.innerHTML = `<div class="mom-status error"><p>${esc((large && large.error) || 'Screener unavailable')}</p></div>`;
        return;
      }

      const wanted = scopeSel === 'all' ? ['large', 'small', 'micro', 'expanded'] : [scopeSel];
      let cands = [];
      // Prefer ghostTop — the FULL scanned cross-section's accumulation names (not
      // just the breakout candidates). Falls back to results for older responses.
      wanted.forEach(s => {
        const d = byScope[s]; if (!d) return;
        const src = Array.isArray(d.ghostTop) && d.ghostTop.length ? d.ghostTop
          : (Array.isArray(d.results) ? d.results.filter(c => c.ghost) : []);
        cands.push(...src.map(c => ({ ...c, _scope: s })));
      });

      const seen = {}, deduped = [];
      cands.filter(c => c.ghost && c.ghost.tier !== 'PASS')
        .sort((a, b) => b.ghost.score - a.ghost.score)
        .forEach(c => { if (!seen[c.ticker]) { seen[c.ticker] = 1; deduped.push(c); } });

      ghostLast = { list: deduped, meta: large.ghost || {}, large };
      renderGhost(ghostLast);
      const gt = document.getElementById('ghost-gen-time');
      if (large.generatedAt) gt.textContent = `Updated ${new Date(large.generatedAt).toLocaleTimeString()}`;
      const rg = (large.ghost && large.ghost.regime) || 'neutral';
      document.getElementById('ghost-meta').textContent = `· ${deduped.length} names scored · ${GHOST_RG_LABEL[rg]} weights · 6-pillar quiet-accumulation`;
    } catch {
      container.innerHTML = `<div class="mom-status error"><p>Could not run the Ghost model. Please try again.</p></div>`;
    } finally { btn.disabled = false; }
  }

  function renderGhost(snap) {
    const { list, meta } = snap;
    renderGhostStrip(meta);
    renderGhostModelPanel(meta);

    const container = document.getElementById('ghost-container');
    const tierFilter = document.getElementById('gh-tier').value;
    let show = list;
    if (tierFilter === 'ghost') show = list.filter(c => c.ghost.tier === 'GHOST');
    else if (tierFilter === 'stalking') show = list.filter(c => c.ghost.tier !== 'WATCH');

    if (!show.length) {
      const why = !meta.regime ? '' : meta.killSwitch ? ' — the kill switch is on in this Risk-Off tape, so every tier is downgraded a notch' : '';
      container.innerHTML = `<div class="mom-status"><p>No names cleared the Ghost model${why}. Ghost re-ranks the breakout-screen candidate pool through an accumulation lens, so a quiet tape can legitimately show nothing. Try a broader scope or looser tier filter.</p></div>`;
      return;
    }
    const groups = [
      ['GHOST', '👻 Ghost', 'Broad accumulation — ≥3 strong pillars, quietly being bought'],
      ['STALKING', '🥷 Stalking', 'Building a position — strong but not yet confirmed across pillars'],
      ['WATCH', '👁 Watch', 'On the radar — early accumulation footprints'],
    ];
    container.innerHTML = '';
    groups.forEach(([tier, name, sub]) => {
      const items = show.filter(c => c.ghost.tier === tier);
      if (!items.length) return;
      const head = document.createElement('div');
      head.className = 'cx-tier-head ' + (GHOST_TIER_CSS[tier] || '');
      head.innerHTML = `<span class="cx-tier-name">${name}</span><span class="cx-tier-sub">${items.length} · ${sub}</span>`;
      container.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'scr-grid';
      items.forEach((c, i) => grid.appendChild(buildGhostCard(c, meta, i)));
      container.appendChild(grid);
    });
    attachTimingLights(container, show.map(c => ({ ticker: c.ticker, stop: c.levels && c.levels.stop, target: c.levels && (c.levels.resistance ?? c.levels.target), trigger: c.levels && c.levels.entry })), 'ghost');
  }

  function buildGhostCard(c, meta, idx) {
    const g = c.ghost, pl = g.pillars, tier = g.tier;
    const up = (c.changePct ?? 0) >= 0;
    const weights = meta.weights || {};
    const tierLabel = { GHOST: 'Ghost', STALKING: 'Stalking', WATCH: 'Watch' }[tier];
    const scopeTag = c._scope && c._scope !== 'large' ? ` · ${c._scope} cap` : '';

    const pill = (k) => {
      const w = weights[k] != null ? `<span class="cx-pill-wt">w${Math.round(weights[k] * 100)}</span>` : '';
      return `<div class="cx-pill"${GHOST_PILLAR_HELP[k] ? ` title="${esc(GHOST_PILLAR_HELP[k])}"` : ''}><div class="cx-pill-top"><span>${GHOST_PILLAR_SHORT[k]} ${w}</span><b>${pl[k]}</b></div><div class="cx-pill-track"><div class="cx-pill-fill" style="width:${pl[k]}%"></div></div></div>`;
    };

    // Insider line — the genuinely new signal; surface the raw net when present.
    const ins = c.insider;
    let insLine = '';
    if (ins && !ins.empty && (ins.buys.tx || ins.sells.tx)) {
      const netUp = (ins.net.value || 0) >= 0;
      const fmt = v => '$' + (Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(1) + 'M' : Math.round(Math.abs(v) / 1e3) + 'K');
      insLine = `<div class="cx-narrative">🏛 Insiders (90d): <b style="color:${netUp ? 'var(--green)' : 'var(--red)'}">${netUp ? '+' : '−'}${fmt(ins.net.value)} net</b> · ${ins.buys.tx} buys / ${ins.sells.tx} sells${ins.buys.insiders >= 2 && netUp ? ' · cluster buy' : ''}</div>`;
    }

    const lv = c.levels || {};
    const levelsHtml = lv.entry != null
      ? `<div class="alert-targets">
          <div class="at-box"><div class="at-label">${c.status === 'Breakout' ? 'Entry' : 'Trigger'}</div><div class="at-val entry">$${lv.entry}</div></div>
          <div class="at-box"><div class="at-label">${targetLabel(lv)}</div><div class="at-val target">$${lv.resistance ?? lv.target}</div></div>
          <div class="at-box"><div class="at-label">Stop</div><div class="at-val stop">$${lv.stop}</div></div>
        </div>${rrLineHTML(lv)}` : '';

    const card = document.createElement('div');
    card.className = `cx-card ${GHOST_TIER_CSS[tier] || ''} fade-in`;
    card.dataset.ticker = c.ticker;
    card.style.animationDelay = `${idx * 45}ms`;
    card.innerHTML = `
      <div class="cx-top">
        <div>
          <div class="cx-tk-row"><span class="cx-ticker" data-live="${esc(c.ticker)}">${esc(c.ticker)}</span><span class="cx-tierbadge ${GHOST_TIER_CSS[tier] || ''}">${tierLabel}</span>${whyNowBadge(c)}</div>
          <div class="cx-company">${esc(c.company || c.ticker)}${c.sector ? ` · ${esc(c.sector)}` : ''}${scopeTag}${c.theme ? ` · ${esc(c.theme)}` : ''}</div>
        </div>
        <div class="cx-score-col">
          <div class="cx-score">${L('accumulation', g.score + '<small>/100</small>')}</div>
          <div class="cx-price">$${esc(c.price)}</div>
          <div class="cx-chg ${up ? 'up' : 'down'}">${c.changePct != null ? (up ? '▲ +' : '▼ ') + c.changePct + '%' : ''}</div>
        </div>
      </div>
      <div class="cx-pillars">
        ${GHOST_PILLAR_ORDER.map(pill).join('')}
      </div>
      <div class="cx-weak" style="border:0;color:var(--text-dim)">${g.strongPillars}/6 pillars strong (≥65)</div>
      ${insLine}
      ${levelsHtml}
      ${chartToggleMarkup()}`;
    wireChartToggle(card, c.ticker);
    return card;
  }

  function renderGhostStrip(meta) {
    const el = document.getElementById('ghost-strip');
    if (!el) return;
    const rg = meta.regime || 'neutral';
    const w = meta.weights || {};
    const wstr = GHOST_PILLAR_ORDER.map(k => w[k] != null ? Math.round(w[k] * 100) : '—').join('/');
    const ks = meta.killSwitch ? `<span class="cx-pending">⚠ kill switch ON · tiers downgraded</span>` : '';
    const mac = meta.macro;
    const macChip = mac ? `<span class="cx-ver" title="Macro risk ${mac.macroRisk}/100 · VIX ${mac.vix.level} (${mac.vix.pctile}th pctile, ${mac.vix.rising ? 'rising' : 'falling'}) · HYG/LQD credit ${mac.credit.belowSma ? 'below' : 'above'} 50d trend (${mac.credit.trend20 > 0 ? '+' : ''}${mac.credit.trend20}% 20d)">🌡 Macro ${mac.macroRisk}/100 · VIX ${mac.vix.level}${mac.riskOff ? ' · RISK-OFF' : mac.riskOn ? ' · risk-on' : ' · neutral'}</span>` : '';
    el.innerHTML =
      `<span class="cx-badge ${rg.replace('-', '_')}"><span class="cx-dot"></span>${GHOST_RG_LABEL[rg]} regime</span>` +
      `<span class="cx-preset">Weights <b>${wstr}</b></span>` + macChip +
      `<span class="cx-ver">Ghost v3 · static priors (Phase 1)</span>` + ks;
  }

  function renderGhostModelPanel(meta) {
    const body = document.getElementById('gh-model-body');
    if (!body) return;
    const labels = meta.pillarLabels || {};
    const w = meta.weights || {};
    const rows = GHOST_PILLAR_ORDER.map(k =>
      `<tr><td>${GHOST_PILLAR_SHORT[k]} — ${esc(labels[k] || k)}</td><td class="active">${w[k] != null ? Math.round(w[k] * 100) + '%' : '—'}</td></tr>`).join('');
    body.innerHTML = `
      <div class="cx-mp-sec">
        <h4>What Ghost looks for</h4>
        <p class="cx-mp-p">Apex hunts <i>confirmed breakouts</i>. Ghost hunts the opposite end: stocks being <b>quietly accumulated before</b> the move — rising relative strength on heavy up-volume, a tightening supply vacuum, and (the new lever) <b>insider buying</b>. Each candidate is graded 0–100 on six pillars, blended by the active regime's weights. <b>Ghost</b> = score ≥80 with ≥3 strong pillars; <b>Stalking</b> = ≥65, ≥2 strong; <b>Watch</b> = ≥50.</p>
      </div>
      <div class="cx-mp-sec">
        <h4>Pillar weights · ${GHOST_RG_LABEL[meta.regime || 'neutral']} regime</h4>
        <table class="cx-preset-table"><thead><tr><th>Pillar</th><th class="active">Weight</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      ${meta.macro ? `<div class="cx-mp-sec">
        <h4>Macro regime layer (VIX + credit)</h4>
        <p class="cx-mp-p">The regime no longer relies on the slow S&amp;P-vs-200-day read alone. A <b>macro risk score (${meta.macro.macroRisk}/100)</b> blends <b>VIX</b> (${meta.macro.vix.level}, ${meta.macro.vix.pctile}th percentile of the last year, ${meta.macro.vix.rising ? 'rising' : 'falling'}) with the <b>HYG/LQD credit spread</b> (high-yield vs investment-grade — ${meta.macro.credit.belowSma ? 'below' : 'above'} its 50-day trend, ${meta.macro.credit.trend20 > 0 ? '+' : ''}${meta.macro.credit.trend20}% over 20d). Vol spikes and credit cracking lead the index, so this catches risk-off <i>earlier</i>. Risk-off (score ≥55, VIX ≥28, or a vol spike at the extreme) trips the <b>kill switch</b> — every Ghost tier drops a notch. Current read: <b>${meta.macro.riskOff ? 'RISK-OFF' : meta.macro.riskOn ? 'risk-on' : 'neutral'}</b>.</p>
      </div>` : ''}
      <div class="cx-mp-sec">
        <h4>Honest caveats</h4>
        <p class="cx-mp-p"><b>Accumulation Vacuum (③) is deliberately starved.</b> This app's own multi-session research found base-tightness / VCP / volume-dry-up have ~zero forward-return edge, so the pillar exists for completeness but carries the lowest weight. The adaptive engine (Phase 2) can raise it only if it earns its keep on resolved picks.</p>
        <p class="cx-mp-p"><b>Insider (⑥) is the one untested, genuinely new factor</b> — net open-market buys over 90 days, cluster buys flagged. It's why Ghost isn't just a re-skin of Apex.</p>
        <p class="cx-mp-p"><b>Universe coverage:</b> Ghost currently re-ranks the breakout-screen's candidate pool through an accumulation lens — it does not yet independently scan the full universe for quiet pre-breakout names (that needs a heavier dedicated pass). Same pragmatic constraint Apex lives under.</p>
        <p class="cx-mp-p"><b>Not yet learning:</b> the regime weights above are static priors. The champion/challenger adaptive engine that tunes them is Phase 2 — it only activates once the signal ledger has ~40 resolved Ghost picks (≈2–3 months), so it can't promote anything on noise.</p>
      </div>`;
  }

  // Ghost — How-to-use modal
  (() => {
    const modal = document.getElementById('gh-help-modal');
    if (!modal) return;
    const open = () => { modal.hidden = false; document.body.style.overflow = 'hidden'; };
    const close = () => { modal.hidden = true; document.body.style.overflow = ''; };
    document.getElementById('gh-help-btn')?.addEventListener('click', open);
    document.getElementById('gh-help-close')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
  })();

  document.getElementById('ghost-refresh-btn').addEventListener('click', runGhost);
  document.getElementById('gh-scope').addEventListener('change', runGhost);
  document.getElementById('gh-tier').addEventListener('change', () => { if (ghostLast) renderGhost(ghostLast); });
  document.getElementById('gh-model-toggle').addEventListener('click', () => {
    const b = document.getElementById('gh-model-body');
    const open = b.style.display !== 'none';
    b.style.display = open ? 'none' : 'block';
    const arr = document.querySelector('#gh-model-toggle .ct-arrow');
    if (arr) arr.style.transform = open ? '' : 'rotate(180deg)';
  });

  // ── CERN — forced-flow event engine (state from /api/tracker?op=cern) ──────
  let cernLoaded = false;
  const CERN_LABEL = {
    INDEX_DELETE: 'Index deletion', INDEX_ADD_FADE: 'Index add · fade', LOCKUP_EXPIRY: 'Lockup expiry',
    TAX_LOSS: 'Tax-loss selling', FIRE_SALE: 'Fund fire-sale', MARGIN_SPIRAL: 'Margin spiral', FORCED_DOWNGRADE: 'Forced downgrade',
  };
  // All seven event types now have a live feed: auto-detected from bars (TAX_LOSS,
  // MARGIN_SPIRAL) plus calendar/flow/ratings feeds. (Kept as a list so a future
  // type added without a feed automatically shows "feed pending".)
  const CERN_FED = ['TAX_LOSS', 'MARGIN_SPIRAL', 'INDEX_DELETE', 'INDEX_ADD_FADE', 'LOCKUP_EXPIRY', 'FIRE_SALE', 'FORCED_DOWNGRADE'];

  function ensureCern() { if (!cernLoaded) { cernLoaded = true; runCern(); } }

  async function runCern() {
    const el = document.getElementById('events-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading the event engine…</p></div>`;
    try {
      // State + decay curves (excess-vs-market by day, per event type) in parallel.
      const [r, dr] = await Promise.all([
        fetch('/api/tracker?op=cern'),
        fetch('/api/tracker?op=cerndecay').catch(() => null),
      ]);
      const d = await r.json();
      if (!d.ok) { el.innerHTML = `<div class="mom-status error"><p>${esc(d.error || 'CERN unavailable')}</p></div>`; return; }
      let decay = null;
      try { decay = dr ? await dr.json() : null; } catch { decay = null; }
      renderCern(d, decay);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the event engine.</p></div>`; }
  }

  // Build a { EVENT_TYPE: {recommendedHold, trustworthy, fades, holdExcess, daysNeeded} }
  // lookup from the decay response so pick cards can show a holding window inline.
  function cernHoldMap(decay) {
    const m = {};
    if (decay && decay.types) for (const [t, v] of Object.entries(decay.types)) m[t] = v;
    return m;
  }
  // A short holding-window chip for a pick card / posterior row.
  function cernHoldChip(hv) {
    if (!hv) return '';
    if (hv.recommendedHold != null && hv.trustworthy)
      return `<span class="cx-hold ok" title="On average this event type's market-beating edge peaks around day ${hv.recommendedHold} (excess vs the S&P +${hv.holdExcess}%), then decays. Based on ${hv.n20} events resolved to the full 20-day window.">🕒 Hold ~${hv.recommendedHold} day${hv.recommendedHold === 1 ? '' : 's'}</span>`;
    if (hv.recommendedHold != null)
      return `<span class="cx-hold prov" title="Provisional: only ${hv.n20} of ${20} events have run the full 20 days. Trustworthy after ${hv.daysNeeded} more resolve.">🕒 Hold ~${hv.recommendedHold}d <i>(provisional)</i></span>`;
    if (hv.fades)
      return `<span class="cx-hold bad" title="On the data so far this event type does not beat the S&P at any horizon — it's underwater from day 1. No positive holding window.">🕒 No edge (fades)</span>`;
    return `<span class="cx-hold wait" title="Not enough resolved events yet to draw a decay curve (${hv.daysNeeded} more needed).">🕒 Window: building</span>`;
  }

  // Compact SVG decay curve — average excess-vs-S&P (%) by day 1..20 for one event
  // type. Zero line, a marker at the recommended-hold day. Matches the app's inline-
  // SVG chart style (coreperfChart) — no chart library.
  function cernDecaySvg(v) {
    const pts = (v.curve || []).filter(c => c.avgExcess != null);
    if (pts.length < 2) return `<div class="cx-decay-empty">Curve appears once ≥2 days have enough resolved events.</div>`;
    const W = 300, H = 84, padL = 30, padR = 8, padT = 8, padB = 16;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxDay = v.curve.length || 20;
    let maxAbs = 1; pts.forEach(p => { maxAbs = Math.max(maxAbs, Math.abs(p.avgExcess)); });
    const x = day => padL + ((day - 1) / (maxDay - 1)) * plotW;
    const zeroY = padT + plotH / 2, y = val => zeroY - (val / maxAbs) * (plotH / 2);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.avgExcess).toFixed(1)}`).join(' ');
    const dots = pts.map(p => `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.avgExcess).toFixed(1)}" r="1.6" fill="${p.avgExcess >= 0 ? '#10d98a' : '#ef4444'}"/>`).join('');
    const hold = v.recommendedHold != null
      ? `<line x1="${x(v.recommendedHold).toFixed(1)}" y1="${padT}" x2="${x(v.recommendedHold).toFixed(1)}" y2="${H - padB}" stroke="#f0a832" stroke-width="1" stroke-dasharray="3 2"/>`
      : '';
    const grid = `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#3a4150"/>`
      + `<text x="${padL - 4}" y="${padT + 4}" text-anchor="end" font-size="8" fill="#8a93a6">+${maxAbs.toFixed(1)}%</text>`
      + `<text x="${padL - 4}" y="${zeroY + 3}" text-anchor="end" font-size="8" fill="#8a93a6">0</text>`
      + `<text x="${padL - 4}" y="${H - padB}" text-anchor="end" font-size="8" fill="#8a93a6">-${maxAbs.toFixed(1)}%</text>`
      + `<text x="${padL}" y="${H - 3}" font-size="8" fill="#8a93a6">day 1</text>`
      + `<text x="${W - padR}" y="${H - 3}" text-anchor="end" font-size="8" fill="#8a93a6">day ${maxDay}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit" role="img" aria-label="Excess vs S&P by day">${grid}${hold}<path d="${line}" fill="none" stroke="#06c4d4" stroke-width="1.5"/>${dots}</svg>`;
  }

  // The full "How long each event stays profitable" panel — one row per event type
  // with a decay curve, recommended hold window, and honest trust status.
  function cernDecayPanel(decay) {
    if (!decay || !decay.types || !Object.keys(decay.types).length) {
      return `<div class="bt-eff"><div class="bt-eff-head">📉 Decay curves — how long each event stays profitable</div>
        <div class="bt-eff-sub">Appears once the engine has logged forced-flow events. Each event's return vs the S&P is tracked day 1→20; the average shows how long the edge lasts.</div></div>`;
    }
    const order = Object.entries(decay.types).sort((a, b) => (b[1].n20 - a[1].n20) || (b[1].n - a[1].n));
    const rows = order.map(([t, v]) => `
      <div class="cx-decay-row">
        <div class="cx-decay-hd">
          <span class="cx-decay-nm">${esc(CERN_LABEL[t] || t)}</span>
          ${cernHoldChip(v)}
          <span class="cx-decay-n">${v.trustworthy ? `${v.n20} resolved` : `${v.n20}/${decay.minTrust} resolved${v.daysNeeded ? ` · ${v.daysNeeded} more to trust` : ''}`}</span>
        </div>
        <div class="cx-decay-chart" title="How this event type's market-beating edge (return vs the S&P) changes each day after it fires. Above the middle line = beating the market; below = lagging. The amber dashed line marks the day the edge peaks — the suggested time to be out by.">${cernDecaySvg(v)}</div>
      </div>`).join('');
    return `<div class="bt-eff">
      <div class="bt-eff-head">📉 Decay curves — how long each event stays profitable</div>
      <div class="bt-eff-sub">Average return <b>vs the S&P 500</b> at each day after the signal fires (excess = beat-the-market). The <span style="color:#f0a832">amber dashed line</span> marks the recommended hold — the day the edge peaks before it decays. Curves need ~${decay.minTrust} events resolved to the full 20-day window before the window is trustworthy; until then it reads "provisional" or "building".</div>
      ${rows}
    </div>`;
  }

  function renderCern(d, decay) {
    const holdMap = cernHoldMap(decay);
    const el = document.getElementById('events-container');
    if (!d.configured) {
      el.innerHTML = `<div class="mom-status"><p>${esc(d.note || 'CERN has not run yet.')} It runs daily with the warm cron — check back after the next run.</p></div>`;
      document.getElementById('events-meta').textContent = '· not yet initialized';
      return;
    }
    const sgn = v => (v >= 0 ? '+' : '') + v;

    // Decisions
    const decGroups = [
      ['TRADE', '🎯 Trade', 'Passed every gate · sized'],
      ['PROBE', '🧪 Probe', 'Paper position · exploration (learning)'],
      ['LOG_ONLY', '📝 Log-only', 'Logged & resolved for learning · no position'],
    ];
    let decHtml = '';
    const open = d.open || [];
    if (!open.length) {
      decHtml = `<div class="mom-status"><p>No live forced-flow events right now. That's normal — margin spirals need a real high-beta selloff and tax-loss selling only fires Nov–Dec. The engine scanned the universe and found nothing forced to react to. The posteriors below are its current beliefs; they move as events resolve.</p></div>`;
    } else {
      decHtml = decGroups.map(([act, name, sub]) => {
        const items = open.filter(o => o.action === act);
        if (!items.length) return '';
        const cards = items.map(o => `
          <div class="cx-card">
            <div class="cx-top">
              <div><div class="cx-tk-row"><span class="cx-ticker">${esc(o.symbol)}</span><span class="cx-tierbadge">${esc(CERN_LABEL[o.type] || o.type)}</span></div>
                <div class="cx-company">${o.side === 'long' ? 'Buy the reversion' : 'Fade the move'} · P(profit) ${(o.pProfit * 100).toFixed(0)}% · κ·x ${sgn(+(o.predMu * 100).toFixed(1))}%</div></div>
              <div class="cx-score-col"><div class="cx-score">${o.action === 'TRADE' ? (o.size * 100).toFixed(1) + '<small>%</small>' : '—'}</div><div class="cx-price">$${esc(o.entry)}</div></div>
            </div>
            <div class="alert-targets">
              <div class="at-box"><div class="at-label">Entry</div><div class="at-val entry">$${esc(o.entry)}</div></div>
              <div class="at-box"><div class="at-label">Target</div><div class="at-val target">${o.target != null ? '$' + o.target : '—'}</div></div>
              <div class="at-box"><div class="at-label">Stop</div><div class="at-val stop">${o.stop != null ? '$' + o.stop : '—'}</div></div>
            </div>
            ${cernHoldChip(holdMap[o.type]) ? `<div class="cx-card-hold">${cernHoldChip(holdMap[o.type])}</div>` : ''}
          </div>`).join('');
        return `<div class="cx-tier-head"><span class="cx-tier-name">${name}</span><span class="cx-tier-sub">${items.length} · ${sub}</span></div><div class="scr-grid">${cards}</div>`;
      }).join('');
    }

    // Posteriors panel
    const rows = Object.entries(d.posteriors).map(([k, p]) => {
      const fed = CERN_FED.includes(k);
      const nm = `<span style="${p.drifted ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(CERN_LABEL[k] || k)}</span>${fed ? '' : ' <span style="color:var(--text-dim);font-size:0.66rem">feed pending</span>'}${p.drifted ? ' <span style="color:var(--amber)">⚠ drifted</span>' : ''}`;
      return `<div class="bt-ic-row"><span>${nm}</span><span><b>${p.kappa}</b> <span style="color:var(--text-dim)">±${p.sd}</span></span><span>${p.n} resolved${p.tradedN ? ` · ${p.tradedN} traded` : ''}</span></div>`;
    }).join('');

    // Alerts
    let alertHtml = '';
    const candidates = d.candidates || [], drift = d.drift || [];
    if (candidates.length || drift.length) {
      const cand = candidates.map(c => `<div class="bt-reco">🔬 <b>Candidate event type</b> — ${esc(c.key)} (${c.n} episodes). ${esc(c.note || '')}</div>`).join('');
      const dr = drift.map(c => `<div class="bt-reco" style="background:var(--amber-dim);border-color:#f0a83233">⚠ <b>Drift</b> — ${esc(CERN_LABEL[c.eventType] || c.eventType)} kernel shifted; sizing auto-suppressed.</div>`).join('');
      alertHtml = cand + dr;
    }

    el.innerHTML = `
      <div class="bt-note">CERN logs and resolves <b>every</b> qualifying forced-flow event whether it trades or not — the archive is the moat. <b>${d.archiveCount}</b> resolved · <b>${(d.open || []).length}</b> live signal${(d.open || []).length === 1 ? '' : 's'} · <b>${d.pendingCount}</b> building. Real size is gated behind posterior t≥2 per type; early on, expect mostly Probe / Log-only.</div>
      ${decHtml}
      ${alertHtml}
      ${cernDecayPanel(decay)}
      <div class="bt-eff">
        <div class="bt-eff-head">🧠 Response-kernel posteriors (κ per event type)</div>
        <div class="bt-eff-sub">κ = the fraction of the dislocation the engine has learned reverts, ±uncertainty. Updated Bayesian-style as events resolve; rare types borrow strength from common ones. All seven types are live: <b>${CERN_FED.map(k => CERN_LABEL[k]).join(', ')}</b>.</div>
        <div class="bt-ic-row head"><span>Event type</span><span>κ ± sd</span><span>Evidence</span></div>
        ${rows}
      </div>
      <div class="chart-disclaimer">⚠ A learning system first — months 0–3 are mostly paper while the archive fills. Not financial advice.</div>`;

    document.getElementById('events-meta').textContent = `· ${d.archiveCount} resolved · ${(d.open || []).length} live · forced-flow engine`;
  }

  (() => {
    const modal = document.getElementById('ev-help-modal');
    if (!modal) return;
    const open = () => { modal.hidden = false; document.body.style.overflow = 'hidden'; };
    const close = () => { modal.hidden = true; document.body.style.overflow = ''; };
    document.getElementById('ev-help-btn')?.addEventListener('click', open);
    document.getElementById('ev-help-close')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
  })();
  document.getElementById('events-refresh-btn')?.addEventListener('click', runCern);

  // ── EDGE BOOK — two orthogonal sleeves: conviction longs + CERN forced-flow ──
  let edgeLoaded = false;
  function ensureEdge() { if (!edgeLoaded) { edgeLoaded = true; runEdge(); } }

  async function runEdge() {
    const el = document.getElementById('edge-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading the Edge Book…</p></div>`;
    try {
      const [book, scr, cern] = await Promise.all([
        fetch('/api/tracker?op=edgebook').then(r => r.json()).catch(() => null),
        fetch('/api/screener?scope=large').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=cern').then(r => r.json()).catch(() => null),
      ]);
      renderEdge(book, scr, cern);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load the Edge Book.</p></div>`; }
  }

  function renderEdge(book, scr, cern) {
    const el = document.getElementById('edge-container');
    if (!el) return;
    const conv = (scr && scr.conviction) || {};
    const regime = conv.regime || '—';
    const canLong = !!conv.longOk;

    // Sleeve A — live top-conviction longs from the screener.
    const aLive = ((scr && scr.results) || []).filter(c => c.conviction && c.conviction.sleeveA)
      .sort((a, b) => b.conviction.score - a.conviction.score);
    const aCards = aLive.length ? aLive.map(c => `
      <div class="bt-ic-row"><span><b>${esc(c.ticker)}</b> <span style="color:var(--text-dim)">${esc((c.company || '').slice(0, 22))}</span></span>
        <span>conv <b>${c.conviction.score.toFixed(1)}</b></span><span>pctile ${c.conviction.pctile}</span></div>`).join('')
      : `<div class="bt-ic-row"><span style="color:var(--text-dim)">${canLong ? 'No top-quintile conviction names right now.' : 'Regime gate is CLOSED — no new longs in risk-off.'}</span></div>`;

    // Sleeve B — live CERN forced-flow decisions (TRADE / PROBE).
    const bLive = ((cern && cern.open) || []).filter(o => o.action === 'TRADE' || o.action === 'PROBE');
    const bCards = bLive.length ? bLive.map(o => `
      <div class="bt-ic-row"><span><b>${esc(o.symbol)}</b> <span style="color:var(--text-dim)">${esc(CERN_LABEL[o.type] || o.type)}</span></span>
        <span>${esc(o.side)} · ${esc(o.action)}</span><span>P ${Math.round((o.pProfit || 0) * 100)}%</span></div>`).join('')
      : `<div class="bt-ic-row"><span style="color:var(--text-dim)">No live forced-flow signals — CERN is mostly logging/probing while its posteriors mature.</span></div>`;

    // Tracking — realized beat-SPY per sleeve + the cross-sleeve correlation (the thesis).
    const byS = Object.fromEntries(((book && book.sleeves) || []).map(s => [s.sleeve, s]));
    const statRow = (label, s) => {
      if (!s) return `<div class="bt-ic-row"><span>${label}</span><span style="color:var(--text-dim)">—</span><span></span></div>`;
      const br = s.beatSpyRate != null ? `${Math.round(s.beatSpyRate * 100)}% <span style="color:var(--text-dim)">(LB ${Math.round(s.wilsonLo * 100)}%)</span>` : '<span style="color:var(--text-dim)">pending</span>';
      const ex = s.avgExcessVsSpy != null ? `${s.avgExcessVsSpy > 0 ? '+' : ''}${s.avgExcessVsSpy}%` : '—';
      return `<div class="bt-ic-row"><span>${label} <span style="color:var(--text-dim)">${s.total} logged · ${s.resolved} resolved</span></span><span>beat SPY ${br}</span><span>avg ${ex}</span></div>`;
    };
    const cs = (book && book.crossSleeve) || {};
    const corrTxt = cs.correlation != null
      ? `Cross-sleeve correlation <b>${cs.correlation}</b> over ${cs.pairedDates} paired days — the overlay thesis wants this near 0 (uncorrelated streams diversify).`
      : `Cross-sleeve correlation: <b>accruing</b> (${cs.pairedDates || 0} paired days; needs ≥8). This is the number that proves — or kills — the overlay.`;

    el.innerHTML = `
      <div class="bt-note">A <b>paper</b> two-sleeve book. <b>Sleeve A</b> = regime-gated <b>conviction longs</b> (the validated momentum+BONUS ranker; ~0.08 out-of-sample IC, best in risk-on). <b>Sleeve B</b> = <b>CERN forced-flow</b> reversion (orthogonal, but unproven until its κ-posteriors ship). They harvest different names — the win is at the <b>portfolio</b> level if their returns are uncorrelated.</div>
      <div class="bt-eff" style="background:${canLong ? '#16241a' : '#241616'};border-color:${canLong ? '#2e6b3e' : '#6b2e2e'}">
        <div class="bt-eff-sub">Regime: <b>${esc(regime)}</b> — long gate is <b>${canLong ? 'OPEN ✓' : 'CLOSED ✗ (risk-off: no new longs)'}</b>.</div>
      </div>
      <div class="bt-eff">
        <div class="bt-eff-head">🅰 Sleeve A · Conviction longs <span style="color:var(--text-dim);font-weight:400">(top quintile, live)</span></div>
        ${aCards}
      </div>
      <div class="bt-eff">
        <div class="bt-eff-head">🅱 Sleeve B · CERN forced-flow <span style="color:var(--text-dim);font-weight:400">(TRADE / PROBE, live)</span></div>
        ${bCards}
      </div>
      <div class="bt-eff">
        <div class="bt-eff-head">📈 Paper track record <span style="color:var(--text-dim);font-weight:400">(beat-SPY, ${(book && book.horizonDays) || 21}-day)</span></div>
        ${statRow('🅰 Conviction', byS.A)}
        ${statRow('🅱 Forced-flow', byS.B)}
        <div class="bt-eff-sub" style="margin-top:8px">${corrTxt}</div>
      </div>
      <div class="chart-disclaimer">⚠ Paper book — accumulating evidence. Real capital only once each sleeve clears its gate and the correlation confirms diversification. Not financial advice.</div>`;

    const meta = document.getElementById('edge-meta');
    if (meta) meta.textContent = `· ${aLive.length} conviction · ${bLive.length} forced-flow · paper`;
    const gt = document.getElementById('edge-gen-time');
    if (gt && book && book.generatedAt) gt.textContent = new Date(book.generatedAt).toLocaleTimeString();
  }

  document.getElementById('edge-refresh-btn')?.addEventListener('click', runEdge);

  // ── Overheated (self-improving inverted-V fade engine) ──────────────────────
  // Novice-first: the engine flags names that spiked then started rolling over and,
  // from its own learned per-stock history, expects to LAG the market over ~1 month.
  // Primary action is AVOID / TRIM (no shorting needed); advanced short details are
  // tucked behind a toggle. The live track record leads, because that's the trust.
  // ── Core Momentum — survivorship-safe small/mid sector-neutral 12-1 (research-validated) ──
  let coremoLoaded = false, coremoCore = null, coremoDrift = null, coremoTopN = 0; // topN 0 = show all
  function ensureCoreMomentum() { if (!coremoLoaded) { coremoLoaded = true; runCoreMomentum(); } }
  async function runCoreMomentum() {
    const cont = document.getElementById('coremo-container');
    const health = document.getElementById('coremo-health-banner');
    const time = document.getElementById('coremo-gen-time');
    if (cont && !coremoCore) cont.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading the Core Momentum book…</p></div>`;
    try {
      const [c, d] = await Promise.all([
        fetch('/api/tracker?op=core').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=coredrift').then(r => r.json()).catch(() => null),
      ]);
      coremoCore = c; coremoDrift = d;
    } catch { /* render whatever we have */ }
    renderCoreHealth(health, coremoDrift);
    renderCoreBook(cont, coremoCore);
    if (time && coremoCore && coremoCore.asOf) time.textContent = 'updated ' + timeAgo(new Date(coremoCore.asOf));
  }
  function coreHealthColor(s) { return s === 'HEALTHY' ? 'var(--green,#10d98a)' : s === 'DEGRADING' ? '#f0a832' : s === 'BROKEN' ? 'var(--red,#ef4444)' : '#8a93a6'; }
  function renderCoreHealth(el, d) {
    if (!el) return;
    if (!d || d.ok === false) { el.innerHTML = ''; return; }
    if (d.status === 'PENDING') {
      el.innerHTML = `<div class="cx-strip" style="border-left:3px solid #8a93a6"><b>Track record: building.</b> ${esc(d.note || 'Signals log quarterly on rebalance and resolve over ~3 months.')} ${d.resolved ? `(${d.resolved} resolved so far)` : ''}</div>`;
      return;
    }
    const col = coreHealthColor(d.status);
    const pct = x => x == null ? '—' : (x * 100).toFixed(0) + '%';
    const wil = d.wilson ? ` (90% CI ${pct(d.wilson.low)}–${pct(d.wilson.high)})` : '';
    const kill = d.killSwitch ? `<div style="margin-top:6px;color:var(--red,#ef4444)"><b>⛔ Kill-switch:</b> live expectancy is negative — revert to passive small/mid exposure until it recovers.</div>` : '';
    el.innerHTML = `<div class="cx-strip" style="border-left:3px solid ${col}">
      <b style="color:${col}">● ${esc(d.status)}</b> — live win rate <b>${pct(d.winRate)}</b>${wil}, profit factor <b>${d.profitFactor == null ? '—' : d.profitFactor.toFixed(2)}</b>, mean return/trade <b>${pct(d.meanReturn)}</b>
      · resolved <b>${d.resolved}</b> / open ${d.open}
      <span style="color:#8a93a6">· baseline win ${pct(d.baseline && d.baseline.winRate)} / PF ${d.baseline ? d.baseline.pf : '—'} (research)</span>
      ${d.recommendation ? `<div style="margin-top:4px">${esc(d.recommendation)}</div>` : ''}${kill}</div>`;
  }
  function renderCoreBook(cont, c) {
    if (!cont) return;
    if (!c || c.ok === false) { cont.innerHTML = `<div class="mom-status"><p>Core Momentum isn't available yet. It needs the Blob store + the daily cron to seed the feature cache (a few runs). See PICK-TRACKING.md.</p></div>`; return; }
    const intro = `<div class="cx-strip" style="margin-bottom:10px">
      <b>What this is.</b> The survivorship-safe small/mid <b>sector-neutral 12-1 momentum</b> sleeve validated in research: cap $800M–5B, top realized-vol tercile excluded, Healthcare excluded; equal-weight the top quintile with a rank buffer; rebalanced quarterly.
      <span style="color:#8a93a6">Forward IR realistically ~0.8–1.2 (in-sample was higher — discounted for filter selection). A concentrated sleeve, not a replacement for broad exposure.</span></div>`;
    if (c.building || !c.book || !c.book.length) {
      const cov = c.coveragePct != null ? c.coveragePct : (c.universeCovered ? '' : 0);
      cont.innerHTML = intro + `<div class="mom-status"><div class="mom-spinner"></div><p>Building the universe feature cache${c.universeCovered ? ` — ${c.universeCovered} names cached so far` : ''}. The daily cron fills it over a few runs; the book appears once enough names are covered.${c.note ? '<br><span style="color:#8a93a6">' + esc(c.note) + '</span>' : ''}</p></div>`;
      return;
    }
    const rebal = c.rebalanceWindow ? `<span style="color:#10d98a">● rebalance window (${esc(c.quarter || '')}) — book logs this quarter</span>` : `<span style="color:#8a93a6">next rebalance: first half of Jan/Apr/Jul/Oct · ${esc(c.quarter || '')}</span>`;
    const regime = c.regime ? `<span style="color:${c.regime === 'risk-on' ? '#10d98a' : '#f0a832'}">regime: ${esc(c.regime)}</span>` : '';
    const cnt = { new: 0, held: 0, watch: 0 }; c.book.forEach(x => { cnt[x.status] = (cnt[x.status] || 0) + 1; });
    const head = `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;font-size:0.72rem">
      <span><b>${c.book.length}</b> names</span><span style="color:#10d98a">🟢 ${cnt.new} new</span><span>● ${cnt.held} held</span><span style="color:#f0a832">⚠️ ${cnt.watch} watch</span><span>pool ${c.pool}</span><span>cache ${c.universeCovered}</span>${regime ? '<span>' + regime + '</span>' : ''}<span>${rebal}</span></div>`;
    // top-N selector — lets you focus on the strongest-ranked subset (with the caveat below)
    const opts = [['Top 10', 10], ['Top 25', 25], ['Top 50', 50], ['All', 0]];
    const controls = `<div class="scr-filters" style="margin-bottom:8px;display:flex;gap:6px;align-items:center">
      <span style="font-size:0.66rem;color:#8a93a6">Show:</span>` +
      opts.map(([l, n]) => `<button class="cm-topn refresh-btn" data-n="${n}" style="${coremoTopN === n ? 'color:#10d98a;font-weight:700;border-color:#10d98a' : 'color:#8a93a6'}">${l}</button>`).join('') + `</div>`;
    const STATUS = {
      new: '<span title="new entry — not in the last rebalance" style="color:#10d98a">🟢 new</span>',
      held: '<span title="held and healthy (still in the top-20% entry band)" style="color:#cbd2dd">● held</span>',
      watch: '<span title="held but deteriorating — only kept by the rank buffer; nearing the exit band" style="color:#f0a832">⚠️ watch</span>',
    };
    const delta = x => x.rankChange == null ? '<span style="color:#10d98a" title="new since last rebalance">new</span>'
      : x.rankChange > 0 ? `<span style="color:#10d98a" title="moved up ${x.rankChange}">▲${x.rankChange}</span>`
      : x.rankChange < 0 ? `<span style="color:var(--red,#ef4444)" title="moved down ${-x.rankChange}">▼${-x.rankChange}</span>`
      : '<span style="color:#8a93a6">—</span>';
    const shown = coremoTopN > 0 ? c.book.slice(0, coremoTopN) : c.book;
    const rows = shown.map(x => `<tr>
      <td style="text-align:right;color:#8a93a6">${x.rank}</td>
      <td style="text-align:center;font-size:0.66rem">${delta(x)}</td>
      <td><b>${esc(x.ticker)}</b><div style="font-size:0.62rem;color:#8a93a6">${esc((x.company || '').slice(0, 24))}</div></td>
      <td style="font-size:0.66rem">${esc(x.sector)}</td>
      <td style="text-align:right" title="strength percentile vs the whole eligible universe">${x.strength}</td>
      <td style="text-align:right;color:${x.mom12_1 >= 0 ? '#10d98a' : 'var(--red,#ef4444)'}">${x.mom12_1 > 0 ? '+' : ''}${x.mom12_1}%</td>
      <td style="text-align:right">${x.vol}%</td>
      <td style="text-align:right">${fmtMoney(x.marketCap)}</td>
      <td style="text-align:right">$${x.advM}M</td>
      <td style="text-align:right">${x.levels ? '$' + x.levels.entry : '—'}</td>
      <td style="text-align:center;font-size:0.66rem">${STATUS[x.status] || x.status}</td>
    </tr>`).join('');
    cont.innerHTML = intro + head + controls + `<div style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:0.74rem">
      <thead><tr><th style="text-align:right">#</th><th style="text-align:center" title="rank change since the last rebalance">Δ</th><th>Ticker</th><th>Sector</th><th style="text-align:right" title="strength percentile vs the universe">Str</th><th style="text-align:right">12-1</th><th style="text-align:right">vol</th><th style="text-align:right">cap</th><th style="text-align:right">ADV</th><th style="text-align:right">entry</th><th style="text-align:center">status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p style="font-size:0.62rem;color:#8a93a6;margin-top:8px">Ranked by sector-neutral momentum. <b>Δ</b> = rank change since the last rebalance (${c.lastRebalance ? esc(c.lastRebalance) : 'none yet'}); <b>Str</b> = strength percentile vs the universe; <b>status</b>: 🟢 new · ● held · ⚠️ deteriorating (near the buffer exit). Ranks refresh daily; <b>trade only at the quarterly rebalance</b> — frequent trading destroyed the edge in testing.</p>
      <p style="font-size:0.62rem;color:#f0a832;margin-top:6px">⚠️ The validated approach is the <b>full equal-weight basket</b>. Focusing on a Top-N subset is your choice and adds idiosyncratic risk <i>without</i> proven extra return — within the book the ranking's predictive power is weak.</p>`;
    cont.querySelectorAll('.cm-topn').forEach(b => b.addEventListener('click', () => { coremoTopN = parseInt(b.dataset.n, 10) || 0; renderCoreBook(cont, c); }));
  }
  const _coremoBtn = document.getElementById('coremo-refresh-btn');
  if (_coremoBtn) _coremoBtn.addEventListener('click', () => { coremoCore = null; runCoreMomentum(); });

  // ── Core Performance — quarterly realized track record vs IWM ──
  let coreperfLoaded = false;
  function ensureCorePerf() { if (!coreperfLoaded) { coreperfLoaded = true; runCorePerf(); } }
  async function runCorePerf() {
    const cont = document.getElementById('coreperf-container');
    const time = document.getElementById('coreperf-gen-time');
    if (cont) cont.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading the Core Momentum track record…</p></div>`;
    let d; try { d = await fetch('/api/tracker?op=coreperf').then(r => r.json()); } catch { d = null; }
    renderCorePerf(cont, d);
    if (time) time.textContent = 'updated ' + timeAgo(new Date());
  }
  function renderCorePerf(cont, d) {
    if (!cont) return;
    if (!d || d.ok === false) { cont.innerHTML = `<div class="mom-status"><p>Core Performance isn't available yet (needs the Blob store + the daily cron). See CORE-MOMENTUM.md.</p></div>`; return; }
    const pct = x => x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
    const col = x => x == null ? '' : `color:${x >= 0 ? 'var(--green,#10d98a)' : 'var(--red,#ef4444)'}`;
    const intro = `<div class="cx-strip" style="margin-bottom:10px">
      <b>What this is.</b> The realized track record of the <b>Core Momentum</b> sleeve — each quarterly cohort logged at rebalance, scored on its forward outcomes (+target / −stop / ~63-session time exit) vs <b>IWM</b> (Russell 2000, the small-cap benchmark).
      <span style="color:#8a93a6">Open positions are counted but not marked-to-market — only resolved trades enter the returns (matches the drift methodology). Realistic forward IR ~0.8–1.2; confirm over ~8 live quarters.</span></div>`;
    if (d.empty || !d.quarters || !d.quarters.length) {
      cont.innerHTML = intro + `<div class="mom-status"><p>${esc(d.note || 'No cohorts logged yet — the track record begins at the first quarterly rebalance.')}</p></div>`;
      return;
    }
    const c = d.cumulative || {}, t = d.totals || {};
    const summary = `<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;font-size:0.8rem">
      <div><div style="color:#8a93a6;font-size:0.62rem">SINCE INCEPTION (realized)</div><b style="${col(c.strategyReturn)};font-size:1.1rem">${pct(c.strategyReturn)}</b></div>
      <div><div style="color:#8a93a6;font-size:0.62rem">IWM (same windows)</div><b style="${col(c.benchReturn)};font-size:1.1rem">${pct(c.benchReturn)}</b></div>
      <div><div style="color:#8a93a6;font-size:0.62rem">EXCESS vs IWM</div><b style="${col(c.excess)};font-size:1.1rem">${pct(c.excess)}</b></div>
      <div><div style="color:#8a93a6;font-size:0.62rem">WIN RATE</div><b>${t.winRate == null ? '—' : (t.winRate * 100).toFixed(0) + '%'}</b></div>
      <div><div style="color:#8a93a6;font-size:0.62rem">RESOLVED / OPEN</div><b>${t.resolved} / ${t.open}</b></div>
      <div><div style="color:#8a93a6;font-size:0.62rem">REALIZED QTRS</div><b>${c.realizedQuarters || 0}</b></div></div>`;
    const STAT = { open: '<span style="color:#8a93a6">○ open</span>', partial: '<span style="color:#f0a832">◐ partial</span>', closed: '<span style="color:#10d98a">● closed</span>' };
    const rows = d.quarters.slice().reverse().map(q => `<tr>
      <td><b>${esc(q.quarter)}</b><div style="font-size:0.6rem;color:#8a93a6">${esc(q.logDate || '')}</div></td>
      <td style="text-align:right">${q.n}</td>
      <td style="text-align:right;color:#8a93a6">${q.resolved}/${q.open}</td>
      <td style="text-align:right">${q.winRate == null ? '—' : (q.winRate * 100).toFixed(0) + '%'}</td>
      <td style="text-align:right;${col(q.meanReturn)}">${pct(q.meanReturn)}</td>
      <td style="text-align:right;color:#8a93a6">${pct(q.benchReturn)}</td>
      <td style="text-align:right;${col(q.excess)}">${pct(q.excess)}</td>
      <td style="text-align:right">${STAT[q.status] || q.status}</td>
    </tr>`).join('');
    cont.innerHTML = intro + summary + coreperfChart(d.quarters) + `<div style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:0.74rem">
      <thead><tr><th>Quarter</th><th style="text-align:right">#</th><th style="text-align:right">res/open</th><th style="text-align:right">win</th><th style="text-align:right">return</th><th style="text-align:right">IWM</th><th style="text-align:right">excess</th><th style="text-align:right">status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p style="font-size:0.62rem;color:#8a93a6;margin-top:8px">Return = equal-weight realized return of that quarter's <i>resolved</i> picks. A quarter stays "open/partial" until its ~63-session windows elapse. Cumulative compounds realized quarters only.</p>`;
  }
  // Responsive SVG: per-quarter realized return (Core) vs IWM, around a zero baseline.
  function coreperfChart(quarters) {
    const R = (quarters || []).filter(q => q.meanReturn != null);
    if (!R.length) return `<div class="cx-strip" style="margin-bottom:12px;color:#8a93a6">📈 The performance chart appears once a quarter's positions resolve (forward windows are ~3 months).</div>`;
    const W = Math.max(360, R.length * 110 + 60), H = 220, padL = 46, padR = 14, padT = 18, padB = 34;
    const plotH = H - padT - padB, zeroY = padT + plotH / 2, halfH = plotH / 2, plotW = W - padL - padR;
    let maxAbs = 0.05; R.forEach(q => { maxAbs = Math.max(maxAbs, Math.abs(q.meanReturn || 0), Math.abs(q.benchReturn || 0)); });
    const gw = plotW / R.length, y = v => zeroY - (v / maxAbs) * halfH;
    const bar = (cx, bw, v, fill) => { if (v == null) return ''; const yy = y(v), top = Math.min(yy, zeroY), h = Math.max(1, Math.abs(yy - zeroY)); return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${fill}"/>`; };
    const fmtp = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
    let bars = '', labels = '';
    R.forEach((q, i) => {
      const c0 = padL + i * gw + gw / 2, bw = Math.min(22, gw * 0.28);
      bars += bar(c0 - bw * 0.62, bw, q.meanReturn, q.meanReturn >= 0 ? '#10d98a' : '#ef4444');
      bars += bar(c0 + bw * 0.62, bw, q.benchReturn, '#5b6472');
      labels += `<text x="${c0.toFixed(1)}" y="${H - padB + 14}" text-anchor="middle" font-size="10" fill="#8a93a6">${esc(q.quarter)}</text>`;
    });
    const grid = `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#3a4150"/>`
      + `<text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="9" fill="#8a93a6">${fmtp(maxAbs)}</text>`
      + `<text x="${padL - 6}" y="${zeroY + 3}" text-anchor="end" font-size="9" fill="#8a93a6">0</text>`
      + `<text x="${padL - 6}" y="${H - padB}" text-anchor="end" font-size="9" fill="#8a93a6">${fmtp(-maxAbs)}</text>`;
    const legend = `<rect x="${padL}" y="3" width="9" height="9" fill="#10d98a"/><text x="${padL + 13}" y="11" font-size="10" fill="#cbd2dd">Core</text>`
      + `<rect x="${padL + 50}" y="3" width="9" height="9" fill="#5b6472"/><text x="${padL + 63}" y="11" font-size="10" fill="#cbd2dd">IWM</text>`;
    return `<div style="margin-bottom:12px"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit" role="img" aria-label="Quarterly Core vs IWM returns">${grid}${bars}${labels}${legend}</svg></div>`;
  }
  const _coreperfBtn = document.getElementById('coreperf-refresh-btn');
  if (_coreperfBtn) _coreperfBtn.addEventListener('click', () => runCorePerf());

  let fadeLoaded = false;
  function ensureFade() { if (!fadeLoaded) { fadeLoaded = true; runFade(); } }

  async function runFade() {
    const el = document.getElementById('fade-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading Overheated names…</p></div>`;
    try {
      const [sig, book] = await Promise.all([
        fetch('/api/tracker?op=fadesignals&scope=large').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=fadebook').then(r => r.json()).catch(() => null),
      ]);
      renderFade(sig, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Overheated names.</p></div>`; }
  }

  const FADE_REGIME = {
    'risk-on': ['Risk-On', 'var(--green)'], neutral: ['Neutral', 'var(--amber)'],
    'risk-off': ['Risk-Off', 'var(--red)'], unknown: ['—', 'var(--text-dim)'],
  };
  const coolOffScore = r => Math.max(0, Math.min(100, Math.round(38 + (r.expAlpha || 0) * 14)));
  const coolColor = s => (s >= 75 ? '#ff4a4a' : s >= 58 ? '#ff8a3a' : 'var(--amber)');

  function renderFade(sig, book) {
    const el = document.getElementById('fade-container');
    if (!el) return;
    if (!sig || !sig.ok) { el.innerHTML = `<div class="mom-status error"><p>Overheated engine unavailable.</p></div>`; return; }
    if (sig.seeded === false) { el.innerHTML = `<div class="mom-status"><p>The engine is not seeded yet. (Admin: run <code>op=fadeseed</code>.)</p></div>`; return; }

    const [rLabel, rColor] = FADE_REGIME[sig.regime] || FADE_REGIME.unknown;
    const gated = sig.regime === 'risk-off';

    // --- Live track record (the trust): lead with it. ---
    const resolved = book && book.resolved || 0;
    let trackHtml;
    if (book && resolved >= 10) {
      const o = book.overall || {};
      const act = book.actionableOnly || {};
      trackHtml = `<div class="fade-track">
        <div class="fade-track-big">${o.beatRate}%<span>of flagged names underperformed the market</span></div>
        <div class="fade-track-sub">over the next ~${sig.holdSessions} trading days · avg ${o.avgAlpha > 0 ? '+' : ''}${o.avgAlpha}% vs market · ${resolved} resolved (${book.stillOpen} still open)
        ${act.n ? ` · the engine's top-rated picks: ${act.beatRate}% (LB ${act.wilsonLo}%)` : ''}</div></div>`;
    } else {
      trackHtml = `<div class="fade-track fade-track-pending">
        <div class="fade-track-big">Building track record…<span>live results accrue automatically</span></div>
        <div class="fade-track-sub">${book ? `${book.stillOpen || 0} picks logged, ${resolved} resolved so far.` : ''} Each flagged name is scored ~${sig.holdSessions} trading days later. Until then, expectations below come from back-testing (see caveat).</div></div>`;
    }

    // --- The Avoid/Trim list ---
    const picks = (sig.recommendations || []).filter(r => (r.action === 'SHORT' || r.action === 'SHORT_LIGHT') && r.geomFavorable).slice(0, 20);
    const cards = picks.map(r => {
      const s = coolOffScore(r);
      const g = r.geometry || {}; const ref = r.refLevels || {};
      const thesis = `Ran up ${g.risePct != null ? '~' + Math.round(g.risePct) + '%' : 'sharply'} into a peak, now rolling over${g.dropOffHighPct != null ? ` (−${Math.round(g.dropOffHighPct)}% off the high)` : ''}.`;
      const exp = r.netExpAlpha != null ? `${r.netExpAlpha > 0 ? '+' : ''}${r.netExpAlpha}%` : '—';
      const strong = r.action === 'SHORT';
      return `<div class="fade-card">
        <div class="fade-card-top">
          <div class="fade-score" style="--c:${coolColor(s)}">${s}<span>cool-off</span></div>
          <div class="fade-id">
            <div class="fade-tk"><b data-live="${esc(r.ticker)}">${esc(r.ticker)}</b> <span class="fade-sec">${esc(r.sector || '')}</span>
              <span class="fade-badge" style="background:${strong ? '#ff4a4a22' : '#ff8a3a22'};color:${strong ? '#ff6b6b' : '#ffa256'}">${strong ? 'AVOID / TRIM' : 'CAUTION'}</span></div>
            <div class="fade-thesis">${thesis}</div>
          </div>
        </div>
        <div class="fade-card-stats">
          <span title="Historical avg market-lag for this name, net of costs">hist. lag ${exp}</span>
          <span title="Engine confidence the edge is positive">confidence ${Math.round((r.conviction || 0) * 100)}%</span>
          <span title="Times this name has set up before">${r.n || 0} priors</span>
          <details class="fade-adv"><summary>advanced ▸ short trade</summary>
            <div class="fade-adv-body">Short ${esc(r.ticker)} @ ~${ref.entry ?? '—'}, market-neutral vs SPY, hold ~${sig.holdSessions} sessions. Suggested weight ${r.sizePct}%. Reference stop ${ref.stop ?? '—'} / target ${ref.target ?? '—'} (the validated trade is the timed hold — don't manage the stop tightly).</div>
          </details>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="fade-head">
        <div class="fade-regime">Market regime: <b style="color:${rColor}">${rLabel}</b></div>
        <div class="fade-tagline">${gated
          ? '⛔ Risk-off — the engine stands down. Fading overheated names does NOT work in risk-off, so no signals today.'
          : `These names look <b>overheated</b> and historically lag the market over the next ~${sig.holdSessions} trading days. Simplest use: <b>don’t chase them</b>, and consider <b>trimming</b> if you hold them.`}</div>
      </div>
      ${trackHtml}
      ${gated ? '' : `<div class="fade-list">${cards || '<div class="mom-status"><p>No overheated names clearing the bar right now.</p></div>'}</div>`}
      <div class="fade-caveats">
        <b>How to read this.</b> A high <b>cool-off score</b> means the engine, from this stock’s own past, expects it to lag the market over the next month. <b>Confidence</b> is how sure it is the edge is real. The engine <b>learns continuously</b> — names whose tops stop reverting are dropped automatically.
        <br><b>Honest caveats.</b> The edge is real but <b>modest</b> (~+1%/month market-neutral on the top names, net of costs) and only works in <b>risk-on/neutral</b> markets. The "hist. lag" figures are back-tested averages and run optimistic — the <b>live track record above</b> is the number to trust as it fills in. This is research, not financial advice.
      </div>`;

    const meta = document.getElementById('fade-meta');
    if (meta) meta.textContent = gated ? '· risk-off — engine standing down' : `· ${picks.length} overheated names · ${sig.actionable} actionable`;
    const gt = document.getElementById('fade-gen-time');
    if (gt && sig.generatedAt) gt.textContent = new Date(sig.generatedAt).toLocaleTimeString();
  }

  document.getElementById('fade-refresh-btn')?.addEventListener('click', runFade);

  // ── Trend Rider (trend-following + momentum + market-climate traffic light) ──
  // The light is the star: validated that forward returns in green >> red. The
  // basket is "what to ride when it's green." Self-learning (per-stock trend
  // quality) drops names that stop trending; track record proves the light live.
  let trendRiderLoaded = false;
  function ensureTrendRider() { if (!trendRiderLoaded) { trendRiderLoaded = true; runTrendRider(); } }
  async function runTrendRider() {
    const el = document.getElementById('trendr-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Reading the market climate…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch('/api/tracker?op=trend').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=trendbook').then(r => r.json()).catch(() => null),
      ]);
      renderTrendRider(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Trend Rider.</p></div>`; }
  }

  const TR_LIGHT = {
    green: ['#22c55e', 'GREEN', 'Favorable — ride trends'],
    yellow: ['#eab308', 'YELLOW', 'Mixed — be selective, size down'],
    red: ['#ef4444', 'RED', 'Stand down — avoid new trend longs'],
  };
  // Plain-English "what to do right now" per light colour.
  const TR_NOW = {
    green: ['Ride trends', 'The market climate favors trend-following — pick names from the ride list below.'],
    yellow: ['Be selective', 'Mixed climate — take only the strongest trends and size down.'],
    red: ['Stand down', "Don't add new trend longs — protect capital and wait for the light to turn green."],
  };

  function renderTrendRider(t, book) {
    const el = document.getElementById('trendr-container');
    if (!el) return;
    if (!t || !t.ok) { el.innerHTML = `<div class="mom-status error"><p>Trend Rider unavailable.</p></div>`; return; }
    const L = t.light || {}; const col = L.color || 'yellow';
    const [c, lbl, desc] = TR_LIGHT[col] || TR_LIGHT.yellow;
    const cmp = L.components || {};

    // The big traffic light.
    const lamp = clr => `<div class="tr-lamp" style="background:${col === clr ? TR_LIGHT[clr][0] : '#1b2740'};box-shadow:${col === clr ? '0 0 18px ' + TR_LIGHT[clr][0] : 'none'}"></div>`;
    const lightHtml = `<div class="tr-light-wrap">
      <div class="tr-light">${lamp('red')}${lamp('yellow')}${lamp('green')}</div>
      <div class="tr-light-info">
        <div class="tr-light-status" style="color:${c}">${lbl}</div>
        <div class="tr-light-desc">${desc}</div>
        <div class="tr-light-score">climate score <b>${L.score ?? '—'}</b>/100</div>
        <div class="tr-light-cmp">
          <span class="${cmp.spyAbove200 ? 'on' : 'off'}">SPY ${cmp.spyAbove200 ? '>' : '<'} 200DMA</span>
          <span class="${cmp.ma200Rising ? 'on' : 'off'}">200DMA ${cmp.ma200Rising ? 'rising' : 'flat/falling'}</span>
          <span class="${(cmp.efficiency || 0) >= 0.3 ? 'on' : 'off'}">trend efficiency ${cmp.efficiency ?? '—'}</span>
          <span class="${(cmp.breadth || 0) >= 0.5 ? 'on' : 'off'}">breadth ${Math.round((cmp.breadth || 0) * 100)}%</span>
          <span class="${cmp.regime === 'risk-on' ? 'on' : cmp.regime === 'risk-off' ? 'off' : ''}">${cmp.regime || '—'}</span>
        </div>
      </div></div>`;

    // Easy-to-follow how-to caption — what the light is and what to do right now.
    const [nowLbl, nowDesc] = TR_NOW[col] || TR_NOW.yellow;
    const howToHtml = `<div class="tr-howto">
      <div class="tr-howto-head">📖 How to use this tab</div>
      <div class="tr-howto-now" style="color:${c};border-color:${c}55;background:${c}14">Right now → <b>${lbl}: ${nowLbl}.</b> ${nowDesc}</div>
      <ol>
        <li><b>Read the light first.</b> It scores today's whole-market climate 0–100 for trend-following — it tells you <i>when</i> to ride trends, not which single stock will win.</li>
        <li><b>Act on the colour.</b> <b style="color:${TR_LIGHT.green[0]}">Green</b> = ride · <b style="color:${TR_LIGHT.yellow[0]}">Yellow</b> = be selective, size down · <b style="color:${TR_LIGHT.red[0]}">Red</b> = stand down on new longs.</li>
        <li><b>Pick from the ride list.</b> When green or yellow, choose from the diversified top-momentum names below (capped at 3 per sector).</li>
        <li><b>Hold &amp; trail.</b> Stay in while a name holds above its trailing 50DMA; the engine automatically drops names that stop trending.</li>
      </ol>
    </div>`;

    // Live track record by light color (the proof).
    let trackHtml = '';
    if (book && book.resolved >= 10) {
      const row = (name, s) => s && s.n ? `<div class="bt-ic-row"><span>${name} <span style="color:var(--text-dim)">${s.n} picks</span></span><span>avg ${s.avgRet > 0 ? '+' : ''}${s.avgRet}%</span><span>${L('beatRate', 'beat SPY')} ${s.beatRate}% <span style="color:var(--text-dim)">(${L('wilsonLB', 'LB')} ${s.wilsonLo}%)</span></span></div>` : '';
      trackHtml = `<div class="rot-panel"><div class="rot-head">📊 Live track record — does the light work?</div>
        <div class="rot-sub">Forward ${book.note.includes('21') ? '~1-month' : ''} returns of logged picks, split by the light when they were picked. Green should beat red.</div>
        ${row('🟢 Green', book.byClimate.green)}${row('🟡 Yellow', book.byClimate.yellow)}${row('🔴 Red', book.byClimate.red)}
        <div class="bt-ic-row" style="border-top:1px solid var(--border);margin-top:4px"><span><b>All picks</b></span><span></span><span>${book.resolved} resolved · ${book.stillOpen} open</span></div></div>`;
    } else {
      trackHtml = `<div class="rot-panel rot-panel-pending"><div class="rot-head">📊 Live track record — building…</div><div class="rot-sub">${book ? `${book.stillOpen || 0} picks logged, ${book.resolved || 0} resolved.` : ''} Each pick is scored ~1 month later; this fills in automatically. Until then, the back-test showed green picks beat red by a wide margin (and red underperformed SPY by ~12% out-of-sample).</div></div>`;
    }

    // The basket (only meaningful when not red).
    const basket = t.basket || [];
    let basketHtml;
    if (col === 'red') {
      basketHtml = `<div class="rot-panel"><div class="rot-head">🛑 Basket suppressed</div><div class="rot-sub">The climate is red — historically the worst time to add trend longs (they underperformed SPY ~12% out-of-sample). The engine shows no new ride list. Protect capital; wait for the light to turn.</div></div>`;
    } else {
      const rows = basket.slice(0, 15).map((b, i) => `<div class="bt-ic-row">
        <span><b data-live="${esc(b.ticker)}">${esc(b.ticker)}</b> <span style="color:var(--text-dim)">${esc(b.sector || '')}</span></span>
        <span>mom ${b.mom > 0 ? '+' : ''}${b.mom}%</span>
        <span>$${b.price} <span style="color:var(--text-dim)">trail ${b.trailStop}</span></span></div>`).join('');
      basketHtml = `<div class="rot-panel"><div class="rot-head">🏇 Ride list — top trends ${col === 'yellow' ? '(size down — yellow)' : ''}</div>
        <div class="rot-sub">Confirmed uptrends (above a rising 200DMA &amp; 50DMA) with the strongest 12-1 momentum, capped at 3 per sector for diversification. Trend-follow: ride while above the trailing 50DMA; the learner drops names that stop trending.</div>
        ${rows || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No qualifying uptrends right now.</span></div>'}</div>`;
    }

    // 🚀 Fresh momentum movers — the recent-thrust lane (validated large-cap momentum signal).
    const movers = t.movers || [];
    const mb = book && book.movers;
    let moversTrack = '';
    if (mb && mb.n >= 8) {
      const good = mb.avgExc >= 0;
      moversTrack = ` <span style="color:${good ? 'var(--green)' : 'var(--amber,#f59e0b)'}">Live: ${mb.n} resolved · avg exc ${mb.avgExc > 0 ? '+' : ''}${mb.avgExc}% · ${mb.beatRate}% beat SPY.</span>`;
    } else {
      moversTrack = ` <span style="color:var(--text-dim)">Live tracking (excess vs SPY) accrues via the cron${mb && mb.stillOpen ? ` — ${mb.stillOpen} open` : ''}.</span>`;
    }
    const moverRows = movers.slice(0, 12).map(m => `<div class="bt-ic-row">
        <span><b data-live="${esc(m.ticker)}">${esc(m.ticker)}</b> <span style="color:var(--text-dim)">${esc(m.sector || '')}</span></span>
        <span>5d ${m.ret5 > 0 ? '+' : ''}${m.ret5}% · RS +${m.rs}</span>
        <span>$${m.price} <span style="color:var(--text-dim)">score ${m.score}</span></span></div>`).join('');
    const moversHtml = `<div class="rot-panel"><div class="rot-head">🚀 Fresh momentum movers <span class="dt-dim">(new)</span></div>
      <div class="rot-sub">Large/mid-cap names ($150M+ daily $-vol) in an established uptrend (above the 50 &amp; 200-DMA) making a <b>fresh 5-day thrust</b> (8–30%) while leading SPY — the recent-mover complement to the 12-month ride list above. Backtested <b>+4.96%/21d excess vs SPY</b> (54% win, $150M+ tier).${moversTrack}</div>
      ${moverRows || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No fresh large-cap momentum movers right now.</span></div>'}</div>`;

    el.innerHTML = `${lightHtml}${howToHtml}${basketHtml}${moversHtml}${trackHtml}
      <div class="fade-caveats"><b>How to use.</b> Trend-following works when markets trend and fails when they chop or fall. The light blends SPY's trend, how <i>clean</i> the trend is (efficiency), market breadth, and the risk regime. <b>Green/Yellow</b> = the climate that historically rewarded riding trends; <b>Red</b> = stand down.
      <br><b>Honest caveat.</b> This is a market-timing + trend-capture system, not a stock-alpha engine — the proven edge is the <b>timing light</b> (when to be on vs off), not beating the market on selection. The basket largely captures the uptrend (beta) when it's safe to. Research, not financial advice.</div>`;

    const meta = document.getElementById('trendr-meta');
    if (meta) meta.textContent = `· light ${lbl} · ${basket.length} names in the ride list`;
    const gt = document.getElementById('trendr-gen-time');
    if (gt && t.generatedAt) gt.textContent = new Date(t.generatedAt).toLocaleTimeString();
  }

  document.getElementById('trendr-refresh-btn')?.addEventListener('click', runTrendRider);

  // ── Day Trade (momentum / relative-volume movers, regime-gated, self-learning) ──
  let daytradeLoaded = false, dtListTimer = null;
  const DT_LIST_REFRESH_MS = 15 * 60 * 1000; // re-pull the whole pick list every 15 min (matches the op=daytrade cache TTL)
  function ensureDaytrade() {
    if (!daytradeLoaded) { daytradeLoaded = true; runDaytradeUI(); }
    if (!dtListTimer) dtListTimer = setInterval(() => runDaytradeUI(true), DT_LIST_REFRESH_MS);
  }
  // silent=true (the 15-min auto-refresh) keeps the current cards on screen until the
  // fresh data arrives, so the list quietly updates instead of flashing a spinner.
  async function runDaytradeUI(silent = false) {
    const el = document.getElementById('dt-container');
    if (!el) return;
    if (!silent) el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning movers…</p></div>`;
    try {
      const [t, book, timingBook] = await Promise.all([
        fetch('/api/tracker?op=daytrade').then(r => r.json()),
        fetch('/api/tracker?op=daytradebook').then(r => r.json()).catch(() => null),
        fetch('/api/tracker?op=timingbook').then(r => r.json()).catch(() => null),
      ]);
      renderDaytrade(t, book, timingBook);
    } catch { if (!silent) el.innerHTML = `<div class="mom-status error"><p>Could not load Day Trade.</p></div>`; }
  }
  // 🟢 Timing-light ACCOUNTABILITY scorecard — the grade's own forward track record.
  function timingScorecard(tb) {
    if (!tb || !tb.ok || !tb.byBucket) return '';
    const b = tb.byBucket, resolved = tb.resolved || 0;
    if (resolved < 20) {
      return `<div class="rot-panel rot-panel-pending"><div class="rot-head">🟢 Timing-light accountability — building…</div><div class="rot-sub">${resolved} graded pick${resolved === 1 ? '' : 's'} resolved so far. Once ~20+ mature, this shows whether a greener light actually preceded a better ${tb.horizon || 3}-session entry (and the adaptive tuner re-weights the factors if not). Accrues via the daily cron.</div></div>`;
    }
    const row = (lbl, s, emoji) => !s || !s.n ? '' : `<div class="bt-ic-row"><span>${emoji} ${lbl} <span style="color:var(--text-dim)">${s.n}</span></span><span>fwd exc <b style="color:${s.avgExc >= 0 ? 'var(--green)' : 'var(--red)'}">${s.avgExc >= 0 ? '+' : ''}${s.avgExc}%</b></span><span>${s.beatRate}% beat</span></div>`;
    const icGood = tb.ic != null && tb.ic > 0;
    return `<div class="rot-panel" style="border-color:${icGood ? '#10d98a55' : '#f59e0b55'}">
        <div class="rot-head">🟢 Timing-light accountability <span class="dt-dim">(self-scoring)</span></div>
        <div class="rot-sub">Realized forward <b>${tb.horizon}-session excess vs SPY</b> of every logged pick, split by the light it showed. <b>Grade→outcome IC: ${tb.ic == null ? 'n/a' : (tb.ic >= 0 ? '+' : '') + tb.ic}</b> ${icGood ? '— greener has been marking better entries.' : '— not clearly separating yet; the adaptive tuner will re-weight the factors as more resolve.'}</div>
        ${row('Green (7-10)', b.green, '🟢')}${row('Amber (4-6)', b.amber, '🟡')}${row('Red (1-3)', b.red, '🔴')}
        <div class="bt-ic-row" style="border-top:1px solid var(--border);margin-top:4px"><span></span><span></span><span>${resolved} resolved · ${tb.daysLogged || 0} days</span></div>
      </div>`;
  }

  function renderDaytrade(t, book, timingBook) {
    const el = document.getElementById('dt-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Day Trade unavailable.</p></div>`; return; }
    const REG = { 'risk-on': ['#22c55e', 'RISK-ON', 'Hunt momentum'], neutral: ['#eab308', 'NEUTRAL', 'Be selective'], 'risk-off': ['#ef4444', 'RISK-OFF', 'Stand down — momentum fails here'] };
    const [rc, rlbl, rdesc] = REG[t.regime] || REG.neutral;
    const banner = `<div class="rot-panel" style="border-color:${rc}55"><div class="rot-head" style="color:${rc}">Regime: ${rlbl}</div><div class="rot-sub">${rdesc}. Forward horizon ~${t.horizon} sessions. Picks are logged daily and the engine learns which names' momentum actually continues.</div></div>`;
    // Inline market-tape badge (momentum favors trending tapes, struggles in chop).
    const TAPE = { trending: ['📈', 'Trending tape', 'momentum continuation is favored — the ideal tape for these setups'], choppy: ['🌊', 'Choppy / ranging tape', 'momentum stalls and reverses here — be selective and tighten stops'], mixed: ['🤝', 'Mixed tape', 'no clear edge for momentum — be selective'], riskoff: ['🛑', 'Risk-off tape', 'momentum fails — stand down on new longs'] };
    const [ti, tlbl, tdesc] = TAPE[t.condition] || TAPE.mixed;
    const fav = t.condition === 'trending', bad = t.condition === 'choppy' || t.condition === 'riskoff';
    const tapeBadge = `<div class="dt-note" style="border-left-color:${fav ? 'var(--green)' : bad ? 'var(--amber,#f59e0b)' : 'var(--border-hi)'}"><b>${ti} ${tlbl}.</b> ${tdesc} ${t.condition && t.condition !== 'mixed' ? `<span class="dt-dim">(momentum is a trend-following style — it ${fav ? '✓ suits' : '⚠ does not suit'} today's tape.)</span>` : ''}</div>`;

    // ⏳ Intraday volume-pacing banner — mid-session the daily bar is only partly printed,
    // so relVol is PROJECTED to a full day (raw partial volume ÷ fraction of session
    // elapsed). This is why movers show up now instead of only after the close.
    const pacedBanner = t.paced ? `<div class="dt-note" style="border-left-color:#38bdf8"><b>⏳ Live mid-session — ${Math.round((t.paceFraction || 0) * 100)}% of the day elapsed.</b> Relative volume is <b>projected to a full day</b> so today's movers surface now rather than after the close. Early RVOL is <b>provisional</b> and firms up as volume prints (marked <span class="dt-dim">proj.</span>).</div>` : '';
    const rvMark = t.paced ? ' <span class="dt-dim" title="Relative volume projected to a full day — provisional mid-session">proj.</span>' : '';

    // Experimental config banner — the evidence-based ORB-stacked upgrade, framed honestly
    // (it tested OOS-positive but FAILED formal deflation, so it's a paper-track lead).
    const cfg = t.config;
    const configBanner = cfg ? `<div class="rot-panel" style="border-color:#a855f755;background:#a855f70d">
        <div class="rot-head" style="color:#c084fc">🧪 ${esc(cfg.name)} — experimental upgrade</div>
        <div class="rot-sub"><b>What changed vs. the old "buy at close" plan:</b>
          <ul style="margin:6px 0 6px 18px;padding:0">${cfg.rules.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
          <b style="color:#f59e0b">⚠️ Unproven — paper-track first.</b> ${esc(cfg.caveat)}</div>
      </div>` : '';

    // Beginner-friendly "how to use" caption.
    const howto = `<div class="tr-howto">
      <div class="tr-howto-head">📖 How to use this — in plain English</div>
      <ol>
        <li><b>What this is.</b> A list of stocks making a <b>big move TODAY on unusually heavy volume</b> — the day's "movers."</li>
        <li><b>Check the regime first.</b> <b style="color:#22c55e">Risk-On</b>/<b style="color:#eab308">Neutral</b> = these setups are worth watching. <b style="color:#ef4444">Risk-Off</b> = the list is hidden — stand down (momentum fails in scary markets).</li>
        <li><b>Pick your entry.</b> 📈 <b>Opening-range breakout</b> (the tested config) = next session, wait ~30 min, buy <b>only if it breaks the opening-range high</b> — don't chase the open · ↩️ <b>Pullback</b> = instead wait to buy lower on a dip. Each shows 🛑 <b>Stop</b> (2.5×ATR — sell here if wrong) and 🏁 <b>Target</b> (1:2, take profit).</li>
        <li><b>Size by risk, not by gut.</b> Shares ≈ (1% of your account) ÷ (Entry − Stop). Example: $10k account, risk $100, Entry $10 / Stop $9 → ~100 shares.</li>
        <li><b>Always confirm on a chart</b> (TradingView: MACD / RSI) before buying. This is a <b>watchlist, not advice</b>.</li>
      </ol>
    </div>`;

    const pb = r => r.pullback || null;
    const orb = r => r.orb || null;
    const relBadge = r => r.relScore == null ? '' : `<span class="dt-relscore" title="Relative strength vs today's other picks (0–100)">${r.relScore}</span>`;
    const tierBadge = r => r.tier === 'B' ? ' <span class="dt-tier-b" title="Building tier — relaxed threshold that surfaces more movers on quiet tapes (display-only; the strict A-tier ledger is tracked separately)">B</span>' : '';
    // 🔮 pcarry — honest, calibrated carry ODDS (%). Colored by level; flags fade risk.
    const carryBadge = r => {
      if (r.carry == null) return '';
      const c = r.carry, col = c >= 55 ? 'var(--green)' : c >= 48 ? 'var(--amber,#f59e0b)' : 'var(--red)';
      const flags = [r.overextended ? '⚠ overextended' : '', r.catalyst === 'FADE_OFFERING' ? '⚠ offering/dilution' : r.catalyst === 'MA' ? '⚠ buyout' : ''].filter(Boolean).join(' · ');
      return `<span class="dt-carry" style="color:${col};border-color:${col}55" title="Honest continuation odds over ~3 sessions (price overextension + news catalyst + regime + scan base-rate). Tradeable continuation is ~coin-flip — this mainly flags FADE risk, it does NOT predict winners.${flags ? ' ' + flags : ''}">🔮 ${c}%${r.overextended ? ' ⚠' : ''}</span>`;
    };
    const rankChip = i => `<span class="dt-rank${i === 0 ? ' dt-rank-top' : ''}" title="Rank in this list — #1 is the strongest setup by the momentum-anomaly + learned tilt; recommendations weaken toward the bottom">#${i + 1}</span>`;
    const card = (r, i) => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span>${rankChip(i)} ${carryBadge(r)} ${relBadge(r)} <b>${esc(r.ticker)}</b>${r.preferred ? ' <span class="dt-star" title="Top-half by rank — the experimental config\'s preferred selection">⭐</span>' : ''}${tierBadge(r)} <span class="dt-sec">${esc(r.sector || '')}</span></span>
          <span class="dt-now"><b data-dt-price>$${r.last}</b> <span data-dt-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><span data-dt-daychg>${r.pctChange >= 0 ? '+' : ''}${r.pctChange}%</span> today <span class="dt-dim">· ${L('rvol', 'RVOL')} ${r.relVol}×${rvMark}${r.beta != null ? ' · ' + L('beta', 'β') + ' ' + r.beta : ''}${r.gapPct != null ? ' · gap ' + r.gapPct + '%' : ''}</span></div>
        ${orb(r) ? `<div class="dt-card-plan">📈 <b>Opening-range breakout</b> <span class="dt-dim">(next session)</span> — break above <b>$${orb(r).trigger}</b> &nbsp;·&nbsp; 🛑 ${L('stop', 'Stop')} <b>$${orb(r).stop}</b> <span class="dt-dim">(−${orb(r).riskPct}%, 2.5×ATR)</span> &nbsp;·&nbsp; 🏁 ${L('target', 'Target')} <b>$${orb(r).target}</b> <span class="dt-dim">${L('rr', 'R:R')} 1:${orb(r).rr}</span></div>` : ''}
        ${pb(r) ? `<div class="dt-card-plan">↩️ <b>${L('pullback', 'Pullback entry')}</b> <span class="dt-dim">(alt: wait for a dip)</span> <b>$${pb(r).entry}</b> &nbsp;·&nbsp; 🛑 ${L('stop', 'Stop')} <b>$${pb(r).stop}</b> <span class="dt-dim">(−${pb(r).riskPct}%)</span> &nbsp;·&nbsp; 🏁 ${L('target', 'Target')} <b>$${pb(r).target}</b> <span class="dt-dim">${L('rr', 'R:R')} 1:${pb(r).rr}</span></div>` : ''}
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const list = (title, rows, sub, extra) => {
      if (t.riskOff) return `<div class="rot-panel"><div class="rot-head">${title}</div><div class="rot-sub">🛑 Risk-off — suppressed (these setups underperform in risk-off; validated).</div></div>`;
      const body = (rows || []).map(card).join('');
      return `<div class="rot-panel"><div class="rot-head">${title}</div><div class="rot-sub">${sub}</div>${extra || ''}${body || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No movers right now.</span></div>'}</div>`;
    };
    const ml = list('🚀 Momentum &amp; Liquid ($5–$50)', t.momentumLiquid, 'Liquid names up &gt;5% on &gt;1.5× relative volume, ranked by the volume anomaly + learned tilt. <b>⭐ = top-half by rank</b> — the experimental config\'s preferred picks.');
    const betaNote = `<div class="dt-note"><b>β ≈ 2 — beta-neutral check:</b> these small caps swing ~2× the market. In 5y tests the edge is <b>real stock-picking alpha</b> (it barely changes when market beta is removed: +1.7% → +1.5%), but it's a <b>low-hit-rate, big-winner</b> profile (~48–49% win rate) — so <b>size small</b>. Advanced traders isolate the alpha by hedging ~2× the position in short SPY.</div>`;
    const esExclNote = `<div class="dt-note" style="border-left-color:var(--amber,#f59e0b)"><b>⚠️ Excluded from the experimental config.</b> In the intraday study this scan tested <b>negative out-of-sample</b>, so it's <b>not</b> part of the ORB-stacked plan above — shown for awareness only. Size very small if traded at all.</div>`;
    const es = list('💥 Explosive Small-Cap ($1–$20)', t.explosiveSmall, 'Small caps up &gt;8% on &gt;2× relative volume — higher reward, lower hit-rate.', esExclNote + betaNote);
    const expNote = `<div class="dt-note"><b>🌐 Broader net — not forward-tracked.</b> The <b>same</b> momentum &amp; liquid gate, run over the free <b>full-market universe</b> (liquid names beyond the maintained S&amp;P / small / micro lists). Kept <b>out of the validated track record</b> above so those stats stay clean — treat this as a wider watchlist to confirm, not a measured edge.</div>`;
    const expList = list('🌐 Expanded Universe ($5–$50)', t.momentumExpanded, 'Momentum &amp; liquid movers from the full liquid universe — names the cap-band scans don\'t cover.', expNote);

    // 🌊 Multi-day Momentum Run (FCEL archetype) — sustained movers, shown in ALL
    // regimes (identification, not a trade signal). Different fields than the single-
    // day cards: 5-day move, # unusual-volume days, proximity to the run high.
    const runCard = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span>${carryBadge(r)} ${r.relScore != null ? `<span class="dt-relscore" title="Relative strength (0–100)">${r.relScore}</span> ` : ''}<b>${esc(r.ticker)}</b>${tierBadge(r)} <span class="dt-sec">${esc(r.sector || '')}</span></span>
          <span class="dt-now"><b data-dt-price>$${r.last}</b> <span data-dt-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><b style="color:var(--green)">+${r.pct5d}% / 5d</b> <span class="dt-dim">· ${r.highVolDays5} high-vol days · ${Math.round((r.nearHighFrac5 || 0) * 100)}% of run-high · today <span data-dt-daychg>${r.pctChange >= 0 ? '+' : ''}${r.pctChange}%</span> · RVOL ${r.relVol}×${rvMark}</span></div>
        ${r.stop ? `<div class="dt-card-plan">🛑 ${L('stop', 'Stop')} <b>$${r.stop}</b> <span class="dt-dim">(2.5×ATR)</span> &nbsp;·&nbsp; 🏁 ${L('target', 'Target')} <b>$${r.target}</b>${r.rr != null ? ` <span class="dt-dim">${L('rr', 'R:R')} 1:${r.rr}</span>` : ''}</div>` : ''}
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const runRows = (t.momentumRun || []);
    const runBody = runRows.map(runCard).join('');
    const runSection = `<div class="rot-panel" style="border-color:#06b6d455">
        <div class="rot-head" style="color:#22d3ee">🌊 Momentum Run — multi-day movers ${runRows.length ? `<span class="dt-dim">(${runRows.length})</span>` : ''}</div>
        <div class="rot-sub">Names in a <b>sustained run</b> — strict (<b>A</b>): up <b>≥20% over 5 sessions</b>, <b>≥2 unusual-volume days</b>, within 8% of the run high. On quiet tapes a relaxed <b>building (B)</b> tier also surfaces earlier or slightly-pulled-back runs (≥15% / ≥1 vol day / within 12% of the high) — display-only, marked with a <b>B</b> chip. This is the <b>FCEL-style archetype</b>: a move that builds over days rather than a single spike, so it surfaces even on continuation days a single-day relative-volume gate misses. Shown in every regime (it's a <b>watchlist of names already moving</b>, not a trade signal).</div>
        ${runBody || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No multi-day runs right now.</span></div>'}
        <div class="dt-note" style="border-left-color:#06b6d4"><b>Honest framing.</b> This is <b>reactive momentum-continuation</b> — it catches a move <b>already underway</b> (recall), not a prediction of which name will start moving. This project's backtests show chasing momentum is <b>not</b> a forward edge, so expect false continuations and chop; use it to <b>spot and confirm</b> runs, then manage risk with the stop. The <b>bottom</b> of an FCEL-type move (the falling-knife low) is <b>not</b> predictable on this data — only the run, once it's confirmed, is catchable.</div>
      </div>`;

    let track;
    if (book && book.resolved >= 10) {
      const row = (n, s) => s && s.n ? `<div class="bt-ic-row"><span>${n} <span style="color:var(--text-dim)">${s.n}</span></span><span>exc ${s.avgExc > 0 ? '+' : ''}${s.avgExc}%</span><span>${L('beatRate', 'beat')} ${s.beatRate}% <span style="color:var(--text-dim)">(${L('wilsonLB', 'LB')} ${s.wilsonLo}%)</span></span></div>` : '';
      track = `<div class="rot-panel"><div class="rot-head">📊 Live track record — forward ${t.horizon}-session excess vs SPY</div>${row('🚀 Momentum-Liquid', book.byScan.momentum_liquid)}${row('💥 Explosive-Small', book.byScan.explosive_small)}${row('All picks', book.overall)}<div class="bt-ic-row" style="border-top:1px solid var(--border);margin-top:4px"><span></span><span></span><span>${book.resolved} resolved · ${book.stillOpen} open</span></div></div>`;
    } else {
      track = `<div class="rot-panel rot-panel-pending"><div class="rot-head">📊 Live track record — building…</div><div class="rot-sub">${book ? `${book.stillOpen || 0} open, ${book.resolved || 0} resolved` : ''}. Each pick is scored ~${t.horizon} sessions later; accrues automatically via the daily cron.</div></div>`;
    }
    // ⭐ Today's Best Opportunities — ranked, from the validated positive-edge scans only.
    const best = (t.bestOpportunities || []);
    const bestCard = o => `<div class="dt-best-card">
        <div class="dt-best-top"><span class="dt-best-rank">#${o.rank}</span> ${carryBadge(o)} <b>${esc(o.ticker)}</b> <span class="dt-relscore" title="Relative strength (0–100)">${o.relScore}</span> <span class="dt-sec">${esc(o.source)}${o.tier === 'B' ? ' · B' : ''}</span></div>
        <div class="dt-card-sub">${o.pctChange >= 0 ? '+' : ''}${o.pctChange}% today · RVOL ${o.relVol}×${rvMark} · <span class="dt-dim">${esc(o.why)}</span></div>
        ${o.orb ? `<div class="dt-card-plan">📈 <b>ORB</b> break &gt;<b>$${o.orb.trigger}</b> · 🛑 <b>$${o.orb.stop}</b> · 🏁 <b>$${o.orb.target}</b> <span class="dt-dim">1:${o.orb.rr}</span></div>` : (o.stop ? `<div class="dt-card-plan">🛑 <b>$${o.stop}</b> · 🏁 <b>$${o.target}</b>${o.rr != null ? ` <span class="dt-dim">1:${o.rr}</span>` : ''}</div>` : '')}
      </div>`;
    const bestSubtitle = `Now a <b>fade-avoidance quality gate</b>, not a ranked dump of the whole pool. <b>Why the change</b>: the app's own forward tracker showed the raw momentum/explosive picks <b>losing ~4% excess vs SPY</b> over 3 sessions (worst on overextended/froth names), and the survivorship-corrected research (research/33, 26k candidate-days) found the <b>only</b> durable tradeable signal is <b>fade avoidance</b>. So this list now admits <b>only</b> names the model does <b>not</b> flag: carry above the ~49% beat-SPY base rate, <b>not</b> an overextended blow-off, and no dilution/M&amp;A fade pop. Fewer, cleaner names on purpose — on a day with no clean setups it's <b>empty</b> (that's the honest answer, not a bug). Still not a winner-predictor: tradeable 3-session continuation is ~a coin-flip (the predictable part is the un-tradeable overnight leg); this just avoids the traps.`;
    const bestEmpty = `<div class="rot-panel" style="border-color:#f59e0b44;background:#f59e0b0a">
        <div class="rot-head" style="color:#f59e0b">⭐ Today's Best Opportunities <span class="dt-dim">(0)</span></div>
        <div class="rot-sub"><b>No clean setups passed the fade-avoidance gate today.</b> Every mover on the tape is either overextended, below the ~49% carry base-rate, or carrying a dilution/M&amp;A pop — the exact population that fades. Showing nothing is the honest call; the full movers watchlist is still below.</div>
      </div>`;
    const bestSection = t.riskOff ? '' : (!best.length ? bestEmpty : `<div class="rot-panel" style="border-color:#f59e0b66;background:#f59e0b0d">
        <div class="rot-head" style="color:#f59e0b">⭐ Today's Best Opportunities <span class="dt-dim">(${best.length})</span></div>
        <div class="rot-sub">${bestSubtitle}</div>
        <div class="dt-best-grid">${best.map(bestCard).join('')}</div>
      </div>`);
    el.innerHTML = banner + tapeBadge + pacedBanner + bestSection + configBanner + howto + ml + es + runSection + expList + track + timingScorecard(timingBook) +
      `<div class="fade-caveats"><b>How to use.</b> Today's relative-volume + momentum movers (the EOD version of the Finviz day-trade scans), regime-gated and self-learning. <b>Honest validation</b> (5y, forward 3-session excess vs SPY): large-cap momentum-chasing does <b>not</b> beat the market (it mean-reverts, −1.3% out-of-sample); explosive small-caps carry a <b>positive average excess</b> (~+1.7–2.3% in risk-on/neutral) but a <b>sub-50% hit-rate</b> — a few big runners carry it, and it dies in risk-off. So treat these as a <b>ranked movers watchlist</b>, not a win-rate edge; the per-stock learner tilts toward names whose momentum actually continues and drops the rest. <b>The 🧪 experimental config above</b> (opening-range-breakout entry + 2.5×ATR stop + top-half selection) is the one variant that tested out-of-sample positive on <b>real intraday execution</b> — but it <b>failed formal deflation</b> (deflated Sharpe 0.59), so it's a paper-trading lead to confirm forward, not a proven edge. Confirm entries in TradingView (MACD / RSI / Smart-Money). Research, not advice.</div>`;
    // Wire each card's chart toggle (reuses the shared /api/chart canvas renderer)
    // and start live-price polling for the recommended names.
    const dtTickers = [];
    el.querySelectorAll('.dt-card[data-ticker]').forEach(cardEl => {
      const tk = cardEl.dataset.ticker; dtTickers.push(tk);
      const btn = cardEl.querySelector('[data-chart-toggle]');
      if (btn) btn.addEventListener('click', () => toggleChart(cardEl, tk));
    });
    startDaytradePrices([...new Set(dtTickers)]);
    // ⏱️ Entry-timing lights — use each pick's ORB plan levels + avg volume when present.
    const seen = new Set();
    const dtPicks = [...(t.bestOpportunities || []), ...(t.momentumLiquid || []), ...(t.explosiveSmall || []), ...(t.momentumRun || []), ...(t.momentumExpanded || [])]
      .filter(p => p && p.ticker && !seen.has(p.ticker) && seen.add(p.ticker))
      .map(p => ({ ticker: p.ticker, stop: p.orb && p.orb.stop, target: p.orb && p.orb.target, trigger: p.orb && p.orb.trigger, avgVol: p.avgVol }));
    attachTimingLights(el, dtPicks, 'daytrade');

    const meta = document.getElementById('dt-meta');
    if (meta) meta.textContent = `· ${t.regime} · ${(t.counts ? t.counts.momentumLiquid + t.counts.explosiveSmall + (t.counts.momentumRun || 0) : 0)} movers`;
    const gt = document.getElementById('dt-gen-time');
    if (gt && t.generatedAt) gt.textContent = new Date(t.generatedAt).toLocaleTimeString();
  }

  // Live current-price polling for Day Trade cards (pre/after-hours aware).
  // Prices tick every ~30s so the quotes stay live; the pick LIST is re-pulled on a
  // separate 15-min cadence (dtListTimer). Fires once immediately on open.
  const DT_PRICE_REFRESH_MS = 30 * 1000;
  let dtPriceTimer = null;
  function startDaytradePrices(tickers) {
    if (dtPriceTimer) { clearInterval(dtPriceTimer); dtPriceTimer = null; }
    if (!tickers.length) return;
    const upd = () => updateDaytradePrices(tickers);
    upd();                                                  // current the moment the tab opens
    dtPriceTimer = setInterval(upd, DT_PRICE_REFRESH_MS);
  }
  // "🟢 Live prices · updated HH:MM:SS · list refreshes every 15 min" line at the top of the list.
  function setDtPriceAsOf() {
    const cont = document.getElementById('dt-container');
    if (!cont) return;
    let el = cont.querySelector('.dt-price-asof');
    if (!el) { el = document.createElement('div'); el.className = 'dt-price-asof'; cont.insertBefore(el, cont.firstChild); }
    const t = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.innerHTML = `<span class="live-dot"></span>Live prices · updated ${t} · list refreshes every 15 min`;
  }
  async function updateDaytradePrices(tickers) {
    try {
      // /api/price caps at 12 tickers/call — chunk so EVERY card gets a live quote,
      // not just the first 12 (Day Trade routinely lists more than that).
      const data = {};
      for (let i = 0; i < tickers.length; i += 12) {
        const chunk = tickers.slice(i, i + 12);
        try {
          const res = await fetch('/api/price?tickers=' + encodeURIComponent(chunk.join(',')));
          if (!res.ok) continue;
          const d = await res.json();
          if (d && !d.error) Object.assign(data, d);
        } catch { /* skip this chunk, keep the rest */ }
      }
      if (!Object.keys(data).length) return;
      let updated = 0;
      document.querySelectorAll('#daytrade .dt-card[data-ticker]').forEach(cardEl => {
        const q = data[cardEl.dataset.ticker]; if (!q) return;
        const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
        const priceEl = cardEl.querySelector('[data-dt-price]');
        const changeEl = cardEl.querySelector('[data-dt-change]');
        if (priceEl && shown != null && priceEl.textContent !== '$' + shown) {
          priceEl.textContent = '$' + shown;
          priceEl.classList.remove('price-flash'); void priceEl.offsetWidth; priceEl.classList.add('price-flash');
        }
        if (changeEl) {
          const pct = q.afterHours ? q.afterHours.changePct : q.changePct;
          const up = parseFloat(pct) >= 0;
          const tag = q.afterHours ? (q.afterHours.session === 'pre' ? 'PRE ' : 'AH ') : '';
          changeEl.textContent = `${tag}${up ? '▲ +' : '▼ '}${pct}%`;
          changeEl.style.color = up ? 'var(--green)' : 'var(--red)';
        }
        // Keep the headline "% today" consistent with the live regular-session change
        // (the card ships with the EOD scan value, which can be a full day stale).
        const dayEl = cardEl.querySelector('[data-dt-daychg]');
        if (dayEl && q.changePct != null && !Number.isNaN(parseFloat(q.changePct))) {
          const up = parseFloat(q.changePct) >= 0;
          dayEl.textContent = (up ? '+' : '') + q.changePct + '%';
          dayEl.style.color = up ? 'var(--green)' : 'var(--red)';
        }
        updated++;
      });
      if (updated) setDtPriceAsOf();
    } catch { /* keep last good prices */ }
  }
  document.getElementById('dt-refresh-btn')?.addEventListener('click', () => runDaytradeUI(false));

  // ── ⏱️ Entry-Timing Light (shared) ─────────────────────────────────────────
  // A 1-10 gauge of HOW GOOD A MOMENT it is to buy a pick RIGHT NOW (🟢10 optimal →
  // 🔴1 worst), from live price level, VWAP extension, position-in-range, intraday
  // relative volume, and the pick's own R:R + breakout trigger. Server-scored
  // (lib/timing.js, SSOT) so there's no client/server sync hazard. Refreshes every
  // 20 min and whenever the tab re-renders (which re-invokes this).
  const TIMING_COL = { green: '#22c55e', amber: '#eab308', red: '#ef4444', grey: '#64748b' };
  const timingTimers = {};
  function renderTimingBadge(card, t) {
    let slot = card.querySelector('[data-timing]');
    if (!slot) {
      slot = document.createElement('span'); slot.setAttribute('data-timing', ''); slot.style.marginLeft = '6px';
      // Host the badge near the ticker on whichever card type this is.
      const host = card.querySelector('.dt-card-top span') || card.querySelector('.cx-tk-row') || card.querySelector('.scr-tk-row') || card;
      host.appendChild(slot);
    }
    if (!t || t.score == null) {
      const lbl = t && t.label ? t.label : '—';
      slot.innerHTML = `<span class="timing-light" style="border:1px solid ${TIMING_COL.grey};color:${TIMING_COL.grey}" title="${esc((t && t.reasons || []).join(' · '))}">${(t && t.emoji) || '⚪'} timing —</span>`;
      return;
    }
    const col = TIMING_COL[t.light] || TIMING_COL.grey;
    const tip = `Entry timing ${t.score}/10 — ${t.label}\n` + (t.reasons || []).join('\n');
    slot.innerHTML = `<span class="timing-light" style="border:1px solid ${col};color:${col};background:${col}1a" title="${esc(tip)}">${t.emoji} ${t.score}/10</span>`;
  }
  // picks = [{ticker, stop?, target?, trigger?, avgVol?}]; `key` scopes the 20-min timer.
  // `findCard(ticker)` optionally locates the card element (default: a .dt-card[data-ticker]).
  async function attachTimingLights(containerEl, picks, key, findCard) {
    if (!containerEl || !picks || !picks.length) return;
    const locate = findCard || (tk => containerEl.querySelector(`[data-ticker="${tk}"]`));
    if (timingTimers[key]) { clearInterval(timingTimers[key]); timingTimers[key] = null; }
    // One-time legend so the badge is self-explanatory on any tab that uses it.
    if (!containerEl.querySelector('.timing-legend')) {
      const lg = document.createElement('div');
      lg.className = 'dt-note timing-legend';
      lg.innerHTML = `<b>⏱️ Entry-timing light</b> — how good a <i>moment</i> it is to buy each pick <b>right now</b> (updates every 20 min &amp; on refresh): <span style="color:${TIMING_COL.green}">🟢 7–10 good</span> · <span style="color:${TIMING_COL.amber}">🟡 4–6 fair</span> · <span style="color:${TIMING_COL.red}">🔴 1–3 poor/avoid</span>. Graded from live R:R to target, VWAP extension, position in the day's range, and intraday volume. Hover a badge for the reasons. <b>Timing, not a prediction.</b>`;
      containerEl.insertBefore(lg, containerEl.firstChild);
    }
    const run = async () => {
      try {
        const res = await fetch('/api/tracker?op=timing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ picks }),
        });
        const j = await res.json();
        if (!j || !j.ok) return;
        picks.forEach(p => {
          const card = locate(p.ticker);
          if (card) renderTimingBadge(card, j.timing[p.ticker.toUpperCase()]);
        });
      } catch { /* keep last good lights */ }
    };
    run();
    timingTimers[key] = setInterval(run, 20 * 60 * 1000); // 20 min — per spec
  }

  // ── 🚀 Gap & Go (unscheduled catalyst gap-up continuation — validated event edge) ──
  // Today's ≥3% gap-ups on liquid names, with EARNINGS gaps filtered out (they don't
  // continue). The first deflation-surviving event edge; ORB entry plan attached.
  let gapgoLoaded = false;
  function ensureGapGo() { if (!gapgoLoaded) { gapgoLoaded = true; runGapGoUI(); } }
  let downdayLoaded = false;
  function ensureDownDay() { if (!downdayLoaded) { downdayLoaded = true; runDownDayUI(); } }
  let gapdownLoaded = false;
  function ensureGapDown() { if (!gapdownLoaded) { gapdownLoaded = true; runGapDownUI(); } }
  let ggSkipFade = false; try { ggSkipFade = localStorage.getItem('ggSkipFade') === '1'; } catch {}
  // Gap-cause badge (research/27 pilot): offering/M&A FADE (red), FDA/guidance/contract
  // CONTINUE (green), else neutral. No badge for newsless gaps (the common case).
  const GG_CAUSE = {
    FADE_OFFERING: ['🩳 Offering', 'fade'], MA: ['🤝 Buyout', 'fade'],
    FDA: ['🧪 FDA', 'cont'], CONTRACT: ['📝 Contract', 'cont'], GUIDE: ['📈 Guidance', 'cont'],
    OTHER: ['📰 News', 'dim'],
  };
  function ggCauseBadge(cause) {
    const c = GG_CAUSE[cause]; if (!c) return '';
    const color = c[1] === 'fade' ? '#ef4444' : c[1] === 'cont' ? '#22c55e' : 'var(--text-dim)';
    return ` <span class="gg-cause" style="color:${color};border:1px solid ${color}44;border-radius:4px;padding:1px 5px;font-size:0.6rem;font-weight:800">${c[0]}</span>`;
  }
  // ── 🎯 Dual Confirmed — buy on BOTH horizons (trend-continuation) ────────────
  let alignedLoaded = false;
  function ensureAligned() { if (!alignedLoaded) { alignedLoaded = true; runAlignedUI(); } }
  async function runAlignedUI() {
    const el = document.getElementById('aligned-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning for names that are a buy on both horizons…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch('/api/tracker?op=aligned').then(r => r.json()),
        fetch('/api/tracker?op=alignedbook').then(r => r.json()).catch(() => null),
      ]);
      renderAligned(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Dual Confirmed.</p></div>`; }
  }
  function alignedBookPanel(book) {
    if (!book || !book.ok) return '';
    const row = (lbl, s) => !s || !s.n ? '' : `<div class="bt-ic-row"><span>${lbl}</span><span><b>${s.avgExc >= 0 ? '+' : ''}${s.avgExc}%</b> avg excess · ${s.beatRate}% beat (Wilson ${s.wilsonLo}%) · n=${s.n}</span></div>`;
    const rows = row('Overall', book.overall) + row('STRONG (conv ≥80)', book.byTier && book.byTier.STRONG) + row('GOOD (conv 60–79)', book.byTier && book.byTier.GOOD);
    return `<div class="rot-panel" style="margin-top:14px"><div class="rot-head">📋 Live forward track record <span class="dt-dim">(self-validation)</span></div>
      <div class="rot-sub">${esc(book.note || '')}</div>
      ${rows || `<div class="bt-ic-row"><span style="color:var(--text-dim)">${book.resolved || 0} resolved · ${book.open || 0} open — accrues as picks mature (~${book.horizon} sessions after each is logged).</span></div>`}</div>`;
  }
  function renderAligned(t, book) {
    const el = document.getElementById('aligned-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Dual Confirmed unavailable.</p></div>`; return; }
    const gt = document.getElementById('aligned-gen-time');
    if (gt) gt.textContent = t.generatedAt ? new Date(t.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const picks = t.picks || [];
    if (!picks.length) {
      el.innerHTML = `<div class="dt-note">No names are aligned on both horizons right now — that's normal in a mixed or choppy tape, where short-term and long-term signals disagree. This list fills when strong long-term trends also flash a fresh short-term buy. <span class="dt-dim">(${t.scanned || 0} scanned)</span></div>` + alignedBookPanel(book);
      return;
    }
    const convClass = c => c >= 80 ? 'hi' : c >= 60 ? 'mid' : 'lo';
    const priceHtml = p => {
      const shown = p.regularPrice ?? p.price;
      if (shown == null) return '';
      const hasPct = p.changePct != null && !Number.isNaN(parseFloat(p.changePct));
      const up = hasPct ? parseFloat(p.changePct) >= 0 : true;
      const chg = hasPct ? `<span class="al-chg ${up ? 'up' : 'down'}">${up ? '▲ +' : '▼ '}${p.changePct}% today</span>` : '';
      let ah = '';
      if (p.afterHours) {
        const ahUp = parseFloat(p.afterHours.changePct) >= 0;
        const tag = p.afterHours.session === 'pre' ? 'PRE' : 'AH';
        ah = `<span class="al-ah ${ahUp ? 'up' : 'down'}">${tag} $${p.afterHours.price} ${ahUp ? '+' : ''}${p.afterHours.changePct}%</span>`;
      }
      return `<div class="al-price"><span class="al-px">$${shown}</span>${chg}${ah}</div>`;
    };
    const lvHtml = lv => (lv && (lv.entry || lv.stop || lv.target)) ? `
      <div class="al-levels">
        ${lv.entry != null ? `<span><i>Entry</i>$${lv.entry}</span>` : ''}
        ${lv.stop != null ? `<span><i>Stop</i>$${lv.stop}</span>` : ''}
        ${(lv.target ?? lv.resistance) != null ? `<span><i>Target</i>$${lv.target ?? lv.resistance}</span>` : ''}
      </div>` : '';
    const card = p => `
      <div class="dt-card al-card" data-ticker="${esc(p.ticker)}">
        <div class="al-top">
          <span class="al-tk">${esc(p.ticker)}</span>
          <span class="al-co">${esc(p.company || '')}</span>
          <span class="al-conv ${convClass(p.conviction)}" title="Conviction — 50% long-term trend strength + 50% short-term signal">${p.conviction}</span>
          <button class="dt-chart-btn" data-chart-toggle title="Show live chart &amp; dual read">📈</button>
        </div>
        ${priceHtml(p)}
        <div class="al-horizons">
          <span class="al-h up">⏱ Short-term <b>Bullish</b> · ${esc(p.stAction.replace('_', ' '))} ${p.stConf}/10</span>
          <span class="al-h up">📈 Long-term <b>Bullish</b> · score +${p.ltScore}${p.group ? ` · ${esc(p.group)}` : ''}</span>
        </div>
        <div class="al-reasons">${[...(p.stReasons || []), ...(p.ltReasons || [])].slice(0, 3).map(esc).join(' · ')}</div>
        ${lvHtml(p.levels)}
        <div class="dt-chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const scanNote = t.stage === 'full-market' ? `<div class="dt-dim" style="font-size:0.68rem;margin-bottom:8px">Full-market scan · ${t.scanned || 0} names → ${t.longTermBullish || 0} long-term bullish → ${t.qualified || 0} confirmed on both horizons</div>` : '';
    el.innerHTML = scanNote + `<div class="al-grid">${picks.map(card).join('')}</div>` + alignedBookPanel(book);
    el.querySelectorAll('.dt-card[data-ticker]').forEach(cardEl => {
      const tk = cardEl.dataset.ticker;
      const btn = cardEl.querySelector('[data-chart-toggle]');
      if (btn) btn.addEventListener('click', () => toggleChart(cardEl, tk));
    });
    attachTimingLights(el, picks.map(p => ({ ticker: p.ticker, stop: p.levels && p.levels.stop, target: p.levels && (p.levels.target ?? p.levels.resistance), trigger: p.levels && p.levels.entry })), 'aligned');
  }
  document.getElementById('aligned-refresh-btn')?.addEventListener('click', runAlignedUI);

  // ── 💰 Options Moves — put-selling setups ───────────────────────────────────
  let putsellLoaded = false;
  function ensurePutSell() { if (!putsellLoaded) { putsellLoaded = true; runPutSellUI(); } }
  async function runPutSellUI() {
    const el = document.getElementById('putsell-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning for put-selling setups…</p></div>`;
    try {
      const t = await fetch('/api/tracker?op=putsell').then(r => r.json());
      renderPutSell(t);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Options Moves.</p></div>`; }
  }
  const PS_TIER = { PRIME: ['🟢 Prime', 'hi'], SOLID: ['🔵 Solid', 'mid'], WATCH: ['⚪ Watch', 'lo'] };
  const PS_IV = { high: 'iv-hi', moderate: 'iv-mid', low: 'iv-lo' };
  function renderPutSell(t, elId = 'putsell-container') {
    const el = document.getElementById(elId);
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Options Moves unavailable.</p></div>`; return; }
    const gt = document.getElementById('putsell-gen-time');
    if (gt) gt.textContent = t.generatedAt ? new Date(t.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    // Strategy module heading — one of (eventually several) options moves under this section.
    const stratHead = `<div class="scr-subhead">🅿️ Cash-Secured Put Selling <span class="sub-meta">quality uptrend · pullback to support · a REAL listed put (25–45 DTE) below support · full economics</span></div>`;
    const picks = t.picks || [];
    if (!picks.length) {
      el.innerHTML = stratHead + `<div class="dt-note">No cash-secured puts with a real, liquid listed contract right now — that's normal when strong stocks are extended (thin premium), the tape is weak, or the only fits cross earnings (excluded by default). <span class="dt-dim">(${t.scanned || 0} scanned · ${t.qualified || 0} setups${t.noContract && t.noContract.length ? ` · ${t.noContract.length} with no tradeable contract` : ''})</span></div>`;
      return;
    }
    const gradeClass = g => g === 'A+' || g === 'A' ? 'g-a' : g === 'B' ? 'g-b' : g === 'C' ? 'g-c' : 'g-d';
    const money = n => n == null ? '' : n >= 1000 ? '$' + Math.round(n).toLocaleString() : '$' + n.toFixed(2);
    const card = p => {
      const tier = PS_TIER[p.tier] || PS_TIER.WATCH;
      const rp = p.realPut, ec = (rp && rp.economics) || {}, mg = (rp && rp.management) || {};
      const ivChip = rp && rp.atmIV != null ? `<span class="ps-iv ${PS_IV[p.ivLevel] || ''}">IV ${(rp.atmIV * 100).toFixed(0)}%</span>` : '';
      const earn = p.earningsInDays != null ? `<span class="ps-earn">📅 Earnings ${p.earningsInDays}d</span>` : '';
      const liq = rp ? `<span class="ps-meta" title="Real listed-contract liquidity">OI ${rp.openInterest ?? '–'} · spread ${rp.spreadPct != null ? rp.spreadPct + '%' : '–'}</span>` : '';
      const pd = rp && rp.proxyDelta && rp.proxyDelta.value != null
        ? `<span class="ps-meta" title="Moneyness+IV proxy — free chains carry no real greeks">~${(rp.proxyDelta.value * 100).toFixed(0)}Δ proxy</span>` : '';
      const cautions = (p.cautions || []).length ? `<div class="ps-caution">${p.cautions.map(c => `⚠ ${esc(c)}`).join('<br>')}</div>` : '';
      const manage = mg.profitTake ? `<details class="ps-manage" style="margin-top:6px"><summary style="cursor:pointer;font-size:0.78rem">📋 Management plan</summary>
          <div class="dt-dim" style="font-size:0.76rem;line-height:1.5;margin-top:4px">🎯 ${esc(mg.profitTake)}<br>🛑 ${esc(mg.maxLoss)}<br>📉 ${esc(mg.supportBreak)}<br>⏱ ${esc(mg.exitRollDte)}<br>📅 ${esc(mg.earningsHandling)}</div></details>` : '';
      return `
        <div class="dt-card ps-card" data-ticker="${esc(p.ticker)}">
          <div class="ps-top">
            <span class="ps-rank">#${p.rank}</span>
            <span class="ps-tk">${esc(p.ticker)}</span>
            <span class="ps-now">$${p.price}</span>
            <span class="ps-co">${esc(p.company || '')}</span>
            <span class="ps-grade ${gradeClass(p.grade)}" title="Grade — setup quality × premium (IV) · rank score ${p.rankScore}/100">${esc(p.grade)}</span>
            <span class="ps-tier ${tier[1]}">${tier[0]}</span>
          </div>
          <div class="ps-trade">
            <div class="ps-trade-main">Sell the <b>$${rp.strike} put</b> · ${esc(rp.expiry)} <span class="dt-dim">(${rp.dte}d)</span></div>
            <div class="ps-trade-sub">Credit ~<b>${money(rp.credit)}</b> (conservative bid) · <b>${ec.returnOnCash}%</b> on ${money(ec.cashRequired)} cash · <b>${ec.annualizedYield}%</b> annualized</div>
            <div class="ps-trade-sub">Breakeven <b>$${ec.breakeven}</b> (${ec.distanceToBreakevenPct}% cushion) · if assigned you own at $${ec.assignmentPrice} (${ec.assignmentDiscountPct}% below spot)</div>
          </div>
          <div class="ps-chips">${ivChip}${earn}${liq}${pd}${p.rsi != null ? `<span class="ps-meta">RSI ${p.rsi}</span>` : ''}</div>
          <div class="ps-reasons">${(p.reasons || []).map(esc).join(' · ')}</div>
          ${manage}
          ${cautions}
        </div>`;
    };
    const noContractNote = (t.noContract && t.noContract.length)
      ? `<div class="dt-dim" style="font-size:0.68rem;margin-top:10px">${t.noContract.length} qualifying setup${t.noContract.length === 1 ? '' : 's'} had no tradeable listed contract (illiquid, wide spread, or earnings-crossing) — shown as no trade rather than a synthetic strike.${t.eventRiskEnabled ? '' : ' Earnings-crossing puts are excluded by default.'}</div>`
      : '';
    el.innerHTML = stratHead + `<div class="dt-dim" style="font-size:0.68rem;margin:2px 0 10px">Full-market scan · ${t.scanned || 0} names → ${t.qualified || 0} qualifying setups → ${picks.length} with a real, liquid listed put</div>
      <div class="ps-grid">${picks.map(card).join('')}</div>
      ${noContractNote}
      <div class="dt-note" style="margin-top:12px">Real listed contracts, not synthetic strikes. Delta shown is a labeled moneyness+IV proxy (free chains carry no greeks); the credit is a conservative bid estimate — you may fill better. Educational, not advice: selling a cash-secured put obligates you to <b>buy 100 shares at the strike</b> if assigned — only sell puts on names you'd want to own at that price, and size to the cash required.</div>`;
  }
  document.getElementById('putsell-refresh-btn')?.addEventListener('click', runPutSellUI);

  async function runGapGoUI() {
    const el = document.getElementById('gg-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning today's unscheduled gappers…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch('/api/tracker?op=gapgo' + (ggSkipFade ? '&skipfade=1' : '')).then(r => r.json()),
        fetch('/api/tracker?op=gapgobook').then(r => r.json()).catch(() => null),
      ]);
      renderGapGo(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Gap &amp; Go.</p></div>`; }
  }
  function renderGapGo(t, book) {
    const el = document.getElementById('gg-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Gap &amp; Go unavailable.</p></div>`; return; }
    document.getElementById('gg-gen-time') && (document.getElementById('gg-gen-time').textContent = t.generatedAt ? new Date(t.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

    // Evidence + honest caveat panel (validated lead — forward-track before sizing).
    const cfg = t.config || {};
    const evidence = `<div class="rot-panel" style="border-color:#22d3ee55;background:#22d3ee0d">
      <div class="rot-head" style="color:#22d3ee">🚀 ${esc(cfg.name || 'Unscheduled Gap-and-Go')} — validated event edge</div>
      <div class="rot-sub">
        <ul style="margin:6px 0 6px 18px;padding:0">${(cfg.rules || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <b style="color:#22c55e">✓ Evidence.</b> ${esc(cfg.evidence || '')}<br>
        <b style="color:#f59e0b">⚠️ Caveat.</b> ${esc(cfg.caveat || '')}
      </div>
    </div>`;

    // Why earnings are skipped + how many were filtered today.
    const filtered = t.counts && t.counts.earningsExcluded
      ? `<div class="dt-note" style="border-left-color:var(--amber,#f59e0b)"><b>⏭️ ${t.counts.earningsExcluded} earnings-reaction gap${t.counts.earningsExcluded === 1 ? '' : 's'} filtered out today.</b> Earnings gaps are a one-time repricing — they don't continue (they underperformed non-earnings gaps in every backtest bucket). This screener trades the <b>unscheduled</b> catalyst gap only.</div>`
      : `<div class="dt-note"><b>⏭️ Earnings gaps are filtered out</b> — the edge is on unscheduled catalyst gaps only.</div>`;

    const howto = `<div class="tr-howto">
      <div class="tr-howto-head">📖 How to use this — in plain English</div>
      <ol>
        <li><b>What this is.</b> Stocks that <b>gapped up hard today on NON-earnings news</b> — a live catalyst that's still repricing. In testing, these keep running intraday; earnings gaps don't.</li>
        <li><b>Entry (the tested rule).</b> Don't chase the open. Wait ~30 min, then buy <b>only if it breaks the opening-range high</b> (📈 trigger below).</li>
        <li><b>Risk.</b> 🛑 <b>Stop</b> = 2.5×ATR below the trigger. 🏁 <b>Target</b> = 1:2. Time-stop after ~3 sessions.</li>
        <li><b>Size by risk.</b> Each card shows a 💰 <b>suggested risk %</b> of capital (0.25× fractional Kelly, scaled by the continuation score, <b>0 in risk-off</b>). Shares ≈ (that % × account) ÷ (Trigger − Stop). Sizing, not a signal — the P&amp;L is lumpy (a few winners carry it), so the model stays conservative.</li>
        <li><b>Watchlist, not advice.</b> Confirm on a chart. This is a validated <b>lead being forward-tracked</b>, not a guarantee.</li>
      </ol>
    </div>`;

    const card = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span>${r.earningsCheck === 'unknown' ? ' <span class="dt-tier-b" title="Earnings adjacency could not be verified (no data) — confirm there is no scheduled report before trading">? ER</span>' : ''}</span>
          <span class="dt-now"><b data-dt-price>$${r.last}</b> <span data-dt-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><b style="color:#22d3ee">▲ gap +${r.gapPct}%</b> <span class="dt-dim">· ${L('rvol', 'RVOL')} ${r.relVol}×${r.excessPct != null ? ' · vs SPY ' + (r.excessPct >= 0 ? '+' : '') + r.excessPct + '%' : ''}</span>${ggCauseBadge(r.cause)}</div>
        ${r.continuationScore != null ? `<div class="dt-card-sub">🎯 <b title="Take/skip meta-label: gap size + RVOL + regime. Top-third beat bottom in 6/6 years OOS. Ranks a right-skewed edge — it does not raise the ~50% hit rate.">Continuation ${r.continuationScore}</b>/100 ${r.take ? '<span class="dt-tier-a" style="background:#22c55e33;color:#22c55e">✅ TAKE</span>' : '<span class="dt-dim">· watch</span>'}${r.suggestedRiskPct ? ` &nbsp;·&nbsp; 💰 <b title="0.25× fractional Kelly by tier, scaled by score, zeroed in risk-off. Position = this% × equity ÷ (trigger − stop).">risk ${r.suggestedRiskPct}%</b> <span class="dt-dim">of capital</span>` : (r.suggestedRiskPct === 0 ? ' <span class="dt-dim">· risk-off: size 0</span>' : '')}</div>` : ''}
        <div class="dt-card-plan">📈 <b>Opening-range breakout</b> — break above <b>$${r.plan.trigger}</b> &nbsp;·&nbsp; 🛑 ${L('stop', 'Stop')} <b>$${r.plan.stop}</b> <span class="dt-dim">(−${r.plan.riskPct}%, 2.5×ATR)</span> &nbsp;·&nbsp; 🏁 ${L('target', 'Target')} <b>$${r.plan.target}</b> <span class="dt-dim">${L('rr', 'R:R')} 1:${r.plan.rr}</span></div>
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const list = (title, rows, sub) => {
      const body = (rows || []).map(card).join('');
      return `<div class="rot-panel"><div class="rot-head">${title}</div><div class="rot-sub">${sub}</div>${body || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No qualifying gappers right now — this is a selective, event-driven screen; empty on quiet days.</span></div>'}</div>`;
    };
    const regimeNote = t.regime === 'risk-off'
      ? `<div class="dt-note" style="border-left-color:#ef4444"><b>🛑 Risk-off regime — suggested size is 0.</b> Non-earnings gaps were net-negative in risk-off across the backtest (the edge is a risk-on/neutral phenomenon). Names still shown for the watchlist, but the sizing model stands down.</div>`
      : '';
    const strong = list('🔥 STRONG — gap ≥5% <span class="dt-dim">(the validated primary)</span>', t.strong, 'Big unscheduled gaps. Intraday exp08: +1.9%/trade, PF 1.47, all 4 years, passes deflation (broad survivorship-corrected daily-bar re-test: PF 1.29). Ranked by the 🎯 continuation meta-label (gap + RVOL + regime) — top-third beat bottom in 6/6 years OOS.');
    const moderate = list('⚡ MODERATE — gap 3–5%', t.moderate, 'Smaller gaps — positive but weaker than the ≥5% tier. Same continuation ranking + sizing.');

    // Self-validation ledger (forward excess-vs-SPY of logged picks, by tier).
    let bookPanel = '';
    if (book && book.ok) {
      const row = (lbl, s) => !s || !s.n ? '' : `<div class="bt-ic-row"><span>${lbl}</span><span><b>${s.avgExc >= 0 ? '+' : ''}${s.avgExc}%</b> avg excess · ${s.beatRate}% beat (Wilson ${s.wilsonLo}%) · n=${s.n}</span></div>`;
      const rows = row('Overall', book.overall) + row('STRONG (≥5%)', book.byTier && book.byTier.STRONG) + row('MODERATE (3–5%)', book.byTier && book.byTier.MODERATE);
      // By-cause accrual (offering/M&A fade vs FDA/guidance continue) — shows progress
      // toward ~150/class before the opt-in FADE skip is trusted.
      const CAUSE_LBL = { FADE_OFFERING: '🩳 Offering', MA: '🤝 Buyout', FDA: '🧪 FDA', CONTRACT: '📝 Contract', GUIDE: '📈 Guidance', OTHER: '📰 Other', NONE: '· No news' };
      const bc = book.byCause || {};
      const causeRows = Object.keys(CAUSE_LBL).map(k => { const s = bc[k]; return s && s.n ? row(`${CAUSE_LBL[k]} <span class="dt-dim">(${s.n}/${book.causeTarget || 150})</span>`, s) : ''; }).join('');
      const causeBlock = causeRows ? `<div class="bt-ic-row" style="margin-top:6px"><span style="color:var(--text-dim);font-weight:700">By gap-cause (pilot — accruing):</span><span></span></div>${causeRows}` : '';
      // Meta-label forward test (exp11). The backtest said NO LIFT (rank-IC ~0); this is the
      // live OOS check — if HIGH ≈ LOW once ~40/class resolve, the flag retires. Shown only
      // once meta-scored picks exist (older picks are 'unscored').
      const bm = book.byMeta || {};
      const metaRows = row(`🤖 Meta HIGH <span class="dt-dim">(${(bm.HIGH && bm.HIGH.n) || 0}/${book.metaTarget || 40})</span>`, bm.HIGH) + row(`🤖 Meta LOW <span class="dt-dim">(${(bm.LOW && bm.LOW.n) || 0}/${book.metaTarget || 40})</span>`, bm.LOW);
      const metaBlock = metaRows ? `<div class="bt-ic-row" style="margin-top:6px"><span style="color:var(--text-dim);font-weight:700">By meta-label (exp11 said NO LIFT — testing live):</span><span></span></div>${metaRows}` : '';
      bookPanel = `<div class="rot-panel"><div class="rot-head">📋 Live forward track record <span class="dt-dim">(self-validation)</span></div>
        <div class="rot-sub">${esc(book.note || '')}</div>
        ${rows || `<div class="bt-ic-row"><span style="color:var(--text-dim)">${book.resolved || 0} resolved · ${book.stillOpen || 0} open — accrues as picks mature (~${t.horizon} sessions).</span></div>`}${causeBlock}${metaBlock}</div>`;
    }

    el.innerHTML = evidence + filtered + regimeNote + howto + strong + moderate + bookPanel;
    // Wire each card's chart toggle (reuses the shared /api/chart canvas renderer).
    el.querySelectorAll('.dt-card[data-ticker]').forEach(cardEl => {
      const tk = cardEl.dataset.ticker;
      const btn = cardEl.querySelector('[data-chart-toggle]');
      if (btn) btn.addEventListener('click', () => toggleChart(cardEl, tk));
    });
    // ⏱️ Entry-timing lights — pass each pick's own ORB levels + avg volume.
    const ggPicks = [...(t.strong || []), ...(t.moderate || [])].map(p => ({
      ticker: p.ticker, stop: p.plan && p.plan.stop, target: p.plan && p.plan.target,
      trigger: p.plan && p.plan.trigger, avgVol: p.avgVol,
    }));
    attachTimingLights(el, ggPicks, 'gapgo');
    // Live current price + how it's trading today (cards ship with the EOD scan value).
    startGapGoPrices([...new Set(ggPicks.map(p => p.ticker))]);
  }
  // /api/price caps at 12 tickers/call — chunk so EVERY card gets a live quote,
  // not just the first 12 (these lists routinely run longer).
  async function fetchLivePrices(tickers) {
    const data = {};
    for (let i = 0; i < tickers.length; i += 12) {
      try {
        const res = await fetch('/api/price?tickers=' + encodeURIComponent(tickers.slice(i, i + 12).join(',')));
        if (!res.ok) continue;
        const d = await res.json();
        if (d && !d.error) Object.assign(data, d);
      } catch { /* skip this chunk, keep the rest */ }
    }
    return data;
  }
  let ggPriceTimer = null;
  function startGapGoPrices(tickers) {
    if (ggPriceTimer) { clearInterval(ggPriceTimer); ggPriceTimer = null; }
    if (!tickers.length) return;
    const upd = async () => {
      try {
        const data = await fetchLivePrices(tickers);
        if (!Object.keys(data).length) return;
        document.querySelectorAll('#gapgo .dt-card[data-ticker]').forEach(cardEl => {
          const q = data[cardEl.dataset.ticker]; if (!q) return;
          const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
          const pe = cardEl.querySelector('[data-dt-price]'), ce = cardEl.querySelector('[data-dt-change]');
          if (pe && shown != null && pe.textContent !== '$' + shown) { pe.textContent = '$' + shown; pe.classList.remove('price-flash'); void pe.offsetWidth; pe.classList.add('price-flash'); }
          if (ce) { const pct = q.afterHours ? q.afterHours.changePct : q.changePct; const up = parseFloat(pct) >= 0; ce.textContent = `${q.afterHours ? (q.afterHours.session === 'pre' ? 'PRE ' : 'AH ') : ''}${up ? '▲ +' : '▼ '}${pct}%`; ce.style.color = up ? 'var(--green)' : 'var(--red)'; }
        });
      } catch {}
    };
    upd(); ggPriceTimer = setInterval(upd, 30 * 1000);
  }
  document.getElementById('gg-refresh-btn')?.addEventListener('click', runGapGoUI);
  (() => {
    const b = document.getElementById('gg-skipfade-toggle');
    if (!b) return;
    b.classList.toggle('active', ggSkipFade);
    b.addEventListener('click', () => {
      ggSkipFade = !ggSkipFade;
      try { localStorage.setItem('ggSkipFade', ggSkipFade ? '1' : '0'); } catch {}
      b.classList.toggle('active', ggSkipFade);
      runGapGoUI();
    });
  })();

  // ── 🪁 Down-Day Mode (what to trade when the tape is red) ───────────────────
  // Routes each name to the play that fits a red tape — an oversold-bounce LONG
  // (V-Reversal, validated red-tape-specific edge) or an overheated/rollover SHORT —
  // and LEADS with the honest reality that chasing strength on down days loses.
  async function runDownDayUI() {
    const el = document.getElementById('downday-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Reading the tape…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch('/api/tracker?op=downday').then(r => r.json()),
        fetch('/api/tracker?op=downdaybook').then(r => r.json()).catch(() => null),
      ]);
      renderDownDay(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Down-Day Mode.</p></div>`; }
  }
  function renderDownDay(t, book) {
    const el = document.getElementById('downday-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Down-Day Mode unavailable.</p></div>`; return; }
    document.getElementById('dd-gen-time') && (document.getElementById('dd-gen-time').textContent = t.generatedAt ? new Date(t.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    const cfg = t.config || {}, rl = t.reality || {}, tape = t.tape || {};

    // Tape banner — is the market red / risk-off right now?
    const sevColor = { heavy: '#ef4444', moderate: '#f59e0b', light: '#eab308', calm: '#22c55e' }[tape.severity] || '#94a3b8';
    const tapeBanner = `<div class="rot-panel" style="border-color:${sevColor}55;background:${sevColor}0d">
      <div class="rot-head" style="color:${sevColor}">${tape.down ? '🩸' : '🟢'} Tape: SPY ${tape.spyChangePct >= 0 ? '+' : ''}${tape.spyChangePct}% today · regime ${esc(tape.regime)} ${tape.down ? `<span style="text-transform:uppercase">— ${esc(tape.severity)} red</span>` : '— not red'}</div>
      <div class="rot-sub">${tape.down
        ? `Down-Day Mode is <b>live</b> — ${esc(tape.reason)}. This is when the reversion/short plays below have their edge.`
        : `The tape is <b>not red right now</b> (${esc(tape.reason)}). These plays are red-tape-specific — on a green tape the oversold-bounce edge disappears. Come back when the market sells off.`}</div>
    </div>`;

    // The honest reality panel — the centerpiece. Chasing strength on red days loses.
    const reality = `<div class="rot-panel" style="border-color:#8b5cf655;background:#8b5cf60d">
      <div class="rot-head" style="color:#a78bfa">🎯 The honest reality of down days <span class="dt-dim">(backtested)</span></div>
      <div class="rot-sub">
        <div class="dt-note" style="border-left-color:#ef4444"><b>❌ Don't chase the names holding up green.</b> On red days those "leaders" win only <b>~${rl.leaderWinPct}%</b> at the tradeable next open and <b>${esc(rl.leaderVerdict)}</b> over the next 2–3 sessions. Buying strength into a red tape is negative selection — that's <i>why</i> down days feel hard.</div>
        <div class="dt-note" style="border-left-color:#22c55e"><b>✅ What pays instead: reversion.</b> A capitulation → turn (oversold bounce) earns <b>+${rl.bounceEmergingExcessH3}%/3d</b> (EMERGING) to <b>+${rl.bounceWatchExcessH3}%/3d</b> (WATCH, fresh turns) excess vs SPY <b>on red days</b> — but <b>${rl.bounceNormalDayExcessH3}%</b> on normal days. The edge only exists when the whole market puked. Earlier/less-confirmed turns bounce more.</div>
        <div class="dt-dim" style="font-size:12px">Evidence: ${esc(rl.source || '')}. ${esc(cfg.caveat || '')}</div>
      </div>
    </div>`;

    const tierBadge = tier => {
      const m = { WATCH: ['#eab308', 'fresh turn'], EMERGING: ['#22c55e', 'turning'], CONFIRMED: ['#3b82f6', 'confirmed (late)'] };
      const c = m[tier] || ['#94a3b8', tier];
      return `<span class="dt-tier-b" style="background:${c[0]}22;color:${c[0]};border-color:${c[0]}55" title="${tier}">${esc(tier)} · ${c[1]}</span>`;
    };
    const longCard = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span> ${tierBadge(r.tier)}</span>
          <span class="dt-now"><b data-dd-price>$${r.price}</b> <span data-dd-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><b style="color:#22c55e">🔄 Oversold bounce</b> <span class="dt-dim">· dropped ${r.geometry.dropPct}% into RSI ${r.geometry.rsiAtPivot} · up ${r.geometry.rallyOffLowPct}% off the low · score ${r.downScore}/100</span></div>
        <div class="dt-card-plan">📈 <b>Long</b> near <b>$${r.signals.entry}</b> &nbsp;·&nbsp; 🛑 Stop <b>$${r.signals.stop}</b> <span class="dt-dim">(−${r.signals.riskPct}%, below the V-low)</span> &nbsp;·&nbsp; 🏁 Target <b>$${r.signals.target}</b> <span class="dt-dim">R:R 1:${r.signals.rr}</span></div>
        <div class="dt-note">${esc(r.signals.note || '')}</div>
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const shortCard = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span> ${tierBadge(r.tier)}</span>
          <span class="dt-now"><b data-dd-price>$${r.price}</b> <span data-dd-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><b style="color:#ef4444">📉 Overheated / rollover</b> <span class="dt-dim">· ran ${r.geometry.risePct}% into RSI ${r.geometry.rsiAtPivot} · off the high ${r.geometry.dropOffHighPct}% · score ${r.score}/100</span>${r.learnedExcess != null ? ` <span class="dt-tier-b" title="Fade-engine per-stock learned edge (${r.nPriors || 0} priors). Positive = this name has historically reverted after such tops.${r.drifted ? ' ⚠ DRIFTED — the edge stopped working; deprioritized.' : ''}" style="background:${r.drifted ? '#94a3b822;color:#94a3b8' : (r.learnedExcess > 0 ? '#22c55e22;color:#22c55e' : '#ef444422;color:#ef4444')}">🧠 ${r.learnedExcess > 0 ? '+' : ''}${r.learnedExcess}%${r.drifted ? ' drift' : ''}</span>` : ''}</div>
        <div class="dt-card-plan">📉 <b>Short</b> near <b>$${r.signals.entry}</b> &nbsp;·&nbsp; 🛑 Stop <b>$${r.signals.stop}</b> <span class="dt-dim">(+${r.signals.riskPct}%, above the peak)</span> &nbsp;·&nbsp; 🏁 Target <b>$${r.signals.target}</b> <span class="dt-dim">R:R 1:${r.signals.rr}</span></div>
        <div class="dt-note">${esc(r.signals.note || '')}</div>
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const panel = (title, sub, rows, cardFn, empty) => `<div class="rot-panel"><div class="rot-head">${title}</div><div class="rot-sub">${sub}</div>${(rows || []).map(cardFn).join('') || `<div class="bt-ic-row"><span style="color:var(--text-dim)">${empty}</span></div>`}</div>`;

    const bounces = panel('🔄 Oversold Bounce <span class="dt-dim">(long — reversion)</span>',
      'Capitulation → turn. Validated red-day edge; earlier (WATCH/EMERGING) turns bounce more. Small edge, ~52–56% win — size accordingly and honor the stop.',
      t.bounces, longCard, 'No clean oversold-bounce setups right now.');

    // 🎁 Forced-Selling Reversion (CERN long reversions) — a different, event-driven long.
    const CERN_LBL = { FIRE_SALE: '🔥 ETF fire-sale', FORCED_DOWNGRADE: '📉 Forced downgrade', INDEX_DELETE: '🗑 Index deletion', LOCKUP_EXPIRY: '🔓 Lockup expiry', TAX_LOSS: '🧾 Tax-loss selling', MARGIN_SPIRAL: '⚠ Margin spiral' };
    const revCard = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span> <span class="dt-tier-b" style="background:#a78bfa22;color:#a78bfa;border-color:#a78bfa55">${esc(CERN_LBL[r.type] || r.type)}</span></span>
          <span class="dt-now"><b data-dd-price>$${r.entry != null ? (+r.entry).toFixed(2) : '—'}</b> <span data-dd-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><b style="color:#22c55e">🎁 Forced-selling reversion</b> <span class="dt-dim">· mechanical selling overshot → tends to revert${r.pProfit != null ? ` · ${Math.round(r.pProfit * 100)}% model win-prob` : ''}${r.horizon ? ` · ~${r.horizon}d hold` : ''}</span></div>
        ${r.stop != null && r.target != null ? `<div class="dt-card-plan">📈 <b>Long</b> near <b>$${(+r.entry).toFixed(2)}</b> &nbsp;·&nbsp; 🛑 Stop <b>$${(+r.stop).toFixed(2)}</b> &nbsp;·&nbsp; 🏁 Target <b>$${(+r.target).toFixed(2)}</b></div>` : ''}
        <div class="dt-note">CERN forced-flow signal — see the ⚡ Events (CERN) tab for the full model, posteriors, and track record.</div>
      </div>`;
    const reversion = panel('🎁 Forced-Selling Reversion <span class="dt-dim">(long — CERN forced-flow)</span>',
      'When an ETF fire-sale or an analyst downgrade forces mechanical selling, the name overshoots below its peers and tends to revert. Live CERN signals — a different, event-driven long that fits a red tape.',
      t.reversion, revCard, 'No active forced-selling reversion signals right now.');

    const fades = panel('📉 Overheated / Short <span class="dt-dim">(the mirror — fade a blow-off top)</span>',
      'Blow-off top rolling over. Ranked by the 🔥 Overheated tab’s per-stock LEARNED edge (🧠 chip) — drifted names sink. Shorting is harder; CONFIRMED rollovers are the more reliable ones.',
      t.fades, shortCard, 'No overheated rollovers right now.');

    // Sit-out honesty when nothing qualifies.
    const nBounce = (t.counts && t.counts.bounces) || 0, nFade = (t.counts && t.counts.fades) || 0, nRev = (t.counts && t.counts.reversion) || 0;
    const sitOut = (nBounce + nFade + nRev === 0)
      ? `<div class="dt-note" style="border-left-color:#94a3b8"><b>🪑 Sit out is a position.</b> No reversion or fade setup fits right now, and momentum longs don't work on a red tape. Preserving capital on a hostile day IS the winning move — wait for a clean bounce or for the tape to turn.</div>`
      : `<div class="dt-note" style="border-left-color:#94a3b8"><b>🪑 Sit out is always on the menu.</b> These are modest, selective edges. If nothing looks clean, standing aside on a red day beats forcing a trade.</div>`;

    // Forward track record of the bounce longs (self-validation).
    let bookPanel = '';
    if (book && book.ok) {
      const row = (lbl, s) => !s || !s.n ? '' : `<div class="bt-ic-row"><span>${lbl}</span><span><b>${s.avgExc >= 0 ? '+' : ''}${s.avgExc}%</b> avg excess · ${s.beatRate}% beat (Wilson ${s.wilsonLo}%) · n=${s.n}</span></div>`;
      const rows = row('Overall', book.overall)
        + row('WATCH (fresh turn)', book.byTier && book.byTier.WATCH)
        + row('EMERGING', book.byTier && book.byTier.EMERGING)
        + row('CONFIRMED (late)', book.byTier && book.byTier.CONFIRMED);
      bookPanel = `<div class="rot-panel"><div class="rot-head">📋 Live forward track record <span class="dt-dim">(bounce longs, red-tape only)</span></div>
        <div class="rot-sub">${esc(book.note || '')}</div>
        ${rows || `<div class="bt-ic-row"><span style="color:var(--text-dim)">${book.resolved || 0} resolved · ${book.stillOpen || 0} open — accrues on red days (~${t.horizon} sessions to mature).</span></div>`}</div>`;
    }

    el.innerHTML = tapeBanner + reality + bounces + reversion + fades + sitOut + bookPanel;
    el.querySelectorAll('.dt-card[data-ticker]').forEach(cardEl => {
      const btn = cardEl.querySelector('[data-chart-toggle]');
      if (btn) btn.addEventListener('click', () => toggleChart(cardEl, cardEl.dataset.ticker));
    });
    startDownDayPrices([...new Set([...(t.bounces || []), ...(t.reversion || []), ...(t.fades || [])].map(p => p.ticker))]);
  }
  let ddPriceTimer = null;
  function startDownDayPrices(tickers) {
    if (ddPriceTimer) { clearInterval(ddPriceTimer); ddPriceTimer = null; }
    if (!tickers.length) return;
    const upd = async () => {
      try {
        const data = await fetchLivePrices(tickers);
        if (!Object.keys(data).length) return;
        document.querySelectorAll('#downday .dt-card[data-ticker]').forEach(cardEl => {
          const q = data[cardEl.dataset.ticker]; if (!q) return;
          const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
          const pe = cardEl.querySelector('[data-dd-price]'), ce = cardEl.querySelector('[data-dd-change]');
          if (pe && shown != null && pe.textContent !== '$' + shown) { pe.textContent = '$' + shown; pe.classList.remove('price-flash'); void pe.offsetWidth; pe.classList.add('price-flash'); }
          if (ce) { const pct = q.afterHours ? q.afterHours.changePct : q.changePct; const up = parseFloat(pct) >= 0; ce.textContent = `${up ? '▲ +' : '▼ '}${pct}%`; ce.style.color = up ? 'var(--green)' : 'var(--red)'; }
        });
      } catch {}
    };
    upd(); ddPriceTimer = setInterval(upd, 30 * 1000);
  }
  document.getElementById('dd-refresh-btn')?.addEventListener('click', runDownDayUI);

  // ── 🐻 Gap-Down Continuation (short — the mirror of Gap & Go) ────────────────
  async function runGapDownUI() {
    const el = document.getElementById('gapdown-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning today's gap-downs…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch('/api/tracker?op=gapdown').then(r => r.json()),
        fetch('/api/tracker?op=gapdownbook').then(r => r.json()).catch(() => null),
      ]);
      renderGapDown(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Gap-Down.</p></div>`; }
  }
  function renderGapDown(t, book) {
    const el = document.getElementById('gapdown-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Gap-Down unavailable.</p></div>`; return; }
    document.getElementById('gd-gen-time') && (document.getElementById('gd-gen-time').textContent = t.generatedAt ? new Date(t.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    const cfg = t.config || {};
    const evidence = `<div class="rot-panel" style="border-color:#ef444455;background:#ef44440d">
      <div class="rot-head" style="color:#ef4444">🐻 ${esc(cfg.name || 'Gap-Down Continuation')} — validated short edge (mirror of Gap & Go)</div>
      <div class="rot-sub">
        <ul style="margin:6px 0 6px 18px;padding:0">${(cfg.rules || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <b style="color:#22c55e">✓ Evidence.</b> ${esc(cfg.evidence || '')}<br>
        <b style="color:#f59e0b">⚠️ Caveat.</b> ${esc(cfg.caveat || '')}
      </div>
    </div>`;
    const frictions = `<div class="dt-note" style="border-left-color:#f59e0b"><b>⚠ Shorting is harder than buying.</b> The net edge after borrow + slippage is thin (~+0.2–0.6%), and the biggest gross edge is in small names that are the hardest/priciest to borrow. Prefer liquid names you can actually short, size small, and confirm the intraday break of the opening-range low — don't chase the gap-down open.</div>`;
    const filtered = t.counts && t.counts.earningsExcluded
      ? `<div class="dt-note"><b>⏭️ ${t.counts.earningsExcluded} earnings gap-down${t.counts.earningsExcluded === 1 ? '' : 's'} filtered out.</b> Earnings gaps may be a one-time repricing that doesn't continue — this trades the unscheduled catalyst gap-down only.</div>`
      : `<div class="dt-note"><b>⏭️ Earnings gap-downs are filtered out</b> — unscheduled catalyst gap-downs only.</div>`;
    const card = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span>${r.earningsCheck === 'unknown' ? ' <span class="dt-tier-b" title="Earnings adjacency unverified — check for a scheduled report">? ER</span>' : ''}</span>
          <span class="dt-now"><b data-gd-price>$${r.last}</b> <span data-gd-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub"><b style="color:#ef4444">▼ gap ${r.gapPct}%</b> <span class="dt-dim">· RVOL ${r.relVol}×${r.excessPct != null ? ' · vs SPY ' + (r.excessPct >= 0 ? '+' : '') + r.excessPct + '%' : ''} · continuation ${r.continuationScore}/100</span></div>
        <div class="dt-card-plan">📉 <b>Short the break below</b> <b>$${r.plan.trigger}</b> <span class="dt-dim">(OR low)</span> &nbsp;·&nbsp; 🛑 Stop <b>$${r.plan.stop}</b> <span class="dt-dim">(+${r.plan.riskPct}%, 2.5×ATR above)</span> &nbsp;·&nbsp; 🏁 Target <b>$${r.plan.target}</b> <span class="dt-dim">1:${r.plan.rr}</span></div>
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    const list = (title, rows, sub) => `<div class="rot-panel"><div class="rot-head">${title}</div><div class="rot-sub">${sub}</div>${(rows || []).map(card).join('') || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No qualifying gap-downs right now — selective, event-driven; empty on quiet days.</span></div>'}</div>`;
    const strong = list('🔴 STRONG — gap ≤ −5% <span class="dt-dim">(the validated primary)</span>', t.strong, 'Big unscheduled gap-downs. Backtest: short excess +1.0%/3d, win 55%, positive all 3 years. Ranked by gap size (bigger = more continuation).');
    const moderate = list('🟠 MODERATE — gap −3 to −5%', t.moderate, 'Smaller gap-downs — positive but weaker than the ≤−5% tier.');
    let bookPanel = '';
    if (book && book.ok) {
      const row = (lbl, s) => !s || !s.n ? '' : `<div class="bt-ic-row"><span>${lbl}</span><span><b>${s.avgExc >= 0 ? '+' : ''}${s.avgExc}%</b> avg short excess · ${s.beatRate}% paid (Wilson ${s.wilsonLo}%) · n=${s.n}</span></div>`;
      const rows = row('Overall', book.overall) + row('STRONG (≤−5%)', book.byTier && book.byTier.STRONG) + row('MODERATE (−3 to −5%)', book.byTier && book.byTier.MODERATE);
      bookPanel = `<div class="rot-panel"><div class="rot-head">📋 Live forward track record <span class="dt-dim">(short, self-validation)</span></div>
        <div class="rot-sub">${esc(book.note || '')}</div>
        ${rows || `<div class="bt-ic-row"><span style="color:var(--text-dim)">${book.resolved || 0} resolved · ${book.stillOpen || 0} open — accrues ~${t.horizon} sessions after each tick.</span></div>`}</div>`;
    }
    el.innerHTML = evidence + frictions + filtered + strong + moderate + bookPanel;
    el.querySelectorAll('.dt-card[data-ticker]').forEach(cardEl => {
      const btn = cardEl.querySelector('[data-chart-toggle]');
      if (btn) btn.addEventListener('click', () => toggleChart(cardEl, cardEl.dataset.ticker));
    });
    startGapDownPrices([...new Set([...(t.strong || []), ...(t.moderate || [])].map(p => p.ticker))]);
  }
  let gdPriceTimer = null;
  function startGapDownPrices(tickers) {
    if (gdPriceTimer) { clearInterval(gdPriceTimer); gdPriceTimer = null; }
    if (!tickers.length) return;
    const upd = async () => {
      try {
        const data = await fetchLivePrices(tickers);
        if (!Object.keys(data).length) return;
        document.querySelectorAll('#gapdown .dt-card[data-ticker]').forEach(cardEl => {
          const q = data[cardEl.dataset.ticker]; if (!q) return;
          const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
          const pe = cardEl.querySelector('[data-gd-price]'), ce = cardEl.querySelector('[data-gd-change]');
          if (pe && shown != null && pe.textContent !== '$' + shown) { pe.textContent = '$' + shown; pe.classList.remove('price-flash'); void pe.offsetWidth; pe.classList.add('price-flash'); }
          if (ce) { const pct = q.afterHours ? q.afterHours.changePct : q.changePct; const up = parseFloat(pct) >= 0; ce.textContent = `${up ? '▲ +' : '▼ '}${pct}%`; ce.style.color = up ? 'var(--green)' : 'var(--red)'; }
        });
      } catch {}
    };
    upd(); gdPriceTimer = setInterval(upd, 30 * 1000);
  }
  document.getElementById('gd-refresh-btn')?.addEventListener('click', runGapDownUI);

  // ── 🧬 Coil Radar (pre-explosion: quiet, coiled names BEFORE the move) ──────
  // Flags volatility-contracted, volume-dried-up, NOT-already-run-up names and
  // attaches an EMPIRICALLY-CALIBRATED probability of an abnormal upside break.
  let coilLoaded = false, coilScope = 'all';
  function ensureCoil() { if (!coilLoaded) { coilLoaded = true; runCoilUI(); } }
  async function runCoilUI() {
    const el = document.getElementById('coil-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning for coiled setups…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch(`/api/tracker?op=coil&scope=${coilScope}&limit=24`).then(r => r.json()),
        fetch('/api/tracker?op=coilbook').then(r => r.json()).catch(() => null),
      ]);
      renderCoil(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Coil Radar.</p></div>`; }
  }
  function coilTrackPanel(book) {
    if (!book || !book.ok || !book.resolved) {
      const open = book && book.open ? book.open : 0;
      return `<div class="dt-note" style="border-left-color:#a855f7"><b>📊 Self-validation ledger.</b> Picks are logged daily and auto-graded after ~${book && book.horizonDays || 10} sessions. ${open ? open + ' logged, none matured yet — check back in ~2 weeks.' : 'No picks logged yet — the daily cron starts the track record.'}</div>`;
    }
    const rows = (book.byBand || []).map(b =>
      `<tr><td style="text-transform:capitalize">${esc(b.band)}</td><td style="text-align:right">${b.n}</td><td style="text-align:right">${b.predictedPct}%</td><td style="text-align:right"><b>${b.realizedPct}%</b></td></tr>`).join('');
    return `<div class="rot-panel" style="border-color:#a855f755;background:#a855f70d">
      <div class="rot-head" style="color:#c084fc">📊 Self-validation — predicted vs realized (out-of-sample)</div>
      <div class="rot-sub">${book.resolved} picks auto-graded over ~${book.horizonDays} sessions (${book.open} still open). Model predicted <b>${book.predictedBreakPct}%</b> would make an abnormal break; <b>${book.realizedBreakPct}%</b> actually did <span class="dt-dim">(95% CI ${book.realizedCi.lo}–${book.realizedCi.hi}%)</span>. Honest, not curve-fit.
        <table style="width:100%;margin-top:8px;font-size:.86em;border-collapse:collapse"><thead><tr style="color:var(--text-dim)"><th style="text-align:left">Coil band</th><th style="text-align:right">n</th><th style="text-align:right">predicted</th><th style="text-align:right">realized</th></tr></thead><tbody>${rows}</tbody></table>
      </div></div>`;
  }
  function coilBandColor(band) { return band === 'high' ? '#a855f7' : band === 'elevated' ? '#8b5cf6' : band === 'normal' ? '#6b7280' : '#4b5563'; }
  function renderCoil(t, book) {
    const el = document.getElementById('coil-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Coil Radar unavailable.</p></div>`; return; }
    const gen = document.getElementById('coil-gen-time'); if (gen && t.generatedAt) gen.textContent = '· ' + new Date(t.generatedAt).toLocaleString();
    const scopeBtns = ['all', 'small', 'large', 'micro'].map(s =>
      `<button class="hub-sub-btn ${s === t.scope ? 'active' : ''}" data-coil-scope="${s}" style="margin-right:6px">${s === 'all' ? 'All caps' : s === 'small' ? 'Small-cap' : s === 'large' ? 'Large-cap' : 'Micro-cap'}</button>`).join('');
    const howto = `<div class="tr-howto">
      <div class="tr-howto-head">📖 What this is — in plain English</div>
      <ol>
        <li><b>The idea.</b> Most screeners show stocks <b>already moving</b>. This shows the opposite: <b>quiet, "coiled" stocks BEFORE they explode</b> — volatility squeezed, volume dried up, price flat (not already run up).</li>
        <li><b>The %.</b> Each name shows the <b>calibrated chance of an abnormal upside break in ~${t.horizonDays} sessions</b> — an <i>honest, backtested number</i> (base rate ~${t.baseRatePct}%), <b>not a hyped "80%"</b>. Top-decile coils break ~1.9× as often as the least-coiled.</li>
        <li><b>How to use it.</b> A coil says a name is <b>primed</b>, not that it <i>will</i> pop — the trigger is usually news/earnings this price model can't see. Use it as a <b>watchlist</b>: set alerts, confirm the breakout on a chart, then act. This is a watchlist, not advice.</li>
      </ol></div>`;
    const card = r => `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><span class="coil-rank" title="Rank by coil strength — the validated break-likelihood signal">#${r.rank}</span> <b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span></span>
          <span class="dt-now"><span class="dt-dim" style="font-size:.8em">coil</span> <b style="color:#c084fc">${r.coilScore != null ? r.coilScore.toFixed(2) : ''}</b></span>
        </div>
        <div class="dt-card-sub" style="display:flex;align-items:center;gap:8px;margin:4px 0 6px">
          <span style="font-size:1.4em;font-weight:800;color:${coilBandColor(r.band)}">${r.explodeProbPct}%</span>
          <span class="dt-dim">chance to break out (~${t.horizonDays}d) · ${r.lift}× base · <b style="color:${coilBandColor(r.band)}">${esc((r.band || '').toUpperCase())} coil</b> (D${r.decile || ''}/10)</span>
        </div>
        <div class="dt-card-plan">📈 <b>Breakout plan</b> <span class="dt-dim">(buy the break, not the quiet)</span> — now <b data-dt-price>$${r.price}</b> <span data-dt-change class="dt-dim">live</span> &nbsp;·&nbsp; enter above <b>$${r.entry}</b> &nbsp;·&nbsp; 🛑 stop <b>$${r.stop}</b> <span class="dt-dim">(−${r.riskPct}%)</span> &nbsp;·&nbsp; 🎯 target <b>$${r.target}</b> <span class="dt-dim">(+${r.rewardPct}%, R:R 1:${r.rr})</span></div>
        <div class="dt-card-sub"><span class="dt-dim">squeeze ${r.metrics.squeezePctile}th pctile · vol ${r.metrics.hvPctile}th pctile · base ${r.metrics.rangeTightPct}% · ATR ${r.metrics.atrRatio}× · 20d ${r.metrics.ret20Pct >= 0 ? '+' : ''}${r.metrics.ret20Pct}%</span></div>
        ${(r.reasons || []).length ? `<ul class="coil-reasons" style="margin:6px 0 0 16px;padding:0;font-size:.86em;color:var(--text-dim,#9ca3af)">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </div>`;
    const bt = t.systemBacktest;
    const btPanel = bt ? `<div class="dt-note" style="border-left-color:#22c55e;margin-top:10px"><b>📈 Backtested system (${esc(bt.scope)}, ~2y point-in-time).</b> Trading the actual plan (enter on the break, stop, target): <b>${bt.triggerRatePct}%</b> of picks trigger; of those, <b>${bt.winRatePct}%</b> hit target, averaging <b>${bt.avgRPerEntered >= 0 ? '+' : ''}${bt.avgRPerEntered}R per entered trade</b>. ${esc(bt.verdict)}.</div>` : '';
    const caveat = `<div class="dt-note" style="border-left-color:#a855f7;margin-top:10px"><b>⚠️ Honest edge.</b> ${esc(t.method ? t.method.caveat : '')} The % is a real base rate, not a promise — most of these stay quiet. <b>Enter</b> is a breakout buy-stop above the coil (not the current price); <b>target</b> is the calibrated ≥2.5σ break level. Picks are <b>ranked by coil strength</b> (the validated signal). I tested ranking by Expected-R / reward:risk and <b>dropped it — it backtested inverted</b> (tight high-R:R stops get whipsawed → worst realized trades). Paper-track before sizing.</div>`;
    el.innerHTML = `${howto}
      ${coilTrackPanel(book)}
      <div style="margin:10px 0">${scopeBtns}</div>
      <div class="rot-panel" style="border-color:#a855f755;background:#a855f70d">
        <div class="rot-head" style="color:#c084fc">🧬 ${t.namesScanned} names scanned · the most-coiled ${t.picks.length}, ranked #1..N by coil strength</div>
        <div class="rot-sub">Ranked by <b>coil strength</b> — the signal validated to concentrate breaks. The % is the calibrated chance of an <b>abnormal</b> upside break (≥2.5× its own volatility) in ~${t.horizonDays} sessions. Each card shows the breakout plan (enter / stop / target).</div>
      </div>
      <div class="dt-grid" style="margin-top:10px">${(t.picks || []).map(card).join('')}</div>
      ${btPanel}
      ${caveat}`;
    el.querySelectorAll('[data-coil-scope]').forEach(b => b.addEventListener('click', () => { coilScope = b.getAttribute('data-coil-scope'); runCoilUI(); }));
    // Pre-breakout names → time the ENTRY relative to the breakout trigger (+ VWAP/trend).
    attachTimingLights(el, (t.picks || []).map(r => ({ ticker: r.ticker, trigger: r.entry })), 'coil');
    // Live current price + how it's trading today (cards ship with the EOD daily close).
    startCoilPrices([...new Set((t.picks || []).map(r => r.ticker))]);
  }
  let coilPriceTimer = null;
  function startCoilPrices(tickers) {
    if (coilPriceTimer) { clearInterval(coilPriceTimer); coilPriceTimer = null; }
    if (!tickers.length) return;
    const upd = async () => {
      try {
        const data = await fetchLivePrices(tickers);
        if (!Object.keys(data).length) return;
        document.querySelectorAll('#coil .dt-card[data-ticker]').forEach(cardEl => {
          const q = data[cardEl.dataset.ticker]; if (!q) return;
          const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
          const pe = cardEl.querySelector('[data-dt-price]'), ce = cardEl.querySelector('[data-dt-change]');
          if (pe && shown != null && pe.textContent !== '$' + shown) { pe.textContent = '$' + shown; pe.classList.remove('price-flash'); void pe.offsetWidth; pe.classList.add('price-flash'); }
          if (ce) { const pct = q.afterHours ? q.afterHours.changePct : q.changePct; const up = parseFloat(pct) >= 0; ce.textContent = `${q.afterHours ? (q.afterHours.session === 'pre' ? 'PRE ' : 'AH ') : ''}${up ? '▲ +' : '▼ '}${pct}%`; ce.style.color = up ? 'var(--green)' : 'var(--red)'; }
        });
      } catch {}
    };
    upd(); coilPriceTimer = setInterval(upd, 30 * 1000);
  }
  document.getElementById('coil-refresh-btn')?.addEventListener('click', runCoilUI);

  // ── Confluence (5 classic strategies agree, regime-gated, self-learning) ──
  const CFL_STRAT = { ema: '9/21 EMA', supertrend: 'Supertrend', rsi: 'RSI dip', macd: 'MACD', priceAction: 'Structure' };
  let confluenceLoaded = false;
  function ensureConfluence() { if (!confluenceLoaded) { confluenceLoaded = true; runConfluenceUI(); } }
  async function runConfluenceUI() {
    const el = document.getElementById('cfl-container');
    if (!el) return;
    el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Running 5-strategy scan…</p></div>`;
    try {
      const [t, book] = await Promise.all([
        fetch('/api/tracker?op=confluence').then(r => r.json()),
        fetch('/api/tracker?op=confluencebook').then(r => r.json()).catch(() => null),
      ]);
      renderConfluence(t, book);
    } catch { el.innerHTML = `<div class="mom-status error"><p>Could not load Confluence.</p></div>`; }
  }
  function renderConfluence(t, book) {
    const el = document.getElementById('cfl-container');
    if (!el || !t || !t.ok) { if (el) el.innerHTML = `<div class="mom-status error"><p>Confluence unavailable.</p></div>`; return; }
    const REG = { 'risk-on': ['#22c55e', 'RISK-ON', 'Trends favored'], neutral: ['#eab308', 'NEUTRAL', 'Be selective'], 'risk-off': ['#ef4444', 'RISK-OFF', 'Stand down — trend signals fail here'] };
    const [rc, rlbl, rdesc] = REG[t.regime] || REG.neutral;
    const banner = `<div class="rot-panel" style="border-color:${rc}55"><div class="rot-head" style="color:${rc}">Regime: ${rlbl}</div><div class="rot-sub">${rdesc}. A name lists when <b>≥${t.minBull} of 5</b> classic strategies agree it's bullish. Horizon ~${t.horizon} sessions.</div></div>`;
    // Condition-aware: which strategies suit today's tape (the top-trader edge).
    const COND = { trending: ['📈', 'Trending tape', 'Trend strategies (EMA · Supertrend · MACD · Structure) are in their element — they get full weight; RSI dip is down-weighted.'], choppy: ['🌊', 'Choppy / ranging tape', 'Mean-reversion (RSI dip) is in its element — it gets full weight; trend strategies are down-weighted.'], mixed: ['🤝', 'Mixed tape', 'No tape clearly favors any strategy — all weighted equally.'], riskoff: ['🛑', 'Risk-off', 'Stand down on new longs.'] };
    const [ci, clbl, cdesc] = COND[t.condition] || COND.mixed;
    const condBanner = `<div class="dt-note"><b>${ci} ${clbl}.</b> ${cdesc} <span class="dt-dim">★ = strategy in its element. (Validated: each strategy does better in its favorable tape; condition-matching raises the floor toward breakeven — not a confident edge, but the right way to use them.)</span></div>`;

    const howto = `<div class="tr-howto">
      <div class="tr-howto-head">📖 What this is — in plain English</div>
      <ol>
        <li><b>5 classic strategies vote.</b> 9/21-EMA trend · Supertrend · RSI dip-buy · MACD · price-structure. A name shows up only when <b>${t.minBull}+ agree</b> it's bullish — that's "confluence."</li>
        <li><b>Self-learning.</b> Each strategy's weight and each stock's tilt adjust from real outcomes over time (see the weights panel). The engine leans toward what's actually working.</li>
        <li><b>Each card</b> shows the agreeing strategies, a 📈 chart, and a trade plan (↩️ pullback / 🎯 breakout entry, 🛑 stop, 🏁 target). Size by risk: shares ≈ (1% of account) ÷ (Entry − Stop).</li>
        <li><b>Honest truth (5y backtest below):</b> these well-known signals — alone or in confluence — <b>do not beat the market</b> (~48% win rate). Use this as a <b>confirmation / watchlist</b> overlay, not a buy button. The live track record is the number to trust.</li>
      </ol>
    </div>`;

    // Self-improving: per-strategy learned weights + realized edge.
    const we = (t.strategyEdge || []).map(s => {
      const w = (t.weights || {})[s.strategy];
      return `<div class="bt-ic-row"><span>${esc(CFL_STRAT[s.strategy] || s.strategy)}</span><span>weight ${w != null ? w : '—'}×</span><span>edge ${s.ewmaExc > 0 ? '+' : ''}${s.ewmaExc}% <span style="color:var(--text-dim)">(${s.n})</span></span></div>`;
    }).join('');
    const weightsPanel = `<div class="rot-panel expert-only"><div class="rot-head">🧠 Self-learning — strategy weights</div><div class="rot-sub">Weights start at 1× and drift with each strategy's realized forward edge. (Thin until picks resolve.)</div>${we}</div>`;

    const card = r => {
      const badges = (r.bull || []).map(s => { const m = (r.matched || []).includes(s); return `<span class="chip ${m ? 'cyan' : 'gray'}">${m ? '★ ' : ''}${esc(CFL_STRAT[s] || s)}</span>`; }).join(' ');
      // Independent-evidence flag (family-v1): agreement across families beats piling
      // votes on one factor. Single-family "confluence" is flagged as one dressed-up signal.
      const famChip = r.familyBullCount == null ? ''
        : (r.singleFamily
          ? `<span class="chip amber" title="These strategies agree but they're all the SAME factor (${esc((r.familyBull || []).join(', '))}) — one confirmation dressed up as several. Ranked below genuinely independent agreement.">⚠ 1 family</span>`
          : `<span class="chip green" title="Independent evidence families agreeing: ${esc((r.familyBull || []).join(', '))}. Cross-family confirmation (trend + mean-reversion) is stronger than more correlated trend votes.">✓ ${r.familyBullCount} indep. families</span>`);
      const pb = r.pullback;
      return `<div class="dt-card" data-ticker="${esc(r.ticker)}">
        <div class="dt-card-top">
          <span><b>${esc(r.ticker)}</b> <span class="dt-sec">${esc(r.sector || '')}</span> <span class="dt-dim">${L('confluence', r.score + '/' + r.maxScore)}</span></span>
          <span class="dt-now"><b data-dt-price>$${r.last}</b> <span data-dt-change class="dt-dim">live</span></span>
        </div>
        <div class="dt-card-sub">${badges} ${famChip} <span class="dt-dim">${r.excess21d != null ? '· ' + L('relStrength', '1mo vs SPY') + ' ' + (r.excess21d > 0 ? '+' : '') + r.excess21d + '%' : ''}${r.beta != null ? ' · ' + L('beta', 'β') + ' ' + r.beta : ''}</span></div>
        ${pb ? `<div class="dt-card-plan">↩️ <b>${L('pullback', 'Pullback')}</b> <b>$${pb.entry}</b> · 🛑 ${L('stop', '<b>$' + pb.stop + '</b>')} <span class="dt-dim">(−${pb.riskPct}%)</span> · 🏁 ${L('target', '<b>$' + pb.target + '</b>')} <span class="dt-dim">${L('rr', 'R:R')} 1:${pb.rr}</span></div>` : ''}
        <div class="dt-card-plan">🎯 <b>${L('pullback', 'Breakout')}</b> <b>$${r.entry}</b> · 🛑 ${L('stop', '<b>$' + (r.stop != null ? r.stop : '—') + '</b>')}${r.riskPct != null ? ` <span class="dt-dim">(−${r.riskPct}%)</span>` : ''} · 🏁 ${L('target', '<b>$' + (r.target != null ? r.target : '—') + '</b>')}${r.rr ? ` <span class="dt-dim">${L('rr', 'R:R')} 1:${r.rr}</span>` : ''}</div>
        <button class="chart-toggle" data-chart-toggle>📈 Live chart &amp; signals <span class="ct-arrow">▾</span></button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>
      </div>`;
    };
    let picksPanel;
    if (t.riskOff) picksPanel = `<div class="rot-panel"><div class="rot-head">🛑 Risk-off — list suppressed</div><div class="rot-sub">Trend/confluence signals underperform in risk-off (validated). Stand down on new longs.</div></div>`;
    else {
      const relaxNote = t.relaxed && t.count ? `<div class="rot-sub" style="color:var(--amber)">No strong 4/5 confluence today — showing moderate <b>3/5</b> agreement (the ledger's bar). Weaker signal; confirm on the chart.</div>` : '';
      picksPanel = `<div class="rot-panel"><div class="rot-head">⚙️ Confluence longs (${t.count})</div><div class="rot-sub">Ranked by <b>independent-family</b> agreement (trend + mean-reversion count more than piling on correlated trend votes) + the per-stock learner. Chips = strategies that agree; the family chip flags single-factor "confluence."</div>${relaxNote}${(t.picks || []).map(card).join('') || '<div class="bt-ic-row"><span style="color:var(--text-dim)">No names at ≥3/5 agreement right now.</span></div>'}</div>`;
    }

    let track;
    if (book && book.resolved >= 10) {
      const row = (n, s) => s && s.n ? `<div class="bt-ic-row"><span>${n} <span style="color:var(--text-dim)">${s.n}</span></span><span>exc ${s.avgExc > 0 ? '+' : ''}${s.avgExc}%</span><span>${L('beatRate', 'beat')} ${s.beatRate}% <span style="color:var(--text-dim)">(${L('wilsonLB', 'LB')} ${s.wilsonLo}%)</span></span></div>` : '';
      track = `<div class="rot-panel"><div class="rot-head">📊 Live track record — forward ${t.horizon}-session excess vs SPY</div>${row('All confluence', book.overall)}${Object.keys(book.byStrategy || {}).map(s => row(CFL_STRAT[s] || s, book.byStrategy[s])).join('')}<div class="bt-ic-row" style="border-top:1px solid var(--border);margin-top:4px"><span></span><span></span><span>${book.resolved} resolved · ${book.stillOpen} open</span></div></div>`;
    } else {
      track = `<div class="rot-panel rot-panel-pending"><div class="rot-head">📊 Live track record — building…</div><div class="rot-sub">${book ? `${book.stillOpen || 0} open, ${book.resolved || 0} resolved` : ''}. Each pick scored ~${t.horizon} sessions later; accrues via the daily cron.</div></div>`;
    }

    el.innerHTML = banner + condBanner + howto + weightsPanel + picksPanel + track +
      `<div class="fade-caveats"><b>Honest validation</b> (5y, fwd ${t.horizon}-session excess vs SPY): confluence (≥3/5 agree) averaged −0.2% with a ~48% win rate. I then <b>tested every sensible improvement</b> — regime gating, a relative-strength filter, fresh-trigger-only, and taking only the top-momentum names — and the best stack (4/5 + relative-strength + regime + top-20%) only reached ~breakeven (+0.1% out-of-sample) with a <b>still-sub-50% win rate</b> (Wilson LB 44%). <b>No combination confidently beats the market</b> — the efficient-market reality for well-known indicators. So treat this as a <b>multi-strategy confirmation/watchlist</b> tool, not an edge. What it adds: one place to see when classic signals align, a self-learning weight on each, and a live track record. Confirm on the chart. Research, not advice.</div>`;

    el.querySelectorAll('.dt-card[data-ticker]').forEach(cardEl => {
      const tk = cardEl.dataset.ticker;
      const btn = cardEl.querySelector('[data-chart-toggle]');
      if (btn) btn.addEventListener('click', () => toggleChart(cardEl, tk));
    });
    startConfluencePrices([...new Set((t.picks || []).map(r => r.ticker))]);
    if (!t.riskOff) attachTimingLights(el, (t.picks || []).map(r => ({ ticker: r.ticker, stop: r.stop, target: r.target, trigger: r.entry })), 'confluence');
    const meta = document.getElementById('cfl-meta');
    if (meta) meta.textContent = `· ${t.regime} · ${t.count || 0} confluence longs`;
    const gt = document.getElementById('cfl-gen-time');
    if (gt && t.generatedAt) gt.textContent = new Date(t.generatedAt).toLocaleTimeString();
  }
  let cflPriceTimer = null;
  function startConfluencePrices(tickers) {
    if (cflPriceTimer) { clearInterval(cflPriceTimer); cflPriceTimer = null; }
    if (!tickers.length) return;
    const upd = async () => {
      try {
        const data = await fetchLivePrices(tickers);
        if (!Object.keys(data).length) return;
        document.querySelectorAll('#confluence .dt-card[data-ticker]').forEach(cardEl => {
          const q = data[cardEl.dataset.ticker]; if (!q) return;
          const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
          const pe = cardEl.querySelector('[data-dt-price]'), ce = cardEl.querySelector('[data-dt-change]');
          if (pe && shown != null && pe.textContent !== '$' + shown) { pe.textContent = '$' + shown; pe.classList.remove('price-flash'); void pe.offsetWidth; pe.classList.add('price-flash'); }
          if (ce) { const pct = q.afterHours ? q.afterHours.changePct : q.changePct; const up = parseFloat(pct) >= 0; ce.textContent = `${q.afterHours ? (q.afterHours.session === 'pre' ? 'PRE ' : 'AH ') : ''}${up ? '▲ +' : '▼ '}${pct}%`; ce.style.color = up ? 'var(--green)' : 'var(--red)'; }
        });
      } catch {}
    };
    upd(); cflPriceTimer = setInterval(upd, 30 * 1000);
  }
  document.getElementById('cfl-refresh-btn')?.addEventListener('click', runConfluenceUI);

  // ── Trade Alerts (social, ranked by the external-collector pipeline) ──
  let xalertsLoaded = false;
  function ensureXalerts() { if (!xalertsLoaded) { xalertsLoaded = true; fetchXalerts(); } }
  let xalertsFlashTimer = null;
  async function fetchXalerts() {
    const c = document.getElementById('xalerts-container');
    const btn = document.getElementById('xalerts-refresh-btn');
    if (xalertsFlashTimer) { clearTimeout(xalertsFlashTimer); xalertsFlashTimer = null; }
    if (btn) { btn.disabled = true; btn.textContent = '⟳ Refreshing…'; btn.style.color = '#8a6dff'; }
    let ok = true;
    try { renderXalerts(await (await fetch('/api/tracker?op=alerts')).json()); }
    catch { ok = false; c.innerHTML = '<div class="mom-status error"><p>Could not load trade alerts.</p></div>'; }
    finally {
      if (btn) {
        btn.disabled = false;
        // Brief "✓ Refreshed" flash so the refresh is visibly confirmed even when the
        // ranked list is unchanged (data only moves when the collector pushes new posts).
        btn.textContent = ok ? '✓ Refreshed' : '⚠ Retry';
        btn.style.color = ok ? 'var(--green, #10d98a)' : 'var(--red, #ef5050)';
        xalertsFlashTimer = setTimeout(() => {
          btn.textContent = '⟳ Refresh'; btn.style.color = '#8a6dff'; xalertsFlashTimer = null;
        }, 1400);
      }
    }
  }
  function renderXalertsEdge(edge) {
    const el = document.getElementById('xalerts-edge'); if (!el) return;
    if (!edge || edge.n == null) { el.innerHTML = ''; return; }
    if (edge.n < (edge.minGraded || 50)) {
      el.innerHTML = `<div class="cx-portfolio"><div class="cx-pf-head">📊 Edge test · gathering data</div><p class="cx-mp-p" style="margin:8px 0 0">${esc(edge.verdict)}. It won't call an edge until ${edge.minGraded || 50} alerts have graded (~3 trading days each) — by design it refuses to flatter small samples.</p></div>`;
      return;
    }
    const good = edge.edge;
    el.innerHTML = `<div class="cx-portfolio" style="border-color:${good ? '#10d98a55' : '#ef505044'}">
      <div class="cx-pf-head">📊 Edge test · ${edge.n} graded calls <span style="margin-left:auto;color:${good ? 'var(--green)' : 'var(--red)'}">${good ? '✅ EDGE' : '❌ NO EDGE'}</span></div>
      <p class="cx-mp-p" style="margin:8px 0 0">Hit rate <b>${edge.hitRatePct}%</b> [${edge.hitRateCI90[0]}–${edge.hitRateCI90[1]}] vs 50% base · conviction rank-IC <b>${edge.convictionRankIC}</b> (t ${edge.rankICtStat}) · mean excess ${edge.meanExcessPct}%/call. <b>${esc(edge.verdict)}.</b></p></div>` + fadeHtml(edge.fade);
  }
  // 🔄 Fade-the-loudest panel — when the mechanical signal is anti-predictive,
  // betting AGAINST each call ("fade") is what backtests positive. The by-direction
  // split is the tradeability tell: fading a bullish pump = SHORT (often illiquid,
  // borrow can erase the edge); fading a bearish call = cheap LONG. Mean is gross.
  const sgn = v => (v > 0 ? '+' : '') + v;
  function fadeDirRow(o, label, isLong) {
    if (!o || o.n == null) return '';
    const pos = o.meanExcessPct > 0;
    return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin-top:5px;min-width:0">
      <span class="xa-chip">${label}</span>
      <b style="color:${pos ? 'var(--green)' : 'var(--red)'}">${sgn(o.meanExcessPct)}%</b>
      <span style="color:var(--text-dim);overflow-wrap:anywhere">hit ${o.hitRatePct}% [${o.hitRateCI90[0]}–${o.hitRateCI90[1]}] · n ${o.n}</span>
      ${isLong ? '<span style="color:var(--green)">✔ cheap long</span>' : '<span style="color:var(--amber,#f0a832)">⚠ short — check borrow</span>'}</div>`;
  }
  function fadeHtml(f) {
    if (!f || f.meanExcessPct == null) return '';
    const b = f.byDirection || {};
    return `<div class="cx-portfolio" style="margin-top:8px;border-style:dashed;border-color:#8a6dff33">
      <div class="cx-pf-head">🔄 Fade-the-loudest test <span style="margin-left:auto;color:${f.edge ? 'var(--green)' : 'var(--text-dim)'}">${f.edge ? '✅ FADE EDGE' : '↔ contrarian read'}</span></div>
      <p class="cx-mp-p" style="margin:8px 0 0">Betting <b>against</b> each call: mean <b>${sgn(f.meanExcessPct)}%</b>/call (gross) · trimmed <b>${sgn(f.trimmedMeanExcessPct)}%</b> · median ${sgn(f.medianExcessPct)}% · hit ${f.hitRatePct}% [${f.hitRateCI90[0]}–${f.hitRateCI90[1]}] · loudness rank-IC <b>${f.convictionRankIC}</b> (t ${f.rankICtStat}, &gt;0 = louder→better fade).</p>
      ${fadeDirRow(b.bull, 'fade 🐂 bull', false)}
      ${fadeDirRow(b.bear, 'fade 🐻 bear', true)}
      <p class="cx-mp-p" style="margin:6px 0 0;color:var(--text-dim);font-size:.85em">Mean is gross (no borrow/slippage). Trimmed mean drops the 5% tails so a few pump implosions can't fake a broad edge — trust it over the raw mean.</p></div>`;
  }
  // 🧠 Fable A/B panel — does the AI's directional read beat the keyword bot? Stays
  // in "tracking" until enough paired calls grade, then flips to PROMOTED (Fable drives
  // ranking + filtering). Refuses to flatter small samples, like the mechanical edge test.
  function renderXalertsFableEdge(fe) {
    const el = document.getElementById('xalerts-fable'); if (!el) return;
    if (!fe || fe.n == null) { el.innerHTML = ''; return; }
    if (fe.n < (fe.minGraded || 40)) {
      el.innerHTML = `<div class="cx-portfolio" style="border-color:#8a6dff44"><div class="cx-pf-head">🧠 AI review · A/B vs the keyword bot</div>
        <p class="cx-mp-p" style="margin:8px 0 0">Fable re-reads each alert for true direction, credibility and pump-risk, and annotates every card. It won't take over the ranking until its direction has <b>beaten the keyword bot</b> on ${fe.minGraded || 40} paired graded calls. ${esc(fe.verdict)}.</p></div>`;
      return;
    }
    const promoted = fe.promoted;
    el.innerHTML = `<div class="cx-portfolio" style="border-color:${promoted ? '#8a6dff88' : '#8a6dff44'}">
      <div class="cx-pf-head">🧠 AI review · A/B vs the keyword bot <span style="margin-left:auto;color:${promoted ? '#8a6dff' : 'var(--text-dim)'}">${promoted ? '✅ PROMOTED' : '⏳ TRACKING'}</span></div>
      <p class="cx-mp-p" style="margin:8px 0 0">Fable direction <b>${fe.fableHitRatePct}%</b> [LB ${fe.fableHitRateLB90}%] vs keyword bot <b>${fe.mechHitRatePct}%</b> over ${fe.n} paired calls${fe.overrides ? ` · ${fe.overrides} overrides hit ${fe.overrideHitRatePct}%` : ''}. <b>${esc(fe.verdict)}.</b>${promoted ? ' Fable now drives card order and hides junk.' : ''}</p></div>`;
  }
  function renderXalerts(d) {
    renderXalertsEdge(d.edge);
    renderXalertsFableEdge(d.fableEdge);
    const c = document.getElementById('xalerts-container'), meta = document.getElementById('xalerts-meta');
    if (meta) meta.textContent = d.generatedAt ? `· ${d.bufferSize} posts · updated ${new Date(d.generatedAt).toLocaleString()} · ${d.gradedTotal}/${d.loggedTotal} graded${d.aiPromoted ? ' · 🧠 AI-ranked' : d.aiAssessedAt ? ' · 🧠 AI-reviewed' : ''}` : '· awaiting data from the collector';
    const ranked = d.ranked || [];
    if (!ranked.length) {
      c.innerHTML = `<div class="mom-status"><p style="text-align:left;line-height:1.7">
        <b>No alerts yet.</b> This tab ranks trade alerts that an <b>external collector</b> POSTs to the app — the scraping runs on your machine (where a browser exists); the app does the ranking + edge-grading.<br><br>
        <b>To feed it</b> (from <code>~/trade-alert-ranker</code>):<br>
        1. Set <code>APP_INGEST_URL</code> = <code>https://market-news-app-chi.vercel.app/api/tracker?op=alertsingest</code><br>
        2. (Recommended) set a matching <code>ALERTS_INGEST_TOKEN</code> as a Vercel env var <i>and</i> in the collector.<br>
        3. Run <code>python3 trade_alert_ranker.py push</code> — schedule it on a cron / GitHub Action to keep this live.<br><br>
        Posts will rank here; the edge test grades them over the next few days.</p></div>`;
      return;
    }
    c.innerHTML = '';
    const grid = document.createElement('div'); grid.className = 'scr-grid';
    ranked.forEach(r => grid.appendChild(buildXalertCard(r)));
    c.appendChild(grid);
    // ⏱️ Entry-timing light — buy-side only (bullish alerts); uses the trader's stated
    // stop/target for R:R when present, else VWAP/extension/volume alone.
    const bullish = ranked.filter(r => r.direction === 'bullish' && r.ticker).map(r => ({
      ticker: r.ticker, stop: r.levels && r.levels.stop, target: r.levels && r.levels.target,
    }));
    attachTimingLights(c, bullish, 'xalerts', tk => {
      const el = grid.querySelector(`.cx-ticker[data-live="${tk}"]`);
      return el ? el.closest('.cx-card') : null;
    });
  }
  const ALERT_CATALYST = { earnings: '📅 Earnings', fda: '🧪 FDA/Trial', breakout: '🚀 Breakout', 'm&a': '🤝 M&A', squeeze: '🩳 Squeeze', analyst: '📊 Analyst', insider: '🏛 Insider', technical: '📈 Technical' };
  const ALERT_TF = { day: '⏱ Day trade', swing: '📆 Swing', long: '🗓 Long-term' };
  function convictionMeta(c) {
    if (c == null) return null;
    const label = c >= 75 ? 'Extreme' : c >= 50 ? 'High' : c >= 25 ? 'Medium' : 'Low';
    const col = c >= 75 ? 'var(--red)' : c >= 50 ? 'var(--amber,#f0a832)' : c >= 25 ? '#06c4d4' : 'var(--text-dim)';
    return { label, col, c };
  }
  const XA_PUMP = { low: null, medium: { t: '⚠ pump-risk med', c: 'var(--amber,#f0a832)' }, high: { t: '🚩 pump-risk HIGH', c: 'var(--red)' } };
  // 🧠 Fable-5 review block — the reasoned read that corrects the keyword bot's
  // direction/conviction. Shows corrected direction, confidence (thesis right?),
  // credibility (genuine vs pump), disagreement flag, and a one-line synthesis.
  function buildXalertAi(r) {
    const ai = r.ai; if (!ai) return '';
    const aiColor = ai.direction === 'bullish' ? 'var(--green)' : ai.direction === 'bearish' ? 'var(--red)' : 'var(--text-dim)';
    const chips = [`<span class="xa-chip" style="color:${aiColor};border-color:currentColor">${esc(ai.direction)}</span>`];
    if (ai.confidence != null) chips.push(`<span class="xa-chip">conf ${ai.confidence}</span>`);
    if (ai.credibility != null) chips.push(`<span class="xa-chip">cred ${ai.credibility}</span>`);
    const pump = XA_PUMP[ai.pumpRisk];
    if (pump) chips.push(`<span class="xa-chip" style="color:${pump.c};border-color:currentColor">${pump.t}</span>`);
    if (!ai.agrees) chips.push(`<span class="xa-chip" style="color:var(--amber,#f0a832);border-color:currentColor" title="Fable disagrees with the keyword bot's direction (${esc(r.direction)})">↔ overrides bot</span>`);
    const thesis = ai.thesis ? `<div class="cx-narrative" style="margin-top:4px;font-style:italic">${esc(ai.thesis)}</div>` : '';
    const caution = ai.caution ? `<div class="xa-caution" style="color:var(--amber,#f0a832)">⚠ ${esc(ai.caution)}</div>` : '';
    return `<div class="xa-ai" style="margin-top:7px;padding-top:7px;border-top:1px dashed var(--border,#ffffff1a)">
        <div class="xa-ai-lb" style="color:#8a6dff;margin-bottom:4px">🧠 Fable review</div>
        <div class="xa-chips">${chips.join('')}</div>${thesis}${caution}</div>`;
  }
  function buildXalertCard(r) {
    const card = document.createElement('div'); card.className = 'cx-card';
    const stars = '★'.repeat(r.score) + '☆'.repeat(5 - r.score);
    const dirColor = r.direction === 'bullish' ? 'var(--green)' : r.direction === 'bearish' ? 'var(--red)' : 'var(--text-dim)';

    // Mined-signal chips: catalysts (WHY), options, timeframe.
    const chips = [];
    (r.catalysts || []).forEach(t => chips.push(`<span class="xa-chip">${ALERT_CATALYST[t] || esc(t)}</span>`));
    if (r.options) chips.push(`<span class="xa-chip" style="color:#06c4d4;border-color:#06c4d444">⚡ ${esc(r.options.type)}${r.options.strike ? ' $' + esc(String(r.options.strike)) : ''}</span>`);
    if (r.timeframe && ALERT_TF[r.timeframe]) chips.push(`<span class="xa-chip">${ALERT_TF[r.timeframe]}</span>`);
    const chipRow = chips.length ? `<div class="xa-chips">${chips.join('')}</div>` : '';

    // Conviction meter (intensity of the language, distinct from direction).
    const cm = convictionMeta(r.conviction);
    const convHtml = (cm && cm.c > 0) ? `<div class="xa-conv" title="How strongly the posts are worded (intensity language + emoji) — not a measure of whether they're right">
        <span class="xa-conv-lb">Conviction</span><div class="xa-conv-track"><div class="xa-conv-fill" style="width:${cm.c}%;background:${cm.col}"></div></div><span style="color:${cm.col};font-weight:700">${cm.label}</span></div>` : '';

    // Stated price levels (the actionable part — what the trader is actually playing).
    const lv = r.levels;
    const levelsHtml = lv ? `<div class="xa-levels">${lv.entry != null ? `<span>▶ Entry <b>$${esc(String(lv.entry))}</b></span>` : ''}${lv.target != null ? `<span>🎯 Target <b style="color:var(--green)">$${esc(String(lv.target))}</b></span>` : ''}${lv.stop != null ? `<span>🛑 Stop <b style="color:var(--red)">$${esc(String(lv.stop))}</b></span>` : ''}</div>` : '';

    card.innerHTML = `<div class="cx-top"><div>
        <div class="cx-tk-row"><span class="cx-ticker" data-live="${esc(r.ticker)}">$${esc(r.ticker)}</span>
          <span class="cx-tierbadge" style="color:${dirColor};border-color:currentColor;background:transparent">${esc(r.direction)}</span>
          ${r.coordinated ? '<span class="cx-tierbadge" style="color:var(--amber);border-color:#f0a83244;background:var(--amber-dim)">⚠ coordinated</span>' : ''}</div>
        <div class="cx-company">${r.independentSources} independent source${r.independentSources > 1 ? 's' : ''} · ${r.distinctAccounts} account${r.distinctAccounts > 1 ? 's' : ''} · ${esc(r.accounts.join(', '))}</div>
      </div>
      <div class="cx-score-col"><div class="cx-score" style="color:#8a6dff;font-size:1.05rem">${stars}</div>
        <div class="cx-price">signal ${r.weightedSignal}</div></div></div>
      ${chipRow}${convHtml}${levelsHtml}${buildXalertAi(r)}
      <div class="cx-narrative">${esc(r.sampleText)}</div>`;
    return card;
  }
  document.getElementById('xalerts-refresh-btn')?.addEventListener('click', fetchXalerts);

  // ── Momentum Alerts ──
  const momentumContainer  = document.getElementById('momentum-container');
  const momentumRefreshBtn = document.getElementById('momentum-refresh-btn');
  const momentumGenTime    = document.getElementById('momentum-gen-time');
  const momentumMeta       = document.getElementById('momentum-meta');

  momentumRefreshBtn.addEventListener('click', fetchMomentum);
  // Lazy-load: only start polling when the Momentum tab opens.
  let momentumLoaded = false;
  function ensureMomentum() { if (momentumLoaded) return; momentumLoaded = true; fetchMomentum(); setInterval(fetchMomentum, 5 * 60 * 1000); }

  async function fetchMomentum() {
    momentumRefreshBtn.disabled = true;
    momentumContainer.innerHTML = skeletonGrid(4);
    try {
      const res  = await fetch('/api/momentum');
      const data = await res.json();
      if (data.error) { showMomError(data.error); return; }
      renderMomentum(data);
    } catch { showMomError('Could not load momentum data. Please try again.'); }
    finally { momentumRefreshBtn.disabled = false; }
  }

  function renderMomentum(data) {
    let { strongBuys = [], strongSells = [], scannedCount, excludedExtended = 0, generatedAt } = data;
    // Hide tiers disabled on the scoreboard (kept logged + scored server-side).
    if (isSignalDisabled('momentum', 'StrongBuy'))  strongBuys = [];
    if (isSignalDisabled('momentum', 'StrongSell')) strongSells = [];
    renderMomentumRegime(); // show the bearish-regime warning banner if applicable
    if (generatedAt) momentumGenTime.textContent = `Updated ${new Date(generatedAt).toLocaleTimeString()}`;
    momentumMeta.textContent = `· ${scannedCount || 0} trending names scanned · early movers only`
      + (excludedExtended ? ` · ${excludedExtended} extended filtered` : '');

    const cols = document.createElement('div');
    cols.className = 'mom-columns';
    cols.appendChild(buildMomColumn('buy', strongBuys));
    cols.appendChild(buildMomColumn('sell', strongSells));

    momentumContainer.innerHTML = '';
    momentumContainer.appendChild(cols);

    // Seed signal state + badges (and surface flips into Strong as alerts)
    [...strongBuys, ...strongSells].forEach(c => handleSignalUpdate(c.ticker, c.action));

    // Live (after-hours-aware) price updates for every listed ticker
    startLivePrices([...strongBuys, ...strongSells].map(c => c.ticker));
  }

  // ── Signal Scoreboard (realized forward returns + enable/disable) ──────────
  const scoreboardContainer  = document.getElementById('scoreboard-container');
  const scoreboardRefreshBtn = document.getElementById('scoreboard-refresh-btn');
  const scoreboardGenTime    = document.getElementById('scoreboard-gen-time');
  const scoreboardMeta       = document.getElementById('scoreboard-meta');
  let   lastScoreboard       = null;

  const SB_SECTIONS   = { screener: '🔎 Screener', momentum: '🔥 Momentum', Ghost: '👻 Ghost Accumulation', Fade: '🔥 Overheated (Fade Shorts)', CERN: '⚡ CERN Forced-Flow Events', Tone: '🎙 Earnings-Call Tone', Attention: '📈 Attention (Sticky vs Fast)', ReadThrough: '🔗 Read-Through (Fresh vs Moved)', Anomaly: '🕵️ Stealth (Accumulation vs Explained)', Biotech: '🧬 Biotech Radar (Hot vs Watch)', SecondWave: '🌊 Second Wave (Primed vs Faded)', CrossAsset: '🌐 Cross-Asset (Lead vs Inline)', ToneShift: '🎚️ Tone Shift (Brightening vs Darkening)', DownDay: '🪁 Down-Day Bounce (Longs)', GapDown: '🐻 Gap-Down Continuation (Shorts)', daytrade: '⚡ Day Trade (A vs B)', coil: '🧬 Coil Radar (squeeze bands)', Ignition: '🔥 Momentum Ignition (Ignition vs Watch)', OMEGA: '💠 OMEGA-Swing (Prime vs Watch)' };
  const SB_TIER_LABEL = { Breakout: 'Breakout', Setup: 'Setup', Early: 'Early', StrongBuy: 'Strong Buy', StrongSell: 'Strong Sell', GHOST: '👻 Ghost', STALKING: '🥷 Stalking', SHORT: 'Short', SHORT_LIGHT: 'Short (light)',
    WATCH: '👀 Watch (fresh turn)', EMERGING: '🌗 Emerging (turning)', CONFIRMED: '✅ Confirmed (late)',
    IGNITION: '🔥 Ignition (accelerating)',
    OMEGA_PRIME: '💠 Prime', OMEGA_QUALIFIED: '🟢 Qualified', OMEGA_WATCH: '👁 Watch',
    STRONG: '🔴 Strong (≥5% gap)', MODERATE: '🟠 Moderate (3–5% gap)',
    INDEX_DELETE: 'Index Delete', INDEX_ADD_FADE: 'Index Add (fade)', LOCKUP_EXPIRY: 'Lockup Expiry', TAX_LOSS: 'Tax-Loss Selling', FIRE_SALE: 'Fire Sale', MARGIN_SPIRAL: 'Margin Spiral', FORCED_DOWNGRADE: 'Forced Downgrade',
    Bullish: '📈 Bullish tone', Neutral: '➖ Neutral tone', Bearish: '📉 Bearish tone',
    Sticky: '📈 Sticky attention', Fast: '⚡ Fast hype',
    Fresh: '🟢 Fresh (not yet moved)', Moved: '⚪ Moved (priced in)', Unknown: '◽ Unknown',
    Accumulation: '🕵️ Accumulation (no reason)', Explained: '📰 Explained (priced)', Noise: '🌫️ Noise',
    Hot: '🔥 Hot (75+)', Emerging: '🌗 Emerging (60+)', Watch: '👀 Watch (45+)',
    Primed: '🌊 Primed (2nd wave)', Early: '🌱 Early', Faded: '🥱 Faded (crowded)',
    Lead: '🌐 Lead (lagging)', Inline: '🔗 Inline (caught up)', Weak: '🌫️ Weak link',
    Brightening: '📈 Brightening', Stable: '➖ Stable', Darkening: '📉 Darkening',
    A: '⭐ A-tier (strict)', B: '🅱️ B-tier (building)' };
  const SB_HZ         = [['1d', '1-Day'], ['5d', '5-Day'], ['10d', '10-Day'], ['20d', '20-Day'], ['1m', '1-Month'], ['3m', '3-Month']];
  // Plain-English "what is this?" hovers for a novice investor — shown on each
  // Scoreboard section header and horizon column.
  const SB_SECTION_HELP = {
    screener: 'Stocks flagged by the breakout screener (chart setups). Each row shows how that quality tier has actually performed since it was flagged.',
    momentum: 'Strong-buy / strong-sell momentum calls, and how they panned out afterward.',
    Ghost: 'Quiet pre-breakout accumulation picks (the Ghost model). Track record of each tier.',
    Fade: 'Overheated names flagged to SHORT (bet they fall). A win here means the stock dropped.',
    CERN: 'Forced-selling events (index changes, lockups, fire-sales, downgrades). One row per event type, showing how the reaction played out.',
    Tone: 'How upbeat or evasive management sounded on the recent earnings call, scored by Claude. Does a bullish-sounding call actually beat the market? This shows it.',
    Attention: 'Social attention split two ways: STICKY = interest sustained over many days (tends to keep drifting up); FAST = a short hype spike (tends to fade/reverse). Compare the two buckets’ returns to see if the split holds.',
    ReadThrough: 'Second-order beneficiaries of the day’s big movers (a supplier/customer/rival linked to a gapper). FRESH = hadn’t repriced when surfaced; MOVED = already jumped. The test: do the Fresh (un-moved) read-throughs actually beat their peers — and beat the already-Moved ones? Excess here is vs each name’s own SECTOR ETF (beat your peers, not just the market); falls back to the S&P if the sector is unknown.',
    Anomaly: 'Stocks that were climbing on volume with NO news, then investigated by AI. ACCUMULATION = no public catalyst found (possible stealth buying); EXPLAINED = a reason was found (already priced); NOISE = technical/illiquid. The test: do the ACCUMULATION names actually beat their sector — and beat the Explained/Noise buckets? Excess is vs each name’s own SECTOR ETF.',
    Biotech: 'Biotech names that just started running, scored 0–100 by a catalyst-aware model (HOT 75+, EMERGING 60+, WATCH 45+). The test: do the HOT-scored names actually beat the WATCH-scored ones — and beat the biotech index (XBI)? Excess here is measured vs XBI, the biotech ETF, not the S&P.',
    SecondWave: 'Stocks that had a first leg up but the crowd hasn’t piled into yet, then judged by AI. PRIMED = fresh story with room to spread (possible reflexive second wave); EARLY = needs a trigger; FADED = already crowded/late. The test: do PRIMED names actually get the second leg — beating their sector and the Faded ones? Excess is vs each name’s own SECTOR ETF.',
    CrossAsset: 'US stocks levered to a move in ANOTHER asset (a commodity, an overnight foreign market/ADR, crypto, or rates) that they may not have caught up to yet. LEAD = still lagging the tell (actionable); INLINE = already tracking; WEAK = loose link. The test: do the LEAD names actually catch up — beating the market and the Inline ones?',
    ToneShift: 'How a company’s latest earnings call sounded vs LAST quarter’s. BRIGHTENING = management got more confident/specific (dropped hedges, added guidance-raise language); DARKENING = more cautious. The test: do BRIGHTENING names beat their sector — and beat the Darkening ones? A slower swing-horizon signal.',
    DownDay: 'Oversold-bounce LONGS surfaced by Down-Day Mode and logged only on RED tapes (a capitulation → turn). Backtest says the edge is red-tape-specific and the EARLIER turns (WATCH/EMERGING) bounce more than CONFIRMED — this is the live test of that.',
    GapDown: 'Gap-down continuation SHORTS (the mirror of Gap & Go): a name that gapped down hard on non-earnings news and kept falling. A win here means the stock dropped. The test: do bigger gap-downs (STRONG ≥5%) continue lower more than MODERATE? Costs not deducted — subtract borrow/slippage.',
    daytrade: 'Intraday momentum picks from the Day-Trade screener (A = strict quality, B = relaxed “building”). The test: does the A tier actually beat the B tier on forward returns? Scored in the score-decile check by its own relVol/gap ranker.',
    coil: 'Pre-explosion compression picks from Coil Radar, grouped by calibrated squeeze band. The test: do the tightest-squeeze bands actually break out more? Scored in the score-decile check by its own Bollinger-squeeze-rank model.',
    OMEGA: 'OMEGA-SWING 5–10 day continuation picks (💠 Prime / 🟢 Qualified / 👁 Watch). The test: do the Prime names actually beat Qualified and Watch — and beat the market — over 1–2 weeks? Each pick is sector- & market-relative and ranked by expected utility.',
  };
  const SB_HZ_HELP = 'Average return this many trading days after the pick. The green/red “vs S&P” line under it is the market-beating number: the pick’s return minus what the S&P 500 did over the same days.';

  // Regime filter — split every track record by the macro regime live at each
  // pick's trigger (the project's one validated edge lever). 'all' = unsplit.
  const SB_REGIMES = [['all', 'All Markets'], ['risk-on', 'Bull / Risk-On'], ['risk-off', 'Bear / Risk-Off']];
  let sbRegime = (() => { try { return localStorage.getItem('sbRegime') || 'all'; } catch { return 'all'; } })();
  function setSbRegime(r) {
    sbRegime = r;
    try { localStorage.setItem('sbRegime', r); } catch {}
    if (lastScoreboard) renderScoreboard(lastScoreboard);
  }
  // Active horizons for a group given the selected regime: the unsplit set for
  // 'all', otherwise that regime's bucket (empty obj → all horizons read pending).
  function sbHz(g) {
    if (sbRegime === 'all') return g.horizons || {};
    return (g.byRegime && g.byRegime[sbRegime]) || {};
  }

  function getDisabledSignals() {
    try { const a = JSON.parse(localStorage.getItem('disabledSignals')); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function isSignalDisabled(section, tier) {
    return !!tier && getDisabledSignals().includes(section + ':' + tier);
  }
  function toggleSignal(section, tier) {
    const key = section + ':' + tier;
    const set = new Set(getDisabledSignals());
    set.has(key) ? set.delete(key) : set.add(key);
    try { localStorage.setItem('disabledSignals', JSON.stringify([...set])); } catch {}
    if (lastScoreboard) renderScoreboard(lastScoreboard);
    // Apply immediately to the affected section.
    if (section === 'momentum' && typeof fetchMomentum === 'function') fetchMomentum();
    if (section === 'screener') ['large', 'small', 'micro'].forEach(s => rankAndRender(s));
  }

  async function fetchScoreboard() {
    scoreboardRefreshBtn.disabled = true;
    scoreboardContainer.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Computing realized returns…</p></div>';
    try {
      const res = await fetch('/api/tracker');
      const data = await res.json();
      lastScoreboard = data;
      renderScoreboard(data);
    } catch { scoreboardContainer.innerHTML = '<div class="mom-status error"><p>Could not load the scoreboard. Please try again.</p></div>'; }
    finally { scoreboardRefreshBtn.disabled = false; }
  }

  // Headline expectancy: prefer 1-month, fall back to 1-week, then 3-month —
  // from the currently-selected regime bucket.
  function sbVerdict(g) {
    const h = sbHz(g);
    const pick = h['20d'] || h['1m'] || h['10d'] || h['5d'] || h['1d'] || h['3m'];
    if (!pick) return { cls: 'pending', label: 'Pending', val: null };
    return { cls: pick.avg > 0 ? 'pos' : 'neg', label: pick.avg > 0 ? 'Positive' : 'Negative', val: pick.avg };
  }

  const SB_THIN_N = 10; // below this resolved-sample, flag the regime split as thin

  // Model-quality chip — the section's score-decile verdict: does THIS section's own
  // conviction score actually rank its winners? (Same for every tier in the section.)
  function sbModelChip(sec) {
    const rq = sbBySection[sec];
    if (!rq || !rq.ready) return '';
    const ic = rq.ic || {};
    if (ic.ic == null) return '';
    const [icn, vcol, vtxt] = RQ_VERDICT[rq.verdict] || RQ_VERDICT.insufficient;
    return `<span class="sb-model" style="color:${vcol};border-color:${vcol}55" title="Score-decile — does this section's own conviction score rank its winners? ${esc(vtxt)}. Rank-IC ${ic.ic} (t=${ic.t ?? '—'}${ic.significant ? ', significant' : ''}) over ${rq.n} resolved ${esc(sbScoreHz)} picks · ${esc(rq.method || '')} scorer.">${icn} model ${ic.ic >= 0 ? '+' : ''}${ic.ic}</span>`;
  }

  function sbCard(g) {
    const v = sbVerdict(g);
    const h = sbHz(g);
    const disabled = isSignalDisabled(g.section, g.tier);
    const hz = SB_HZ.map(([k, lb]) => {
      const s = h[k];
      if (!s) return `<div class="sb-h"><div class="sb-h-lb" title="${esc(SB_HZ_HELP)}">${lb}</div><div class="sb-h-ret na">—</div><div class="sb-h-sub">pending</div></div>`;
      const up = s.avg >= 0;
      // Market-relative line — the Step-1 headline: excess vs the S&P over the same
      // window, plus how often the signal beat the market. null until SPY resolves.
      const exUp = s.avgExcess != null && s.avgExcess >= 0;
      const exLine = s.avgExcess == null
        ? `<div class="sb-h-exc na">vs S&amp;P: —</div>`
        : `<div class="sb-h-exc ${exUp ? 'up' : 'down'}" title="Average return minus the S&P 500 over the same ${lb} window — this is 'did it beat the market'. Beat rate = share of picks that outran the S&P.">vs S&amp;P ${exUp ? '+' : ''}${s.avgExcess}% · beat ${s.beatMktRate}%</div>`;
      // Cost-adjusted headline (cost-v1): the same return after a realistic round-trip
      // spread+slippage haircut, tiered by liquidity. This is 'does the edge survive
      // real friction?' — often the deciding line on thin small/micro-cap signals.
      const netUp = s.avgNet != null && s.avgNet >= 0;
      const netLine = s.avgNet == null ? ''
        : `<div class="sb-h-net ${netUp ? 'up' : 'down'}" title="Return after a realistic round-trip cost (spread + slippage), tiered by liquidity: large ~0.16%, small ~0.60%, biotech ~1.0%, micro ~1.5%. 'vs S&P' is the cost-adjusted market-beat. Cost model ${esc((lastScoreboard && lastScoreboard.costModel && lastScoreboard.costModel.version) || 'cost-v1')}.">net ${netUp ? '+' : ''}${s.avgNet}%${s.avgNetExcess != null ? ` · vs S&amp;P ${s.avgNetExcess > 0 ? '+' : ''}${s.avgNetExcess}%` : ''}</div>`;
      // Sector-relative line: return minus the pick's SECTOR ETF — isolates real
      // selection skill from sector beta (beating the market can just be owning the
      // hot sector). null until the sector ETF resolves for enough picks.
      const secUp = s.avgSecExcess != null && s.avgSecExcess >= 0;
      const secLine = s.avgSecExcess == null ? ''
        : `<div class="sb-h-sec ${secUp ? 'up' : 'down'}" title="Average return minus the pick's own SECTOR ETF (XLK, XLF, XBI…) over the same ${lb} window — 'did it beat its peers', not just the market. Strips out sector beta so a hot-sector tailwind isn't mistaken for stock-selection skill. Beat rate = share that outran their sector.">vs sector ${secUp ? '+' : ''}${s.avgSecExcess}% · beat ${s.beatSecRate}%</div>`;
      // Realistic-entry line: what you'd actually get entering the NEXT session's open
      // (you can't trade the close you screen on), plus the entry drag vs that close.
      // Only present on sleeves whose picks had no logged entry price.
      const realUp = s.avgReal != null && s.avgReal >= 0;
      const realLine = s.avgReal == null ? ''
        : `<div class="sb-h-real ${realUp ? 'up' : 'down'}" title="Return entering at the NEXT session's open instead of the signal-day close (which an end-of-day screen can't actually trade). Entry drag ${s.avgEntryDrag != null ? (s.avgEntryDrag > 0 ? '+' : '') + s.avgEntryDrag + '%' : 'n/a'} = how much the un-tradeable close flattered the result (negative = it was optimistic). Model entry-v1.">real entry ${realUp ? '+' : ''}${s.avgReal}%${s.avgEntryDrag != null ? ` · drag ${s.avgEntryDrag > 0 ? '+' : ''}${s.avgEntryDrag}%` : ''}</div>`;
      // Distribution stats (#4) — median resists the fat outlier tail, trimmed drops
      // the extremes, the CI says whether the mean is distinguishable from zero.
      const distTip = s.median != null
        ? `Mean ${up ? '+' : ''}${s.avg}% · median ${s.median > 0 ? '+' : ''}${s.median}% · 10%-trimmed ${s.trimmedAvg > 0 ? '+' : ''}${s.trimmedAvg}%${s.avgCI ? ` · 90% CI [${s.avgCI.lo}, ${s.avgCI.hi}]${s.avgCI.lo > 0 ? ' — above zero' : s.avgCI.hi < 0 ? ' — below zero' : ' — spans zero'}` : ''}`
        : `Mean return ${lb} after the pick`;
      return `<div class="sb-h"><div class="sb-h-lb" title="${esc(SB_HZ_HELP)}">${lb}</div><div class="sb-h-ret ${up ? 'up' : 'down'}" title="${esc(distTip)}">${up ? '+' : ''}${s.avg}%</div><div class="sb-h-sub">${s.winRate}% win · n=${s.n}</div>${exLine}${netLine}${secLine}${realLine}</div>`;
    }).join('');
    const HZ_FALLBACK = ['20d', '1m', '10d', '5d', '1d', '3m'];
    const hzKey = HZ_FALLBACK.find(k => h[k] && h[k].n) || null;
    const hzLabel = (SB_HZ.find(x => x[0] === hzKey) || [])[1] || hzKey || '';
    const hl = hzKey ? h[hzKey] : (h['20d'] || h['1m'] || h['10d'] || h['5d'] || h['1d'] || h['3m']);
    // In a regime view, show that regime's logged-pick count; flag thin samples so
    // a 2-pick win-rate isn't mistaken for a real edge (the project's small-n rule).
    const regCount = sbRegime === 'all' ? g.picks : ((g.regimePicks && g.regimePicks[sbRegime]) || 0);
    const thin = sbRegime !== 'all' && (!hl || hl.n < SB_THIN_N)
      ? `<span class="sb-thin" title="Small sample for this regime in the current data window — interpret with caution; the live window is mostly risk-on so the risk-off bucket fills slowly.">⚠ thin sample</span>` : '';
    const wl = hl ? `<div class="sb-wl"><span>Avg win <b class="win">+${hl.avgWin}%</b></span><span>Avg loss <b class="loss">${hl.avgLoss}%</b></span></div>` : '';
    // Big-winner reach: how often the signal's best run-up (MFE) crossed +10% / +20%
    // before the horizon, regardless of where it closed. Surfaces the models that
    // catch large moves vs. those that only grind out a small average.
    const heatSpans = (hl && hl.avgMae != null)
      ? `<span title="Average worst intra-hold drawdown per signal (Maximum Adverse Excursion) — the heat you sat through to earn the result, which a flat average return hides">🩸 Heat <b>−${hl.avgMae}%</b></span>${hl.excursionRatio != null ? `<span title="Avg favorable reach ÷ avg adverse reach (MFE/MAE). >1 = the path ran in your favor more than against before the horizon">R/P <b>${hl.excursionRatio}×</b></span>` : ''}`
      : '';
    const bw = (hl && hl.big10 != null) ? `<div class="sb-bw"><span title="Share of signals whose best run-up reached +10% before the horizon elapsed">🚀 &gt;10%: <b>${hl.big10}%</b></span><span title="Share that reached +20%">&gt;20%: <b>${hl.big20}%</b></span><span title="Average best run-up (Maximum Favorable Excursion) per signal">Avg peak <b>+${hl.avgMfe}%</b></span>${heatSpans}</div>` : '';
    // Liquidity split (#4 "performance by liquidity"): the SAME edge, broken out by the
    // pick's liquidity tier — does it survive in liquid, tradeable names or only in the
    // illiquid, cost-eaten tail? Only shown when ≥2 tiers have resolved picks (else the
    // split is just the headline). Uses the same headline horizon as the card.
    const LIQ_LABEL = { liquid: 'Large / liquid', small: 'Small-cap', micro: 'Micro-cap', biotech: 'Biotech' };
    const liqData = g.byLiquidity || {};
    const liqTiers = hzKey ? Object.keys(liqData).filter(lt => liqData[lt][hzKey] && liqData[lt][hzKey].n) : [];
    const liq = liqTiers.length >= 2
      ? `<details class="sb-liq"><summary title="The same signal, split by the pick's liquidity bucket. An edge that only shows up in micro-caps is largely eaten by spread/slippage — see the cost-adjusted 'net' line.">💧 By liquidity <span class="dt-dim">· ${esc(hzLabel)}</span></summary><div class="sb-liq-body">${liqTiers.map(lt => {
          const s = liqData[lt][hzKey]; const up = s.avg >= 0;
          return `<div class="sb-liq-row"><span class="sb-liq-nm">${LIQ_LABEL[lt] || esc(lt)}</span><span class="sb-liq-v ${up ? 'up' : 'down'}">${up ? '+' : ''}${s.avg}%</span><span class="sb-liq-sub dt-dim">${s.winRate}% win · n=${s.n}${s.avgExcess != null ? ` · vs S&amp;P ${s.avgExcess > 0 ? '+' : ''}${s.avgExcess}%` : ''}</span></div>`;
        }).join('')}</div></details>`
      : '';
    // Concentration check (#4 "results excluding the largest winners"): the mean with the
    // top winners dropped. If it collapses vs the headline avg, a few lottery winners were
    // carrying it — not a repeatable edge.
    const exWin = (hl && hl.avgExTopWinners != null && hl.exTopN > 0 && hl.avg != null)
      ? `<div class="sb-exwin" title="Mean forward return with the ${hl.exTopN} biggest winner(s) removed. If it falls toward or below 0 while the headline average is positive, the edge was a handful of outliers, not a process.">✂️ Ex top-${hl.exTopN}: <b class="${hl.avgExTopWinners >= 0 ? 'win' : 'loss'}">${hl.avgExTopWinners > 0 ? '+' : ''}${hl.avgExTopWinners}%</b> <span class="dt-dim">vs ${hl.avg > 0 ? '+' : ''}${hl.avg}% avg</span></div>`
      : '';
    // Per-SECTOR split (#4) — is the edge broad or concentrated in one hot sector?
    const secData = g.bySector || {};
    const secKeys = hzKey ? Object.keys(secData).filter(s => secData[s][hzKey] && secData[s][hzKey].n) : [];
    const sector = secKeys.length >= 2
      ? `<details class="sb-liq"><summary title="The same signal split by the pick's GICS sector — a broad edge holds across sectors; a narrow one lives in one.">🏦 By sector <span class="dt-dim">· ${esc(hzLabel)}</span></summary><div class="sb-liq-body">${secKeys
          .sort((a, b) => secData[b][hzKey].avg - secData[a][hzKey].avg)
          .map(sc => { const s = secData[sc][hzKey]; const up = s.avg >= 0;
            return `<div class="sb-liq-row"><span class="sb-liq-nm">${esc(sc)}</span><span class="sb-liq-v ${up ? 'up' : 'down'}">${up ? '+' : ''}${s.avg}%</span><span class="sb-liq-sub dt-dim">${s.winRate}% win · n=${s.n}</span></div>`;
          }).join('')}</div></details>`
      : '';
    const bwBadge = (hl && hl.big10 >= 30) ? `<span class="sb-bwbadge" title="${hl.big10}% of signals reached +10% — a big-winner model">🚀 Big-winner ${hl.big10}%</span>` : '';
    // STRATEGY efficacy (distinct from the return horizons, which measure whether the
    // stock MOVED): did the pick's published entry/stop/target actually capture it —
    // target reached before the stop, at the levels shown on the card. Only shown for
    // sleeves that logged levels (e.g. Ghost). PF>1 & target-first>50% = the plan works.
    const st = g.strategy;
    const strat = (st && st.n) ? `<div class="sb-strat" title="STRATEGY efficacy — resolving each pick at its OWN logged entry/stop/target (target-before-stop, hold ≤63 sessions). 'Target-first' is the plan's real win rate; PF = gross target-R ÷ gross stop-R. This is 'could the published trade capture it', separate from 'did the stock move' above.">🎯 Plan: <b class="${st.targetFirstRate >= 50 ? 'win' : 'loss'}">${st.targetFirstRate}%</b> hit target first · 🛑 ${st.stopFirstRate}% stopped · PF <b class="${st.profitFactor != null && st.profitFactor >= 1 ? 'win' : 'loss'}">${st.profitFactor != null ? st.profitFactor : '∞'}</b> <span class="sb-strat-n">n=${st.n}</span></div>` : '';
    return `<div class="sb-card ${v.cls === 'pos' ? 'pos' : v.cls === 'neg' ? 'neg' : ''} ${disabled ? 'disabled' : ''}">
        <div class="sb-head">
          <span class="sb-exp ${v.cls}">${v.label}${v.val != null ? ` ${v.val > 0 ? '+' : ''}${v.val}%` : ''}</span>
          <div class="sb-title"><div class="sb-sig">${SB_TIER_LABEL[g.tier] || esc(g.tier)}${bwBadge}</div></div>
          <button class="sb-toggle ${disabled ? 'off' : 'on'}" data-sig-toggle="${g.section}:${g.tier}">${disabled ? '✕ Disabled' : '✓ Enabled'}</button>
        </div>
        <div class="sb-count">${regCount} pick${regCount === 1 ? '' : 's'} logged${sbRegime === 'all' ? '' : ` in ${sbRegime === 'risk-on' ? 'risk-on' : 'risk-off'}`} ${thin}${sbModelChip(g.section)}</div>
        <div class="sb-horizons">${hz}</div>
        ${wl}
        ${exWin}
        ${bw}
        ${strat}
        ${liq}
        ${sector}
      </div>`;
  }

  // Cross-sleeve allocation panel — inverse-vol (risk-parity) blend of the app's edge
  // sleeves. Framed as RISK REDUCTION (research Round 4/S3: it cuts vol & drawdown at
  // ~equal Sharpe; it is NOT an alpha booster). Server does the math in lib/allocation.js.
  function allocationPanelHTML(a) {
    if (!a) return '';
    if (a.status === 'accruing') {
      const have = (a.sleeves || []).length, om = a.overlapMonths || 0;
      return `<div class="rot-panel" style="border-color:#8a6dff55;background:#8a6dff0d">
        <div class="rot-head" style="color:#8a6dff">🧩 Cross-Sleeve Allocation <span class="dt-dim">(risk reduction)</span></div>
        <div class="rot-sub">Blends the app's edge sleeves into one inverse-vol (risk-parity) book to <b>reduce volatility &amp; drawdown</b> — a risk tool, not an alpha booster. <b>Accruing:</b> need ≥${a.need.sleeves} sleeves × ${a.need.months} overlapping months; have ${have} sleeve${have === 1 ? '' : 's'}, ${om} overlapping month${om === 1 ? '' : 's'}. Fills in as the ledgers mature.</div>
      </div>`;
    }
    if (a.status !== 'ok') return '';
    const rr = a.riskReduction || {};
    const ca = a.cashAware || null;
    const gov = a.governance || null;
    const GOV_ICON = { production: '🟢', reduced: '🔵', probation: '🟠', paper: '⚪', disabled: '⛔', retired: '🗄️' };
    const bar = s => `<div class="sb-alloc-row">
        <span class="sb-alloc-nm">${esc(s.name)}</span>
        <span class="sb-alloc-track"><span class="sb-alloc-fill" style="width:${Math.max(2, s.weight)}%"></span></span>
        <span class="sb-alloc-w"><b>${s.weight}%</b></span>
        <span class="sb-alloc-meta dt-dim">vol ${s.volAnn}% · Sharpe ${s.sharpe == null ? '—' : s.sharpe} · maxDD ${s.maxDD}% · ${s.months}mo${s.turnoverPerMonth != null ? ` · ~${s.turnoverPerMonth} picks/mo` : ''}</span>
      </div>`;
    const corrs = (a.correlations || []).map(c => `${esc(c.a)}↔${esc(c.b)} ${c.corr >= 0 ? '+' : ''}${c.corr}`).join(' · ');
    const b = a.blended || {};
    const divTxt = rr.diversificationRatio != null
      ? `diversification ratio <b>${rr.diversificationRatio}×</b>${rr.volVsWeightedAvg < 0 ? ` — cuts book vol by <b>${Math.abs(rr.volVsWeightedAvg)}%</b> vs the components` : ''}`
      : '';
    return `<div class="rot-panel" style="border-color:#8a6dff55;background:#8a6dff0d">
      <div class="rot-head" style="color:#8a6dff">🧩 Cross-Sleeve Allocation <span class="dt-dim">(risk reduction · inverse-vol)</span></div>
      <div class="rot-sub" style="margin-bottom:8px">${esc(a.note || '')}</div>
      <div class="sb-alloc">${a.sleeves.map(bar).join('')}</div>
      <div class="sb-alloc-blend">📉 <b>Blended book:</b> vol <b>${b.volAnn}%</b> · maxDD <b>${b.maxDD}%</b> · Sharpe <b>${b.sharpe == null ? '—' : b.sharpe}</b> &nbsp;·&nbsp; ${divTxt}</div>
      ${ca ? `<div class="sb-alloc-cash" title="Only sleeves with positive expected return in-window get capital; the rest is held as CASH rather than force-deployed. Sit-out = nothing clears the bar. Gross expectancy; costs would raise it.">${ca.sitOut ? '🛑' : '💵'} <b>Cash-when-thin:</b> ${ca.sitOut ? 'sit out — hold <b>100% cash</b> (no sleeve has positive expectancy in-window)' : `fund ${ca.deployed.filter(d => d.funded).map(d => esc(d.name) + ' ' + d.weight + '%').join(' · ') || '—'} · hold <b>${ca.cashWeight}% cash</b>`}</div>` : ''}
      ${gov && gov.applied ? `<div class="sb-alloc-gov" title="Each sleeve's deployed capital is capped by its model-governance status (Production 100% · Reduced 50% · Probation 25% · Paper/Disabled/Retired 0%). Applied after cash-when-thin; freed capital is held as cash, never reallocated — governance can only cut size.">🏛️ <b>Governed deploy:</b> ${gov.sitOut ? 'hold <b>100% cash</b> — no sleeve\'s model holds clearance to size' : `${gov.deployed.filter(d => d.deployedWeight > 0).map(d => `${GOV_ICON[d.status] || '·'} ${esc(d.name)} <b>${d.deployedWeight}%</b>${d.haircut > 0 ? ` <span class="dt-dim">(cut ${d.haircut} · ${esc(d.status || '')})</span>` : ''}`).join(' · ') || '—'} · hold <b>${gov.cashWeight}% cash</b>`}</div>` : ''}
      ${corrs ? `<div class="sb-alloc-corr dt-dim">correlations: ${corrs}</div>` : ''}
      <div class="sb-alloc-corr dt-dim">weights = inverse-vol (risk parity) over ${a.overlapMonths} overlapping months (${esc((a.window || [])[0] || '')}…${esc((a.window || [])[1] || '')}). Leans toward the lower-vol, validated event sleeve. Illustrative — see research caveats (small sample; blending buys smoothness, not Sharpe).</div>
    </div>`;
  }

  let sbBySection = {}, sbScoreHz = '5d';   // per-section score-decile verdict for the card chips
  function renderScoreboard(data) {
    sbBySection = (data.scoreQuality && data.scoreQuality.bySection) || {};
    sbScoreHz = (data.scoreQuality && data.scoreQuality.horizon) || '5d';
    if (data.generatedAt) scoreboardGenTime.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
    if (!data.configured) {
      scoreboardMeta.textContent = '· storage not configured';
      scoreboardContainer.innerHTML = `<div class="sb-empty">📦 <b>Pick tracking isn't enabled yet.</b><br>Create a <b>Vercel Blob</b> store for this project (Storage → Blob in the dashboard), then redeploy. Picks log daily and the scoreboard fills in as returns mature — 1 week, then 1 month, then 3 months.</div>`;
      return;
    }
    scoreboardMeta.textContent = `· ${data.totalPicks || 0} signals tracked (first appearance)${data.loggedRows ? ` · ${data.loggedRows} daily rows` : ''} · realized forward returns`;
    if (!data.groups || !data.groups.length) {
      scoreboardContainer.innerHTML = `<div class="sb-empty">No picks logged yet. The daily cron snapshots Screener &amp; Momentum picks — check back after the next run.</div>`;
      return;
    }

    const intro = `<div class="sb-intro">Every ticker the Screener and Momentum sections surface is logged daily with its entry price; each signal is scored on its <b>first appearance</b> (so names that linger aren't over-counted). Figures below are <b>realized</b> from price history. <b>Expectancy</b> = average return per pick (Strong Sell is inverted, so positive = a profitable short). The <b>🚀 big-winner row</b> shows how often a signal's best run-up reached +10% / +20% before the horizon (and its average peak) — separating models that catch large moves from steady grinders. Disable a negative-expectancy signal to hide it from its section — it keeps being tracked so you can re-enable it if it recovers.</div>`;

    // Regime filter — only shown when the server could build the macro split.
    const regimeBar = data.regimeSplit
      ? `<div class="sb-regime-bar">
          <label class="sb-regime-lb" for="sb-regime-sel">📊 Market regime</label>
          <select id="sb-regime-sel" class="sb-regime-sel">${SB_REGIMES.map(([v, lb]) => `<option value="${v}"${v === sbRegime ? ' selected' : ''}>${lb}</option>`).join('')}</select>
          <span class="sb-regime-note">${sbRegime === 'all'
            ? 'Win-rates &amp; returns across every market. Switch to a regime to see which engines actually earn in bull vs. bear tapes — the one lever this project\'s backtests validated.'
            : `Showing only picks triggered in a <b>${sbRegime === 'risk-on' ? 'risk-on (bull)' : 'risk-off (bear)'}</b> macro tape (VIX + credit-spread read at the trigger date).`}</span>
        </div>`
      : '';

    if (typeof ensureMaturityMap === 'function') ensureMaturityMap();
    const bySec = {};
    data.groups.forEach(g => { (bySec[g.section] = bySec[g.section] || []).push(g); });
    const secBadge = sec => (maturityMap && maturityMap[sec]) ? ' ' + matBadge(maturityMap[sec].grade, maturityMap[sec].meta) : '';
    const html = Object.keys(bySec).map(sec =>
      `<div class="sb-secgroup"><div class="sb-secgroup-h"${SB_SECTION_HELP[sec] ? ` title="${esc(SB_SECTION_HELP[sec])}"` : ''}>${SB_SECTIONS[sec] || esc(sec)}${secBadge(sec)}${SB_SECTION_HELP[sec] ? ' <span class="sb-help-i" title="' + esc(SB_SECTION_HELP[sec]) + '">ⓘ</span>' : ''}</div><div class="sb-grid">${bySec[sec].map(sbCard).join('')}</div></div>`
    ).join('');

    scoreboardContainer.innerHTML = intro + allocationPanelHTML(data.allocation) + scoreDecilePanel(data.scoreQuality) + `<div id="sb-rankquality"></div><div id="sb-leadtime"></div><div id="sb-failure"></div><div id="sb-complab"></div>` + regimeBar + html;
    const regimeSel = document.getElementById('sb-regime-sel');
    if (regimeSel) regimeSel.addEventListener('change', e => setSbRegime(e.target.value));
    scoreboardContainer.querySelectorAll('[data-sig-toggle]').forEach(btn => {
      btn.addEventListener('click', () => { const [s, t] = btn.dataset.sigToggle.split(':'); toggleSignal(s, t); });
    });
    loadRankQuality();  // #5 — does a higher score actually win? (lazy, own endpoint)
    loadLeadTime();     // §7 — does each algorithm find moves EARLY enough to be useful? (lazy)
    loadFailureModel(); // §5 — does the shadow failure model actually predict failure? (lazy)
    loadComponentLab(); // §2 — which components ADD value after matching on confounders? (lazy)
  }

  // ── 🎯 RANKING QUALITY (#5) — validate that higher scores produce better outcomes.
  // Reads op=rankquality (decile perf, rank-IC, top-K precision, lift, calibration/
  // Brier, verdict) over the resolved Apex ledger. Honest: says "building" until the
  // sample matures, and shows "noise"/"inverted" verdicts plainly.
  const RQ_VERDICT = {
    predictive: ['✅', 'var(--green)', 'Predictive — higher scores really do win'],
    'weak-positive': ['🟡', 'var(--amber,#f59e0b)', 'Weakly positive — a mild edge, not yet significant'],
    noise: ['⚪', 'var(--text-dim)', 'No signal — score does not separate winners from losers'],
    inverted: ['🔻', 'var(--red)', 'Inverted — higher scores did WORSE (a red flag)'],
    insufficient: ['⏳', 'var(--text-dim)', 'Not enough resolved picks yet'],
  };
  function rqBar(b, maxAbs) {
    const w = maxAbs > 0 ? Math.min(100, Math.abs(b.avgOutcome) / maxAbs * 100) : 0;
    const col = b.avgOutcome >= 0 ? 'var(--green)' : 'var(--red)';
    return `<div class="rq-row"><span class="rq-band" title="Score ${b.scoreLo}–${b.scoreHi}">Q${b.bucket} <span class="dt-dim">(${b.scoreLo}–${b.scoreHi})</span></span>`
      + `<span class="rq-track"><span class="rq-fill" style="width:${w}%;background:${col}"></span></span>`
      + `<span class="rq-val" style="color:${col}">${b.avgOutcome > 0 ? '+' : ''}${b.avgOutcome}</span><span class="rq-wr">${b.winRate}% · n${b.n}</span></div>`;
  }
  // Calibration curve (#4 "calibration") — the binned table the backend already computes,
  // finally drawn. For each score band (treated as an implied win-probability) it shows the
  // ACTUAL realized win rate. Close = the score is calibrated; far apart = the score is a
  // relative RANK, not a probability (which the app states everywhere).
  function calibrationHTML(cal) {
    if (!cal || !Array.isArray(cal.table) || cal.table.length < 2) return '';
    const rows = cal.table.map(t => {
      const gap = Math.abs((t.predicted ?? 0) - (t.actual ?? 0));
      const col = gap <= 10 ? 'var(--green)' : gap <= 20 ? 'var(--amber,#f59e0b)' : 'var(--red)';
      return `<div class="cal-row"><span class="cal-band" title="Score band ${esc(t.band)}">${esc(t.band)}</span>`
        + `<span class="cal-track"><span class="cal-act" style="width:${Math.max(0, Math.min(100, t.actual))}%;background:${col}"></span>`
        + `<span class="cal-tick" style="left:${Math.max(0, Math.min(100, t.predicted))}%" title="Score implies ${t.predicted}%"></span></span>`
        + `<span class="cal-val">pred <b>${t.predicted}%</b> → act <b style="color:${col}">${t.actual}%</b> <span class="dt-dim">n${t.n}</span></span></div>`;
    }).join('');
    return `<details class="rq-cal"><summary>📈 Calibration — does a score translate to that win rate? <span class="dt-dim">Brier ${cal.brier ?? '—'}</span></summary>`
      + `<div class="rq-cal-body"><div class="dt-dim rq-cap">Bar = ACTUAL win rate; the tick = the score's implied probability. Aligned = calibrated; far apart = the score is a rank, not a probability.</div>${rows}</div></details>`;
  }
  function rankQualityPanel(rq) {
    if (!rq || !rq.ok) return '';
    const o = rq.overall || {};
    if (!o.ready) return `<div class="sb-secgroup"><div class="sb-secgroup-h">🎯 Ranking quality — do higher scores win?</div><div class="dt-note">⏳ ${esc(o.note || 'Building — needs more resolved scored picks.')} This validates that the model's score actually predicts outcomes; it fills in as the Apex ledger matures.</div></div>`;
    const [vi, vcol, vtxt] = RQ_VERDICT[o.verdict] || RQ_VERDICT.insufficient;
    const maxAbs = Math.max(...o.buckets.map(b => Math.abs(b.avgOutcome)), 0.01);
    const ic = o.ic || {};
    const cal = o.calibration || {};
    const regimes = Object.entries(rq.byRegime || {}).filter(([, v]) => v.ready)
      .map(([k, v]) => `${k.replace('_', '-').toLowerCase()}: IC ${v.ic.ic ?? '—'} (${v.verdict})`).join(' · ');
    return `<div class="sb-secgroup rq-panel">`
      + `<div class="sb-secgroup-h">🎯 Ranking quality — do higher scores win? <span class="dt-dim">· Apex ledger, ${rq.resolvedCount} resolved</span></div>`
      + `<div class="rq-verdict" style="border-left-color:${vcol}"><b style="color:${vcol}">${vi} ${esc(vtxt)}.</b> `
      + `Rank-IC <b>${ic.ic ?? '—'}</b> (t=${ic.t ?? '—'}, ${ic.significant ? 'significant' : 'not significant'}) · top decile beat base win-rate by <b>${o.liftWinRate ?? '—'}pts</b> · top-vs-bottom spread <b>${o.topBottomSpread ?? '—'}</b> · top-${o.topKn} precision <b>${o.topKprecision}%</b> · Brier ${cal.brier ?? '—'}.</div>`
      + `<div class="rq-bars"><div class="dt-dim rq-cap">Avg outcome (realized R×100) by score quantile — a predictive score slopes up left→right:</div>${o.buckets.map(b => rqBar(b, maxAbs)).join('')}</div>`
      + calibrationHTML(cal)
      + (regimes ? `<div class="dt-dim rq-reg">By regime → ${esc(regimes)}</div>` : '')
      + `<div class="dt-dim rq-foot">Outcome = realized R-multiple at each pick's logged stop/target. Verdict "predictive" needs a positive, statistically-significant rank-IC AND a monotone quantile ladder — the same bar this project holds every claimed edge to.</div>`
      + `</div>`;
  }

  // 🏅 SCORE DECILE (#4 "performance by score decile") — the WHOLE-BOOK version of the
  // ranking-quality check. Every pick, regardless of section, carries a single UNIFORM
  // momentum-conviction score (uscore-v1, computed server-side in the scoreboard payload);
  // this buckets all of them by decile and asks whether higher conviction earned better
  // 20-session returns. Reuses rqBar + the rank-IC/verdict battery. Reads data.scoreQuality
  // directly (no extra endpoint) — so it's honest about "building" until ≥20 resolve.
  // Per-section decile breakdown — does EACH section's own scorer rank its own winners?
  // A compact row per section (verdict · rank-IC · top-vs-bottom spread · n), each
  // expandable to its own decile ladder. Sorted best-separating (highest rank-IC) first.
  function scoreBySectionHTML(bySection, hLbl) {
    const rows = Object.entries(bySection || {}).filter(([, v]) => v && v.ready);
    if (!rows.length) return '';
    rows.sort((a, b) => (b[1].ic?.ic ?? -99) - (a[1].ic?.ic ?? -99));
    const one = ([sec, v]) => {
      const [vi, vcol, vtxt] = RQ_VERDICT[v.verdict] || RQ_VERDICT.insufficient;
      const label = SB_SECTIONS[sec] || sec;
      const ic = v.ic || {};
      const maxAbs = Math.max(...(v.buckets || []).map(b => Math.abs(b.avgOutcome)), 0.01);
      const bars = (v.buckets || []).map(b => rqBar(b, maxAbs)).join('');
      return `<details class="rq-sec"><summary>`
        + `<span class="rq-sec-v" style="color:${vcol}">${vi}</span>`
        + `<span class="rq-sec-nm">${esc(label)}</span>`
        + `<span class="rq-sec-m dt-dim">${esc(v.method)}</span>`
        + `<span class="rq-sec-ic" title="Spearman rank-IC — does higher conviction rank better returns?">IC <b style="color:${vcol}">${ic.ic ?? '—'}</b></span>`
        + `<span class="rq-sec-sp dt-dim">spread ${v.topBottomSpread ?? '—'}%</span>`
        + `<span class="rq-sec-n dt-dim">n=${v.n}</span>`
        + `</summary><div class="rq-sec-body"><div class="dt-dim rq-cap">Avg ${esc(hLbl)} return (%) by ${esc(v.method)} conviction decile:</div>${bars}</div></details>`;
    };
    return `<div class="rq-bysec"><div class="dt-dim rq-cap rq-bysec-h">Per section — does each model rank its OWN winners? <span class="dt-dim">(best-separating first; click to expand)</span></div>${rows.map(one).join('')}</div>`;
  }

  function scoreDecilePanel(sq) {
    if (!sq) return '';
    const o = sq.overall || {};
    const mm = sq.methodMix || {};
    const mix = [['apex', 'Apex'], ['ghost', 'Ghost'], ['momentum', 'Momentum'], ['daytrade', 'DayTrade'], ['coil', 'Coil'], ['proxy', 'proxy']].filter(([k]) => mm[k]).map(([k, lb]) => `${lb} ${mm[k]}`).join(' · ');
    const hLbl = String(sq.horizon || '5d').replace(/^(\d+)d$/, '$1-session').replace(/^1m$/, '1-month').replace(/^3m$/, '3-month');
    const head = `🏅 Score decile — do higher-conviction picks win? <span class="dt-dim">· per-section ${esc(sq.model || '')} · ${sq.scoredPicks || 0} scored${mix ? ` · ${esc(mix)}` : ''} · ${esc(sq.horizon || '')} outcome</span>`;
    if (!o.ready) return `<div class="sb-secgroup"><div class="sb-secgroup-h">${head}</div><div class="dt-note">⏳ ${esc(o.note || 'Building')} Every pick is scored by <b>its own section's real model</b> reconstructed point-in-time (Breakout→Apex 4-pillar, Ghost→Ghost 6-pillar, Momentum→EMA/VWAP/MACD/RSI composite, Day-Trade→relVol/gap ranker, Coil→Bollinger-squeeze rank; the rest fall back to a tagged momentum proxy), normalized within section, then bucketed by decile. Fills in as picks resolve their ${esc(hLbl)} return.</div></div>`;
    const [vi, vcol, vtxt] = RQ_VERDICT[o.verdict] || RQ_VERDICT.insufficient;
    const maxAbs = Math.max(...o.buckets.map(b => Math.abs(b.avgOutcome)), 0.01);
    const ic = o.ic || {};
    const regimes = Object.entries(sq.byRegime || {}).filter(([, v]) => v.ready)
      .map(([k, v]) => `${esc(k)}: IC ${v.ic.ic ?? '—'} (${esc(v.verdict)})`).join(' · ');
    return `<div class="sb-secgroup rq-panel">`
      + `<div class="sb-secgroup-h">${head}</div>`
      + `<div class="rq-verdict" style="border-left-color:${vcol}"><b style="color:${vcol}">${vi} ${esc(vtxt)}.</b> `
      + `Rank-IC <b>${ic.ic ?? '—'}</b> (t=${ic.t ?? '—'}, ${ic.significant ? 'significant' : 'not significant'}) · top decile beat base win-rate by <b>${o.liftWinRate ?? '—'}pts</b> · top-vs-bottom spread <b>${o.topBottomSpread ?? '—'}%</b> · top-${o.topKn} precision <b>${o.topKprecision}%</b>.</div>`
      + `<div class="rq-bars"><div class="dt-dim rq-cap">Avg ${esc(hLbl)} return (%) by within-section conviction decile — a predictive score slopes up left→right:</div>${o.buckets.map(b => rqBar(b, maxAbs)).join('')}</div>`
      + scoreBySectionHTML(sq.bySection, hLbl)
      + (regimes ? `<div class="dt-dim rq-reg">By regime → ${esc(regimes)}</div>` : '')
      + `<div class="dt-dim rq-foot">Each pick is scored by <b>its own section's real model</b> reconstructed from point-in-time candles (Breakout→Apex, Ghost→Ghost, Momentum→EMA/VWAP/MACD/RSI, Day-Trade→relVol/gap ranker, Coil→Bollinger-squeeze rank; the rest use a tagged momentum proxy), then ranked <b>within its section</b> so scores from different models compare as "top of their own model". It's a conviction RANK, not a probability. "Predictive" needs a positive, significant rank-IC AND a monotone ladder — the bar every edge here is held to. Caveat: pct-based scorers (Apex/Ghost) percentile-rank across the logged-pick cohort, not the full daily universe, so absolute scores differ from live.</div>`
      + `</div>`;
  }
  // Shared lazy-panel loader for the Scoreboard's own-endpoint panels. Fixes a re-render race:
  // renderScoreboard runs again on a regime toggle / maturity restamp and rebuilds the panel
  // divs, so the loader must (a) re-show the spinner into the CURRENT host on every call while a
  // fetch is in flight — never early-return to a blank div — and (b) write the result to the host
  // re-queried at completion time, not a host captured before an intervening re-render detached it.
  const _panelState = {}; // id → { loading, data }
  const _panelErr = `<div class="sb-secgroup"><div class="dt-note" style="border-left-color:var(--red)">Couldn't load this panel right now — the ranking is unaffected.</div></div>`;
  async function loadLazyPanel(id, url, render, spinner) {
    const set = (html) => { const h = document.getElementById(id); if (h) h.innerHTML = html; };
    const st = _panelState[id] || (_panelState[id] = {});
    if (st.data !== undefined) { set(render(st.data)); return; }
    set(spinner);                 // always (re)show the spinner into the current host
    if (st.loading) return;       // a fetch is already in flight; the spinner is showing
    st.loading = true;
    try { const d = await fetch(url).then(r => r.json()); st.data = d; set(render(d)); }
    catch { set(_panelErr); } finally { st.loading = false; }
  }
  const rqSpinner = `<div class="sb-secgroup"><div class="sb-secgroup-h">🎯 Ranking quality — do higher scores win?</div><div class="mom-status"><div class="mom-spinner"></div><p>Checking whether higher scores actually produce better outcomes…</p></div></div>`;
  const loadRankQuality = () => loadLazyPanel('sb-rankquality', '/api/tracker?op=rankquality', rankQualityPanel, rqSpinner);

  // ── ⏱ EARLY DETECTION (§7) — does each algorithm find moves EARLY enough to be useful?
  // Reads op=leadtime (days-before-breakout, share of the move captured before confirmation,
  // false-early rate, capital efficiency) over the SAME first-appearance ledgers the Scoreboard
  // resolves. Honest by construction: a screener is "early" ONLY if its signals also convert
  // and the wait is tradeable — being first is not enough (the acceptance rule is in the model).
  const LT_VERDICT = {
    'genuinely-early': ['🟢', 'var(--green)', 'Genuinely early — finds moves before they break out AND they convert'],
    'low-conversion': ['🔻', 'var(--red)', 'Fires early but few signals become real moves'],
    'late-detector': ['🟡', 'var(--amber,#f59e0b)', 'By the time it fires the move is mostly done'],
    'slow-to-pay': ['⏳', 'var(--amber,#f59e0b)', 'Converts, but the wait ties up capital too long'],
    insufficient: ['⚪', 'var(--text-dim)', 'Not enough resolved picks yet'],
  };
  function ltAlgoRow(a) {
    const [vi, vcol, vtxt] = LT_VERDICT[a.verdict] || LT_VERDICT.insufficient;
    const wait = a.medianDaysToBreakout == null ? '—' : `${a.medianDaysToBreakout}d`;
    const share = a.medianEarlyShare == null ? '—' : `${Math.round(a.medianEarlyShare * 100)}%`;
    const conv = `${Math.round(a.breakoutRate * 100)}%`;
    return `<div class="lt-row" title="${esc(vtxt)}">`
      + `<span class="lt-v" style="color:${vcol}">${vi}</span>`
      + `<span class="lt-nm">${esc(a.key)}</span>`
      + `<span class="lt-m" title="Median trading days from detection to the +move breakout marker (among names that converted)">⏱ ${wait}</span>`
      + `<span class="lt-m" title="Share of the eventual move captured BEFORE the breakout — the value of being early">🎯 ${share}</span>`
      + `<span class="lt-m" title="Conversion: share of early signals that reached a real move (1 − false-early rate)">✅ ${conv}</span>`
      + `<span class="lt-m dt-dim" title="Median forward return from detection to window end">${a.medianResolved == null ? '' : (a.medianResolved > 0 ? '+' : '') + a.medianResolved + '%'}</span>`
      + `<span class="lt-n dt-dim">n=${a.n}</span></div>`;
  }
  function leadTimePanel(lt) {
    if (!lt || !lt.ok) return `<div class="sb-secgroup"><div class="dt-note" style="border-left-color:var(--red)">Couldn't load the early-detection check.</div></div>`;
    const algos = (lt.algorithms || []).filter(a => a.n > 0);
    if (!algos.length) return `<div class="sb-secgroup rq-panel"><div class="sb-secgroup-h">⏱ Early detection — does each algorithm find moves early?</div><div class="dt-dim">No resolvable first-appearance picks yet — this fills in as the ledgers mature.</div></div>`;
    const lb = lt.leaderboard || {};
    const leaderLine = (icon, label, key) => key ? `<span class="lt-lead"><b>${icon} ${label}</b> ${esc(key)}</span>` : '';
    const leaders = [
      leaderLine('🥇', 'Earliest', lb.earliestDetector),
      leaderLine('🎯', 'Most captured early', lb.bestMoveCaptured),
      leaderLine('📈', 'Best post-entry', lb.bestPostEntryReturn),
      leaderLine('⚡', 'Best capital efficiency', lb.bestCapitalEfficiency),
      leaderLine('🛡', 'Lowest false-early', lb.lowestFalseEarly),
    ].filter(Boolean).join('');
    return `<div class="sb-secgroup rq-panel lt-panel">`
      + `<div class="sb-secgroup-h">⏱ Early detection — does each algorithm find moves early <span class="dt-dim">enough to be useful?</span></div>`
      + `<div class="dt-dim rq-cap">Earliness measured against an objective +${lt.config.BREAKOUT_PCT}% breakout marker within ${lt.config.WINDOW} bars. A screener is "early" only if its signals also CONVERT (✅) and the wait (⏱) is tradeable — being first is not enough.</div>`
      + (leaders ? `<div class="lt-leaders">${leaders}</div>` : '')
      + `<div class="lt-rows">${algos.map(ltAlgoRow).join('')}</div>`
      + `<div class="dt-dim rq-foot">🎯 = share of the eventual move captured before confirmation (the payoff for earliness). ✅ = conversion rate. A high ⏱ with low ✅ is a screener that fires into names that never move. Same first-appearance ledgers and point-in-time candles as the Scoreboard above.</div>`
      + `</div>`;
  }
  const ltSpinner = `<div class="sb-secgroup"><div class="sb-secgroup-h">⏱ Early detection — does each algorithm find moves early?</div><div class="mom-status"><div class="mom-spinner"></div><p>Measuring how early each algorithm detects moves…</p></div></div>`;
  const loadLeadTime = () => loadLazyPanel('sb-leadtime', '/api/tracker?op=leadtime', leadTimePanel, ltSpinner);

  // ── 🛡 ADVERSARIAL FAILURE MODEL (§5) — a SHADOW model that flags likely-to-fail setups.
  // Reads op=failuremodel: replays the candle-derivable failure features point-in-time over the
  // resolved ledger and asks whether the names it REJECTS underperform the ones it APPROVES.
  // Honest by construction — it stays shadow (never binds) unless 'predictive'.
  const FMV = {
    predictive: ['✅', 'var(--green)', 'Predictive — rejected names really did underperform (could bind)'],
    'no-signal': ['⚪', 'var(--text-dim)', 'No signal — the failure split does not separate outcomes; stays shadow'],
    inverted: ['🔻', 'var(--red)', 'Inverted — "failure" flags marked winners here; stays shadow'],
    insufficient: ['⏳', 'var(--text-dim)', 'Not enough resolved picks in both buckets yet'],
  };
  function fmBucket(label, b, cls) {
    if (!b || !b.n) return '';
    const ret = b.meanReturn == null ? '—' : (b.meanReturn > 0 ? '+' : '') + b.meanReturn + '%';
    return `<div class="lt-row"><span class="lt-nm ${cls}">${esc(label)}</span>`
      + `<span class="lt-m" title="Mean forward return over the eval window">ret <b>${ret}</b></span>`
      + `<span class="lt-m dt-dim">win ${b.winRate == null ? '—' : b.winRate + '%'}</span>`
      + (b.meanExcess != null ? `<span class="lt-m dt-dim">vs mkt ${b.meanExcess > 0 ? '+' : ''}${b.meanExcess}%</span>` : '')
      + `<span class="lt-n dt-dim">n=${b.n}</span></div>`;
  }
  function failureModelPanel(fm) {
    if (!fm || !fm.ok) return `<div class="sb-secgroup"><div class="dt-note" style="border-left-color:var(--red)">Couldn't load the failure-model check.</div></div>`;
    let [vi, vcol, vtxt] = FMV[fm.verdict] || FMV.insufficient;
    // A predictive verdict that is NOT promoted is honestly "promising but still shadow".
    if (fm.verdict === 'predictive' && !fm.promoted) { vi = '🟡'; vcol = 'var(--amber,#f59e0b)'; vtxt = 'Predictive on this window — but held in SHADOW pending multi-regime confirmation'; }
    const b = fm.buckets || {};
    const gap = fm.predictiveGap == null ? '' : `<div class="dt-dim rq-cap">Approved − rejected forward-return gap: <b style="color:${fm.predictiveGap > 0 ? 'var(--green)' : 'var(--red)'}">${fm.predictiveGap > 0 ? '+' : ''}${fm.predictiveGap}%</b> (positive = the model's rejected names did worse).</div>`
      + (fm.promotionBlockedReason ? `<div class="dt-dim rq-cap">⏳ ${esc(fm.promotionBlockedReason)}</div>` : '');
    const modes = (fm.byMode || []).slice(0, 5).map(m => `<span class="lt-lead"><b>${esc(m.label)}</b> ${m.lossRate}% loss <span class="dt-dim">n${m.n}</span></span>`).join('');
    return `<div class="sb-secgroup rq-panel lt-panel">`
      + `<div class="sb-secgroup-h">🛡 Adversarial failure model <span class="dt-dim">— SHADOW: never changes the rank until it's proven</span></div>`
      + `<div class="rq-verdict" style="border-left-color:${vcol}"><b style="color:${vcol}">${vi} ${esc(vtxt)}.</b> ${esc(fm.note || '')}</div>`
      + gap
      + `<div class="lt-rows">${fmBucket('🔴 Rejected (highest failure score)', b.rejected, 'td-neg')}${fmBucket('🟡 Near threshold', b.nearThreshold, '')}${fmBucket('🟢 Approved (lowest failure score)', b.approved, 'td-pos')}</div>`
      + (modes ? `<div class="dt-dim rq-cap">Historical loss rate by failure mode:</div><div class="lt-leaders">${modes}</div>` : '')
      + `<div class="dt-dim rq-foot">Rejected/approved are the top/bottom third by failure score. Replays only the candle-derivable failure features (earnings/single-factor/track aren't in the ledger). ${fm.coverage ? `Evaluated ${fm.coverage.evaluated} resolved picks.` : ''}</div>`
      + `</div>`;
  }
  const fmSpinner = `<div class="sb-secgroup"><div class="sb-secgroup-h">🛡 Adversarial failure model (shadow)</div><div class="mom-status"><div class="mom-spinner"></div><p>Testing whether flagged setups actually underperform…</p></div></div>`;
  const loadFailureModel = () => loadLazyPanel('sb-failure', '/api/tracker?op=failuremodel', failureModelPanel, fmSpinner);

  // ── 🧪 COMPONENT LABORATORY (§2) — does each algorithm component ADD value beyond the rest
  // of the setup? Reads op=complab: a matched treated-vs-control study over the resolved ledger
  // (each component's names compared to the most similar names WITHOUT it), so a component reads
  // "additive" only if it beats comparable setups — not because component-present names did well.
  const CLV = {
    additive: ['✅', 'var(--green)', 'Additive', 'retain'],
    redundant: ['🔁', 'var(--text-dim)', 'Redundant', 'reduce'],
    harmful: ['🔻', 'var(--red)', 'Harmful', 'disable'],
    inconclusive: ['⚪', 'var(--text-dim)', 'Inconclusive', 'observe'],
    insufficient: ['⏳', 'var(--text-dim)', 'Insufficient data', 'observe'],
  };
  function clComponentRow(c) {
    const [vi, vcol, vlbl] = CLV[c.verdict] || CLV.insufficient;
    const incr = c.incrementalReturn == null ? '—' : (c.incrementalReturn > 0 ? '+' : '') + c.incrementalReturn + '%';
    const ci = c.ci ? ` <span class="dt-dim">CI [${c.ci[0]}, ${c.ci[1]}]</span>` : '';
    const naive = c.naiveDifference == null ? '' : `<span class="lt-m dt-dim" title="Raw with−without difference before matching. The gap vs the matched number is confounding the matching removed.">naive ${c.naiveDifference > 0 ? '+' : ''}${c.naiveDifference}%</span>`;
    return `<details class="cl-item"><summary class="lt-row" title="${esc(c.blurb || '')}">`
      + `<span class="lt-v" style="color:${vcol}">${vi}</span>`
      + `<span class="lt-nm">${esc(c.label)}</span>`
      + `<span class="lt-m" title="Matched incremental forward return (with − matched-without)">incr <b style="color:${vcol}">${incr}</b>${c.significant ? ' *' : ''}</span>`
      + naive
      + `<span class="lt-n dt-dim">${vlbl}${c.matchedPairs ? ' · ' + c.matchedPairs + ' pairs' : ''}</span>`
      + `</summary><div class="cl-body">`
      + (c.note ? `<div class="dt-dim rq-cap">${esc(c.note)}</div>` : '')
      + (c.ci ? `<div class="dt-dim rq-cap">Incremental ${incr}${ci}${c.significant ? ' — statistically significant' : ' — not significant'}. Recommendation: <b>${esc(c.recommendation || 'observe')}</b> (evidence only — nothing is auto-removed).</div>` : '')
      + (c.caveat ? `<div class="dt-dim rq-cap">⏳ ${esc(c.caveat)}</div>` : '')
      + (c.treatedGroup ? `<div class="dt-dim rq-cap">With: n${c.treatedGroup.n}, win ${c.treatedGroup.winRate}%, mean ${c.treatedGroup.meanReturn}% · Without: n${c.controlGroup.n}, win ${c.controlGroup.winRate}%, mean ${c.controlGroup.meanReturn}%</div>` : '')
      + (c.byRegime ? `<div class="dt-dim rq-cap">By regime: ${esc(Object.entries(c.byRegime).map(([k, v]) => `${k} ${v.incremental > 0 ? '+' : ''}${v.incremental}% (n${v.n})`).join(' · '))}</div>` : '')
      + (c.examples && c.examples.length ? `<div class="dt-dim rq-cap">Example matched pairs: ${esc(c.examples.map(e => `${e.treated.ticker} ${e.treated.date}(${e.treated.ret}%) ↔ ${e.control.ticker}(${e.control.ret}%)`).join(' · '))}</div>` : '')
      + `</div></details>`;
  }
  function componentLabPanel(cl) {
    if (!cl || !cl.ok) return `<div class="sb-secgroup"><div class="dt-note" style="border-left-color:var(--red)">Couldn't load the component laboratory.</div></div>`;
    const comps = cl.components || [];
    if (!comps.length) return `<div class="sb-secgroup rq-panel"><div class="sb-secgroup-h">🧪 Component laboratory</div><div class="dt-dim">No resolvable picks yet — fills in as the ledger matures.</div></div>`;
    const order = { additive: 0, harmful: 1, redundant: 2, inconclusive: 3, insufficient: 4 };
    const rows = comps.slice().sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9)).map(clComponentRow).join('');
    return `<div class="sb-secgroup rq-panel lt-panel">`
      + `<div class="sb-secgroup-h">🧪 Component laboratory <span class="dt-dim">— does each component ADD value, after matching?</span></div>`
      + `<div class="dt-dim rq-cap">Each component is measured against the most SIMILAR names without it (matched on regime, sector, prior return, liquidity). "Additive" = it beats comparable setups; "redundant" = the raw edge was really the confounders. ${cl.coverage ? `Over ${cl.coverage.records} resolved picks.` : ''} * = significant.</div>`
      + `<div class="lt-rows">${rows}</div>`
      + `<div class="dt-dim rq-foot">Nearest-neighbour matched treated-vs-control (${cl.window || 21}-bar forward return). Never auto-removes a feature — recommendations are evidence for a human decision.</div>`
      + `</div>`;
  }
  const clSpinner = `<div class="sb-secgroup"><div class="sb-secgroup-h">🧪 Component laboratory</div><div class="mom-status"><div class="mom-spinner"></div><p>Matching treated vs control to isolate what each component adds…</p></div></div>`;
  const loadComponentLab = () => loadLazyPanel('sb-complab', '/api/tracker?op=complab', componentLabPanel, clSpinner);

  scoreboardRefreshBtn.addEventListener('click', fetchScoreboard);
  fetchScoreboard();

  // ── Evidence & Maturity — the earned trust grade for every strategy ──────────
  // Grades come from op=maturity (lib/maturity): each class is graded on its own
  // resolved Scoreboard record. A shared badge is reused on the Scoreboard headers.
  const MAT_ORDER = ['validated', 'promising', 'experimental', 'informational', 'disabled'];
  let maturityData = null, maturityLoaded = false, maturityMap = null;

  function matBadge(grade, meta) {
    const m = (meta && meta[grade]) || { icon: '•', label: grade };
    return `<span class="mat-badge mat-${esc(grade)}" title="${esc(m.blurb || '')}">${m.icon} ${esc(m.label)}</span>`;
  }

  // Lazily fetch the grade map once; when it arrives, restamp a rendered Scoreboard.
  async function ensureMaturityMap() {
    if (maturityMap) return maturityMap;
    if (ensureMaturityMap._p) return ensureMaturityMap._p;
    ensureMaturityMap._p = (async () => {
      try {
        const d = await fetch('/api/tracker?op=maturity').then(r => r.json());
        maturityData = d;
        maturityMap = {};
        (d.strategies || []).forEach(s => { if (s.section) maturityMap[s.section] = { grade: s.grade, meta: d.gradeMeta }; });
        // Bake grade badges into the Scoreboard as soon as the map lands (harmless
        // if the tab is hidden — it's re-rendered in place, ready when opened).
        if (lastScoreboard) renderScoreboard(lastScoreboard);
        return maturityMap;
      } catch { maturityMap = {}; return maturityMap; }
    })();
    return ensureMaturityMap._p;
  }

  // Governance status badge — the actionable status (Production/Reduced/Probation/
  // Paper-only/Disabled/Retired) that CONTROLS sizing weight, distinct from the trust grade.
  function govBadge(gov, statusMeta) {
    if (!gov || !gov.status) return '';
    const m = (statusMeta && statusMeta[gov.status]) || { icon: '•', label: gov.status, weight: 0 };
    const wt = Math.round((m.weight ?? 0) * 100);
    const vr = gov.versionReset ? ' 🔄' : '';
    return `<span class="gov-badge gov-${esc(gov.status)}" title="${esc(m.blurb || '')} — cleared for ${wt}% size.${gov.versionReset ? ' Scoring version changed; track record reset.' : ''}\n${esc(gov.reason || '')}">${m.icon} ${esc(m.label)} · ${wt}%${vr}</span>`;
  }

  function strategyCard(s, meta, gov, statusMeta) {
    const st = s.stats;
    const sec = st && st.baselines && st.baselines.sector;
    const secLine = (sec && sec.n) ? ` · <span class="${sec.avgExcess < 0 ? 'mat-neg' : 'mat-pos'}">${sec.avgExcess > 0 ? '+' : ''}${sec.avgExcess}% vs sector</span>` : '';
    const track = (st && st.excessN)
      ? `<div class="mat-track"><span class="${st.avgExcess < 0 ? 'mat-neg' : 'mat-pos'}">${st.avgExcess > 0 ? '+' : ''}${st.avgExcess}% vs SPY</span> · beats ${st.beatMktRate}%${secLine} · <b>n=${st.excessN}</b></div>`
      : '';
    const crit = (s.inLab && s.criteria) ? `<div class="mat-crit">🎯 To graduate: ${esc(s.criteria)}</div>` : '';
    const hz = { intraday: 'Intraday', swing: 'Swing', position: 'Position', portfolio: 'Portfolio' }[s.horizon] || s.horizon;
    return `<div class="mat-card">
      <div class="mat-card-h">${matBadge(s.grade, meta)}${govBadge(gov, statusMeta)}<b>${esc(s.label)}</b>${s.core ? '<span class="mat-core" title="Core tradeable screener — stays in the main app">core</span>' : ''}<span class="mat-hz">${esc(hz)}</span></div>
      <div class="mat-reason">${esc(s.reason || '')}</div>${track}${crit}
    </div>`;
  }

  function renderEvidence(d) {
    const host = document.getElementById('evidence-container');
    if (!host) return;
    if (!d || !d.ok) { host.innerHTML = `<div class="dt-note" style="border-left-color:var(--red)">Couldn't grade strategies right now.</div>`; return; }
    const meta = d.gradeMeta || {};
    const statusMeta = d.statusMeta || {};
    const govMap = {};
    ((d.governance && d.governance.strategies) || []).forEach(g => { govMap[g.id] = g; });
    const gov = s => govMap[s.id];
    const gt = document.getElementById('evidence-gen-time');
    if (gt) gt.textContent = d.scoreboardAt ? `graded from Scoreboard @ ${new Date(d.scoreboardAt).toLocaleDateString()}` : (d.configured ? '' : 'storage not configured — grades will fill in');
    const strategies = d.strategies || [];
    // Legend with live counts.
    const legend = MAT_ORDER.map(g => `<span class="mat-leg mat-${g}" title="${esc((meta[g] || {}).blurb || '')}">${(meta[g] || {}).icon || ''} ${(meta[g] || {}).label || g} <b>${(d.counts || {})[g] || 0}</b></span>`).join('');
    const intro = `<div class="mat-intro">Each strategy earns a grade from its <b>own resolved track record</b> vs its benchmark (S&amp;P / sector) — Wilson-bounded and sample-aware, so a lucky small streak can't read as proven. Unproven overlays live in the <b>Research Lab</b> until the data promotes them. <b>A 0–100 score is a relative rank within a screen, not a probability</b> — a name scoring 80 is not "80% likely"; trust the grade and the track record, not the number.</div>`;
    // Governance summary — the actionable layer that lets the Scoreboard CONTROL sizing.
    let govPanel = '';
    if (d.governance && d.governance.counts) {
      const order = Object.keys(statusMeta).sort((a, b) => (statusMeta[b].rank || 0) - (statusMeta[a].rank || 0));
      const chips = order.map(st => `<span class="gov-leg gov-${st}" title="${esc(statusMeta[st].blurb || '')} — ${Math.round((statusMeta[st].weight ?? 0) * 100)}% size.">${statusMeta[st].icon} ${statusMeta[st].label} <b>${d.governance.counts[st] || 0}</b></span>`).join('');
      govPanel = `<div class="gov-panel"><div class="gov-panel-h">🏛️ Model governance <span class="mat-hz">status controls sizing weight</span></div>
        <div class="gov-legend">${chips}</div>
        <div class="mat-lab-note">Each grade maps to an <b>actionable status</b> gated on sample size — Production (full size) down to Retired. A model on <b>Probation</b> or below never sizes. Track records are <b>never merged across scoring versions</b> (🔄 = version reset). Total cleared weight budget: <b>${d.governance.clearedWeight ?? 0}</b>.</div></div>`;
    }
    // Main app (not in lab), grouped by grade.
    const main = strategies.filter(s => !s.inLab);
    const lab = strategies.filter(s => s.inLab);
    let html = `<div class="mat-legend">${legend}</div>${intro}${govPanel}`;
    MAT_ORDER.forEach(g => {
      const rows = main.filter(s => s.grade === g);
      if (!rows.length) return;
      html += `<div class="sb-secgroup"><div class="sb-secgroup-h">${matBadge(g, meta)} <span style="opacity:.8">${rows.length}</span></div><div class="mat-grid">${rows.map(s => strategyCard(s, meta, gov(s), statusMeta)).join('')}</div></div>`;
    });
    if (lab.length) {
      html += `<div class="sb-secgroup mat-lab"><div class="sb-secgroup-h">🔬 Research Lab <span style="opacity:.8">${lab.length}</span></div>
        <div class="mat-lab-note">Unproven overlays — kept out of the main workspaces until they beat their benchmark out-of-sample over enough resolved picks. Still logged and tracked so they can graduate.</div>
        <div class="mat-grid">${lab.map(s => strategyCard(s, meta, gov(s), statusMeta)).join('')}</div></div>`;
    }
    host.innerHTML = html;
  }

  async function loadEvidence(force) {
    const host = document.getElementById('evidence-container');
    if (!host) return;
    if (maturityData && !force) { renderEvidence(maturityData); return; }
    host.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Grading strategies…</p></div>`;
    try {
      const d = await fetch('/api/tracker?op=maturity' + (force ? '&_cb=' + Date.now() : '')).then(r => r.json());
      maturityData = d;
      maturityMap = {};
      (d.strategies || []).forEach(s => { if (s.section) maturityMap[s.section] = { grade: s.grade, meta: d.gradeMeta }; });
      renderEvidence(d);
    } catch { host.innerHTML = `<div class="dt-note" style="border-left-color:var(--red)">Couldn't load evidence grades.</div>`; }
  }
  let evidenceLoaded = false;
  function ensureEvidence() { if (!evidenceLoaded) { evidenceLoaded = true; loadEvidence(); } }
  window.ensureEvidence = ensureEvidence;
  const evidenceRefreshBtn = document.getElementById('evidence-refresh-btn');
  if (evidenceRefreshBtn) evidenceRefreshBtn.addEventListener('click', () => loadEvidence(true));

  // ── Baseline validation — does a strategy beat a DUMB baseline? ──────────────
  let baselinesData = null, baselinesComputing = false;

  function baselineRow(b) {
    if (b.kind === 'unavailable' || b.available === false) {
      return `<div class="bl-row bl-na"><span class="bl-name">${esc(b.name)}</span><span class="bl-edge td-dim">not computed</span><span class="bl-note td-dim">${esc(b.note || 'unavailable')}</span></div>`;
    }
    if (b.kind === 'benchmark' || b.kind === 'null') {
      const bar = b.kind === 'null' ? '0% excess bar' : 'benchmark';
      return `<div class="bl-row"><span class="bl-name">${esc(b.name)}</span><span class="bl-edge td-dim">${bar}</span><span class="bl-note td-dim">${esc(b.note || '')}</span></div>`;
    }
    // factor baseline
    const ic = b.rankIC != null ? b.rankIC.toFixed(3) : '—';
    const top = b.topQuintileExcess != null ? `${b.topQuintileExcess > 0 ? '+' : ''}${b.topQuintileExcess}%` : '—';
    const cls = b.predictive ? 'bl-pos' : 'bl-dead';
    return `<div class="bl-row"><span class="bl-name">${esc(b.name)}</span><span class="bl-edge ${cls}">IC ${ic} · top-20% ${top}</span><span class="bl-note td-dim">${b.predictive ? 'a real bar to beat' : 'no edge — ranking by this doesn’t predict returns'}</span></div>`;
  }

  function stratVsBaseRow(s) {
    const grade = maturityData && maturityData.gradeMeta ? matBadge(s.grade, maturityData.gradeMeta) : esc(s.grade);
    const spy = s.vsSpy == null ? '—' : `<span class="${s.vsSpy >= 0 ? 'bl-pos' : 'bl-neg'}">${s.vsSpy > 0 ? '+' : ''}${s.vsSpy}%</span>`;
    const sec = s.vsSector == null ? '—' : `<span class="${s.vsSector >= 0 ? 'bl-pos' : 'bl-neg'}">${s.vsSector > 0 ? '+' : ''}${s.vsSector}%</span>`;
    // Clears the bar = VALIDATED (beats both at significance). Positive-but-unproven
    // (right direction, too few resolved) is ➖ — an n=4 lead must not read as proven.
    const clears = s.grade === 'validated' ? '✅' : (s.beatsSpy && s.beatsSector ? '➖' : '❌');
    return `<div class="bl-srow"><span class="bl-name">${esc(s.label)}</span>${grade}<span class="bl-cell">vs SPY ${spy}</span><span class="bl-cell">vs sector ${sec}</span><span class="bl-clear" title="✅ Validated — beats BOTH SPY and its sector at significance · ➖ positive but not yet proven · ❌ doesn't beat both">${clears}</span><span class="td-dim">n=${s.n}</span></div>`;
  }

  function renderBaselines(d) {
    const host = document.getElementById('baselines-container');
    if (!host) return;
    if (!d || !d.ok) { host.innerHTML = `<div class="dt-note" style="border-left-color:var(--red)">Couldn't assemble baselines.</div>`; return; }
    const gt = document.getElementById('baselines-gen-time');
    if (gt) gt.textContent = d.researchAsOf ? `factors @ ${new Date(d.researchAsOf).toLocaleDateString()}` : 'factor scan not run yet';
    const intro = `<div class="mat-intro">The honest promotion test: a strategy earns nothing unless it beats a <b>dumb baseline</b>. Below are the baselines (what each naive screen actually earns) and then every strategy vs the two it's graded on — SPY and its sector. A strategy only <b>clears the bar</b> (✅) when it beats <b>both</b>.</div>`;
    const verdict = `<div class="dt-note" style="border-left-color:${d.summary && d.summary.beatSpyAndSector ? 'var(--green,#22c55e)' : 'var(--amber,#f59e0b)'}">⚖️ ${esc(d.verdict)}</div>`;
    let html = intro + verdict;
    html += `<div class="sb-secgroup"><div class="sb-secgroup-h">The baselines — the bar to beat</div><div class="bl-list">${(d.baselines || []).map(baselineRow).join('')}</div></div>`;
    if (!d.summary || !d.summary.researchAvailable) {
      html += `<div class="dt-note">The factor bars (momentum / 52-week / rel-volume) need the research cross-section. It's heavy (~50s) and rate-limited — click <b>Recompute factor scan</b> to build it, then Refresh.</div>`;
    }
    html += `<div class="bl-actions"><button class="refresh-btn" id="bl-recompute" ${baselinesComputing ? 'disabled' : ''} style="color:#38bdf8;border-color:#38bdf855">${baselinesComputing ? '⏳ Computing (~50s)…' : '🧪 Recompute factor scan'}</button></div>`;
    if (d.strategies && d.strategies.length) {
      html += `<div class="sb-secgroup"><div class="sb-secgroup-h">Every strategy vs its benchmarks</div><div class="bl-slist">${d.strategies.map(stratVsBaseRow).join('')}</div></div>`;
    }
    host.innerHTML = html;
    const rc = document.getElementById('bl-recompute');
    if (rc) rc.addEventListener('click', recomputeFactors);
  }

  async function loadBaselines(force) {
    const host = document.getElementById('baselines-container');
    if (!host) return;
    if (baselinesData && !force) { renderBaselines(baselinesData); return; }
    if (!baselinesData) host.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Assembling baselines…</p></div>`;
    try {
      const d = await fetch('/api/tracker?op=baselines' + (force ? '&_cb=' + Date.now() : '')).then(r => r.json());
      baselinesData = d;
      renderBaselines(d);
    } catch { host.innerHTML = `<div class="dt-note" style="border-left-color:var(--red)">Couldn't load baselines.</div>`; }
  }

  // Heavy: triggers the ~50s research scan (rate-limited server-side), which persists
  // the factor cross-section; then reloads the scorecard.
  async function recomputeFactors() {
    if (baselinesComputing) return;
    baselinesComputing = true;
    renderBaselines(baselinesData || { ok: true, baselines: [], summary: {}, verdict: 'Computing…' });
    try {
      const r = await fetch('/api/tracker?op=research&scope=large').then(r => r.json());
      if (r && r.ok === false && r.error) { /* rate-limited or failed — fall through to reload */ }
    } catch { /* ignore — reload shows whatever persisted */ }
    baselinesComputing = false;
    await loadBaselines(true);
  }

  let baselinesLoadedFlag = false;
  function ensureBaselines() { if (!baselinesLoadedFlag) { baselinesLoadedFlag = true; loadBaselines(); } }
  window.ensureBaselines = ensureBaselines;
  const baselinesRefreshBtn = document.getElementById('baselines-refresh-btn');
  if (baselinesRefreshBtn) baselinesRefreshBtn.addEventListener('click', () => loadBaselines(true));

  function buildMomColumn(side, list) {
    const buy = side === 'buy';
    // 2:1 reward-to-risk gate with graceful fallback (never blank the column).
    const gated = rrGate(list);

    const col = document.createElement('div');
    col.className = 'mom-col';

    const head = document.createElement('div');
    head.className = 'mom-col-head ' + side;
    head.innerHTML = `${buy ? '⚡ Strong Buy' : '⚡ Strong Sell'}<span class="cnt">${gated.items.length}</span>`;
    col.appendChild(head);

    const body = document.createElement('div');
    body.className = 'mom-col-body';
    if (!gated.items.length) {
      const empty = document.createElement('div');
      empty.className = 'mom-col-empty';
      empty.textContent = buy ? 'No strong buy signals right now.' : 'No strong sell signals right now.';
      body.appendChild(empty);
    } else {
      if (gated.fallback) body.insertAdjacentHTML('beforeend', rrFallbackBanner(gated.items.length));
      gated.items.forEach((c, idx) => body.appendChild(buildMomCard(c, side, idx)));
    }
    col.appendChild(body);
    return col;
  }

  function buildMomCard(c, side, idx) {
    const buy = side === 'buy';
    const chg = c.regChangePct;
    const up  = (chg ?? 0) >= 0;
    const chgHtml = chg != null ? `${up ? '▲ +' : '▼ '}${chg}%` : '';

    const reasonsHtml = (c.reasons || []).map(r =>
      `<div class="sig-reason ${buy ? 'bull' : 'bear'}"><span class="sr-dot">${buy ? '▲' : '▼'}</span><span>${esc(r)}</span></div>`
    ).join('');

    // Distance from the breakout pivot (prior 20-day high for buys / low for
    // sells). Small/positive "past" = just started moving; "from" = still coiling.
    let breakoutHtml = '';
    if (c.breakoutPoint != null && c.distFromBreakoutPct != null) {
      const dfb   = c.distFromBreakoutPct;
      const label = buy ? 'breakout' : 'breakdown';
      const past  = buy ? dfb >= 0 : dfb <= 0;
      const mag   = Math.abs(dfb).toFixed(1);
      const rel   = past ? `${mag}% past ${label}` : `${mag}% from ${label}`;
      breakoutHtml = `
        <div class="mom-breakout ${past ? 'past' : 'approaching'} ${side}" title="Breakout pivot = prior 20-day ${buy ? 'high' : 'low'} ($${esc(c.breakoutPoint)})">
          <span class="mb-ic">${past ? '🚀' : '⏳'}</span>
          <span class="mb-txt">${rel}</span>
          <span class="mb-lvl">$${esc(c.breakoutPoint)}</span>
        </div>`;
    }

    const lv = c.levels;
    const levelsHtml = lv ? `
        <div class="alert-targets">
          <div class="at-box"><div class="at-label">Entry</div><div class="at-val entry">$${esc(lv.entry)}</div></div>
          <div class="at-box"><div class="at-label">${targetLabel(lv)}</div><div class="at-val target">$${esc(lv.target)}</div></div>
          <div class="at-box"><div class="at-label">Stop</div><div class="at-val stop">$${esc(lv.stop)}</div></div>
        </div>${rrLineHTML(lv)}` : '';

    const card = document.createElement('div');
    card.className = `alert-card ${side} fade-in`;
    card.dataset.ticker = c.ticker;
    card.style.animationDelay = `${idx * 70}ms`;
    card.innerHTML = `
        <div class="alert-top">
          <div class="alert-rank ${side}">${c.confidence}</div>
          <div class="alert-title">
            <div class="alert-ticker">${esc(c.ticker)}</div>
            <div class="alert-company">${esc(c.company)}</div>
          </div>
          <div class="alert-price-col">
            <div class="alert-price" data-price>$${esc(c.price)}</div>
            <div class="alert-change ${up ? 'up' : 'down'}" data-change>${chgHtml}</div>
            <div class="alert-ah" data-ah style="display:none"></div>
          </div>
        </div>

        <div class="alert-badges">
          <div class="alert-live-badge"><div class="alert-live-dot"></div>LIVE</div>
          <div class="mom-action-badge ${side}">⚡ ${buy ? 'STRONG BUY' : 'STRONG SELL'}</div>
          ${whyNowBadge(c)}
          ${c.social ? `<div class="alert-social-badge">👥 ${Number(c.social).toLocaleString()}</div>` : ''}
        </div>

        ${breakoutHtml}

        <div class="sig-reasons-static">${reasonsHtml}</div>
        ${levelsHtml}

        <div class="alert-meta">
          ${lv ? `<span class="alert-rr">R/R ${esc(lv.riskReward)}</span>` : ''}
          <span class="alert-conf">Conf: ${c.confidence}/10</span>
          ${c.rsi != null ? `<span class="alert-tf">RSI ${c.rsi}</span>` : ''}
          ${c.pctFromSMA20 != null ? `<span class="alert-tf">${c.pctFromSMA20 >= 0 ? '+' : ''}${c.pctFromSMA20}% vs 20d SMA</span>` : ''}
        </div>

        <div class="alert-thesis">${esc(c.thesis)}</div>

        ${chartToggleMarkup()}
      `;
    wireChartToggle(card, c.ticker);
    return card;
  }

  // ── Live price polling (reflects pre/after-hours) ──────────────────────────
  let livePriceTimer = null;
  function startLivePrices(tickers) {
    if (livePriceTimer) clearInterval(livePriceTimer);
    if (!tickers.length) return;
    const update = () => updateLivePrices(tickers);
    update();
    livePriceTimer = setInterval(update, 30 * 1000); // 30s — near-live
  }

  async function updateLivePrices(tickers) {
    try {
      const res = await fetch('/api/price?tickers=' + encodeURIComponent(tickers.join(',')));
      if (!res.ok) return;
      const data = await res.json();
      document.querySelectorAll('.alert-card[data-ticker]').forEach(card => {
        const q = data[card.dataset.ticker];
        if (!q) return;
        const priceEl  = card.querySelector('[data-price]');
        const changeEl = card.querySelector('[data-change]');
        const ahEl     = card.querySelector('[data-ah]');

        const shown = q.afterHours ? q.afterHours.price : q.regularPrice;
        if (priceEl && priceEl.textContent !== '$' + shown) {
          priceEl.textContent = '$' + shown;
          priceEl.classList.remove('price-flash'); void priceEl.offsetWidth; priceEl.classList.add('price-flash');
        }
        if (changeEl) {
          const up = parseFloat(q.changePct) >= 0;
          changeEl.className = 'alert-change ' + (up ? 'up' : 'down');
          changeEl.textContent = (up ? '▲ +' : '▼ ') + q.changePct + '%';
        }
        if (ahEl) {
          if (q.afterHours) {
            const up = parseFloat(q.afterHours.changePct) >= 0;
            const tag = q.afterHours.session === 'pre' ? 'PRE' : 'AH';
            ahEl.style.display = 'flex';
            ahEl.style.color = up ? 'var(--green)' : 'var(--red)';
            ahEl.innerHTML = `<span class="ah-tag">${tag}</span>${up ? '▲' : '▼'} $${q.afterHours.price} (${up ? '+' : ''}${q.afterHours.changePct}%)`;
          } else {
            ahEl.style.display = 'none';
          }
        }
      });
    } catch { /* keep last good prices */ }
  }

  // ── Live chart + real-time signal panel ────────────────────────────────────
  const openCharts = new Map(); // ticker -> intervalId

  // Reusable toggle markup + wiring so any card (momentum, picks, options) can
  // expand a live chart + signal panel.
  function chartToggleMarkup() {
    return `
        <button class="chart-toggle" data-chart-toggle>
          <span>📈</span><span>Live Chart &amp; Real-Time Signals</span><span class="sig-badge" data-sig-badge></span><span class="ct-arrow">▾</span>
        </button>
        <div class="chart-panel" data-chart-panel style="display:none"></div>`;
  }
  function wireChartToggle(card, ticker) {
    const btn = card.querySelector('[data-chart-toggle]');
    if (btn) btn.addEventListener('click', () => toggleChart(card, ticker));
  }

  // ── Strong Buy/Sell flip alerts (badge + sound) ────────────────────────────
  const signalState = new Map(); // ticker -> last known action
  let soundEnabled  = localStorage.getItem('alertsMuted') !== '1';
  let notifyEnabled = localStorage.getItem('notifyOn') === '1';
  let audioCtx = null;
  const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  // Register the service worker (enables installable PWA + reliable notifications)
  let swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(r => { swReg = r; }).catch(() => {});
  }

  // ── Auto-update: prompt a reload when a new deploy lands ──────────────────
  // The app is a long-lived SPA — switching its in-page tabs reuses code already in
  // memory, so a new deploy isn't seen until a full page reload. Poll the deploy's
  // commit SHA (/api/tracker?op=version); when it changes from the one we booted with,
  // show a one-tap refresh bar. No build-time asset versioning required.
  (function autoUpdate() {
    let bootVersion = null, dismissedVersion = null;
    const fetchVersion = () => fetch('/api/tracker?op=version', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null)).then(d => d && d.version).catch(() => null);
    const showBar = (v) => {
      if (document.getElementById('update-bar')) return;
      const bar = document.createElement('div');
      bar.id = 'update-bar';
      bar.innerHTML = `<span class="ub-msg">🔄 A new version of the app is available.</span>`
        + `<button class="ub-reload" type="button">Refresh</button>`
        + `<button class="ub-x" type="button" aria-label="Dismiss">✕</button>`;
      document.body.appendChild(bar);
      bar.querySelector('.ub-reload').onclick = () => location.reload();
      bar.querySelector('.ub-x').onclick = () => { bar.remove(); dismissedVersion = v; };
    };
    const check = async () => {
      const v = await fetchVersion();
      if (!v || v === 'dev') return;
      if (bootVersion == null) { bootVersion = v; return; }   // first successful fetch = our version
      if (v !== bootVersion && v !== dismissedVersion) showBar(v);
    };
    check();                                                   // capture bootVersion
    setInterval(check, 5 * 60 * 1000);                         // re-check every 5 minutes
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });  // and when the tab regains focus
  })();

  // Fire a desktop/phone notification on a Strong flip (works while the app is
  // open or installed as a PWA). Uses the service worker so it shows even when
  // the tab is backgrounded.
  async function showFlipNotification(ticker, action) {
    if (!notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const buy = action === 'STRONG_BUY';
    const title = `${ticker} · ${buy ? '⚡ STRONG BUY' : '⚡ STRONG SELL'}`;
    const opts = {
      body: `${ticker} just flipped to ${buy ? 'Strong Buy' : 'Strong Sell'} on real-time price action. Tap to view the chart.`,
      icon: '/icon.svg', badge: '/icon.svg',
      tag: 'sig-' + ticker, renotify: true,
      data: { url: '/#momentum', ticker },
      vibrate: buy ? [80, 40, 80] : [120, 60, 120],
    };
    try {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.ready);
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch { try { new Notification(title, opts); } catch {} }
  }

  function initAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  document.addEventListener('click', initAudio, { once: true });

  function playAlertSound(side) {
    if (!soundEnabled) return;
    initAudio();
    if (!audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      const freqs = side === 'buy' ? [660, 880, 1175] : [523, 392, 294]; // rising chime = buy, falling = sell
      freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(g); g.connect(audioCtx.destination);
        const t = now + i * 0.14;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.start(t); o.stop(t + 0.18);
      });
    } catch {}
  }

  function flashCards(ticker, action) {
    const cls = action === 'STRONG_BUY' ? 'card-flash-buy' : 'card-flash-sell';
    document.querySelectorAll('[data-ticker="' + cssEsc(ticker) + '"]').forEach(card => {
      card.classList.remove('card-flash-buy', 'card-flash-sell');
      void card.offsetWidth; // restart animation
      card.classList.add(cls);
      setTimeout(() => card.classList.remove(cls), 4500);
    });
  }

  // Central handler: update every card for this ticker, alert on a flip into Strong.
  function handleSignalUpdate(ticker, action) {
    if (!ticker || !action) return;
    const prev = signalState.get(ticker);
    signalState.set(ticker, action);
    const isStrong = action === 'STRONG_BUY' || action === 'STRONG_SELL';

    document.querySelectorAll('[data-ticker="' + cssEsc(ticker) + '"]').forEach(card => {
      const badge = card.querySelector('[data-sig-badge]');
      if (!badge) return;
      if (isStrong) {
        const buy = action === 'STRONG_BUY';
        badge.textContent = buy ? '⚡ STRONG BUY' : '⚡ STRONG SELL';
        badge.className = 'sig-badge ' + (buy ? 'buy' : 'sell');
      } else {
        badge.textContent = '';
        badge.className = 'sig-badge';
      }
    });

    // Alert only on an actual flip into Strong (skip the first sighting on load)
    if (isStrong && prev !== undefined && prev !== action) {
      playAlertSound(action === 'STRONG_BUY' ? 'buy' : 'sell');
      flashCards(ticker, action);
      showFlipNotification(ticker, action);
    }
  }

  // Background watcher — polls every on-screen ticker so flips alert even with
  // the chart collapsed. Server caches /api/chart for 60s, so this is cheap.
  let polling = false;
  async function pollSignals() {
    if (polling) return;
    polling = true;
    try {
      const tickers = [...new Set(
        [...document.querySelectorAll('[data-ticker]')].map(e => e.dataset.ticker).filter(Boolean)
      )].slice(0, 12);
      await Promise.all(tickers.map(async t => {
        try {
          const r = await fetch('/api/chart?ticker=' + encodeURIComponent(t));
          if (!r.ok) return;
          const d = await r.json();
          if (d && d.live) handleSignalUpdate(t, d.live.action);
        } catch {}
      }));
    } finally { polling = false; }
  }
  setTimeout(pollSignals, 6000);                 // seed baseline shortly after load (no alerts)
  setInterval(pollSignals, 120 * 1000);          // then re-check every 2 min

  // Sound + Notification toggles, dropped into the Momentum header next to Refresh
  (function setupAlertToggles() {
    const refresh = document.getElementById('momentum-refresh-btn');
    if (!refresh) return;

    // ── Sound toggle ──
    const sBtn = document.createElement('button');
    sBtn.className = 'refresh-btn';
    sBtn.style.color = '#ff6b35';
    sBtn.title = 'Strong Buy/Sell alert chime';
    const paintS = () => { sBtn.textContent = soundEnabled ? '🔊 Sound' : '🔇 Sound'; };
    paintS();
    sBtn.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem('alertsMuted', soundEnabled ? '0' : '1');
      paintS();
      if (soundEnabled) { initAudio(); playAlertSound('buy'); } // preview chime
    });

    // ── Notification toggle ──
    const nBtn = document.createElement('button');
    nBtn.className = 'refresh-btn';
    nBtn.style.color = '#ff6b35';
    nBtn.title = 'Desktop / phone notifications on Strong Buy/Sell flips';
    const supported = ('Notification' in window);
    const paintN = () => {
      if (!supported) { nBtn.textContent = '🔔 N/A'; return; }
      const denied = Notification.permission === 'denied';
      nBtn.textContent = notifyEnabled && !denied ? '🔔 Notify On' : denied ? '🔕 Blocked' : '🔔 Notify Off';
    };
    // If permission was lost/reset, reflect that
    if (supported && notifyEnabled && Notification.permission !== 'granted') { notifyEnabled = false; localStorage.setItem('notifyOn', '0'); }
    paintN();
    nBtn.addEventListener('click', async () => {
      if (!supported) { alert('This browser does not support notifications.'); return; }
      if (notifyEnabled) {
        notifyEnabled = false; localStorage.setItem('notifyOn', '0'); paintN(); return;
      }
      let perm = Notification.permission;
      if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch {} }
      if (perm !== 'granted') {
        notifyEnabled = false; localStorage.setItem('notifyOn', '0'); paintN();
        if (perm === 'denied') alert('Notifications are blocked in your browser settings for this site. Enable them there to receive alerts.\n\nOn iPhone: open this site in Safari, tap Share → Add to Home Screen, then open it from the home-screen icon and enable notifications.');
        return;
      }
      notifyEnabled = true; localStorage.setItem('notifyOn', '1'); paintN();
      // Confirmation notification
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.ready);
        const title = '🔔 Alerts on';
        const opts = { body: 'You\'ll be notified when a stock flips to Strong Buy or Strong Sell.', icon: '/icon.svg', badge: '/icon.svg', tag: 'sig-test' };
        if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
      } catch {}
    });

    refresh.parentNode.insertBefore(nBtn, refresh);
    refresh.parentNode.insertBefore(sBtn, refresh);
  })();

  function toggleChart(card, ticker) {
    const btn   = card.querySelector('[data-chart-toggle]');
    const panel = card.querySelector('[data-chart-panel]');
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
      panel.style.display = 'none';
      btn.classList.remove('open');
      if (openCharts.has(ticker)) { clearInterval(openCharts.get(ticker)); openCharts.delete(ticker); }
      return;
    }
    panel.style.display = 'block';
    btn.classList.add('open');
    panel.innerHTML = `<div class="chart-loading"><div class="mom-spinner"></div>Loading live chart &amp; signals for ${esc(ticker)}…</div>`;
    loadChart(ticker, panel);
    // Refresh open chart every 60s for real-time signal updates
    const id = setInterval(() => loadChart(ticker, panel, true), 60 * 1000);
    openCharts.set(ticker, id);
  }

  async function loadChart(ticker, panel, silent) {
    try {
      const res = await fetch('/api/chart?ticker=' + encodeURIComponent(ticker));
      if (!res.ok) throw new Error('no data');
      const data = await res.json();
      renderChart(panel, data);
    } catch {
      if (!silent) panel.innerHTML = `<div class="chart-err">Live chart unavailable for ${esc(ticker)}.</div>`;
    }
  }

  function renderChart(panel, data) {
    const { live, candles, indicators, price, marketState, interval, signals, source } = data;
    const act = (live.action || 'HOLD').toLowerCase();
    const actLabel = live.label || 'Hold';

    const reasonsHtml = (live.reasons || []).map(r =>
      `<div class="sig-reason ${live.bullish ? 'bull' : 'bear'}"><span class="sr-dot">${live.bullish ? '▲' : '▼'}</span><span>${esc(r)}</span></div>`
    ).join('');
    const counterHtml = (live.counter || []).map(r =>
      `<div class="sig-reason ${live.bullish ? 'bear' : 'bull'}" style="opacity:.7"><span class="sr-dot">${live.bullish ? '▼' : '▲'}</span><span>${esc(r)}</span></div>`
    ).join('');

    const lv = live.levels;
    const levelsHtml = lv ? `
      <div class="chart-levels">
        <div class="cl-box"><div class="cl-label">Entry</div><div class="cl-val entry">$${lv.entry}</div></div>
        <div class="cl-box"><div class="cl-label">Target</div><div class="cl-val target">$${lv.target}</div></div>
        <div class="cl-box"><div class="cl-label" title="Invalidation — the setup is wrong below here">Stop</div><div class="cl-val stop">$${lv.stop}</div></div>
        <div class="cl-box"><div class="cl-label">R/R</div><div class="cl-val rr">${lv.riskReward}</div></div>
        ${lv.atr ? `<div class="cl-box"><div class="cl-label" title="Average True Range (14) — typical daily move; sizes the stop">ATR</div><div class="cl-val">$${lv.atr}</div></div>` : ''}
      </div>` : '';

    const ahHtml = price.afterHours
      ? ` · <b style="color:${price.afterHours.change >= 0 ? 'var(--green)' : 'var(--red)'}">${price.afterHours.session === 'pre' ? 'Pre' : 'After'}-hrs $${price.afterHours.price} (${price.afterHours.change >= 0 ? '+' : ''}${price.afterHours.changePct}%)</b>`
      : '';

    const dualHtml = data.dual ? buildDualBanner(data) : '';

    panel.innerHTML = `
      ${dualHtml}
      <div class="sig-banner ${act}">
        <div class="sig-verdict">
          <div class="sig-action">${esc(actLabel)}</div>
          <div class="sig-conf">Conf ${live.confidence}/10</div>
        </div>
        <div class="sig-reasons">${reasonsHtml}${counterHtml}</div>
      </div>
      ${levelsHtml}
      <div class="chart-canvas-wrap"><canvas></canvas></div>
      <div class="chart-legend">
        <span><i class="cleg-swatch" style="background:#c0d0e8"></i>Price</span>
        <span><i class="cleg-swatch" style="background:#06c4d4"></i>EMA9</span>
        <span><i class="cleg-swatch" style="background:#f0a832"></i>EMA21</span>
        <span><i class="cleg-swatch" style="background:#8a6dff"></i>EMA50</span>
        ${source === 'yahoo' ? '<span><i class="cleg-swatch" style="background:#ff6b35;height:0;border-top:2px dashed #ff6b35"></i>VWAP</span>' : ''}
        <span style="color:var(--green)">▲ Buy</span><span style="color:var(--red)">▼ Sell</span>
        ${lv ? '<span style="color:#06c4d4">┈ Entry</span><span style="color:#10d98a">┈ Target</span><span style="color:#ef5050">┈ Stop</span>' : ''}
      </div>
      <div class="chart-stats">
        <span>Live <b>$${price.live}</b></span>
        <span>RSI <b>${live.rsi ?? '—'}</b></span>
        <span>VWAP <b>${live.vwap != null ? '$' + live.vwap : '—'}</b></span>
        <span>MACD <b style="color:${live.macdBull ? 'var(--green)' : 'var(--red)'}">${live.macdBull == null ? '—' : live.macdBull ? 'Bullish' : 'Bearish'}</b></span>
        <span>${esc(marketState)} · ${esc(interval)}${ahHtml}</span>
      </div>
      <div class="chart-disclaimer">⚠ Technical signal from real-time price action (EMA · VWAP · RSI · MACD · volume) — for educational use, not financial advice. Confirm before trading.</div>
    `;

    const canvas = panel.querySelector('canvas');
    // Overlay the trade plan (entry/breakout, stop=invalidation, target) as lines on the
    // chart, plus any real event markers (earnings) the payload carries (#5). Levels come
    // as strings from lib/signal.js → coerce to numbers; drop non-finite ones.
    const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };
    const chartLevels = lv ? { entry: num(lv.entry), stop: num(lv.stop), target: num(lv.target) } : null;
    const chartEvents = Array.isArray(data.events) ? data.events : [];
    drawChart(canvas, candles, indicators, signals, source, { levels: chartLevels, events: chartEvents });

    handleSignalUpdate(data.ticker, live.action);

    // Enrich the mechanical dual-read with the Fable narrative + quadrant track
    // record, and the long-term second-opinions panel (all async — the banner
    // already shows the instant mechanical verdict).
    if (data.dual) { enrichDualRead(panel, data); fetchLtRecs(panel.querySelector('[data-dual]') || panel, data); }
  }

  // ── Dual-horizon read (short-term × long-term) ──────────────────────────────
  const SETUP_TONE = {
    'trend-continuation': 'pos', 'pullback-buy': 'pos', 'early-strength': 'pos', 'uptrend-pause': 'pos',
    'range': 'mix', 'early-weakness': 'mix',
    'bear-bounce': 'neg', 'downtrend': 'neg', 'downtrend-pause': 'neg',
  };
  const SETUP_LABEL = {
    'trend-continuation': 'Trend continuation', 'pullback-buy': 'Pullback buy', 'early-strength': 'Early strength',
    'uptrend-pause': 'Uptrend pause', 'range': 'Range / chop', 'early-weakness': 'Early weakness',
    'bear-bounce': 'Bear bounce', 'downtrend': 'Downtrend', 'downtrend-pause': 'Downtrend pause',
  };
  const dhSide = action =>
    (action === 'STRONG_BUY' || action === 'BUY') ? 'bullish'
    : (action === 'STRONG_SELL' || action === 'SELL') ? 'bearish' : 'neutral';
  const dhLabel = s => s === 'bullish' ? 'Bullish' : s === 'bearish' ? 'Bearish' : 'Neutral';
  const dhArrow = s => s === 'bullish' ? '🔼' : s === 'bearish' ? '🔻' : '⏸';

  function buildDualBanner(data) {
    const lt = data.longTerm, dual = data.dual, live = data.live;
    const st = dhSide(live.action);
    const stSub = (live.reasons || [])[0] || live.label || '';
    const ltSub = (lt.reasons || [])[0] || '';
    const tone = SETUP_TONE[dual.setupClass] || 'mix';
    const setupLabel = SETUP_LABEL[dual.setupClass] || dual.setupClass;
    return `
      <div class="dual-read" data-dual>
        <div class="dual-horizons">
          <div class="dh-cell ${st}">
            <div class="dh-top">⏱ Short-term · intraday</div>
            <div class="dh-val ${st}">${dhArrow(st)} ${dhLabel(st)}</div>
            <div class="dh-sub">${esc(stSub)}</div>
          </div>
          <div class="dh-cell ${lt.trend}">
            <div class="dh-top">📈 Long-term · ~1y</div>
            <div class="dh-val ${lt.trend}">${dhArrow(lt.trend)} ${dhLabel(lt.trend)}</div>
            <div class="dh-sub">${esc(ltSub)}</div>
          </div>
        </div>
        <div class="dual-verdict">
          <span class="dv-setup ${tone}" data-setup>${esc(setupLabel)}</span>
          <span class="dv-text" data-verdict>${esc(dual.verdict)}</span>
        </div>
        <div class="dual-note" data-note hidden></div>
        <div class="dual-recs" data-ltrecs hidden></div>
        <div class="dual-track" data-track hidden></div>
      </div>`;
  }

  // Long-term "second opinions" — the custom model plus four independent lenses.
  const REC_TONE = { Buy: 'pos', Hold: 'mix', Sell: 'neg' };
  const LT_TREND_TO_REC = { bullish: 'Buy', bearish: 'Sell', neutral: 'Hold' };
  const MOM_MARK = {
    improving: '<span class="lr-mom up" title="Analysts upgrading recently">▲</span>',
    deteriorating: '<span class="lr-mom down" title="Analysts downgrading recently">▼</span>',
    stable: '<span class="lr-mom flat" title="Ratings steady this month">→</span>',
  };
  function recRow(label, r) {
    if (!r || !r.rec) return `<div class="lr-row"><span class="lr-name">${esc(label)}</span><span class="lr-chip na">n/a</span><span class="lr-detail">${esc((r && r.detail) || 'No data')}</span></div>`;
    const mom = r.momentum ? MOM_MARK[r.momentum] || '' : '';
    return `<div class="lr-row"><span class="lr-name">${esc(label)}</span><span class="lr-chip ${REC_TONE[r.rec] || 'mix'}">${esc(r.rec)}</span><span class="lr-detail">${mom}${esc(r.detail || '')}</span></div>`;
  }
  async function fetchLtRecs(root, data) {
    const host = root.querySelector('[data-ltrecs]');
    if (!host) return;
    try {
      const res = await fetch('/api/tracker?op=ltrecs&ticker=' + encodeURIComponent(data.ticker));
      const j = await res.json();
      if (!j || !j.recs) return;
      const R = j.recs;
      const custom = { rec: LT_TREND_TO_REC[data.longTerm && data.longTerm.trend] || 'Hold', detail: `Trend + relative-strength model · score ${data.longTerm ? data.longTerm.score : '—'}` };
      const all = [custom.rec, R.expert && R.expert.rec, R.fundamental && R.fundamental.rec, R.technical && R.technical.rec, R.momentum && R.momentum.rec].filter(Boolean);
      const buy = all.filter(x => x === 'Buy').length, sell = all.filter(x => x === 'Sell').length, hold = all.filter(x => x === 'Hold').length;
      const lean = buy > hold && buy > sell ? 'Buy' : sell > hold && sell > buy ? 'Sell' : 'Hold';
      host.innerHTML = `
        <div class="lr-head"><span class="lr-title">Long-term second opinions</span><span class="lr-consensus ${REC_TONE[lean]}">${buy}·${hold}·${sell} → ${lean}</span></div>
        ${recRow('Custom model', custom)}
        ${recRow('Expert consensus', R.expert)}
        ${recRow('Fundamental', R.fundamental)}
        ${recRow('Technical', R.technical)}
        ${recRow('Momentum', R.momentum)}`;
      host.hidden = false;
    } catch { /* leave hidden — the custom read still stands */ }
  }

  async function enrichDualRead(panel, data) {
    const root = panel.querySelector('[data-dual]');
    if (!root) return;
    const { live, longTerm: lt, dual } = data;
    try {
      const res = await fetch('/api/tracker?op=dualread', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: data.ticker, price: data.price && data.price.live,
          st: { action: live.action, confidence: live.confidence, reasons: live.reasons },
          lt: { trend: lt.trend, score: lt.score, reasons: lt.reasons, factors: lt.factors },
          mech: { quadrant: dual.quadrant, verdict: dual.verdict, setupClass: dual.setupClass },
        }),
      });
      const j = await res.json();
      const ai = j && j.ai;
      if (ai) {
        if (ai.verdict) {
          const vEl = root.querySelector('[data-verdict]');
          if (vEl) vEl.innerHTML = esc(ai.verdict) + ' <span class="dv-ai">🧠 AI</span>';
        }
        if (ai.setupClass) {
          const sEl = root.querySelector('[data-setup]');
          if (sEl) { sEl.textContent = SETUP_LABEL[ai.setupClass] || ai.setupClass; sEl.className = 'dv-setup ' + (SETUP_TONE[ai.setupClass] || 'mix'); }
        }
        if (ai.note || ai.stance) {
          const nEl = root.querySelector('[data-note]');
          if (nEl) { nEl.innerHTML = (ai.stance ? `<span class="dn-stance">${esc(ai.stance)}</span>` : '') + `<span>${esc(ai.note || '')}</span>`; nEl.hidden = false; }
        }
      }
    } catch { /* keep the mechanical verdict */ }
    // Quadrant track record + self-tuner status — how this exact short×long combo
    // has done vs SPY, and whether the learning loop has re-weighted yet.
    try {
      const book = await dualBook();
      if (!book) return;
      const row = book.byQuadrant && book.byQuadrant.find(b => b.quadrant === dual.quadrant);
      const eng = book.engine || {};
      const grp = lt && lt.group;
      const gInfo = grp && eng.groups && eng.groups[grp];
      const engBit = (gInfo && gInfo.personalized)
        ? `⚙️ tuned for ${esc(grp)} stocks <b>${esc(String(gInfo.version || ''))}</b>`
        : eng.promoted
          ? `⚙️ self-tuned <b>${esc(String(eng.version || ''))}</b>`
          : `⚙️ learning <b>${eng.resolved || 0}/${eng.minResolved || 40}</b>${grp ? ` <span style="opacity:.6">(${esc(grp)})</span>` : ''}`;
      let html = '';
      if (row && row.n >= 5) {
        const sign = row.avgExcessPct >= 0 ? '+' : '';
        html = `📊 This setup historically: <b>${sign}${row.avgExcessPct}%</b> vs SPY over ${book.horizon}d · <b>${row.beatRatePct}%</b> beat rate <span style="opacity:.6">(n=${row.n})</span> · ${engBit}`;
      } else {
        html = `📊 Track record building · ${engBit}`;
      }
      const tEl = root.querySelector('[data-track]');
      if (tEl) { tEl.innerHTML = html; tEl.hidden = false; }
    } catch { /* no track record yet */ }
  }

  // Cache the quadrant book for the session (server caches it 5 min too).
  let _dualBookPromise = null;
  function dualBook() {
    if (!_dualBookPromise) {
      _dualBookPromise = fetch('/api/tracker?op=dualreadbook').then(r => r.json()).catch(() => null);
    }
    return _dualBookPromise;
  }

  function drawChart(canvas, candles, ind, signals, source, opts = {}) {
    const levels = opts.levels || null;
    const events = opts.events || [];
    const wrap = canvas.parentElement;
    const cssW = wrap.clientWidth || 380;
    const cssH = 220;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const padL = 6, padR = 46, padT = 8, padB = 26;
    const plotW = cssW - padL - padR;
    const priceH = (cssH - padT - padB) * 0.74;
    const volH   = (cssH - padT - padB) * 0.26;
    const volTop = padT + priceH + 6;

    const n = candles.length;
    if (!n) return;

    // Price range across candles + EMAs + vwap
    let lo = Infinity, hi = -Infinity;
    candles.forEach(c => { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); });
    [ind.ema9, ind.ema21, ind.ema50, ind.vwap].forEach(arr => arr && arr.forEach(v => {
      if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }));
    // Keep the plan lines (entry/stop/target) inside the visible range.
    if (levels) [levels.entry, levels.stop, levels.target].forEach(v => {
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    });
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const maxVol = Math.max(1, ...candles.map(c => c.volume || 0));

    const x = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = p => padT + (1 - (p - lo) / (hi - lo)) * priceH;
    const vy = v => volTop + volH - (v / maxVol) * volH;

    // ── grid + price axis labels ──
    ctx.strokeStyle = '#16223e'; ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = '#4d6688'; ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const yy = padT + (priceH * g) / 4;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      const val = hi - ((hi - lo) * g) / 4;
      ctx.fillText('$' + val.toFixed(2), padL + plotW + 4, yy);
    }

    // ── volume bars ──
    const bw = Math.max(1, plotW / n * 0.7);
    candles.forEach((c, i) => {
      const up = c.close >= c.open;
      ctx.fillStyle = up ? 'rgba(16,217,138,0.35)' : 'rgba(239,80,80,0.35)';
      const h = volTop + volH - vy(c.volume || 0);
      ctx.fillRect(x(i) - bw / 2, vy(c.volume || 0), bw, h);
    });

    // ── candlesticks (wicks + bodies) ──
    candles.forEach((c, i) => {
      const up = c.close >= c.open;
      const col = up ? '#10d98a' : '#ef5050';
      const cx = x(i);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(c.high)); ctx.lineTo(cx, y(c.low)); ctx.stroke();
      ctx.fillStyle = col;
      const yo = y(c.open), yc = y(c.close);
      const top = Math.min(yo, yc); const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - bw / 2, top, bw, bh);
    });

    // ── EMA / VWAP overlays ──
    const line = (arr, color, dash) => {
      if (!arr) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash(dash || []);
      ctx.beginPath(); let started = false;
      arr.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const px = x(i), py = y(v);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      });
      ctx.stroke(); ctx.setLineDash([]);
    };
    line(ind.ema9,  '#06c4d4');
    line(ind.ema21, '#f0a832');
    line(ind.ema50, '#8a6dff');
    if (source === 'yahoo') line(ind.vwap, '#ff6b35', [4, 3]);

    // ── trade-plan level lines (#5): entry/breakout, stop=invalidation, target ──
    const hLine = (p, color, label) => {
      if (!Number.isFinite(p) || p < lo || p > hi) return;
      const py = y(p);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = '8px ui-monospace, monospace'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
      ctx.fillText(label, padL + 2, py - 1);
      ctx.textBaseline = 'middle';
    };
    if (levels) {
      hLine(levels.target, '#10d98a', 'Target');
      hLine(levels.entry,  '#06c4d4', 'Entry / breakout');
      hLine(levels.stop,   '#ef5050', 'Stop (invalidation)');
    }

    // ── event markers (#5): a vertical dotted line + ⧫ at any real event date in range ──
    const idxByTime = {}; candles.forEach((c, i) => { idxByTime[c.date] = i; });
    const nearestIdx = (dateStr) => {
      if (idxByTime[dateStr] != null) return idxByTime[dateStr];
      const t = new Date(dateStr).getTime();
      if (!Number.isFinite(t)) return null;
      let best = null, bestD = Infinity;
      candles.forEach((c, i) => { const d = Math.abs(new Date(c.date).getTime() - t); if (d < bestD) { bestD = d; best = i; } });
      return best;
    };
    (events || []).forEach(ev => {
      const i = nearestIdx(ev.date || ev.when); if (i == null) return;
      const cx = x(i);
      ctx.strokeStyle = 'rgba(240,168,50,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + priceH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0a832'; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(ev.mark || '⧫', cx, padT + 1);
      ctx.textBaseline = 'middle';
    });
    ctx.textAlign = 'left';

    // ── buy/sell signal markers ──
    const byTime = {}; candles.forEach((c, i) => { byTime[c.date] = i; });
    (signals || []).forEach(s => {
      const i = byTime[s.time]; if (i == null) return;
      const cx = x(i), cy = y(s.price);
      const buy = s.side === 'buy';
      ctx.fillStyle = buy ? '#10d98a' : '#ef5050';
      const oy = buy ? cy + 12 : cy - 12;
      ctx.beginPath();
      if (buy) { ctx.moveTo(cx, oy - 5); ctx.lineTo(cx - 4, oy + 3); ctx.lineTo(cx + 4, oy + 3); }
      else     { ctx.moveTo(cx, oy + 5); ctx.lineTo(cx - 4, oy - 3); ctx.lineTo(cx + 4, oy - 3); }
      ctx.closePath(); ctx.fill();
    });

    // ── time axis labels (first / mid / last) ──
    ctx.fillStyle = '#4d6688'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const fmt = d => {
      const dt = new Date(d);
      return source === 'yahoo'
        ? dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };
    [0, Math.floor(n / 2), n - 1].forEach(i => {
      ctx.fillText(fmt(candles[i].date), x(i), cssH - padB + 8);
    });
    ctx.textAlign = 'left';
  }

  function showMomError(msg) {
    momentumContainer.innerHTML = `<div class="mom-status error"><p>${esc(msg)}</p></div>`;
  }


  // Boot the initial tab LAST, so every lazy-loader (let-scoped) is initialized
  // before its tab-switch dispatch runs. Still executes before first paint.
  showTab(currentTop, { instant: true, noScroll: true });
