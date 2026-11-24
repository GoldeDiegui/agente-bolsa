// Panel de rendimiento "estilo gestora": rentabilidad, riesgo (volatilidad, Sharpe, Sortino, caída máxima), beta y alfa frente al S&P 500,
// estadísticas de las operaciones cerradas, rotación, y qué aportó cada valor, sector y mercado.
// Todo se calcula con datos que la cartera ya guarda (equity diario, órdenes, eventos). Las funciones puras se pueden probar solas.
import { INITIAL_CASH, getSummary, getDailyEquity, getStartTime, getOrdersChrono, getEventsChrono } from './portfolio.js';
import { getRiskFree } from './macro.js';
import { getIndexSeries } from './technicals.js';
import { costSummary } from './costs.js';
import { getQuote } from './market.js';

const DAY = 86400e3, ANN = 252;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

// ---------- métricas de la curva de patrimonio (puras) ----------
// daily: [{ d, equity, spy }] (un punto por día), initial: capital inicial, rf: tipo sin riesgo anual (0,04 = 4 %)
export function curveStats(daily, initial = INITIAL_CASH, rf = 0) {
  const n = daily.length;
  const out = { days: n, minDaysRisk: 20 };
  if (!n) return out;
  const eq = daily.map((p) => p.equity), spy = daily.map((p) => p.spy);
  const last = eq[n - 1];
  out.totalPct = r((last / initial - 1) * 100);
  out.spyTotalPct = r((spy[n - 1] / initial - 1) * 100); // la serie SPY ya está normalizada a 100.000
  out.excessPct = r(out.totalPct - out.spyTotalPct);
  // rentabilidades diarias (entre días consecutivos)
  const R = [], S = [];
  for (let i = 1; i < n; i++) { R.push(eq[i] / eq[i - 1] - 1); S.push(spy[i] / spy[i - 1] - 1); }
  out.returns = R.length;
  // caída máxima y actual, partiendo del capital inicial
  let peak = initial, maxDD = 0, maxDDEnd = null;
  for (let i = 0; i < n; i++) { peak = Math.max(peak, eq[i]); const dd = eq[i] / peak - 1; if (dd < maxDD) { maxDD = dd; maxDDEnd = daily[i].d; } }
  out.maxDrawdownPct = r(maxDD * 100); out.maxDrawdownDay = maxDDEnd;
  out.currentDrawdownPct = r((last / peak - 1) * 100);
  let spyPeak = initial, spyDD = 0;
  for (const v of spy) { spyPeak = Math.max(spyPeak, v); spyDD = Math.min(spyDD, v / spyPeak - 1); }
  out.spyMaxDrawdownPct = r(spyDD * 100);
  if (R.length) {
    out.bestDayPct = r(Math.max(...R) * 100); out.worstDayPct = r(Math.min(...R) * 100);
    out.upDaysPct = r((R.filter((x) => x > 0).length / R.length) * 100, 0);
  }
  if (R.length >= out.minDaysRisk) {
    const rfd = rf / ANN;
    const sd = std(R), ex = mean(R) - rfd;
    out.volPct = r(sd * Math.sqrt(ANN) * 100);
    out.spyVolPct = r(std(S) * Math.sqrt(ANN) * 100);
    out.sharpe = sd > 0 ? r((ex / sd) * Math.sqrt(ANN)) : null;
    const dd = Math.sqrt(mean(R.map((x) => Math.min(x - rfd, 0) ** 2)));
    out.sortino = dd > 0 ? r((ex / dd) * Math.sqrt(ANN)) : null;
    const vs = std(S) ** 2;
    if (vs > 0) {
      const mR = mean(R), mS = mean(S);
      const cov = R.reduce((s, x, i) => s + (x - mR) * (S[i] - mS), 0) / (R.length - 1);
      const beta = cov / vs;
      out.beta = r(beta);
      out.alphaPct = r(((mR - rfd) - beta * (mS - rfd)) * ANN * 100);
      out.correlation = std(R) > 0 ? r(cov / (std(R) * std(S))) : null;
      const diff = R.map((x, i) => x - S[i]);
      const te = std(diff) * Math.sqrt(ANN);
      out.trackingErrorPct = r(te * 100);
      out.infoRatio = te > 0 ? r((mean(diff) * ANN) / te) : null;
    }
  }
  return out;
}

