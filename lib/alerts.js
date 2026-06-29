// Trade-alert trend ranker — Node port of the validated Python tool. The
// fragile/heavy SCRAPING lives in an external collector (a browser box) that
// POSTs raw posts to /api/tracker?op=alertsingest; everything here is pure
// computation: dedup, coordination clustering, per-ticker direction, ranking,
// excess-return grading, and the edge harness (rank-IC / Wilson, refuses to
// declare edge on small samples). Mirrors trade_alert_ranker.py 1:1.

const CFG = {
  decayHalfLifeHours: 6.0,
  dedupSimilarity: 0.85,
  coordSimilarity: 0.90,
  coordWindowMinutes: 60,
  coordMinAccounts: 3,
  gradeHoldDays: 3,
  minGradedForEdge: 50,
};

const ALERT_KEYWORDS = ['alert', 'entry', 'bought', 'buying', 'sold', 'selling', 'long', 'short',
  'calls', 'puts', 'breakout', 'target', 'stop loss', 'sweep', 'unusual options', 'added', 'trimmed', 'position'];
const BULLISH_W = { calls: 3, long: 3, bought: 2, buying: 2, breakout: 2, added: 1, entry: 1 };
const BEARISH_W = { puts: 3, short: 3, sold: 2, selling: 2, trimmed: 1 };

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wb = w => new RegExp('\\b' + esc(w) + '\\b', 'i');
const ALERT_RX = ALERT_KEYWORDS.map(wb);
const BULL_RX = Object.entries(BULLISH_W).map(([k, v]) => [wb(k), v]);
const BEAR_RX = Object.entries(BEARISH_W).map(([k, v]) => [wb(k), v]);
const TICKER_RE = /\$([A-Z]{1,5})\b/g;

