// X-ALERTS ROUTE HANDLERS (Twitter/X trade-alert ingest + grading) — extracted
// from api/tracker.js. Separate 'alerts/' Blob namespace; self-contained.
const alerts = require('./alerts');
const alertsFable = require('./alerts-fable');
const { fetchDailyHistory } = require('./screener');
const { hasStore, readJSON, writeJSON } = require('./store');
const { requireMethod, ingestAuthorized } = require('./auth');

const ALERTS = { RAW: 'alerts/raw.json', RANKED: 'alerts/ranked.json', LOG: 'alerts/log.json', RECORD: 'alerts/record.json', EDGE: 'alerts/edge.json', ASSESS: 'alerts/assess.json' };
const RAW_TTL_MS = 48 * 3600 * 1000, RAW_CAP = 600;

// POST raw posts → dedup/cluster/rank/log. Optional shared-secret via header.
async function runAlertsIngest(req, res) {
  if (!requireMethod(req, res, ['POST'])) return;
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!ingestAuthorized(req, 'ALERTS_INGEST_TOKEN')) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (req.query.reset === '1') {  // wipe the alert store (start a clean real feed)
    await writeJSON(ALERTS.RAW, { posts: [] }); await writeJSON(ALERTS.RANKED, { ranked: [] });
    await writeJSON(ALERTS.LOG, []); await writeJSON(ALERTS.RECORD, {}); await writeJSON(ALERTS.EDGE, { n: 0, edge: false, verdict: 'INSUFFICIENT DATA (0/50 graded directional alerts)', minGraded: 50 });
    await writeJSON(ALERTS.ASSESS, { assessments: {}, generatedAt: null, model: alertsFable.MODEL });
    return res.status(200).json({ ok: true, reset: true });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const incoming = (body && Array.isArray(body.posts)) ? body.posts : null;
  if (!incoming) return res.status(400).json({ ok: false, error: 'expected JSON { posts: [{text, account, timestamp}] }' });

  const now = Date.now();
  // Rolling raw buffer: append, dedupe exact (text|account), drop stale, cap.
  const rawDoc = (await readJSON(ALERTS.RAW, { posts: [] })) || { posts: [] };
  const seen = new Set(rawDoc.posts.map(p => (p.account || '') + '|' + (p.text || '')));
  let added = 0;
  for (const p of incoming) {
    if (!p || !p.text) continue;
    const k = (p.account || '') + '|' + p.text;
    if (seen.has(k)) continue;
    seen.add(k);
    rawDoc.posts.push({ text: String(p.text).slice(0, 600), account: p.account || '?', timestamp: p.timestamp || new Date(now).toISOString() });
    added++;
  }
  rawDoc.posts = rawDoc.posts.filter(p => { const t = Date.parse(p.timestamp); return isNaN(t) || now - t <= RAW_TTL_MS; }).slice(-RAW_CAP);
  rawDoc.updatedAt = new Date(now).toISOString();

  const record = (await readJSON(ALERTS.RECORD, {})) || {};
  const ranked = alerts.rankPosts(rawDoc.posts, record, now);

  // Log first appearance of each directional alert per account per day (for grading).
  const log = (await readJSON(ALERTS.LOG, [])) || [];
  const logKeys = new Set(log.map(e => `${e.ticker}|${e.direction}|${e.account}|${e.logged_at.slice(0, 10)}`));
  const today = new Date(now).toISOString().slice(0, 10);
  for (const r of ranked) {
    if (r.direction === 'neutral' || r.coordinated) continue; // don't grade coordinated pumps
    for (const acct of r.accounts) {
      const k = `${r.ticker}|${r.direction}|${acct}|${today}`;
      if (logKeys.has(k)) continue;
      logKeys.add(k);
      log.push({ ticker: r.ticker, direction: r.direction, account: acct, weightedSignal: r.weightedSignal, score: r.score, logged_at: new Date(now).toISOString(), graded: false, excess: null });
    }
  }

  await writeJSON(ALERTS.RAW, rawDoc);
  await writeJSON(ALERTS.RANKED, { ranked, generatedAt: rawDoc.updatedAt, bufferSize: rawDoc.posts.length });
  await writeJSON(ALERTS.LOG, log);
  return res.status(200).json({ ok: true, received: incoming.length, added, bufferSize: rawDoc.posts.length, ranked: ranked.length, logged: log.length });
}

