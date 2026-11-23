// Cartera virtual: efectivo, posiciones, órdenes, valoración y métricas de riesgo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuote, getAllQuotes, isValid, getHistory } from './market.js';
import { tradeStatus } from './hours.js';
import { stopFor, regimeSummary } from './volatility.js';
import { costsFor, dividendTaxPct, costSummary, COST } from './costs.js';

export const INITIAL_CASH = 100000;
const MAX_POSITION_PCT = 0.30; // límite de riesgo: máx. 30% del patrimonio en un valor
// Los costes de operar (comisión, deslizamiento, divisa, impuestos) están en costs.js

// --- Persistencia: la cartera se guarda en data/state.json y se recupera al arrancar ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');

const freshState = () => ({
  cash: INITIAL_CASH,
  positions: {}, // symbol -> { shares, avgCost }
  orders: [],
  equityCurve: [], // { t, equity, spy }
  spyBase: null,
  agentLog: [],    // decisiones del gestor
  pending: [],     // órdenes límite pendientes
  pendingSeq: 0,
  events: [],      // splits y dividendos aplicados a las posiciones
});

let state = freshState();

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (typeof saved.cash !== 'number' || typeof saved.positions !== 'object') throw new Error('formato no válido');
    state = { ...freshState(), ...saved };
    console.log(`Cartera recuperada de ${DATA_FILE} (${state.orders.length} operaciones)`);
  } catch (e) {
    console.warn(`No se pudo leer ${DATA_FILE} (${e.message}); empiezo con una cartera nueva.`);
    try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupto'); } catch { /* ignorar */ }
  }
}

let saveTimer = null;
function saveNow() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE); // escritura atómica: nunca deja un fichero a medias
  } catch (e) {
    console.warn('No se pudo guardar la cartera:', e.message);
  }
}
const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000); };
let lastCurveSave = 0;
export const flushState =() => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveNow(); };

load();

// Vuelve a 100.000 USD, sin posiciones, historial ni decisiones.
export function resetPortfolio() {
  state = freshState();
  flushState();
}

export function addAgentLog(entry) {
  state.agentLog.unshift(entry);
  if (state.agentLog.length > 50) state.agentLog.pop();
  saveSoon();
}
export const getAgentLog = () => state.agentLog;

export function placeOrder({ symbol, side, shares, reason = '', by = 'usuario', limitFill = false }) {
  symbol = String(symbol || '').toUpperCase();
  shares = Math.floor(Number(shares));
  if (!isValid(symbol) || symbol === 'SPY') return { ok: false, error: `Símbolo no operable: ${symbol}` };
  if (!['buy', 'sell'].includes(side)) return { ok: false, error: 'side debe ser buy o sell' };
  if (!(shares > 0)) return { ok: false, error: 'La cantidad debe ser un entero positivo' };

  const q = getQuote(symbol);
  const price = q?.price;
  if (price == null) return { ok: false, error: `Todavía no tengo el precio de ${symbol} (se carga en segundo plano; prueba en unos segundos)` };
  const ts = tradeStatus(q);
  if (!ts.ok) return { ok: false, error: `No se puede operar ${symbol} ahora: ${ts.reason}` };

  // Costes: precio de ejecución con deslizamiento, comisión, divisa e impuestos; y límite de liquidez (% del volumen diario)
  const c = costsFor({ symbol, side, shares, q, limitFill });
  if (c.partial) {
    if (!(c.shares >= 1)) return { ok: false, error: `Liquidez insuficiente en ${symbol}: una orden no puede superar el ${COST.maxPartPct} % del volumen diario` };
    shares = c.shares; // se ejecuta solo lo que el volumen permite
  }
  const exec = c.exec, gross = exec * shares, fees = c.fee + c.fx + c.tax;
  const fxCost = c.fx, taxCost = c.tax, slipCost = c.slip;

  if (side === 'buy') {
    if (gross + fees > state.cash) return { ok: false, error: `Efectivo insuficiente (${state.cash.toFixed(2)} disponible)` };
    const equity = getSummary().equity;
    const current = (state.positions[symbol]?.shares ?? 0) * price;
    if ((current + gross) / equity > MAX_POSITION_PCT) {
      return { ok: false, error: `Superaría el límite del ${MAX_POSITION_PCT * 100}% del patrimonio en ${symbol}` };
    }
    const pos = state.positions[symbol] ?? { shares: 0, avgCost: 0, evFrom: Date.now(), evDone: [], evCheckedTo: Date.now() };
    pos.avgCost = (pos.avgCost * pos.shares + gross + fees) / (pos.shares + shares); // el coste medio incluye los costes de compra
    pos.shares += shares;
    state.positions[symbol] = pos;
    state.cash -= gross + fees;
  } else {
    const pos = state.positions[symbol];
    if (!pos || pos.shares < shares) return { ok: false, error: `No tienes ${shares} acciones de ${symbol}` };
    pos.shares -= shares;
    if (pos.shares === 0) delete state.positions[symbol];
    state.cash += gross - fees;
  }

  const order = {
    id: state.orders.length + 1, t: Date.now(), symbol, side, shares, price: exec, total: +gross.toFixed(2), reason, by,
    refPrice: +price.toFixed(4), fee: +c.fee.toFixed(2), fxCost: +fxCost.toFixed(2), tax: +taxCost.toFixed(2), slip: +slipCost.toFixed(2), slipBps: c.slipBps,
  };
  state.orders.push(order);
  saveSoon();
  return { ok: true, order };
}

