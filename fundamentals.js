// Datos fundamentales, resultados, opiniones de analistas y noticias.
//  - S&P 500: Finnhub (gratis con clave FINNHUB_API_KEY). Sin clave, se usa Yahoo.
//  - IBEX 35: Yahoo Finance (vía no oficial: cookie + "crumb"; puede cambiar o fallar).
// Todo se descarga poco a poco en segundo plano respetando límites de uso y se guarda en data/fundamentals.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE } from './market.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.FUNDAMENTALS_FILE || path.join(__dirname, 'data', 'fundamentals.json');
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const UA = 'Mozilla/5.0';
const HOUR = 3600e3;
const FUND_TTL = 24 * HOUR;   // los fundamentales cambian despacio: una vez al día
const NEWS_TTL = 3 * HOUR;    // noticias de lo que tienes en cartera o estás vigilando
const RETRY_TTL = 6 * HOUR;   // tras un fallo, no se insiste hasta pasadas 6 h
const CAL_TTL = 12 * HOUR;
const INS_TTL_WATCH = 24 * HOUR, INS_TTL = 3 * 24 * HOUR; // directivos: lo que tienes y los candidatos cada día; el resto cada 3 días
const STMT_TTL = 5 * 24 * HOUR; // cuentas (ingresos, balance…): cambian solo al publicar resultados
const EST_TTL = 24 * HOUR;    // revisiones de estimaciones de analistas: una vez al día

const BY = new Map(UNIVERSE.map((u) => [u.symbol, u]));
export const hasFinnhub = () => Boolean(FINNHUB_KEY);

const cache = { fundamentals: {}, news: {}, estimates: {}, statements: {}, insiders: {}, calendar: { fetchedAt: 0, dates: {} } };
const status = { errors: {}, paused: { finnhub: 0, yahoo: 0 } };

// ---------- caché en disco ----------
function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    cache.fundamentals = s.fundamentals ?? {};
    cache.news = s.news ?? {};
    cache.estimates = s.estimates ?? {};
    cache.statements = s.statements ?? {};
    cache.insiders = s.insiders ?? {};
    cache.calendar = s.calendar ?? { fetchedAt: 0, dates: {} };
    console.log(`Datos fundamentales recuperados (${Object.keys(cache.fundamentals).length} valores)`);
  } catch (e) {
    console.warn('No se pudo leer la caché de fundamentales:', e.message);
  }
}
let dirty = false, saveTimer = null;
export function flushFundamentals() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.warn('No se pudo guardar la caché de fundamentales:', e.message); }
}
function markDirty() { dirty = true; if (!saveTimer) saveTimer = setTimeout(flushFundamentals, 30000); }

// ---------- red: límites de uso y errores ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeLimiter(perMin) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const start = Math.max(now, next);
    next = start + 60000 / perMin;
    if (start > now) await sleep(start - now);
  };
}
const limiters = {
  finnhub: makeLimiter(Number(process.env.FINNHUB_PER_MIN || 50)), // el plan gratuito permite unas 60/min
  yahoo: makeLimiter(Number(process.env.YAHOO_FUND_PER_MIN || 15)),
  yahooStmt: makeLimiter(Number(process.env.YAHOO_STMT_PER_MIN || 40)),
  yahooIns: makeLimiter(Number(process.env.YAHOO_INS_PER_MIN || 30)),
};

async function http(url, { headers = {}, timeout = 8000, as = 'json' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal, redirect: as === 'raw' ? 'manual' : 'follow' });
    if (as === 'raw') return res;
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return as === 'text' ? await res.text() : await res.json();
  } finally { clearTimeout(timer); }
}

async function viaProvider(name, fn) {
  if (Date.now() < status.paused[name.startsWith('yahoo') ? 'yahoo' : name]) { const e = new Error('proveedor en pausa'); e.paused = true; throw e; }
  await limiters[name]();
  try { return await fn(); }
  catch (e) { if (e.status === 429) status.paused[name.startsWith('yahoo') ? 'yahoo' : name] = Date.now() + 60000; throw e; }
}

