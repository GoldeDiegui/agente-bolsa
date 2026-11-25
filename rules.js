// Gestor gratuito basado en reglas: no usa ninguna API de IA ni clave.
// Decide con análisis fundamental (valoración frente al sector, crecimiento, calidad, analistas, resultados y titulares)
// y con gestión de riesgo (stop-loss, toma de beneficios, límite de concentración).
import { UNIVERSE, getAllQuotes, getQuote, getHistory, isValid } from './market.js';
import { placeOrder, getSummary, getRisk, getOrders, addLimitOrder, cancelLimitOrder, getPending, canTrade, eventsFresh } from './portfolio.js';
import { openMarkets, ENFORCE } from './hours.js';
import { analyze, analysisText, rank, analysisCoverage, thesisLine, worstLine } from './analysis.js';
import { fundamentalsStats, hasFinnhub } from './fundamentals.js';
import { stressInfo } from './macro.js';
import { stopFor, takeProfitFor, sizeFactor, regimeGate, regimeText, regimeFor, cashFloorPct, bearMinScore } from './volatility.js';
import { M, allowedByMandate } from './mandato.js';

const BY = 'agente (reglas)';
// Los parámetros (límites, tamaños, rotación, umbrales) vienen del mandato (mandato.json); aquí solo se leen.
const OVERWEIGHT_PCT = () => M.riesgo.overweightPct;
const TARGET_WEIGHT_PCT = () => M.riesgo.targetWeightPct;
const ENTRY_PCT = () => M.compras.entryPct;
const MAX_BUYS_PER_REVIEW = () => M.compras.maxPerReview;
const MIN_CONFIDENCE = () => M.compras.minConfidence;
const MIN_COVERAGE = Number(process.env.MIN_COVERAGE ?? M.analisis.minCoverage); // hasta tener analizado este % del universo no se compara con el sector ni se opera por tesis
const MIN_HOLD_MS = () => M.compras.minHoldHours * 3600e3; // no vende por tesis en las primeras horas (evita comprar y vender seguido)
const ROTATION_GAP = () => Number(process.env.ROTATION_GAP ?? M.rotacion.gap);
const ROTATION_MIN_HOLD_MS = () => M.rotacion.minHoldDays * 24 * 3600e3;
const MAX_ROTATIONS_PER_DAY = () => M.rotacion.maxPerDay;
const ROTATION_SECTOR_MAX = () => Math.min(M.rotacion.sectorMaxPct, M.riesgo.sectorMaxPct);
const ALLOW_MOMENTUM_ONLY = () => process.env.ALLOW_MOMENTUM_ONLY === '1' || M.analisis.allowMomentumOnly; // sin datos fundamentales, operar solo por tendencia
const dec = (v) => String(v).replace('.', ',');

const usd = (n) => n.toLocaleString('es-ES', { style: 'currency', currency: 'USD' });
const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function trendPct(symbol) {
  const h = getHistory(symbol).slice(-60).map((x) => x.p);
  return h.length > 5 ? (h[h.length - 1] / h[0] - 1) * 100 : 0;
}
const lastBuyAt = (symbol) => getOrders().find((o) => o.symbol === symbol && o.side === 'buy')?.t ?? 0;
const worst = worstLine;
const DAY_MS = 24 * 3600e3;
const rotationsToday = () => getOrders().filter((o) => o.side === 'sell' && o.reason.startsWith('Rotación') && Date.now() - o.t < DAY_MS).length;
const lastRotationBuyAt = (symbol) => getOrders().find((o) => o.symbol === symbol && o.side === 'buy' && o.reason.startsWith('Rotación'))?.t ?? 0;
// Una caída enorme hasta ~1/k del coste (k = 2, 3, 4, 5, 10…) puede ser un split sin ajustar y no una pérdida real
const suspectSplit = (p) => { const r = p.price / p.avgCost; return r < 0.65 && [2, 3, 4, 5, 6, 8, 10, 15, 20].some((k) => Math.abs(r * k - 1) < 0.15); };

