// Cartera virtual: efectivo, posiciones, órdenes, valoración y métricas de riesgo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuote, getAllQuotes, isValid, getHistory } from './market.js';
import { tradeStatus } from './hours.js';

export const INITIAL_CASH = 100000;
const MAX_POSITION_PCT = 0.30; // límite de riesgo: máx. 30% del patrimonio en un valor
const COMMISSION = 1.0;        // comisión fija por orden (USD)

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

export function placeOrder({ symbol, side, shares, reason = '', by = 'usuario' }) {
  symbol = String(symbol || '').toUpperCase();
  shares = Math.floor(Number(shares));
  if (!isValid(symbol) || symbol === 'SPY') return { ok: false, error: `Símbolo no operable: ${symbol}` };
  if (!['buy', 'sell'].includes(side)) return { ok: false, error: 'side debe ser buy o sell' };
  if (!(shares > 0)) return { ok: false, error: 'La cantidad debe ser un entero positivo' };

  const price = getQuote(symbol)?.price;
  if (price == null) return { ok: false, error: `Todavía no tengo el precio de ${symbol} (se carga en segundo plano; prueba en unos segundos)` };
  const ts = tradeStatus(getQuote(symbol));
  if (!ts.ok) return { ok: false, error: `No se puede operar ${symbol} ahora: ${ts.reason}` };
  const gross = price * shares;

  if (side === 'buy') {
    if (gross + COMMISSION > state.cash) return { ok: false, error: `Efectivo insuficiente (${state.cash.toFixed(2)} disponible)` };
    const equity = getSummary().equity;
    const current = (state.positions[symbol]?.shares ?? 0) * price;
    if ((current + gross) / equity > MAX_POSITION_PCT) {
      return { ok: false, error: `Superaría el límite del ${MAX_POSITION_PCT * 100}% del patrimonio en ${symbol}` };
    }
    const pos = state.positions[symbol] ?? { shares: 0, avgCost: 0 };
    pos.avgCost = (pos.avgCost * pos.shares + gross) / (pos.shares + shares);
    pos.shares += shares;
    state.positions[symbol] = pos;
    state.cash -= gross + COMMISSION;
  } else {
    const pos = state.positions[symbol];
    if (!pos || pos.shares < shares) return { ok: false, error: `No tienes ${shares} acciones de ${symbol}` };
    pos.shares -= shares;
    if (pos.shares === 0) delete state.positions[symbol];
    state.cash += gross - COMMISSION;
  }

  const order = { id: state.orders.length + 1, t: Date.now(), symbol, side, shares, price, total: +gross.toFixed(2), reason, by };
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
      symbol: o.symbol, side: o.side, shares: o.shares, by: o.by,
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
  };
}

export const marketOverview = () => getAllQuotes();
export const priceHistory = getHistory;
