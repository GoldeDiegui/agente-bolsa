// Volatilidad por valor (para stop-loss y tamaño de las compras) y régimen de mercado (S&P 500 / IBEX frente a sus medias).
// Datos: Yahoo (gráfico diario), sin clave. Caché en disco junto al estado de la cartera (vol.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE } from './market.js';
import { stressInfo } from './macro.js';
import { M } from './mandato.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.VOL_FILE
  || (process.env.DATA_FILE ? path.join(path.dirname(process.env.DATA_FILE), 'vol.json') : path.join(__dirname, 'data', 'vol.json'));
const HOUR = 3600e3;
const VOL_TTL = 12 * HOUR;
const REGIME_TTL = 4 * HOUR;
const RETRY_TTL = 2 * HOUR;
const BY = new Map(UNIVERSE.map((u) => [u.symbol, u]));

// ---- parámetros del modelo (todos explicables) ----
// Todos los umbrales (stop, objetivo, tamaños, régimen y colchón de efectivo) vienen del mandato (mandato.json).
const REGIME_INDEX = { 'S&P 500': '^GSPC', 'IBEX 35': '^IBEX' };

const cache = { vol: {}, regime: {} };
(function load() {
  try { if (fs.existsSync(FILE)) { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache.vol = d.vol ?? {}; cache.regime = d.regime ?? {}; } }
  catch (e) { console.warn('No se pudo leer la caché de volatilidad:', e.message); }
})();
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.warn('No se pudo guardar la volatilidad:', e.message); }
}

async function fetchDaily(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!q?.close) throw new Error('sin datos');
  const bars = [];
  q.close.forEach((c, i) => { if (typeof c === 'number' && typeof q.high?.[i] === 'number' && typeof q.low?.[i] === 'number') bars.push({ c, h: q.high[i], l: q.low[i] }); });
  return bars;
}

// ---- cálculos (puros, para poder probarlos) ----
export function computeVol(bars) {
  if (bars.length < 25) return null;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].c / bars[i - 1].c - 1;
    if (Math.abs(r) < 0.3) rets.push(r); // un salto del 30 % o más suele ser un split sin ajustar, no volatilidad
  }
  const last = rets.slice(-60);
  const mean = last.reduce((a, b) => a + b, 0) / last.length;
  const volPct = Math.sqrt(last.reduce((a, b) => a + (b - mean) ** 2, 0) / last.length) * 100;
  const trs = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const pc = bars[i - 1].c;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
    if (tr / pc < 0.3) trs.push(tr / pc);
  }
  if (trs.length < 8) return null;
  const atrPct = (trs.reduce((a, b) => a + b, 0) / trs.length) * 100;
  return { atrPct: +atrPct.toFixed(2), volPct: +volPct.toFixed(2), n: bars.length };
}

export function computeRegime(bars) {
  if (bars.length < 200) return null;
  const closes = bars.map((b) => b.c);
  const sma = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const price = closes[closes.length - 1], sma50 = sma(50), sma200 = sma(200);
  const state = price < sma200 ? 'bajista' : price < sma50 ? 'cautela' : 'alcista';
  return { state, price: +price.toFixed(2), sma50: +sma50.toFixed(2), sma200: +sma200.toFixed(2), vs200Pct: +(((price / sma200) - 1) * 100).toFixed(1) };
}

// ---- descarga ----
export async function refreshVolatility(symbols, { budgetMs = 30000 } = {}) {
  const now = Date.now(), deadline = now + budgetMs;
  const todo = [...new Set(symbols)].filter((s) => BY.has(s) && s !== 'SPY').filter((s) => {
    const e = cache.vol[s];
    return !e || now - (e.failedAt ?? e.t) > (e.failedAt ? RETRY_TTL : VOL_TTL);
  });
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (i < todo.length && Date.now() < deadline) {
      const s = todo[i++];
      try {
        const v = computeVol(await fetchDaily(s, '6mo'));
        cache.vol[s] = v ? { ...v, t: Date.now() } : { ...(cache.vol[s] ?? {}), failedAt: Date.now() };
        if (v) done++;
      } catch { cache.vol[s] = { ...(cache.vol[s] ?? {}), failedAt: Date.now() }; }
    }
  }));
  if (todo.length) save();
  return { requested: Math.min(i, todo.length), done };
}

