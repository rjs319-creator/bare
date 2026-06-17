// Scan universes. Yahoo uses '-' for class shares (BRK-B, BF-B).
// Lists are curated snapshots — constituents drift over time; unknown/invalid
// tickers simply return no data and are skipped by the scanner.

// ── S&P 500 (large/mid cap) ──────────────────────────────────────────────
const SP500 = [
  'A','AAPL','ABBV','ABNB','ABT','ACGL','ACN','ADBE','ADI','ADM','ADP','ADSK','AEE','AEP','AES','AFL','AIG','AIZ','AJG','AKAM','ALB','ALGN','ALL','ALLE','AMAT','AMCR','AMD','AME','AMGN','AMP','AMT','AMZN','ANET','ANSS','AON','AOS','APA','APD','APH','APTV','ARE','ATO','AVB','AVGO','AVY','AWK','AXON','AXP','AZO','BA','BAC','BALL','BAX','BBY','BDX','BEN','BF-B','BG','BIIB','BK','BKNG','BKR','BLDR','BLK','BMY','BR','BRK-B','BRO','BSX','BX','BXP','C','CAG','CAH','CARR','CAT','CB','CBOE','CBRE','CCI','CCL','CDNS','CDW','CE','CEG','CF','CFG','CHD','CHRW','CHTR','CI','CINF','CL','CLX','CMCSA','CME','CMG','CMI','CMS','CNC','CNP','COF','COIN','COO','COP','COR','COST','CPAY','CPB','CPRT','CPT','CRL','CRM','CRWD','CSCO','CSGP','CSX','CTAS','CTLT','CTRA','CTSH','CTVA','CVS','CVX','CZR','D','DAL','DAY','DD','DE','DECK','DELL','DFS','DG','DGX','DHI','DHR','DIS','DLR','DLTR','DOC','DOV','DOW','DPZ','DRI','DTE','DUK','DVA','DVN','DXCM','EA','EBAY','ECL','ED','EFX','EG','EIX','EL','ELV','EMN','EMR','ENPH','EOG','EPAM','EQIX','EQR','EQT','ES','ESS','ETN','ETR','EVRG','EW','EXC','EXPD','EXPE','EXR','F','FANG','FAST','FCX','FDS','FDX','FE','FFIV','FI','FICO','FIS','FITB','FMC','FOX','FOXA','FRT','FSLR','FTNT','FTV','GD','GDDY','GE','GEHC','GEN','GEV','GILD','GIS','GL','GLW','GM','GNRC','GOOG','GOOGL','GPC','GPN','GRMN','GS','GWW','HAL','HAS','HBAN','HCA','HD','HES','HIG','HII','HLT','HOLX','HON','HPE','HPQ','HRL','HSIC','HST','HSY','HUBB','HUM','HWM','IBM','ICE','IDXX','IEX','IFF','INCY','INTC','INTU','INVH','IP','IPG','IQV','IR','IRM','ISRG','IT','ITW','IVZ','J','JBHT','JBL','JCI','JKHY','JNJ','JNPR','JPM','K','KDP','KEY','KEYS','KHC','KIM','KKR','KLAC','KMB','KMI','KMX','KO','KR','KVUE','L','LDOS','LEN','LH','LHX','LIN','LKQ','LLY','LMT','LNT','LOW','LRCX','LULU','LUV','LVS','LW','LYB','LYV','MA','MAA','MAR','MAS','MCD','MCHP','MCK','MCO','MDLZ','MDT','MET','META','MGM','MHK','MKC','MKTX','MLM','MMC','MMM','MNST','MO','MOH','MOS','MPC','MPWR','MRK','MRNA','MS','MSCI','MSFT','MSI','MTB','MTCH','MTD','MU','NCLH','NDAQ','NDSN','NEE','NEM','NFLX','NI','NKE','NOC','NOW','NRG','NSC','NTAP','NTRS','NUE','NVDA','NVR','NWS','NWSA','NXPI','O','ODFL','OKE','OMC','ON','ORCL','ORLY','OTIS','OXY','PANW','PARA','PAYC','PAYX','PCAR','PCG','PEG','PEP','PFE','PFG','PG','PGR','PH','PHM','PKG','PLD','PLTR','PM','PNC','PNR','PNW','PODD','POOL','PPG','PPL','PRU','PSA','PSX','PTC','PWR','PYPL','QCOM','RCL','REG','REGN','RF','RJF','RL','RMD','ROK','ROL','ROP','ROST','RSG','RTX','RVTY','SBAC','SBUX','SCHW','SHW','SJM','SLB','SMCI','SNA','SNPS','SO','SOLV','SPG','SPGI','SRE','STE','STLD','STT','STX','STZ','SWK','SWKS','SYF','SYK','SYY','T','TAP','TDG','TDY','TECH','TEL','TER','TFC','TFX','TGT','TJX','TMO','TMUS','TPR','TRGP','TRMB','TROW','TRV','TSCO','TSLA','TSN','TT','TTWO','TXN','TXT','TYL','UAL','UBER','UDR','UHS','ULTA','UNH','UNP','UPS','URI','USB','V','VICI','VLO','VLTO','VMC','VRSK','VRSN','VRTX','VST','VTR','VTRS','VZ','WAB','WAT','WBA','WBD','WDC','WEC','WELL','WFC','WM','WMB','WMT','WRB','WST','WTW','WY','WYNN','XEL','XOM','XYL','YUM','ZBH','ZBRA','ZTS',
];

