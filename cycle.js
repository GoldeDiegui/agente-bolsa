// Modo "una pasada": hace un ciclo completo y termina. Pensado para ejecutarse solo (GitHub Actions), sin servidor ni ordenador encendido.
//   node cycle.js trade   -> precios, órdenes límite, gestión de riesgo, revisión autónoma, descarga de datos
//   node cycle.js datos   -> solo descarga de fundamentales y noticias (sirve fuera de horario de mercado)
// El estado se lee y se guarda en DATA_FILE / FUNDAMENTALS_FILE; la web de solo lectura se exporta a SITE_DIR/state.json.
import fs from 'node:fs';
import path from 'node:path';
import { refreshPrices, getAllQuotes, marketStats, UNIVERSE } from './market.js';
import { getSummary, snapshot, getOrders, getEquityCurve, getRisk, getPending, checkPending, getWatchedSymbols, addAgentLog, getAgentLog, getEvents, flushState } from './portfolio.js';
import { checkCorporateEvents } from './corporate.js';
import { maybeSnapshot, evaluate, summary as scoreSummary } from './scorecard.js';
import { dailySummary } from './daily.js';
import { refreshVolatility, refreshRegime, regimeSummary } from './volatility.js';
import { runFundamentalsBudget, flushFundamentals, fundamentalsStats, hasFinnhub, exportStatements } from './fundamentals.js';
import { analyze, brief, rank, shortlist, analysisCoverage } from './analysis.js';
import { autonomousReview, agentEnabled, agentMode } from './agent.js';
import { MARKETS, marketClock, openMarkets, scheduleText, ENFORCE } from './hours.js';

const mode = process.argv[2] || process.env.CYCLE_MODE || 'trade';
const SITE_DIR = process.env.SITE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'site');
const FUND_BUDGET_MS = Number(process.env.FUND_BUDGET_SECONDS || (mode === 'trade' ? 90 : 330)) * 1000;
const MAX_MS = Number(process.env.CYCLE_MAX_SECONDS || 600) * 1000; // tope duro
const LOG_EVERY_MS = 60 * 60 * 1000; // sin operaciones, se anota "sin cambios" como mucho cada hora

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const finish = (code = 0) => { try { flushState(); flushFundamentals(); } catch { /* ignorar */ } process.exit(code); };
setTimeout(() => { console.error('Tiempo máximo del ciclo superado: se guarda lo hecho y se sale.'); finish(1); }, MAX_MS).unref();

// ¿Hay algo que hacer?
const open = openMarkets();
if (mode === 'trade' && ENFORCE && !open.length && process.env.FORCE_RUN !== '1') { log('Mercados cerrados: no hay nada que hacer.'); process.exit(0); }
log(`Ciclo "${mode}" · mercados abiertos: ${open.join(', ') || 'ninguno'} · gestor: ${agentMode()} · fundamentales: ${hasFinnhub() ? 'Finnhub+Yahoo' : 'Yahoo'}`);

const openSet = new Set(open);
const worklist = {
  getWatched: getWatchedSymbols,
  // candidatos de los mercados abiertos (si solo importan los datos, de cualquier mercado)
  getShortlist: () => shortlist(60).filter((s) => mode !== 'trade' || !ENFORCE || openSet.has(UNIVERSE.find((u) => u.symbol === s)?.market)).slice(0, 30),
};

