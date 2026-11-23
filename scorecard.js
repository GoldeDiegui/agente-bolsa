// Marcador de aciertos: ¿los veredictos del modelo predicen la rentabilidad futura?
// Cada semana se guarda una "cohorte" con el veredicto y la puntuación de cada valor (todos los Atractiva/Cara/Evitar/Precaución
// y una muestra fija de Neutral). Pasados 5, 20 y 60 días de bolsa se compara lo que hizo cada valor con su índice
// (S&P 500 con SPY; IBEX 35 con ^IBEX) y se resume: rentabilidad extra media por veredicto, % que supera al índice y
// correlación de rangos (Spearman) entre la puntuación y la rentabilidad extra, para el total y para cada componente.
// Es una prueba hacia adelante: los fundamentales del pasado no están disponibles gratis, así que no hay backtest histórico.
// Entrada: cierre ajustado (con dividendos) anterior al día de la cohorte. Los cierres son de Yahoo Finance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE } from './market.js';
import { analyze, analysisCoverage } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.SCORECARD_FILE
  || (process.env.DATA_FILE ? path.join(path.dirname(process.env.DATA_FILE), 'scorecard.json') : path.join(__dirname, 'data', 'scorecard.json'));
export const HORIZONS = [5, 20, 60];
const BENCH = { US: 'SPY', ES: '^IBEX' };
const MIN_COVERAGE = Number(process.env.MIN_COVERAGE ?? 0.35);
const MAX_COHORTS = 52;
const NEUTRAL_SAMPLE = 60;
const VERDICTS = ['Atractiva', 'Neutral', 'Precaución', 'Cara', 'Evitar'];
const COMPONENTS = ['valuation', 'growth', 'quality', 'analysts', 'earnings', 'revisions', 'momentum', 'insiders', 'shorts', 'sentiment'];
const DAY = 86400e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let data = { cohorts: [] };
function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(d.cohorts)) data = d; }
  catch { /* sin fichero todavía */ }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.warn('No se pudo guardar el marcador:', e.message); }
}
load();

const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
export function isoWeek(t) {
  const x = new Date(t), d = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // jueves de esa semana
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - first) / DAY - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
const hash = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 1000003; return h; };

function defaultRows(now) {
  const week = isoWeek(now), rows = [], neutral = [];
  for (const u of UNIVERSE) {
    if (u.symbol === 'SPY') continue;
    const a = analyze(u.symbol);
    if (!a || a.score == null || a.confidence < 0.5) continue;
    const row = { s: u.symbol, m: u.market === 'IBEX 35' ? 'ES' : 'US', v: a.verdict, sc: a.score, c: a.scores };
    (a.verdict === 'Neutral' ? neutral : rows).push(row);
  }
  neutral.sort((x, y) => hash(x.s + week) - hash(y.s + week));
  return rows.concat(neutral.slice(0, NEUTRAL_SAMPLE));
}

// Guarda la cohorte de la semana (una sola por semana ISO) si ya hay suficientes valores analizados.
export function maybeSnapshot({ now = Date.now(), rows } = {}) {
  const week = isoWeek(now);
  if (data.cohorts.some((c) => c.week === week)) return null;
  if (!rows) {
    const cov = analysisCoverage();
    if (cov.analyzed < cov.total * MIN_COVERAGE) return null;
    rows = defaultRows(now);
  }
  if (!rows.length) return null;
  const cohort = { week, date: dayStr(now), t: now, rows, bench: {} };
  data.cohorts.push(cohort);
  if (data.cohorts.length > MAX_COHORTS) data.cohorts.splice(0, data.cohorts.length - MAX_COHORTS);
  save();
  return cohort;
}

// ---------- cierres diarios ----------
export async function fetchCloses(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const px = r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close ?? [];
  return ts.map((t, i) => ({ d: dayStr(t * 1000), p: px[i] })).filter((x) => x.p > 0);
}

// Rentabilidad a h sesiones desde el último cierre anterior a la fecha de la cohorte (la última vela, si es de hoy, es parcial y se ignora)
export function forwardReturns(series, cohortDate, today) {
  const s = series.filter((x) => x.d < today);
  let i0 = -1;
  for (let i = 0; i < s.length; i++) { if (s[i].d < cohortDate) i0 = i; else break; }
  if (i0 < 0) return {};
  const out = {};
  for (const h of HORIZONS) if (s[i0 + h]) out[h] = s[i0 + h].p / s[i0].p - 1;
  return out;
}
const matured = (c, h, now) => now >= c.t + Math.ceil((h * 7) / 5 + 2) * DAY;

