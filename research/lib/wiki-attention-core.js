'use strict';
// WIKI ATTENTION CORE (wiki-attention-v1) — the pure pieces of research/104.
//
// attention z   : log1p(views) 7-day mean vs the preceding 60-day baseline, in baseline SDs
// spike         : top decile of z across the names eligible on that session (z > minZ)
// quiet filter  : |5-session return| < 1 × ATR(14)/close — attention WITHOUT a price move yet
// outcome       : next-open → close(+H) minus SPY, minus one tiered round trip (kit cost model)
// placebo       : the same spikes dated +30 calendar days (first session on/after)
// blocks        : 4 chronological blocks with an H-session embargo at every boundary
//
// PIT rule: a decision on session D may only see pageview days ≤ D−1 (the Wikimedia day
// closes at 00:00 UTC and publishes the next morning). Nothing here does I/O.

const WIKI_ATTENTION_VERSION = 'wiki-attention-v1';
const DAY_MS = 86400000;
const MIN_NAMES_PER_DATE = 10;

const isoShift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// pairs: ascending [[yyyymmdd, views]] or Map(ISO→views). Returns Map(ISO → z) over the
// CALENDAR days present. Gaps (a day Wikimedia did not return) count as 0 views — a page
// with no row had no recorded traffic that day.
function attentionSeries(daily, { window = 7, baseline = 60 } = {}) {
  const entries = daily instanceof Map ? [...daily.entries()] : (daily || []).map(([ts, v]) => [`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`, v]);
  if (!entries.length) return new Map();
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const byIso = new Map(entries);
  const first = entries[0][0];
  const last = entries[entries.length - 1][0];
  const nDays = Math.round((Date.parse(last) - Date.parse(first)) / DAY_MS) + 1;
  const logs = new Array(nDays);
  const isos = new Array(nDays);
  for (let i = 0; i < nDays; i++) { isos[i] = isoShift(first, i); logs[i] = Math.log1p(byIso.get(isos[i]) || 0); }
  const ps = new Array(nDays + 1).fill(0);
  const ps2 = new Array(nDays + 1).fill(0);
  for (let i = 0; i < nDays; i++) { ps[i + 1] = ps[i] + logs[i]; ps2[i + 1] = ps2[i] + logs[i] * logs[i]; }
  const sum = (a, b) => ps[b + 1] - ps[a];           // inclusive [a, b]
  const sum2 = (a, b) => ps2[b + 1] - ps2[a];
  const out = new Map();
  for (let t = window + baseline - 1; t < nDays; t++) {
    const recent = sum(t - window + 1, t) / window;
    const b0 = t - window - baseline + 1, b1 = t - window;
    const bMean = sum(b0, b1) / baseline;
    const bVar = sum2(b0, b1) / baseline - bMean * bMean;
    if (!(bVar > 1e-12)) { out.set(isos[t], null); continue; }
    out.set(isos[t], (recent - bMean) / Math.sqrt(bVar));
  }
  return out;
}

// The last COMPLETE pageview day usable for a decision on session D.
const lastUsableDay = (sessionIso) => isoShift(sessionIso, -1);