// Non-S&P names with strong narratives / liquidity worth scanning alongside.
const THEMES = [
  'ARM','TSM','ASML','NU','APP','TTD','RIVN','SOFI','HOOD','CVNA','AFRM','RBLX','U','DASH','MELI','BABA','SMR','OKLO','CCJ','SHOP','SNOW','DDOG','NET','ZS','MDB','PINS','RDDT','TOST','HIMS','CELH',
];

// ── Small-cap (~$300M–$3B) — curated, liquid, across sectors/themes ────────
const SMALL_CAPS = [
  // Quantum / AI / space / defense-tech
  'IONQ','RGTI','QBTS','BBAI','SOUN','LUNR','RKLB','ASTS','ACHR','JOBY','SERV','PL','RDW','KTOS','AVAV','RCAT','ONDS','UMAC','LASR','KULR',
  // Clean energy / solar / hydrogen / storage
  'PLUG','FCEL','BE','RUN','NOVA','SHLS','ARRY','AMRC','MAXN','CSIQ','JKS','NXT','FLNC','STEM','OKLO','SMR',
  // Internet / consumer / e-commerce
  'FUBO','RUM','YELP','CARG','OPEN','COMP','EXPI','CARS','TRIP','YETI','CROX','BIRD','FIGS','WW','SKIN','OLPX','HELE','REAL','RVLV','GES','BKE','SFIX',
  // Fintech / crypto-adjacent
  'UPST','LMND','OPFI','MARA','RIOT','CLSK','BTBT','HUT','CIFR','WULF','HIVE','BITF','CAN','IREN','BTDR','PSFE',
  // Semis / hardware
  'AMBA','POWI','SLAB','CRUS','VECO','UCTT','ACLS','ONTO','SITM','INDI','NVTS','AOSL','MTSI','FORM','ICHR','PLAB','DIOD','RMBS','LSCC','SMTC',
  // Retail / restaurants / consumer
  'KSS','M','AEO','BBWI','VSCO','WOOF','PRTS','DNUT','WING','CAKE','BJRI','PLAY','SHAK','PTLO','FWRG','BROS','DIN','CBRL',
  // Biotech / med-tech
  'CRSP','BEAM','NTLA','VERV','RXRX','SDGR','ME','PACB','TWST','CDNA','FOLD','ARWR','RARE','KRYS','CYTK','ACAD','INSM','VKTX','CRNX','RNA','IOVA','DAWN','KYMR','RXST','TMDX','TNDM',
  // EV / mobility
  'CHPT','EVGO','BLNK','QS','LCID',
  // Other growth
  'PTON','GPRO','DV','APPS','DGII','CXM','BAND','PRPL','LOVE','SG','DOCS',
];

// ── Micro-cap (< ~$300M) — curated, more speculative/illiquid ──────────────
const MICRO_CAPS = [
  // Biotech micro
  'ATOS','OCGN','CYTH','ADTX','SLS','CMRX','TNXP','ENVB','CRBP','BNGO','PSNL','NVCT','CABA','ANIX','ATHA','CRMD','SNGX','VTGN','AGEN','CDXC','INMB','ELDN','GERN','ATNF','PRTA','CGEM',
  // EV / clean / hydrogen micro
  'GEVO','AMTX','CLNE','HYZN','NKLA','WKHS','SLDP','MVST','SOLO','FFIE','GOEV','ENVX','VLCN',
  // Lidar / sensors
  'OUST','MVIS','LIDR','AEVA','CPTN','INVZ',
  // AI / tech micro
  'GFAI','AISP','AITX','SES','LAES','POET','MARK',
  // Crypto miners / blockchain micro
  'SOS','GREE','SDIG','ARBK','BTCM','DGHI','BTCS',
  // Cannabis
  'SNDL','TLRY','OGI','CGC','ACB','CRON','VFF','GRWG',
  // Speculative / misc
  'CENN','MULN','INDO','HUSA','IMPP','ENSV','NINE','IDEX','LGVN','CISS','GORV',
];

