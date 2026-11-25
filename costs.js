// Costes de operar realistas: comisión, diferencial (spread) y deslizamiento según liquidez, límite de participación en el volumen,
// coste de cambio de divisa (IBEX), impuesto sobre transacciones financieras de España y retención en dividendos.
// COST_MODEL=simple vuelve al modelo antiguo (1 US$ por orden, sin nada más). Todo configurable por variables de entorno.
import { getTech } from './technicals.js';
import { getVol } from './volatility.js';
import { M } from './mandato.js';

// prioridad: variable de entorno > mandato.json > valor por defecto
const num = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== '' && process.env[name] != null ? v : def; };
const K = M.costes;
export const SIMPLE = (process.env.COST_MODEL || M.costes.modelo) === 'simple';

export const COST = {
  usPerShare: num('COST_US_PER_SHARE', K.usPerShare), usMin: num('COST_US_MIN', K.usMin), usMaxPct: num('COST_US_MAX_PCT', K.usMaxPct), // EE. UU.: 0,005 US$/acción, mín. 1 US$, máx. 1 %
  esPct: num('COST_ES_PCT', K.esPct), esMin: num('COST_ES_MIN', K.esMin),                                                  // España: 0,10 %, mín. 2 US$ equivalentes
  fxBps: num('COST_FX_BPS', K.fxBps),            // cambio EUR↔USD: 0,15 % en cada operación del IBEX
  itfEsPct: num('COST_ITF_ES_PCT', K.itfEsPct),    // impuesto sobre transacciones financieras: 0,2 % en las compras de acciones españolas grandes
  maxPartPct: num('COST_MAX_PARTICIPATION_PCT', K.maxParticipationPct), // una orden no puede superar el 5 % del volumen diario medio
  impactK: num('COST_IMPACT_K', K.impactK),       // impacto de mercado ≈ k · volatilidad diaria · √(participación)
  slipCapBps: num('COST_SLIP_CAP_BPS', K.slipCapBps),
  divTaxUS: num('DIV_TAX_US', K.divTaxUS),          // retención en origen sobre dividendos de EE. UU. (con convenio, W-8BEN)
  divTaxES: num('DIV_TAX_ES', K.divTaxES),          // retención sobre dividendos españoles
};

// Semi-diferencial en puntos básicos según el volumen diario negociado (en US$)
export function halfSpreadBps(advUsd) {
  if (advUsd == null) return 10; // sin datos: tramo medio
  return advUsd >= 5e8 ? 2 : advUsd >= 1e8 ? 4 : advUsd >= 2e7 ? 8 : advUsd >= 5e6 ? 15 : 30;
}

// q: cotización (price en USD, priceNative en moneda original). Devuelve lo que costaría esa orden.
export function costsFor({ symbol, side, shares, q, limitFill = false }) {
  const ref = q.price;
  if (SIMPLE) return { ref, exec: ref, gross: ref * shares, fee: 1, fx: 0, tax: 0, slip: 0, slipBps: 0, maxShares: Infinity, total: 1, model: 'simple' };
  const es = q.market === 'IBEX 35';
  const fxFactor = q.priceNative ? q.price / q.priceNative : 1;
  const adv = getTech(symbol)?.advNative;
  const advUsd = adv != null ? adv * fxFactor : null;
  const sigma = getVol(symbol)?.volPct ?? 2;                       // volatilidad diaria en %
  const maxShares = advUsd ? Math.floor((advUsd * COST.maxPartPct) / 100 / ref) : Infinity;
  const n = Math.min(shares, maxShares);
  const part = advUsd ? (ref * n) / advUsd : 0;
  // las órdenes límite se ejecutan al precio del límite o mejor: sin deslizamiento
  const slipBps = limitFill ? 0 : Math.min(COST.slipCapBps, halfSpreadBps(advUsd) + COST.impactK * sigma * 100 * Math.sqrt(part));
  const exec = +(ref * (1 + (side === 'buy' ? 1 : -1) * slipBps / 1e4)).toFixed(4);
  const gross = exec * n;
  const fee = es ? Math.max(COST.esMin, (gross * COST.esPct) / 100) : Math.max(COST.usMin, Math.min(n * COST.usPerShare, (gross * COST.usMaxPct) / 100));
  const fx = es ? (gross * COST.fxBps) / 1e4 : 0;
  const tax = es && side === 'buy' ? (gross * COST.itfEsPct) / 100 : 0;
  const slip = Math.abs(exec - ref) * n;
  return { ref, exec, gross, fee, fx, tax, slip, slipBps: +slipBps.toFixed(1), maxShares, shares: n, total: fee + fx + tax, model: 'realista', partial: n < shares };
}

export const dividendTaxPct = (market) => (SIMPLE ? 0 : market === 'IBEX 35' ? COST.divTaxES : COST.divTaxUS);

// Resumen de costes acumulados a partir de las órdenes y los eventos
export function costSummary(orders, events, initialCash) {
  const s = { commissions: 0, slippage: 0, fx: 0, taxes: 0, dividendTax: 0 };
  for (const o of orders) { s.commissions += o.fee ?? 1; s.slippage += o.slip ?? 0; s.fx += o.fxCost ?? 0; s.taxes += o.tax ?? 0; }
  for (const e of events) if (e.type === 'dividend') s.dividendTax += e.tax ?? 0;
  const total = s.commissions + s.slippage + s.fx + s.taxes + s.dividendTax;
  const r = (v) => +v.toFixed(2);
  return { total: r(total), commissions: r(s.commissions), slippage: r(s.slippage), fx: r(s.fx), taxes: r(s.taxes), dividendTax: r(s.dividendTax), pctOfCapital: +((total / initialCash) * 100).toFixed(3), model: SIMPLE ? 'simple' : 'realista' };
}
