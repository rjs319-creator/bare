// Evidence verdicts, in plain English — the shared honesty layer for every tab.
//
// The app already grades each strategy on its own resolved record (lib/maturity,
// op=maturity): Validated / Promising / Experimental / Informational / Disabled.
// Until now that verdict only existed on the Evidence tab, so you could sit on the
// 👻 Ghost tab reading pick cards with entries and stops while the app's own grade
// for Ghost was "Disabled — underperforms the market over 166 resolved (−4.2% vs
// SPY, beats 30%)". The tab never said so.
//
// This module is the one place that (a) speaks a grade in beginner English and
// (b) puts a tab's own verdict on that tab. One fetch, memoised and shared by every
// caller, so mounting the banner on 20 tabs costs one request.
import { esc } from './format.js';
import { fetchJSON, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';

// Plain-English face of lib/maturity's GRADE_META. The canonical grade word is kept
// in the tooltip so any badge can be traced back to the Evidence tab's verdict.
export const GRADE = {
  validated: { icon: '✅', label: 'Proven', cls: 'ok', lead: 'This has earned its place' },
  promising: { icon: '🟡', label: 'Promising', cls: 'prov', lead: 'Promising, not yet proven' },
  experimental: { icon: '🧪', label: 'Untested', cls: 'wait', lead: 'Still being tested — treat as research' },
  informational: { icon: 'ℹ️', label: 'Background info', cls: 'wait', lead: 'Context, not a buy or sell signal' },
  disabled: { icon: '⛔', label: 'Losing money so far', cls: 'bad', lead: 'Watch only — its results are behind the market' },
};
export const gradeFace = g => GRADE[g] || GRADE.experimental;

// Tab id → maturity strategy id. Most match by name; only the exceptions are listed,
// so a new tab whose id matches its strategy id needs no entry here.
const TAB_STRATEGY = {
  picks: 'momentum',
  rltlab: 'rlt',
  aligned: 'screener',
  // Pattern Radar shows ONLY its own evidence (id 'chartpattern'). It was previously
  // mapped to 'coil', which displayed the Coil strategy's record as if it were Pattern
  // Radar's — another strategy's performance must never stand in as pattern evidence.
  patternradar: 'chartpattern',
  atlas: 'atlasx',
  orbitlab: 'orbit',
  options: 'optionsflow',
};
export const strategyIdFor = tab => TAB_STRATEGY[tab] || tab;

// One shared fetch of the grade table. Memoised as a promise so twenty tabs opening
// in one session make one request; a failure is cached as null rather than retried
// on every tab switch (the banner is an enhancement, never a blocker).
let gradesPromise = null;
export function loadGrades() {
  if (!gradesPromise) {
    gradesPromise = fetchJSON('/api/tracker?op=maturity', { timeoutMs: OPTIONAL_TIMEOUT_MS })
      .then(d => {
        const map = {};
        for (const s of (d && d.strategies) || []) if (s && s.id) map[s.id] = s;
        return map;
      })
      .catch(() => null);
  }
  return gradesPromise;
}

// Turn a maturity strategy record into the banner's plain-English parts. Pure, so the
// wording rules are testable without a DOM or a network.
export function verdictFor(strategy) {
  if (!strategy || !strategy.grade) return null;
  const face = gradeFace(strategy.grade);
  const st = strategy.stats || {};
  const hasRecord = Number.isFinite(st.avgExcess) && st.excessN > 0;

  // The record in one beginner-legible sentence. "Beats the market 43% of the time"
  // is the number that matters and the one the raw reason buries. The BASIS matters
  // just as much: cost-net means trading friction is already subtracted; gross means
  // it is not — and a gross-only record can never be graded Proven.
  const basisNote = st.basis === 'net'
    ? ' Costs (spread + slippage) are already subtracted.'
    : (st.basis === 'gross' ? ' Before trading costs — a record this app will not call Proven until costs are counted.' : '');
  const record = hasRecord
    ? `Over ${st.excessN} past pick${st.excessN === 1 ? '' : 's'} that have run their course, this averaged `
      + `${st.avgExcess >= 0 ? '+' : ''}${st.avgExcess}% against the S&P 500 and beat it ${st.beatMktRate}% of the time.`
      + basisNote
    : null;

  // What a beginner should actually do about it.
  const advice = {
    validated: 'Its record holds up against the market. Still size positions so a loss is survivable.',
    promising: 'Early results are positive but the sample is too small to rely on. Treat it as a watchlist.',
    experimental: 'There is not enough resolved history to say whether this works. Do not size it like a proven strategy.',
    informational: 'Use it to understand the market, not to pick a trade.',
    disabled: 'On its own record it has lost to simply buying the S&P 500. The app keeps it visible and keeps scoring it, but it has not earned your money.',
  }[strategy.grade] || '';

  return { grade: strategy.grade, face, headline: face.lead, record, advice, reason: strategy.reason || '' };
}

export function verdictBannerHTML(strategy) {
  const v = verdictFor(strategy);
  if (!v) return '';
  return `<div class="ev-banner ${v.face.cls} ev-verdict" data-grade="${esc(v.grade)}">
    <div class="ev-banner-hd">${v.face.icon} ${esc(v.headline)}</div>
    ${v.record ? `<div class="ev-banner-bd">${esc(v.record)}</div>` : ''}
    <div class="ev-banner-bd">${esc(v.advice)}</div>
    <div class="ev-banner-bd ev-verdict-src" title="${esc(v.reason)}">Graded <b>${esc(v.face.label)}</b> from this strategy's own resolved results — the same verdict shown on the Evidence tab.</div>
  </div>`;
}

// Mount (or refresh) a tab's own verdict banner directly under its section heading.
// Inserted as a sibling of the tab's render container, so a tab redrawing its own
// contents never wipes the verdict. Silent no-op when the tab has no grade.
export async function mountVerdict(tabId) {
  try {
    const sec = document.getElementById(tabId);
    if (!sec) return;
    const grades = await loadGrades();
    if (!grades) return;
    const strategy = grades[strategyIdFor(tabId)];
    const html = verdictBannerHTML(strategy);
    if (!html) return;

    const existing = sec.querySelector(':scope > .ev-verdict');
    if (existing) {
      if (existing.dataset.grade === strategy.grade) return;   // already current
      existing.remove();
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const node = wrap.firstElementChild;
    if (!node) return;
    // Under the section heading (and under the "how to use" panel if one is present).
    const label = sec.querySelector(':scope > .section-label');
    if (label && label.nextSibling) sec.insertBefore(node, label.nextSibling);
    else if (label) sec.appendChild(node);
    else sec.insertBefore(node, sec.firstChild);
  } catch { /* non-fatal — the verdict is an enhancement, never a blocker */ }
}
