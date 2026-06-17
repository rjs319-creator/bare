const { analyze } = require('../lib/signal');

module.exports = async function handler(req, res) {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

  try {
    const result = await analyze(ticker);
    if (!result) return res.status(404).json({ error: 'No chart data' });
    res.setHeader('Cache-Control', 's-maxage=60'); // realtime-ish: refresh each minute
    return res.json(result);
  } catch (e) {
    return res.status(502).json({ error: 'Chart data unavailable: ' + e.message });
  }
};
