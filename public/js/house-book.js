// 📒 HOUSE BOOK — render helpers for the simulated paper portfolio (op=housebook) and the
// per-browser "my book" (op=mybook). Pure: payload in, HTML out; no fetch, no DOM.
//
// Honesty rules: a null metric renders "–" (never 0 / NaN / Infinity); the equity chart is
// indexed to 100 so the book and SPY share ONE axis (never a dual axis); both series carry a
// legend AND a direct end label, so identity never rides on color alone; a table view of the
// same points sits under the chart for screen readers / print.
import { esc } from './format.js';

// Validated with the dataviz palette checker against the dark card surface (#0d1628):
// lightness band, chroma, CVD separation (deutan/protan/tritan), normal-vision floor, contrast.
export const BOOK_COLOR = '#0e9aa7';
export const BENCH_COLOR = '#d97706';
const GRID_COLOR = '#243659';
const INK_DIM = '#8ea0bf';
const CHART_W = 560;
const CHART_H = 180;
const PAD = { t: 10, r: 54, b: 22, l: 40 };
const TABLE_ROWS = 30;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const fmtRatio = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '–');
export const fmtPct = (v, d = 2) => (isNum(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '–');
export const fmtPctPts = (v, d = 2) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '–');
export const fmtUsd = (v) => (isNum(v) ? `$${Math.round(v).toLocaleString('en-US')}` : '–');
const shortDate = (d) => (typeof d === 'string' && d.length >= 10 ? d.slice(5) : '–');

// Index a series to 100 at its first finite value; non-finite points become null gaps.
export function indexed(points, key) {
  const vals = (points || []).map((p) => (p && isNum(p[key]) ? p[key] : null));
  const base = vals.find((v) => v != null && v > 0);
  if (base == null) return vals.map(() => null);
  return vals.map((v) => (v == null ? null : (v / base) * 100));
}