const clean = arr => [...new Set(arr)].filter(t => /^[A-Z]{1,5}(-[A-Z])?$/.test(t));

// ── GICS-style sector map (approximate; covers the scan universe) ──────────
// Payments/data-processing (V, MA, PYPL, FI…) are Financials per the 2023 GICS
// reclass. Small/micro theme names are mapped to their closest sector.
const SECTOR_GROUPS = {
  'Technology': ['AAPL','MSFT','NVDA','AVGO','AMD','ORCL','CRM','ADBE','CSCO','ACN','QCOM','TXN','INTC','MU','AMAT','ADI','LRCX','KLAC','NOW','INTU','IBM','SNPS','CDNS','ANET','APH','MSI','FTNT','PANW','CRWD','ADSK','MCHP','NXPI','ON','MPWR','FICO','IT','GLW','HPQ','HPE','DELL','WDC','STX','KEYS','TEL','TER','TYL','PTC','GDDY','JBL','SMCI','ZBRA','AKAM','JNPR','FFIV','EPAM','GEN','CTSH','NTAP','SWKS','TRMB','VRSN','CDW','ANSS','PLTR','ARM','TSM','ASML','SNOW','DDOG','NET','ZS','MDB','APP','TTD','IONQ','RGTI','QBTS','BBAI','SOUN','PL','AMBA','POWI','SLAB','CRUS','VECO','UCTT','ACLS','ONTO','SITM','INDI','NVTS','AOSL','MTSI','FORM','ICHR','PLAB','DIOD','RMBS','LSCC','SMTC','DGII','GFAI','AISP','AITX','SES','LAES','POET','MARK','DV','APPS','BAND','CXM','DOCS','U'],
  'Communication Services': ['GOOGL','GOOG','META','NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR','EA','TTWO','WBD','OMC','IPG','LYV','MTCH','FOXA','FOX','PARA','NWSA','NWS','RDDT','PINS'],
  'Consumer Discretionary': ['AMZN','TSLA','HD','MCD','NKE','LOW','SBUX','BKNG','TJX','ORLY','CMG','MAR','GM','F','HLT','AZO','ROST','YUM','DHI','LEN','NVR','PHM','GRMN','APTV','LVS','WYNN','MGM','CZR','RCL','CCL','NCLH','EXPE','ABNB','DPZ','DRI','LULU','ULTA','BBY','KMX','POOL','TSCO','GPC','DECK','RL','TPR','MHK','LKQ','HAS','EBAY','BLDR','MELI','DKNG','CVNA','RIVN','DASH','FUBO','RUM','YELP','CARG','OPEN','COMP','EXPI','CARS','TRIP','YETI','CROX','BIRD','FIGS','WW','SKIN','OLPX','HELE','REAL','RVLV','GES','BKE','SFIX','KSS','M','AEO','BBWI','VSCO','WOOF','PRTS','DNUT','WING','CAKE','BJRI','PLAY','SHAK','PTLO','FWRG','BROS','DIN','CBRL','PTON','GPRO','PRPL','LOVE','SG','CHPT','EVGO','BLNK','QS','LCID','NKLA','WKHS','SLDP','MVST','SOLO','FFIE','GOEV','CENN','MULN'],
  'Consumer Staples': ['PG','KO','PEP','COST','WMT','PM','MO','MDLZ','CL','KMB','GIS','KDP','KHC','STZ','SYY','KVUE','HSY','KR','MNST','ADM','MKC','CHD','CLX','K','TAP','TSN','HRL','SJM','CAG','CPB','BG','LW','BF-B','DG','DLTR','CELH'],
  'Health Care': ['LLY','UNH','JNJ','ABBV','MRK','TMO','ABT','DHR','ISRG','AMGN','PFE','BSX','SYK','GILD','VRTX','MDT','BMY','CI','ELV','REGN','CVS','MCK','ZTS','BDX','HCA','EW','COR','A','IQV','IDXX','DXCM','GEHC','BIIB','RMD','MRNA','CNC','HUM','CAH','MOH','WST','STE','ALGN','BAX','HOLX','RVTY','PODD','TECH','WAT','MTD','LH','DGX','CRL','UHS','INCY','VTRS','CTLT','HSIC','DVA','SOLV','HIMS','CRSP','BEAM','NTLA','VERV','RXRX','SDGR','ME','PACB','TWST','CDNA','FOLD','ARWR','RARE','KRYS','CYTK','ACAD','INSM','VKTX','CRNX','RNA','IOVA','DAWN','KYMR','RXST','TMDX','TNDM','ATOS','OCGN','CYTH','ADTX','SLS','CMRX','TNXP','ENVB','CRBP','BNGO','PSNL','NVCT','CABA','ANIX','ATHA','CRMD','SNGX','VTGN','AGEN','CDXC','INMB','ELDN','GERN','ATNF','PRTA','CGEM','SNDL','TLRY','OGI','CGC','ACB','CRON','VFF','GRWG'],
  'Financials': ['BRK-B','JPM','V','MA','BAC','WFC','GS','MS','AXP','SPGI','BLK','C','SCHW','FI','PGR','CB','MMC','KKR','BX','FIS','PYPL','GPN','CME','ICE','MCO','AON','PNC','USB','AJG','TRV','AFL','MET','BK','COF','AIG','MSCI','AMP','ALL','PRU','TFC','DFS','ACGL','NDAQ','FITB','BRO','HIG','CBOE','STT','CINF','WRB','MTB','RF','HBAN','NTRS','RJF','SYF','CFG','FDS','BEN','IVZ','KEY','L','JKHY','BR','CPAY','EG','AIZ','GL','MKTX','COIN','SOFI','HOOD','AFRM','NU','UPST','LMND','OPFI','MARA','RIOT','CLSK','BTBT','HUT','CIFR','WULF','HIVE','BITF','CAN','IREN','BTDR','PSFE','SOS','GREE','SDIG','ARBK','BTCM','DGHI','BTCS'],
  'Industrials': ['GE','CAT','RTX','HON','UNP','BA','ETN','LMT','UPS','DE','ADP','PAYX','PAYC','TT','ITW','EMR','PH','GD','CSX','NSC','FDX','NOC','WM','TDG','GEV','CARR','JCI','CMI','PCAR','AME','ROP','ROK','OTIS','IR','FAST','RSG','URI','GWW','ODFL','VRSK','EFX','LHX','AXON','DAL','UAL','LUV','HWM','DOV','XYL','WAB','HUBB','FTV','IEX','PWR','NDSN','SNA','JBHT','J','GNRC','ALLE','MAS','AOS','CHRW','EXPD','TXT','HII','PNR','DAY','LDOS','CTAS','VLTO','UBER','LUNR','RKLB','ASTS','RDW','KTOS','AVAV','RCAT','ONDS','UMAC','LASR','KULR','ACHR','JOBY','SERV','FLNC','STEM','SHLS','AMRC'],
  'Energy': ['XOM','CVX','COP','EOG','SLB','MPC','PSX','WMB','OKE','KMI','VLO','HES','OXY','BKR','HAL','FANG','DVN','TRGP','CTRA','APA','EQT','CCJ','OKLO','SMR','PLUG','FCEL','BE','RUN','NOVA','ARRY','MAXN','CSIQ','JKS','NXT','FSLR','ENPH','GEVO','AMTX','CLNE','HYZN','ENVX','VLCN','INDO','HUSA','IMPP','ENSV','NINE'],
  'Utilities': ['NEE','DUK','SO','D','AEP','SRE','EXC','XEL','PEG','ED','PCG','WEC','ETR','AEE','DTE','ES','FE','PPL','AWK','CMS','CNP','NRG','ATO','NI','LNT','EVRG','AES','PNW','EIX'],
  'Real Estate': ['PLD','AMT','EQIX','WELL','SPG','PSA','O','CCI','DLR','CBRE','EXR','VICI','AVB','IRM','EQR','SBAC','VTR','ARE','INVH','MAA','ESS','KIM','UDR','DOC','REG','BXP','FRT','CPT','HST','CSGP'],
  'Materials': ['LIN','SHW','APD','ECL','FCX','NEM','CTVA','DOW','NUE','DD','MLM','VMC','PPG','IFF','ALB','LYB','STLD','BALL','AMCR','AVY','CF','IP','PKG','EMN','CE','MOS','FMC'],
};

const SECTOR_OF = {};
for (const [sector, list] of Object.entries(SECTOR_GROUPS)) for (const t of list) SECTOR_OF[t] = sector;
const SECTOR_LIST = Object.keys(SECTOR_GROUPS);

// Normalise Yahoo exchange codes → friendly names.
function exchangeName(code) {
  const c = (code || '').toUpperCase();
  if (['NMS', 'NGM', 'NCM', 'NASDAQ', 'NSD'].includes(c)) return 'NASDAQ';
  if (['NYQ', 'NYE', 'NYS', 'NYSE'].includes(c)) return 'NYSE';
  if (['ASE', 'AMEX', 'PCX', 'BATS'].includes(c)) return 'AMEX';
  return c || 'Other';
}

module.exports = {
  SP500,
  THEMES,
  LARGE: clean([...SP500, ...THEMES]),
  SMALL_CAPS: clean(SMALL_CAPS),
  MICRO_CAPS: clean(MICRO_CAPS),
  SECTOR_OF,
  SECTOR_LIST,
  exchangeName,
};
