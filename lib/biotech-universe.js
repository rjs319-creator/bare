'use strict';
// 🧬 BIOTECH UNIVERSE (Phase 1) — a point-in-time-compatible membership process that reduces the
// dependence on a single static ticker list. It unions the curated BIOTECH list with the
// biotech-named tail of the free expanded (NASDAQ-directory) universe, records each member's
// membership date + discovery method, dedupes share classes/uppercase variants, filters obvious
// non-biotech false positives (medtech/diagnostics/devices/cannabis/shells), retains delisted &
// failed companies in research history (via the app security-master when supplied), and reports
// coverage honestly (size, candle coverage, stale coverage, missing reasons).
//
// HONEST LIMITS: there is NO free XBI/IBB holdings feed and no SIC classification on the live
// feeds, so ETF-membership and SIC sourcing are not available here; the app security-master only
// knows S&P-500 removals (survivorshipSafe:false). Uncertain classifications are MARKED, not
// silently assumed biotech. Backward compatible: biotechTickers() returns the same flat union
// the legacy detect() consumed.

const { BIOTECH } = require('./universe');
const { isBiotechName } = require('./universe-expand');

// Names that read as biotech to the inclusive matcher but are really medtech/diagnostics/devices/
// cannabis/shells — excluded unless intentionally supported. Deterministic keyword screen.
const FALSE_POSITIVE_RX = /\b(diagnostics?|medical device|devices?|imaging|dental|veterinary|cannabis|hemp|marijuana|acquisition corp|blank check|holding company|robotics?|surgical)\b/i;

function isFalsePositiveBiotech(name) {
  return FALSE_POSITIVE_RX.test(String(name || ''));
}

const normSym = s => String(s || '').toUpperCase().trim().replace(/[^A-Z.^-]/g, '');

/**
 * Build the point-in-time biotech universe.
 * @param {object} p { expanded:[{symbol,name}], asOf, secmasterRecords, curated }
 * @returns {{ members:[{symbol,company,source,discoveryMethod,membershipDate,uncertain,active,status}],
 *            excluded:[{symbol,reason}], size, curatedCount, expandedCount, uncertainCount, survivorshipSafe }}
 */
function buildUniverse({ expanded = [], asOf = null, secmasterRecords = null, curated = BIOTECH } = {}) {
  const seen = new Set();
  const members = [];
  const excluded = [];
  let resolveAsOf = null;
  if (secmasterRecords) { try { resolveAsOf = require('./security-master').resolveAsOf; } catch { /* pure fallback */ } }

  const pitMeta = sym => {
    if (!resolveAsOf || !secmasterRecords || !secmasterRecords[sym]) return { active: true, status: 'active', membershipDate: null };
    const r = resolveAsOf(secmasterRecords[sym], asOf);
    return { active: r.active !== false, status: r.status || 'active', membershipDate: r.knownAsOf || r.firstSeen || null };
  };

  const add = (symbol, company, source, discoveryMethod, uncertain) => {
    const sym = normSym(symbol);
    if (!sym || seen.has(sym)) return;
    seen.add(sym);
    const pit = pitMeta(sym);
    members.push({ symbol: sym, company: company || null, source, discoveryMethod, membershipDate: pit.membershipDate, uncertain: !!uncertain, active: pit.active, status: pit.status });
  };

  // Curated list = highest-confidence membership.
  for (const t of curated) add(t, null, 'curated', 'curated-list', false);

  // Expanded universe: keep biotech-named, drop false positives, mark generic-token matches uncertain.
  for (const row of expanded) {
    const sym = normSym(row.symbol);
    if (!sym || seen.has(sym)) continue;
    const name = row.name || '';
    if (!isBiotechName(name)) continue;
    if (isFalsePositiveBiotech(name)) { excluded.push({ symbol: sym, reason: 'non-biotech name (medtech/diagnostics/cannabis/shell)' }); continue; }
    // "Uncertain" = matched only by the generic embedded 'bio' token (no drug/therapeutics stem).
    const uncertain = !/\b(pharma|therapeut|bioscience|biopharma|biotech|biologic|oncolog|genomic|immun|vaccin|peptide|antibod)/i.test(name);
    add(sym, name, 'expanded', uncertain ? 'name-match(bio-token)' : 'name-match(stem)', uncertain);
  }

  const uncertainCount = members.filter(m => m.uncertain).length;
  return {
    members, excluded,
    size: members.length,
    curatedCount: members.filter(m => m.source === 'curated').length,
    expandedCount: members.filter(m => m.source === 'expanded').length,
    uncertainCount,
    survivorshipSafe: false,   // honest: no delisted-inclusive PIT master on the live feeds
    asOf,
  };
}

// Backward-compatible flat ticker union (curated first) — what the legacy detect() consumed.
function biotechTickers({ expanded = [] } = {}) {
  return buildUniverse({ expanded }).members.map(m => m.symbol);
}

/**
 * Coverage report over a candle lookup. `lookup(symbol)` → { hasCandles, lastDate } | null.
 * Returns coverage counts + the reasons names are missing candles (so gaps are visible, not silent).
 */
function coverageReport(members, lookup, { asOf = null, staleAfterDays = 4 } = {}) {
  let withCandles = 0, stale = 0, missing = 0;
  const reasons = {};
  const today = asOf || new Date().toISOString().slice(0, 10);
  for (const m of members) {
    const info = lookup ? lookup(m.symbol) : null;
    if (!info || !info.hasCandles) { missing++; reasons[m.active === false ? 'delisted/inactive' : 'no candles cached'] = (reasons[m.active === false ? 'delisted/inactive' : 'no candles cached'] || 0) + 1; continue; }
    withCandles++;
    if (info.lastDate) {
      const ageD = Math.round((new Date(today) - new Date(info.lastDate)) / 86_400_000);
      if (ageD > staleAfterDays) stale++;
    }
  }
  return {
    universeSize: members.length, withCandles, staleCandles: stale, missingCandles: missing,
    candleCoveragePct: members.length ? +((withCandles / members.length) * 100).toFixed(1) : 0,
    missingReasons: reasons,
  };
}

module.exports = { buildUniverse, biotechTickers, coverageReport, isFalsePositiveBiotech, FALSE_POSITIVE_RX, normSym };