// Revisión autónoma: riesgo, tesis de las posiciones abiertas y compras con fundamento.
export function autonomousReview() {
  const CASH_FLOOR_PCT = cashFloorPct(); // según el régimen del S&P 500
  let mandateBlocked = ''; // por qué el mandato frenó alguna compra
  let regimeBlocked = 0; // candidatas descartadas por el filtro de mercado
  const actions = [];
  const sold = new Set();
  let suspectSkips = [];
  let closedSkips = 0; // decisiones que habría tomado pero el mercado de ese valor está cerrado
  const tryOrder = (o, label) => {
    if (!canTrade(o.symbol)) { closedSkips++; return false; }
    const r = placeOrder({ ...o, by: BY });
    if (r.ok) actions.push(label);
    return r.ok;
  };

  // 0) Posiciones que ya no encajan en el mandato (mercado, símbolo o sector excluidos): se venden
  for (const p of getSummary().positions) {
    const al = allowedByMandate(getQuote(p.symbol));
    if (!al.ok && tryOrder({ symbol: p.symbol, side: 'sell', shares: p.shares, reason: `Fuera del mandato: ${al.why}` }, `Vendo todo ${p.symbol}: ${al.why}.`)) sold.add(p.symbol);
  }
  // 1) Gestión de riesgo sobre lo que ya tengo
  for (const p of getSummary().positions) {
    if (sold.has(p.symbol)) continue;
    const { stopPct, atrPct } = stopFor(p.symbol), tp = takeProfitFor(p.symbol);
    const stopWhy = atrPct != null ? `límite ${stopPct}% = ${dec(M.riesgo.stopAtrMult)} × volatilidad diaria ${atrPct}%` : `límite ${stopPct}%, sin datos de volatilidad`;
    if (p.pnlPct <= stopPct) {
      if (p.pnlPct <= -30 && suspectSplit(p) && !eventsFresh(p.symbol)) { suspectSkips.push(p.symbol); continue; } // no vende por un posible split sin verificar
      if (tryOrder({ symbol: p.symbol, side: 'sell', shares: p.shares, reason: `Stop-loss: pérdida de ${pct(p.pnlPct)} (${stopWhy})` },
        `Vendo todo ${p.symbol} por stop-loss (${pct(p.pnlPct)}; ${stopWhy}).`)) sold.add(p.symbol);
    } else if (p.pnlPct >= tp && p.shares >= 2) {
      const n = Math.max(1, Math.floor((p.shares * M.riesgo.takeProfitSellPct) / 100));
      if (tryOrder({ symbol: p.symbol, side: 'sell', shares: n, reason: `Toma de beneficios: ganancia de ${pct(p.pnlPct)} (objetivo ${tp}%)` },
        `Vendo ${n} de ${p.symbol} para asegurar beneficios (${pct(p.pnlPct)}).`)) sold.add(p.symbol);
    }
  }
  for (const p of getSummary().positions) {
    if (p.weightPct > OVERWEIGHT_PCT() && !sold.has(p.symbol)) {
      const equity = getSummary().equity;
      const n = Math.max(1, Math.floor(((p.weightPct - TARGET_WEIGHT_PCT()) / 100) * equity / p.price));
      if (tryOrder({ symbol: p.symbol, side: 'sell', shares: n, reason: `Rebalanceo: pesaba ${p.weightPct}% (máx. ${OVERWEIGHT_PCT()}%)` },
        `Recorto ${n} de ${p.symbol}: pesaba ${p.weightPct}% de la cartera.`)) sold.add(p.symbol);
    }
  }

  // 2) La tesis de lo que tengo: ¿sigue teniendo sentido?
  const cov = analysisCoverage();
  const ready = cov.analyzed >= cov.total * MIN_COVERAGE; // con pocos valores analizados las medianas del sector no son fiables
  for (const p of ready ? getSummary().positions : []) {
    if (sold.has(p.symbol) || Date.now() - lastBuyAt(p.symbol) < MIN_HOLD_MS()) continue;
    const a = analyze(p.symbol);
    if (!a || a.score == null || a.confidence < MIN_CONFIDENCE()) continue;
    if (a.verdict === 'Evitar') {
      tryOrder({ symbol: p.symbol, side: 'sell', shares: p.shares, reason: `Tesis rota (${a.score}/100): ${worst(a) || 'puntuación baja'}` },
        `Vendo todo ${p.symbol}: su tesis se ha deteriorado (${a.score}/100; ${worst(a, 1) || 'puntuación baja'}).`);
    } else if (a.verdict === 'Cara' && p.pnlPct >= M.ventas.expensiveGainPct && p.shares >= 2) {
      const n = Math.floor(p.shares / 2);
      tryOrder({ symbol: p.symbol, side: 'sell', shares: n, reason: `Sobrevalorada tras subir ${pct(p.pnlPct)}: ${worst(a) || 'múltiplos exigentes'}` },
        `Vendo ${n} de ${p.symbol}: tras subir ${pct(p.pnlPct)} ya está cara (${worst(a, 1) || 'múltiplos exigentes'}).`);
    } else if (a.redFlags >= M.ventas.redFlagsToReduce && p.shares >= 2) {
      const n = Math.floor(p.shares / 2);
      tryOrder({ symbol: p.symbol, side: 'sell', shares: n, reason: `Varios titulares de riesgo grave (${a.redFlags}): ${a.catalysts.filter((c) => c.text.startsWith('▼')).slice(0, 2).map((c) => c.text.slice(2)).join(' | ')}` },
        `Reduzco ${n} de ${p.symbol} por ${a.redFlags} titulares de riesgo grave.`);
    }
  }

  // 3) Compras: solo valores con tesis atractiva, repartidos por sector y con tamaño según convicción
  const sum = getSummary();
  const sectorW = {};
  for (const p of sum.positions) sectorW[p.sector] = (sectorW[p.sector] ?? 0) + p.weightPct;
  const held = Object.fromEntries(sum.positions.map((p) => [p.symbol, p.weightPct]));
  const canBuy = ready || ALLOW_MOMENTUM_ONLY();

  const FRESH_MS = 20 * 60 * 1000; // solo valores con precio reciente
  const candidates = !canBuy ? [] : getAllQuotes()
    .filter((q) => q.symbol !== 'SPY' && q.price != null && Date.now() - q.ts < FRESH_MS && (held[q.symbol] ?? 0) < M.compras.maxExistingWeightPct && allowedByMandate(q).ok && canTrade(q.symbol))
    .filter((q) => q.changePct < M.compras.maxDayRisePct && q.changePct > -M.compras.maxDayFallPct) // ni persigue saltos bruscos ni compra caídas fuertes del día
    .map((q) => {
      const a = analyze(q.symbol);
      const trend = trendPct(q.symbol);
      if (!ready) { const g = regimeGate(q.market, null); if (!g.ok) { regimeBlocked++; return null; } return { ...q, a: null, trend, mult: g.mult, pick: trend + q.changePct * 0.5 }; }
      const ok = a && a.verdict === 'Atractiva' && !a.eventRisk && a.confidence >= MIN_CONFIDENCE();
      if (!ok) return null;
      const g = regimeGate(q.market, a.score);
      if (!g.ok) { regimeBlocked++; return null; }
      return { ...q, a, trend, mult: g.mult, pick: a.score + clamp(q.changePct, -3, 3) };
    })
    .filter((c) => c && (c.a || c.pick > -0.3));

  let buys = 0;
  while (buys < MAX_BUYS_PER_REVIEW() && candidates.length) {
    candidates.sort((a, b) => (sectorW[a.sector] ?? 0) - (sectorW[b.sector] ?? 0) || b.pick - a.pick);
    const c = candidates.shift();
    const s = getSummary();
    if (M.riesgo.maxPositions > 0 && !held[c.symbol] && s.positions.length >= M.riesgo.maxPositions) { mandateBlocked = `límite de ${M.riesgo.maxPositions} posiciones alcanzado`; break; }
    if ((sectorW[c.sector] ?? 0) >= M.riesgo.sectorMaxPct) { mandateBlocked = `sector ${c.sector} en el máximo del ${M.riesgo.sectorMaxPct} %`; continue; }
    const spendable = s.cash - (s.equity * CASH_FLOOR_PCT) / 100;
    const conviction = c.a ? clamp((c.a.score - M.compras.convictionFloorScore) / M.compras.convictionSpan, 0, 1) : 0.3;
    const budget = Math.min((s.equity * ENTRY_PCT() * (0.6 + 0.8 * conviction) * c.mult * sizeFactor(c.symbol)) / 100, spendable);
    const shares = Math.floor(budget / c.price);
    if (shares < 1) break;
    const why = c.a
      ? `Tesis ${c.a.score}/100 (valoración ${c.a.scores.valuation ?? '–'}, crecimiento ${c.a.scores.growth ?? '–'}): ${thesisLine(c.a, 3)}`
      : `Sin datos fundamentales: diversificación en ${c.sector} por tendencia ${pct(c.trend)}`;
    const ok = tryOrder(
      { symbol: c.symbol, side: 'buy', shares, reason: `${why} · ${c.sector} con peso ${(sectorW[c.sector] ?? 0).toFixed(1)}%` },
      c.a ? `Compro ${shares} de ${c.symbol} (${c.sector}): tesis ${c.a.score}/100 — ${thesisLine(c.a, 2)}.`
          : `Compro ${shares} de ${c.symbol} (${c.sector}) solo por tendencia (sin datos fundamentales).`
    );
    if (ok) { buys++; sectorW[c.sector] = (sectorW[c.sector] ?? 0) + ((shares * c.price) / s.equity) * 100; }
  }

  // 3b) Rotación: sin margen de efectivo, vende la posición más débil si una candidata la supera con claridad
  let rotationNote = '';
  const s1 = getSummary();
  const noRoom = s1.cash - (s1.equity * CASH_FLOOR_PCT) / 100 < s1.equity * 0.02;
  if (ready && noRoom && rotationsToday() >= MAX_ROTATIONS_PER_DAY()) rotationNote = ` Límite de ${MAX_ROTATIONS_PER_DAY()} rotaciones en 24 h alcanzado.`;
  if (ready && noRoom && rotationsToday() < MAX_ROTATIONS_PER_DAY()) {
    const weak = s1.positions
      .filter((p) => !sold.has(p.symbol) && canTrade(p.symbol) && Date.now() - lastBuyAt(p.symbol) >= MIN_HOLD_MS() && Date.now() - lastRotationBuyAt(p.symbol) >= ROTATION_MIN_HOLD_MS())
      .map((p) => ({ p, a: analyze(p.symbol) }))
      .filter(({ a }) => a && a.score != null && a.confidence >= MIN_CONFIDENCE())
      .sort((x, y) => x.a.score - y.a.score);
    const rotCands = getAllQuotes()
      .filter((q) => q.symbol !== 'SPY' && q.price != null && Date.now() - q.ts < FRESH_MS && !held[q.symbol] && allowedByMandate(q).ok && canTrade(q.symbol) && q.changePct < M.compras.maxDayRisePct && q.changePct > -M.compras.maxDayFallPct)
      .map((q) => ({ q, a: analyze(q.symbol) }))
      .filter(({ a }) => a && a.verdict === 'Atractiva' && !a.eventRisk && a.confidence >= MIN_CONFIDENCE())
      .filter(({ q, a }) => { const ok = regimeGate(q.market, a.score).ok; if (!ok) regimeBlocked++; return ok; })
      .sort((x, y) => y.a.score - x.a.score);
    if (weak.length) rotationNote = ` Posición más débil: ${weak[0].p.symbol} ${weak[0].a.score}/100; solo se rota si una candidata la supera en ${ROTATION_GAP()}+ puntos.`;
    let pair = null;
    outer: for (const c of rotCands) {
      for (const w of weak) {
        if (c.a.score - w.a.score < ROTATION_GAP()) break; // `weak` va de menor a mayor puntuación: las siguientes tendrían aún menos ventaja
        const sectorAfter = (sectorW[c.q.sector] ?? 0) - (w.p.sector === c.q.sector ? w.p.weightPct : 0);
        if (sectorAfter >= ROTATION_SECTOR_MAX()) continue;
        pair = { c, w }; break outer;
      }
    }
    if (pair) {
      const { c, w } = pair, gap = c.a.score - w.a.score;
      const sold1 = tryOrder(
        { symbol: w.p.symbol, side: 'sell', shares: w.p.shares, reason: `Rotación: ${w.p.symbol} puntúa ${w.a.score}/100 y ${c.q.symbol} ${c.a.score}/100 (+${gap}); se libera capital para la mejor candidata (${worst(w.a, 1) || 'puntuación inferior'})` },
        `Rotación: vendo todo ${w.p.symbol} (${w.a.score}/100, la posición más débil) para comprar ${c.q.symbol} (${c.a.score}/100).`
      );
      if (sold1) {
        sold.add(w.p.symbol);
        const s2 = getSummary();
        const room = s2.cash - (s2.equity * CASH_FLOOR_PCT) / 100;
        const conviction = clamp((c.a.score - M.compras.convictionFloorScore) / M.compras.convictionSpan, 0, 1);
        const budget = Math.min((s2.equity * ENTRY_PCT() * (0.6 + 0.8 * conviction) * regimeGate(c.q.market, c.a.score).mult * sizeFactor(c.q.symbol)) / 100, room);
        const shares = Math.floor(budget / c.q.price);
        if (shares >= 1) tryOrder(
          { symbol: c.q.symbol, side: 'buy', shares, reason: `Rotación desde ${w.p.symbol} (${w.a.score}/100 → ${c.a.score}/100): ${thesisLine(c.a, 3)} · ${c.q.sector}` },
          `Compro ${shares} de ${c.q.symbol} (${c.q.sector}): tesis ${c.a.score}/100 — ${thesisLine(c.a, 2)}.`
        );
      }
    }
  }

  const s = getSummary();
  let head;
  const open = ENFORCE ? openMarkets() : null;
  if (actions.length) head = actions.join(' ');
  else if (open && !open.length) head = 'Mercados cerrados: no se opera hasta la próxima sesión (el gestor sigue recopilando datos y noticias).';
  else if (ready && s.cash - (s.equity * CASH_FLOOR_PCT) / 100 < s.equity * 0.01) {
    const top = rank({ limit: 8, verdicts: ['Atractiva'], minConfidence: MIN_CONFIDENCE() }).filter((a) => !held[a.symbol]).slice(0, 3);
    head = `Sin cambios: el efectivo está en el mínimo (${((s.cash / s.equity) * 100).toFixed(1)} %, colchón del ${CASH_FLOOR_PCT} %) y no hay margen para nuevas compras.` +
      (top.length ? ` Candidatas en espera: ${top.map((a) => `${a.symbol} ${a.score}/100`).join(', ')}.` : '') + rotationNote;
  }
  else if (suspectSkips.length) head = `Sin cambios: ${suspectSkips.join(', ')} ha caído de golpe y podría ser un split sin verificar; no se vende por stop-loss hasta confirmar con los datos de eventos.`;
  else if (closedSkips) head = `Sin cambios: ${closedSkips} decisión(es) pendientes de que abra el mercado de ese valor.`;
  else if (!ready && !ALLOW_MOMENTUM_ONLY()) head = `Sin cambios: el análisis fundamental aún cubre ${cov.analyzed}/${cov.total} valores y necesito al menos ${Math.ceil(cov.total * MIN_COVERAGE)} para comparar cada empresa con su sector. El gestor espera antes de comprar o vender por tesis (la gestión de riesgo sigue activa).`;
  else {
    const top = rank({ limit: 3, verdicts: ['Atractiva', 'Neutral', 'Cara', 'Precaución', 'Evitar'], minConfidence: MIN_CONFIDENCE() });
    head = `Sin cambios: ningún valor cumple ahora los criterios (tesis atractiva, sin resultados inminentes y sin riesgo grave en titulares).` +
      (top.length ? ` Mejor puntuados: ${top.map((a) => `${a.symbol} ${a.score}/100 (${a.verdict})`).join(', ')}.` : '');
  }
  if (mandateBlocked) head += ` Mandato: ${mandateBlocked}.`;
  const rg = regimeFor('S&P 500');
  const st = stressInfo();
  const stressed = st && st.level !== 'normal';
  const regimeNote = (rg && rg.state !== 'alcista') || stressed
    ? ` Filtro de mercado: ${[rg && rg.state !== 'alcista' ? regimeText('S&P 500') : null, stressed ? st.text : null].filter(Boolean).join('; ')}; ${rg?.state === 'bajista' ? `solo compro con tesis de ${bearMinScore()}+/100 y a medio tamaño` : 'compro con tamaño reducido'}, colchón de efectivo del ${CASH_FLOOR_PCT} %.${regimeBlocked ? ` ${regimeBlocked} candidata(s) descartada(s) por el filtro.` : ''}`
    : '';
  return `${head}${regimeNote} Patrimonio ${usd(s.equity)}, efectivo ${usd(s.cash)} (${((s.cash / s.equity) * 100).toFixed(1)}%). Análisis: ${cov.analyzed}/${cov.total} valores.`;
}

