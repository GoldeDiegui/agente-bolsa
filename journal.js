// Diario de operaciones con autopsia. Una entrada por posición (desde que se abre hasta que se cierra del todo):
// guarda la tesis del momento de comprar (puntuación, componentes, régimen de mercado, stop), cada compra y venta, el recorrido
// (máxima ganancia y máxima pérdida que llegó a tener) y, al cerrar, una autopsia con lecciones. Cuando pasan 5 y 20 sesiones
// de la venta se mide qué hizo el precio después (¿se vendió pronto o a tiempo?). Con el tiempo, el resumen dice qué reglas funcionan.
import { setHooks, getJournalRaw, getOrdersChrono, getSummary } from './portfolio.js';
import { getQuote } from './market.js';
import { analyze } from './analysis.js';
import { stopFor, takeProfitFor, regimeFor } from './volatility.js';
import { stressInfo } from './macro.js';
import { getSeries } from './technicals.js';
import { M } from './mandato.js';

const DAY = 86400e3;
const r = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const NAMES = { valuation: 'valoración', growth: 'crecimiento', quality: 'calidad', analysts: 'analistas', earnings: 'resultados', revisions: 'revisiones de estimaciones', sentiment: 'noticias', momentum: 'momentum', insiders: 'insiders', shorts: 'posición corta' };
const pct = (v) => `${v > 0 ? '+' : ''}${String(r(v)).replace('.', ',')} %`;

export const EXIT_KINDS = {
  stop: 'Stop-loss', target: 'Toma de beneficios', rebalance: 'Rebalanceo', thesis: 'Tesis rota', overvalued: 'Sobrevalorada',
  risk: 'Titulares de riesgo', rotation: 'Rotación', mandate: 'Fuera del mandato', manual: 'Manual',
};
export function exitKind(reason = '', by = '') {
  const t = String(reason);
  if (/^Stop-loss/i.test(t)) return 'stop';
  if (/^Toma de beneficios/i.test(t)) return 'target';
  if (/^Rebalanceo/i.test(t)) return 'rebalance';
  if (/^Tesis rota/i.test(t)) return 'thesis';
  if (/^Sobrevalorada/i.test(t)) return 'overvalued';
  if (/^Varios titulares de riesgo/i.test(t)) return 'risk';
  if (/^Rotaci[oó]n/i.test(t)) return 'rotation';
  if (/^Fuera del mandato/i.test(t)) return 'mandate';
  return 'manual';
}

// ---- toma de la foto de entrada ----
function entrySnapshot(order, market) {
  let a = null;
  try { a = analyze(order.symbol); } catch { /* sin análisis */ }
  const reg = regimeFor(market ?? getQuote(order.symbol)?.market);
  const st = stressInfo();
  const sc = a?.scores ? Object.fromEntries(Object.entries(a.scores).filter(([, v]) => v != null)) : null;
  const spy = getQuote('SPY')?.price ?? null;
  return {
    t: order.t, price: order.price, score: a?.score ?? null, verdict: a?.verdict ?? null, scores: sc, confidence: a?.confidence ?? null,
    reason: order.reason, by: order.by, mandate: `${M.nombre} v${M.version}`, regime: reg?.state ?? null, stress: st?.level ?? null, vix: st?.vix ?? null,
    stopPct: stopFor(order.symbol).stopPct, targetPct: takeProfitFor(order.symbol), spy,
  };
}

const openTrade = (symbol) => getJournalRaw().find((j) => j.symbol === symbol && j.status === 'open');
let seq = 0;
function create(order, approxEntry = null) {
  const q = getQuote(order.symbol);
  const J = getJournalRaw();
  seq = Math.max(seq, ...J.map((j) => j.id), 0) + 1;
  const t = {
    id: seq, symbol: order.symbol, name: q?.name ?? order.symbol, sector: q?.sector ?? 'Otros', market: q?.market ?? null,
    openT: order.t, closeT: null, status: 'open',
    entry: approxEntry ?? entrySnapshot(order, q?.market),
    buys: [], sells: [], basisSold: 0, mfe: 0, mae: 0,
  };
  J.push(t);
  if (J.length > 600) J.splice(0, J.length - 600);
  return t;
}

