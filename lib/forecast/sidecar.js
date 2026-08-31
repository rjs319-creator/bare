'use strict';
// PYTHON SIDECAR BRIDGE (forecast-sidecar-v1)
//
// LightGBM, Chronos-2 and Moirai-2 are Python libraries; this app is Node. Rather than pull a
// Python runtime into the serverless request path, the heavyweight models live behind a
// SIDECAR: a short-lived `python` process that reads one JSON request on stdin and writes one
// JSON response on stdout. Nothing here downloads anything, and nothing here runs at import
// time — capability probing is explicit and cached per process.
//
// The interpreter is resolved in this order (first that exists wins):
//   1. $FORECAST_PYTHON
//   2. tools/forecast-sidecar/.venv/bin/python   (the repo-local optional venv)
//   3. python3 on PATH
//
// A sidecar that is not installed is NOT an error: `probe()` returns a structured report and
// every adapter degrades through lib/forecast/capabilities.js. We never swallow an unexpected
// Python traceback — it comes back verbatim in `stderr` so a real bug stays visible.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SIDECAR_VERSION = 'forecast-sidecar-v1';
const SIDECAR_DIR = path.join(__dirname, '..', '..', 'tools', 'forecast-sidecar');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv', 'bin', 'python');
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_BUFFER = 256 * 1024 * 1024;

let _probeCache = null;

function resolvePython() {
  const explicit = process.env.FORECAST_PYTHON;
  if (explicit) return { python: explicit, source: 'FORECAST_PYTHON' };
  if (fs.existsSync(VENV_PYTHON)) return { python: VENV_PYTHON, source: 'repo-venv' };
  return { python: 'python3', source: 'PATH' };
}

function scriptPath(name) { return path.join(SIDECAR_DIR, name); }

/**
 * Run one sidecar script with a JSON payload. Returns
 *   { ok, data, error, code, stderr, elapsedMs, python }
 * `ok:false` NEVER carries fabricated data — callers must branch on it.
 */
function runScript(name, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const file = scriptPath(name);
  const { python, source } = resolvePython();
  if (!fs.existsSync(file)) {
    return { ok: false, data: null, error: `sidecar script not found: ${file}`, code: null, stderr: '', elapsedMs: 0, python, pythonSource: source };
  }
  let r;
  try {
    r = spawnSync(python, [file], {
      input: JSON.stringify(payload ?? {}),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, PYTHONHASHSEED: '0', OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '4' },
    });
  } catch (e) {
    return { ok: false, data: null, error: `spawn failed: ${String((e && e.message) || e)}`, code: null, stderr: '', elapsedMs: Date.now() - started, python, pythonSource: source };
  }
  const elapsedMs = Date.now() - started;
  const stderr = (r.stderr || '').toString().trim();
  if (r.error) {
    const missing = r.error.code === 'ENOENT';
    return { ok: false, data: null, error: missing ? `python interpreter not found: ${python}` : String(r.error.message || r.error), code: r.status, stderr, elapsedMs, python, pythonSource: source };
  }
  if (r.status !== 0) {
    return { ok: false, data: null, error: `sidecar exited ${r.status}`, code: r.status, stderr, elapsedMs, python, pythonSource: source };
  }
  let data = null;
  try { data = JSON.parse(r.stdout); } catch (e) {
    return { ok: false, data: null, error: `sidecar stdout was not JSON: ${String(r.stdout).slice(0, 200)}`, code: 0, stderr, elapsedMs, python, pythonSource: source };
  }
  if (data && data.ok === false) {
    return { ok: false, data: null, error: data.error || 'sidecar reported failure', code: 0, stderr, elapsedMs, python, pythonSource: source, detail: data };
  }
  return { ok: true, data, error: null, code: 0, stderr, elapsedMs, python, pythonSource: source };
}

/**
 * Probe the sidecar: which interpreter, which Python version, which optional packages are
 * importable and at what version. Cached per process (`force` re-runs it). Never throws.
 */
function probe({ force = false, timeoutMs = 60000 } = {}) {
  if (_probeCache && !force) return _probeCache;
  const { python, source } = resolvePython();
  const base = {
    version: SIDECAR_VERSION, python, pythonSource: source,
    installed: false, pythonVersion: null, packages: {}, error: null,
    sidecarDir: SIDECAR_DIR,
  };
  const r = runScript('probe.py', {}, { timeoutMs });
  if (!r.ok) {
    _probeCache = Object.freeze({ ...base, error: r.error, stderr: r.stderr || null });
    return _probeCache;
  }
  _probeCache = Object.freeze({
    ...base,
    installed: true,
    pythonVersion: r.data.pythonVersion || null,
    pythonVersionInfo: r.data.pythonVersionInfo || null,
    platform: r.data.platform || null,
    packages: Object.freeze(r.data.packages || {}),
    torch: r.data.torch || null,
    elapsedMs: r.elapsedMs,
  });
  return _probeCache;
}

function resetProbeCache() { _probeCache = null; }

module.exports = { SIDECAR_VERSION, SIDECAR_DIR, resolvePython, scriptPath, runScript, probe, resetProbeCache };