// ---------- Chat por palabras clave ----------
const GLOSSARY = [
  [/(qu[eé] es|explica|significa|c[oó]mo funciona).*(orden(es)? l[ií]mite|limit order)/, 'Una orden límite es una orden que solo se ejecuta si el precio llega al nivel que tú fijas. Compra límite: se ejecuta cuando el precio baja hasta ese nivel (o menos). Venta límite: cuando sube hasta ese nivel (o más). Aquí: "compra 10 AAPL a 300" o "vende 5 MSFT a 600". Caducan a los 30 días.'],
  [/stop.?loss/, 'Un stop-loss es una orden o regla para vender si el precio cae un porcentaje determinado y limitar así la pérdida. Este gestor lo ajusta a la volatilidad de cada valor (3,5 veces su variación diaria típica, entre -6 % y -15 %; -8 % si aún no hay datos).'],
  [/diversific/, 'Diversificar es repartir el dinero entre distintos valores y sectores para que un mal resultado en uno no hunda toda la cartera. Reduce el riesgo específico, pero no elimina el riesgo de mercado.'],
  [/drawdown|ca[ií]da m[aá]xima/, 'El drawdown máximo es la mayor caída desde un máximo hasta un mínimo posterior. Mide cuánto "dolor" ha tenido que soportar la cartera.'],
  [/volatilidad/, 'La volatilidad mide cuánto fluctúan los precios. Más volatilidad implica más incertidumbre: puede dar más ganancias, pero también más pérdidas.'],
  [/\bper\b|p\/e/, 'El PER (price-to-earnings) es precio de la acción dividido entre el beneficio por acción. Un PER alto suele indicar que el mercado espera mucho crecimiento (o que está cara); compáralo siempre con empresas del mismo sector.'],
  [/\betf\b|fondo cotizado/, 'Un ETF es un fondo que cotiza en bolsa y replica un índice o una cesta de activos. SPY replica el S&P 500; aquí lo usamos como referencia para comparar.'],
  [/dividendo/, 'Un dividendo es la parte del beneficio que una empresa reparte a sus accionistas. Esta simulación los abona en efectivo al cobrarse (sin impuestos).'],
  [/hhi|concentraci/, 'El HHI mide la concentración: suma de los pesos al cuadrado. Cerca de 0 = muy repartida; cerca de 1 = todo en un solo valor.'],
  [/momentum|tendencia/, 'El momentum es la tendencia a que lo que sube siga subiendo a corto plazo (y lo contrario). Este gestor lo usa como criterio secundario al elegir qué comprar.'],
  [/\betf|bolsa|mercado de valores|acci[oó]n(es)?\b.*qu[eé]|qu[eé] es una acci/, 'Una acción es una parte del capital de una empresa; la bolsa es el mercado donde se compran y venden. El precio sube o baja según la oferta y la demanda.'],
];

