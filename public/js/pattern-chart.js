// Pattern chart — hand-drawn candle canvas with structural overlays, so a user can SEE
// why the engine assigned a label: pivots, frozen trigger/invalidation/target, and the
// confirmation bar. No chart library (repo convention: canvas only).

const COLORS = {
  up: '#22c55e', down: '#ef4444', wick: '#6b7280',
  trigger: '#38bdf8', stop: '#ef4444', target: '#22c55e',
  pivot: '#eab308', vol: '#334155', grid: '#1f2937', text: '#94a3b8',
};

// chart: { candles: [{date,o,h,l,c,v}] }; det: canonical detection (plan + pivotsUsed).
export function drawPatternChart(canvas, chart, det) {
  if (!canvas || !chart || !Array.isArray(chart.candles) || chart.candles.length < 5) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 640;
  const H = canvas.clientHeight || 260;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const cs = chart.candles;
  const padL = 6;
  const padR = 52;
  const volH = 34;
  const priceH = H - volH - 14;
  const plan = (det && det.plan) || {};
  const levels = [plan.trigger, plan.stop, plan.target].filter(v => typeof v === 'number');
  let lo = Math.min(...cs.map(c => c.l), ...levels);
  let hi = Math.max(...cs.map(c => c.h), ...levels);
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const x = i => padL + (i / (cs.length - 1)) * (W - padL - padR);
  const y = p => 8 + (1 - (p - lo) / (hi - lo)) * (priceH - 8);
  const barW = Math.max(1.5, (W - padL - padR) / cs.length * 0.62);

  // volume
  const vmax = Math.max(...cs.map(c => c.v || 0)) || 1;
  for (let i = 0; i < cs.length; i++) {
    const vh = ((cs[i].v || 0) / vmax) * (volH - 4);
    ctx.fillStyle = COLORS.vol;
    ctx.fillRect(x(i) - barW / 2, H - 12 - vh, barW, vh);
  }
  // candles
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const up = c.c >= c.o;
    ctx.strokeStyle = COLORS.wick;
    ctx.beginPath();
    ctx.moveTo(x(i), y(c.h));
    ctx.lineTo(x(i), y(c.l));
    ctx.stroke();
    ctx.fillStyle = up ? COLORS.up : COLORS.down;
    const top = y(Math.max(c.o, c.c));
    const hgt = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    ctx.fillRect(x(i) - barW / 2, top, barW, hgt);
  }
  // frozen levels
  const lvl = (price, color, label) => {
    if (typeof price !== 'number') return;
    ctx.strokeStyle = color;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(price));
    ctx.lineTo(W - padR, y(price));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${label} ${price.toFixed(2)}`, W - padR + 3, y(price) + 3);
  };
  lvl(plan.trigger, COLORS.trigger, 'TRIG');
  lvl(plan.stop, COLORS.stop, 'STOP');
  lvl(plan.target, COLORS.target, 'TGT');

  // pivots (matched by date where possible)
  const dateIdx = new Map(cs.map((c, i) => [String(c.date), i]));
  for (const p of (det && det.pivotsUsed) || []) {
    const i = dateIdx.get(String(p.date));
    if (i == null || typeof p.price !== 'number') continue;
    ctx.fillStyle = COLORS.pivot;
    ctx.beginPath();
    ctx.arc(x(i), y(p.price), 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // confirmation bar marker
  if (det && det.confirmation && det.confirmation.confirmBarDate) {
    const i = dateIdx.get(String(det.confirmation.confirmBarDate));
    if (i != null) {
      ctx.strokeStyle = det.confirmation.closedThrough ? COLORS.up : COLORS.text;
      ctx.strokeRect(x(i) - barW / 2 - 2, 6, barW + 4, priceH - 4);
    }
  }
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, monospace';
  const label = det ? `${det.patternLabel || ''} ${det.direction || ''} ${det.timeframe || ''}` : '';
  ctx.fillText(label, padL + 2, H - 2);
}