// Descarga cierres y completa los resultados que ya han madurado (con un tiempo máximo y ritmo de ~20 peticiones/min).
export async function evaluate({ now = Date.now(), budgetMs = 90000, closesFor = fetchCloses, pauseMs = 3000 } = {}) {
  const today = dayStr(now), deadline = Date.now() + budgetMs;
  const cache = new Map();
  let fetched = 0, resolved = 0;
  const getSeries = async (sym) => {
    if (cache.has(sym)) return cache.get(sym);
    if (Date.now() >= deadline) return undefined;
    if (fetched) await sleep(pauseMs);
    fetched++;
    let s = null;
    try { s = await closesFor(sym); } catch { /* se reintenta en otra pasada */ }
    cache.set(sym, s);
    return s;
  };

  // 1) índices de referencia
  for (const c of data.cohorts) {
    for (const m of ['US', 'ES']) {
      if (!c.rows.some((r) => r.m === m)) continue;
      c.bench ??= {};
      const pending = HORIZONS.filter((h) => c.bench[m]?.[h] === undefined && matured(c, h, now));
      if (!pending.length) continue;
      const s = await getSeries(BENCH[m]);
      if (!s) continue;
      const f = forwardReturns(s, c.date, today);
      c.bench[m] ??= {};
      for (const h of pending) if (f[h] !== undefined) { c.bench[m][h] = +f[h].toFixed(4); resolved++; }
    }
  }
  // 2) valores, de las cohortes más antiguas a las más nuevas
  const bySymbol = new Map();
  for (const c of data.cohorts) for (const row of c.rows) {
    if (HORIZONS.some((h) => row.r?.[h] === undefined && matured(c, h, now))) {
      if (!bySymbol.has(row.s)) bySymbol.set(row.s, []);
      bySymbol.get(row.s).push({ c, row });
    }
  }
  for (const [sym, list] of bySymbol) {
    const s = await getSeries(sym);
    if (s === undefined) break; // sin tiempo
    for (const { c, row } of list) {
      row.r ??= {};
      if (!s) { row.f = (row.f ?? 0) + 1; if (row.f >= 4) for (const h of HORIZONS) if (matured(c, h, now) && row.r[h] === undefined) row.r[h] = null; continue; }
      const f = forwardReturns(s, c.date, today);
      for (const h of HORIZONS) if (row.r[h] === undefined && matured(c, h, now)) { if (f[h] !== undefined) { row.r[h] = +f[h].toFixed(4); resolved++; } }
    }
  }
  if (resolved || fetched) save();
  return { fetched, resolved };
}

// ---------- estadísticas ----------
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
export const spearman = (x, y) => (x.length < 8 ? null : pearson(ranks(x), ranks(y)));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const r2 = (x) => (x == null ? null : +x.toFixed(2));

export function summary(now = Date.now()) {
  const cohorts = data.cohorts.map((c) => ({ week: c.week, date: c.date, n: c.rows.length }));
  const out = { updatedAt: now, cohorts, horizons: {}, minSample: 30 };
  for (const h of HORIZONS) {
    const obs = [];
    for (const c of data.cohorts) for (const row of c.rows) {
      const b = c.bench?.[row.m]?.[h];
      if (row.r?.[h] != null && b != null) obs.push({ v: row.v, sc: row.sc, c: row.c ?? {}, e: row.r[h] - b });
    }
    const groups = {};
    for (const v of VERDICTS) {
      const g = obs.filter((o) => o.v === v).map((o) => o.e);
      if (!g.length) continue;
      groups[v] = { n: g.length, mean: r2(mean(g) * 100), ci: g.length >= 5 ? r2((1.96 * sd(g) / Math.sqrt(g.length)) * 100) : null, hit: Math.round((g.filter((e) => e > 0).length / g.length) * 100) };
    }
    const ic = { score: r2(spearman(obs.map((o) => o.sc), obs.map((o) => o.e))) };
    for (const k of COMPONENTS) {
      const sub = obs.filter((o) => o.c[k] != null);
      ic[k] = r2(spearman(sub.map((o) => o.c[k]), sub.map((o) => o.e)));
    }
    out.horizons[h] = { n: obs.length, groups, ic };
  }
  const first = data.cohorts[0];
  out.status = !first ? 'Todavía no hay ninguna cohorte: se guarda la primera cuando el análisis cubra suficientes valores.'
    : `${cohorts.length} cohorte(s) desde ${first.date}. Primeros resultados a 5 sesiones ~${dayStr(first.t + Math.ceil((5 * 7) / 5 + 2) * DAY)}; a 20 sesiones ~${dayStr(first.t + Math.ceil((20 * 7) / 5 + 2) * DAY)}.`;
  return out;
}

export const _reset = () => { data = { cohorts: [] }; }; // solo para pruebas