export function recordOrder(order, jb = {}, approx = false) {
  if (order.symbol === 'SPY') return;
  const fees = jb.fees ?? ((order.fee ?? 0) + (order.fxCost ?? 0) + (order.tax ?? 0));
  if (order.side === 'buy') {
    const t = openTrade(order.symbol) ?? create(order, approx ? approxEntryFrom(order) : null);
    t.buys.push({ t: order.t, shares: order.shares, price: order.price, reason: order.reason, by: order.by });
    return;
  }
  const t = openTrade(order.symbol) ?? create(order, approx ? approxEntryFrom(order) : null);
  const proceeds = (order.total ?? order.price * order.shares) - fees;
  const basis = (jb.avgBefore ?? order.price) * order.shares;
  const pnl = proceeds - basis;
  t.sells.push({ t: order.t, shares: order.shares, price: order.price, reason: order.reason, by: order.by, pnl: r(pnl, 2), kind: exitKind(order.reason, order.by) });
  t.basisSold += basis;
  const left = (jb.sharesBefore ?? order.shares) - order.shares;
  if (left <= 0) finalize(t, order, approx);
}

// Entradas reconstruidas desde el historial de órdenes (sin foto del momento): solo se sabe lo que dice el motivo
function approxEntryFrom(order) {
  const m = String(order.reason ?? '').match(/(\d{1,3})\s*\/\s*100/);
  return { t: order.t, price: order.price, score: m ? Number(m[1]) : null, verdict: null, scores: null, reason: order.reason, by: order.by, regime: null, stress: null, stopPct: null, targetPct: null, spy: null, approx: true };
}

function finalize(t, lastOrder, approx = false) {
  t.status = 'closed'; t.closeT = lastOrder.t;
  const realized = t.sells.reduce((s, x) => s + x.pnl, 0);
  t.realized = r(realized, 2);
  t.retPct = t.basisSold > 0 ? r((realized / t.basisSold) * 100, 2) : null;
  t.holdDays = r((t.closeT - t.openT) / DAY, 1);
  // la salida "principal" es la de la última venta
  const last = t.sells[t.sells.length - 1];
  let a = null; if (!approx) { try { a = analyze(t.symbol); } catch { /* */ } } // en operaciones reconstruidas el análisis actual no sería el de entonces
  t.exit = { kind: last.kind, reason: last.reason, score: a?.score ?? null, verdict: a?.verdict ?? null, price: last.price, spy: approx ? null : getQuote('SPY')?.price ?? null };
  const s0 = t.entry.spy, s1 = t.exit.spy;
  t.spyRetPct = s0 && s1 ? r((s1 / s0 - 1) * 100, 2) : null;
  t.alphaPct = t.spyRetPct != null && t.retPct != null ? r(t.retPct - t.spyRetPct, 2) : null;
  t.post = {};
  t.autopsy = autopsy(t);
}

// ---- seguimiento mientras la posición está abierta: máxima ganancia y máxima pérdida alcanzadas ----
export function trackExcursions(positions) {
  for (const t of getJournalRaw()) {
    if (t.status !== 'open') continue;
    const p = positions.find((x) => x.symbol === t.symbol);
    if (!p || !(p.avgCost > 0)) continue;
    const ret = (p.price / p.avgCost - 1) * 100;
    t.mfe = r(Math.max(t.mfe ?? 0, ret), 2); t.mae = r(Math.min(t.mae ?? 0, ret), 2);
  }
}

