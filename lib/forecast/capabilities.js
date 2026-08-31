'use strict';
// CAPABILITY DETECTION & FALLBACK HIERARCHY (forecast-capabilities-v1)
//
// One place that answers "what can this machine actually run right now, and therefore which
// tier of the system are we in". Everything downstream reads the resolved tier instead of
// re-probing, so a run cannot half-believe a model is present.
//
// Documented fallback hierarchy (highest → lowest):
//   1  chronos2 + moirai2 + ridge + lightgbm
//   2  chronos2 + ridge + lightgbm
//   3  moirai2 + ridge + lightgbm
//   4  ridge + lightgbm
//   5  ridge + ridge-xs (cross-sectional ridge ranker)
//   6  ridge only
//
// CHRONOS-2 / MOIRAI-2 VERSION DISCIPLINE. `chronos-forecasting` 1.x is Chronos-1/Chronos-Bolt,
// a DIFFERENT model family from Chronos-2. Detecting 1.x therefore reports
// `incompatible-version`, NOT availability — the spec forbids silently substituting a
// different generation. The same rule applies to Moirai: only a uni2ts release exposing the
// Moirai-2 module counts.

const { AVAILABILITY } = require('./contract');
const sidecar = require('./sidecar');

const CAPABILITIES_VERSION = 'forecast-capabilities-v1';

// Minimum Python for each foundation model, from the upstream project metadata.
const CHRONOS2_MIN_PY = [3, 10];
const MOIRAI2_MIN_PY = [3, 10];
const CHRONOS2_MIN_MAJOR = 2;

const cmpVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
const majorOf = (v) => {
  const m = /^(\d+)/.exec(String(v || ''));
  return m ? Number(m[1]) : null;
};

function pyTooOld(info, min) {
  if (!Array.isArray(info)) return null;
  return cmpVersion(info, min) < 0 ? `python ${info.join('.')} < ${min.join('.')}` : null;
}

/** Resolve one foundation model's availability from a probe report. Never throws. */
function foundationStatus(name, { probeReport, importName, minPy, minMajor, enabled }) {
  const out = { name, available: false, availability: AVAILABILITY.DISABLED, reason: null, packageVersion: null, notes: [] };
  if (!enabled) { out.reason = `${name} disabled by configuration`; return out; }

  if (!probeReport.installed) {
    out.availability = AVAILABILITY.PACKAGE_MISSING;
    out.reason = `python sidecar unavailable (${probeReport.error || 'probe failed'})`;
    return out;
  }
  const tooOld = minPy ? pyTooOld(probeReport.pythonVersionInfo, minPy) : null;
  const pkg = (probeReport.packages || {})[importName] || { available: false };
  out.packageVersion = pkg.version || null;

  if (!pkg.available) {
    out.availability = AVAILABILITY.PACKAGE_MISSING;
    out.reason = tooOld
      ? `${importName} not installed and cannot be: ${tooOld} (sidecar interpreter ${probeReport.python})`
      : `${importName} not installed in the sidecar interpreter (${probeReport.python})`;
    if (tooOld) out.notes.push(tooOld);
    return out;
  }
  if (minMajor != null) {
    const maj = majorOf(pkg.version);
    if (maj != null && maj < minMajor) {
      out.availability = AVAILABILITY.INCOMPATIBLE_VERSION;
      out.reason = `${importName} ${pkg.version} is a different model generation than required (need >= ${minMajor}.0); refusing to substitute it`;
      return out;
    }
  }
  const torch = (probeReport.packages || {}).torch;
  if (!torch || !torch.available) {
    out.availability = AVAILABILITY.PACKAGE_MISSING;
    out.reason = `${importName} present but torch is not — the model cannot run`;
    return out;
  }
  out.available = true;
  out.availability = AVAILABILITY.OK;
  out.reason = null;
  return out;
}

/**
 * Detect capabilities for a resolved config.
 * Returns a frozen report: per-component status, the resolved tier, and the model list a run
 * may actually use. `probeReport` may be injected (tests use a fixture instead of a real probe).
 */
