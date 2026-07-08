// LONG-TERM "SECOND OPINIONS" — four independent recommendation lenses shown next
// to the app's own custom long-term model (lib/longterm.js). The custom model is a
// trend + relative-strength composite; these add orthogonal reads so the user sees
// agreement/disagreement, the way a desk cross-checks a call:
//
//   • momentum   — pure trailing price return (3/6/12-month)
//   • technical  — classic daily indicator tally (MA structure, RSI, MACD)
//   • fundamental— growth + acceleration + margin trend (Finnhub metric=all)
//   • expert     — Wall-Street analyst recommendation consensus (Finnhub trends)
//
// Every lens is PURE (fetched data in → verdict out) so it's testable and can't
// fabricate a call: no data → rec:null (rendered as "n/a"), never a guess.

const { calcEMA, calcRSI, calcMACD } = require('./signal');

const RECS = ['Buy', 'Hold', 'Sell'];
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const last = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const sma = (closes, n) => (closes.length >= n ? avg(closes.slice(-n)) : null);
const pct1 = x => (x == null ? null : +x.toFixed(1));

// ── Momentum: absolute trailing return over 3 / 6 / 12 months ────────────────
function momentumRec(candles) {
  if (!candles || candles.length < 70) return { rec: null, score: null, detail: 'Not enough price history' };
  const closes = candles.map(c => c.close);
  const ret = n => (closes.length > n ? ((closes[closes.length - 1] - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]) * 100 : null);
  const r3 = ret(63), r6 = ret(126), r12 = ret(252);
  // Weighted blend (favor the 6–12mo window that defines the momentum factor).
  const parts = [[r3, 0.4], [r6, 0.35], [r12, 0.25]].filter(([v]) => v != null);
  const wsum = parts.reduce((s, [, w]) => s + w, 0) || 1;
  const mom = parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;
  const rec = mom > 5 ? 'Buy' : mom < -5 ? 'Sell' : 'Hold';
  const d = [r3 != null && `3mo ${r3 >= 0 ? '+' : ''}${pct1(r3)}%`, r6 != null && `6mo ${r6 >= 0 ? '+' : ''}${pct1(r6)}%`, r12 != null && `12mo ${r12 >= 0 ? '+' : ''}${pct1(r12)}%`].filter(Boolean).join(' · ');
  return { rec, score: +mom.toFixed(1), detail: d };
}

// ── Technical: classic daily indicator tally (MA structure, RSI, MACD) ───────
function technicalRec(candles) {
  if (!candles || candles.length < 60) return { rec: null, score: null, detail: 'Not enough price history' };
  const closes = candles.map(c => c.close);
  const px = closes[closes.length - 1];
  const s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rsi = last(calcRSI(closes, 14));
  const macd = calcMACD(closes);
  const macdBull = (() => { const l = last(macd.macdLine), s = last(macd.signalLine); return l != null && s != null ? l > s : null; })();

  let bull = 0, total = 0;
  const add = v => { if (v == null) return; total++; if (v) bull++; };
  add(s50 != null ? px > s50 : null);          // above the 50-day
  add(s200 != null ? px > s200 : null);        // above the 200-day
  add(s50 != null && s200 != null ? s50 > s200 : null); // golden-cross structure
  add(rsi != null ? (rsi > 50 && rsi < 72) : null);     // healthy momentum, not overbought
  add(macdBull);                                // MACD above signal
  if (!total) return { rec: null, score: null, detail: 'Indeterminate' };

  const rec = bull >= 4 ? 'Buy' : bull <= 1 ? 'Sell' : 'Hold';
  const detail = `${bull}/${total} daily signals bullish${rsi != null ? ` · RSI ${Math.round(rsi)}` : ''}${macdBull != null ? ` · MACD ${macdBull ? '+' : '−'}` : ''}`;
  return { rec, score: Math.round((bull / total) * 100), detail };
}

// ── Fundamental: growth + acceleration + margin trend (fetchFundamentals shape) ─
function fundamentalRec(fd) {
  if (!fd) return { rec: null, score: null, detail: 'No fundamentals available' };
  let net = 0, seen = 0;
  const vote = (v, pos) => { if (v == null) return; seen++; net += pos ? 1 : -1; };
  if (fd.revGrowth != null) vote(fd.revGrowth, fd.revGrowth > 0);
  if (fd.epsGrowth != null) vote(fd.epsGrowth, fd.epsGrowth > 0);
  if (fd.revAccel != null) vote(fd.revAccel, fd.revAccel > 0);      // 2nd derivative — accelerating?
  if (fd.marginExpanding != null) vote(fd.marginExpanding, fd.marginExpanding === true);
  if (!seen) return { rec: null, score: null, detail: 'No fundamentals available' };

  const rec = net >= 2 ? 'Buy' : net <= -2 ? 'Sell' : 'Hold';
  const bits = [];
  if (fd.revGrowth != null) bits.push(`Rev ${fd.revGrowth >= 0 ? '+' : ''}${pct1(fd.revGrowth)}%`);
  if (fd.epsGrowth != null) bits.push(`EPS ${fd.epsGrowth >= 0 ? '+' : ''}${pct1(fd.epsGrowth)}%`);
  if (fd.marginExpanding != null) bits.push(`margins ${fd.marginExpanding ? 'expanding' : 'compressing'}`);
  return { rec, score: net, detail: bits.join(' · ') || 'Mixed fundamentals' };
}

// ── Expert: Wall-Street analyst recommendation consensus (Finnhub trends) ─────
function expertRec(trend) {
  if (!trend) return { rec: null, score: null, detail: 'No analyst coverage' };
  const sb = +trend.strongBuy || 0, b = +trend.buy || 0, h = +trend.hold || 0, s = +trend.sell || 0, ss = +trend.strongSell || 0;
  const total = sb + b + h + s + ss;
  if (!total) return { rec: null, score: null, detail: 'No analyst coverage' };
  const buys = sb + b, sells = s + ss;
  const rec = (buys / total >= 0.55 && buys > sells) ? 'Buy' : (sells / total >= 0.4 || sells > buys) ? 'Sell' : 'Hold';
  const score = Math.round(((sb * 2 + b - s - ss * 2) / total) * 50); // -100..100
  return { rec, score, detail: `${total} analysts · ${buys} buy / ${h} hold / ${sells} sell` };
}

// ── Roll-up consensus across all provided lenses (custom + the four) ─────────
function consensusOf(recs) {
  const valid = recs.filter(r => r && RECS.includes(r));
  if (!valid.length) return { lean: null, buy: 0, hold: 0, sell: 0, n: 0 };
  const buy = valid.filter(r => r === 'Buy').length;
  const hold = valid.filter(r => r === 'Hold').length;
  const sell = valid.filter(r => r === 'Sell').length;
  const lean = buy > hold && buy > sell ? 'Buy' : sell > hold && sell > buy ? 'Sell' : 'Hold';
  return { lean, buy, hold, sell, n: valid.length };
}

module.exports = { momentumRec, technicalRec, fundamentalRec, expertRec, consensusOf, RECS };
