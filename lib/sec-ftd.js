'use strict';
// SEC FAILS-TO-DELIVER — semi-monthly CNS fails files (sec-ftd-v1, FETCH STUBBED).
//
//   https://www.sec.gov/files/data/fails-deliver-data/cnsfails{YYYYMM}{a|b}.zip
//   'a' = settlement days 1–15 of the month, 'b' = 16th–end. Each zip holds ONE
//   pipe-delimited text file (CP1252), header:
//     SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE
//   Published with a ~2-week lag; only positions ≥ 10,000 shares are listed.
//
// STATUS 2026-10-02: www.sec.gov does NOT resolve from the build/agent sandbox
// (`curl: (6) Could not resolve host`), so the live fetch could not be probed and is
// deliberately NOT implemented — a fetch that cannot be exercised here would ship
// untested. fetchFtd() returns an explicit `unavailable` with that reason. The period
// math and the inner-file parser ARE implemented and tested, so enabling the feed later
// is a small change: fetch the zip with the SEC User-Agent (lib/edgar's SEC_UA
// convention — descriptive UA with contact, ≤10 req/s), read the single local-file
// entry (signature 0x04034b50, method 8) and zlib.inflateRawSync it, then parseFtdText.
// Like short volume, fails-to-deliver is a FEATURE/diagnostic, never a score input.

const SEC_FTD_VERSION = 'sec-ftd-v1';
const BASE = 'https://www.sec.gov/files/data/fails-deliver-data/cnsfails';
const EXPECTED_HEADER = 'SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE';
const UNAVAILABLE_REASON = 'SEC fails-to-deliver fetch is not implemented: www.sec.gov did not resolve from the build sandbox on 2026-10-02, so the zip download path could not be probed or tested. Period/URL math and the file parser are ready; see the module header to enable.';
const FIRST_HALF_LAST_DAY = 15;

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The semi-monthly period a settlement date falls in. */
function periodFor(iso) {
  if (!isIsoDate(iso)) throw new TypeError(`sec-ftd: periodFor needs an ISO date, got ${iso}`);
  const yyyymm = iso.slice(0, 7).replace('-', '');
  const half = Number(iso.slice(8, 10)) <= FIRST_HALF_LAST_DAY ? 'a' : 'b';
  return { yyyymm, half, id: `${yyyymm}${half}` };
}

function urlFor(period) {
  const p = typeof period === 'string' ? periodFor(period) : period;
  if (!p || !/^\d{6}$/.test(p.yyyymm) || !['a', 'b'].includes(p.half)) throw new TypeError('sec-ftd: urlFor needs { yyyymm, half }');
  return `${BASE}${p.yyyymm}${p.half}.zip`;
}

/** Parse the inner text file. Per-row problems are counted and skipped, never coerced. */
function parseFtdText(text) {
  const health = { lines: 0, kept: 0, invalid: 0, invalidReasons: {} };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty_body', rows: [], health };
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== EXPECTED_HEADER) return { ok: false, reason: 'bad_header', rows: [], health };
  const rows = [];
  const bad = (why) => { health.invalid++; health.invalidReasons[why] = (health.invalidReasons[why] || 0) + 1; };
  for (const line of lines.slice(1)) {
    if (!line.trim() || /^Trailer/i.test(line)) continue;
    health.lines++;
    const p = line.split('|');
    if (p.length !== 6) { bad('bad_column_count'); continue; }
    const d = p[0].trim();
    if (!/^\d{8}$/.test(d)) { bad('bad_date'); continue; }
    const symbol = p[2].trim().toUpperCase();
    const fails = Number(p[3]);
    if (!symbol) { bad('bad_symbol'); continue; }
    if (!Number.isFinite(fails) || fails < 0) { bad('bad_quantity'); continue; }
    const price = p[5].trim() === '' || p[5].trim() === '.' ? null : Number(p[5]);
    if (price != null && !Number.isFinite(price)) { bad('bad_price'); continue; }
    rows.push({ settlementDate: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, cusip: p[1].trim(), symbol, fails, description: p[4].trim(), price });
    health.kept++;
  }
  return rows.length ? { ok: true, reason: null, rows, health } : { ok: false, reason: 'no_rows', rows: [], health };
}

/** Stub: explicit unavailability (see header). Never throws. */
async function fetchFtd(iso = null) {
  const period = iso ? periodFor(iso) : null;
  return { available: false, version: SEC_FTD_VERSION, reason: UNAVAILABLE_REASON, period, url: period ? urlFor(period) : null };
}

module.exports = { SEC_FTD_VERSION, EXPECTED_HEADER, UNAVAILABLE_REASON, periodFor, urlFor, parseFtdText, fetchFtd };
