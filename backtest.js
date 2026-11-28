// Backtest de las reglas basadas en precio: ¿aportan algo la selección por momentum, el stop por volatilidad (ATR), el filtro de tendencia,
// el filtro de mercado (S&P 500 / IBEX frente a sus medias) y el tamaño según volatilidad? Se simula sobre ~5 años de histórico diario de
// Yahoo (gratis) y se compara con el índice, con una cartera equiponderada del universo y con selecciones al azar con las mismas reglas.
//
//   node backtest.js [--years 5] [--markets "S&P 500,IBEX 35"] [--max-symbols N] [--out fichero.json]
//
// LÍMITES (se muestran también en la web): solo se pueden probar reglas que dependen del precio, porque no hay fundamentales históricos
// gratuitos. El universo son los valores ACTUALES de cada índice (sesgo de supervivencia: favorece a todas las estrategias por igual, pero
// infla los números absolutos). Solo rentabilidad por precio (sin dividendos), sin divisa (cada mercado en su moneda), costes aproximados
// y órdenes al cierre. Sirve para comparar reglas entre sí, no para predecir rentabilidades.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE } from './market.js';
import { M } from './mandato.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400e3, TD = 252;
const BENCH = { 'S&P 500': { sym: '^GSPC', name: 'S&P 500' }, 'IBEX 35': { sym: '^IBEX', name: 'IBEX 35' } };
const COST_BPS = { 'S&P 500': 10, 'IBEX 35': 25 }; // por operación y lado: diferencial + comisión (+ divisa e impuesto en España), aproximado
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

// ---------------------------------------------------------------- descarga ----
async function fetchBars(symbol, years) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = (await res.json())?.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0], ts = r?.timestamp;
      if (!ts || !q?.close) throw new Error('sin datos');
      const out = [];
      ts.forEach((t, i) => { const c = q.close[i]; if (typeof c === 'number' && c > 0) out.push({ day: Math.floor(t * 1000 / DAY), c, h: typeof q.high?.[i] === 'number' ? q.high[i] : c, l: typeof q.low?.[i] === 'number' ? q.low[i] : c }); });
      return out;
    } catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
}

export async function downloadDataset(market, { years = 5, maxSymbols = Infinity, log = () => {} } = {}) {
  const bench = await fetchBars(BENCH[market].sym, years);
  const days = bench.map((b) => b.day);
  const index = new Map(days.map((d, i) => [d, i]));
  const list = UNIVERSE.filter((u) => u.market === market).slice(0, maxSymbols);
  const symbols = {};
  let i = 0, ok = 0, fail = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < list.length) {
      const u = list[i++];
      try { symbols[u.symbol] = alignBars(await fetchBars(u.symbol, years), index, days.length); ok++; } catch { fail++; }
    }
  }));
  log(`${market}: ${ok} valores descargados, ${fail} sin datos`);
  return { market, days, bench: bench.map((b) => b.c), symbols, failed: fail };
}

// Alinea las barras de un valor con el calendario del índice (los huecos se rellenan con el último cierre)
export function alignBars(bars, index, n) {
  const c = new Float64Array(n).fill(NaN), h = new Float64Array(n).fill(NaN), l = new Float64Array(n).fill(NaN), has = new Uint8Array(n);
  for (const b of bars) { const k = index.get(b.day); if (k != null) { c[k] = b.c; h[k] = b.h; l[k] = b.l; has[k] = 1; } }
  let last = NaN;
  for (let t = 0; t < n; t++) { if (Number.isFinite(c[t])) last = c[t]; else if (Number.isFinite(last)) { c[t] = last; h[t] = last; l[t] = last; } }
  return { c, h, l, has };
}