// ---------- Reconocimiento de valores por símbolo o nombre (S&P 500 + IBEX 35) ----------
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(inc|corp|corporation|company|co|ltd|plc|group|holdings|the|sa|de|del)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

const SYMBOLS = new Set(UNIVERSE.map((u) => u.symbol));
const NAME_KEYS = new Map(); // nombre normalizado -> símbolo
{
  const firstWords = new Map();
  for (const u of UNIVERSE) {
    const n = norm(u.name);
    if (n && !NAME_KEYS.has(n)) NAME_KEYS.set(n, u.symbol);
    const w = n.split(' ')[0];
    firstWords.set(w, (firstWords.get(w) ?? 0) + 1);
  }
  // la primera palabra sirve de alias solo si no es ambigua ("apple" sí; "american" no)
  for (const u of UNIVERSE) {
    const w = norm(u.name).split(' ')[0];
    if (firstWords.get(w) === 1 && w.length >= 4 && !NAME_KEYS.has(w)) NAME_KEYS.set(w, u.symbol);
  }
}

function symbolFromToken(tok) {
  const up = tok.toUpperCase().replace(/[.,;:!?]+$/, '');
  if (SYMBOLS.has(up)) return up;
  if (SYMBOLS.has(up.replace('.', '-'))) return up.replace('.', '-'); // BRK.B -> BRK-B
  if (SYMBOLS.has(up + '.MC')) return up + '.MC';                     // SAN -> SAN.MC
  return null;
}

