'use strict';
// S&P 500 POINT-IN-TIME MEMBERSHIP (sp500-pit-v1).
//
// Source: fja05680/sp500 (MIT) — "S&P 500 Historical Components & Changes (Updated).csv", one
// row per change date since 1996-01-02: `date,"T1,T2,…"`. scripts/vendor-sp500-constituents.js
// fetches it via `gh api`, compresses it LOSSLESSLY into membership intervals and writes
// research/data-derived/sp500-constituents.csv (`ticker,start,end`; end EXCLUSIVE = the first
// snapshot date the ticker is absent, empty while still a member) next to the upstream LICENSE.
//
// Why intervals: the daily file is 5.5 MB of repeated lists; the interval form is ~40 KB, carries
// the same membersAt(date) answer for every date the source can answer, and keeps re-additions
// (a ticker removed and later re-added gets two rows). Dates BEFORE the first snapshot are
// unknown → membersAt returns null, never an empty set (an empty set would read as "nobody was
// in the index", which is the survivorship lie this file exists to prevent).
//
// Ticker convention: dots become dashes (BF.B → BF-B) to match the app's symbol convention.
// Pure core (parse / compress / membersAt); loadVendored() is the only fs touch.

const fs = require('fs');
const path = require('path');

const SP500_PIT_VERSION = 'sp500-pit-v1';
const DERIVED_DIR = path.join(__dirname, '..', 'data-derived');
const VENDORED_CSV = path.join(DERIVED_DIR, 'sp500-constituents.csv');
const INTERVAL_HEADER = 'ticker,start,end';
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeTicker = (t) => String(t || '').trim().toUpperCase().replace(/\./g, '-');

// Upstream daily CSV → [{ date, tickers: string[] }] sorted ascending, validated at the boundary.
function parseDailyCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  if ((lines[0] || '').trim() !== 'date,tickers') throw new Error(`sp500 daily csv: unexpected header "${(lines[0] || '').slice(0, 40)}"`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^(\d{4}-\d{2}-\d{2}),"?([^"]*)"?$/.exec(line);
    if (!m) throw new Error(`sp500 daily csv: malformed row ${i + 1}: ${line.slice(0, 60)}`);
    const tickers = [...new Set(m[2].split(',').map(normalizeTicker).filter(Boolean))].sort();
    if (!tickers.length) throw new Error(`sp500 daily csv: empty membership on ${m[1]}`);
    rows.push({ date: m[1], tickers });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (let i = 1; i < rows.length; i++) if (rows[i].date === rows[i - 1].date) throw new Error(`sp500 daily csv: duplicate date ${rows[i].date}`);
  return rows;
}

// Snapshots → intervals. A ticker opens on the first snapshot that lists it and closes on the
// first later snapshot that does not (end exclusive). Re-additions produce additional rows.
function compressToIntervals(snapshots) {
  const open = new Map();
  const out = [];
  for (const snap of snapshots) {
    const present = new Set(snap.tickers);
    for (const [t, start] of [...open.entries()]) {
      if (present.has(t)) continue;
      out.push({ ticker: t, start, end: snap.date });
      open.delete(t);
    }
    for (const t of present) if (!open.has(t)) open.set(t, snap.date);
  }
  for (const [t, start] of open.entries()) out.push({ ticker: t, start, end: null });
  return out.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.start < b.start ? -1 : 1));
}

const intervalsToCsv = (intervals) => [INTERVAL_HEADER, ...intervals.map((r) => `${r.ticker},${r.start},${r.end || ''}`)].join('\n') + '\n';

function parseIntervalsCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  if ((lines[0] || '').trim() !== INTERVAL_HEADER) throw new Error(`sp500 intervals csv: unexpected header "${(lines[0] || '').slice(0, 40)}"`);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = line.split(',');
    if (f.length !== 3 || !f[0] || !ISO_RE.test(f[1]) || (f[2] !== '' && !ISO_RE.test(f[2])) || (f[2] && f[2] <= f[1])) {
      throw new Error(`sp500 intervals csv: malformed row ${i + 1}: ${line.slice(0, 60)}`);
    }
    out.push({ ticker: normalizeTicker(f[0]), start: f[1], end: f[2] || null });
  }
  return out;
}

// Membership object over intervals. `firstDate` = the earliest snapshot the data can speak for.
function createMembership(intervals) {
  const rows = [...intervals];
  const firstDate = rows.reduce((m, r) => (m === null || r.start < m ? r.start : m), null);
  const lastKnown = rows.reduce((m, r) => { const d = r.end || r.start; return m === null || d > m ? d : m; }, null);
  const asIso = (d) => (typeof d === 'number' ? new Date(d).toISOString().slice(0, 10) : String(d).slice(0, 10));
  function membersAt(date) {
    const iso = asIso(date);
    if (!ISO_RE.test(iso)) throw new Error(`membersAt: bad date ${date}`);
    if (firstDate === null || iso < firstDate) return null;   // before the record begins: unknown, not empty
    const set = new Set();
    for (const r of rows) if (r.start <= iso && (r.end === null || iso < r.end)) set.add(r.ticker);
    return set;
  }
  return {
    version: SP500_PIT_VERSION, firstDate, lastKnown, intervals: rows.length,
    tickers: [...new Set(rows.map((r) => r.ticker))].sort(),
    membersAt,
    currentMembers: () => new Set(rows.filter((r) => r.end === null).map((r) => r.ticker)),
  };
}

function loadVendored(file = VENDORED_CSV) {
  return createMembership(parseIntervalsCsv(fs.readFileSync(file, 'utf8')));
}

module.exports = {
  SP500_PIT_VERSION, VENDORED_CSV, DERIVED_DIR, INTERVAL_HEADER,
  normalizeTicker, parseDailyCsv, compressToIntervals, intervalsToCsv, parseIntervalsCsv, createMembership, loadVendored,
};