// ------------------------------------------------------------ indicadores ----
export function indicators(s) {
  const n = s.c.length, c = s.c;
  const pre = new Float64Array(n + 1);
  for (let t = 0; t < n; t++) pre[t + 1] = pre[t] + (Number.isFinite(c[t]) ? c[t] : 0);
  const sma = (t, k) => (t + 1 >= k ? (pre[t + 1] - pre[t + 1 - k]) / k : NaN);
  const sma50 = new Float64Array(n), sma200 = new Float64Array(n), atr = new Float64Array(n), mom = new Float64Array(n);
  const tr = new Float64Array(n).fill(NaN);
  for (let t = 1; t < n; t++) { const pc = c[t - 1]; if (pc > 0 && Number.isFinite(s.h[t])) { const v = Math.max(s.h[t] - s.l[t], Math.abs(s.h[t] - pc), Math.abs(s.l[t] - pc)) / pc; tr[t] = v < 0.3 ? v : NaN; } }
  for (let t = 0; t < n; t++) {
    sma50[t] = sma(t, 50); sma200[t] = sma(t, 200);
    let sum = 0, k = 0;
    if (t >= 14) for (let j = t - 13; j <= t; j++) if (Number.isFinite(tr[j])) { sum += tr[j]; k++; }
    atr[t] = k >= 8 ? (sum / k) * 100 : NaN; // ATR 14 en % del precio
    mom[t] = t >= 252 && c[t - 252] > 0 && Number.isFinite(c[t - 21]) ? c[t - 21] / c[t - 252] - 1 : NaN; // momentum 12-1
  }
  return { sma50, sma200, atr, mom };
}
export function regimeSeries(closes) {
  const n = closes.length, pre = new Float64Array(n + 1);
  for (let t = 0; t < n; t++) pre[t + 1] = pre[t] + closes[t];
  const sm = (t, k) => (t + 1 >= k ? (pre[t + 1] - pre[t + 1 - k]) / k : NaN);
  return Array.from({ length: n }, (_, t) => { const s200 = sm(t, 200), s50 = sm(t, 50); if (!Number.isFinite(s200)) return null; return closes[t] < s200 ? 'bajista' : closes[t] < s50 ? 'cautela' : 'alcista'; });
}