// ── text similarity (Python difflib.SequenceMatcher.ratio() ≈ Dice on matching blocks).
// A lightweight ratio good enough for near-duplicate detection.
function normalize(text) {
  return String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9$ ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function similar(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // token Jaccard — robust and fast for short posts
  const sa = new Set(a.split(' ')), sb = new Set(b.split(' '));
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

const decayWeight = (postedMs, nowMs) => {
  if (!postedMs) return 0.5;
  const ageH = Math.max((nowMs - postedMs) / 3.6e6, 0);
  return Math.pow(0.5, ageH / CFG.decayHalfLifeHours);
};
function accountWeight(handle, record) {
  const s = record[handle] || { hits: 0, total: 0 };
  return 0.5 + (s.hits + 5) / (s.total + 10); // Bayesian prior 50% → weight [0.5,1.5], new=1.0
}

// Within-account near-duplicate removal (copy/paste spam); cross-account kept.
function dedup(posts) {
  const seen = {}; const out = [];
  for (const p of posts) {
    const norm = normalize(p.text); if (!norm) continue;
    const acct = p.account || '?';
    (seen[acct] = seen[acct] || []);
    if (seen[acct].some(k => similar(norm, k) >= CFG.dedupSimilarity)) continue;
    seen[acct].push(norm); out.push({ ...p, _norm: norm });
  }
  return out;
}

// Coordination clusters: near-identical text across DIFFERENT accounts within the
// time window → one cluster (collapsed to a single independent source).
function clusterPosts(posts) {
  const n = posts.length, parent = posts.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const tsMs = posts.map(p => p.timestamp ? Date.parse(p.timestamp) : NaN);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (posts[i].account === posts[j].account) continue;
    if (similar(posts[i]._norm, posts[j]._norm) < CFG.coordSimilarity) continue;
    if (!isNaN(tsMs[i]) && !isNaN(tsMs[j]) && Math.abs(tsMs[i] - tsMs[j]) / 6e4 > CFG.coordWindowMinutes) continue;
    parent[find(i)] = find(j);
  }
  return posts.map((_, i) => find(i));
}

const isAlert = lower => ALERT_RX.some(rx => rx.test(lower));
function scoreSegment(seg) {
  let b = 0, s = 0;
  for (const [rx, w] of BULL_RX) if (rx.test(seg)) b += w;
  for (const [rx, w] of BEAR_RX) if (rx.test(seg)) s += w;
  return b > s ? 'bullish' : s > b ? 'bearish' : 'neutral';
}
function tickerDirections(text) {
  const ms = [...text.matchAll(TICKER_RE)];
  if (!ms.length) return [];
  const lower = text.toLowerCase();
  if (ms.length === 1) return [[ms[0][1], scoreSegment(lower)]];
  const out = [];
  for (let i = 0; i < ms.length; i++) {
    const a = i > 0 ? Math.floor((ms[i - 1].index + ms[i - 1][0].length + ms[i].index) / 2) : 0;
    const b = i + 1 < ms.length ? Math.floor((ms[i].index + ms[i][0].length + ms[i + 1].index) / 2) : text.length;
    out.push([ms[i][1], scoreSegment(lower.slice(a, b))]);
  }
  return out;
}

// ── Mining richer signal out of a post's text (the "more useful info" layer) ──
// Everything here is derived from the post TEXT we already collect — no new feed.
// Catalyst/thesis tags (WHY the call is being made), conviction intensity (HOW
// strongly), and any price levels / options / timeframe the trader stated.
const CATALYST_TAGS = [
  ['earnings',  /\b(earnings|eps|guidance|beat|results|report(?:s|ing|ed)?|\ber\b)\b/i],
  ['fda',       /\b(fda|pdufa|approval|phase\s?[123]|trial|clinical|readout|data)\b/i],
  ['breakout',  /\b(break\s?out|breaking out|new high|all[- ]?time high|\bath\b|52[- ]?w(?:eek)?\s?high|cup and handle)\b/i],
  ['squeeze',   /\b(squeeze|gamma|short interest|low float|\bftd\b|short\s?seller)\b/i],
  ['m&a',       /\b(merger|acquisition|buyout|takeover|acquir(?:e|ed|es)|\bdeal\b|rumou?r)\b/i],
  ['analyst',   /\b(upgrade|downgrade|price target|\bpt\b|initiat(?:e|ed|ion)|reiterat|overweight|outperform)\b/i],
  ['insider',   /\b(insider|buyback|repurchase|form\s?4)\b/i],
  ['technical', /\b(support|resistance|trend(?:line)?|\bmacd\b|\brsi\b|\bvwap\b|moving average|\bfib\b|flag|wedge)\b/i],
];
// Intensity language + emoji → 0-100 (separate from direction). "all in 🚀🚀" is
// high conviction; "watching" is low.
const STRONG_RX = [
  [/\b(all[- ]?in|back(?:ing)? up the truck|table[- ]?pound|can'?t miss|loading up|load(?:ing)? the boat|max(?:ed)? out|conviction|huge|massive|aggressive)\b/i, 30],
  [/\b(loading|buying|adding|ripping|running|sending|parabolic|moon(?:ing)?|explod|breakout|squeeze|rocket)\b/i, 15],
  [/\b(watching|eyeing|maybe|small|starter|nibble)\b/i, -10],
];
const EMOJI_RX = /[🚀🔥💎🤑🌙📈⚡🟢]/gu;
const num = s => { const n = parseFloat(s); return isFinite(n) && n > 0 && n < 1e6 ? +n.toFixed(2) : null; };

function mineText(text) {
  const t = String(text || '');
  const catalysts = [];
  for (const [tag, rx] of CATALYST_TAGS) if (rx.test(t)) catalysts.push(tag);

  let conv = 0;
  for (const [rx, w] of STRONG_RX) if (rx.test(t)) conv += w;
  conv += Math.min(20, (t.match(EMOJI_RX) || []).length * 7);     // emoji intensity, capped
  conv += Math.min(10, ((t.match(/!/g) || []).length) * 3);       // exclamation intensity, capped
  if (/[A-Z]{4,}/.test(t.replace(/\$[A-Z]+/g, ''))) conv += 8;     // shouting (ALLCAPS, excl. $TICKERS)
  const conviction = Math.max(0, Math.min(100, conv));

  const grab = rx => { const m = t.match(rx); return m ? num(m[1]) : null; };
  const levels = {
    target: grab(/(?:target|tgt|\bpt\b|price target|goal)\s*[:=]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)/i),
    stop:   grab(/(?:stop(?:\s?loss)?|\bsl\b)\s*[:=]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)/i),
    entry:  grab(/(?:entry|enter|buy(?:ing)?|add(?:ed|ing)?|in at|got in)\s*[:=]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)/i),
  };
  const hasLevels = levels.target != null || levels.stop != null || levels.entry != null;

  let options = null;
  const om = t.match(/\$?(\d{1,5}(?:\.\d{1,2})?)\s?(c|p|call|put)s?\b/i) || t.match(/\b(call|put)s?\b/i);
  if (om) {
    const isCall = /c/i.test(om[2] || om[1]);
    options = { type: isCall ? 'calls' : 'puts', strike: om[2] ? num(om[1]) : null };
  }

  let timeframe = null;
  if (/\b(day ?trade|scalp|0dte|intraday|today|\beod\b)\b/i.test(t)) timeframe = 'day';
  else if (/\b(swing|this week|few days|short[- ]?term|overnight)\b/i.test(t)) timeframe = 'swing';
  else if (/\b(long[- ]?term|invest(?:ing|ment)?|hold(?:ing)?|leaps?|years?)\b/i.test(t)) timeframe = 'long';

  return { catalysts, conviction, levels: hasLevels ? levels : null, options, timeframe };
}

