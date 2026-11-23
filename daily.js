// Resumen del día: qué ha hecho la cartera hoy (o en la última sesión con actividad), frente al S&P 500, con operaciones y movimientos.
import { getSummary, getOrders, getEquityCurve, getEvents, getAgentLog } from './portfolio.js';
import { getQuote } from './market.js';
import { regimeText, regimeFor } from './volatility.js';
import { stressInfo } from './macro.js';

const TZ = 'Europe/Madrid';
const dayKey = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ }); // AAAA-MM-DD en hora de Madrid
const fmtPct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')} %`;
const fmtUsd = (v) => `${v < 0 ? '-' : v > 0 ? '+' : ''}${Math.abs(v).toLocaleString('es-ES', { maximumFractionDigits: 0 })} US$`;
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

export function dailySummary(now = Date.now()) {
  const curve = getEquityCurve();
  if (!curve.length) return null;
  // Día de referencia: hoy si ya hay datos; si no (fin de semana, antes de abrir), el último con actividad
  const today = dayKey(now);
  const lastKey = dayKey(curve[curve.length - 1].t);
  const day = lastKey <= today ? lastKey : today;
  const inDay = curve.filter((p) => dayKey(p.t) === day);
  if (!inDay.length) return null;
  const before = curve.filter((p) => dayKey(p.t) < day);
  const base = before.length ? before[before.length - 1] : inDay[0];
  const last = inDay[inDay.length - 1];
  const retPct = (last.equity / base.equity - 1) * 100;
  const spyPct = (last.spy / base.spy - 1) * 100;
  const sinceStart = curve[0] ? (last.equity / curve[0].equity - 1) * 100 : 0;
  const spySinceStart = curve[0] ? (last.spy / curve[0].spy - 1) * 100 : 0;

  const orders = getOrders().filter((o) => dayKey(o.t) === day).reverse().map((o) => ({
    t: o.t, side: o.side, symbol: o.symbol, shares: o.shares, price: o.price, total: o.total, by: o.by, reason: short(o.reason, 220),
  }));
  const events = getEvents().filter((e) => dayKey(e.t) === day).reverse().map((e) => ({ t: e.t, type: e.type, symbol: e.symbol, text: short(e.text, 160), total: e.total ?? null }));

  // Quién ha movido la cartera hoy (variación del día de cada posición, en US$)
  const sum = getSummary();
  const movers = sum.positions.map((p) => {
    const q = getQuote(p.symbol);
    const chg = q?.changePct ?? 0;
    return { symbol: p.symbol, changePct: chg, impact: p.value - p.value / (1 + chg / 100) };
  }).filter((m) => m.changePct !== 0).sort((a, b) => b.impact - a.impact);
  const best = movers.length ? movers[0] : null;
  const worst = movers.length > 1 ? movers[movers.length - 1] : null;

  const buys = orders.filter((o) => o.side === 'buy').length, sells = orders.length - buys;
  const reg = regimeFor('S&P 500');
  const label = new Date(day + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const parts = [];
  parts.push(`${label[0].toUpperCase() + label.slice(1)}: la cartera ${retPct >= 0 ? 'sube' : 'baja'} ${fmtPct(Math.abs(retPct)).replace('+', '')} (${fmtUsd(last.equity - base.equity)}) frente a ${fmtPct(spyPct)} del S&P 500${retPct - spyPct >= 0 ? ', es decir, lo supera' : ', es decir, va por detrás'} en ${Math.abs(retPct - spyPct).toFixed(2).replace('.', ',')} puntos.`);
  parts.push(orders.length ? `Operaciones: ${buys} compra${buys === 1 ? '' : 's'} y ${sells} venta${sells === 1 ? '' : 's'}.` : 'Sin operaciones.');
  if (best && best.impact > 0) parts.push(`Más aportó ${best.symbol} (${fmtPct(best.changePct)}).`);
  if (worst && worst.impact < 0) parts.push(`Más restó ${worst.symbol} (${fmtPct(worst.changePct)}).`);
  if (reg) parts.push(`Mercado: ${regimeText('S&P 500')}.`);
  const st = stressInfo();
  if (st && st.level !== 'normal') parts.push(`${st.text}.`);

  const lastLog = getAgentLog().find((l) => dayKey(l.t) === day);
  return {
    day, label, text: parts.join(' '),
    retPct: +retPct.toFixed(2), spyPct: +spyPct.toFixed(2), pnl: +(last.equity - base.equity).toFixed(2), equity: +last.equity.toFixed(2),
    sinceStartPct: +sinceStart.toFixed(2), spySinceStartPct: +spySinceStart.toFixed(2),
    cashPct: +((sum.cash / sum.equity) * 100).toFixed(1), positions: sum.positions.length,
    orders, events,
    best: best && best.impact > 0 ? { symbol: best.symbol, changePct: best.changePct, impact: +best.impact.toFixed(0) } : null,
    worst: worst && worst.impact < 0 ? { symbol: worst.symbol, changePct: worst.changePct, impact: +worst.impact.toFixed(0) } : null,
    lastDecision: lastLog ? short(lastLog.summary, 420) : null,
  };
}
