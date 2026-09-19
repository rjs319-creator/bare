'use strict';
// Frozen four-arm diagnostic on the already-consumed 2025-10→2026-05 gap-news window.
// This is a mechanism comparison, not a fresh alpha confirmation and never affects live ranks.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const PIT = require('./lib/pit');
const { screenTicker } = require('../lib/screener');
const NF = require('../lib/research/news-alpha-features');

const ID = 'improved-news-composite-diagnostic-2026-08';
const VERSION = 'improved-news-composite-v2';
const DATA = path.join(__dirname, 'data'), H = 21, TOP_K = 10;
const events = JSON.parse(fs.readFileSync(path.join(DATA, 'gap-events-cause.json'), 'utf8')).filter(x => x.date >= '2025-10-15');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = K.mean;

function newsFile(sym, date) { const from = new Date(Date.parse(date) - 3 * 86400000).toISOString().slice(0, 10); return path.join(DATA, 'gapnews', `${sym}_${from}.json`); }
function loadNews(sym, date) { try { const x = JSON.parse(fs.readFileSync(newsFile(sym, date), 'utf8')); return Array.isArray(x) ? x : []; } catch { return []; } }
function loadRaw(sym) { try { return JSON.parse(fs.readFileSync(path.join(K.CACHE_DIR, `${sym}.json`), 'utf8')); } catch { return null; } }
function rank01(rows, key) {
  const v = rows.map((x, i) => [x[key], i]).filter(x => Number.isFinite(x[0])).sort((a, b) => a[0] - b[0]);
  for (let lo = 0; lo < v.length;) { let hi = lo + 1; while (hi < v.length && v[hi][0] === v[lo][0]) hi++;
    const z = v.length === 1 ? .5 : ((lo + hi - 1) / 2) / (v.length - 1); for (let i = lo; i < hi; i++) rows[v[i][1]][`${key}Rank`] = z; lo = hi; }
  rows.forEach(x => { if (!Number.isFinite(x[`${key}Rank`])) x[`${key}Rank`] = .5; });
}
function fundamentalsAsOf(income, date) {
  const cutoff = Date.parse(date + 'T20:00:00Z');
  const q = (income || []).map(x => ({ ...x, eff: Date.parse(x.acceptedDate || x.filingDate || x.date) + ((x.acceptedDate || x.filingDate) ? 0 : PIT.LAG) }))
    .filter(x => Number.isFinite(x.eff) && x.eff <= cutoff).sort((a, b) => b.eff - a.eff);
  if (!q.length || !(q[0].revenue > 0)) return null;
  const cur = q[0], prev = q[1], yr = q[4] || q[3];
  const g = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-9 ? a / Math.abs(b) - 1 : null;
  const opm = x => x && x.revenue > 0 ? x.operatingIncome / x.revenue : null;
  const revGrowth = yr ? g(cur.revenue, yr.revenue) : null, prevRevGrowth = prev && q[5] ? g(prev.revenue, q[5].revenue) : null;
  const epsGrowth = yr ? g(cur.eps, yr.eps) : null, prevEpsGrowth = prev && q[5] ? g(prev.eps, q[5].eps) : null;
  return { ttmRevenue: q.slice(0, 4).reduce((s, x) => s + (x.revenue || 0), 0),
    acceleration: .45 * clamp(((revGrowth ?? 0) - (prevRevGrowth ?? 0) + .4) / .8, 0, 1)
      + .3 * clamp(((epsGrowth ?? 0) - (prevEpsGrowth ?? 0) + 1) / 2, 0, 1)
      + .25 * clamp(((opm(cur) ?? 0) - (opm(prev) ?? 0) + .1) / .2, 0, 1),
    dilution: yr && yr.weightedAverageShsOut > 0 ? cur.weightedAverageShsOut / yr.weightedAverageShsOut - 1 : null };
}
function perf(c, spy, d) { const i = c.findIndex(x => x.date === d), j = spy.findIndex(x => x.date === d); if (i < 127 || j < 127) return null;
  const ret = (x, k, n) => x[k].close / x[k - n].close - 1;
  const residualMomentum = (ret(c, i - 21, 105) - ret(spy, j - 21, 105)); // 126→21 skip-most-recent
  const path = []; for (let k = i - 62; k <= i; k++) path.push(c[k].close / c[k - 1].close - 1);
  const vol = Math.sqrt(mean(path.map(x => x * x))) || .01;
  return { residualMomentum, vol, oneDayExcess: ret(c, i, 1) - ret(spy, j, 1) };
}
function entryQuality(t) { const f = t.factors || {}, m = t.metrics || {};
  const ext = Math.abs((f.mom21 ?? 0) / Math.max(1, m.adrPct ?? 3));
  return clamp(.35 * (m.accumRatio ?? 1) / 2 + .25 * (m.udVol ?? 1) / 2 + .25 * (f.trendTemplate ?? 0) + .15 * (1 - clamp(ext / 8, 0, 1)), 0, 1); }