function detectCapabilities(cfg, { probeReport = null, force = false } = {}) {
  const report = probeReport || sidecar.probe({ force });
  const enabled = new Set(cfg.models.enabled || []);

  const chronos2 = foundationStatus('chronos2', {
    probeReport: report, importName: 'chronos', minPy: CHRONOS2_MIN_PY, minMajor: CHRONOS2_MIN_MAJOR,
    enabled: enabled.has('chronos2') && cfg.models.chronos2.enabled !== false,
  });
  const moirai2 = foundationStatus('moirai2', {
    probeReport: report, importName: 'uni2ts', minPy: MOIRAI2_MIN_PY, minMajor: null,
    enabled: enabled.has('moirai2') && cfg.models.moirai2.enabled !== false,
  });

  // LightGBM needs only the sidecar + the package; no checkpoint, no torch.
  const lgbmPkg = (report.packages || {}).lightgbm || { available: false };
  const backend = cfg.metaRanker.backend;
  const lightgbm = { name: 'lightgbm', available: false, availability: AVAILABILITY.DISABLED, reason: null, packageVersion: lgbmPkg.version || null, notes: [] };
  if (backend === 'ridge-xs') {
    lightgbm.reason = 'meta-ranker backend pinned to ridge-xs by configuration';
  } else if (!report.installed) {
    lightgbm.availability = AVAILABILITY.PACKAGE_MISSING;
    lightgbm.reason = `python sidecar unavailable (${report.error || 'probe failed'})`;
  } else if (!lgbmPkg.available) {
    lightgbm.availability = AVAILABILITY.PACKAGE_MISSING;
    lightgbm.reason = `lightgbm not installed in the sidecar interpreter (${report.python})`;
  } else {
    lightgbm.available = true;
    lightgbm.availability = AVAILABILITY.OK;
  }

  // The Ridge/AR baseline is PERMANENT: pure JS, no optional dependency, always available.
  const ridge = { name: 'ridge', available: true, availability: AVAILABILITY.OK, reason: null, packageVersion: null, notes: ['in-repo, no optional dependency'] };

  const foundations = [chronos2.available && 'chronos2', moirai2.available && 'moirai2'].filter(Boolean);
  const metaBackend = lightgbm.available ? 'lightgbm' : 'ridge-xs';

  let tier, tierLabel;
  if (lightgbm.available && chronos2.available && moirai2.available) { tier = 1; tierLabel = 'chronos2+moirai2+ridge+lightgbm'; }
  else if (lightgbm.available && chronos2.available) { tier = 2; tierLabel = 'chronos2+ridge+lightgbm'; }
  else if (lightgbm.available && moirai2.available) { tier = 3; tierLabel = 'moirai2+ridge+lightgbm'; }
  else if (lightgbm.available) { tier = 4; tierLabel = 'ridge+lightgbm'; }
  else if (cfg.metaRanker.backend !== 'none') { tier = 5; tierLabel = 'ridge+ridge-xs'; }
  else { tier = 6; tierLabel = 'ridge-only'; }

  const degraded = [];
  if (!chronos2.available && chronos2.reason) degraded.push(`chronos2: ${chronos2.reason}`);
  if (!moirai2.available && moirai2.reason) degraded.push(`moirai2: ${moirai2.reason}`);
  if (!lightgbm.available && lightgbm.reason) degraded.push(`lightgbm: ${lightgbm.reason}`);

  return Object.freeze({
    schema: 'ForecastCapabilities', version: CAPABILITIES_VERSION,
    tier, tierLabel,
    baseModels: Object.freeze(['ridge', ...foundations]),
    metaBackend,
    components: Object.freeze({ ridge, chronos2, moirai2, lightgbm }),
    degraded: Object.freeze(degraded),
    sidecar: Object.freeze({
      installed: report.installed, python: report.python, pythonSource: report.pythonSource,
      pythonVersion: report.pythonVersion, error: report.error || null,
    }),
    configHash: cfg.configHash || null,
  });
}

/** Actionable setup guidance — printed by the CLI and returned by the API when degraded. */
function setupHints(caps) {
  const hints = [];
  if (!caps.sidecar.installed) {
    hints.push('Sidecar not runnable. Create it: python3 -m venv tools/forecast-sidecar/.venv && tools/forecast-sidecar/.venv/bin/pip install -r tools/forecast-sidecar/requirements-optional.txt');
  }
  if (!caps.components.lightgbm.available && caps.components.lightgbm.availability !== AVAILABILITY.DISABLED) {
    hints.push('LightGBM meta-ranker unavailable. Install: tools/forecast-sidecar/.venv/bin/pip install lightgbm');
  }
  if (!caps.components.chronos2.available) {
    hints.push('Chronos-2 unavailable. It requires Python >= 3.10 plus torch and chronos-forecasting >= 2.0; chronos-forecasting 1.x is Chronos-1/Bolt and is deliberately NOT substituted. Point FORECAST_PYTHON at a >=3.10 interpreter with those installed.');
  }
  if (!caps.components.moirai2.available) {
    hints.push('Moirai-2 unavailable. It requires Python >= 3.10 plus torch and uni2ts with the Moirai-2 module. Point FORECAST_PYTHON at a >=3.10 interpreter with those installed.');
  }
  return hints;
}

module.exports = { CAPABILITIES_VERSION, detectCapabilities, setupHints, foundationStatus };
