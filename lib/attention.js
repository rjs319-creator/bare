'use strict';
// Fast-vs-sticky ATTENTION classifier (roadmap Step 4).
//
// Splits the app's attention signal (daily StockTwits mention counts, archived per
// ticker) into two kinds:
//   • STICKY  — sustained / growing attention over many days → tends to keep drifting
//               (a mild positive).
//   • FAST    — a short-burst spike that fades quickly → tends to reverse (a caution).
//
// Deliberately PRESENCE-first because the per-ticker mention history is thin and gappy
// (a name only appears on days it trends): how MANY of the recent days a name showed up
// is a far more robust signal than the exact day-over-day mention slope. This is a
// standalone flag + Scoreboard-tracked signal — it does NOT touch the core score yet.

const WINDOW = 14;        // archived days looked back over
const RECENT_DAYS = 5;    // must have trended within this many recent days to be "active"
const STICKY_MIN = 3;     // present on ≥ this many days in the window → candidate sticky
const FADE_RATIO = 0.55;  // latest mentions below this fraction of its peak → fading (hype giving back)
const TRUST_MIN_DAYS = 10;// below this many archived days the whole read is "still accruing"

// days = [{ date, records: [{ ticker, mentions, trendRank }] }]. mentions is null on
// days a ticker wasn't trending. Returns { asOf, window, trustworthy, byTicker, summary }.
function classifyAttention(days, opts = {}) {
  const window = opts.window || WINDOW;
  const stickyMin = opts.stickyMin || STICKY_MIN;
  const recentDays = opts.recentDays || RECENT_DAYS;
  const sorted = (Array.isArray(days) ? days : [])
    .filter(d => d && d.date && Array.isArray(d.records))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!sorted.length) return { asOf: null, window, trustworthy: false, byTicker: {}, summary: { sticky: 0, fast: 0, building: 0 } };

  const win = sorted.slice(-window);
  const asOf = win[win.length - 1].date;
  const lastIdx = win.length - 1;

  // Per-ticker: the ordered list of days it was present (trending), with its mentions.
  const byT = new Map();
  win.forEach((day, i) => {
    for (const r of day.records) {
      const t = String(r && r.ticker || '').toUpperCase();
      if (!t) continue;
      const m = (r.mentions == null || typeof r.mentions !== 'number') ? null : r.mentions;
      if (m == null) continue; // not trending that day → no attention observation
      if (!byT.has(t)) byT.set(t, []);
      byT.get(t).push({ i, date: day.date, mentions: m, rank: r.trendRank ?? null });
    }
  });

  const byTicker = {};
  const summary = { sticky: 0, fast: 0, building: 0 };
  for (const [t, pres] of byT) {
    const presence = pres.length;
    const last = pres[presence - 1];
    const active = (lastIdx - last.i) < recentDays; // trended within the recent window
    if (!active) continue; // attention has gone cold — not a live signal

    const vals = pres.map(p => p.mentions);
    const peak = Math.max(...vals);
    const latest = last.mentions;
    const fadingFromPeak = peak > 0 && latest < FADE_RATIO * peak;
    // rising = latest at/above the previous present reading (or first-and-only reading)
    const rising = presence < 2 ? true : latest >= pres[presence - 2].mentions;

    let cls, note;
    if (presence >= stickyMin && !fadingFromPeak) {
      cls = 'Sticky';
      note = `Trended ${presence} of the last ${win.length} days, attention ${rising ? 'still building' : 'holding'} — sustained interest tends to keep drifting.`;
    } else if (presence <= 2) {
      cls = 'Fast';
      note = `A short ${presence}-day burst of attention — quick spikes tend to fade and reverse.`;
    } else if (fadingFromPeak) {
      cls = 'Fast';
      note = `Attention spiked to ${peak} then fell to ${latest} (off its peak) — hype giving back, tends to reverse.`;
    } else {
      cls = 'Building';
      note = `Attention building over ${presence} days — not yet a sustained trend.`;
    }

    byTicker[t] = {
      class: cls, presence, windowDays: win.length, latestMentions: latest, peakMentions: peak,
      rising, fadingFromPeak, firstSeen: pres[0].date, lastSeen: last.date, rank: last.rank, note,
    };
    if (cls === 'Sticky') summary.sticky++;
    else if (cls === 'Fast') summary.fast++;
    else summary.building++;
  }

  return { asOf, window: win.length, trustworthy: win.length >= TRUST_MIN_DAYS, byTicker, summary };
}

module.exports = { classifyAttention, WINDOW, RECENT_DAYS, STICKY_MIN, FADE_RATIO, TRUST_MIN_DAYS };
