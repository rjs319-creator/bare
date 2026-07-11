const { internalHeaders } = require('./auth');
// PREDICT-SUITE ROUTE HANDLERS — extracted from api/tracker.js to de-godfile it.
// Placed in lib/ (not api/) so Vercel does not treat it as its own endpoint;
// api/tracker.js imports these handlers and dispatches op=predict/brief/crowd/etc.
// Inline require('../lib/x') paths resolve correctly from lib/ ('../lib/x' = lib/x).
const { fetchDailyHistory } = require('./screener');
const { wilson } = require('./stats');
// (buildStudyEvents / summarizeCrowdStudy / CSTUDY_HORIZONS are required inline below)
const { writePredictDay, readAllPredictDays, hasStore,
        writePredmktDay, readAllPredmktDays, readSharpEvents, writeSharpEvents,
        writeBriefDay, readAllBriefDays, readNotifyFeed, writeNotifyFeed,
        writeCStudyDay, readAllCStudyDays } = require('./store');

// ── 🔮 FORECAST — modernized predictions (falsifiable, AUTO-resolved) ──────────
// Unlike the old manual "click correct" tracker, every prediction is measurable and
// resolved against real price data; the accuracy is honest, not self-graded.
async function buildPredictContext() {
  const { fetchMacro } = require('../lib/macro');
  const cf = require('../lib/confluence');
  const SEC = { XLK: 'Tech', XLF: 'Financials', XLE: 'Energy', XLV: 'Health Care', XLY: 'Cons Disc', XLP: 'Cons Staples', XLI: 'Industrials', XLU: 'Utilities', XLRE: 'Real Estate', XLB: 'Materials', XLC: 'Comm Svcs' };
  const spy = await fetchDailyHistory('SPY');
  let regime = 'neutral'; try { const m = await fetchMacro(); if (m) regime = m.regime; } catch {}
  const condition = spy ? cf.marketCondition(spy.candles, regime) : 'mixed';
  const asOf = spy ? spy.candles[spy.candles.length - 1].date : new Date().toISOString().slice(0, 10);
  const ret = (c, n) => (!c || c.length <= n) ? null : +((c[c.length - 1].close / c[c.length - 1 - n].close - 1) * 100).toFixed(1);
  const sectors = [];
  await Promise.all(Object.keys(SEC).map(async e => { try { const d = await fetchDailyHistory(e); if (d) sectors.push({ sector: SEC[e], etf: e, r1m: ret(d.candles, 21) }); } catch {} }));
  sectors.sort((a, b) => (b.r1m || 0) - (a.r1m || 0));
  return { asOf, regime, condition, spy1w: ret(spy && spy.candles, 5), spy1m: ret(spy && spy.candles, 21), sectors };
}
async function generatePredictions(ctx) {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const Anthropic = require('@anthropic-ai/sdk');
  const pr = require('../lib/predict');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const lead = ctx.sectors.slice(0, 3).map(s => `${s.sector} ${s.r1m > 0 ? '+' : ''}${s.r1m}%`).join(', ');
  const lag = ctx.sectors.slice(-3).map(s => `${s.sector} ${s.r1m > 0 ? '+' : ''}${s.r1m}%`).join(', ');
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1500, tools: [pr.PREDICT_TOOL], tool_choice: { type: 'tool', name: 'submit_predictions' },
      messages: [{ role: 'user', content: `Make 5 FALSIFIABLE market predictions for the next 1-3 weeks, each measurable against price data. Context as of ${ctx.asOf}: macro regime ${ctx.regime}, tape ${ctx.condition}; SPY ${ctx.spy1w > 0 ? '+' : ''}${ctx.spy1w}% past week, ${ctx.spy1m > 0 ? '+' : ''}${ctx.spy1m}% past month. Leading sectors (1mo): ${lead}. Lagging: ${lag}. Use subjects like SPY, QQQ, ^VIX, sector ETFs, or liquid stocks. Mix directions (up/down/outperform/underperform) and horizons (5/10/21 days). Be specific and honest about uncertainty.` }],
    });
    const tool = msg.content.find(b => b.type === 'tool_use');
    return (tool?.input?.items || []).filter(p => p.subject && p.direction && p.horizon).slice(0, 5);
  } catch { return []; }
}

