'use strict';
// CATALYST VERIFICATION — independent confirmation that a claimed catalyst is real.
//
// A social account can REPORT a catalyst ("earnings tonight", "FDA readout") but that claim
// is not evidence the catalyst exists. This module verifies the claim against INDEPENDENT
// sources through clean adapter interfaces, and degrades HONESTLY when a source is
// unavailable — it never upgrades a social claim to "verified" on faith.
//
// Statuses: VERIFIED_PRIMARY (IR / SEC / exchange / FDA), VERIFIED_SECONDARY (earnings
// calendar / reputable news), SOCIAL_ONLY (only the post claims it), CONFLICTED (sources
// disagree), UNVERIFIED (no source consulted / nothing to verify), FALSE_OR_STALE (the
// claimed catalyst already passed or contradicts the record).
//
// No paid provider is required. Adapters return null when they have no data, and the result
// degrades to UNVERIFIED/SOCIAL_ONLY with an explicit note. Pure given injected adapter data.

const STATUS = {
  VERIFIED_PRIMARY: 'VERIFIED_PRIMARY',
  VERIFIED_SECONDARY: 'VERIFIED_SECONDARY',
  SOCIAL_ONLY: 'SOCIAL_ONLY',
  CONFLICTED: 'CONFLICTED',
  UNVERIFIED: 'UNVERIFIED',
  FALSE_OR_STALE: 'FALSE_OR_STALE',
};

const EARNINGS_SOON_DAYS = 21;   // an earnings claim is corroborated if a report is within this window
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * Verify a claimed catalyst against injected, independent evidence.
 * @param {object} claim   { catalysts:string[], ticker, asOfDate }
 * @param {object} sources { earnings?:{nextDate?, lastDate?}, filings?:[], news?:[], regulatory?:[] }
 *                          each source is null/absent when unavailable (⇒ honest degradation)
 * @returns {{ status, verifiedCatalyst, sources:object[], note }}
 */
function verifyCatalyst(claim = {}, sources = {}) {
  const cats = Array.isArray(claim.catalysts) ? claim.catalysts : [];
  const asOf = claim.asOfDate || null;
  const evidence = [];

  if (!cats.length) {
    return { status: STATUS.UNVERIFIED, verifiedCatalyst: null, sources: [], note: 'No catalyst claimed — nothing to verify.' };
  }

  // ── Earnings adapter (secondary: a calendar date, not a primary filing) ──
  if (cats.includes('earnings')) {
    const e = sources.earnings;
    if (e && (e.nextDate || e.lastDate)) {
      if (e.nextDate && asOf) {
        const d = daysBetween(asOf, e.nextDate);
        if (d >= 0 && d <= EARNINGS_SOON_DAYS) {
          evidence.push({ type: 'earnings-calendar', sourceType: 'secondary', date: e.nextDate, url: e.url || null });
          return finalize(STATUS.VERIFIED_SECONDARY, 'earnings', evidence, `Earnings ~${d}d out corroborates the claim (calendar, secondary).`);
        }
        if (d < 0 && d > -EARNINGS_SOON_DAYS) {
          evidence.push({ type: 'earnings-calendar', sourceType: 'secondary', date: e.nextDate });
          return finalize(STATUS.FALSE_OR_STALE, 'earnings', evidence, `Claimed earnings already reported ~${-d}d ago — the catalyst is stale.`);
        }
      }
      // A record exists but the date is far / unknown → weakly corroborated.
      evidence.push({ type: 'earnings-calendar', sourceType: 'secondary', date: e.nextDate || e.lastDate });
      return finalize(STATUS.SOCIAL_ONLY, 'earnings', evidence, 'Earnings claimed but no near-dated report to corroborate — treat as social-only.');
    }
    // adapter unavailable
    return finalize(STATUS.UNVERIFIED, 'earnings', evidence, 'Earnings calendar unavailable — cannot verify (degraded honestly).');
  }

  // ── Filing / regulatory adapters (primary) — wired as interfaces; degrade when empty ──
  const primaryHit = (sources.filings && sources.filings[0]) || (sources.regulatory && sources.regulatory[0]);
  if (primaryHit && matchesClaim(primaryHit, cats)) {
    evidence.push({ type: primaryHit.type || 'filing', sourceType: 'primary', date: primaryHit.date || null, url: primaryHit.url || null });
    return finalize(STATUS.VERIFIED_PRIMARY, cats[0], evidence, 'Independent primary filing/notice corroborates the claim.');
  }
  const newsHit = sources.news && sources.news[0];
  if (newsHit && matchesClaim(newsHit, cats)) {
    evidence.push({ type: 'news', sourceType: 'secondary', date: newsHit.date || null, url: newsHit.url || null });
    return finalize(STATUS.VERIFIED_SECONDARY, cats[0], evidence, 'Reputable secondary news corroborates the claim.');
  }

  // Nothing independent consulted or matched — the claim stands only on the post.
  const anyAdapter = sources.filings || sources.news || sources.regulatory;
  return finalize(
    anyAdapter ? STATUS.SOCIAL_ONLY : STATUS.UNVERIFIED,
    cats[0], evidence,
    anyAdapter ? 'No independent source corroborates the claim yet — social-only.' : 'No verification adapter available — unverified (degraded honestly).',
  );
}

function matchesClaim(hit, cats) {
  const tag = String(hit.catalyst || hit.type || '').toLowerCase();
  return cats.some(c => tag.includes(c) || c.includes(tag));
}
function finalize(status, verifiedCatalyst, sources, note) {
  return { status, verifiedCatalyst, sources, note };
}

// Is this verification status strong enough to count as independent catalyst evidence?
function isVerified(status) {
  return status === STATUS.VERIFIED_PRIMARY || status === STATUS.VERIFIED_SECONDARY;
}
// Freshness/quality contribution (0..1) of a verification status toward the score.
function catalystScore(status) {
  return { [STATUS.VERIFIED_PRIMARY]: 1.0, [STATUS.VERIFIED_SECONDARY]: 0.7, [STATUS.SOCIAL_ONLY]: 0.2, [STATUS.CONFLICTED]: 0.1, [STATUS.UNVERIFIED]: 0.15, [STATUS.FALSE_OR_STALE]: 0 }[status] ?? 0.15;
}

module.exports = { STATUS, EARNINGS_SOON_DAYS, verifyCatalyst, isVerified, catalystScore };