function noteError(kind, symbol, err) {
  const cur = status.errors[kind] ?? { count: 0 };
  status.errors[kind] = { count: cur.count + 1, last: err.message, symbol, t: Date.now() };
  if (cur.count % 25 === 0) console.warn(`[datos] ${kind}${symbol ? ' ' + symbol : ''}: ${err.message}${cur.count ? ` (${cur.count + 1} fallos)` : ''}`);
}

// ---------- utilidades de normalización ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (o, ...keys) => { for (const k of keys) { const v = num(o?.[k]); if (v != null) return v; } return null; };
const scale = (v, k) => (v == null ? null : v * k);
const surprisePct = (actual, estimate) => (num(actual) != null && num(estimate) != null && estimate !== 0 ? ((actual - estimate) / Math.abs(estimate)) * 100 : null);
const hasAny = (m) => Object.values(m).some((v) => v != null);

// ---------- Finnhub ----------
const fh = (p, params = {}) => viaProvider('finnhub', () => {
  const u = new URL('https://finnhub.io/api/v1' + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('token', FINNHUB_KEY);
  return http(u.toString());
});

export function normalizeFinnhubMetric(x = {}) {
  return {
    pe: pick(x, 'peTTM', 'peBasicExclExtraTTM', 'peNormalizedAnnual'),
    forwardPe: pick(x, 'forwardPE'),
    peg: pick(x, 'pegTTM', 'pegRatio'),
    ps: pick(x, 'psTTM', 'psAnnual'),
    pb: pick(x, 'pbQuarterly', 'pbAnnual'),
    evEbitda: pick(x, 'evEbitdaTTM', 'enterpriseValueOverEBITDATTM'),
    revGrowth: pick(x, 'revenueGrowthTTMYoy'),
    epsGrowth: pick(x, 'epsGrowthTTMYoy'),
    revGrowth3y: pick(x, 'revenueGrowth3Y'),
    epsGrowth3y: pick(x, 'epsGrowth3Y'),
    netMargin: pick(x, 'netProfitMarginTTM', 'netProfitMarginAnnual'),
    opMargin: pick(x, 'operatingMarginTTM', 'operatingMarginAnnual'),
    roe: pick(x, 'roeTTM', 'roeRfy'),
    debtToEquity: pick(x, 'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual'),
    currentRatio: pick(x, 'currentRatioQuarterly', 'currentRatioAnnual'),
    beta: pick(x, 'beta'),
    high52: pick(x, '52WeekHigh'),
    low52: pick(x, '52WeekLow'),
    divYield: pick(x, 'dividendYieldIndicatedAnnual', 'currentDividendYieldTTM'),
  };
}

export function normalizeFinnhubAnalysts(rec) {
  const r = Array.isArray(rec) ? [...rec].sort((a, b) => String(b.period).localeCompare(String(a.period)))[0] : null;
  if (!r) return null;
  const sb = r.strongBuy ?? 0, b = r.buy ?? 0, h = r.hold ?? 0, s = r.sell ?? 0, ss = r.strongSell ?? 0;
  const total = sb + b + h + s + ss;
  return total ? { score: (2 * sb + b - s - 2 * ss) / total, buy: sb + b, hold: h, sell: s + ss, total, targetMean: null, period: r.period } : null;
}

export function normalizeFinnhubEarnings(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const rows = [...list].sort((a, b) => String(b.period).localeCompare(String(a.period))).slice(0, 4);
  const surprises = rows.map((e) => num(e.surprisePercent) ?? surprisePct(e.actual, e.estimate)).filter((v) => v != null);
  return surprises.length ? { surprises, beats: surprises.filter((v) => v > 0).length, total: surprises.length } : null;
}

async function fetchFinnhubFundamentals(symbol) {
  const metric = await fh('/stock/metric', { symbol, metric: 'all' });
  const m = normalizeFinnhubMetric(metric?.metric);
  if (!hasAny(m)) throw new Error('Finnhub no tiene métricas de este valor');
  let analysts = null, earnings = null;
  try { analysts = normalizeFinnhubAnalysts(await fh('/stock/recommendation', { symbol })); } catch (e) { if (e.paused || e.status === 429) throw e; }
  try { earnings = normalizeFinnhubEarnings(await fh('/stock/earnings', { symbol, limit: 4 })); } catch (e) { if (e.paused || e.status === 429) throw e; }
  return { fetchedAt: Date.now(), source: 'finnhub', m, analysts, earnings, nextEarnings: null };
}

async function fetchFinnhubNews(symbol) {
  const to = new Date(), from = new Date(Date.now() - 7 * 24 * HOUR);
  const iso = (d) => d.toISOString().slice(0, 10);
  const list = await fh('/company-news', { symbol, from: iso(from), to: iso(to) });
  return (Array.isArray(list) ? list : [])
    .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0)).slice(0, 12)
    .map((x) => ({ t: (x.datetime ?? 0) * 1000, headline: x.headline ?? '', summary: (x.summary ?? '').slice(0, 300), source: x.source ?? '', url: x.url ?? '' }))
    .filter((x) => x.headline);
}