// ---- autopsia (pura: se puede recalcular cuando llegan datos nuevos) ----
export function autopsy(t) {
  const L = [];
  const ret = t.retPct;
  const verdict = ret == null ? 'Sin resultado' : ret >= 1 ? 'Acierto' : ret <= -1 ? 'Error' : 'Neutra';
  const e = t.entry ?? {}, x = t.exit ?? {}, post = t.post ?? {};
  const kind = x.kind;
  // ¿Qué falló o qué funcionó en la tesis de entrada?
  if (e.scores && e.score != null) {
    const ent = Object.entries(e.scores).sort((a, b) => a[1] - b[1]);
    const weak = ent[0], strong = ent[ent.length - 1];
    if (verdict === 'Error') {
      L.push(`Se compró con ${e.score}/100${e.verdict ? ` (${e.verdict})` : ''}; el componente más flojo era ${NAMES[weak[0]] ?? weak[0]} (${weak[1]}/100).` + (e.score >= 70 ? ' La puntuación era alta y aun así falló: conviene revisar si ese componente pesa poco.' : ''));
    } else if (verdict === 'Acierto') {
      L.push(`Se compró con ${e.score}/100; lo que más sostenía la tesis era ${NAMES[strong[0]] ?? strong[0]} (${strong[1]}/100).`);
    }
  } else if (e.score != null) L.push(`Se compró con ${e.score}/100 (el detalle por componentes no se guardó).`);
  if (x.score != null && e.score != null) {
    const dlt = x.score - e.score;
    if (Math.abs(dlt) >= 8) L.push(`La puntuación pasó de ${e.score} a ${x.score} (${dlt > 0 ? '+' : ''}${dlt}) mientras se tuvo.`);
  }
  // Recorrido
  if (t.mfe != null && t.mae != null && !e.approx) {
    if (verdict === 'Error' && t.mfe >= 5) L.push(`Llegó a ganar ${pct(t.mfe)} antes de acabar en pérdida: no hubo forma de proteger beneficios.`);
    else if (verdict === 'Acierto' && t.mfe >= 6 && ret < t.mfe * 0.5) L.push(`Devolvió más de la mitad de la ganancia máxima (${pct(t.mfe)} → ${pct(ret)}): se salió tarde.`);
    if (verdict === 'Acierto' && t.mae <= -5) L.push(`Antes de ganar llegó a perder ${pct(t.mae)}: la tesis aguantó una caída fuerte.`);
  }
  // Salida
  const d5 = post.d5, d20 = post.d20;
  if (kind === 'stop') {
    if (d20 != null && d20 >= 5) L.push(`Tras saltar el stop, el valor subió ${pct(d20)} en 20 sesiones: el stop pudo estar demasiado ajustado.`);
    else if (d20 != null && d20 <= -5) L.push(`El stop evitó una caída posterior de ${pct(d20)} en 20 sesiones.`);
    else if (d20 != null) L.push('Tras el stop el precio apenas se movió: salida neutra.');
  } else if (kind === 'target') {
    if (d20 != null && d20 >= 8) L.push(`Tras tomar beneficios el valor siguió subiendo ${pct(d20)} en 20 sesiones: se vendió pronto.`);
    else if (d20 != null && d20 <= -3) L.push(`Tomar beneficios fue buena decisión: el precio cayó ${pct(d20)} después.`);
  } else if (kind === 'rotation' || kind === 'thesis' || kind === 'overvalued' || kind === 'risk') {
    if (d20 != null && d20 >= 8) L.push(`Después de vender (${EXIT_KINDS[kind].toLowerCase()}) el valor subió ${pct(d20)} en 20 sesiones: la señal de salida fue prematura.`);
    else if (d20 != null && d20 <= -5) L.push(`La salida (${EXIT_KINDS[kind].toLowerCase()}) acertó: el precio cayó ${pct(d20)} en 20 sesiones.`);
  }
  if (d20 == null && d5 != null && Math.abs(d5) >= 5) L.push(`A 5 sesiones de la venta el precio se movió ${pct(d5)}.`);
  if (d5 == null && d20 == null && t.status === 'closed') L.push('Aún no han pasado 5 sesiones desde la venta: el seguimiento posterior está pendiente.');
  // Frente al mercado y duración
  if (t.alphaPct != null && Math.abs(t.alphaPct) >= 3) L.push(`Frente al S&P 500 en el mismo periodo: ${pct(t.alphaPct)} (${t.alphaPct > 0 ? 'mejor' : 'peor'} que el índice).`);
  if (t.holdDays != null && t.holdDays < 2 && verdict === 'Error') L.push('Duró menos de 2 días: posible entrada y salida precipitadas por ruido.');
  if (e.regime && e.regime !== 'alcista' && verdict === 'Error') L.push(`Se compró con el mercado en régimen «${e.regime}».`);
  if (e.stress && e.stress !== 'normal' && verdict === 'Error') L.push(`Se compró con tensión ${e.stress} en el mercado (VIX ${e.vix ?? '–'}).`);
  if (e.approx) L.push('Operación anterior al diario: la foto de entrada se reconstruyó solo con el motivo de la orden.');
  return { verdict, lessons: L };
}