// GET current ranked alerts + cached edge verdict + Fable review layer + status.
async function runAlerts(req, res) {
  if (!hasStore()) return res.json({ configured: false, ranked: [], note: 'Blob storage not configured.' });
  const rankedDoc = (await readJSON(ALERTS.RANKED, null));
  const edge = (await readJSON(ALERTS.EDGE, null));
  const log = (await readJSON(ALERTS.LOG, [])) || [];
  const assessDoc = (await readJSON(ALERTS.ASSESS, null));

  // Fable review layer: annotate each card with the AI read, run the A/B report,
  // and — once Fable's directional call is PROVEN better than the keyword bot —
  // let it drive ranking + filtering (Phase 2 of "both, gated").
  const baseRanked = rankedDoc ? rankedDoc.ranked : [];
  const fableEdge = alertsFable.fableEdgeReport(log);
  const withAi = alertsFable.mergeAssessments(baseRanked, assessDoc);
  const ranked = alertsFable.applyPromotion(withAi, fableEdge.promoted);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  return res.json({
    configured: true,
    ranked,
    generatedAt: rankedDoc ? rankedDoc.generatedAt : null,
    bufferSize: rankedDoc ? rankedDoc.bufferSize : 0,
    loggedTotal: log.length,
    gradedTotal: log.filter(e => e.graded).length,
    edge,
    fableEdge,
    aiAssessedAt: assessDoc ? assessDoc.generatedAt : null,
    aiPromoted: fableEdge.promoted,
    aiNotes: assessDoc ? assessDoc.notes : null,
  });
}

// Run the bounded Fable-5 review over the current top ranked alerts, cache it,
// and STAMP the pending log entries with Fable's direction/confidence so the A/B
// grader can later prove whether Fable beats the keyword bot. Triggered by the
// warm cron (hands-off); no-ops gracefully without an API key or ranked data.
async function runAlertsAssess(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not set — Fable review disabled.' });
  const rankedDoc = (await readJSON(ALERTS.RANKED, null));
  const ranked = (rankedDoc && rankedDoc.ranked) || [];
  if (!ranked.length) return res.status(200).json({ ok: true, assessed: 0, note: 'no ranked alerts to review' });

  const parsed = await alertsFable.assessAlerts(ranked);
  if (!parsed) return res.status(200).json({ ok: false, error: 'Fable call failed or returned no tool output (kept prior assessment).' });

  const now = new Date().toISOString();
  const assessDoc = { assessments: parsed.assessments, notes: parsed.notes, generatedAt: now, model: alertsFable.MODEL, count: Object.keys(parsed.assessments).length };
  await writeJSON(ALERTS.ASSESS, assessDoc);

  // Stamp UNGRADED log entries with the current Fable read for their ticker (A/B).
  const log = (await readJSON(ALERTS.LOG, [])) || [];
  let stamped = 0;
  for (const e of log) {
    if (e.graded) continue;                              // don't rewrite a call after the fact
    const a = parsed.assessments[String(e.ticker).toUpperCase()];
    if (!a) continue;
    if (e.aiDirection === a.direction && e.aiConfidence === a.confidence) continue;
    e.aiDirection = a.direction; e.aiConfidence = a.confidence; e.aiCredibility = a.credibility; e.aiPumpRisk = a.pumpRisk;
    stamped++;
  }
  if (stamped) await writeJSON(ALERTS.LOG, log);

  return res.status(200).json({ ok: true, assessed: assessDoc.count, stampedLogEntries: stamped, model: alertsFable.MODEL, at: now });
}

// Grade matured log entries on forward excess return; update record + edge report.
async function runAlertsGrade(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const log = (await readJSON(ALERTS.LOG, [])) || [];
  const record = (await readJSON(ALERTS.RECORD, {})) || {};
  const hold = alerts.CFG.gradeHoldDays;
  const pending = log.filter(e => !e.graded && e.direction !== 'neutral');
  const tickers = [...new Set(pending.map(e => e.ticker))];
  let spy = null; try { const d = await fetchDailyHistory('SPY'); if (d) spy = d.candles; } catch {}
  const hist = new Map();
  let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  let graded = 0;
  if (spy) for (const e of pending) {
    const c = hist.get(e.ticker); if (!c) continue;
    const ex = alerts.gradeExcess(c, spy, e.logged_at.slice(0, 10), hold);
    if (ex == null) continue;
    e.excess = ex; e.graded = true;
    const hit = e.direction === 'bullish' ? ex > 0 : ex < 0;
    const s = record[e.account] || (record[e.account] = { hits: 0, total: 0 });
    s.total++; s.hits += hit ? 1 : 0;
    graded++;
  }
  const edge = alerts.analyzeEdge(log);
  edge.generatedAt = new Date().toISOString();
  if (graded) { await writeJSON(ALERTS.LOG, log); await writeJSON(ALERTS.RECORD, record); }
  await writeJSON(ALERTS.EDGE, edge);
  return res.status(200).json({ ok: true, gradedThisRun: graded, totalGraded: log.filter(e => e.graded).length, edge });
}

module.exports = { runAlertsIngest, runAlerts, runAlertsGrade, runAlertsAssess };