// -------------------------------------------------------------- estrategias ----
// Parámetros de una estrategia. Los valores por defecto copian los del gestor (mandato.json).
export function strategy(over = {}) {
  const R = M.riesgo, K = M.mercado, E = M.efectivo;
  return {
    name: 'Estrategia', topN: 20, rebal: 21, exitRankMult: 1.5, select: 'momentum', seed: 1,
    stop: { type: 'none', fixedPct: R.baseStopPct, atrMult: R.stopAtrMult, minPct: R.stopMinPct, maxPct: R.stopMaxPct },
    takeProfit: false, tpMinPct: R.takeProfitMinPct, tpRiskMult: R.takeProfitRiskMultiple, tpSellFrac: R.takeProfitSellPct / 100,
    trendFilter: false, regime: false, sizing: 'equal', targetAtr: R.targetAtrPct, sizeMin: R.sizeMin, sizeMax: R.sizeMax,
    cashFloor: E.floorPct / 100, floorCaution: E.floorCautionPct / 100, floorBear: E.floorBearPct / 100,
    cautionMult: K.cautionSizeMult, bearMult: K.bearSizeMult, bearTopPct: 90, maxPosPct: R.maxPositionPct / 100, costBps: 10,
    ...over, stop: { type: 'none', fixedPct: R.baseStopPct, atrMult: R.stopAtrMult, minPct: R.stopMinPct, maxPct: R.stopMaxPct, ...(over.stop ?? {}) },
  };
}
function stopPct(p, atr) {
  const s = p.stop;
  if (s.type === 'fixed') return s.fixedPct;
  if (s.type === 'atr') return Number.isFinite(atr) ? Math.min(s.maxPct, Math.max(s.minPct, s.atrMult * atr)) : R_BASE;
  return null;
}
const R_BASE = 8;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Simula una estrategia. ds = { days, bench, symbols:{sym:{c,h,l,has}}, ind:{sym:indicators}, regime:[...] }
export function simulate(ds, p, { t0 = 253 } = {}) {
  const n = ds.days.length, syms = Object.keys(ds.symbols);
  const cost = p.costBps / 1e4;
  let cash = 100000;
  const pos = new Map(); // sym -> { sh, avg, basis, t, tpDone, realized }
  const equity = new Float64Array(n).fill(NaN), invested = new Float64Array(n).fill(0);
  const closed = [], stopExits = [];
  let traded = 0;
  const rand = rng(p.seed);
  const price = (s, t) => ds.symbols[s].c[t];
  const value = (t) => { let v = cash; for (const [s, q] of pos) v += q.sh * price(s, t); return v; };
  const sell = (s, t, sh, kind) => {
    const q = pos.get(s), px = price(s, t), gross = sh * px, fee = gross * cost;
    cash += gross - fee; traded += gross;
    q.realized += gross - fee - q.avg * sh; q.sh -= sh;
    if (q.sh <= 0) {
      pos.delete(s);
      closed.push({ sym: s, ret: q.realized / q.basis, hold: t - q.t, kind });
      if (kind === 'stop') stopExits.push({ sym: s, t, px });
    }
  };
  for (let t = t0; t < n; t++) {
    // 1) gestión de riesgo diaria (a cierre): stop-loss y toma de beneficios
    if (p.stop.type !== 'none' || p.takeProfit) {
      for (const [s, q] of [...pos]) {
        const px = price(s, t), pnl = (px / q.avg - 1) * 100, atr = ds.ind[s].atr[t];
        const sp = stopPct(p, atr);
        if (sp != null && pnl <= -sp) { sell(s, t, q.sh, 'stop'); continue; }
        if (p.takeProfit && !q.tpDone && q.sh >= 2) {
          const tp = Number.isFinite(atr) && sp != null ? Math.max(p.tpMinPct, p.tpRiskMult * sp) : p.tpMinPct;
          if (pnl >= tp) { sell(s, t, Math.max(1, Math.floor(q.sh * p.tpSellFrac)), 'tp'); q.tpDone = true; }
        }
      }
    }
    // 2) rebalanceo: las señales usan datos hasta el día anterior
    if ((t - t0) % p.rebal === 0) {
      const sg = t - 1;
      const reg = p.regime ? ds.regime[sg] : 'alcista';
      const floor = reg === 'bajista' ? p.floorBear : reg === 'cautela' ? p.floorCaution : p.cashFloor;
      const regMult = reg === 'bajista' ? p.bearMult : reg === 'cautela' ? p.cautionMult : 1;
      // elegibles
      let el = [];
      for (const s of syms) {
        const I = ds.ind[s], px = ds.symbols[s].c[sg], m = I.mom[sg];
        if (!Number.isFinite(m) || !(px > 0) || !ds.symbols[s].has[t]) continue;
        if (p.trendFilter && !(px > I.sma200[sg])) continue;
        el.push({ s, m });
      }
      if (p.select === 'random') el.forEach((x) => (x.m = rand())); else el.sort((a, b) => b.m - a.m);
      if (p.select === 'random') el.sort((a, b) => b.m - a.m);
      // en mercado bajista, solo lo más fuerte (el equivalente a exigir puntuación alta)
      if (p.regime && reg === 'bajista') el = el.slice(0, Math.max(1, Math.ceil((el.length * (100 - p.bearTopPct)) / 100)));
      const rank = new Map(el.map((x, i) => [x.s, i]));
      const exitRank = Math.ceil(p.topN * p.exitRankMult);
      for (const s of [...pos.keys()]) { if (!(rank.has(s) && rank.get(s) < exitRank)) sell(s, t, pos.get(s).sh, 'rebalance'); }
      const eq = value(t);
      for (const x of el) {
        if (pos.size >= p.topN) break;
        if (pos.has(x.s)) continue;
        const px = price(x.s, t), atr = ds.ind[x.s].atr[sg];
        const sizeF = p.sizing === 'atr' && Number.isFinite(atr) ? Math.min(p.sizeMax, Math.max(p.sizeMin, p.targetAtr / atr)) : 1;
        const want = (eq * (1 - p.cashFloor)) / p.topN * regMult * sizeF;
        const room = cash - eq * floor;
        const amt = Math.min(want, room, eq * p.maxPosPct);
        const sh = Math.floor(amt / (px * (1 + cost)));
        if (sh < 1) { if (room < px) break; continue; }
        const gross = sh * px, fee = gross * cost;
        cash -= gross + fee; traded += gross;
        pos.set(x.s, { sh, avg: (gross + fee) / sh, basis: gross + fee, t, tpDone: false, realized: 0 });
      }
    }
    const v = value(t);
    equity[t] = v; invested[t] = v > 0 ? 1 - cash / v : 0;
  }
  // posiciones abiertas al final: se cuentan a mercado
  for (const [s, q] of pos) closed.push({ sym: s, ret: (q.realized + q.sh * price(s, n - 1) - q.avg * q.sh) / q.basis, hold: n - 1 - q.t, kind: 'abierta' });
  return { equity, invested, closed, stopExits, traded, t0 };
}