try {
  // 1) Datos primero: así la lista de candidatos ya incluye lo recién analizado
  const n = await runFundamentalsBudget(worklist, FUND_BUDGET_MS);
  const cov = analysisCoverage();
  log(`Datos: ${n} descargas · análisis ${cov.analyzed}/${cov.total}`);
  // 2) Precios de lo que tengo, de las órdenes pendientes y de los candidatos
  // (fuera de horario también: sirve para valorar la cartera al último cierre en la web)
  // En el ciclo de datos se refresca todo el universo; en el de operar, un lote grande (la caché en disco conserva el resto)
  const pr = await refreshPrices([...getWatchedSymbols(), ...worklist.getShortlist()],
    mode === 'trade' ? { batch: Number(process.env.PRICE_BATCH_TRADE || 120), budgetMs: 100000 } : { batch: Infinity, budgetMs: 200000 });
  log(`Precios: ${pr.requested}/${pr.total} pedidos · ${marketStats().loaded}/${marketStats().total} con precio`);

  // 2b) Volatilidad de lo que tengo y de los candidatos (para el stop-loss y el tamaño) y régimen de mercado
  {
    await refreshRegime();
    const v = await refreshVolatility([...getWatchedSymbols(), ...worklist.getShortlist()], { budgetMs: 40000 });
    const rs = regimeSummary();
    log(`Volatilidad: ${v.done} nuevas · mercado: ${Object.entries(rs.markets).map(([m, r]) => `${m} ${r.state}`).join(', ') || 'sin datos'}`);
  }

  // 3) Splits y dividendos de lo que tengo (antes de decidir nada, para que los precios y las acciones cuadren)
  {
    const { applied, failures } = await checkCorporateEvents();
    for (const e of applied) { log(`${e.type === 'split' ? 'Split' : 'Dividendo'} ${e.symbol}: ${e.text}`); addAgentLog({ t: Date.now(), summary: `${e.type === 'split' ? 'Split' : 'Dividendo'} en ${e.symbol}: ${e.text}` }); }
    if (failures) log(`Eventos: ${failures} valor(es) sin revisar (se reintenta en el próximo ciclo)`);
  }
  // 4) Marcador de aciertos: cohorte semanal y, fuera de horario de mercado, evaluación de las ya maduras
  {
    const c = maybeSnapshot();
    if (c) log(`Marcador: cohorte ${c.week} guardada (${c.rows.length} valores)`);
    if (mode !== 'trade') {
      const ev = await evaluate({ budgetMs: Number(process.env.SCORE_BUDGET_SECONDS || 90) * 1000 });
      if (ev.fetched) log(`Marcador: ${ev.fetched} descargas, ${ev.resolved} resultados nuevos`);
    }
  }
  if (mode === 'trade') {
    const before = getOrders().length;
    const changed = checkPending();
    if (changed.length) log('Órdenes límite:', JSON.stringify(changed));
    snapshot();
    let summary = '';
    if (agentEnabled()) summary = await autonomousReview();
    const traded = getOrders().length - before;
    const last = getAgentLog()[0]?.t ?? 0;
    if (traded > 0 || Date.now() - last > LOG_EVERY_MS) addAgentLog({ t: Date.now(), summary });
    log(traded ? `${traded} operación(es):` : 'Sin operaciones:', summary);
  }
} catch (e) {
  console.error('Error en el ciclo:', e);
  process.exitCode = 1;
}

// ---------- exportación para la web de solo lectura ----------
function exportSite() {
  const s = getSummary();
  for (const p of s.positions) p.thesis = brief(p.symbol);
  const syms = new Set([...s.positions.map((p) => p.symbol), ...getPending().map((o) => o.symbol)]);

  const opportunities = [];
  for (const verdict of ['Atractiva', 'Cara', 'Evitar', 'Precaución', 'Neutral']) {
    for (const market of Object.keys(MARKETS)) {
      for (const a of rank({ limit: 30, market, verdicts: [verdict] })) {
        opportunities.push({ symbol: a.symbol, name: a.name, sector: a.sector, market: a.market, verdict: a.verdict, score: a.score, scores: a.scores,
          why: a.reasons.filter((r) => r.type === 'pos').slice(0, 2).map((r) => r.short ?? r.text) });
        syms.add(a.symbol);
      }
    }
  }
  const analyses = {};
  for (const sym of syms) {
    const a = analyze(sym);
    if (a) analyses[sym] = { ...a, headlines: (a.headlines ?? []).slice(0, 4).map((h) => ({ headline: h.headline, source: h.source })) };
  }
  // Análisis de TODOS los valores en un fichero aparte (la web lo descarga solo al abrir un valor que no esté en state.json)
  const all = {};
  for (const u of UNIVERSE) {
    const a = analyze(u.symbol);
    if (a) all[u.symbol] = { ...a, headlines: (a.headlines ?? []).slice(0, 3).map((h) => ({ headline: h.headline, source: h.source })) };
  }
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SITE_DIR, 'analyses.json'), JSON.stringify({ updatedAt: Date.now(), analyses: all }));
  fs.writeFileSync(path.join(SITE_DIR, 'financials.json'), JSON.stringify(exportStatements()));
  const curve = getEquityCurve();
  const step = Math.max(1, Math.ceil(curve.length / 700));
  const now = Date.now();
  const out = {
    updatedAt: now, mode, agentMode: agentMode(), agentEnabled: true,
    markets: Object.fromEntries(Object.keys(MARKETS).map((k) => [k, { open: marketClock(k, now).open, schedule: scheduleText(k) }])),
    quotes: getAllQuotes().filter((q) => q.price != null).map((q) => ({ symbol: q.symbol, name: q.name, sector: q.sector, market: q.market, currency: q.currency, price: q.price, priceNative: q.priceNative, changePct: q.changePct, source: q.source })),
    market: marketStats(), analysis: analysisCoverage(), portfolio: s, risk: getRisk(), regime: regimeSummary(), daily: dailySummary(),
    orders: getOrders().slice(0, 300), events: getEvents().slice(0, 100), pending: getPending(),
    curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
    agentLog: getAgentLog(), scorecard: scoreSummary(), opportunities, analyses, data: fundamentalsStats(),
  };
  fs.mkdirSync(SITE_DIR, { recursive: true });
  const f = path.join(SITE_DIR, 'state.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(out));
  fs.renameSync(f + '.tmp', f);
  log(`Web exportada: ${f} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
}
try { exportSite(); } catch (e) { console.error('No se pudo exportar la web:', e); process.exitCode = 1; }
finish(process.exitCode ?? 0);