async function refreshCalendar() {
  const iso = (d) => d.toISOString().slice(0, 10);
  try {
    const r = await fh('/calendar/earnings', { from: iso(new Date()), to: iso(new Date(Date.now() + 14 * 24 * HOUR)) });
    const dates = {};
    for (const e of r?.earningsCalendar ?? []) {
      const t = Date.parse(e.date + 'T12:00:00Z');
      if (e.symbol && Number.isFinite(t) && (!dates[e.symbol] || t < dates[e.symbol])) dates[e.symbol] = t;
    }
    cache.calendar = { fetchedAt: Date.now(), dates };
    markDirty();
  } catch (e) {
    if (!e.paused && e.status !== 429) { cache.calendar.fetchedAt = Date.now() - CAL_TTL + HOUR; noteError('calendario', null, e); }
  }
}

// ---------- Yahoo Finance (no oficial) ----------
let yAuth = null;
async function yahooAuth() {
  if (yAuth && Date.now() - yAuth.ts < HOUR) return yAuth;
  const r1 = await http('https://fc.yahoo.com', { as: 'raw' });
  const cookie = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Yahoo no ha entregado cookie de sesión');
  const crumb = (await http('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { Cookie: cookie }, as: 'text' })).trim();
  if (!crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('Yahoo no ha entregado un crumb válido');
  yAuth = { cookie, crumb, ts: Date.now() };
  return yAuth;
}

const raw = (o, k) => num(o?.[k]?.raw);

export function normalizeYahooSummary(r = {}) {
  const sd = r.summaryDetail ?? {}, ks = r.defaultKeyStatistics ?? {}, fd = r.financialData ?? {};
  const m = {
    pe: raw(sd, 'trailingPE'),
    forwardPe: raw(sd, 'forwardPE') ?? raw(ks, 'forwardPE'),
    peg: raw(ks, 'pegRatio'),
    ps: raw(sd, 'priceToSalesTrailing12Months'),
    pb: raw(ks, 'priceToBook'),
    evEbitda: raw(ks, 'enterpriseToEbitda'),
    revGrowth: scale(raw(fd, 'revenueGrowth'), 100),
    epsGrowth: scale(raw(fd, 'earningsGrowth'), 100),
    revGrowth3y: null,
    epsGrowth3y: null,
    netMargin: scale(raw(fd, 'profitMargins'), 100),
    opMargin: scale(raw(fd, 'operatingMargins'), 100),
    roe: scale(raw(fd, 'returnOnEquity'), 100),
    debtToEquity: scale(raw(fd, 'debtToEquity'), 0.01), // Yahoo lo da en %, aquí en ratio
    currentRatio: raw(fd, 'currentRatio'),
    beta: raw(sd, 'beta'),
    high52: raw(sd, 'fiftyTwoWeekHigh'),
    low52: raw(sd, 'fiftyTwoWeekLow'),
    divYield: scale(raw(sd, 'dividendYield'), 100),
  };
  const mean = raw(fd, 'recommendationMean'); // 1 = compra fuerte ... 5 = venta fuerte
  const target = raw(fd, 'targetMeanPrice');
  const n = raw(fd, 'numberOfAnalystOpinions');
  const analysts = mean != null || target != null
    ? { score: mean != null ? 3 - mean : null, buy: null, hold: null, sell: null, total: n, targetMean: target, recKey: fd.recommendationKey ?? null }
    : null;
  const hist = r.earningsHistory?.history;
  const surprises = Array.isArray(hist)
    ? hist.map((h) => surprisePct(raw(h, 'epsActual'), raw(h, 'epsEstimate'))).filter((v) => v != null).reverse().slice(0, 4)
    : [];
  const earnings = surprises.length ? { surprises, beats: surprises.filter((v) => v > 0).length, total: surprises.length } : null;
  const ed = r.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
  return { m, analysts, earnings, nextEarnings: num(ed) != null ? ed * 1000 : null };
}

async function fetchYahooFundamentals(symbol) {
  return viaProvider('yahoo', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { cookie, crumb } = await yahooAuth();
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData,calendarEvents,earningsHistory&crumb=${encodeURIComponent(crumb)}`;
      try {
        const data = await http(url, { headers: { Cookie: cookie } });
        const result = data?.quoteSummary?.result?.[0];
        if (!result) throw new Error('Yahoo no devolvió datos');
        const parsed = normalizeYahooSummary(result);
        if (!hasAny(parsed.m)) throw new Error('Yahoo no tiene métricas de este valor');
        return { fetchedAt: Date.now(), source: 'yahoo', ...parsed };
      } catch (e) {
        if ((e.status === 401 || e.status === 403) && attempt === 0) { yAuth = null; continue; } // sesión caducada: se renueva
        throw e;
      }
    }
  });
}

// Revisiones de las estimaciones de beneficio por acción (año en curso y siguiente): cuánto han cambiado en 30 y 90 días
// y cuántos analistas las han subido o bajado. Si tras resultados la empresa da buena guidance, las estimaciones suben.
export function normalizeYahooEstimates(r = {}) {
  const trend = r.earningsTrend?.trend;
  if (!Array.isArray(trend)) return null;
  const yrs = trend.filter((t) => ['0y', '+1y'].includes(t.period));
  const pct = (cur, base) => (cur == null || base == null ? null : Math.max(-100, Math.min(100, ((cur - base) / Math.max(Math.abs(base), 0.1)) * 100)));
  const avg = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const sum = (...ks) => yrs.reduce((s, t) => s + ks.reduce((q, k) => q + (raw(t.epsRevisions, k) ?? 0), 0), 0);
  const out = {
    eps30: avg(yrs.map((t) => pct(raw(t.epsTrend, 'current'), raw(t.epsTrend, '30daysAgo')))),
    eps90: avg(yrs.map((t) => pct(raw(t.epsTrend, 'current'), raw(t.epsTrend, '90daysAgo')))),
    up30: sum('upLast30days'), down30: sum('downLast30days'),
    up7: sum('upLast7days'), down7: sum('downLast7days', 'downLast7Days'),
    fwdGrowth: scale(raw(trend.find((t) => t.period === '+1y'), 'growth'), 100),
  };
  return out.eps30 == null && out.eps90 == null && !out.up30 && !out.down30 ? null : out;
}

async function fetchYahooEstimates(symbol) {
  return viaProvider('yahoo', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { cookie, crumb } = await yahooAuth();
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsTrend&crumb=${encodeURIComponent(crumb)}`;
      try {
        const data = await http(url, { headers: { Cookie: cookie } });
        const est = normalizeYahooEstimates(data?.quoteSummary?.result?.[0]);
        if (!est) throw new Error('Yahoo no tiene estimaciones de este valor');
        return { fetchedAt: Date.now(), ...est };
      } catch (e) {
        if ((e.status === 401 || e.status === 403) && attempt === 0) { yAuth = null; continue; }
        throw e;
      }
    }
  });
}

async function fetchYahooNews(symbol) {
  return viaProvider('yahoo', async () => {
    const j = await http(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=10`);
    return (j?.news ?? []).map((x) => ({ t: (x.providerPublishTime ?? 0) * 1000, headline: x.title ?? '', summary: '', source: x.publisher ?? '', url: x.link ?? '' }))
      .filter((x) => x.headline).sort((a, b) => b.t - a.t);
  });
}


// ---------- Cuentas: ingresos, gastos, beneficio, balance y flujos de caja (Yahoo, trimestral y anual) ----------
// Campo -> tipo de Yahoo (sin prefijo annual/quarterly)
export const STMT_FIELDS = {
  rev: 'TotalRevenue', cogs: 'CostOfRevenue', gp: 'GrossProfit', opex: 'OperatingExpense', totexp: 'TotalExpenses',
  opinc: 'OperatingIncome', ebitda: 'EBITDA', ni: 'NetIncome', eps: 'DilutedEPS',
  ocf: 'OperatingCashFlow', fcf: 'FreeCashFlow',
  assets: 'TotalAssets', liab: 'TotalLiabilitiesNetMinorityInterest', eq: 'StockholdersEquity', cash: 'CashAndCashEquivalents', debt: 'TotalDebt',
};
const STMT_KEYS = Object.keys(STMT_FIELDS);
const KEEP = { q: 8, a: 5 }; // periodos que se guardan

export function normalizeYahooStatements(result = []) {
  const byType = new Map();
  for (const r of result) { const t = r?.meta?.type?.[0]; if (t && Array.isArray(r[t])) byType.set(t, r[t]); }
  const out = { currency: null, q: {}, a: {} };
  for (const [kind, prefix] of [['q', 'quarterly'], ['a', 'annual']]) {
    for (const k of STMT_KEYS) {
      for (const it of byType.get(prefix + STMT_FIELDS[k]) ?? []) {
        const v = num(it?.reportedValue?.raw);
        if (v == null || !it.asOfDate) continue;
        (out[kind][it.asOfDate] ??= {})[k] = v;
        out.currency ??= it.currencyCode ?? null;
      }
    }
    const dates = Object.keys(out[kind]).sort().reverse().slice(0, KEEP[kind]);
    out[kind] = Object.fromEntries(dates.map((d) => [d, out[kind][d]]));
  }
  return Object.keys(out.q).length || Object.keys(out.a).length ? out : null;
}

async function fetchYahooStatements(symbol) {
  return viaProvider('yahooStmt', async () => {
    const types = STMT_KEYS.flatMap((k) => [`annual${STMT_FIELDS[k]}`, `quarterly${STMT_FIELDS[k]}`]).join(',');
    for (let attempt = 0; attempt < 2; attempt++) {
      let crumbQ = '', headers = {};
      try { const { cookie, crumb } = await yahooAuth(); crumbQ = `&crumb=${encodeURIComponent(crumb)}`; headers = { Cookie: cookie }; } catch { /* a veces funciona sin crumb */ }
      const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?type=${types}&merge=false&padTimeSeries=false&period1=${Math.floor(Date.now() / 1000 - 6 * 365 * 86400)}&period2=${Math.floor(Date.now() / 1000 + 86400)}${crumbQ}`;
      try {
        const data = await http(url, { headers, timeout: 12000 });
        const st = normalizeYahooStatements(data?.timeseries?.result);
        if (!st) throw new Error('Yahoo no tiene cuentas de este valor');
        return { fetchedAt: Date.now(), ...st };
      } catch (e) {
        if ((e.status === 401 || e.status === 403) && attempt === 0) { yAuth = null; continue; }
        throw e;
      }
    }
  });
}
const needsStmt = (s, now) => {
  if (status.paused.yahoo > now) return false;
  const e = cache.statements[s];
  return !e || now - (e.failedAt ?? e.fetchedAt) > (e.failedAt ? RETRY_TTL : STMT_TTL);
};
async function refreshStatements(s) {
  const prev = cache.statements[s];
  try { cache.statements[s] = await fetchYahooStatements(s); }
  catch (e) {
    if (e.paused || e.status === 429) return;
    cache.statements[s] = { ...(prev?.fetchedAt ? prev : {}), failedAt: Date.now() };
    noteError('cuentas', s, e);
  }
  markDirty();
}
export const getStatements = (symbol) => { const e = cache.statements[symbol]; return e?.fetchedAt ? e : null; };
// Para el servidor local: si aún no hay cuentas de este valor, se piden en el momento
export async function ensureStatements(symbol) {
  if (!BY.has(symbol)) return null;
  if (!getStatements(symbol) && needsStmt(symbol, Date.now())) await refreshStatements(symbol);
  return getStatements(symbol);
}
// Formato compacto para la web de solo lectura: { fields, data: { SIMBOLO: { c, q: [[fecha, ...valores]], a: [...] } } }
export function exportStatements() {
  const row = (d, o) => [d, ...STMT_KEYS.map((k) => (o[k] == null ? null : o[k]))];
  const data = {};
  for (const [sym, e] of Object.entries(cache.statements)) {
    if (!e?.fetchedAt || !BY.has(sym)) continue;
    data[sym] = { c: e.currency, t: e.fetchedAt, q: Object.entries(e.q ?? {}).map(([d, o]) => row(d, o)), a: Object.entries(e.a ?? {}).map(([d, o]) => row(d, o)) };
  }
  return { fields: STMT_KEYS, data };
}


// ---------- Operaciones de directivos (Form 4 de la SEC, vía Yahoo): solo S&P 500 ----------
export function normalizeYahooInsiders(r = {}) {
  const n = r.netSharePurchaseActivity ?? {};
  const buys = raw(n, 'buyInfoCount') ?? 0, sells = raw(n, 'sellInfoCount') ?? 0;
  const buyShares = raw(n, 'buyInfoShares') ?? 0, sellShares = raw(n, 'sellInfoShares') ?? 0, total = raw(n, 'totalInsiderShares');
  const recent = (r.insiderTransactions?.transactions ?? [])
    .map((t) => ({
      name: t.filerName ?? '', role: t.filerRelation ?? '', text: t.transactionText ?? '',
      shares: raw(t, 'shares'), value: raw(t, 'value'), t: (raw(t, 'startDate') ?? 0) * 1000,
    }))
    .filter((t) => t.t && /purchase|sale|buy|sell/i.test(t.text)) // sin concesiones, ejercicios de opciones ni regalos
    .sort((a, b) => b.t - a.t).slice(0, 6);
  if (!buys && !sells && !recent.length) return { none: true };
  return { buys, sells, buyShares, sellShares, netPct: total > 0 ? +(((buyShares - sellShares) / total) * 100).toFixed(2) : null, period: n.period ?? '6m', recent };
}
async function fetchYahooInsiders(symbol) {
  return viaProvider('yahooIns', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { cookie, crumb } = await yahooAuth();
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=netSharePurchaseActivity,insiderTransactions&crumb=${encodeURIComponent(crumb)}`;
      try {
        const data = await http(url, { headers: { Cookie: cookie } });
        const r = data?.quoteSummary?.result?.[0];
        if (!r) throw new Error('Yahoo no devuelve datos de directivos');
        return { fetchedAt: Date.now(), ...normalizeYahooInsiders(r) };
      } catch (e) {
        if ((e.status === 401 || e.status === 403) && attempt === 0) { yAuth = null; continue; }
        throw e;
      }
    }
  });
}
const needsIns = (s, now, watched) => {
  if (BY.get(s)?.market !== 'S&P 500' || status.paused.yahoo > now) return false; // los Form 4 son de EE. UU.
  const e = cache.insiders[s];
  return !e || now - (e.failedAt ?? e.fetchedAt) > (e.failedAt ? RETRY_TTL : watched ? INS_TTL_WATCH : INS_TTL);
};
async function refreshInsiders(s) {
  const prev = cache.insiders[s];
  try { cache.insiders[s] = await fetchYahooInsiders(s); }
  catch (e) {
    if (e.paused || e.status === 429) return;
    cache.insiders[s] = { ...(prev?.fetchedAt ? prev : {}), failedAt: Date.now() };
    noteError('directivos', s, e);
  }
  markDirty();
}
export const getInsiders = (symbol) => { const e = cache.insiders[symbol]; return e?.fetchedAt && !e.none ? e : null; };

// ---------- API pública ----------
export const providerFor = (symbol) => (BY.get(symbol)?.market === 'S&P 500' && FINNHUB_KEY ? 'finnhub' : 'yahoo');
export const getFundamentals = (symbol) => { const e = cache.fundamentals[symbol]; return e?.m ? e : null; };
export const getNews = (symbol) => cache.news[symbol] ?? null;
// Revisiones de estimaciones de analistas (sustituto gratuito de la "guidance"): solo hay datos de lo que se vigila o es candidato
export const getEstimates = (symbol) => { const e = cache.estimates[symbol]; return e && (e.eps30 != null || e.eps90 != null || e.up30 || e.down30) ? e : null; };

export function getNextEarnings(symbol) {
  const c = cache.calendar.dates?.[symbol];
  const y = cache.fundamentals[symbol]?.nextEarnings;
  const future = [c, y].filter((t) => t && t > Date.now() - 12 * HOUR);
  return future.length ? Math.min(...future) : null;
}

export function fundamentalsStats() {
  const analyzed = UNIVERSE.filter((u) => u.symbol !== 'SPY' && getFundamentals(u.symbol)).length;
  return {
    analyzed,
    statements: Object.values(cache.statements).filter((e) => e?.fetchedAt).length,
    insiders: Object.values(cache.insiders).filter((e) => e?.fetchedAt).length,
    total: UNIVERSE.filter((u) => u.symbol !== 'SPY').length,
    finnhub: hasFinnhub(),
    errors: status.errors,
    paused: Object.fromEntries(Object.entries(status.paused).map(([k, v]) => [k, Math.max(0, Math.round((v - Date.now()) / 1000))])),
  };
}

// Descarga directa sin caché (la usa el script de diagnóstico)
export async function diagnose(symbol) {
  const out = { symbol, provider: providerFor(symbol) };
  try {
    out.fundamentals = out.provider === 'finnhub' ? await fetchFinnhubFundamentals(symbol) : await fetchYahooFundamentals(symbol);
  } catch (e) { out.fundamentalsError = e.message; }
  try {
    out.news = (out.provider === 'finnhub' ? await fetchFinnhubNews(symbol) : await fetchYahooNews(symbol)).slice(0, 5);
  } catch (e) { out.newsError = e.message; }
  return out;
}

// ---------- planificador en segundo plano ----------
const needsFund = (s, now) => {
  if (status.paused[providerFor(s)] > now) return false;
  const e = cache.fundamentals[s];
  if (!e) return true;
  return e.failedAt ? now - e.failedAt > RETRY_TTL : now - e.fetchedAt > FUND_TTL;
};
const needsNews = (s, now) => {
  if (status.paused[providerFor(s)] > now) return false;
  const e = cache.news[s];
  return !e || now - (e.failedAt ?? e.fetchedAt) > (e.failedAt ? RETRY_TTL : NEWS_TTL);
};

async function refreshFund(s) {
  const prev = cache.fundamentals[s];
  try {
    cache.fundamentals[s] = providerFor(s) === 'finnhub' ? await fetchFinnhubFundamentals(s) : await fetchYahooFundamentals(s);
  } catch (e) {
    if (e.paused || e.status === 429) return; // se reintentará tras la pausa
    cache.fundamentals[s] = { ...(prev?.m ? prev : {}), failedAt: Date.now(), error: e.message };
    noteError('fundamentales', s, e);
  }
  markDirty();
}

const needsEst = (s, now) => {
  if (status.paused.yahoo > now) return false; // las estimaciones siempre se piden a Yahoo
  const e = cache.estimates[s];
  return !e || now - (e.failedAt ?? e.fetchedAt) > (e.failedAt ? RETRY_TTL : EST_TTL);
};
async function refreshEstimates(s) {
  const prev = cache.estimates[s];
  try { cache.estimates[s] = await fetchYahooEstimates(s); }
  catch (e) {
    if (e.paused || e.status === 429) return;
    cache.estimates[s] = { ...(prev?.fetchedAt ? prev : {}), failedAt: Date.now() };
    noteError('estimaciones', s, e);
  }
  markDirty();
}

async function refreshNews(s) {
  const prev = cache.news[s];
  try {
    const items = providerFor(s) === 'finnhub' ? await fetchFinnhubNews(s) : await fetchYahooNews(s);
    cache.news[s] = { fetchedAt: Date.now(), items };
  } catch (e) {
    if (e.paused || e.status === 429) return;
    cache.news[s] = { ...(prev ?? { items: [] }), failedAt: Date.now() };
    noteError('noticias', s, e);
  }
  markDirty();
}

// getWatched: símbolos en cartera u órdenes pendientes. getShortlist: candidatos a comprar (para tener sus noticias al día).
// Devuelve una función "trabajo()" que hace UNA descarga pendiente (por prioridad) y dice si hizo algo.
function makeWorker({ getWatched = () => [], getShortlist = () => [] } = {}) {
  const symbols = UNIVERSE.map((u) => u.symbol).filter((s) => s !== 'SPY');
  let cursor = 0, stmtCursor = 0, insCursor = 0;
  return async function work() {
    const now = Date.now();
    try {
      const watched = getWatched().filter((s) => BY.has(s) && s !== 'SPY');
      if (FINNHUB_KEY && now - cache.calendar.fetchedAt > CAL_TTL && now >= status.paused.finnhub) { await refreshCalendar(); return true; }
      const w = watched.find((s) => needsFund(s, now));
      if (w) { await refreshFund(w); return true; }
      const n = [...new Set([...watched, ...getShortlist()])].find((s) => BY.has(s) && needsNews(s, now));
      if (n) { await refreshNews(n); return true; }
      const est = [...new Set([...watched, ...getShortlist()])].find((s) => BY.has(s) && needsEst(s, now));
      if (est) { await refreshEstimates(est); return true; }
      // Cuentas de lo que tienes y de los candidatos: antes que el resto del universo
      const st = [...new Set([...watched, ...getShortlist()])].find((s) => BY.has(s) && needsStmt(s, now));
      if (st) { await refreshStatements(st); return true; }
      const ins = [...new Set([...watched, ...getShortlist()])].find((s) => needsIns(s, now, true));
      if (ins) { await refreshInsiders(ins); return true; }
      for (let i = 0; i < symbols.length; i++) {
        const s = symbols[(cursor + i) % symbols.length];
        if (needsFund(s, now)) { cursor = (cursor + i + 1) % symbols.length; await refreshFund(s); return true; }
      }
      for (let i = 0; i < symbols.length; i++) {
        const s = symbols[(stmtCursor + i) % symbols.length];
        if (needsStmt(s, now)) { stmtCursor = (stmtCursor + i + 1) % symbols.length; await refreshStatements(s); return true; }
      }
      for (let i = 0; i < symbols.length; i++) {
        const s = symbols[(insCursor + i) % symbols.length];
        if (needsIns(s, now, false)) { insCursor = (insCursor + i + 1) % symbols.length; await refreshInsiders(s); return true; }
      }
    } catch (e) {
      noteError('planificador', null, e);
    }
    return false;
  };
}

// Servidor continuo: una descarga cada 2 s en segundo plano.
export function startFundamentals(opts = {}) {
  load();
  const work = makeWorker(opts);
  let busy = false;
  const timer = setInterval(async () => { if (busy) return; busy = true; try { await work(); } finally { busy = false; } }, 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Modo "una pasada" (GitHub Actions): descarga durante un tiempo máximo y termina. Devuelve cuántas descargas hizo.
export async function runFundamentalsBudget(opts = {}, budgetMs = 90000) {
  load();
  const work = makeWorker(opts);
  const deadline = Date.now() + budgetMs;
  let n = 0;
  while (Date.now() < deadline && (await work())) n++;
  flushFundamentals();
  return n;
}
