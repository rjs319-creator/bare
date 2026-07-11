// Canonical trade-outcome resolution — shared by the live ledger and the
// historical backfill so both measure the SAME thing: trading a signal at its
// OWN stop/target levels (the levels shown on the card), not a fixed % barrier.
//
//   WIN     — the day's high reaches `target` before the day's low reaches `stop`
//   LOSS    — `stop` is hit first
//   EXPIRED — neither within `maxHold` sessions (won = final return > 0)
//   OPEN    — fewer than `maxHold` sessions have elapsed and neither level hit
//
// R is the ACTUAL realized return at the level — so profit factor reflects each
// setup's true reward:risk, not an assumed one.
const MAX_HOLD = 63;                                // trading sessions (≈3 months)
const FALLBACK_TARGET = 0.20, FALLBACK_STOP = 0.08; // used only when a signal lacks valid levels

// candles: [{date,high,low,close}] oldest→newest. fromDate: signal date (entry on/after).
// `short` inverts the geometry for short setups: target is BELOW entry (profit when
// price falls) and stop is ABOVE. The long path (default) is byte-for-byte unchanged
// so every existing caller behaves identically. r is the realized fraction either way
// (positive = the setup made money). Same-bar ambiguity resolves to the STOP
// (conservative) in both directions.
function resolveTrade(candles, fromDate, entry, stop, target, maxHold = MAX_HOLD, short = false) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date >= fromDate) { idx = k; break; } }
  if (idx < 0) return { outcome: 'OPEN' };
  const e = entry || candles[idx].close;
  if (!(e > 0)) return { outcome: 'OPEN' };
  if (short) {
    const tgt = (target > 0 && target < e) ? target : e * (1 - FALLBACK_TARGET); // below entry
    const stp = (stop > e) ? stop : e * (1 + FALLBACK_STOP);                     // above entry
    for (let h = 1; h <= maxHold && idx + h < candles.length; h++) {
      const c = candles[idx + h];
      if (c.high >= stp) return { outcome: 'LOSS', r: (e - stp) / e, hold: h, exitDate: c.date }; // stop first (conservative)
      if (c.low <= tgt) return { outcome: 'WIN', r: (e - tgt) / e, hold: h, exitDate: c.date };
    }
    if (candles.length - 1 - idx >= maxHold) {
      const j = idx + maxHold;
      return { outcome: 'EXPIRED', r: (e - candles[j].close) / e, hold: maxHold, exitDate: candles[j].date };
    }
    return { outcome: 'OPEN' };
  }
  const tgt = (target > e) ? target : e * (1 + FALLBACK_TARGET);
  const stp = (stop > 0 && stop < e) ? stop : e * (1 - FALLBACK_STOP);
  for (let h = 1; h <= maxHold && idx + h < candles.length; h++) {
    const c = candles[idx + h];
    if (c.low <= stp) return { outcome: 'LOSS', r: (stp - e) / e, hold: h, exitDate: c.date };  // stop first (conservative)
    if (c.high >= tgt) return { outcome: 'WIN', r: (tgt - e) / e, hold: h, exitDate: c.date };
  }
  if (candles.length - 1 - idx >= maxHold) {
    const j = idx + maxHold;
    return { outcome: 'EXPIRED', r: (candles[j].close - e) / e, hold: maxHold, exitDate: candles[j].date };
  }
  return { outcome: 'OPEN' };
}

module.exports = { resolveTrade, MAX_HOLD, FALLBACK_TARGET, FALLBACK_STOP };
