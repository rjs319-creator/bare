'use strict';
// Phase-2 step 07 — PEAD: the orthogonal CATALYST engine. Run (after pulls free up):
//   node --env-file=research/.env research/07-pead.js
//
// For every in-band earnings event: the announcement REACTION (2-day return) and,
// where available, the EPS SURPRISE; then the forward 63-day DRIFT (starting after
// the reaction settles). Tests (a) does reaction/surprise predict drift = PEAD, and
// (b) is it ORTHOGONAL to 12-1 momentum (low correlation = a genuinely new edge,
// not momentum repackaged). Event-conditioned ⇒ far less survivorship-exposed.

const fs = require('fs');
const path = require('path');
const fmp = require('./lib/fmp');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const EARN = path.join(DATA, 'earnings');
const DRIFT = 63, REACT_SKIP = 2;                   // start the drift window 2 days post-announcement

async function earningsCached(sym) {
  const f = path.join(EARN, `${sym}.json`);
  if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(c)) return c; } catch {} }
  let e = []; try { e = await fmp.earnings(sym, 40); } catch {}
  if (Array.isArray(e) && e.length) { fs.mkdirSync(EARN, { recursive: true }); fs.writeFileSync(f, JSON.stringify(e)); }
  return Array.isArray(e) ? e : [];
}
function idxAt(s, ms) { let i = -1; for (let k = 0; k < s.length; k++) { if (s[k].ms <= ms) i = k; else break; } return i; }
function mom(s, ms) { const i = idxAt(s, ms); if (i - 252 < 0 || i - 21 < 0) return null; const a = s[i - 252].close, b = s[i - 21].close; return (a > 0 && b > 0) ? b / a - 1 : null; }
function spearman(xs, ys) { const n = xs.length; if (n < 10) return null; const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? num / Math.sqrt(dx * dy) : null; }
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';

(async () => {
  const syms = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  console.log(`Pulling earnings for ${syms.length} names (cached)…`);

  const events = [];                                 // {react, surprise, drift, mom, ym}
  let done = 0;
  for (const sym of syms) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let rec; try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(rec.price), ss = pit.sharesSeries(rec.income);
    if (ps.length < 120 || !ss.length) continue;
    const earns = await earningsCached(sym);
    if (++done % 300 === 0) process.stdout.write(`  ${done}/${syms.length}\n`);
    for (const ev of earns) {
      const ms = Date.parse(ev.date); if (!Number.isFinite(ms)) continue;
      if (ms < Date.UTC(2022, 0, 1) || ms > Date.UTC(2025, 11, 31)) continue;   // need 63d forward
      const i = idxAt(ps, ms); if (i < 1 || i + REACT_SKIP + DRIFT >= ps.length) continue;
      // in-band at the event?
      const pa = pit.asOfPriceAdv(ps, ms), sh = pit.asOfShares(ss, ms);
      if (!pa || pa.stale || !sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const react = ps[i + 1] ? ps[i + 1].close / ps[i - 1].close - 1 : null;     // 2-day announcement reaction
      const base = ps[i + REACT_SKIP].close, end = ps[i + REACT_SKIP + DRIFT].close;
      if (!(base > 0) || !(end > 0) || react == null) continue;
      const drift = end / base - 1;
      const surprise = (ev.epsEstimated != null && ev.epsActual != null && Math.abs(ev.epsEstimated) > 0)
        ? (ev.epsActual - ev.epsEstimated) / Math.abs(ev.epsEstimated) : null;
      events.push({ react, surprise, drift, mom: mom(ps, ms), ym: new Date(ms).toISOString().slice(0, 7) });
    }
  }

  console.log(`\n=== PEAD  (${events.length} in-band earnings events, 2022-2025) ===\n`);
  // (1) reaction → drift (all events)
  const R = events.filter(e => e.react != null && e.drift != null);
  console.log(`reaction→drift:  IC ${spearman(R.map(e => e.react), R.map(e => e.drift))?.toFixed(3)}  (n=${R.length})`);
  // (2) surprise → drift (subset with estimates)
  const S = events.filter(e => e.surprise != null && e.drift != null);
  console.log(`surprise→drift:  IC ${S.length > 10 ? spearman(S.map(e => e.surprise), S.map(e => e.drift))?.toFixed(3) : 'n/a'}  (n=${S.length}, ${(100 * S.length / events.length).toFixed(0)}% have estimates)`);
  // (3) quintiles by reaction → mean drift
  const ord = R.map((e, i) => [e.react, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]); const per = Math.floor(ord.length / 5);
  const qd = qi => mean(ord.slice(qi * per, qi === 4 ? ord.length : (qi + 1) * per).map(i => R[i].drift));
  console.log(`\nby reaction quintile → fwd 63d drift:`);
  console.log(`  Q1(worst react) ${pct(qd(0))}   Q5(best react) ${pct(qd(4))}   Q5-Q1 ${pct(qd(4) - qd(0))}`);
  // (4) asymmetry (classic PEAD: beats drift up, misses drift down)
  console.log(`  positive-reaction events: drift ${pct(mean(R.filter(e => e.react > 0).map(e => e.drift)))}  |  negative: ${pct(mean(R.filter(e => e.react < 0).map(e => e.drift)))}`);
  // (5) ORTHOGONALITY to momentum — the key test
  const M = events.filter(e => e.react != null && e.mom != null);
  console.log(`\northogonality to 12-1 momentum:  corr(reaction, momentum) = ${spearman(M.map(e => e.react), M.map(e => e.mom))?.toFixed(3)}  (near 0 = independent edge ✓)`);
  fs.writeFileSync(path.join(DATA, 'pead.json'), JSON.stringify({ generatedAt: new Date().toISOString(), n: events.length, events: events.slice(0, 0) }, null, 0));
  console.log('\nVERDICT cues: reaction→drift IC>0 = PEAD present; low corr-to-momentum = orthogonal (stacks with the anchor).');
})();