// ---------- repetición de las operaciones: resultados por venta y aportación por valor ----------
// orders: de la más antigua a la más reciente; events: splits y dividendos (en orden de aplicación)
export function replayTrades(orders, events) {
  const book = {}; // symbol -> { shares, basis, since, flows, realizedFlow, dividends, splitCash, bought, sold }
  const get = (s) => (book[s] ??= { shares: 0, basis: 0, since: null, flows: 0, dividends: 0, splitCash: 0, realized: 0, bought: 0, sold: 0, trades: 0 });
  const closed = [];
  const timeline = [...orders.map((o) => ({ t: o.t, k: 'o', o })), ...events.map((e) => ({ t: e.t, k: 'e', e }))].sort((a, b) => a.t - b.t);
  for (const it of timeline) {
    if (it.k === 'o') {
      const o = it.o, b = get(o.symbol), fees = (o.fee ?? 1) + (o.fxCost ?? 0) + (o.tax ?? 0), gross = o.total ?? o.price * o.shares;
      if (o.side === 'buy') {
        if (b.shares === 0) b.since = o.t;
        b.basis += gross + fees; b.shares += o.shares; b.flows -= gross + fees; b.bought += gross;
      } else {
        const proceeds = gross - fees, avg = b.shares > 0 ? b.basis / b.shares : 0;
        const pnl = proceeds - avg * o.shares;
        b.basis -= avg * o.shares; b.shares -= o.shares; b.flows += proceeds; b.sold += gross; b.realized += pnl; b.trades++;
        closed.push({ t: o.t, symbol: o.symbol, pnl, retPct: avg > 0 ? (proceeds / (avg * o.shares) - 1) * 100 : 0, holdDays: b.since ? (o.t - b.since) / DAY : 0, by: o.by });
        if (b.shares === 0) { b.basis = 0; b.since = null; }
      }
    } else {
      const e = it.e, b = get(e.symbol);
      if (e.type === 'dividend') { b.dividends += e.total ?? 0; b.flows += e.total ?? 0; }
      else if (e.type === 'split') { b.shares += e.shares ?? 0; b.splitCash += e.total ?? 0; b.flows += e.total ?? 0; if (b.shares <= 0) { b.shares = 0; b.basis = 0; b.since = null; } }
    }
  }
  return { book, closed };
}

export function tradeStats(closed) {
  const n = closed.length;
  if (!n) return { closed: 0 };
  const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl <= 0);
  const gw = wins.reduce((s, c) => s + c.pnl, 0), gl = -losses.reduce((s, c) => s + c.pnl, 0);
  return {
    closed: n, wins: wins.length, losses: losses.length,
    hitRatePct: r((wins.length / n) * 100, 0),
    avgWinPct: wins.length ? r(mean(wins.map((c) => c.retPct))) : null,
    avgLossPct: losses.length ? r(mean(losses.map((c) => c.retPct))) : null,
    avgWinUsd: wins.length ? r(gw / wins.length, 0) : null,
    avgLossUsd: losses.length ? r(-gl / losses.length, 0) : null,
    profitFactor: gl > 0 ? r(gw / gl) : (gw > 0 ? null : null),
    expectancyUsd: r(mean(closed.map((c) => c.pnl)), 0),
    avgHoldDays: r(mean(closed.map((c) => c.holdDays)), 1),
    realizedUsd: r(closed.reduce((s, c) => s + c.pnl, 0), 0),
    best: (() => { const c = closed.slice().sort((a, b) => b.pnl - a.pnl)[0]; return { symbol: c.symbol, pnl: r(c.pnl, 0), retPct: r(c.retPct, 1) }; })(),
    worst: (() => { const c = closed.slice().sort((a, b) => a.pnl - b.pnl)[0]; return { symbol: c.symbol, pnl: r(c.pnl, 0), retPct: r(c.retPct, 1) }; })(),
  };
}

// Rentabilidad de un índice entre dos días (días desde 1970), usando el último cierre igual o anterior a cada fecha
export function indexReturn(series, fromDay, toDay = Infinity) {
  if (!series?.d?.length) return null;
  const at = (day) => { let k = -1; for (let i = 0; i < series.d.length; i++) { if (series.d[i] <= day) k = i; else break; } return k; };
  const i0 = at(fromDay - 1) >= 0 ? at(fromDay - 1) : 0; // cierre del día anterior al inicio
  const i1 = at(toDay);
  if (i1 <= i0) return null;
  return r((series.c[i1] / series.c[i0] - 1) * 100);
}

