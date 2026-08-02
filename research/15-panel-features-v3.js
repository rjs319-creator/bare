'use strict';
// Step 15 — PANEL v3: the feature panel rebuilt on the fwd-outcome-v3 contract.
//   node research/15-panel-features-v3.js
//
// Written BESIDE panel-v2 (research/14-panel-features.js → panel-features.json),
// which is NEVER overwritten: v3 writes panel-features-v3.json. Differences:
//   * labels come from research/lib/outcome-v3.forwardOutcomeV3, so a delisting
//     is only labeled when research/data/secmaster-v3.json supplies an
//     authoritative confirmed record — a stale price tail alone is 'unresolved'
//     (v2 labeled it 'delisted' and haircut it: the verified defect).
//   * status chars: m|c|p|u|n (mature / confirmed_delisted / pending /
//     unresolved / no_fill); f{h} is null unless labelReady.
//   * requires secmaster-v3. Absent → writes an explicit BLOCKED artifact with
//     the deterministic migration commands and exits without generating anything.
//
// Everything else (grid, PIT cap-band membership, features) matches step 14 so
// v2-vs-v3 label deltas are attributable to the label contract alone.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');
const OV3 = require('./lib/outcome-v3');

const DATA = path.join(__dirname, 'data');
const MASTER_PATH = path.join(DATA, 'secmaster-v3.json');
const OUT_PATH = path.join(DATA, 'panel-features-v3.json');
const BLOCKED_PATH = path.join(DATA, 'panel-v3.BLOCKED.json');
const GRID = pit.monthEnds('2022-01', '2026-05');
const VOL_LB = 63;

const STATUS_CHAR = { mature: 'm', confirmed_delisted: 'c', pending: 'p', unresolved: 'u', no_fill: 'n' };

function labelFieldsV3(h, o) {
  return {
    [`f${h}`]: o.labelReady ? o.trainingLabel : null,
    [`d${h}`]: o.labelReady ? (o.status === 'confirmed_delisted' ? 1 : 0) : null,
    [`s${h}`]: STATUS_CHAR[o.status] || 'u',
  };
}

const sd = (a) => { if (a.length < 2) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const ratio = (ps, i, lb, sk) => { if (i - lb < 0 || i - sk < 0) return null; const a = ps[i - lb].close, b = ps[i - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; };
function annVol(ps, i, n) { if (i - n < 0) return null; const r = []; for (let k = i - n + 1; k <= i; k++) { const x = ps[k].close / ps[k - 1].close - 1; if (Number.isFinite(x)) r.push(Math.max(-0.5, Math.min(0.5, x))); } const s = sd(r); return s ? s * Math.sqrt(252) : null; }
function advN(ps, i, n) { if (i < 0) return null; let s = 0, c = 0; for (let k = Math.max(0, i - n + 1); k <= i; k++) { s += ps[k].dollar; c++; } return c ? s / c : null; }

function writeBlocked(reason) {
  const blocked = {
    status: 'blocked', panelVersion: 'panel-v3', checkedAt: new Date().toISOString(), reason,
    note: 'panel-v2 (panel-features.json) is untouched and remains the survivorship-CAVEATED artifact; its inferred-delisting labels are marked for revalidation in research/PANEL-V2-REVALIDATION.md.',
    migration: [
      '1. node research/16-secmaster-v3.js --from <pitdata-v3 listings export>   (or with FMP_API_KEY set)',
      '2. node research/15-panel-features-v3.js',
    ],
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(BLOCKED_PATH, JSON.stringify(blocked, null, 2));
  console.log(`BLOCKED: ${reason}`);
  for (const step of blocked.migration) console.log(step);
}

(async () => {
  if (!fs.existsSync(MASTER_PATH)) {
    return writeBlocked('research/data/secmaster-v3.json missing — fwd-outcome-v3 requires an authoritative security master and will not label from price staleness');
  }
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));
  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  const syms = Object.keys(sj);
  const out = {};
  const labelStates = { m: 0, c: 0, p: 0, u: 0, n: 0 };
  let kept = 0, names = 0;
  const outcomeOpts = Object.freeze({
    dataCutoffMs: pit.DATA_CUTOFF_MS,
    securityMasterVersion: master.version,
    priceDataVersion: 'fmp-cache-v1',
  });
  for (const sym of syms) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < 60) continue;
    const ss = pit.sharesSeries(c.income); if (!ss.length) continue;
    const sec = sj[sym].sector || 'Unknown'; names++;
    const security = master.records[sym] || null;   // null → outcome-v3 fails closed to unresolved
    for (const d of GRID) {
      const pa = pit.asOfPriceAdv(ps, d); if (!pa || pa.stale) continue;
      const i = pa.idx, sh = pit.asOfShares(ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const m121 = ratio(ps, i, 252, 21); if (m121 == null) continue;
      const o21 = OV3.forwardOutcomeV3({ series: ps, dateMs: d, bars: 21, security, opts: outcomeOpts });
      if (!o21.labelReady) { labelStates[STATUS_CHAR[o21.status] || 'u']++; continue; }
      const o63 = OV3.forwardOutcomeV3({ series: ps, dateMs: d, bars: 63, security, opts: outcomeOpts });
      const o126 = OV3.forwardOutcomeV3({ series: ps, dateMs: d, bars: 126, security, opts: outcomeOpts });
      for (const o of [o21, o63, o126]) labelStates[STATUS_CHAR[o.status] || 'u']++;
      const m121lag = ratio(ps, i - 63, 252, 21);
      const v63 = annVol(ps, i, VOL_LB);
      const a20 = advN(ps, i, 20), a60 = advN(ps, i, 60);
      const row = {
        s: sym, sec, cap, adv: pa.adv, ipo: Math.round((d - ps[0].ms) / pit.DAY),
        lid: security ? security.listingId : null,
        m61: ratio(ps, i, 126, 21), m91: ratio(ps, i, 189, 21), m121,
        m181: ratio(ps, i, 378, 21), m63: ratio(ps, i, 126, 63), m93: ratio(ps, i, 189, 63), m122: ratio(ps, i, 252, 42),
        acc: m121lag == null ? null : m121 - m121lag,
        r21: ratio(ps, i, 21, 0), r5: ratio(ps, i, 5, 0),
        v63, ra: v63 ? m121 / v63 : null, vs: (a20 && a60) ? a20 / a60 : null,
        ...labelFieldsV3(21, o21), ...labelFieldsV3(63, o63), ...labelFieldsV3(126, o126),
      };
      const ym = new Date(d).toISOString().slice(0, 7); (out[ym] || (out[ym] = [])).push(row); kept++;
    }
  }
  const months = Object.keys(out).sort();
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    panelVersion: 'panel-v3',
    outcomePolicyVersion: OV3.OUTCOME_POLICY_VERSION,
    securityMasterVersion: master.version,
    dataCutoff: new Date(pit.DATA_CUTOFF_MS).toISOString().slice(0, 10),
    labelStates,
    months, rows: kept, panel: out,
  }));
  if (fs.existsSync(BLOCKED_PATH)) fs.unlinkSync(BLOCKED_PATH);
  console.log(`Panel built (panel-v3/${OV3.OUTCOME_POLICY_VERSION}): ${kept} name-months across ${months.length} months, ${names} names scanned.`);
  console.log('label states (per horizon-label):', JSON.stringify(labelStates));
})();