// "banco santander por favor" -> SAN.MC (prueba con 1-4 palabras, de más a menos)
function resolveSymbol(str) {
  const tokens = str.trim().split(/\s+/).filter(Boolean);
  for (let len = tokens.length; len >= 1; len--) {
    const cand = tokens.slice(0, len).join(' ');
    const sym = (len === 1 ? symbolFromToken(cand) : null) ?? NAME_KEYS.get(norm(cand));
    if (sym) return sym;
  }
  return null;
}

// Busca un valor mencionado en texto libre: símbolos en MAYÚSCULAS o nombres de empresa
function findMentioned(text) {
  for (const tok of text.match(/\b[A-Z][A-Z0-9.\-]{1,9}\b/g) ?? []) {
    const s = symbolFromToken(tok);
    if (s) return s;
  }
  const nt = ' ' + norm(text) + ' ';
  let best = null;
  for (const [k, sym] of NAME_KEYS) if (nt.includes(' ' + k + ' ') && (!best || k.length > best.k.length)) best = { k, sym };
  return best?.sym ?? null;
}

const native = (q) => q.priceNative.toLocaleString('es-ES', { style: 'currency', currency: q.currency });

function describePortfolio() {
  const s = getSummary();
  if (!s.positions.length) return `Todavía no tienes posiciones. Efectivo: ${usd(s.cash)}. Escribe "revisa la cartera" y el gestor invertirá de forma diversificada, o "compra 10 AAPL".`;
  const rows = s.positions.map((p) => `• ${p.symbol}: ${p.shares} acc. a ${usd(p.price)} → ${usd(p.value)} (${p.weightPct}% de la cartera, P&L ${usd(p.pnl)} / ${pct(p.pnlPct)})`).join('\n');
  return `Patrimonio ${usd(s.equity)} (${pct(s.totalReturnPct)} desde el inicio). Efectivo ${usd(s.cash)}, invertido ${usd(s.invested)}.\n${rows}`;
}

