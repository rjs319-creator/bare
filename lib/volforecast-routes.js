'use strict';
// 🔊 op=volforecast — next-session volume/capacity forecast for ONE ticker.
//
// Bounded read (one candle fetch), public. Execution context ONLY: the payload
// carries its own disclaimer that a volume forecast is never directional evidence
// (this repo measured raw volume-surge at rank-IC ≈ −0.004 and weights it zero).

const { fetchDailyHistory } = require('./screener');
const { forecastNextSession, VOLUME_FORECAST_VERSION } = require('./volume-forecast');

async function runVolForecast(req, res) {
  const ticker = String(req.query.ticker || '').toUpperCase().trim();
  if (!/^[A-Z.^-]{1,8}$/.test(ticker)) {
    return res.status(400).json({ ok: false, error: 'missing or invalid ?ticker=' });
  }
  try {
    const hist = await fetchDailyHistory(ticker, '1y');
    const candles = (hist && hist.candles) || [];
    if (!candles.length) return res.status(200).json({ ok: false, ticker, error: 'no-candles' });
    const forecast = forecastNextSession(candles, {});
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=120');
    return res.status(200).json({
      ok: true, ticker, version: VOLUME_FORECAST_VERSION, forecast,
      honesty: 'Activity/capacity forecast for execution planning. NOT a directional signal — high expected volume is not a buy reason.',
    });
  } catch (e) {
    return res.status(200).json({ ok: false, ticker, error: String((e && e.message) || e) });
  }
}

module.exports = { runVolForecast };
