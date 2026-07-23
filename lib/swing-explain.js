'use strict';
// SWING EXPLANATION ENGINE — deterministic reason-codes → plain language.
//
// Every state a pick lands in gets a concise, user-facing sentence built ONLY from measured
// numbers (return since suggestion, excess vs SPY, score/rank change, % of target remaining). It
// never invents a statistic and never presents an uncalibrated model number as a probability. Pure.

const { LIFECYCLE, THESIS } = require('./swing-lifecycle');

function pct(v, dp = 1) { return v == null || !Number.isFinite(+v) ? null : `${(+v * 100).toFixed(dp)}%`; }
function signedPct(v, dp = 1) { if (v == null || !Number.isFinite(+v)) return null; const s = +v >= 0 ? '+' : ''; return `${s}${(+v * 100).toFixed(dp)}%`; }
function n1(v) { return v == null || !Number.isFinite(+v) ? null : (Math.round(+v * 10) / 10); }

// Compose an explanation from the classification and the metrics.
//   cls: { lifecycle, thesis, reasonCodes }   m: the swing-evaluate metrics   origin: immutable origin
function explain(cls, m = {}, origin = {}) {
  const parts = [];
  const ret = signedPct(m.returnSinceSuggestion);
  const exSpy = m.excessVsSpy != null ? signedPct(m.excessVsSpy) : null;
  const remainingOfTarget = m.consumedPct != null ? pct(Math.max(0, 1 - m.consumedPct), 0) : null;
  const scoreFrom = n1(origin.originalScore), scoreTo = n1(m.currentScore);
  const rankFrom = origin.originalRank != null ? Math.round(origin.originalRank) : null;
  const rankTo = m.currentRank != null ? Math.round(m.currentRank) : null;

  switch (cls.lifecycle) {
    case LIFECYCLE.DATA_STALE:
      return 'Re-evaluation unavailable — required data is stale or unavailable; retaining the last confirmed state.';

    case LIFECYCLE.TARGET_HIT:
      return `Target reached — the original objective was met${ret ? ` (${ret} since suggestion)` : ''}. The episode stays in Completed for grading.`;

    case LIFECYCLE.INVALIDATED:
      return `No longer actionable — price closed through the original invalidation${ret ? `, ${ret} since suggestion` : ''}. The thesis is broken.`;

    case LIFECYCLE.EXPIRED: {
      const dir = (m.returnSinceFill ?? m.returnSinceSuggestion ?? 0) >= 0 ? 'in the green' : 'in the red';
      return `Time exit — the maximum hold elapsed with neither target nor stop hit; closed ${dir}${ret ? ` (${ret} since suggestion)` : ''}.`;
    }

    case LIFECYCLE.NO_FILL:
      if ((cls.reasonCodes || []).includes('GAP_BEYOND_MAX_ENTRY')) {
        return 'No fill — the stock gapped beyond the maximum acceptable entry, so it was skipped. This is a no-fill, not a loss.';
      }
      return `Entry expired — the breakout trigger was never reached within the allowed window. This is a no-fill, not a loss.`;

    case LIFECYCLE.WEAKENING: {
      const cracks = [];
      if ((cls.reasonCodes || []).includes('RS_DETERIORATION')) cracks.push('relative strength turned negative');
      if ((cls.reasonCodes || []).includes('VOLUME_FADE')) cracks.push('volume participation declined');
      if ((cls.reasonCodes || []).includes('TREND_BREAK')) cracks.push('price lost the 20-day average');
      if ((cls.reasonCodes || []).includes('SECTOR_ROLLOVER')) cracks.push('the sector rolled over');
      const scoreClause = scoreFrom != null && scoreTo != null ? ` and the score fell from ${scoreFrom} to ${scoreTo}` : '';
      return `Weakening — ${cracks.length ? cracks.join(', ') : 'the thesis is deteriorating'}${scoreClause}. Still open; tighten risk.`;
    }

    case LIFECYCLE.EXTENDED: {
      const bits = [];
      if (remainingOfTarget) bits.push(`only ${remainingOfTarget} of the original target remains`);
      if (m.remainingRewardRisk != null) bits.push(`remaining reward-to-risk is ${n1(m.remainingRewardRisk)}`);
      return `Do not chase — ${bits.length ? bits.join(' and ') : 'the move is extended'}. Fine to hold, not to enter fresh.`;
    }

    case LIFECYCLE.VALID_BUT_DISPLACED: {
      if ((cls.reasonCodes || []).includes('SOURCE_DROPPED') && !(cls.reasonCodes || []).includes('RANK_CUTOFF')) {
        return `Source no longer selects — the original screener condition is absent, but the price structure and original thesis remain intact${ret ? ` (${ret} since suggestion)` : ''}.`;
      }
      const rankClause = rankFrom != null && rankTo != null ? `fell from rank ${rankFrom} to rank ${rankTo}` : 'slipped in the ranking';
      return `Valid but displaced — the setup remains intact but ${rankClause} as stronger candidates entered the universe.`;
    }

    case LIFECYCLE.WAITING_FOR_TRIGGER:
      return `Waiting for trigger — the setup is valid but the entry has not fired yet. No position; watch for the breakout.`;

    case LIFECYCLE.ENTERABLE:
      return `Enterable now — a fresh swing setup at or near the entry${m.remainingRewardRisk != null ? `, with ${n1(m.remainingRewardRisk)} reward-to-risk` : ''}.`;

    case LIFECYCLE.NEW:
      return `New candidate — first published this session.`;

    case LIFECYCLE.THESIS_INTACT:
    default: {
      if (cls.thesis === THESIS.STRENGTHENING && scoreFrom != null && scoreTo != null) {
        return `Strengthening — the score improved from ${scoreFrom} to ${scoreTo} as relative strength and participation built${ret ? `; ${ret} since suggestion` : ''}.`;
      }
      parts.push('Still valid');
      const clauses = [];
      if (ret) clauses.push(`${ret} since suggestion`);
      if (exSpy) clauses.push(`${exSpy.startsWith('+') ? 'leading' : 'lagging'} SPY by ${exSpy.replace('+', '').replace('-', '')}`);
      if (m.priceVsMa20 != null) clauses.push(`${m.priceVsMa20 >= 0 ? 'holding above' : 'below'} the 20-day average`);
      if (remainingOfTarget) clauses.push(`${remainingOfTarget} of the original target remaining`);
      return clauses.length ? `${parts[0]} — ${clauses.join(', ')}.` : `${parts[0]} — the original thesis is intact.`;
    }
  }
}

module.exports = { explain };