// ---- seguimiento posterior a la venta (precio 5 y 20 sesiones después) ----
export function postExitFrom(series, closeT) {
  if (!series?.d?.length) return null;
  const day = Math.floor(closeT / DAY);
  let i = -1;
  for (let k = 0; k < series.d.length; k++) { if (series.d[k] <= day) i = k; else break; }
  if (i < 0) return null;
  const at = (n) => (i + n < series.c.length ? r((series.c[i + n] / series.c[i] - 1) * 100, 1) : null);
  return { d5: at(5), d20: at(20) };
}
export function refreshPostExit() {
  let changed = 0;
  for (const t of getJournalRaw()) {
    if (t.status !== 'closed' || (t.post?.d20 != null)) continue;
    if (Date.now() - t.closeT < 6 * DAY) continue; // aún no hay 5 sesiones
    const p = postExitFrom(getSeries(t.symbol), t.closeT);
    if (!p || (p.d5 == null && p.d20 == null)) continue;
    t.post = { ...p, asOf: Date.now() };
    t.autopsy = autopsy(t);
    changed++;
  }
  return changed;
}
// Valores vendidos hace poco que conviene seguir descargando para medir el después
export const recentClosedSymbols = (days = 40) => [...new Set(getJournalRaw().filter((t) => t.status === 'closed' && Date.now() - t.closeT < days * DAY && t.post?.d20 == null).map((t) => t.symbol))];

// ---- resumen: qué funciona y qué no ----
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function group(list, keyFn, labelFn) {
  const m = new Map();
  for (const t of list) { const k = keyFn(t); if (k == null) continue; (m.get(k) ?? m.set(k, []).get(k)).push(t); }
  return [...m.entries()].map(([k, ts]) => ({
    key: k, label: labelFn ? labelFn(k) : k, n: ts.length, hitPct: r((ts.filter((t) => t.retPct > 0).length / ts.length) * 100, 0),
    avgRetPct: r(avg(ts.map((t) => t.retPct)), 2), avgHoldDays: r(avg(ts.map((t) => t.holdDays)), 1), pnl: r(ts.reduce((s, t) => s + (t.realized ?? 0), 0), 0),
  })).sort((a, b) => b.n - a.n);
}
export function insights(closed) {
  const n = closed.length;
  const out = { n, byExit: group(closed, (t) => t.exit?.kind, (k) => EXIT_KINDS[k] ?? k), byScore: [], bySource: group(closed, (t) => t.entry?.by), bySector: group(closed, (t) => t.sector), findings: [], minSample: 5 };
  out.byScore = group(closed.filter((t) => t.entry?.score != null), (t) => (t.entry.score >= 75 ? 'a' : t.entry.score >= 60 ? 'b' : 'c'), (k) => (k === 'a' ? 'Puntuación ≥ 75' : k === 'b' ? 'Puntuación 60–74' : 'Puntuación < 60')).sort((a, b) => a.key.localeCompare(b.key));
  const wins = closed.filter((t) => t.retPct > 0), loss = closed.filter((t) => t.retPct <= 0);
  const tracked = (t) => !t.entry?.approx; // el recorrido solo se conoce en operaciones hechas con el diario activo
  out.avgMaeWinners = r(avg(wins.filter(tracked).map((t) => t.mae).filter((v) => v != null)));
  out.avgMfeLosers = r(avg(loss.filter(tracked).map((t) => t.mfe).filter((v) => v != null)));
  const F = out.findings;
  if (n < out.minSample) { F.push(`Solo hay ${n} operaciones cerradas: las conclusiones aparecerán a partir de ${out.minSample}.`); return out; }
  const stops = closed.filter((t) => t.exit?.kind === 'stop' && t.post?.d20 != null);
  if (stops.length >= 3) { const rec = stops.filter((t) => t.post.d20 >= 5).length; F.push(`${rec} de ${stops.length} stops se recuperaron más de un 5 % en 20 sesiones${rec / stops.length >= 0.5 ? ': los stops podrían estar demasiado ajustados' : ': los stops están cumpliendo su función'}.`); }
  const tg = closed.filter((t) => t.exit?.kind === 'target' && t.post?.d20 != null);
  if (tg.length >= 3) { const more = tg.filter((t) => t.post.d20 >= 8).length; F.push(`${more} de ${tg.length} ventas por toma de beneficios siguieron subiendo más de un 8 % después${more / tg.length >= 0.5 ? ': el objetivo de beneficios quizá es corto' : ''}.`); }
  const hi = out.byScore.find((g) => g.key === 'a'), lo = out.byScore.find((g) => g.key === 'c');
  if (hi && lo && hi.n >= 3 && lo.n >= 3) F.push(`Compras con puntuación ≥ 75: ${hi.hitPct} % de aciertos (${pct(hi.avgRetPct)} de media); con menos de 60: ${lo.hitPct} % (${pct(lo.avgRetPct)}). ${hi.avgRetPct > lo.avgRetPct ? 'La puntuación está discriminando bien.' : 'La puntuación todavía no discrimina: revisar pesos.'}`);
  if (out.avgMfeLosers != null && loss.filter(tracked).length >= 3 && out.avgMfeLosers >= 4) F.push(`Las operaciones perdedoras llegaron a ganar de media ${pct(out.avgMfeLosers)} antes de caer: un stop que siga al precio (trailing) podría proteger beneficios.`);
  const quick = closed.filter((t) => t.holdDays < 2);
  if (quick.length >= 3 && quick.filter((t) => t.retPct <= 0).length / quick.length >= 0.6) F.push(`${quick.length} operaciones duraron menos de 2 días y la mayoría perdió: hay demasiada rotación a corto plazo.`);
  if (!F.length) F.push('Aún no hay patrones claros con esta muestra.');
  return out;
}