const ARMS = Object.freeze({
  residualMomentum: x => x.residRank,
  residualPlusEntry: x => .7*x.residRank + .3*x.entryRank,
  materialNewsUnderreaction: x => x.newsRank,
  fullComposite: x => .35*x.newsRank + .30*x.residRank + .20*x.entryRank + .15*x.accelRank - .15*x.consumedRank - .10*x.volRank,
  gatedComposite: x => x.riskGate ? -Infinity : .35*x.newsRank + .30*x.residRank + .20*x.entryRank + .15*x.accelRank - .15*x.consumedRank - .10*x.volRank,
});
function evalArm(panels, name) { const rows = panels.map(p => { const top = p.rows.filter(x => Number.isFinite(ARMS[name](x))).sort((a,b) => ARMS[name](b)-ARMS[name](a)||a.ticker.localeCompare(b.ticker)).slice(0,TOP_K); return top.length >= 3 ? {date:p.date,value:mean(top.map(x=>x.netExcess))*100} : null; }).filter(Boolean); return K.summarizeByDate(rows,{horizonBars:H}); }
function pairedLiftValue(a, b) { return (mean(a) - mean(b)) * 100; }

async function main() {
  const t0 = Date.now(), { dataset, spy, spyIdx, attrition } = K.loadUniverse({minBars:180,minAdv:1e6,maxNames:12000});
  const raw = new Map([...new Set(events.map(x=>x.sym))].map(t=>[t,loadRaw(t)]).filter(x=>x[1]));
  const byDate = new Map(); for(const e of events){if(!byDate.has(e.date))byDate.set(e.date,[]);byDate.get(e.date).push(e);}
  const panels=[];
  for(const [date,evs] of [...byDate].sort((a,b)=>a[0].localeCompare(b[0]))){const sf=K.benchmarkForward(spy,spyIdx,date,H);if(sf==null)continue;const sp=K.sliceAsOf(spy,date),spyByDate={};sp.forEach(x=>spyByDate[x.date]=x.close);const rows=[];
    for(const e of evs){const d=dataset.get(e.sym),rr=raw.get(e.sym);if(!d||!rr)continue;const pit=K.sliceAsOf(d.candles,date);if(pit.length<160||pit.at(-1).date!==date)continue;const pf=perf(d.candles,spy,date),fw=K.forwardFromNextOpen(d,date,H);if(!pf||fw==null)continue;const tech=screenTicker(pit,{symbol:e.sym},{gate:'relaxed',spyByDate});if(!tech||!tech.factors)continue;const fund=fundamentalsAsOf(rr.income,date),articles=loadNews(e.sym,date),nw=NF.improvedNewsFeature({articles,stock:d.candles,benchmark:spy,decisionDate:date,ttmRevenue:fund&&fund.ttmRevenue}),flags=NF.newsRiskFlags(articles,{decisionDate:date});const cost=K.costFractions(tech.factors.dollarVol);
      rows.push({ticker:e.sym,netExcess:fw-sf-cost.base,resid:pf.residualMomentum,entry:entryQuality(tech),news:nw.score,accel:fund?fund.acceleration:null,consumed:nw.consumedPenalty,vol:pf.vol,riskGate:flags.offeringOrDilution||flags.guidanceCutOrMiss||flags.binaryLegalOrClinical||(fund&&fund.dilution>.15)||(nw.consumedPenalty>=75)||(tech.factors.dollarVol<5e6)});}
    if(rows.length<TOP_K)continue;for(const k of ['resid','entry','news','accel','consumed','vol'])rank01(rows,k);panels.push({date,rows});}
  const results=Object.fromEntries(Object.keys(ARMS).map(n=>[n,evalArm(panels,n)]));
  const lift=(a,b)=>K.summarizeByDate(panels.map(p=>{const pick=n=>p.rows.filter(x=>Number.isFinite(ARMS[n](x))).sort((u,v)=>ARMS[n](v)-ARMS[n](u)||u.ticker.localeCompare(v.ticker)).slice(0,TOP_K);const x=pick(a),y=pick(b);return x.length>=3&&y.length>=3?{date:p.date,value:pairedLiftValue(x.map(z=>z.netExcess),y.map(z=>z.netExcess))}:null;}).filter(Boolean),{horizonBars:H});
  const lifts={entryOverResidual:lift('residualPlusEntry','residualMomentum'),newsOverResidual:lift('materialNewsUnderreaction','residualMomentum'),fullOverResidualEntry:lift('fullComposite','residualPlusEntry'),gatingOverFull:lift('gatedComposite','fullComposite')};
  const verdict=(lifts.fullOverResidualEntry&&lifts.fullOverResidualEntry.ci95.lo>0&&results.gatedComposite.ci95.lo>0)?'PROMISING_DIAGNOSTIC_NEEDS_FUTURE_CONFIRMATION':'NO_INCREMENTAL_ALPHA';
  const art={studyId:ID,version:VERSION,contract:{arms:Object.keys(ARMS),weights:{news:.35,residualMomentum:.30,entryQuality:.20,fundamentalAcceleration:.15,consumedPenalty:-.15,volatilityPenalty:-.10},horizon:H,topK:TOP_K,entry:'next-session open',outcome:'cost-net excess vs SPY'},data:{first:panels[0]?.date,last:panels.at(-1)?.date,dates:panels.length,candidates:panels.reduce((s,p)=>s+p.rows.length,0),attrition},results,lifts,verdict,promotable:false,holdoutStatus:'DIAGNOSTIC_ONLY — all dates were previously examined by experiment 77',limitations:['Gap-event-conditioned news universe only.','Headline materiality is deterministic; exact dollars are available for only some articles.','Daily bars cannot isolate intraday publication timing.','Future prospective dates are required for confirmation.'],generatedAt:new Date().toISOString(),runtimeMs:Date.now()-t0};
  const out=K.writeArtifact(path.join(DATA,'improved-news-composite'),'result.json',art);K.recordExperiment({id:ID,hypothesis:'Material news underreaction, residual momentum, entry quality and fundamental acceleration add cost-net alpha beyond residual momentum plus entry quality.',frozenConfig:art.contract,dataSnapshot:art.data,codeVersion:VERSION,testDates:{first:art.data.first,last:art.data.last,n:art.data.dates},variationsAttempted:Object.keys(ARMS).length,result:{results,lifts,verdict},correctedSignificance:{method:'fixed five-arm diagnostic; previously consumed dates, no confirmatory claim'},costStress:{baseCostsApplied:true},decision:'NOT PROMOTED',reason:`${verdict}; diagnostic reused data.`,artifact:out});console.log(JSON.stringify({...art,artifact:out.file},null,2));return art;}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1);});module.exports={main,fundamentalsAsOf,entryQuality,pairedLiftValue,ARMS};
