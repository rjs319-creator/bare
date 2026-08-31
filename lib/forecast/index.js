'use strict';
// CFR — CROSS-SECTIONAL FORECAST & RANKING. Public surface.
//
// A research and decision-support system. It does NOT place orders, alter portfolios or deploy
// anything, and no component here may be described as profitable without after-cost walk-forward
// out-of-sample evidence produced by this implementation.
//
// See docs/FORECAST-RANKING-SYSTEM.md for architecture, target equations, timing, leakage
// controls and reproduction commands.

module.exports = {
  config: require('./config'),
  contract: require('./contract'),
  capabilities: require('./capabilities'),
  sidecar: require('./sidecar'),
  panel: require('./panel'),   // pure; the research-cache loader is research/lib/forecast-panel.js
  universe: require('./universe'),
  targets: require('./targets'),
  features: require('./features'),
  xsection: require('./xsection'),
  dataset: require('./dataset'),
  ridge: require('./ridge'),
  chronos: require('./chronos-adapter'),
  moirai: require('./moirai-adapter'),
  lightgbm: require('./lightgbm-adapter'),
  baseModels: require('./base-models'),
  crossfit: require('./crossfit'),
  metaRanker: require('./meta-ranker'),
  calibration: require('./calibration'),
  quantiles: require('./quantiles'),
  ensemble: require('./ensemble'),
  folds: require('./folds'),
  walkforward: require('./walkforward'),
  backtest: require('./backtest'),
  metrics: require('./metrics'),
  score: require('./score'),
  scoreboard: require('./scoreboard'),
  registry: require('./registry'),
  leakage: require('./leakage'),
  arms: require('./arms'),
  infer: require('./infer'),
};
