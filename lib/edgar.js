const { fetchWithTimeout } = require('./http');
// SEC EDGAR — point-in-time insider (Form 4) transactions.
//
// Why EDGAR and not the Finnhub snapshot: Finnhub gives the LIVE trailing-90d net
// only. EDGAR is the primary source and exposes the FULL filing history, so we can
// reconstruct insider net-buying AS OF any historical date — which is what makes
// the IN pillar backtestable in the walk-forward harness (no train/serve skew).
//
// SEC etiquette (required): a descriptive User-Agent with contact info, and ≤10
// requests/sec. Set SEC_USER_AGENT to override the default contact string.
const SEC_UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';
const H = { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate', 'Accept': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const m1 = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };

// ── ticker → zero-padded CIK (cached for the process) ──────────────────────
let _cikMap = null;
async function loadCikMap() {
  if (_cikMap) return _cikMap;
  const r = await fetchWithTimeout('https://www.sec.gov/files/company_tickers.json', { headers: H });
  if (!r.ok) throw new Error('SEC company_tickers ' + r.status);
  const j = await r.json();
  _cikMap = {};
  for (const k in j) { const row = j[k]; if (row && row.ticker) _cikMap[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0'); }
  return _cikMap;
}
async function cikFor(ticker) {
  const map = await loadCikMap();
  return map[String(ticker).toUpperCase()] || null;
}

// ── list a company's Form 4 filings on/after `fromDate` (YYYY-MM-DD) ────────
async function fetchForm4List(cik, fromDate, maxFilings = 60) {
  const r = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: H });
  if (!r.ok) return [];
  const j = await r.json();
  const rec = j.filings && j.filings.recent;
  if (!rec || !Array.isArray(rec.form)) return [];
  const out = [];
  for (let i = 0; i < rec.form.length && out.length < maxFilings; i++) {
    if (rec.form[i] !== '4') continue;
    const filingDate = rec.filingDate[i];
    if (fromDate && filingDate < fromDate) continue;   // recent[] is newest-first
    out.push({ accession: rec.accessionNumber[i], filingDate, primaryDoc: rec.primaryDocument[i] });
  }
  return out;
}

// Resolve the ownership XML for a filing and fetch its text. The primaryDocument
// is often an XSL-rendered HTML wrapper, so we read the filing index and grab the
// actual .xml ownership document.
async function fetchForm4Xml(cik, accession, primaryDoc) {
  const accNo = accession.replace(/-/g, '');
  const numCik = String(parseInt(cik, 10));
  const base = `https://www.sec.gov/Archives/edgar/data/${numCik}/${accNo}`;
  let xmlName = (primaryDoc && /\.xml$/i.test(primaryDoc)) ? primaryDoc.split('/').pop() : null;
  if (!xmlName) {
    try {
      const ir = await fetchWithTimeout(`${base}/index.json`, { headers: H });
      if (ir.ok) {
        const items = (((await ir.json()).directory || {}).item) || [];
        // Prefer the ownership doc (.xml that isn't the XSL stylesheet).
        const xml = items.find(it => /\.xml$/i.test(it.name) && !/xsl/i.test(it.name));
        if (xml) xmlName = xml.name;
      }
    } catch {}
  }
  if (!xmlName) return null;
  const dr = await fetchWithTimeout(`${base}/${xmlName}`, { headers: { ...H, 'Accept': 'application/xml,text/xml' } });
  if (!dr.ok) return null;
  return dr.text();
}

// Parse open-market non-derivative transactions from a Form 4 ownership XML.
// transactionCode P = open-market purchase, S = open-market sale (the conviction
// signals). A/D = acquired/disposed (sign check). Returns owner role + tx list.
function parseForm4(xml) {
  if (!xml) return null;
  const owner = m1(xml, /<rptOwnerName>\s*([^<]+?)\s*<\/rptOwnerName>/i);
  const isDirector = /<isDirector>\s*(1|true)\s*<\/isDirector>/i.test(xml);
  const isOfficer = /<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(xml);
  const isTenPct = /<isTenPercentOwner>\s*(1|true)\s*<\/isTenPercentOwner>/i.test(xml);
  const txs = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];
  for (const b of blocks) {
    const code = m1(b, /<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i);
    if (code !== 'P' && code !== 'S') continue;                 // open-market only
    const date = m1(b, /<transactionDate>\s*<value>\s*([0-9-]+)\s*<\/value>/i);
    const shares = parseFloat(m1(b, /<transactionShares>\s*<value>\s*([0-9.]+)\s*<\/value>/i) || '0');
    const price = parseFloat(m1(b, /<transactionPricePerShare>\s*<value>\s*([0-9.]+)\s*<\/value>/i) || '0');
    const ad = m1(b, /<transactionAcquiredDisposedCode>\s*<value>\s*([AD])\s*<\/value>/i);
    if (!shares) continue;
    txs.push({ date, code, shares, price, value: Math.round(shares * price), ad, owner, isDirector, isOfficer, isTenPct });
  }
  return { owner, isDirector, isOfficer, isTenPct, txs };
}