export function getSummary() {
  const positions = Object.entries(state.positions).map(([symbol, p]) => {
    const q = getQuote(symbol);
    const price = q?.price ?? p.avgCost; // si aún no hay precio, se valora a coste
    const value = p.shares * price;
    const pnl = value - p.shares * p.avgCost;
    return {
      symbol, name: q?.name ?? symbol, sector: q?.sector ?? 'Otros', market: q?.market, shares: p.shares,
      avgCost: +p.avgCost.toFixed(2), price: +price.toFixed(2),
      value: +value.toFixed(2), pnl: +pnl.toFixed(2),
      pnlPct: +((pnl / (p.shares * p.avgCost)) * 100).toFixed(2),
      stopPct: stopFor(symbol).stopPct, atrPct: stopFor(symbol).atrPct,
    };
  });
  const invested = positions.reduce((s, p) => s + p.value, 0);
  const equity = state.cash + invested;
  positions.forEach((p) => (p.weightPct = +((p.value / equity) * 100).toFixed(2)));
  return {
    cash: +state.cash.toFixed(2),
    invested: +invested.toFixed(2),
    equity: +equity.toFixed(2),
    totalReturnPct: +(((equity - INITIAL_CASH) / INITIAL_CASH) * 100).toFixed(2),
    positions,
  };
}

export function snapshot() {
  const { equity } = getSummary();
  const spy = getQuote('SPY').price;
  if (spy == null) return;
  if (state.spyBase === null) state.spyBase = spy;
  state.equityCurve.push({ t: Date.now(), equity, spy: INITIAL_CASH * (spy / state.spyBase) });
  if (state.equityCurve.length > 2000) state.equityCurve.shift();
  // El gráfico se guarda como mucho cada 30 s (las órdenes se guardan al momento);
  // así se evitan escrituras constantes, que molestan a OneDrive.
  if (Date.now() - lastCurveSave > 30000) { lastCurveSave = Date.now(); saveSoon(); }
}

// Símbolos que hay que refrescar en cada ciclo: posiciones abiertas y valores con orden límite pendiente
export const getWatchedSymbols = () => [...new Set([...Object.keys(state.positions), ...state.pending.map((o) => o.symbol)])];

// ---------- Órdenes límite ----------
// Compra: se ejecuta cuando el precio baja a (o por debajo de) el límite.
// Venta: se ejecuta cuando el precio sube a (o por encima de) el límite.
// El límite va en la moneda del valor (EUR para el IBEX, USD para el S&P 500).
// No se reserva efectivo: si al cumplirse no hay saldo suficiente, se reintenta en cada ciclo hasta que caduque.
const LIMIT_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_PENDING = 50;
const hit = (side, price, limit) => (side === 'buy' ? price <= limit : price >= limit);