// ---- informe para la web ----
export function journalReport() {
  const J = getJournalRaw();
  const slim = (t) => ({
    id: t.id, symbol: t.symbol, name: t.name, sector: t.sector, status: t.status, openT: t.openT, closeT: t.closeT,
    entry: { price: r(t.entry?.price, 2), score: t.entry?.score ?? null, verdict: t.entry?.verdict ?? null, scores: t.entry?.scores ?? null, reason: t.entry?.reason ?? '', by: t.entry?.by ?? null, regime: t.entry?.regime ?? null, stress: t.entry?.stress ?? null, stopPct: t.entry?.stopPct ?? null, targetPct: t.entry?.targetPct ?? null, approx: Boolean(t.entry?.approx) },
    buys: t.buys.length, sells: t.sells.map((s) => ({ t: s.t, shares: s.shares, price: r(s.price, 2), pnl: s.pnl, kind: s.kind })),
    mfe: t.mfe, mae: t.mae, realized: t.realized ?? null, retPct: t.retPct ?? null, holdDays: t.holdDays ?? r((Date.now() - t.openT) / DAY, 1), spyRetPct: t.spyRetPct ?? null, alphaPct: t.alphaPct ?? null,
    exit: t.exit ? { kind: t.exit.kind, label: EXIT_KINDS[t.exit.kind], reason: t.exit.reason, score: t.exit.score, verdict: t.exit.verdict } : null,
    post: t.post ?? null, autopsy: t.autopsy ?? null,
  });
  const closed = J.filter((t) => t.status === 'closed');
  return {
    open: J.filter((t) => t.status === 'open').map(slim).reverse(),
    closed: closed.slice(-80).map(slim).reverse(),
    insights: insights(closed), total: J.length,
  };
}

// ---- puesta en marcha ----
// Si la cartera ya tenía operaciones antes del diario, se reconstruye con el historial de órdenes.
export function rebuildFromOrders() {
  const J = getJournalRaw();
  if (J.length) return 0;
  const book = {};
  let k = 0;
  for (const o of getOrdersChrono()) {
    const b = (book[o.symbol] ??= { shares: 0, basis: 0 });
    const fees = (o.fee ?? 1) + (o.fxCost ?? 0) + (o.tax ?? 0), gross = o.total ?? o.price * o.shares;
    const jb = { sharesBefore: b.shares, avgBefore: b.shares ? b.basis / b.shares : o.price, fees };
    if (o.side === 'buy') { b.basis += gross + fees; b.shares += o.shares; }
    else { const avg = b.shares ? b.basis / b.shares : o.price; b.basis -= avg * o.shares; b.shares -= o.shares; }
    recordOrder(o, jb, true); k++;
  }
  // las posiciones aún abiertas arrancan sin recorrido conocido
  return k;
}
setHooks({
  onOrder: (order, jb) => recordOrder(order, jb),
  onTick: () => trackExcursions(getSummary().positions),
});
rebuildFromOrders();