function describeRisk() {
  const r = getRisk();
  const notes = [];
  if (r.cashPct < 10) notes.push('Tienes poco efectivo: menos margen para aprovechar oportunidades.');
  if (r.cashPct > 60) notes.push('Más de la mitad está en efectivo: poco riesgo, pero también poco potencial.');
  if (r.concentrationHHI > 0.25) notes.push('La cartera está bastante concentrada; conviene repartir más.');
  const top = Object.entries(r.sectorWeightsPct).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 40) notes.push(`Exposición alta a ${top[0]} (${top[1]}%).`);
  if (!notes.length) notes.push('Los indicadores están dentro de los límites del gestor.');
  return `Riesgo: drawdown máx. ${pct(r.maxDrawdownPct)}, efectivo ${r.cashPct}%, concentración (HHI) ${r.concentrationHHI}, vs S&P 500 ${pct(r.vsSpyPct)}.\nSectores: ${Object.entries(r.sectorWeightsPct).map(([k, v]) => `${k} ${v}%`).join(', ') || 'ninguno'}.\n${notes.join(' ')}`;
}

// ---------- Análisis fundamental en el chat ----------
function opportunitiesText() {
  const cov = analysisCoverage();
  if (!cov.analyzed) return `Todavía no hay datos fundamentales (0/${cov.total} valores analizados). Se descargan poco a poco en segundo plano; prueba en unos minutos. Con "estado de los datos" ves cómo va.`;
  const list = rank({ limit: 8 });
  if (!list.length) {
    const top = rank({ limit: 5, verdicts: ['Neutral', 'Cara', 'Precaución', 'Evitar'], minConfidence: 0.5 });
    return `Ahora mismo ningún valor llega a "atractivo" (${cov.analyzed}/${cov.total} analizados).` + (top.length ? '\nLos mejor puntuados son:\n' + top.map((a) => `• ${a.symbol} (${a.name}): ${a.verdict} ${a.score}/100`).join('\n') : '');
  }
  return `Valores con tesis atractiva (${cov.analyzed}/${cov.total} analizados):\n` +
    list.map((a) => `• ${a.symbol} (${a.name}, ${a.sector}): ${a.score}/100 · valoración ${a.scores.valuation ?? '–'} · crecimiento ${a.scores.growth ?? '–'} — ${thesisLine(a, 2)}`).join('\n') +
    '\nPide "analiza <valor>" para ver el detalle completo.';
}

function expensiveText() {
  const list = rank({ limit: 8, verdicts: ['Cara'], sortBy: 'valuation' });
  if (!list.length) return 'No he encontrado valores claramente caros entre los ya analizados (o aún faltan datos).';
  return 'Valores caros según el análisis (múltiplos altos para su crecimiento y sector):\n' +
    list.map((a) => `• ${a.symbol} (${a.name}): valoración ${a.scores.valuation}/100 — ${a.reasons.filter((r) => r.type === 'neg').slice(0, 2).map((r) => r.text).join('; ')}`).join('\n');
}

function newsText(sym) {
  const a = analyze(sym);
  if (!a?.headlines.length) return `No tengo titulares recientes de ${a?.name ?? sym} (se descargan en segundo plano para lo que tienes en cartera y los candidatos).`;
  return `Titulares recientes de ${a.name} (${a.symbol}), con lectura automática por palabras clave:\n` +
    a.headlines.map((h) => `• ${h.sentiment >= 1 ? '▲' : h.sentiment <= -1 ? '▼' : '·'} ${h.headline}${h.tags.length ? ` [${h.tags.join(', ')}]` : ''} — ${h.source}`).join('\n') +
    '\nOjo: la lectura por palabras clave es limitada (no entiende ironía ni matices).';
}

function explainTrade(sym) {
  const o = getOrders().find((x) => x.symbol === sym);
  const held = getSummary().positions.find((p) => p.symbol === sym);
  if (!o) return `No he operado con ${sym}.${held ? '' : ' Ahora no lo tengo en cartera.'}`;
  const a = analyze(sym);
  return `Última operación en ${sym}: ${o.side === 'buy' ? 'compra' : 'venta'} de ${o.shares} a ${usd(o.price)} (${new Date(o.t).toLocaleString('es-ES')}, por ${o.by}).\nMotivo: ${o.reason}` +
    (a?.score != null ? `\nAhora mismo el análisis dice: ${a.verdict} (${a.score}/100).` : '');
}