export function addLimitOrder({ symbol, side, shares, limit, reason = '', by = 'usuario' }) {
  symbol = String(symbol || '').toUpperCase();
  shares = Math.floor(Number(shares));
  limit = Number(limit);
  if (!isValid(symbol) || symbol === 'SPY') return { ok: false, error: `Símbolo no operable: ${symbol}` };
  if (!['buy', 'sell'].includes(side)) return { ok: false, error: 'side debe ser buy o sell' };
  if (!(shares > 0)) return { ok: false, error: 'La cantidad debe ser un entero positivo' };
  if (!Number.isFinite(limit) || limit <= 0) return { ok: false, error: 'El precio límite debe ser un número positivo' };
  if (state.pending.length >= MAX_PENDING) return { ok: false, error: `Máximo ${MAX_PENDING} órdenes pendientes` };
  const q = getQuote(symbol);
  const order = {
    id: ++state.pendingSeq, t: Date.now(), symbol, side, shares, limit: +limit.toFixed(4),
    currency: q.currency, reason, by, expires: Date.now() + LIMIT_TTL_MS,
  };
  state.pending.push(order);
  saveSoon();
  return { ok: true, order, triggersNow: q.priceNative != null && hit(side, q.priceNative, order.limit) };
}

export function cancelLimitOrder(id) {
  const i = state.pending.findIndex((o) => o.id === Number(id));
  if (i < 0) return { ok: false, error: `No existe la orden límite #${id}` };
  const [order] = state.pending.splice(i, 1);
  saveSoon();
  return { ok: true, order };
}

export const getPending = () => state.pending.slice();

// ---------- Splits y dividendos ----------
// Un split no cambia el valor de la posición: multiplica las acciones y divide el coste medio (y el precio de mercado baja
// en la misma proporción). Si no se ajusta, la cartera vería una pérdida falsa y el stop-loss vendería.
// Los dividendos se abonan en efectivo, netos de la retención en origen (ver costs.js).
// Cada posición recuerda desde cuándo cuenta (evFrom), qué eventos ya se aplicaron (evDone) y cuándo se revisó por última vez (evCheckedTo).
const firstBuyTime = (symbol) => state.orders.find((o) => o.symbol === symbol && o.side === 'buy')?.t;
export const getEventWatch = () => Object.keys(state.positions).map((symbol) => ({ symbol }));
export const getEvents = () => state.events.slice().reverse();
// ¿Se han revisado hace poco los splits/dividendos de este valor? (si no, una caída brusca podría ser un split sin ajustar)
export const eventsFresh = (symbol, maxAgeMs = 45 * 60 * 1000) => { const t = state.positions[symbol]?.evCheckedTo; return Boolean(t) && Date.now() - t < maxAgeMs; };

// events: [{type:'split', t, num, den} | {type:'dividend', t, amount}] (t en ms). Devuelve los eventos aplicados.
export function applyCorporateEvents(symbol, events, checkedTo = Date.now()) {
  const pos = state.positions[symbol];
  if (!pos) return [];
  pos.evFrom ??= pos.evCheckedTo ?? firstBuyTime(symbol) ?? checkedTo; // posiciones guardadas con versiones anteriores
  pos.evDone ??= [];
  const q = getQuote(symbol);
  // el evento solo cuenta cuando el precio ya lo refleja: el último precio es posterior a la fecha del evento
  const crossed = (ev) => q?.price != null && (q.marketTime == null ? Date.now() - ev.t > 6 * 3600e3 : q.marketTime >= ev.t);
  const rate = q?.price != null && q.priceNative ? q.price / q.priceNative : null;
  const applied = [];
  for (const ev of events.filter((e) => e.t > pos.evFrom && e.t <= checkedTo).sort((a, b) => a.t - b.t)) {
    const key = `${ev.type}:${ev.t}`;
    if (pos.evDone.includes(key) || !crossed(ev)) continue; // ya aplicado, o el precio aún no lo refleja (se reintenta)
    if (ev.type === 'split') {
      const ratio = ev.num / ev.den;
      const exact = pos.shares * ratio, newShares = Math.floor(exact);
      const cashInLieu = +((exact - newShares) * q.price).toFixed(2);
      const before = pos.shares;
      pos.avgCost = pos.avgCost / ratio;
      pos.shares = newShares;
      state.cash += cashInLieu;
      for (const o of state.pending) if (o.symbol === symbol && o.t < ev.t) { o.limit = +(o.limit / ratio).toFixed(4); o.shares = Math.max(1, Math.round(o.shares * ratio)); }
      const e = { t: Date.now(), evT: ev.t, symbol, type: 'split', shares: newShares - before, total: cashInLieu,
        text: `Split ${ev.num}:${ev.den}: ${before} → ${newShares} acciones, coste medio ${pos.avgCost.toFixed(2)} US$` + (cashInLieu ? `; ${cashInLieu.toFixed(2)} US$ en efectivo por fracciones` : '') };
      state.events.push(e); applied.push(e); pos.evDone.push(key);
      if (newShares === 0) { delete state.positions[symbol]; break; }
    } else if (ev.type === 'dividend' && rate) {
      const grossDiv = pos.shares * ev.amount * rate, taxPct = dividendTaxPct(q.market);
      const tax = +((grossDiv * taxPct) / 100).toFixed(2), total = +(grossDiv - tax).toFixed(2);
      state.cash += total;
      const e = { t: Date.now(), evT: ev.t, symbol, type: 'dividend', shares: 0, total, tax,
        text: `Dividendo de ${ev.amount} ${q.currency}/acción × ${pos.shares} acciones = ${grossDiv.toFixed(2)} US$ brutos` + (taxPct ? `, retención del ${taxPct} % (${tax.toFixed(2)} US$): ${total.toFixed(2)} US$ netos` : ' (sin impuestos)') };
      state.events.push(e); applied.push(e); pos.evDone.push(key);
    }
  }
  if (state.positions[symbol]) { pos.evCheckedTo = checkedTo; if (pos.evDone.length > 40) pos.evDone.splice(0, pos.evDone.length - 40); }
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
  saveSoon();
  return applied;
}