function polyline(xs, ys, color, dashed) {
  const segs = [];
  let cur = [];
  ys.forEach((y, i) => { if (y == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${xs[i].toFixed(1)},${y.toFixed(1)}`); });
  if (cur.length) segs.push(cur);
  return segs.map((s) => `<polyline points="${s.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dashed ? ' stroke-dasharray="5 4"' : ''}/>`).join('');
}

// Book vs SPY, both indexed to 100 — one axis, two labeled series, hover titles per session.
export function equityChartSvg(points, { w = CHART_W, h = CHART_H } = {}) {
  const pts = Array.isArray(points) ? points.filter((p) => p && p.date) : [];
  if (pts.length < 2) return `<div class="hb-chart-empty">Not enough sessions yet for a curve (${pts.length} point${pts.length === 1 ? '' : 's'}).</div>`;
  const book = indexed(pts, 'equity');
  const spy = indexed(pts, 'spyClose');
  const all = [...book, ...spy].filter((v) => v != null);
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const yMin = lo - span * 0.08, yMax = hi + span * 0.08;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const x = (i) => PAD.l + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * iw);
  const y = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const xs = pts.map((_, i) => x(i));
  const grid = [yMin + (yMax - yMin) * 0.25, yMin + (yMax - yMin) * 0.5, yMin + (yMax - yMin) * 0.75, 100]
    .map((v) => `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${w - PAD.r}" y2="${y(v).toFixed(1)}" stroke="${GRID_COLOR}" stroke-width="1"${v === 100 ? ' stroke-dasharray="2 3"' : ''}/><text x="${PAD.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${INK_DIM}">${v.toFixed(0)}</text>`).join('');
  const endLabel = (series, color, name) => { const last = [...series].reverse().find((v) => v != null); return last == null ? '' : `<text x="${w - PAD.r + 5}" y="${(y(last) + 3).toFixed(1)}" font-size="9" font-weight="700" fill="${color}">${name} ${last.toFixed(1)}</text>`; };
  const step = pts.length > 1 ? iw / (pts.length - 1) : iw;
  const hits = pts.map((p, i) => `<rect x="${(xs[i] - step / 2).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}" height="${ih}" fill="transparent"><title>${esc(p.date)} · book ${book[i] == null ? '–' : book[i].toFixed(2)} · SPY ${spy[i] == null ? '–' : spy[i].toFixed(2)} · equity ${esc(fmtUsd(p.equity))}</title></rect>`).join('');
  return `<svg class="hb-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="House book equity vs SPY, both indexed to 100">
    ${grid}
    ${polyline(xs, spy, BENCH_COLOR, true)}
    ${polyline(xs, book, BOOK_COLOR, false)}
    ${endLabel(spy, BENCH_COLOR, 'SPY')}${endLabel(book, BOOK_COLOR, 'Book')}
    <text x="${PAD.l}" y="${h - 6}" font-size="9" fill="${INK_DIM}">${esc(pts[0].date)}</text>
    <text x="${w - PAD.r}" y="${h - 6}" text-anchor="end" font-size="9" fill="${INK_DIM}">${esc(pts[pts.length - 1].date)}</text>
    ${hits}
  </svg>
  <div class="hb-legend"><span><i style="background:${BOOK_COLOR}"></i>Book (indexed 100)</span><span><i style="background:${BENCH_COLOR};border-top:2px dashed ${BENCH_COLOR};height:0"></i>SPY (indexed 100)</span></div>`;
}

export function pointsTable(points) {
  const pts = (Array.isArray(points) ? points : []).slice(-TABLE_ROWS);
  if (!pts.length) return '';
  const rows = pts.map((p) => `<tr><td>${esc(p.date)}</td><td>${esc(fmtUsd(p.equity))}</td><td>${isNum(p.spyClose) ? p.spyClose.toFixed(2) : '–'}</td><td>${isNum(p.openPositions) ? p.openPositions : '–'}</td></tr>`).join('');
  return `<details class="hb-table"><summary>Table view <span class="sb-dim">last ${pts.length} sessions</span></summary><div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Equity</th><th>SPY close</th><th>Open</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

const TILES = [
  ['totalReturn', 'Total return', fmtPct, 'Book equity vs its starting cash.'],
  ['annualReturn', 'Annualized', fmtPct, 'Geometric, (1+total)^(252/n) − 1 — meaningless for a few sessions.'],
  ['annualVolatility', 'Volatility (ann.)', fmtPct, 'Sample std of daily returns × √252.'],
  ['sortino', 'Sortino', fmtRatio, 'Annualized mean return / downside deviation (empyrical definition).'],
  ['calmar', 'Calmar', fmtRatio, 'Annualized return / |max drawdown|.'],
  ['omega', 'Omega', fmtRatio, 'Σ gains / Σ losses around a 0% threshold.'],
  ['maxDrawdown', 'Max drawdown', fmtPct, 'Worst peak-to-trough on the equity curve.'],
  ['beta', 'Beta vs SPY', fmtRatio, 'Full-sample beta of daily book returns on SPY returns.'],
];
export function metricTiles(m) {
  const M = m || {};
  const n = isNum(M.n) ? M.n : 0;
  const tiles = TILES.map(([k, label, fmt, help]) => `<div class="hb-tile" title="${esc(help)}"><span class="hb-tile-k">${label}</span><b class="hb-tile-v">${fmt(M[k])}</b></div>`).join('');
  const bench = isNum(M.benchmarkTotalReturn) ? `<div class="hb-tile" title="SPY over the same sessions."><span class="hb-tile-k">SPY same window</span><b class="hb-tile-v">${fmtPct(M.benchmarkTotalReturn)}</b></div>` : '';
  const roll = isNum(M.latestRollingBeta) ? `<div class="hb-tile" title="Beta over the trailing ${esc(String(M.rollingBetaWindow || ''))} sessions."><span class="hb-tile-k">Rolling beta</span><b class="hb-tile-v">${fmtRatio(M.latestRollingBeta)}</b></div>` : '';
  return `<div class="hb-tiles">${tiles}${bench}${roll}</div><div class="sb-dim hb-n">${n} daily return${n === 1 ? '' : 's'} · exact precision, rounded only here · empyrical-reloaded definitions</div>`;
}

const RC_LABEL = { ok: ['✅', 'Reconciled', 'hb-rc-ok'], divergent: ['🚨', 'DIVERGENT', 'hb-rc-bad'], 'no-data': ['⏳', 'No horizon exits yet', 'hb-rc-wait'] };
export function reconcileHtml(rc) {
  if (!rc) return `<div class="hb-rc hb-rc-wait">⏳ Reconciliation not computed yet.</div>`;
  const [icon, label, cls] = RC_LABEL[rc.status] || RC_LABEL['no-data'];
  const bits = [];
  if (isNum(rc.rows)) bits.push(`${rc.rows} horizon exit${rc.rows === 1 ? '' : 's'} compared`);
  if (isNum(rc.divergencePct)) bits.push(`divergence ${rc.divergencePct.toFixed(3)}% vs tolerance ${fmtRatio(rc.tolerancePct, 2)}%`);
  if (isNum(rc.bookMeanNetPct) && isNum(rc.scoreboardMeanNetPct)) bits.push(`book ${fmtPctPts(rc.bookMeanNetPct)} · Scoreboard method ${fmtPctPts(rc.scoreboardMeanNetPct)}`);
  if (isNum(rc.duplicateBuys)) bits.push(`${rc.duplicateBuys} duplicate buy${rc.duplicateBuys === 1 ? '' : 's'}`);
  if (isNum(rc.ledgerIdentityGapUsd)) bits.push(`ledger identity gap $${rc.ledgerIdentityGapUsd.toFixed(2)}`);
  const missingSb = Array.isArray(rc.rowsMissingInScoreboard) ? `<div class="sb-dim">Rows the Scoreboard does not grade: ${rc.rowsMissingInScoreboard.length ? rc.rowsMissingInScoreboard.slice(0, 8).map((r) => `<b>${esc(r.ticker)}</b> (${esc(r.section || '?')})`).join(', ') : 'none'}</div>` : `<div class="sb-dim">Scoreboard summary unavailable — the missing-rows check could not run.</div>`;
  const skips = rc.rowsMissingInBook && rc.rowsMissingInBook.counts ? Object.entries(rc.rowsMissingInBook.counts) : [];
  const missingBook = `<div class="sb-dim">Board rows the book did not take: ${skips.length ? skips.map(([k, v]) => `${esc(k)} ×${v}`).join(', ') : 'none'}</div>`;
  const problems = Array.isArray(rc.problems) && rc.problems.length ? `<ul class="hb-rc-problems">${rc.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
  return `<div class="hb-rc ${cls}"><b>${icon} ${label}</b> <span class="sb-dim">${bits.map(esc).join(' · ')}</span>${problems}${missingSb}${missingBook}<div class="sb-dim hb-rc-basis">${esc(rc.basis || '')}</div></div>`;
}

function positionsTable(open, closed) {
  const o = (open || []).slice(0, 12).map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td>${esc(p.timeframe || '–')}</td><td>${esc(shortDate(p.fillDate))}</td><td>${isNum(p.fillPrice) ? p.fillPrice.toFixed(2) : '–'}</td><td>${p.mark && isNum(p.mark.price) ? p.mark.price.toFixed(2) : '–'}</td><td class="${isNum(p.unrealizedPct) && p.unrealizedPct < 0 ? 'neg' : 'pos'}">${fmtPctPts(p.unrealizedPct)}</td><td>open</td></tr>`).join('');
  const c = (closed || []).slice(0, 12).map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td>${esc(p.timeframe || '–')}</td><td>${esc(shortDate(p.fillDate))}</td><td>${isNum(p.fillPrice) ? p.fillPrice.toFixed(2) : '–'}</td><td>${p.exit && isNum(p.exit.price) ? p.exit.price.toFixed(2) : '–'}</td><td class="${isNum(p.netReturnPct) && p.netReturnPct < 0 ? 'neg' : 'pos'}">${fmtPctPts(p.netReturnPct)}</td><td>${p.exit ? esc(p.exit.reason) + (p.exit.gapThrough ? ' (gap)' : '') : '–'}</td></tr>`).join('');
  if (!o && !c) return '<div class="sb-dim">No positions yet.</div>';
  return `<div style="overflow-x:auto"><table class="hb-pos"><thead><tr><th>Name</th><th>Frame</th><th>Filled</th><th>Fill</th><th>Mark / exit</th><th>Net</th><th>Status</th></tr></thead><tbody>${o}${c}</tbody></table></div>`;
}

// The Scoreboard panel.
export function renderHouseBook(p) {
  if (!p || p.ok === false) return `<div class="sb-secgroup"><div class="sb-secgroup-h">📒 House book</div><div class="sb-dim">House book unavailable${p && p.error ? `: ${esc(p.error)}` : ''}.</div></div>`;
  if (p.empty) return `<div class="sb-secgroup"><div class="sb-secgroup-h">📒 House book <span class="hb-shadow">shadow · weight 0</span></div><div class="sb-dim">${esc(p.note || 'No book yet.')}</div><div class="sb-dim hb-disc">${esc(p.disclosure || '')}</div></div>`;
  const b = p.book || {};
  const counts = b.counts || {};
  const head = `<div class="hb-head"><span>as of <b>${esc(p.asOfDate || '–')}</b></span><span>equity <b>${fmtUsd(b.equity)}</b> of ${fmtUsd(b.initialCash)}</span><span>open <b>${isNum(counts.open) ? counts.open : '–'}</b> · closed <b>${isNum(counts.closed) ? counts.closed : '–'}</b> · pending <b>${isNum(counts.pending) ? counts.pending : '–'}</b></span><span>realized <b>${fmtUsd(b.realizedPnl)}</b> · unrealized <b>${fmtUsd(b.unrealizedPnl)}</b></span></div>`;
  return `<div class="sb-secgroup hb-panel"><div class="sb-secgroup-h" title="${esc(p.disclosure || '')}">📒 House book — every A/B Session Board row, paper-traded <span class="hb-shadow">shadow · weight 0</span></div>
    ${head}
    ${equityChartSvg(p.equity && p.equity.points)}
    ${pointsTable(p.equity && p.equity.points)}
    ${metricTiles(p.metrics)}
    <div class="hb-sub">Reconciliation vs the Scoreboard</div>
    ${reconcileHtml(p.reconcile)}
    <div class="hb-sub">Positions</div>
    ${positionsTable(b.openPositions, b.recentClosed)}
    <div class="sb-dim hb-disc">${esc(p.disclosure || '')}</div>
  </div>`;
}