// Cartera equiponderada del universo (rebalanceo cada `rebal` sesiones, sin costes): ¿añade algo elegir valores?
export function equalWeight(ds, { t0 = 253, rebal = 21 } = {}) {
  const n = ds.days.length, syms = Object.keys(ds.symbols);
  const eq = new Float64Array(n).fill(NaN);
  let sh = new Map(), cash = 100000;
  for (let t = t0; t < n; t++) {
    if ((t - t0) % rebal === 0) {
      let v = cash; for (const [s, k] of sh) v += k * ds.symbols[s].c[t];
      const el = syms.filter((s) => ds.symbols[s].has[t] && Number.isFinite(ds.ind[s].mom[t - 1]));
      sh = new Map(); const w = v / Math.max(1, el.length);
      for (const s of el) sh.set(s, w / ds.symbols[s].c[t]);
      cash = el.length ? 0 : v;
    }
    let v = cash; for (const [s, k] of sh) v += k * ds.symbols[s].c[t];
    eq[t] = v;
  }
  return eq;
}
export function benchmarkEquity(ds, t0 = 253) { const e = new Float64Array(ds.days.length).fill(NaN); for (let t = t0; t < e.length; t++) e[t] = (100000 * ds.bench[t]) / ds.bench[t0]; return e; }

