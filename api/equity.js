// Vercel serverless — proxy de datos de Equity desde Yahoo Finance (sin API key).
// Acciones: ?action=metrics&tickers=A,B | movers | trending | news&q=...
// El token/crumb y las cookies viven sólo del lado del servidor.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Mapeo ticker de la guía → símbolo Yahoo. ARG con ADR → ADR (USD + fundamentals); solo-BYMA → .BA.
const YF = {
  // ETFs / CEDEARs (mismo símbolo US, salvo BRK-B)
  BRKB:'BRK-B', B:'B', TXR:'TX', TEN:'TS',
  // Acciones argentinas
  PAMP:'PAM', BMA:'BMA', CEPU:'CEPU', YPFD:'YPF', EDN:'EDN', LOMA:'LOMA', TGSU2:'TGS',
  BYMA:'BYMA.BA', TRAN:'TRAN.BA', TXAR:'TXAR.BA'
};
const yf = t => YF[t] || t;

let _cookie = null, _crumb = null, _crumbTs = 0;
async function ensureCrumb() {
  if (_crumb && Date.now() - _crumbTs < 25 * 60 * 1000) return;
  let cookie = '';
  try { const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; } catch (e) {}
  if (!cookie) { try { const r = await fetch('https://finance.yahoo.com', { headers: { 'User-Agent': UA } }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; } catch (e) {} }
  const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, cookie } });
  _crumb = (await cr.text()).trim(); _cookie = cookie; _crumbTs = Date.now();
}

const raw = o => (o && typeof o === 'object' && 'raw' in o) ? o.raw : (typeof o === 'number' ? o : null);
const cache = new Map();
const cget = (k, ttl) => { const e = cache.get(k); return (e && Date.now() - e.t < ttl) ? e.v : null; };
const cset = (k, v) => { cache.set(k, { v, t: Date.now() }); return v; };

async function yget(url, useCookie) {
  const headers = { 'User-Agent': UA }; if (useCookie && _cookie) headers.cookie = _cookie;
  const r = await fetch(url, { headers }); if (!r.ok) throw new Error('yf ' + r.status); return r.json();
}

async function getMetrics(tickers) {
  const key = 'm:' + tickers.slice().sort().join(','); const hit = cget(key, 15 * 60 * 1000); if (hit) return hit;
  await ensureCrumb();
  const out = {};
  // 1) Precio + technicals + P/E en lote (v7 quote, chunks de 50)
  for (let i = 0; i < tickers.length; i += 50) {
    const ch = tickers.slice(i, i + 50);
    try {
      const syms = ch.map(yf);
      const j = await yget(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms.join(','))}&crumb=${encodeURIComponent(_crumb)}`, true);
      const bySym = {}; ((j.quoteResponse && j.quoteResponse.result) || []).forEach(q => bySym[q.symbol] = q);
      ch.forEach(tk => {
        const q = bySym[yf(tk)]; if (!q) { out[tk] = { err: true }; return; }
        const p = q.regularMarketPrice, s200 = q.twoHundredDayAverage, s50 = q.fiftyDayAverage, hi = q.fiftyTwoWeekHigh, lo = q.fiftyTwoWeekLow;
        out[tk] = {
          precio: p, ccy: q.currency, varDia: q.regularMarketChangePercent,
          vsSMA200: s200 ? (p / s200 - 1) * 100 : null,
          vsSMA50: s50 ? (p / s50 - 1) * 100 : null,
          posRango: (hi && lo && hi > lo) ? (p - lo) / (hi - lo) * 100 : null,
          pe: q.trailingPE != null ? q.trailingPE : null, hi52: hi, lo52: lo
        };
      });
    } catch (e) { ch.forEach(tk => { if (!out[tk]) out[tk] = { err: true }; }); }
  }
  // 2) EV/EBITDA + ROE por ticker (quoteSummary), concurrencia limitada
  const fund = tickers.filter(tk => out[tk] && !out[tk].err);
  let idx = 0;
  const worker = async () => {
    while (idx < fund.length) {
      const tk = fund[idx++];
      try {
        const qs = await yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yf(tk))}?modules=defaultKeyStatistics,financialData&crumb=${encodeURIComponent(_crumb)}`, true);
        const r = qs.quoteSummary.result[0];
        out[tk].evEbitda = raw(r.defaultKeyStatistics && r.defaultKeyStatistics.enterpriseToEbitda);
        const roe = raw(r.financialData && r.financialData.returnOnEquity);
        out[tk].roe = roe == null ? null : roe * 100;
      } catch (e) {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return cset(key, out);
}

async function quotes(syms) {
  if (!syms.length) return [];
  await ensureCrumb();
  const j = await yget(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms.join(','))}&crumb=${encodeURIComponent(_crumb)}`, true);
  return (j.quoteResponse && j.quoteResponse.result) || [];
}
const mapQ = x => ({ sym: x.symbol, name: x.shortName || x.longName || x.symbol, precio: x.regularMarketPrice, chg: x.regularMarketChangePercent, vol: x.regularMarketVolume, ccy: x.currency });

async function getMovers() {
  const hit = cget('movers', 10 * 60 * 1000); if (hit) return hit;
  const one = async id => { try { const j = await yget(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${id}&count=12`); return (j.finance.result[0].quotes || []).map(mapQ); } catch (e) { return []; } };
  const [gainers, losers, actives] = await Promise.all([one('day_gainers'), one('day_losers'), one('most_actives')]);
  return cset('movers', { gainers, losers, actives });
}

async function getTrending() {
  const hit = cget('trending', 10 * 60 * 1000); if (hit) return hit;
  let syms = [];
  try { const j = await yget('https://query1.finance.yahoo.com/v1/finance/trending/US?count=15'); syms = (j.finance.result[0].quotes || []).map(x => x.symbol); } catch (e) {}
  let list = [];
  try { list = (await quotes(syms)).map(mapQ); } catch (e) { list = syms.map(s => ({ sym: s, name: s })); }
  return cset('trending', { list });
}

async function getNews(q) {
  const key = 'news:' + (q || 'markets'); const hit = cget(key, 15 * 60 * 1000); if (hit) return hit;
  let news = [];
  try {
    const j = await yget(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q || 'stock market')}&newsCount=12&quotesCount=0`);
    news = (j.news || []).map(n => ({ title: n.title, publisher: n.publisher, link: n.link, ts: n.providerPublishTime, tickers: n.relatedTickers || [] }));
  } catch (e) {}
  return cset(key, { news });
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const action = q.action || 'metrics';
  try {
    let data;
    if (action === 'metrics') {
      const tickers = String(q.tickers || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 80);
      data = await getMetrics(tickers);
    } else if (action === 'movers') data = await getMovers();
    else if (action === 'trending') data = await getTrending();
    else if (action === 'news') data = await getNews(q.q);
    else { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'bad action' })); }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.end(JSON.stringify({ ok: true, action, data }));
  } catch (e) {
    res.statusCode = 502; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