// True range average over the last `atrSessions` bars ending at index i.
function atrAt(candles, i, atrSessions = 14) {
  if (i - atrSessions < 0) return null;
  let s = 0;
  for (let k = i - atrSessions + 1; k <= i; k++) {
    const b = candles[k], p = candles[k - 1];
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return s / atrSessions;
}

// |5-session return| < maxAtrMultiple × ATR/close → the attention has not moved the price.
function isQuiet(candles, i, { returnSessions = 5, atrSessions = 14, maxAtrMultiple = 1.0 } = {}) {
  if (i - returnSessions < 0) return false;
  const atr = atrAt(candles, i, atrSessions);
  const c = candles[i].close, c0 = candles[i - returnSessions].close;
  if (!(atr > 0) || !(c > 0) || !(c0 > 0)) return false;
  return Math.abs(c / c0 - 1) < maxAtrMultiple * (atr / c);
}

// rows: [{ticker, z, …}] for ONE session → the top-decile rows by z (z > minZ).
function selectTopDecile(rows, { decile = 0.1, minZ = 0 } = {}) {
  const valid = rows.filter((r) => Number.isFinite(r.z));
  if (valid.length < MIN_NAMES_PER_DATE) return [];
  const sorted = valid.slice().sort((a, b) => b.z - a.z);
  const k = Math.max(1, Math.floor(sorted.length * decile));
  const cut = sorted[k - 1].z;
  return sorted.filter((r) => r.z >= cut && r.z > minZ);
}

// One event per ticker per `cooldown` sessions (events ascending by date).
function applyCooldown(events, sessionIndex, cooldown) {
  const lastIdx = new Map();
  const out = [];
  for (const e of events.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const i = sessionIndex.get(e.date);
    if (i == null) continue;
    const prev = lastIdx.get(e.ticker);
    if (prev != null && i - prev < cooldown) continue;
    lastIdx.set(e.ticker, i);
    out.push(e);
  }
  return out;
}

// First session on/after date+days; null when the calendar ends first.
function shiftPlaceboDate(dateIso, days, sessions) {
  const target = isoShift(dateIso, days);
  let lo = 0, hi = sessions.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sessions[mid] < target) lo = mid + 1; else hi = mid; }
  return lo < sessions.length ? sessions[lo] : null;
}

// Chronological blocks with an embargo: the first `embargo` rows of every block after the
// first are dropped so an outcome window started in block k never leaks into block k+1.
function purgedBlockMeans(series, { blocks = 4, embargo = 0 } = {}) {
  const rows = series.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (rows.length < blocks * 2) return [];
  const per = Math.floor(rows.length / blocks);
  return Array.from({ length: blocks }, (_, b) => {
    const start = b * per + (b ? embargo : 0);
    const end = b === blocks - 1 ? rows.length : (b + 1) * per;
    const vals = rows.slice(start, end).map((r) => r.value);
    return vals.length ? mean(vals) : null;
  });
}

// ── Event construction ────────────────────────────────────────────────────────────────
function buildEvents({ dataset, views, sessions, frozen }) {
  const sessionIndex = new Map(sessions.map((d, i) => [d, i]));
  const zSeries = new Map([...views.entries()].map(([t, daily]) => [t, attentionSeries(daily, frozen.attention)]));
  const raw = [];
  let spikes = 0, quiet = 0;
  for (const D of sessions) {
    const day = lastUsableDay(D);
    const rows = [];
    for (const [ticker, zs] of zSeries) {
      const entry = dataset.get(ticker);
      if (!entry) continue;
      const i = entry.idx.get(D);
      if (i == null || i < frozen.eligibility.minPriorBars || entry.candles[i].close < frozen.eligibility.minClose) continue;
      const z = zs.get(day);
      if (z == null) continue;
      rows.push({ ticker, date: D, z, i });
    }
    for (const r of selectTopDecile(rows, frozen.attention)) {
      const entry = dataset.get(r.ticker);
      const q = isQuiet(entry.candles, r.i, frozen.quietFilter);
      spikes++; if (q) quiet++;
      raw.push({ ticker: r.ticker, date: r.date, z: +r.z.toFixed(3), quiet: q });
    }
  }
  const all = applyCooldown(raw, sessionIndex, frozen.cooldownSessions);
  const quietEvents = applyCooldown(raw.filter((e) => e.quiet), sessionIndex, frozen.cooldownSessions);
  return { spikes, quiet, events: { all, quiet: quietEvents } };
}

