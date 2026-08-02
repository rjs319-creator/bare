'use strict';
// Step 14 — build ONE tidy PIT feature panel so the big sweep is fast + correct.
//   node research/14-panel-features.js
//
// Per in-band name-month: a battery of momentum/refinement features + forward outcomes
// at 21/63/126d under the fwd-outcome-v2 contract (research/lib/pit.forwardOutcome).
// PANEL v2 — the v1 panel was CONTAMINATED: it wrote fwdReturn's old delistedWithin
// flag straight through as d21/d63/d126, which mislabeled every active-but-unmatured
// name-month near the end of the grid as a "delisting" and let truncated partial
// returns leak into labels. v2 labels ONLY mature and verified-delisted outcomes:
//   f{h} = label-ready return (raw when mature; Shumway-adjusted when delisted)
//   d{h} = 1 only for a GENUINE delisting inside the horizon
//   s{h} = status char m|d|p|u (mature / delisted / pending / unresolved)
// pending + unresolved rows carry f=null (fail closed — they are not labels).
// PIT membership (price×lagged-quarterly-shares cap band, ADV floor, stale guard) is
// enforced HERE so every downstream sweep inherits correct, survivorship-safe accounting.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');
const SM = require('./lib/secmaster');

const DATA = path.join(__dirname, 'data');
const GRID = pit.monthEnds('2022-01', '2026-05');   // wide; rows only kept where features+fwd exist
const VOL_LB = 63;

const OUTCOME_OPTS = Object.freeze({ securityMasterVersion: SM.VERSION });
const STATUS_CHAR = { mature: 'm', delisted: 'd', pending: 'p', unresolved: 'u' };

// Per-horizon label fields under the v2 contract. f = label-ready (delisting-adjusted)
// return or null; d = 1 only for a genuine in-horizon delisting; s = status char.
function labelFields(h, o) {
  const usable = o.adjustedReturn != null;
  return {
    [`f${h}`]: usable ? o.adjustedReturn : null,
    [`d${h}`]: usable ? (o.status === 'delisted' ? 1 : 0) : null,
    [`s${h}`]: STATUS_CHAR[o.status] || 'u',
  };
}

const sd = a => { if (a.length < 2) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const ratio = (ps, i, lb, sk) => { if (i - lb < 0 || i - sk < 0) return null; const a = ps[i - lb].close, b = ps[i - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; };
function annVol(ps, i, n) { if (i - n < 0) return null; const r = []; for (let k = i - n + 1; k <= i; k++) { const x = ps[k].close / ps[k - 1].close - 1; if (Number.isFinite(x)) r.push(Math.max(-0.5, Math.min(0.5, x))); } const s = sd(r); return s ? s * Math.sqrt(252) : null; }
function advN(ps, i, n) { if (i < 0) return null; let s = 0, c = 0; for (let k = Math.max(0, i - n + 1); k <= i; k++) { s += ps[k].dollar; c++; } return c ? s / c : null; }

(async () => {
  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  const syms = Object.keys(sj);
  const out = {};                                    // ym -> rows[]
  let kept = 0, names = 0;
  for (const sym of syms) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < 60) continue;
    const ss = pit.sharesSeries(c.income); if (!ss.length) continue;
    const sec = sj[sym].sector || 'Unknown'; names++;
    for (const d of GRID) {
      const pa = pit.asOfPriceAdv(ps, d); if (!pa || pa.stale) continue;
      const i = pa.idx, sh = pit.asOfShares(ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const m121 = ratio(ps, i, 252, 21); if (m121 == null) continue;
      const o21 = pit.forwardOutcome(ps, d, 21, OUTCOME_OPTS);
      if (o21.adjustedReturn == null) continue;                          // need at least a labeled short fwd
      const o63 = pit.forwardOutcome(ps, d, 63, OUTCOME_OPTS);
      const o126 = pit.forwardOutcome(ps, d, 126, OUTCOME_OPTS);
      const m121lag = ratio(ps, i - 63, 252, 21);                        // 12-1 as of 63d earlier (acceleration)
      const v63 = annVol(ps, i, VOL_LB);
      const a20 = advN(ps, i, 20), a60 = advN(ps, i, 60);
      const row = {
        s: sym, sec, cap, adv: pa.adv, ipo: Math.round((d - ps[0].ms) / pit.DAY),
        m61: ratio(ps, i, 126, 21), m91: ratio(ps, i, 189, 21), m121,
        m181: ratio(ps, i, 378, 21), m63: ratio(ps, i, 126, 63), m93: ratio(ps, i, 189, 63), m122: ratio(ps, i, 252, 42),
        acc: m121lag == null ? null : m121 - m121lag,
        r21: ratio(ps, i, 21, 0), r5: ratio(ps, i, 5, 0),
        v63, ra: v63 ? m121 / v63 : null, vs: (a20 && a60) ? a20 / a60 : null,
        ...labelFields(21, o21), ...labelFields(63, o63), ...labelFields(126, o126),
      };
      const ym = new Date(d).toISOString().slice(0, 7); (out[ym] || (out[ym] = [])).push(row); kept++;
    }
  }
  const months = Object.keys(out).sort();
  fs.writeFileSync(path.join(DATA, 'panel-features.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    panelVersion: 'panel-v2',
    outcomePolicyVersion: pit.OUTCOME_POLICY_VERSION,
    securityMasterVersion: SM.VERSION,
    dataCutoff: new Date(pit.DATA_CUTOFF_MS).toISOString().slice(0, 10),
    months, rows: kept, panel: out,
  }));
  console.log(`Panel built (panel-v2/${pit.OUTCOME_POLICY_VERSION}): ${kept} name-months across ${months.length} months (${months[0]}..${months.at(-1)}), ${names} names scanned.`);
  console.log('avg cross-section:', Math.round(kept / months.length));
})();
