'use strict';
// SCOREBOARD EPISODE SEPARATION (quant-redesign-3, H15) — replaces the Scoreboard's
// "first ticker/tier appearance FOREVER" dedup with honest episodes.
//
// THE DEFECT: runScoreboard deduped every ledger with `section:tier:ticker` keyed
// first-appearance across ALL history — a name that fired in January, resolved, and
// fired again in July was silently dropped the second time, forever. That undercounts
// evidence for recurring setups and freezes each strategy's track record on its oldest
// occurrences.
//
// THE FIX: within a key, consecutive appearances belong to ONE episode while the gap
// since the last sighting stays within the strategy's contract cooldown
// (lib/strategy-contracts.js episodeCooldownSessions); a reappearance after the
// cooldown opens a NEW episode whose first record enters the Scoreboard like a fresh
// pick. Continuous listing keeps extending the same episode (the gap is measured from
// the LAST sighting, not the first), so a name that stays on a list for weeks is still
// counted once per episode — never once per day.
//
// `legacy: true` reproduces the old first-appearance-forever behavior exactly
// (surfaced as ?dedup=first for comparison/debug).
//
// Pure, order-insensitive (records are sorted per key at fold time). No network.

const SC = require('./strategy-contracts');

const EPISODES_VERSION = 'sb-episodes-v2';

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function gapDays(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

// v2: contracts declare cooldowns in TRADING SESSIONS (episodeCooldownSessions), but v1
// compared them against CALENDAR days — a 21-session cooldown enforced as 21 calendar
// days (≈15 sessions) opened "independent" episodes ~40% too early, inflating the very
// episode/date counts the promotion gates lean on. The gap is now measured in sessions
// (weekday roll minus NYSE holidays, lib/swing-sessions).
// The FROZEN daytrade section keeps the v1 calendar-day axis (Day Trade is excluded
// from this redesign; its episode boundaries must not move).
const CALENDAR_AXIS_SECTIONS = new Set(['daytrade']);

function gapSessions(a, b) {
  const { calendarSessionsBetween } = require('./swing-sessions');
  const n = calendarSessionsBetween(a, b);
  return Number.isFinite(n) ? n : 0;
}

// Drop-in replacement for the `firstSeen` Map in runScoreboard. Call `.add(key, rec)`
// for EVERY ledger record (no has() pre-check needed); `.values()` returns one record
// per episode (the episode's first sighting, stamped with `episode` ordinal).
function createEpisodeMap({ cooldownForSection = SC.cooldownForSection, legacy = false } = {}) {
  const byKey = new Map();
  return {
    add(key, rec) {
      if (!key || !rec) return;
      const list = byKey.get(key) || (byKey.set(key, []).get(key));
      list.push(rec);
    },
    values() {
      const out = [];
      for (const recs of byKey.values()) {
        recs.sort(byDate);
        if (legacy) { out.push(recs[0]); continue; }
        let lastSeen = null;
        let episode = 0;
        for (const r of recs) {
          const cd = cooldownForSection(r.section);
          const gap = lastSeen == null ? null
            : CALENDAR_AXIS_SECTIONS.has(r.section) ? gapDays(lastSeen, r.date)
              : gapSessions(lastSeen, r.date);
          if (lastSeen == null || gap > cd) {
            episode++;
            out.push(episode === 1 ? r : { ...r, episode });
          }
          lastSeen = r.date;
        }
      }
      return out;
    },
  };
}

module.exports = { EPISODES_VERSION, createEpisodeMap, gapDays, gapSessions, CALENDAR_AXIS_SECTIONS };
