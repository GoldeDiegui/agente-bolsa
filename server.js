import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshPrices, getAllQuotes, getHistory, marketStats } from './market.js';
import { getSummary, snapshot, getOrders, getEquityCurve, getRisk, placeOrder, addAgentLog, getAgentLog, flushState, resetPortfolio, getWatchedSymbols, addLimitOrder, cancelLimitOrder, getPending, checkPending } from './portfolio.js';
import { chat, autonomousReview, agentEnabled, agentMode } from './agent.js';
import { startFundamentals, flushFundamentals, fundamentalsStats } from './fundamentals.js';
import { analyze, analysisText, brief, rank, shortlist, analysisCoverage } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PRICE_INTERVAL_MS = 5000;                                   // refresco de precios
// Revisión autónoma: cada 5 min con reglas (gratis), cada 30 min con Claude (cuesta dinero)
const REVIEW_INTERVAL_MS = Number(process.env.REVIEW_MINUTES || (process.env.ANTHROPIC_API_KEY ? 30 : 5)) * 60 * 1000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Tiempo real (Server-Sent Events) ---
const clients = new Set();
function logDecision(summary) {
  const entry = { t: Date.now(), summary };
  addAgentLog(entry);
  broadcast('agent', entry);
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// cartera con el veredicto del análisis de cada posición
function portfolioView() {
  const s = getSummary();
  for (const p of s.positions) p.thesis = brief(p.symbol);
  return s;
}

// --- API REST ---
app.get('/api/analysis/:symbol', (req, res) => {
  const a = analyze(req.params.symbol.toUpperCase());
  if (!a) return res.status(404).json({ error: 'Valor desconocido' });
  res.json({ ...a, text: analysisText(a) });
});
app.get('/api/opportunities', (req, res) => {
  const verdicts = req.query.verdict ? [String(req.query.verdict)] : ['Atractiva'];
  const list = rank({ limit: Math.min(Number(req.query.limit) || 10, 30), market: req.query.market, sector: req.query.sector, verdicts, sortBy: req.query.sortBy === 'valuation' ? 'valuation' : 'score' });
  res.json(list.map((a) => ({ symbol: a.symbol, name: a.name, sector: a.sector, market: a.market, verdict: a.verdict, score: a.score, scores: a.scores, why: a.reasons.filter((r) => r.type === 'pos').slice(0, 2).map((r) => r.short ?? r.text) })));
});
app.get('/api/data-status', (_req, res) => res.json(fundamentalsStats()));

app.get('/api/state', (_req, res) => {
  res.json({
    quotes: getAllQuotes(), market: marketStats(), analysis: analysisCoverage(), portfolio: portfolioView(), risk: getRisk(),
    orders: getOrders(), pending: getPending(), curve: getEquityCurve(), agentLog: getAgentLog(), agentEnabled: agentEnabled(), agentMode: agentMode(),
  });
});
app.get('/api/history/:symbol', (req, res) => res.json(getHistory(req.params.symbol.toUpperCase())));

app.post('/api/order', (req, res) => {
  const r = placeOrder({ ...req.body, by: 'usuario' });
  if (r.ok) broadcast('orders', getOrders());
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/limit', (req, res) => {
  const r = addLimitOrder({ ...req.body, by: 'usuario' });
  if (r.ok) broadcast('pending', getPending());
  res.status(r.ok ? 200 : 400).json(r);
});
app.delete('/api/limit/:id', (req, res) => {
  const r = cancelLimitOrder(req.params.id);
  if (r.ok) broadcast('pending', getPending());
  res.status(r.ok ? 200 : 404).json(r);
});

app.post('/api/chat', async (req, res) => {
  const text = String(req.body?.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
  try {
    const answer = await chat(text, (ev) => { if (ev.tool === 'place_order') broadcast('orders', getOrders()); }, logDecision);
    broadcast('orders', getOrders());
    broadcast('pending', getPending());
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: 'Error del agente: ' + e.message });
  }
});

app.post('/api/reset', (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Falta confirmación' });
  resetPortfolio(); // también borra las órdenes pendientes
  broadcast('reset', {}); // las páginas abiertas se recargan solas
  res.json({ ok: true });
});

let reviewing = false;
async function runReview() {
  if (reviewing || !agentEnabled()) return;
  reviewing = true;
  try {
    const summary = await autonomousReview();
    logDecision(summary);
    broadcast('orders', getOrders());
  } catch (e) {
    console.error('Revisión autónoma fallida:', e.message);
  } finally {
    reviewing = false;
  }
}
app.post('/api/agent/review', async (_req, res) => {
  if (!agentEnabled()) return res.status(400).json({ error: 'Falta ANTHROPIC_API_KEY' });
  runReview();
  res.json({ started: true });
});

// --- Bucles de fondo ---
let ticking = false;
async function tick() {
  if (ticking) return; // si Yahoo va lento, no se solapan los ciclos
  ticking = true;
  try {
    await refreshPrices(getWatchedSymbols());
  } catch (e) {
    console.warn('Error al refrescar precios:', e.message);
  } finally {
    ticking = false;
  }
  const changed = checkPending();
  if (changed.length) { broadcast('orders', getOrders()); broadcast('pending', getPending()); }
  snapshot();
  broadcast('tick', { quotes: getAllQuotes(), market: marketStats(), analysis: analysisCoverage(), portfolio: portfolioView(), risk: getRisk(), point: getEquityCurve().at(-1) });
}
await tick();
setInterval(tick, PRICE_INTERVAL_MS);
setInterval(runReview, REVIEW_INTERVAL_MS);

// Guarda el estado al cerrar con Ctrl+C
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushState(); flushFundamentals(); process.exit(0); });

// Descarga de fundamentales y noticias en segundo plano (lo que tienes en cartera y los mejores candidatos, primero)
let sl = { t: 0, list: [] };
startFundamentals({
  getWatched: getWatchedSymbols,
  getShortlist: () => { if (Date.now() - sl.t > 60000) sl = { t: Date.now(), list: shortlist(25) }; return sl.list; },
});

app.listen(PORT, () => {
  console.log(`Agente de bolsa en http://localhost:${PORT}`);
  console.log(agentMode() === 'claude' ? 'Gestor: Claude (API de pago)' : 'Gestor: reglas (gratis, sin API)');
  console.log(fundamentalsStats().finnhub ? 'Fundamentales: Finnhub (S&P 500) + Yahoo (IBEX)' : 'Fundamentales: Yahoo para todo (define FINNHUB_API_KEY para usar Finnhub en el S&P 500)');
});
