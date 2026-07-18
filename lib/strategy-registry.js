// Canonical catalog of every strategy/signal class the app runs — the single source
// of truth that the evidence-maturity grader (lib/maturity.js) joins against the live
// Scoreboard track record. Adding a screener? Add it here so it gets a maturity grade
// and, if it's an unproven overlay, is auto-routed to the Research Lab until it earns
// its way out.
//
// Fields:
//   id        stable key (matches the app tab where possible)
//   label     display name (with the tab's emoji)
//   kind      'signal' (return-generating, graded on forward return) | 'informational'
//             (context/awareness — never graded, never in the lab)
//   section   the Scoreboard `section` this class logs under (join key), or null when
//             it is tracked elsewhere / not yet in the board
//   horizon   intended holding period — intraday | swing | position | portfolio
//   core      true = a backbone tradeable screener that stays in the main workspaces
//             regardless of grade; false = an overlay that lives in the Research Lab
//             until it reaches Validated
//   note      optional plain-English context shown when there's no data to grade
//   criteria  optional: what would promote it out of the lab

const STRATEGY_REGISTRY = [
  // ── Core backbone screeners (stay in the main app; grade shown for honesty) ──
  { id: 'screener',   label: '🔎 Breakout',           kind: 'signal', section: 'screener', horizon: 'swing',    core: true,  criteria: 'Beat SPY/sector over ≥20 resolved.' },
  { id: 'momentum',   label: '🔥 Momentum',           kind: 'signal', section: 'momentum', horizon: 'position', core: true },
  { id: 'ghost',      label: '👻 Ghost Accumulation',  kind: 'signal', section: 'Ghost',    horizon: 'swing',    core: true },
  { id: 'gapgo',      label: '🚀 Gap & Go',            kind: 'signal', section: 'GapGo',    horizon: 'intraday', core: true,  note: 'The one deflation-surviving event edge; tracked via its own ledger.' },
  { id: 'daytrade',   label: '⚡ Day Trade',           kind: 'signal', section: 'daytrade', horizon: 'intraday', core: true },
  { id: 'coil',       label: '🧬 Coil Radar',          kind: 'signal', section: 'coil',     horizon: 'swing',    core: true },
  { id: 'custom',     label: '🧠 Adaptive Momentum',   kind: 'signal', section: null,       horizon: 'position', core: true,  note: 'Apex model — tracked via its own drift/rank-quality panel.' },
  { id: 'biotech',    label: '🧬 Biotech Radar',       kind: 'signal', section: 'Biotech',  horizon: 'swing',    core: true },
  { id: 'downday',    label: '🪁 Down-Day Bounce',     kind: 'signal', section: 'DownDay',  horizon: 'swing',    core: true },

  // ── Overlays / experimental detectors (Research Lab until Validated) ──
  { id: 'fade',       label: '🔥 Overheated (Fade)',   kind: 'signal', section: 'Fade',       horizon: 'swing',    core: false },
  { id: 'gapdown',    label: '🐻 Gap-Down Continuation', kind: 'signal', section: 'GapDown',   horizon: 'intraday', core: false },
  { id: 'events',     label: '⚡ CERN Forced-Flow',     kind: 'signal', section: 'CERN',       horizon: 'position', core: false, criteria: 'Per event-type decay curve must beat SPY over ≥20 resolved.' },
  { id: 'readthrough',label: '🔗 Read-Through',         kind: 'signal', section: 'ReadThrough',horizon: 'position', core: false, criteria: 'Fresh (not-yet-moved) must beat Moved + sector.' },
  { id: 'anomaly',    label: '🕵️ Stealth',            kind: 'signal', section: 'Anomaly',    horizon: 'position', core: false },
  { id: 'secondwave', label: '🌊 Second Wave',          kind: 'signal', section: 'SecondWave', horizon: 'position', core: false },
  { id: 'crossasset', label: '🌐 Cross-Asset',          kind: 'signal', section: 'CrossAsset', horizon: 'position', core: false },
  { id: 'toneshift',  label: '🎚️ Tone Shift',          kind: 'signal', section: 'ToneShift',  horizon: 'position', core: false },
  { id: 'tone',       label: '🎙 Earnings-Call Tone',   kind: 'signal', section: 'Tone',       horizon: 'position', core: false },
  { id: 'attention',  label: '📈 Attention (Sticky/Fast)', kind: 'signal', section: 'Attention', horizon: 'swing', core: false },
  { id: 'xalerts',    label: '🐦 Trade Alerts',         kind: 'signal', section: null,         horizon: 'swing',    core: false, note: 'Social alerts — edge unproven until ≥50 grade.' },
  { id: 'challenger-decision', label: '🧪 Challenger Decision', kind: 'signal', section: 'Challenger', horizon: 'swing', core: false, note: 'Shadow-only four-outcome challenger (challenger-decision-v1) — paper/weight-0 until it passes strict OOS + live-forward validation.' },

  // ── Informational surfaces (context, never graded, never in the lab) ──
  { id: 'sectors',    label: '📊 Sectors',    kind: 'informational', section: null, horizon: 'position', note: 'Sector performance heatmap — context, not a buy signal.' },
  { id: 'rotation',   label: '🔄 Rotation',   kind: 'informational', section: null, horizon: 'position', note: 'Where money is rotating week over week — context.' },
  { id: 'news',       label: '📰 News',       kind: 'informational', section: null, horizon: 'intraday', note: 'Summarized market-moving headlines — context.' },
  { id: 'pulse',      label: '📡 Market Pulse',kind: 'informational', section: null, horizon: 'swing',   note: 'Social/finance attention — awareness, not advice.' },
  { id: 'gameplan',   label: '🗞️ Game Plan',  kind: 'informational', section: null, horizon: 'intraday', note: 'Plain-English daily market game plan.' },
  { id: 'forecast',   label: '🔮 Forecast',   kind: 'informational', section: null, horizon: 'position', note: 'Falsifiable macro predictions, auto-graded on their own page.' },
];

module.exports = { STRATEGY_REGISTRY };
