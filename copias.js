// Copias de seguridad del estado de la cartera.
//   node copias.js copiar   <carpeta estado> <carpeta copias>          → copia diaria (y semanal los lunes)
//   node copias.js restaurar <carpeta copias> <carpeta estado> [fecha]  → vuelve a una copia (por defecto, la última)
// Qué se guarda cada día: state.json (cartera, órdenes, diario, curva) y scorecard.json (marcador de aciertos, tarda semanas en rehacerse).
// Los lunes, además, fundamentals.json (se puede volver a descargar, pero tarda). Todo comprimido. Se conservan 30 días y 26 semanas.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const KEEP_DAILY = 30, KEEP_WEEKLY = 26;
const DAILY_FILES = ['state.json', 'scorecard.json'];
const WEEKLY_EXTRA = ['fundamentals.json'];
const TZ = 'Europe/Madrid';
export const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
const weekday = (key) => new Date(key + 'T12:00:00Z').getUTCDay(); // 1 = lunes

// Comprueba que el estado se puede leer y tiene la forma esperada. Devuelve un resumen o lanza un error.
export function validateState(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const s = JSON.parse(raw);
  if (typeof s.cash !== 'number' || !s.positions || typeof s.positions !== 'object' || !Array.isArray(s.orders)) throw new Error('state.json no tiene el formato esperado');
  const last = Array.isArray(s.dailyEquity) && s.dailyEquity.length ? s.dailyEquity[s.dailyEquity.length - 1] : null;
  const invested = Object.values(s.positions).reduce((a, p) => a + (p.shares ?? 0) * (p.avgCost ?? 0), 0);
  return {
    cash: +s.cash.toFixed(2), orders: s.orders.length, positions: Object.keys(s.positions).length,
    journal: Array.isArray(s.journal) ? s.journal.length : 0, equity: last?.equity ?? +(s.cash + invested).toFixed(2), bytes: raw.length,
  };
}

const gz = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, zlib.gzipSync(fs.readFileSync(src), { level: 9 })); return fs.statSync(dst).size; };
const gunzip = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, zlib.gunzipSync(fs.readFileSync(src))); };
const listDirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && fs.statSync(path.join(d, x)).isDirectory()).sort() : []);
const readIndex = (copias) => { try { return JSON.parse(fs.readFileSync(path.join(copias, 'indice.json'), 'utf8')); } catch { return { daily: [], weekly: [] }; } };

export function pruneOld(copias, keepDaily = KEEP_DAILY, keepWeekly = KEEP_WEEKLY) {
  let removed = 0;
  for (const [sub, keep] of [['diarias', keepDaily], ['semanales', keepWeekly]]) {
    const dirs = listDirs(path.join(copias, sub));
    for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) { fs.rmSync(path.join(copias, sub, d), { recursive: true, force: true }); removed++; }
  }
  return removed;
}

export function backup(estadoDir, copiasDir, now = Date.now()) {
  const data = path.join(estadoDir, 'data');
  const stateFile = path.join(data, 'state.json');
  if (!fs.existsSync(stateFile)) return { ok: false, skipped: true, message: 'Todavía no hay estado que copiar.' };
  const info = validateState(stateFile); // si el estado está roto, no se copia y el flujo falla (aviso en rojo)
  const day = dayKey(now), weekly = weekday(day) === 1;
  const prevIdx = readIndex(copiasDir);
  const prev = prevIdx.daily[prevIdx.daily.length - 1];
  const warnings = [];
  if (prev && prev.date !== day && info.orders < prev.orders) warnings.push(`Hay menos operaciones que en la copia del ${prev.date} (${info.orders} frente a ${prev.orders}): reinicio de cartera o posible pérdida de datos.`);
  const dir = path.join(copiasDir, 'diarias', day);
  let bytes = 0;
  for (const f of DAILY_FILES) { const src = path.join(data, f); if (fs.existsSync(src)) bytes += gz(src, path.join(dir, f + '.gz')); }
  if (weekly) {
    const wdir = path.join(copiasDir, 'semanales', day);
    for (const f of [...DAILY_FILES, ...WEEKLY_EXTRA]) { const src = path.join(data, f); if (fs.existsSync(src)) gz(src, path.join(wdir, f + '.gz')); }
  }
  const removed = pruneOld(copiasDir);
  // índice: qué copias hay y qué contenía cada una
  const entry = { date: day, t: now, ...info, copyBytes: bytes };
  const daily = [...prevIdx.daily.filter((e) => e.date !== day), entry].sort((a, b) => a.date.localeCompare(b.date));
  const have = new Set(listDirs(path.join(copiasDir, 'diarias')));
  const weeklyList = listDirs(path.join(copiasDir, 'semanales'));
  const index = { updatedAt: now, daily: daily.filter((e) => have.has(e.date)), weekly: weeklyList, warnings };
  fs.writeFileSync(path.join(copiasDir, 'indice.json'), JSON.stringify(index, null, 1));
  fs.writeFileSync(path.join(copiasDir, 'LEEME.md'), README_COPIAS);
  return { ok: true, day, weekly, removed, warnings, ...info, copyBytes: bytes };
}

