// Precios de mercado: Yahoo Finance (sin clave). Universo: S&P 500 + IBEX 35 (universe.json).
// - Los valores en cartera y SPY se refrescan en cada ciclo; el resto, por turnos (lotes), para no saturar Yahoo.
// - Los valores en EUR (IBEX) se convierten a USD con el cambio EURUSD.
// - Solo los 10 valores "semilla" tienen respaldo simulado si Yahoo no responde; el resto queda "sin datos".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, 'universe.json'), 'utf8'));
const BY_SYMBOL = new Map(UNIVERSE.map((u) => [u.symbol, u]));

const BATCH = Number(process.env.UNIVERSE_BATCH || 15); // valores "de fondo" por ciclo
const CONCURRENCY = 6;
const MAX_HISTORY = 600;

// Precios de arranque aproximados, solo para el modo sin conexión (respaldo simulado)
const SEEDS = { AAPL: 355, MSFT: 523, NVDA: 164, AMZN: 269, GOOGL: 300, JPM: 344, XOM: 171, JNJ: 284, KO: 68, SPY: 580 };

const prices = new Map();   // symbol -> { native, prev, source, ts }
const history = new Map();  // symbol -> [{ t, p }]  (p en USD)
const fx = {};              // 'EUR' -> { rate, ts }
let cursor = 0;
let pausedUntil = 0;        // pausa si Yahoo responde 429 (demasiadas peticiones)
let lastFx = 0;

// NO_SIMULATION=1 (modo nube): sin respaldo simulado; solo se opera con precios reales.
const SIMULATE = process.env.NO_SIMULATION !== '1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
let finnhubNext = 0;

for (const u of UNIVERSE) {
  history.set(u.symbol, []);
  if (SIMULATE && SEEDS[u.symbol]) prices.set(u.symbol, { native: SEEDS[u.symbol], prev: SEEDS[u.symbol], source: 'simulado', ts: Date.now() });
}

function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('sin datos');
    return { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice, marketTime: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null };
  } finally {
    clearTimeout(timer);
  }
}

// Respaldo para el S&P 500 si Yahoo bloquea (pasa a veces con las IP de la nube): cotización de Finnhub, máx. ~20 por minuto.
async function fetchFinnhubQuote(symbol) {
  const wait = finnhubNext - Date.now();
  if (wait > 30000) throw new Error('límite de Finnhub');
  finnhubNext = Math.max(finnhubNext, Date.now()) + 3000;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Finnhub HTTP ' + res.status);
  const d = await res.json();
  if (!(d.c > 0)) throw new Error('Finnhub sin datos');
  return { price: d.c, prevClose: d.pc > 0 ? d.pc : d.c, marketTime: d.t > 0 ? d.t * 1000 : null };
}
async function fallbackQuote(symbol) {
  if (!FINNHUB_KEY || BY_SYMBOL.get(symbol)?.market !== 'S&P 500') return null;
  try { return await fetchFinnhubQuote(symbol); } catch { return null; }
}

async function refreshFx() {
  if (Date.now() - lastFx < 60000) return;
  lastFx = Date.now();
  try {
    const q = await fetchYahoo('EURUSD=X');
    fx.EUR = { rate: q.price, ts: Date.now() };
  } catch { /* se mantiene el último cambio conocido; si no hay ninguno, los valores en EUR quedan sin precio */ }
}

const rateFor = (currency) => (currency === 'USD' ? 1 : fx[currency]?.rate ?? null);

function record(symbol) {
  const q = getQuote(symbol);
  if (!q || q.price == null) return;
  const h = history.get(symbol);
  h.push({ t: Date.now(), p: q.price });
  if (h.length > MAX_HISTORY) h.shift();
}

async function updateOne(symbol) {
  const cur = prices.get(symbol);
  const seeded = symbol in SEEDS;
  const simulate = () => {
    if (!cur || !seeded) return;
    const next = Math.max(0.01, cur.native * (1 + 0.0001 + 0.0006 * randn())); // ~0,06% por ciclo
    prices.set(symbol, { native: +next.toFixed(2), prev: cur.prev, source: 'simulado', ts: Date.now() });
  };
  const store = (q, source) => prices.set(symbol, { native: q.price, prev: q.prevClose, source, ts: Date.now(), mt: q.marketTime ?? null });
  if (Date.now() < pausedUntil) {
    const f = await fallbackQuote(symbol);
    if (f) store(f, 'finnhub'); else simulate();
    record(symbol); return;
  }
  try {
    store(await fetchYahoo(symbol), 'yahoo');
  } catch (e) {
    if (e.status === 429) pausedUntil = Date.now() + 60000;
    const f = await fallbackQuote(symbol);
    if (f) store(f, 'finnhub'); else simulate();
  }
  record(symbol);
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// priority: símbolos que se deben refrescar siempre (los que tienes en cartera)
export async function refreshPrices(priority = []) {
  await refreshFx();
  const must = new Set(['SPY', ...priority.filter((s) => BY_SYMBOL.has(s))]);
  const rest = UNIVERSE.map((u) => u.symbol).filter((s) => !must.has(s));
  const batch = [];
  for (let n = 0; n < BATCH && rest.length; n++) batch.push(rest[cursor++ % rest.length]);
  await pool([...must, ...batch], CONCURRENCY, updateOne);
}

export function getQuote(symbol) {
  const u = BY_SYMBOL.get(symbol);
  if (!u) return null;
  const q = prices.get(symbol);
  const rate = rateFor(u.currency);
  const base = { symbol, name: u.name, sector: u.sector, market: u.market, currency: u.currency };
  if (!q || rate == null) return { ...base, price: null, priceNative: null, prevClose: null, change: 0, changePct: 0, source: 'sin datos', ts: 0 };
  const change = q.native - q.prev;
  return {
    ...base,
    price: +(q.native * rate).toFixed(2),          // en USD (moneda de la cartera)
    priceNative: q.native,                          // en la moneda original (EUR para el IBEX)
    prevClose: q.prev,
    change: +change.toFixed(2),
    changePct: q.prev ? +((change / q.prev) * 100).toFixed(2) : 0,
    source: q.source,
    marketTime: q.mt ?? null,
    ts: q.ts,
  };
}

export const getAllQuotes = () => UNIVERSE.map((u) => getQuote(u.symbol));
export const getHistory = (symbol) => history.get(symbol) ?? [];
export const isValid = (symbol) => BY_SYMBOL.has(symbol);
export const marketStats = () => ({
  total: UNIVERSE.length,
  loaded: UNIVERSE.filter((u) => prices.has(u.symbol) && rateFor(u.currency) != null).length,
  real: UNIVERSE.filter((u) => ['yahoo', 'finnhub'].includes(prices.get(u.symbol)?.source)).length,
  eurusd: fx.EUR?.rate ?? null,
});
