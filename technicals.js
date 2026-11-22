// Señales de precio: momentum, tendencia (medias), RSI, máximos de 52 semanas y fuerza relativa frente al índice.
// Datos: gráfico diario de Yahoo (2 años, ajustado por splits), sin clave. Se guarda en technicals.json (rama `estado`) junto con
// el último año de cierres, que la web usa para dibujar el gráfico de precios.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE } from './market.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.TECH_FILE
  || (process.env.DATA_FILE ? path.join(path.dirname(process.env.DATA_FILE), 'technicals.json') : path.join(__dirname, 'data', 'technicals.json'));
const HOUR = 3600e3, DAY = 86400e3;
const BY = new Map(UNIVERSE.map((u) => [u.symbol, u]));
const INDEX = { 'S&P 500': '^GSPC', 'IBEX 35': '^IBEX' };
const KEEP = 260; // cierres que se guardan (≈ 1 año de sesiones)

const cache = { sym: {}, idx: {} };
let version = 0, rankCache = null;
(function load() {
  try { if (fs.existsSync(FILE)) { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache.sym = d.sym ?? {}; cache.idx = d.idx ?? {}; } }
  catch (e) { console.warn('No se pudo leer technicals.json:', e.message); }
})();
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.warn('No se pudo guardar technicals.json:', e.message); }
}

async function fetchDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!ts || !cl) throw new Error('sin datos');
  const t = [], c = [];
  ts.forEach((x, i) => { if (typeof cl[i] === 'number' && cl[i] > 0) { t.push(x * 1000); c.push(cl[i]); } });
  return { t, c };
}

// ---- cálculo (puro, para poder probarlo) ----
export function computeTech(c) {
  const n = c.length;
  if (n < 130) return null;
  const last = c[n - 1];
  const ret = (k) => (n > k ? (last / c[n - 1 - k] - 1) * 100 : null);
  const sma = (k) => (n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null);
  // Momentum "12-1": rentabilidad de hace 12 meses a hace 1 mes (se salta el último mes, que tiende a revertir)
  const mom12_1 = n > 252 ? (c[n - 1 - 21] / c[n - 1 - 252] - 1) * 100 : null;
  // RSI de 14 sesiones (Wilder)
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= 14; l /= 14;
  for (let i = 15; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  const yr = c.slice(-252);
  const high52 = Math.max(...yr), low52 = Math.min(...yr);
  const s50 = sma(50), s200 = sma(200);
  const r = (v, d = 1) => (v == null ? null : +v.toFixed(d));
  return {
    last: r(last, 2), ret1m: r(ret(21)), ret3m: r(ret(63)), ret6m: r(ret(126)), ret12m: r(ret(252)), mom12_1: r(mom12_1),
    sma50: r(s50, 2), sma200: r(s200, 2), vs200: s200 ? r((last / s200 - 1) * 100) : null,
    rsi: r(rsi, 0), high52: r(high52, 2), low52: r(low52, 2), offHigh: r((last / high52 - 1) * 100), aboveLow: r((last / low52 - 1) * 100),
  };
}

// ---- descarga ----
export async function refreshTech(symbols, { budgetMs = 60000, ttlMs = 20 * HOUR } = {}) {
  const now = Date.now(), deadline = now + budgetMs;
  const needs = (e) => !e || now - (e.failedAt ?? e.fetchedAt) > (e.failedAt ? 2 * HOUR : ttlMs);
  const idxTodo = Object.values(INDEX).filter((s) => needs(cache.idx[s]));
  const todo = [...new Set(symbols)].filter((s) => BY.has(s) && s !== 'SPY' && needs(cache.sym[s]));
  const jobs = [...idxTodo.map((s) => ['idx', s]), ...todo.map((s) => ['sym', s])];
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
    while (i < jobs.length && Date.now() < deadline) {
      const [kind, s] = jobs[i++];
      try {
        const { t, c } = await fetchDaily(s);
        const ind = computeTech(c);
        if (!ind) throw new Error('historial corto');
        const from = Math.max(0, c.length - KEEP);
        cache[kind][s] = { fetchedAt: Date.now(), t: t[t.length - 1], ind, d: t.slice(from).map((x) => Math.round(x / DAY)), c: c.slice(from).map((x) => +x.toFixed(2)) };
        done++;
      } catch { cache[kind][s] = { ...(cache[kind][s] ?? {}), failedAt: Date.now() }; }
    }
  }));
  if (jobs.length) { save(); version++; rankCache = null; }
  return { requested: Math.min(i, jobs.length), done };
}

// ---- consulta ----
function ranks() {
  if (rankCache?.v === version) return rankCache;
  const by = {}; // mercado -> { mom: [...], r6: [...] }
  for (const [sym, e] of Object.entries(cache.sym)) {
    const u = BY.get(sym); if (!u || !e.ind) continue;
    const g = (by[u.market] ??= { mom: [], r6: [] });
    const m = e.ind.mom12_1 ?? e.ind.ret12m;
    if (m != null) g.mom.push(m);
    if (e.ind.ret6m != null) g.r6.push(e.ind.ret6m);
  }
  for (const g of Object.values(by)) { g.mom.sort((a, b) => a - b); g.r6.sort((a, b) => a - b); }
  rankCache = { v: version, by };
  return rankCache;
}
const pctile = (sorted, v) => {
  if (v == null || sorted.length < 10) return null; // con muy pocos valores el percentil no es fiable
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return Math.round((lo / sorted.length) * 100);
};

// Indicadores de un valor + percentil dentro de su mercado + fuerza relativa frente a su índice
export function getTech(symbol) {
  const e = cache.sym[symbol];
  const u = BY.get(symbol);
  if (!e?.ind || !u) return null;
  const g = ranks().by[u.market];
  const idx = cache.idx[INDEX[u.market]]?.ind;
  const m = e.ind.mom12_1 ?? e.ind.ret12m;
  return {
    ...e.ind, asOf: e.t, fetchedAt: e.fetchedAt,
    pctMom: g ? pctile(g.mom, m) : null, pctRet6: g ? pctile(g.r6, e.ind.ret6m) : null,
    rs6: idx?.ret6m != null && e.ind.ret6m != null ? +(e.ind.ret6m - idx.ret6m).toFixed(1) : null,
    market: u.market, peers: g?.mom.length ?? 0,
  };
}

// Serie de cierres para el gráfico: [{ d: día (ms), c }]
export function getSeries(symbol) {
  const e = cache.sym[symbol];
  return e?.c ? { symbol, d: e.d, c: e.c, asOf: e.t } : null;
}
export const hasTech = (symbol) => Boolean(cache.sym[symbol]?.ind);
export const techCount = () => Object.values(cache.sym).filter((e) => e.ind).length;

// Para el servidor local: pide los datos del valor si no los hay
export async function ensureTech(symbol) {
  if (!BY.has(symbol)) return null;
  if (!hasTech(symbol)) await refreshTech([symbol], { budgetMs: 15000 });
  return getSeries(symbol);
}

// Para la web de solo lectura: { SIMBOLO: { d: [días], c: [cierres] } } (un año de cierres)
export function exportCharts() {
  const out = {};
  for (const [sym, e] of Object.entries(cache.sym)) if (e.c && BY.has(sym)) out[sym] = { d: e.d, c: e.c };
  return { charts: out }; // sin fecha: así el fichero no cambia si no hay datos nuevos
}