// Build ranked alerts from raw posts. Confirmation bonus uses INDEPENDENT SOURCES
// (clusters), so a coordinated pump counts as one voice.
function rankPosts(posts, record, nowMs = Date.now()) {
  posts = dedup(posts);
  const clusters = clusterPosts(posts);
  const clAccts = {};
  posts.forEach((p, i) => { (clAccts[clusters[i]] = clAccts[clusters[i]] || new Set()).add(p.account); });
  const coordinated = new Set(Object.entries(clAccts).filter(([, a]) => a.size >= CFG.coordMinAccounts).map(([c]) => +c));

  const alerts = {};
  posts.forEach((post, i) => {
    if (!isAlert(post._norm)) return;
    const w = decayWeight(post.timestamp ? Date.parse(post.timestamp) : 0, nowMs) * accountWeight(post.account, record);
    const cid = clusters[i];
    const mined = mineText(post.text);   // catalysts / conviction / levels / options / timeframe
    for (const [ticker, direction] of tickerDirections(post.text)) {
      const key = ticker + ':' + direction;
      const a = alerts[key] || (alerts[key] = { ticker, direction, text: String(post.text).slice(0, 200), rawWeight: 0, mentions: 0, accounts: new Set(), clusters: new Set(), coordinated: false, catalysts: new Set(), conviction: 0, levels: {}, optionsCtx: null, tf: {} });
      a.accounts.add(post.account);
      // Merge mined signal from every contributing post (cheap; Set/max dedupe it).
      mined.catalysts.forEach(t => a.catalysts.add(t));
      if (mined.conviction > a.conviction) a.conviction = mined.conviction;
      if (mined.levels) for (const k of ['target', 'stop', 'entry']) if (a.levels[k] == null && mined.levels[k] != null) a.levels[k] = mined.levels[k];
      if (!a.optionsCtx && mined.options) a.optionsCtx = mined.options;
      if (mined.timeframe) a.tf[mined.timeframe] = (a.tf[mined.timeframe] || 0) + 1;
      if (a.clusters.has(cid)) return;
      a.clusters.add(cid); a.mentions++; a.rawWeight += w;
      if (coordinated.has(cid)) a.coordinated = true;
    }
  });

  const items = Object.values(alerts);
  if (!items.length) return [];
  const weighted = items.map(a => a.rawWeight * (1 + 0.5 * (a.clusters.size - 1)));
  const lo = Math.min(...weighted), hi = Math.max(...weighted), span = Math.max(hi - lo, 1e-9);
  return items.map((a, i) => {
    const levels = (a.levels.target != null || a.levels.stop != null || a.levels.entry != null) ? a.levels : null;
    const timeframe = Object.keys(a.tf).sort((x, y) => a.tf[y] - a.tf[x])[0] || null;
    return {
      ticker: a.ticker, direction: a.direction, mentions: a.mentions,
      distinctAccounts: a.accounts.size, independentSources: a.clusters.size, coordinated: a.coordinated,
      accounts: [...a.accounts].sort(), weightedSignal: +weighted[i].toFixed(3),
      score: 1 + Math.round(4 * (weighted[i] - lo) / span), sampleText: a.text,
      catalysts: [...a.catalysts], conviction: a.conviction, levels, options: a.optionsCtx, timeframe,
    };
  }).sort((x, y) => (y.score - x.score) || (y.weightedSignal - x.weightedSignal));
}

