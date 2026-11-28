// Carteras en paralelo: varias carteras virtuales con distintos parámetros compiten sobre los mismos datos de mercado.
// Cada cartera = mandato principal (mandato.json) + sus cambios (carteras.json). Tienen su propio efectivo, posiciones, órdenes y diario,
// y se guardan en carteras/<id>.json junto al estado principal. Los datos (precios, fundamentales, noticias) se descargan una sola vez.
// El gestor las procesa una tras otra en cada ciclo, cambiando de cartera y de mandato en memoria (useBook / useLaneMandate).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useLaneMandate, useMainMandate, validate, deepMerge, diffFromMain, mandateInfo, M } from './mandato.js';
import { useBook, MAIN_STATE_FILE, getSummary, snapshot, checkPending, getOrders, getEquityCurve, getDailyEquity, getAgentLog, addAgentLog, getPending, setExtraWatched, flushState, getRisk, getStartTime } from './portfolio.js';
import { checkCorporateEvents } from './corporate.js';
import { autonomousReview, agentEnabled } from './agent.js';
import { performanceReport } from './performance.js';
import { journalReport, rebuildFromOrders } from './journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LANES_FILE = process.env.LANES_FILE || path.join(__dirname, 'carteras.json');
const LANES_DIR = path.join(path.dirname(MAIN_STATE_FILE), 'carteras');
export const MAX_LANES = 6;
const laneFile = (id) => path.join(LANES_DIR, id + '.json');

// ---- configuración ----
export function loadLaneConfig(file = LANES_FILE) {
  const warnings = [], lanes = [];
  let raw = null;
  try { if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { warnings.push(`No se pudo leer ${path.basename(file)} (${e.message}): no hay carteras en paralelo`); }
  const list = Array.isArray(raw?.carteras) ? raw.carteras : [];
  if (raw && !Array.isArray(raw.carteras)) warnings.push('carteras.json debe tener una lista «carteras»');
  const seen = new Set(['principal']);
  for (const [i, c] of list.entries()) {
    const w = [];
    const id = String(c?.id ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) { warnings.push(`Cartera nº ${i + 1}: «id» no válido (solo letras minúsculas, números y guiones, máx. 24): se ignora`); continue; }
    if (seen.has(id)) { warnings.push(`Cartera «${id}»: id repetido o reservado («principal»): se ignora`); continue; }
    seen.add(id);
    if (c.activa === false) continue;
    if (lanes.length >= MAX_LANES) { warnings.push(`Máximo ${MAX_LANES} carteras en paralelo: «${id}» se ignora`); continue; }
    const over = c.mandato && typeof c.mandato === 'object' && !Array.isArray(c.mandato) ? c.mandato : {};
    if (over.capital) { w.push('el capital de una cartera en paralelo debe ser el mismo que el de la principal para comparar: se ignora «capital»'); delete over.capital; }
    const v = validate(deepMerge(readMainRaw(), over));
    for (const x of v.warnings) w.push(x);
    lanes.push({ id, name: String(c.nombre ?? id).slice(0, 40), description: String(c.descripcion ?? '').slice(0, 200), overrides: over, warnings: w });
    for (const x of w) warnings.push(`Cartera «${id}»: ${x}`);
  }
  return { lanes, warnings };
}
function readMainRaw() { try { return JSON.parse(fs.readFileSync(process.env.MANDATE_FILE || path.join(__dirname, 'mandato.json'), 'utf8')); } catch { return {}; } }

// Valores que tienen las demás carteras (posiciones y órdenes pendientes), para mantener sus precios al día
let configCache = null;
const config = () => (configCache ??= loadLaneConfig());
function peekWatched() {
  const out = [];
  for (const l of config().lanes) {
    try {
      const s = JSON.parse(fs.readFileSync(laneFile(l.id), 'utf8'));
      out.push(...Object.keys(s.positions ?? {}), ...(s.pending ?? []).map((o) => o.symbol));
    } catch { /* aún no existe */ }
  }
  return out;
}
setExtraWatched(peekWatched);

// ---- informe de la cartera activa ----
function thin(arr, n) { const step = Math.max(1, Math.ceil(arr.length / n)); return arr.filter((_, i) => i % step === 0 || i === arr.length - 1); }
export function bookReport({ id, name, description = '', overrides = {} }) {
  const s = getSummary(), perf = performanceReport(), jr = journalReport();
  const risk = getRisk();
  return {
    id, name, description,
    mandate: { name: M.nombre, version: M.version, hash: mandateInfo().hash, diff: id === 'principal' ? [] : diffFromMain(overrides) },
    since: getStartTime(), equity: s.equity, cash: s.cash, invested: s.invested, totalReturnPct: s.totalReturnPct,
    positions: s.positions.map((p) => ({ symbol: p.symbol, name: p.name, sector: p.sector, shares: p.shares, value: p.value, pnl: p.pnl, pnlPct: p.pnlPct, weightPct: p.weightPct })),
    perf: { curve: perf.curve, trades: perf.trades, byMarket: perf.byMarket, notes: perf.notes },
    insights: { n: jr.insights.n, findings: jr.insights.findings },
    orders: getOrders().slice(0, 12).map((o) => ({ t: o.t, side: o.side, symbol: o.symbol, shares: o.shares, price: o.price, reason: String(o.reason).slice(0, 160) })),
    pending: getPending().length, cashPct: risk.cashPct, costs: risk.costs,
    daily: thin(getDailyEquity(), 400).map((p) => ({ d: p.d, equity: p.equity, spy: p.spy })),
    lastDecision: getAgentLog()[0]?.summary ? String(getAgentLog()[0].summary).slice(0, 300) : null,
  };
}

// ---- ejecución de un ciclo ----
// opciones: { trade: bool, logEveryMs, log }
export async function runLanes({ trade = false, logEveryMs = 3600e3, log = () => {} } = {}) {
  configCache = null;
  const cfg = config();
  const reports = [], warnings = [...cfg.warnings];
  // cartera principal primero (estado y mandato ya activos)
  reports.push(bookReport({ id: 'principal', name: M.nombre === 'Mandato base' ? 'Principal' : `Principal · ${M.nombre}` }));
  try {
    for (const lane of cfg.lanes) {
      try {
        useLaneMandate(lane.overrides, lane.name);
        useBook(lane.id, laneFile(lane.id));
        rebuildFromOrders();
        const { applied } = await checkCorporateEvents();
        for (const e of applied) log(`[${lane.id}] ${e.type === 'split' ? 'Split' : 'Dividendo'} ${e.symbol}: ${e.text}`);
        if (trade) {
          const before = getOrders().length;
          checkPending();
          snapshot();
          let summary = '';
          if (agentEnabled()) summary = await autonomousReview();
          const traded = getOrders().length - before;
          const last = getAgentLog()[0]?.t ?? 0;
          if (traded > 0 || Date.now() - last > logEveryMs) addAgentLog({ t: Date.now(), summary });
          log(`[${lane.id}] ${traded ? traded + ' operación(es)' : 'sin operaciones'}`);
        }
        flushState();
        reports.push(bookReport(lane));
      } catch (e) { warnings.push(`Cartera «${lane.id}»: error en el ciclo (${e.message})`); console.error(`Cartera ${lane.id}:`, e); }
    }
  } finally {
    useBook('principal', MAIN_STATE_FILE);
    useMainMandate();
  }
  return { updatedAt: Date.now(), lanes: reports, warnings, maxLanes: MAX_LANES };
}

export function exportLanes(result, siteDir) {
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'carteras.json'), JSON.stringify(result));
}