// All open-market insider transactions for a ticker on/after `fromDate`.
// Polite: small delay between filing fetches to respect SEC's rate limit.
async function fetchInsiderTransactions(ticker, { fromDate = null, maxFilings = 60, throttleMs = 120 } = {}) {
  const cik = await cikFor(ticker);
  if (!cik) return { ticker, cik: null, txs: [], note: 'no CIK' };
  const filings = await fetchForm4List(cik, fromDate, maxFilings);
  const txs = [];
  for (const f of filings) {
    try {
      const xml = await fetchForm4Xml(cik, f.accession, f.primaryDoc);
      const parsed = parseForm4(xml);
      if (parsed && parsed.txs.length) {
        for (const t of parsed.txs) txs.push({ ...t, filingDate: f.filingDate, accession: f.accession });
      }
    } catch {}
    if (throttleMs) await sleep(throttleMs);
  }
  return { ticker, cik, filings: filings.length, txs };
}

// ── list a company's recent filings of ANY form type on/after `fromDate` ─────
// Deterministic primary-source capital-structure evidence for the Biotech Swing Engine:
// S-3 / 424B5 / 424B* (shelf + priced offering), 8-K (offering announcements), 424B3, etc.
// `forms` is an array of exact form strings OR prefixes ending in '*' (e.g. '424B*'). Reads
// the same free data.sec.gov submissions endpoint used for Form 4; NO paid provider needed.
async function fetchRecentFilings(cik, { forms = null, fromDate = null, maxFilings = 40 } = {}) {
  if (!cik) return [];
  const matches = f => {
    if (!forms) return true;
    return forms.some(w => (w.endsWith('*') ? f.startsWith(w.slice(0, -1)) : f === w));
  };
  const r = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: H });
  if (!r.ok) return [];
  const j = await r.json();
  const rec = j.filings && j.filings.recent;
  if (!rec || !Array.isArray(rec.form)) return [];
  const out = [];
  for (let i = 0; i < rec.form.length && out.length < maxFilings; i++) {
    const form = rec.form[i];
    if (!matches(form)) continue;
    const filingDate = rec.filingDate[i];
    if (fromDate && filingDate < fromDate) continue;   // recent[] is newest-first
    out.push({
      form, filingDate,
      accession: rec.accessionNumber[i], primaryDoc: rec.primaryDocument[i],
      items: rec.items ? rec.items[i] : null,          // 8-K item numbers (e.g. "1.01,3.02")
      url: `https://www.sec.gov/Archives/edgar/data/${String(parseInt(cik, 10))}/${rec.accessionNumber[i].replace(/-/g, '')}/`,
    });
  }
  return out;
}

// Convenience: fetch the offering-relevant filings for a ticker in one call. Returns a small
// structured summary the capital-structure model consumes (dates only — no document parsing,
// so it stays fast and never fabricates offering size).
async function fetchOfferingFilings(ticker, { fromDate = null, maxFilings = 40 } = {}) {
  const cik = await cikFor(ticker);
  if (!cik) return { ticker, cik: null, filings: [], note: 'no CIK' };
  const filings = await fetchRecentFilings(cik, { forms: ['S-3', 'S-3/A', '424B5', '424B3', '424B4', '8-K'], fromDate, maxFilings });
  return { ticker, cik, filings };
}

// Aggregate a transaction list into a net buy/sell baseline over an optional
// [windowStart, asOf] date window — the same shape the IN pillar consumes.
function aggregateInsider(txs, { windowStart = null, asOf = null } = {}) {
  const buys = { value: 0, shares: 0, tx: 0, names: new Set() };
  const sells = { value: 0, shares: 0, tx: 0, names: new Set() };
  for (const t of txs) {
    const d = t.date || t.filingDate;
    if (windowStart && d < windowStart) continue;
    if (asOf && d > asOf) continue;
    const bucket = t.code === 'P' ? buys : sells;
    bucket.value += t.value; bucket.shares += t.shares; bucket.tx += 1;
    if (t.owner) bucket.names.add(t.owner);
  }
  if (!buys.tx && !sells.tx) return null;
  const shape = b => ({ value: Math.round(b.value), shares: b.shares, tx: b.tx, insiders: b.names.size });
  return {
    buys: shape(buys), sells: shape(sells),
    net: { value: Math.round(buys.value - sells.value), shares: buys.shares - sells.shares },
    source: 'edgar',
  };
}

module.exports = { cikFor, loadCikMap, fetchForm4List, fetchForm4Xml, parseForm4, fetchInsiderTransactions, aggregateInsider, fetchRecentFilings, fetchOfferingFilings };