function dataStatusText() {
  const st = fundamentalsStats();
  const errs = Object.entries(st.errors).map(([k, e]) => `${k}: ${e.count} fallos (último: ${e.last}${e.symbol ? ' en ' + e.symbol : ''})`);
  return `Análisis fundamental: ${st.analyzed}/${st.total} valores con datos.\nFuente del S&P 500: ${st.finnhub ? 'Finnhub' : 'Yahoo (sin clave de Finnhub: más lento y con menos datos)'}. Fuente del IBEX 35: Yahoo.\n` +
    (errs.length ? 'Incidencias: ' + errs.join(' | ') : 'Sin incidencias registradas.') +
    (!st.finnhub ? '\nConsejo: crea una clave gratuita en finnhub.io y arranca con FINNHUB_API_KEY para analizar el S&P 500 con datos más fiables.' : '');
}

function portfolioAnalysisText() {
  const s = getSummary();
  if (!s.positions.length) return 'No tienes posiciones que analizar todavía.';
  return 'Tesis de tus posiciones:\n' + s.positions.map((p) => {
    const a = analyze(p.symbol);
    return `• ${p.symbol} (${p.weightPct}% de la cartera, ${pct(p.pnlPct)}): ${a?.score != null ? `${a.verdict} ${a.score}/100` : 'sin datos aún'}${a?.eventRisk ? ' · resultados inminentes' : ''}${a?.redFlags ? ' · ⚠ titulares de riesgo' : ''}`;
  }).join('\n');
}

const money = (n, currency) => n.toLocaleString('es-ES', { style: 'currency', currency });

function listPending() {
  const p = getPending();
  if (!p.length) return 'No tienes órdenes límite pendientes. Crea una con "compra 10 AAPL a 300".';
  return 'Órdenes límite pendientes:\n' + p.map((o) => {
    const q = getQuote(o.symbol);
    const now = q?.priceNative != null ? `, ahora ${money(q.priceNative, o.currency)}` : '';
    return `• #${o.id}: ${o.side === 'buy' ? 'comprar' : 'vender'} ${o.shares} ${o.symbol} cuando el precio sea ${o.side === 'buy' ? '≤' : '≥'} ${money(o.limit, o.currency)}${now}${o.lastError ? ` (⚠ ${o.lastError})` : ''}`;
  }).join('\n');
}

