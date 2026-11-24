// Contexto macro: miedo del mercado (VIX), tipos de interés de EE. UU., curva, dólar, petróleo y oro.
// Datos: gráfico diario de Yahoo (1 año), sin clave. Se guarda en macro.json (rama `estado`).
// Uso en el gestor: una tensión alta (VIX) reduce el tamaño de las compras y sube el colchón de efectivo (ver volatility.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MACRO_FILE
  || (process.env.DATA_FILE ? path.join(path.dirname(process.env.DATA_FILE), 'macro.json') : path.join(__dirname, 'data', 'macro.json'));
const TTL = 30 * 60e3;

// kind: 'level' (variación en %) · 'rate' (rentabilidad en %, variación en puntos)
export const MACRO = [
  { key: 'vix', symbol: '^VIX', label: 'VIX (miedo del mercado)', kind: 'level', dec: 1 },
  { key: 'us10y', symbol: '^TNX', label: 'Bono EE. UU. 10 años', kind: 'rate', dec: 2 },
  { key: 'us3m', symbol: '^IRX', label: 'Letra EE. UU. 3 meses', kind: 'rate', dec: 2 },
  { key: 'dxy', symbol: 'DX-Y.NYB', label: 'Índice dólar (DXY)', kind: 'level', dec: 1 },
  { key: 'oil', symbol: 'CL=F', label: 'Petróleo WTI (US$)', kind: 'level', dec: 1 },
  { key: 'gold', symbol: 'GC=F', label: 'Oro (US$/onza)', kind: 'level', dec: 0 },
];

let cache = { t: 0, ind: {} };
try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.warn('No se pudo leer macro.json:', e.message); }
function save() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache)); fs.renameSync(FILE + '.tmp', FILE); }
  catch (e) { console.warn('No se pudo guardar macro.json:', e.message); }
}

async function fetchCloses(symbol) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const cl = (await res.json())?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!cl) throw new Error('sin datos');
  return cl.filter((v) => typeof v === 'number' && v > 0);
}

// ---- cálculo (puro) ----
export function computeIndicator(def, closes) {
  if (closes.length < 30) return null;
  const f = def.kind === 'rate' && closes[closes.length - 1] > 20 ? 0.1 : 1; // algunas series de tipos vienen multiplicadas por 10
  const c = closes.map((v) => v * f), n = c.length, last = c[n - 1];
  const at = (k) => c[Math.max(0, n - 1 - k)];
  const chg = (k) => (def.kind === 'rate' ? last - at(k) : (last / at(k) - 1) * 100);
  const yr = c.slice(-252);
  const r = (v, d = 2) => +v.toFixed(d);
  return { last: r(last, def.dec + 1), chg1d: r(chg(1)), chg1m: r(chg(21)), chg3m: r(chg(63)), hi: r(Math.max(...yr), def.dec + 1), lo: r(Math.min(...yr), def.dec + 1), avg1y: r(yr.reduce((a, b) => a + b, 0) / yr.length, def.dec + 1) };
}

export function stressFromVix(vix) { return vix == null ? null : vix >= 30 ? 'alta' : vix >= 25 ? 'elevada' : 'normal'; }

export async function refreshMacro({ force = false } = {}) {
  if (!force && Date.now() - cache.t < TTL) return { fetched: 0 };
  let ok = 0;
  await Promise.all(MACRO.map(async (def) => {
    try { const v = computeIndicator(def, await fetchCloses(def.symbol)); if (v) { cache.ind[def.key] = { ...v, t: Date.now() }; ok++; } } catch { /* se conserva el último valor */ }
  }));
  if (ok) { cache.t = Date.now(); save(); }
  else cache.t = Date.now() - TTL + 5 * 60e3; // sin datos: se reintenta en 5 min
  return { fetched: ok };
}

// ---- consulta ----
// Tipo sin riesgo (letra de EE. UU. a 3 meses) en tanto por uno; 0 si no hay dato
export function getRiskFree() { const v = cache.ind.us3m; return v && Number.isFinite(v.last) && Date.now() - v.t < 7 * 86400e3 ? v.last / 100 : 0; }

export function stressInfo() {
  const v = cache.ind.vix; if (!v || Date.now() - v.t > 12 * 3600e3) return null;
  const level = stressFromVix(v.last);
  return { level, vix: v.last, text: level === 'alta' ? `VIX en ${v.last}: tensión alta en el mercado` : level === 'elevada' ? `VIX en ${v.last}: tensión elevada` : `VIX en ${v.last}: tensión normal` };
}

export function macroSummary() {
  const I = cache.ind;
  if (!Object.keys(I).length) return null;
  const indicators = MACRO.filter((d) => I[d.key]).map((d) => ({ key: d.key, label: d.label, kind: d.kind, dec: d.dec, ...I[d.key] }));
  const curve = I.us10y && I.us3m ? +(I.us10y.last - I.us3m.last).toFixed(2) : null;
  const notes = [];
  const st = stressInfo();
  if (st && st.level !== 'normal') notes.push(`${st.text}: el gestor compra menos y mantiene más efectivo.`);
  else if (I.vix && I.vix.last < 14) notes.push(`VIX muy bajo (${I.vix.last}): mercado confiado; cuidado con la complacencia.`);
  if (curve != null && curve < 0) notes.push(`Curva de tipos invertida (10 años − 3 meses = ${String(curve).replace('.', ',')} puntos): históricamente ha precedido recesiones.`);
  if (I.us10y && I.us10y.chg1m >= 0.4) notes.push(`El bono a 10 años ha subido ${String(I.us10y.chg1m).replace('.', ',')} puntos en un mes: presiona las valoraciones, sobre todo de crecimiento.`);
  if (I.dxy && I.dxy.chg1m >= 3) notes.push(`Dólar fuerte (+${String(I.dxy.chg1m).replace('.', ',')} % en un mes): resta a los beneficios de multinacionales.`);
  if (I.oil && Math.abs(I.oil.chg1m) >= 15) notes.push(`Petróleo ${I.oil.chg1m > 0 ? 'sube' : 'baja'} ${String(Math.abs(I.oil.chg1m)).replace('.', ',')} % en un mes: afecta a energía y a costes de transporte.`);
  return { updatedAt: cache.t, stress: st, curve, indicators, notes };
}