// Restaura la copia de una fecha ('ultima' = la más reciente) sobre estado/data. Antes guarda lo que hay en copias/previas/.
export function restore(copiasDir, estadoDir, which = 'ultima', now = Date.now()) {
  const daily = listDirs(path.join(copiasDir, 'diarias')), weekly = listDirs(path.join(copiasDir, 'semanales'));
  let kind = 'diarias', date = which;
  if (!which || which === 'ultima') date = daily[daily.length - 1];
  if (!date) throw new Error('No hay copias diarias.');
  if (!daily.includes(date)) { if (weekly.includes(date)) kind = 'semanales'; else throw new Error(`No existe copia de ${date}. Diarias disponibles: ${daily.join(', ') || 'ninguna'}; semanales: ${weekly.join(', ') || 'ninguna'}.`); }
  const src = path.join(copiasDir, kind, date), data = path.join(estadoDir, 'data');
  if (!fs.existsSync(path.join(src, 'state.json.gz'))) throw new Error('La copia no contiene state.json.gz');
  // se comprueba la copia antes de tocar nada
  const tmp = path.join(copiasDir, '.tmp-restore.json');
  gunzip(path.join(src, 'state.json.gz'), tmp); const info = validateState(tmp); fs.rmSync(tmp);
  // guardar lo que hay ahora por si la restauración fue un error
  const prevDir = path.join(copiasDir, 'previas', dayKey(now) + '-' + new Date(now).toISOString().slice(11, 16).replace(':', ''));
  for (const f of [...DAILY_FILES]) { const cur = path.join(data, f); if (fs.existsSync(cur)) gz(cur, path.join(prevDir, f + '.gz')); }
  const prevs = fs.existsSync(path.join(copiasDir, 'previas')) ? fs.readdirSync(path.join(copiasDir, 'previas')).sort() : [];
  for (const d of prevs.slice(0, Math.max(0, prevs.length - 10))) fs.rmSync(path.join(copiasDir, 'previas', d), { recursive: true, force: true });
  const restored = [];
  for (const f of fs.readdirSync(src)) if (f.endsWith('.json.gz')) { gunzip(path.join(src, f), path.join(data, f.slice(0, -3))); restored.push(f.slice(0, -3)); }
  return { ok: true, kind, date, restored, ...info };
}

const README_COPIAS = `# Copias de seguridad del gestor de cartera

Se generan solas cada día (flujo «Copias de seguridad»). Esta rama no la lee la web.

- diarias/AAAA-MM-DD/: state.json.gz (cartera, órdenes, diario) y scorecard.json.gz (marcador de aciertos). Últimos 30 días.
- semanales/AAAA-MM-DD/: lo anterior más fundamentals.json.gz, de los lunes. Últimas 26 semanas.
- previas/: lo que había justo antes de cada restauración.
- indice.json: lista de copias con el patrimonio, operaciones y posiciones de cada una.

Para volver a una copia: Actions → «Restaurar copia» → Run workflow → escribe la fecha (o deja «ultima»).
`;

// ---- línea de comandos ----
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    if (cmd === 'copiar') {
      const r = backup(path.resolve(a), path.resolve(b));
      console.log(r.ok ? `Copia ${r.day}${r.weekly ? ' (+semanal)' : ''}: patrimonio ${r.equity} US$, ${r.orders} operaciones, ${r.positions} posiciones, ${(r.copyBytes / 1024).toFixed(0)} KB; ${r.removed} antiguas eliminadas` : r.message);
      for (const w of r.warnings ?? []) console.log('::warning::' + w);
    } else if (cmd === 'restaurar') {
      const r = restore(path.resolve(a), path.resolve(b), c);
      console.log(`Restaurada la copia ${r.kind === 'diarias' ? 'diaria' : 'semanal'} de ${r.date}: ${r.restored.join(', ')} · ${r.orders} operaciones, ${r.positions} posiciones, patrimonio ${r.equity} US$`);
    } else { console.error('Uso: node copias.js copiar <estado> <copias> | restaurar <copias> <estado> [fecha]'); process.exit(2); }
  } catch (e) { console.error('::error::' + e.message); process.exit(1); }
}