export function ruleChat(text, onOrder, onReview) {
  const t = text.toLowerCase().trim();

  if (/\bcancel(a|ar|e)\b/.test(t)) {
    const pending = getPending();
    if (/todas/.test(t)) {
      pending.forEach((o) => cancelLimitOrder(o.id));
      return pending.length ? `Canceladas ${pending.length} órdenes límite.` : 'No había órdenes límite pendientes.';
    }
    const num = t.match(/#?(\d+)/);
    const id = num ? Number(num[1]) : pending.length === 1 ? pending[0].id : null;
    if (id == null) return pending.length ? `Dime cuál cancelar, por ejemplo "cancela la orden ${pending[0].id}".\n${listPending()}` : 'No tienes órdenes límite pendientes.';
    const r = cancelLimitOrder(id);
    return r.ok ? `Cancelada la orden límite #${id} (${r.order.side === 'buy' ? 'compra' : 'venta'} de ${r.order.shares} ${r.order.symbol}).` : r.error;
  }

  const m = t.match(/\b(compra|comprar|vende|vender)\s+(\d+)\s+(?:acciones\s+)?(?:de\s+)?([a-z0-9áéíóúñ.\-]+(?:\s+[a-z0-9áéíóúñ.\-]+){0,3})/);
  if (m) {
    const side = m[1].startsWith('comp') ? 'buy' : 'sell';
    const symbol = resolveSymbol(m[3]);
    if (!symbol) return `No reconozco el valor "${m[3]}". Usa el símbolo (AAPL, SAN.MC...) o el nombre (apple, banco santander...). Tengo el S&P 500 y el IBEX 35.`;
    // "compra 10 aapl a 300" / "vende 5 msft si sube a 600" -> orden límite
    const lim = t.match(/\b(?:a|en|hasta|l[ií]mite(?: de)?|si (?:baja|sube|cae|llega) a|cuando (?:baje|suba|caiga|llegue) a)\s+(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros|usd|\$|d[oó]lares)?/);
    if (lim) {
      const limit = Number(lim[1].replace(',', '.'));
      const r = addLimitOrder({ symbol, side, shares: Number(m[2]), limit, reason: 'Orden límite por chat', by: 'usuario (chat)' });
      if (!r.ok) return `No he podido crearla: ${r.error}.`;
      const q = getQuote(symbol);
      const o = r.order;
      const now = q.priceNative != null ? money(q.priceNative, q.currency) : 'sin precio aún';
      return `Orden límite #${o.id} creada: ${side === 'buy' ? 'comprar' : 'vender'} ${o.shares} ${symbol} cuando el precio sea ${side === 'buy' ? '≤' : '≥'} ${money(o.limit, q.currency)} (ahora ${now}). Caduca en 30 días.` +
        (r.triggersNow ? '\nOjo: esa condición ya se cumple ahora mismo, así que se ejecutará en el próximo ciclo (unos segundos). Si querías esperar a otro precio, cancélala con "cancela la orden ' + o.id + '".' : '');
    }
    const r = placeOrder({ symbol, side, shares: Number(m[2]), reason: 'Orden por chat', by: 'usuario (chat)' });
    onOrder?.();
    return r.ok
      ? `Hecho: ${side === 'buy' ? 'compradas' : 'vendidas'} ${r.order.shares} acciones de ${symbol} a ${usd(r.order.price)} (total ${usd(r.order.total)}).`
      : `No he podido ejecutarla: ${r.error}.`;
  }

  if (/revis|optimiz|rebalanc|gestiona|invierte|invierta|opera por m[ií]/.test(t)) {
    const res = autonomousReview();
    onOrder?.();
    onReview?.(res); // queda registrada también en "Decisiones del agente"
    return res;
  }

  // --- análisis fundamental ---
  const sym = findMentioned(text);
  const askAnalysis = /analiz|qu[eé] opin|opini[oó]n|vale la pena|merece|est[aá] (cara|barata|infravalorad|sobrevalorad)|valoraci[oó]n|tesis|fundament|recomiendas|proyecci[oó]n|buena inversi[oó]n/.test(t);
  if (/por qu[eé] (compr|vend|tengo|tienes|cog)/.test(t) && sym) return explainTrade(sym);
  if (/noticias|titulares|catalizador/.test(t) && sym) return newsText(sym);
  if (askAnalysis && sym) return analysisText(analyze(sym));
  if (askAnalysis && /cartera|posiciones/.test(t)) return portfolioAnalysisText();
  if (/datos fundamentales|estado de los datos|cobertura|an[aá]lisis cargado|cu[aá]ntas empresas has analizado/.test(t)) return dataStatusText();
  if (/oportunidad|qu[eé] (comprar|compro)|mejores (valores|empresas|acciones)|(valores|empresas|acciones) (baratas|baratos|atractiv|infravalorad)/.test(t)) return opportunitiesText();
  if (/\b(caras|caros|sobrevalorad|infravalorad|evitar)\b/.test(t) && !sym) return expensiveText();

  for (const [re, answer] of GLOSSARY) if (re.test(t)) return answer;

  if (/riesgo|diversific|concentra|drawdown/.test(t)) return describeRisk();
  if (/cartera|posici[oó]n|patrimonio|rentabilidad|cu[aá]nto (tengo|llevo|he ganado)|efectivo/.test(t)) return describePortfolio();
  if (/pendiente|l[ií]mite/.test(t)) return listPending();
  if (/orden|historial|operaciones/.test(t)) {
    const o = getOrders().slice(0, 5);
    return o.length ? 'Últimas operaciones:\n' + o.map((x) => `• ${x.side === 'buy' ? 'Compra' : 'Venta'} ${x.shares} ${x.symbol} a ${usd(x.price)} — ${x.reason}`).join('\n') : 'Aún no hay operaciones.';
  }

  const mentioned = findMentioned(text);
  if (mentioned) {
    const q = getQuote(mentioned);
    if (q.price == null) return `${q.name} (${q.symbol}): todavía no tengo su precio; se carga en segundo plano, prueba en unos segundos.`;
    const px = q.currency === 'USD' ? usd(q.price) : `${native(q)} (≈ ${usd(q.price)})`;
    return `${q.name} (${q.symbol}, ${q.market}, ${q.sector}): ${px}, ${pct(q.changePct)} hoy; tendencia reciente ${pct(trendPct(q.symbol))}.`;
  }
  if (/mercado|precio|cotiza|bolsa hoy|c[oó]mo va|mejores|peores/.test(t)) {
    const all = getAllQuotes();
    const live = all.filter((q) => q.price != null && q.symbol !== 'SPY').sort((a, b) => b.changePct - a.changePct);
    if (!live.length) return 'Aún no hay precios cargados; espera unos segundos.';
    const line = (q) => `• ${q.symbol} (${q.name}): ${q.currency === 'USD' ? usd(q.price) : native(q)} ${pct(q.changePct)}`;
    return `Tengo precio de ${live.length} de ${all.length - 1} valores (se cargan por turnos).\nMejores hoy:\n${live.slice(0, 5).map(line).join('\n')}\nPeores hoy:\n${live.slice(-5).reverse().map(line).join('\n')}\nPregunta por uno concreto: "precio de apple", "cómo va SAN.MC".`;
  }

  return 'Soy un gestor basado en reglas (gratis, sin IA externa). Tengo el S&P 500 y el IBEX 35. Puedo:\n• "revisa la cartera": invierte y rebalancea con mis reglas\n• "compra 10 AAPL" / "vende 5 banco santander"\n• Órdenes límite: "compra 10 AAPL a 300", "órdenes pendientes", "cancela la orden 2"\n• Análisis fundamental: "analiza apple", "¿está cara nvidia?", "oportunidades", "noticias de inditex", "por qué compraste AAPL", "estado de los datos"\n• "precio de inditex", "mejores del día", "cómo va mi cartera", "riesgo", "últimas operaciones"\n• Explicar conceptos: stop-loss, diversificación, drawdown, volatilidad, PER, ETF…\nEs una simulación educativa, no asesoramiento financiero.';
}