// ── Grading + edge harness ──────────────────────────────────────────────────
// Excess return (stock − SPY) over a fixed forward window. candlesAt: date→idx not
// needed; we pass candle arrays. Returns excess % or null if not matured.
function gradeExcess(stockCandles, spyCandles, fromDate, holdDays) {
  const at = (c, d) => { let idx = -1; for (let k = 0; k < c.length; k++) { if (c[k].date >= d) { idx = k; break; } } return idx; };
  const si = at(stockCandles, fromDate), mi = at(spyCandles, fromDate);
  if (si < 0 || mi < 0) return null;
  if (si + holdDays >= stockCandles.length || mi + holdDays >= spyCandles.length) return null; // not matured
  const sr = (stockCandles[si + holdDays].close - stockCandles[si].close) / stockCandles[si].close;
  const mr = (spyCandles[mi + holdDays].close - spyCandles[mi].close) / spyCandles[mi].close;
  return +(100 * (sr - mr)).toFixed(3);
}

function ranks(xs) {
  const order = xs.map((v, i) => i).sort((a, b) => xs[a] - xs[b]); const r = new Array(xs.length);
  let i = 0; while (i < order.length) { let j = i; while (j < order.length && xs[order[j]] === xs[order[i]]) j++; const avg = (i + j - 1) / 2 + 1; for (let k = i; k < j; k++) r[order[k]] = avg; i = j; }
  return r;
}
function pearson(a, b) { const n = a.length; if (n < 2) return 0; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let nu = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; nu += x * y; da += x * x; db += y * y; } return da && db ? nu / Math.sqrt(da * db) : 0; }
const spearman = (a, b) => pearson(ranks(a), ranks(b));
function wilson(k, n, z = 1.645) { if (!n) return [0, 0]; const p = k / n, z2 = z * z, d = 1 + z2 / n; const c = (p + z2 / (2 * n)) / d, h = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }

// Edge report on graded directional alerts. Conservative verdict (lesson learned):
// EDGE only if the hit-rate interval clears 50% AND conviction is significant.
function analyzeEdge(entries) {
  const g = entries.filter(e => e.graded && e.excess != null && (e.direction === 'bullish' || e.direction === 'bearish'));
  const n = g.length;
  if (n < CFG.minGradedForEdge) return { n, edge: false, verdict: `INSUFFICIENT DATA (${n}/${CFG.minGradedForEdge} graded directional alerts)`, minGraded: CFG.minGradedForEdge };
  const signed = g.map(e => (e.direction === 'bullish' ? 1 : -1) * e.excess);  // >0 = call was right
  const conv = g.map(e => e.weightedSignal);
  const hits = signed.filter(s => s > 0).length;
  const [lo, hi] = wilson(hits, n);
  const ic = spearman(conv, signed);
  const tIC = ic * Math.sqrt(Math.max(n - 2, 1) / Math.max(1e-9, 1 - ic * ic));
  const tiers = {}; g.forEach((e, i) => { (tiers[e.score] = tiers[e.score] || []).push(signed[i]); });
  const byTier = Object.fromEntries(Object.entries(tiers).sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)]));
  const accts = {}; g.forEach((e, i) => { (accts[e.account] = accts[e.account] || []).push(signed[i] > 0 ? 1 : 0); });
  const byAccount = Object.fromEntries(Object.entries(accts).sort((a, b) => (b[1].reduce((x, y) => x + y, 0) / b[1].length) - (a[1].reduce((x, y) => x + y, 0) / a[1].length)).map(([k, v]) => [k, { hitRate: Math.round(100 * v.reduce((a, b) => a + b, 0) / v.length), n: v.length }]));
  const edge = lo > 0.50 && tIC > 2.0;
  return {
    n, holdDays: CFG.gradeHoldDays,
    hitRatePct: +(100 * hits / n).toFixed(1), hitRateCI90: [+(100 * lo).toFixed(1), +(100 * hi).toFixed(1)],
    meanExcessPct: +(signed.reduce((a, b) => a + b, 0) / n).toFixed(2),
    convictionRankIC: +ic.toFixed(3), rankICtStat: +tIC.toFixed(2),
    byScoreTierMeanExcess: byTier, byAccountHitRate: byAccount,
    edge, verdict: edge ? 'EDGE: directional calls beat the market and conviction predicts outcome' : 'NO EDGE: indistinguishable from chance vs the market',
  };
}

module.exports = { CFG, rankPosts, gradeExcess, analyzeEdge, accountWeight, tickerDirections, scoreSegment, clusterPosts, dedup, isAlert, normalize, mineText };