// ---------------------------------------------------------------- métricas ----
const dayStr = (d) => new Date(d * DAY).toISOString().slice(0, 10);
export function metrics(eq, days, t0, extra = {}) {
  const n = eq.length, e = [];
  for (let t = t0; t < n; t++) if (Number.isFinite(eq[t])) e.push(eq[t]);
  if (e.length < 30) return null;
  const rets = []; for (let i = 1; i < e.length; i++) rets.push(e[i] / e[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  let peak = e[0], dd = 0; for (const v of e) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const years = (e.length - 1) / TD, total = e[e.length - 1] / e[0] - 1, cagr = Math.pow(1 + total, 1 / years) - 1;
  const yearly = {}; // rentabilidad por año natural
  let yStart = e[0], yKey = dayStr(days[t0]).slice(0, 4);
  for (let t = t0 + 1; t < n; t++) { const k = dayStr(days[t]).slice(0, 4); if (k !== yKey) { yearly[yKey] = r2((eq[t - 1] / yStart - 1) * 100, 1); yKey = k; yStart = eq[t - 1]; } }
  yearly[yKey] = r2((e[e.length - 1] / yStart - 1) * 100, 1);
  return { totalPct: r2(total * 100, 1), cagrPct: r2(cagr * 100, 1), volPct: r2(sd * Math.sqrt(TD) * 100, 1), sharpe: sd > 1e-9 ? r2((mean / sd) * Math.sqrt(TD)) : null, maxDDPct: r2(dd * 100, 1), calmar: dd < 0 ? r2(cagr / Math.abs(dd)) : null, yearly, years: r2(years, 1), ...extra };
}
function tradeExtras(sim, ds) {
  const n = ds.days.length, cl = sim.closed.filter((c) => c.kind !== 'abierta');
  const eqAvg = sim.equity.reduce((a, b, i) => (Number.isFinite(b) ? a + b : a), 0) / Math.max(1, sim.equity.filter(Number.isFinite).length);
  const years = (n - sim.t0) / TD;
  const stops = sim.stopExits.length, whip = sim.stopExits.filter((s) => s.t + 20 < n && ds.symbols[s.sym].c[s.t + 20] / s.px - 1 >= 0.05).length;
  const evalStops = sim.stopExits.filter((s) => s.t + 20 < n).length;
  return {
    trades: cl.length, hitPct: cl.length ? r2((cl.filter((c) => c.ret > 0).length / cl.length) * 100, 0) : null,
    avgHoldDays: cl.length ? r2(cl.reduce((a, c) => a + c.hold, 0) / cl.length, 0) : null, stops, whipsawPct: evalStops ? r2((whip / evalStops) * 100, 0) : null,
    tpExits: cl.filter((c) => c.kind === 'tp').length, investedPct: r2((sim.invested.reduce((a, b, i) => a + (i >= sim.t0 ? b : 0), 0) / (n - sim.t0)) * 100, 0),
    turnoverPct: r2(((sim.traded / 2) / eqAvg / years) * 100, 0),
  };
}
const curveDates = (days, t0, n, step = 5) => { const out = []; for (let t = t0; t < n; t += step) out.push(dayStr(days[t])); if ((n - 1 - t0) % step) out.push(dayStr(days[n - 1])); return out; };
const curve = (eq, t0, step = 5) => { const out = []; for (let t = t0; t < eq.length; t += step) out.push(r2((eq[t] / eq[t0] - 1) * 100, 1)); if ((eq.length - 1 - t0) % step) out.push(r2((eq[eq.length - 1] / eq[t0] - 1) * 100, 1)); return out; };

// ------------------------------------------------------------ batería de pruebas ----
export function variantList(nSymbols) {
  const topN = Math.max(5, Math.min(20, Math.round(nSymbols * 0.04)));
  const atr = { type: 'atr' }, base = { topN };
  return [
    { id: 'base', name: 'Solo momentum (sin stop)', desc: `Compra los ${topN} valores con mayor momentum 12-1 y los rebalancea cada mes. Sin stop-loss.`, over: { ...base } },
    { id: 'stop8', name: 'Stop fijo −8 %', desc: 'Añade un stop-loss fijo del 8 % (el del gestor antes de usar volatilidad).', over: { ...base, stop: { type: 'fixed', fixedPct: 8 } } },
    { id: 'stopatr', name: 'Stop por volatilidad (ATR)', desc: 'Stop = múltiplo del ATR diario, entre el 6 % y el 15 % (mandato).', over: { ...base, stop: atr } },
    { id: 'stopatr_tp', name: 'ATR + toma de beneficios', desc: 'Además vende la mitad al alcanzar el objetivo (máx. de 15 % y 2× el stop).', over: { ...base, stop: atr, takeProfit: true } },
    { id: 'trend', name: 'ATR + filtro de tendencia', desc: 'Solo compra valores por encima de su media de 200 sesiones.', over: { ...base, stop: atr, trendFilter: true } },
    { id: 'regime', name: 'ATR + filtro de mercado', desc: 'Reduce tamaño y sube el efectivo cuando el índice cae bajo sus medias; en mercado bajista solo compra el 10 % más fuerte.', over: { ...base, stop: atr, regime: true } },
    { id: 'size', name: 'ATR + tamaño por volatilidad', desc: 'Compra menos de los valores más volátiles.', over: { ...base, stop: atr, sizing: 'atr' } },
    { id: 'gestor', name: 'Reglas de precio del gestor', desc: 'Todo junto: momentum, stop ATR, toma de beneficios, tendencia, filtro de mercado y tamaño por volatilidad.', over: { ...base, stop: atr, takeProfit: true, trendFilter: true, regime: true, sizing: 'atr' } },
    { id: 'stop5', name: 'Sensibilidad: stop fijo −5 %', desc: 'Stop más estrecho.', group: 'sens', over: { ...base, stop: { type: 'fixed', fixedPct: 5 } } },
    { id: 'stop12', name: 'Sensibilidad: stop fijo −12 %', desc: 'Stop más amplio.', group: 'sens', over: { ...base, stop: { type: 'fixed', fixedPct: 12 } } },
    { id: 'atr25', name: 'Sensibilidad: ATR × 2,5', desc: 'Stop por volatilidad más ajustado.', group: 'sens', over: { ...base, stop: { type: 'atr', atrMult: 2.5 } } },
    { id: 'atr5', name: 'Sensibilidad: ATR × 5', desc: 'Stop por volatilidad más amplio.', group: 'sens', over: { ...base, stop: { type: 'atr', atrMult: 5 } } },
    { id: 'top_half', name: `Sensibilidad: ${Math.max(3, Math.round(topN / 2))} posiciones`, desc: 'Cartera más concentrada (con stop ATR).', group: 'sens', over: { topN: Math.max(3, Math.round(topN / 2)), stop: atr } },
    { id: 'top_double', name: `Sensibilidad: ${topN * 2} posiciones`, desc: 'Cartera más diversificada (con stop ATR).', group: 'sens', over: { topN: topN * 2, stop: atr } },
    { id: 'rebal63', name: 'Sensibilidad: rebalanceo trimestral', desc: 'Rebalancea cada 63 sesiones en vez de 21 (con stop ATR).', group: 'sens', over: { ...base, rebal: 63, stop: atr } },
  ];
}

export function runMarket(ds, { randomRuns = 20, log = () => {} } = {}) {
  const market = ds.market, t0 = 253, n = ds.days.length;
  ds.ind = Object.fromEntries(Object.entries(ds.symbols).map(([s, v]) => [s, indicators(v)]));
  ds.regime = regimeSeries(ds.bench);
  const nSym = Object.keys(ds.symbols).length;
  if (n < t0 + 60 || nSym < 10) return { market, error: `datos insuficientes (${nSym} valores, ${n} sesiones)` };
  const costBps = COST_BPS[market] ?? 10;
  const variants = [];
  for (const v of variantList(nSym)) {
    const p = strategy({ ...v.over, costBps, name: v.name });
    const sim = simulate(ds, p, { t0 });
    variants.push({ id: v.id, name: v.name, desc: v.desc, group: v.group ?? 'main', m: metrics(sim.equity, ds.days, t0, tradeExtras(sim, ds)), curve: curve(sim.equity, t0) });
  }
  const bench = benchmarkEquity(ds, t0), ew = equalWeight(ds, { t0 });
  const gestor = variantList(nSym).find((v) => v.id === 'gestor');
  // selección al azar con las mismas reglas que "gestor": ¿el momentum aporta algo o es suerte?
  const rnd = [];
  for (let k = 1; k <= randomRuns; k++) {
    const sim = simulate(ds, strategy({ ...gestor.over, costBps, select: 'random', seed: 1000 + k }), { t0 });
    rnd.push(metrics(sim.equity, ds.days, t0));
  }
  const q = (arr, f) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : null; };
  const gm = variants.find((v) => v.id === 'gestor').m;
  const random = {
    runs: rnd.length,
    cagr: { p10: q(rnd.map((m) => m?.cagrPct), 0.1), p50: q(rnd.map((m) => m?.cagrPct), 0.5), p90: q(rnd.map((m) => m?.cagrPct), 0.9) },
    sharpe: { p10: q(rnd.map((m) => m?.sharpe), 0.1), p50: q(rnd.map((m) => m?.sharpe), 0.5), p90: q(rnd.map((m) => m?.sharpe), 0.9) },
    maxDD: { p50: q(rnd.map((m) => m?.maxDDPct), 0.5) },
    pctBelowMomentum: gm ? r2((rnd.filter((m) => m && m.cagrPct < gm.cagrPct).length / rnd.length) * 100, 0) : null,
  };
  const out = {
    market, symbols: nSym, failed: ds.failed ?? 0, from: dayStr(ds.days[t0]), to: dayStr(ds.days[n - 1]), costBps, topN: variantList(nSym)[0].over.topN,
    dates: curveDates(ds.days, t0, n),
    benchmark: { name: BENCH[market].name, m: metrics(bench, ds.days, t0), curve: curve(bench, t0) },
    equalWeight: { name: 'Todos los valores, equiponderada', m: metrics(ew, ds.days, t0), curve: curve(ew, t0) },
    variants, random,
  };
  out.findings = findings(out);
  return out;
}

// ---------------------------------------------------------- lectura de resultados ----
export function findings(o) {
  const F = [], V = (id) => o.variants.find((v) => v.id === id)?.m, b = o.benchmark.m, ew = o.equalWeight.m;
  const pt = (x) => (x == null ? '–' : String(x).replace('.', ',') + ' %');
  const nm = (x) => (x == null ? '–' : String(x).replace('.', ','));
  const sg = (x) => (x > 0 ? '+' : '') + String(r2(x, 1)).replace('.', ',') + ' pp';
  const base = V('base'), atr = V('stopatr'), s8 = V('stop8'), g = V('gestor');
  if (b && ew && base) F.push(`Sin ninguna regla de riesgo, elegir por momentum rindió ${pt(base.cagrPct)} anual frente a ${pt(ew.cagrPct)} de la cartera equiponderada del universo y ${pt(b.cagrPct)} del ${o.benchmark.name}.`);
  if (o.random?.runs && g) F.push(`Con las mismas reglas del gestor, elegir valores por momentum (${pt(g.cagrPct)} anual) supera al ${o.random.pctBelowMomentum} % de ${o.random.runs} selecciones al azar (mediana ${pt(o.random.cagr.p50)}, rango 10–90 %: ${pt(o.random.cagr.p10)} a ${pt(o.random.cagr.p90)}). ${o.random.pctBelowMomentum >= 80 ? 'El momentum parece aportar algo más que suerte.' : o.random.pctBelowMomentum <= 40 ? 'El momentum no se distingue del azar en este periodo.' : 'La diferencia con el azar es modesta.'}`);
  if (base && atr) F.push(`Stop por volatilidad frente a no tener stop: caída máxima ${pt(base.maxDDPct)} → ${pt(atr.maxDDPct)} y rentabilidad anual ${sg(atr.cagrPct - base.cagrPct)}. ${atr.maxDDPct > base.maxDDPct && atr.cagrPct >= base.cagrPct - 1 ? 'Protege sin coste apreciable.' : atr.cagrPct < base.cagrPct - 2 ? 'Protege, pero a costa de rentabilidad.' : ''}`.trim());
  if (atr && s8) F.push(`Stop ATR frente a stop fijo del 8 %: Sharpe ${nm(atr.sharpe)} frente a ${nm(s8.sharpe)}; ${atr.sharpe > s8.sharpe ? 'el stop adaptado a la volatilidad funciona mejor' : 'no mejora al stop fijo'}.`);
  const withStop = o.variants.find((v) => v.id === 'stopatr')?.m;
  if (withStop?.whipsawPct != null && withStop.stops >= 10) F.push(`De ${withStop.stops} salidas por stop, el ${withStop.whipsawPct} % se recuperó más de un 5 % en las 20 sesiones siguientes${withStop.whipsawPct >= 50 ? ': los stops saltan a menudo antes de un rebote' : ''}.`);
  const tp = V('stopatr_tp'); if (atr && tp) F.push(`Toma de beneficios: ${sg(tp.cagrPct - atr.cagrPct)} de rentabilidad anual y caída máxima ${pt(atr.maxDDPct)} → ${pt(tp.maxDDPct)}. ${tp.cagrPct < atr.cagrPct - 1 ? 'Vender la mitad pronto frena a los ganadores.' : ''}`.trim());
  const tr = V('trend'); if (atr && tr) F.push(`Filtro de tendencia: ${sg(tr.cagrPct - atr.cagrPct)} anual, caída máxima ${pt(atr.maxDDPct)} → ${pt(tr.maxDDPct)}.`);
  const rg = V('regime'); if (atr && rg) F.push(`Filtro de mercado: ${sg(rg.cagrPct - atr.cagrPct)} anual, caída máxima ${pt(atr.maxDDPct)} → ${pt(rg.maxDDPct)}, invertido el ${rg.investedPct} % del tiempo (frente al ${atr.investedPct} %).`);
  const sz = V('size'); if (atr && sz) F.push(`Tamaño por volatilidad: Sharpe ${nm(atr.sharpe)} → ${nm(sz.sharpe)}.`);
  const sens = o.variants.filter((v) => v.group === 'sens' && v.m); const best = [...sens, ...o.variants.filter((v) => v.group === 'main' && v.m)].sort((x, y) => (y.m.sharpe ?? -9) - (x.m.sharpe ?? -9))[0];
  if (best) F.push(`Mejor relación rentabilidad/riesgo (Sharpe) de todas las variantes: «${best.name}» con ${nm(best.m.sharpe)}.`);
  if (g && b) F.push(`Las reglas de precio del gestor: ${pt(g.cagrPct)} anual con caída máxima de ${pt(g.maxDDPct)} (el ${o.benchmark.name}: ${pt(b.cagrPct)} y ${pt(b.maxDDPct)}).`);
  return F;
}

// ---------------------------------------------------------------- ejecución ----
export async function runBacktest({ markets = Object.keys(BENCH), years = 5, maxSymbols = Infinity, randomRuns = 20, log = () => {} } = {}) {
  const out = { generatedAt: Date.now(), years, markets: {}, mandate: { name: M.nombre, version: M.version }, caveats: CAVEATS };
  for (const m of markets) {
    try { const ds = await downloadDataset(m, { years, maxSymbols, log }); out.markets[m] = runMarket(ds, { randomRuns, log }); log(`${m}: backtest completado`); }
    catch (e) { out.markets[m] = { market: m, error: e.message }; log(`${m}: error (${e.message})`); }
  }
  return out;
}
export const CAVEATS = [
  'Solo se prueban las reglas que dependen del precio; los fundamentales (valoración, crecimiento, calidad…) no se pueden probar porque no hay histórico gratuito.',
  'Sesgo de supervivencia: el universo son los valores actuales de cada índice. Infla las rentabilidades absolutas de todas las variantes; sirve para comparar unas reglas con otras, no para esperar esos números.',
  'Solo rentabilidad por precio (sin dividendos), cada mercado en su moneda, órdenes al cierre y costes aproximados (10 puntos básicos por operación en EE. UU. y 25 en España).',
  'Un solo periodo histórico: lo que funcionó en estos años puede no repetirse. Las diferencias pequeñas entre variantes no son concluyentes.',
];

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const markets = arg('markets', Object.keys(BENCH).join(',')).split(',').map((s) => s.trim());
  const outFile = arg('out', path.join(process.env.SITE_DIR || path.join(__dirname, 'site'), 'backtest.json'));
  const res = await runBacktest({ markets, years: Number(arg('years', 5)), maxSymbols: Number(arg('max-symbols', Infinity)), randomRuns: Number(arg('random', 20)), log: (m) => console.log(m) });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(res));
  console.log(`Backtest guardado en ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
  if (Object.values(res.markets).every((m) => m.error)) { console.error('::error::ningún mercado se pudo probar'); process.exit(1); }
}