// ── Outcomes + cells ──────────────────────────────────────────────────────────────────
function outcomeOf(entry, spy, spyIdx, date, H, kit) {
  const fwd = kit.forwardFromNextOpen(entry, date, H);
  const bench = kit.benchmarkForward(spy, spyIdx, date, H);
  if (fwd == null || bench == null) return null;
  const i = entry.idx.get(date);
  const cost = kit.costFractions(kit.advOf(entry.candles.slice(0, i + 1))).base;
  return fwd - bench - cost;
}

function summarizeCell(id, { arm, variant, H }, series, frozen, kit) {
  const s = series.length ? kit.summarizeByDate(series, { horizonBars: H }) : null;
  const blockMeans = purgedBlockMeans(series, { blocks: frozen.blocks, embargo: H });
  const t = s && s.seExact > 0 ? s.avgExact / s.seExact : null;
  return {
    id, arm, variant, H, n: series.length, dates: s ? s.dates : 0,
    mean: s ? +(s.avgExact * 100).toFixed(3) : null, t: t == null ? null : +t.toFixed(2), p: s ? kit.pValue(s) : null,
    ci95: s ? s.ci95 : null, effectiveN: s ? s.effectiveN : null,
    blockMeans: blockMeans.map((m) => (m == null ? null : +(m * 100).toFixed(3))),
    negativeBlocks: blockMeans.filter((m) => m != null && m < 0).length,
    medianPct: series.length ? +(median(series.map((r) => r.value)) * 100).toFixed(3) : null,
  };
}

function median(a) { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function evaluateCells({ dataset, spy, spyIdx, sessions, events, frozen, kit }) {
  const cells = [];
  for (const variant of frozen.variants) {
    for (const H of frozen.horizons) {
      for (const arm of ['event', 'placebo']) {
        const series = [];
        for (const e of events[variant]) {
          const date = arm === 'placebo' ? shiftPlaceboDate(e.date, frozen.placeboShiftDays, sessions) : e.date;
          if (!date) continue;
          const v = outcomeOf(dataset.get(e.ticker), spy, spyIdx, date, H, kit);
          if (v != null) series.push({ date, ticker: e.ticker, value: v });
        }
        cells.push(summarizeCell(`${arm}:${variant}@${H}`, { arm, variant, H }, series, frozen, kit));
      }
    }
  }
  return cells;
}

// Mechanical verdict for the declared primary cell against the frozen gates.
function verdictOf(primary, placebo, frozen) {
  if (!primary || primary.n < frozen.gates.minEvents || primary.dates < frozen.gates.minDates) {
    return { verdict: 'insufficient-data', reason: `need ≥${frozen.gates.minEvents} events on ≥${frozen.gates.minDates} dates (got ${primary ? primary.n : 0} / ${primary ? primary.dates : 0})` };
  }
  const fails = [];
  if (!(primary.mean < 0)) fails.push('mean not negative');
  if (!(primary.t != null && primary.t <= -frozen.gates.minT)) fails.push(`t ${primary.t} > −${frozen.gates.minT}`);
  if (!(primary.q != null && primary.q <= frozen.fdrAlpha)) fails.push(`q ${primary.q} > ${frozen.fdrAlpha}`);
  if (!(primary.negativeBlocks >= frozen.gates.minNegativeBlocks)) fails.push(`${primary.negativeBlocks}/${frozen.blocks} negative blocks`);
  if (placebo && placebo.mean != null && Math.abs(placebo.mean) >= Math.abs(primary.mean) / 2) fails.push(`placebo |${placebo.mean}| ≥ ½ |${primary.mean}|`);
  return fails.length ? { verdict: 'not-confirmed', reason: fails.join('; ') } : { verdict: 'research-promising', reason: 'all frozen gates passed (survivor universe — ceiling research-promising)' };
}

module.exports = {
  WIKI_ATTENTION_VERSION, MIN_NAMES_PER_DATE, isoShift, attentionSeries, lastUsableDay, atrAt, isQuiet,
  selectTopDecile, applyCooldown, shiftPlaceboDate, purgedBlockMeans, buildEvents, evaluateCells, verdictOf,
};