// ¿Se puede operar este valor ahora mismo? (horario de mercado y precio de hoy)
export const canTrade = (symbol) => { const q = getQuote(symbol); return Boolean(q && q.price != null && tradeStatus(q).ok); };

// Se llama tras cada actualización de precios. Devuelve las órdenes que han cambiado de estado.
export function checkPending() {
  const changed = [];
  const now = Date.now();
  for (const o of state.pending.slice()) {
    if (now > o.expires) {
      state.pending.splice(state.pending.indexOf(o), 1);
      changed.push({ id: o.id, status: 'caducada' });
      continue;
    }
    const q = getQuote(o.symbol);
    if (!q || q.price == null || now - q.ts > 120000) continue; // solo con precio reciente
    if (!tradeStatus(q).ok) continue; // mercado cerrado: la orden espera a la próxima sesión
    if (!hit(o.side, q.priceNative, o.limit)) continue;
    const r = placeOrder({
      symbol: o.symbol, side: o.side, shares: o.shares, by: o.by, limitFill: true,
      reason: `Orden límite #${o.id} (${o.side === 'buy' ? '≤' : '≥'} ${o.limit} ${o.currency})${o.reason ? ': ' + o.reason : ''}`,
    });
    if (r.ok) {
      state.pending.splice(state.pending.indexOf(o), 1);
      changed.push({ id: o.id, status: 'ejecutada' });
    } else if (o.lastError !== r.error) {
      o.lastError = r.error; // sigue pendiente; se muestra el motivo en la web
      changed.push({ id: o.id, status: 'bloqueada' });
    }
  }
  if (changed.length) saveSoon();
  return changed;
}
export const getOrders = () => state.orders.slice().reverse();
export const getEquityCurve = () => state.equityCurve;

export function getRisk() {
  const s = getSummary();
  const curve = state.equityCurve;
  let maxDD = 0, peak = -Infinity;
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    maxDD = Math.min(maxDD, (pt.equity - peak) / peak);
  }
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const stdev = Math.sqrt(variance);

  const bySector = {};
  for (const p of s.positions) bySector[p.sector] = (bySector[p.sector] ?? 0) + p.weightPct;
  const hhi = s.positions.reduce((a, p) => a + (p.weightPct / 100) ** 2, 0);

  const first = curve[0], last = curve[curve.length - 1];
  const spyRet = first && last ? (last.spy / first.spy - 1) * 100 : 0;
  const pfRet = first && last ? (last.equity / first.equity - 1) * 100 : 0;

  return {
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    volatilityPerTickPct: +(stdev * 100).toFixed(4),
    cashPct: +((s.cash / s.equity) * 100).toFixed(2),
    concentrationHHI: +hhi.toFixed(3),
    sectorWeightsPct: Object.fromEntries(Object.entries(bySector).map(([k, v]) => [k, +v.toFixed(2)])),
    vsSpyPct: +(pfRet - spyRet).toFixed(2),
    maxPositionLimitPct: MAX_POSITION_PCT * 100,
    regime: regimeSummary(),
    costs: costSummary(state.orders, state.events, INITIAL_CASH),
  };
}

export const marketOverview = () => getAllQuotes();
export const priceHistory = getHistory;