// op=predict — live read: open predictions + the honest auto-graded track record.
async function runPredict(req, res) {
  const pr = require('../lib/predict');
  const { computeCalibration } = pr;
  const days = await readAllPredictDays();
  const all = []; days.forEach(dd => (dd.predictions || []).forEach(p => all.push({ ...p, regime: dd.regime, condition: dd.condition })));
  const open = all.filter(p => !p.status || p.status === 'pending').sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
  const resolved = all.filter(p => p.status === 'correct' || p.status === 'incorrect');
  const correct = resolved.filter(p => p.status === 'correct').length;
  const ci = wilson(correct, resolved.length);
  const byHorizon = {}; [5, 10, 21].forEach(h => { const a = resolved.filter(p => p.horizon === h); byHorizon[h] = { n: a.length, correct: a.filter(p => p.status === 'correct').length }; });
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    open: open.map(p => ({ id: p.id, text: p.text, claim: pr.claimLabel(p), subject: p.subject, horizon: p.horizon, confidence: p.confidence, rationale: p.rationale, date: p.date })),
    resolvedCount: resolved.length,
    accuracy: resolved.length ? Math.round((correct / resolved.length) * 100) : null,
    wilsonLo: resolved.length ? Math.round(ci.lo * 100) : null,
    recent: resolved.slice(-8).reverse().map(p => ({ text: p.text, claim: pr.claimLabel(p), status: p.status, actualPct: p.actualPct })),
    byHorizon, calibration: computeCalibration(resolved),
    lastGenerated: days.length ? days[days.length - 1].date : null, generatedAt: new Date().toISOString(),
  });
}