export async function refreshRegime() {
  const now = Date.now();
  let changed = false;
  for (const [market, idx] of Object.entries(REGIME_INDEX)) {
    const e = cache.regime[market];
    if (e && now - (e.failedAt ?? e.t) < (e.failedAt ? RETRY_TTL : REGIME_TTL)) continue;
    try {
      const r = computeRegime(await fetchDaily(idx, '2y'));
      cache.regime[market] = r ? { ...r, index: idx, t: now } : { ...(e ?? {}), failedAt: now };
    } catch { cache.regime[market] = { ...(e ?? {}), failedAt: now }; }
    changed = true;
  }
  if (changed) save();
}

// ---- consulta (síncrona, la usan las reglas) ----
export const getVol = (symbol) => { const e = cache.vol[symbol]; return e?.atrPct != null ? e : null; };

// Stop-loss del valor: múltiplo de su ATR, entre el 6 % y el 15 %. Sin datos, el 8 % de siempre.
export function stopFor(symbol) {
  const v = getVol(symbol);
  const R = M.riesgo;
  const pct = v ? Math.min(R.stopMaxPct, Math.max(R.stopMinPct, R.stopAtrMult * v.atrPct)) : R.baseStopPct;
  return { stopPct: -+pct.toFixed(1), atrPct: v?.atrPct ?? null };
}
// Toma de beneficios: el doble del riesgo asumido (mínimo el 15 %)
export const takeProfitFor = (symbol) => (getVol(symbol) ? Math.max(M.riesgo.takeProfitMinPct, +(M.riesgo.takeProfitRiskMultiple * Math.abs(stopFor(symbol).stopPct)).toFixed(1)) : M.riesgo.takeProfitMinPct);
// Factor de tamaño de la compra: más pequeña cuanto más volátil
export function sizeFactor(symbol) {
  const v = getVol(symbol);
  return v ? Math.min(M.riesgo.sizeMax, Math.max(M.riesgo.sizeMin, M.riesgo.targetAtrPct / v.atrPct)) : 1;
}

export const regimeFor = (market) => { const r = cache.regime[market]; return r?.state ? r : null; };
const REGIME_TEXT = { alcista: 'por encima de sus medias de 50 y 200 sesiones', cautela: 'por debajo de su media de 50 sesiones (aún sobre la de 200)', bajista: 'por debajo de su media de 200 sesiones' };
export const regimeText = (market) => { const r = regimeFor(market); return r ? `${market} ${REGIME_TEXT[r.state]} (${r.vs200Pct > 0 ? '+' : ''}${String(r.vs200Pct).replace('.', ',')} % frente a su media de 200)` : null; };

// Reglas según el régimen del mercado del valor: en el bajista solo compra con convicción alta y a medio tamaño.
export const bearMinScore = () => M.mercado.bearMinScore;
// Además, una tensión alta en el mercado (VIX ≥ 25: elevada, ≥ 30: alta) reduce el tamaño aunque la tendencia sea alcista.
export function regimeGate(market, score) {
  const r = regimeFor(market), st = stressInfo()?.level;
  const K = M.mercado;
  const stressMult = st === 'alta' ? K.stressHighSizeMult : st === 'elevada' ? K.stressElevatedSizeMult : 1;
  if (r?.state === 'bajista') return { ok: score != null && score >= K.bearMinScore, mult: +(K.bearSizeMult * (st === 'alta' ? 0.8 : 1)).toFixed(2), state: 'bajista' };
  const mult = Math.min(r?.state === 'cautela' ? K.cautionSizeMult : 1, stressMult);
  return { ok: true, mult, state: mult < 1 ? 'cautela' : r?.state ?? null };
}
// Colchón de efectivo: 15 % normal, 20 % en cautela, 25 % en mercado bajista (según el S&P 500, que pesa más en la cartera)
export function cashFloorPct(base = M.efectivo.floorPct) {
  const s = regimeFor('S&P 500')?.state, st = stressInfo()?.level;
  const E = M.efectivo;
  const byTrend = s === 'bajista' ? E.floorBearPct : s === 'cautela' ? E.floorCautionPct : base;
  const byStress = st === 'alta' ? E.floorStressHighPct : st === 'elevada' ? E.floorStressElevatedPct : base;
  return Math.max(base, byTrend, byStress);
}
export const regimeSummary = () => ({
  markets: Object.fromEntries(Object.entries(cache.regime).filter(([, r]) => r?.state).map(([m, r]) => [m, { state: r.state, vs200Pct: r.vs200Pct, t: r.t }])),
  cashFloorPct: cashFloorPct(),
});