// ---------- informe completo ----------
export function performanceReport(now = Date.now()) {
  const sum = getSummary();
  const daily = getDailyEquity();
  const orders = getOrdersChrono(), events = getEventsChrono();
  const start = getStartTime() ?? orders[0]?.t ?? now;
  const calDays = Math.max(0, (now - start) / DAY);
  const rf = getRiskFree();
  const cs = curveStats(daily, INITIAL_CASH, rf);
  // El total debe salir del patrimonio actual, no del último punto diario guardado
  cs.totalPct = r((sum.equity / INITIAL_CASH - 1) * 100);
  cs.excessPct = r(cs.totalPct - (cs.spyTotalPct ?? 0));
  cs.annualizedPct = calDays >= 30 ? r((Math.pow(sum.equity / INITIAL_CASH, 365 / calDays) - 1) * 100) : null;
  cs.spyAnnualizedPct = calDays >= 30 && cs.spyTotalPct != null ? r((Math.pow(1 + cs.spyTotalPct / 100, 365 / calDays) - 1) * 100) : null;
  cs.calendarDays = r(calDays, 0);
  cs.riskFreePct = r(rf * 100);

  const { book, closed } = replayTrades(orders, events);
  const ts = tradeStats(closed);

  // rotación: la mitad del volumen negociado (compras + ventas) entre el patrimonio medio, anualizada si hay ≥ 30 días
  const traded = orders.reduce((s, o) => s + (o.total ?? 0), 0);
  const avgEq = daily.length ? mean(daily.map((p) => p.equity)) : sum.equity;
  const turnover = avgEq > 0 ? (traded / 2) / avgEq : 0;
  ts.turnoverPct = r(turnover * 100, 0);
  ts.turnoverAnnualPct = calDays >= 30 ? r(turnover * (365 / calDays) * 100, 0) : null;
  ts.orders = orders.length;
  const costs = costSummary(orders, events, INITIAL_CASH);
  ts.costsUsd = costs.total; ts.costsPctOfCapital = costs.pctOfCapital;

  // aportación por valor: efectivo neto de operaciones y dividendos + valor actual de la posición
  const pos = Object.fromEntries(sum.positions.map((p) => [p.symbol, p]));
  const rows = [];
  for (const sym of new Set([...Object.keys(book), ...Object.keys(pos)])) {
    const b = book[sym] ?? { flows: 0, dividends: 0, splitCash: 0 }, p = pos[sym];
    const q = getQuote(sym);
    const total = b.flows + (p?.value ?? 0);
    const unreal = p?.pnl ?? 0;
    const realized = total - unreal - b.dividends - b.splitCash;
    rows.push({
      symbol: sym, name: q?.name ?? sym, sector: q?.sector ?? p?.sector ?? 'Otros', market: q?.market ?? p?.market ?? '—', open: Boolean(p),
      total, realized, unrealized: unreal, dividends: b.dividends,
    });
  }
  const pctCap = (v) => r((v / INITIAL_CASH) * 100, 2);
  const byKey = (key) => {
    const m = {};
    for (const x of rows) { const g = (m[x[key]] ??= { name: x[key], total: 0, realized: 0, unrealized: 0, dividends: 0, n: 0 }); g.total += x.total; g.realized += x.realized; g.unrealized += x.unrealized; g.dividends += x.dividends; g.n++; }
    return Object.values(m).sort((a, b) => b.total - a.total).map((g) => ({ name: g.name, n: g.n, total: r(g.total, 0), contribPct: pctCap(g.total), realized: r(g.realized, 0), unrealized: r(g.unrealized, 0), dividends: r(g.dividends, 0) }));
  };
  const bySymbol = rows.sort((a, b) => b.total - a.total).map((x) => ({
    symbol: x.symbol, name: x.name, sector: x.sector, market: x.market, open: x.open,
    total: r(x.total, 0), contribPct: pctCap(x.total), realized: r(x.realized, 0), unrealized: r(x.unrealized, 0), dividends: r(x.dividends, 0),
  }));
  const attributed = rows.reduce((s, x) => s + x.total, 0);
  const marketCompare = byKey('market').map((g) => {
    const idx = g.name === 'IBEX 35' || g.name === 'S&P 500' ? getIndexSeries(g.name) : null;
    const fromDay = Math.floor(start / DAY);
    return { ...g, indexPct: idx ? indexReturn(idx, fromDay) : null };
  });

  return {
    asOf: now, since: start, curve: cs, trades: ts, bySymbol, bySector: byKey('sector'), byMarket: marketCompare,
    // la suma de lo aportado por cada valor debe coincidir con la ganancia total (ver prueba)
    reconciliation: { attributedUsd: r(attributed, 2), pnlUsd: r(sum.equity - INITIAL_CASH, 2), diffUsd: r(attributed - (sum.equity - INITIAL_CASH), 2) },
    notes: notesFor(cs, ts),
  };
}

function notesFor(cs, ts) {
  const n = [];
  if (cs.returns < cs.minDaysRisk) n.push(`Con solo ${cs.returns} días de historial, Sharpe, Sortino, beta y alfa aún no son fiables: se muestran a partir de ${cs.minDaysRisk} sesiones.`);
  else if (cs.returns < 60) n.push(`Con ${cs.returns} sesiones de historial, las métricas de riesgo son orientativas.`);
  if (ts.closed != null && ts.closed < 20) n.push(`Solo hay ${ts.closed} ventas cerradas: el porcentaje de aciertos y el factor de beneficio todavía dicen poco.`);
  if (cs.annualizedPct == null) n.push('La rentabilidad anualizada se mostrará a partir de 30 días de vida de la cartera.');
  return n;
}