// op=predicttick — cron: resolve matured predictions, then generate a fresh weekly batch.
async function runPredictTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const pr = require('../lib/predict');
  const t0 = Date.now();
  try {
    const days = await readAllPredictDays();
    // 1) Resolve matured predictions.
    const subjects = new Set(['SPY']); days.forEach(dd => (dd.predictions || []).forEach(p => { if (!p.status || p.status === 'pending') subjects.add(p.subject); }));
    const subjList = [...subjects]; const cand = new Map(); let i = 0;
    const rw = async () => { while (i < subjList.length) { if (Date.now() - t0 > 15000) return; const s = subjList[i++]; try { const d = await fetchDailyHistory(s); if (d) cand.set(s, d.candles); } catch {} } };
    await Promise.all(Array.from({ length: 8 }, rw));
    const spy = cand.get('SPY') || [];
    let resolvedNow = 0; const changed = new Set();
    for (const dd of days) for (const p of (dd.predictions || [])) {
      if (p.status && p.status !== 'pending') continue;
      const subj = cand.get(p.subject); if (!subj) continue;
      const r = pr.resolvePrediction(p, subj, spy); if (!r) continue;
      p.status = r.status; p.actualPct = r.actualPct; p.excPct = r.excPct; p.exitDate = r.exitDate; resolvedNow++; changed.add(dd.date);
    }
    await Promise.all([...changed].map(dt => { const dd = days.find(x => x.date === dt); return writePredictDay(dt, { regime: dd.regime, condition: dd.condition, predictions: dd.predictions }); }));

    // 2) Generate a fresh batch weekly (≥6 days since the last one).
    let generated = 0, genDate = null;
    const lastGen = days.length ? days[days.length - 1].date : null;
    const stale = !lastGen || (Date.now() - Date.parse(lastGen + 'T00:00:00Z')) / 86400000 >= 6;
    if (stale && (req.query.gen !== '0')) {
      const ctx = await buildPredictContext();
      const preds = await generatePredictions(ctx);
      if (preds.length && ctx.asOf !== lastGen) {
        const stamped = preds.map((p, idx) => ({ id: ctx.asOf + '-' + idx, date: ctx.asOf, status: 'pending', ...p }));
        await writePredictDay(ctx.asOf, { regime: ctx.regime, condition: ctx.condition, predictions: stamped });
        generated = stamped.length; genDate = ctx.asOf;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, resolvedNow, generated, genDate, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// ── 🎲 CROWD — scan real-money prediction markets for UNUSUAL activity ─────────
// Kalshi + Polymarket macro/equity contracts: volume bursts + sharp odds swings.
// A crowd-sentiment radar, not a proven edge (see the trust badge in the UI).
const todayUTC = () => new Date().toISOString().slice(0, 10);

// Append new alerts to the durable feed (dedup by id, newest first, rolling cap).
async function emitAlerts(newItems) {
  if (!newItems || !newItems.length) return 0;
  const feed = await readNotifyFeed().catch(() => ({ items: [] }));
  const items = feed.items || [];
  const have = new Set(items.map(i => i.id));
  let added = 0;
  for (const it of newItems) {
    if (!it || have.has(it.id)) continue;
    items.unshift({ ts: new Date().toISOString(), ...it });
    have.add(it.id); added++;
  }
  if (added) { feed.items = items.slice(0, 80); await writeNotifyFeed(feed); }
  return added;
}

// op=crowd — live read: scored markets (unusual first) + baseline status.
async function runCrowd(req, res) {
  const pm = require('../lib/predmarkets');
  try {
    const [k, p, days, evLog, cdays] = await Promise.all([
      pm.fetchKalshi().catch(() => []),
      pm.fetchPolymarket().catch(() => []),
      readAllPredmktDays().catch(() => []),
      readSharpEvents().catch(() => ({ events: [] })),
      readAllCStudyDays().catch(() => []),
    ]);
    const today = todayUTC();
    const all = [...k, ...p];
    const baseline = pm.buildBaseline(days, today);
    const prevOI = pm.buildPrevOI(days, today);
    const baselineDays = days.filter(d => d.date !== today).length;
    const scored = pm.scoreMarkets(all, baseline);
    const unusual = scored.filter(m => m.unusual);
    const sharpScored = pm.scoreSharp(all, baseline, prevOI);
    const sharp = sharpScored.filter(m => m.sharpFlag);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.json({
      ok: true,
      unusual: unusual.slice(0, 20),
      top: scored.slice(0, 25),
      sharp: sharp.slice(0, 20),
      sharpTop: sharpScored.slice(0, 12),
      recentEvents: (evLog.events || []).slice(0, 15),
      sharpValidation: pm.summarizeSharpValidation(evLog.events || []),
      crowdStudy: summarizeCrowdStudy(cdays),
      counts: { kalshi: k.length, polymarket: p.length, scanned: scored.length, unusual: unusual.length, sharp: sharp.length },
      baselineDays, baselineReady: baselineDays >= 3, oiBaseline: Object.keys(prevOI).length > 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e) });
  }
}

// Dedup-merge flagged sharp markets into the rolling event log (one entry per
// market per day; refreshes peak score / notional while the flag persists).
async function logSharpEvents(flagged, today) {
  if (!flagged.length) return { added: 0, updated: 0 };
  const log = await readSharpEvents();
  const events = log.events || [];
  const byKey = new Map(events.map(e => [e.id + '|' + e.date, e]));
  let added = 0, updated = 0; const now = new Date().toISOString();
  for (const m of flagged) {
    const key = m.id + '|' + today, ex = byKey.get(key);
    if (ex) {
      ex.lastSeen = now; ex.peakSharp = Math.max(ex.peakSharp || 0, m.sharp);
      ex.notional = Math.max(ex.notional || 0, m.notional); ex.prob = m.prob; ex.tells = m.tells; updated++;
    } else {
      const e = { id: m.id, date: today, venue: m.venue, title: m.title, group: m.group, sharp: m.sharp, peakSharp: m.sharp,
        notional: m.notional, prob: m.prob, side: m.side, daysToClose: m.daysToClose, tells: m.tells, url: m.url, firstSeen: now, lastSeen: now };
      events.unshift(e); byKey.set(key, e); added++;
    }
  }
  log.events = events.slice(0, 120);   // rolling cap
  await writeSharpEvents(log);
  return { added, updated };
}

// Resolve settled Kalshi sharp events against their actual outcome (did the bet's
// side win?). Only attempts events likely past settlement, within a time budget.
async function resolveSharpEvents(pm, deadlineMs) {
  const log = await readSharpEvents();
  const evs = log.events || [];
  const now = Date.now();
  const pending = evs.filter(e => !e.outcome && e.venue === 'Kalshi'
    && (!e.daysToClose || now >= Date.parse(e.date + 'T00:00:00Z') + (e.daysToClose + 1) * 86400000));
  let i = 0, resolved = 0;
  const worker = async () => {
    while (i < pending.length) {
      if (Date.now() > deadlineMs) return;
      const e = pending[i++];
      const r = await pm.fetchKalshiResult(e.id);
      if (r) { e.outcome = r.result; e.hit = (r.result === String(e.side || '').toLowerCase()); e.resolvedAt = new Date().toISOString(); resolved++; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (resolved) await writeSharpEvents(log);
  return resolved;
}

// ── CROWD-LEADS STUDY — pure logic in lib/cstudy.js; resolution (store + fetch)
// stays here. Does a themed crowd swing precede the implicated sector's move? ────
const { CSTUDY_HORIZONS, buildStudyEvents, summarizeCrowdStudy } = require('../lib/cstudy');

// Grade matured study events against the implicated sector's forward return.
async function resolveCrowdStudy(deadlineMs) {
  const days = await readAllCStudyDays();
  const events = days.flatMap(d => d.events || []);
  const open = events.filter(e => CSTUDY_HORIZONS.some(h => !e.grades || !e.grades[h]));
  if (!open.length) return 0;
  const etfs = [...new Set(open.map(e => e.etf))];
  const candByEtf = {};
  await Promise.all(etfs.map(async e => { if (Date.now() > deadlineMs) return; try { const d = await fetchDailyHistory(e); if (d) candByEtf[e] = d.candles; } catch {} }));
  const idxOnOrAfter = (c, date) => { for (let i = 0; i < c.length; i++) if (c[i].date >= date) return i; return -1; };
  let graded = 0; const changed = new Set();
  for (const e of open) {
    const c = candByEtf[e.etf]; if (!c) continue;
    const ai = idxOnOrAfter(c, e.date); if (ai < 0) continue;
    for (const h of CSTUDY_HORIZONS) {
      if (e.grades && e.grades[h]) continue;
      const bi = ai + h; if (bi >= c.length) continue;
      const ret = (c[bi].close / c[ai].close - 1) * 100;
      e.grades = e.grades || {}; e.grades[h] = { ret: +ret.toFixed(2), hit: (ret > 0 ? 1 : -1) === e.dir };
      graded++; changed.add(e.date);
    }
  }
  await Promise.all([...changed].map(dt => { const d = days.find(x => x.date === dt); return writeCStudyDay(dt, { events: d.events }); }));
  return graded;
}

// op=crowdtick — cron: snapshot today's volume+OI (baseline) AND durably log any
// flagged sharp-money events, so flags are captured even when nobody's watching.
async function runCrowdTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const pm = require('../lib/predmarkets');
  const t0 = Date.now();
  try {
    const [k, p, days] = await Promise.all([
      pm.fetchKalshi().catch(() => []),
      pm.fetchPolymarket().catch(() => []),
      readAllPredmktDays().catch(() => []),
    ]);
    const all = [...k, ...p];
    const today = todayUTC();
    // 1) snapshot today's 24h volume + open interest (builds the baselines)
    const snap = {};
    for (const m of all) if (m.vol24 > 0) snap[m.id] = { v: +m.vol24.toFixed(2), oi: m.oi ? +m.oi.toFixed(2) : 0 };
    await writePredmktDay(today, { snap, n: Object.keys(snap).length });
    // 2) score sharp against the PRIOR baseline + log any flagged events (always-on)
    const baseline = pm.buildBaseline(days, today);
    const prevOI = pm.buildPrevOI(days, today);
    const flagged = pm.scoreSharp(all, baseline, prevOI).filter(m => m.sharpFlag);
    const logged = await logSharpEvents(flagged, today);
    // 3) emit alerts — every flagged sharp bet + the single biggest macro crowd swing
    const { classifyMkt } = require('../lib/brief');
    const alerts = flagged.map(m => ({
      id: 'sharp|' + m.id + '|' + today, type: 'sharp', sev: 'high', go: 'sharp',
      title: '🕵️ Sharp money: ' + m.title, detail: (m.tells || []).slice(0, 2).join(' · ') + ' · ~$' + m.notional,
    }));
    const scored = pm.scoreMarkets(all, baseline);
    const swing = scored.filter(m => {
      if (m.movePts < 18 || !classifyMkt(m.title)) return false;          // big macro move
      const notion = m.venue === 'Polymarket' ? m.vol24 : m.vol24 * (m.prob || 0.5);
      if (notion < 1000) return false;                                    // real money, not a thin strike
      const days = m.closeTime ? (Date.parse(m.closeTime) - Date.now()) / 86400000 : 999;
      return days <= 120;                                                 // near-dated enough to matter
    }).sort((a, b) => b.movePts - a.movePts)[0];
    if (swing) alerts.push({
      id: 'crowd|' + swing.id + '|' + today, type: 'crowd', sev: 'med', go: 'crowd',
      title: '🎲 Crowd swing: ' + swing.title, detail: `odds ${swing.prob > swing.probPrev ? 'rising' : 'falling'} ${Math.round(swing.movePts)}pts → ${Math.round((swing.prob || 0) * 100)}%`,
    });
    const alerted = await emitAlerts(alerts);
    // 4) resolve any settled sharp events against their real outcome (validation)
    const resolved = await resolveSharpEvents(pm, t0 + 18000).catch(() => 0);
    // 5) crowd-leads study — log qualifying themed swings, then grade matured ones
    const studyEvents = buildStudyEvents(scored, today);
    if (studyEvents.length) {
      const cdays = await readAllCStudyDays().catch(() => []);
      const existing = (cdays.find(d => d.date === today) || {}).events || [];
      const have = new Set(existing.map(e => e.id));
      const merged = existing.concat(studyEvents.filter(e => !have.has(e.id)));
      if (merged.length !== existing.length) await writeCStudyDay(today, { events: merged });
    }
    const studyGraded = await resolveCrowdStudy(t0 + 24000).catch(() => 0);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, date: today, snapshot: Object.keys(snap).length, kalshi: k.length, polymarket: p.length, flagged: flagged.length, logged, alerted, resolved, studyLogged: studyEvents.length, studyGraded, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// ── 🧭 PREDICTION BRIEF — synthesis + forward validation against SPY ────────────
// Gathers the three Predict signals (reusing their cached endpoints), synthesizes
// one stance, and tracks whether that stance actually precedes SPY moves.
async function gatherBriefInputs(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = 'https://' + host + '/api/tracker?op=';
  const get = op => fetch(base + op, { headers: internalHeaders() }).then(r => r.json()).catch(() => null);
  const [predict, crowd, tape] = await Promise.all([get('predict'), get('crowd'), get('tape')]);
  return { predict, crowd, tape };
}

// op=brief — live synthesis + the forward-validation track record.
async function runBrief(req, res) {
  const { computeBrief, summarizeValidation } = require('../lib/brief');
  try {
    const { predict, crowd, tape } = await gatherBriefInputs(req);
    const brief = computeBrief(predict, crowd, tape);
    const [days, spyDoc] = await Promise.all([readAllBriefDays().catch(() => []), fetchDailyHistory('SPY').catch(() => null)]);
    const validation = summarizeValidation(days, spyDoc && spyDoc.candles);
    validation.logged = days.length;
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
    return res.json({ ok: true, ...brief, validation, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e) });
  }
}

// op=alertfeed — read the durable Predict alerts feed (UI consumes; cron writes it).
async function runAlertFeed(req, res) {
  const feed = await readNotifyFeed().catch(() => ({ items: [] }));
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=86400');
  return res.json({ ok: true, items: (feed.items || []).slice(0, 50), generatedAt: new Date().toISOString() });
}

// op=brieftick — cron: log today's stance (with SPY close) + resolve matured days.
async function runBriefTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const { computeBrief, summarizeValidation } = require('../lib/brief');
  const t0 = Date.now();
  try {
    const { predict, crowd, tape } = await gatherBriefInputs(req);
    const b = computeBrief(predict, crowd, tape);
    const spyDoc = await fetchDailyHistory('SPY').catch(() => null);
    const spy = (spyDoc && spyDoc.candles) || [];
    const asOf = spy.length ? spy[spy.length - 1].date : new Date().toISOString().slice(0, 10);
    const days = await readAllBriefDays().catch(() => []);
    let logged = false, alerted = 0;
    if (!days.some(d => d.date === asOf)) {
      await writeBriefDay(asOf, {
        consensus: b.consensus, fcLean: b.fcLean, crowdLean: b.crowdLean, sharpLean: b.sharpLean, regimeScore: b.regimeScore,
        stance: b.stance, regime: b.regime, cond: b.cond, spyClose: spy.length ? spy[spy.length - 1].close : null,
      });
      logged = true;
      // Alert on a stance FLIP (sign change vs the last logged day) — a rare, high-value event.
      const prev = days[days.length - 1];
      if (prev && prev.consensus !== b.consensus && b.consensus !== 0) {
        alerted = await emitAlerts([{ id: 'stance|' + asOf, type: 'stance', sev: 'high', go: 'brief',
          title: '🧭 Brief flipped to ' + b.stance, detail: `was "${prev.stance || '—'}" — the prediction layer changed direction` }]);
      }
    }
    const val = summarizeValidation(logged ? [...days, { date: asOf, consensus: b.consensus }] : days, spy);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, asOf, logged, alerted, stance: b.stance, resolvedDays: val.n, overall: val.overall, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// ── op=tape : the current MARKET CONDITION (shared badge across all screeners) ──
// Lightweight: one SPY read + macro → trending / choppy / mixed / risk-off, so every
// screener tab can show the same tape context (and adapt to it).
async function runTape(req, res) {
  const cf = require('../lib/confluence');
  const { fetchMacro } = require('../lib/macro');
  const spy = await fetchDailyHistory('SPY');
  let regime = 'neutral';
  try { const m = await fetchMacro(); if (m) regime = m.regime; } catch {}
  const cl = spy ? spy.candles.map(c => c.close) : [];
  const i = cl.length - 1;
  const er = (spy && i >= 63) ? cf.efficiencyRatio(cl, i, 63) : 0;
  let s200 = null; if (i >= 199) { let s = 0; for (let j = i - 199; j <= i; j++) s += cl[j]; s200 = s / 200; }
  const condition = spy ? cf.marketCondition(spy.candles, regime) : 'mixed';
  const spyChangePct = i >= 1 ? +((cl[i] / cl[i - 1] - 1) * 100).toFixed(2) : 0;
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, condition, regime, efficiency: +er.toFixed(2), spyChangePct,
    spyAbove200: s200 != null && cl[i] > s200, generatedAt: new Date().toISOString(),
  });
}

module.exports = { runPredict, runPredictTick, runCrowd, runCrowdTick, runBrief, runBriefTick, runTape, runAlertFeed };
