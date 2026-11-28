// Mandato de la cartera: todos los parámetros que gobiernan al gestor, en un único fichero editable (mandato.json).
// - Cada parámetro tiene valor por defecto, rango válido y descripción (SCHEMA). Un valor fuera de rango o mal escrito se ignora
//   (se usa el de por defecto) y se avisa; una clave desconocida (típica errata) también se avisa. Nunca rompe el ciclo.
// - Ruta del fichero: variable MANDATE_FILE, o mandato.json junto al código.
// - Los módulos leen `M` en el momento de usarlo (no al importar), así que un cambio de mandato se nota en el siguiente ciclo.
//   `node mandato.js` valida el fichero y muestra lo que cambia respecto a los valores por defecto.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MANDATE_FILE = process.env.MANDATE_FILE || path.join(__dirname, 'mandato.json');
export const MARKET_NAMES = ['S&P 500', 'IBEX 35'];

// [ruta, valor por defecto, mínimo, máximo, descripción]; tipo según el valor por defecto
const N = (path, def, min, max, desc) => ({ path, def, min, max, desc, type: 'number' });
const S = (path, def, desc) => ({ path, def, desc, type: 'string' });
const L = (path, def, desc, allowed) => ({ path, def, desc, type: 'list', allowed });
const B = (path, def, desc) => ({ path, def, desc, type: 'bool' });

export const SCHEMA = [
  S('nombre', 'Mandato base', 'Nombre del mandato (aparece en la web y en el diario)'),
  N('version', 1, 1, 9999, 'Número de versión; súbelo cuando cambies parámetros para distinguir resultados'),
  // capital
  N('capital.initialCash', 100000, 1000, 1e9, 'Capital inicial en US$. Solo se aplica al crear o reiniciar la cartera'),
  // universo
  L('universo.markets', MARKET_NAMES, 'Mercados en los que puede comprar', MARKET_NAMES),
  L('universo.excludedSymbols', [], 'Símbolos que nunca compra (y vende si los tiene), p. ej. ["TSLA"]'),
  L('universo.excludedSectors', [], 'Sectores que nunca compra (y vende si los tiene), p. ej. ["Energía"]'),
  // riesgo
  N('riesgo.maxPositionPct', 30, 5, 100, 'Límite duro: máximo % del patrimonio en un valor (rechaza la orden)'),
  N('riesgo.overweightPct', 25, 5, 100, 'Recorta un valor si pesa más de este %'),
  N('riesgo.targetWeightPct', 20, 1, 100, '...hasta dejarlo en este %'),
  N('riesgo.maxPositions', 0, 0, 100, 'Número máximo de posiciones abiertas (0 = sin límite)'),
  N('riesgo.sectorMaxPct', 100, 10, 100, 'Máximo % de la cartera en un sector al comprar (100 = sin límite)'),
  N('riesgo.baseStopPct', 8, 1, 50, 'Stop-loss estándar si aún no hay datos de volatilidad'),
  N('riesgo.stopAtrMult', 3.5, 0.5, 10, 'Stop-loss = este múltiplo de la volatilidad diaria (ATR 14)'),
  N('riesgo.stopMinPct', 6, 1, 50, '...con suelo de este %'),
  N('riesgo.stopMaxPct', 15, 2, 60, '...y techo de este %'),
  N('riesgo.takeProfitMinPct', 15, 3, 200, 'Toma de beneficios mínima (% de ganancia)'),
  N('riesgo.takeProfitRiskMultiple', 2, 0.5, 10, 'Objetivo de beneficios = este múltiplo del stop (si supera el mínimo)'),
  N('riesgo.takeProfitSellPct', 50, 10, 100, '% de la posición que vende al alcanzar el objetivo'),
  N('riesgo.targetAtrPct', 2.5, 0.5, 10, 'Volatilidad diaria (ATR %) que recibe el tamaño de compra normal'),
  N('riesgo.sizeMin', 0.5, 0.1, 1, 'Factor mínimo de tamaño para valores muy volátiles'),
  N('riesgo.sizeMax', 1.2, 1, 3, 'Factor máximo de tamaño para valores muy tranquilos'),
  // efectivo
  N('efectivo.floorPct', 15, 0, 90, 'Colchón mínimo de efectivo (% del patrimonio) en condiciones normales'),
  N('efectivo.floorCautionPct', 20, 0, 90, 'Colchón con el S&P 500 en cautela'),
  N('efectivo.floorBearPct', 25, 0, 90, 'Colchón con el S&P 500 en mercado bajista'),
  N('efectivo.floorStressElevatedPct', 20, 0, 90, 'Colchón con tensión elevada (VIX)'),
  N('efectivo.floorStressHighPct', 25, 0, 90, 'Colchón con tensión alta (VIX)'),
  // mercado
  N('mercado.vixElevated', 25, 10, 80, 'VIX a partir del cual la tensión es «elevada»'),
  N('mercado.vixHigh', 30, 10, 100, 'VIX a partir del cual la tensión es «alta»'),
  N('mercado.cautionSizeMult', 0.75, 0.1, 1, 'Tamaño de compra en cautela (× lo normal)'),
  N('mercado.bearSizeMult', 0.5, 0.1, 1, 'Tamaño de compra en mercado bajista'),
  N('mercado.stressElevatedSizeMult', 0.75, 0.1, 1, 'Tamaño de compra con tensión elevada'),
  N('mercado.stressHighSizeMult', 0.6, 0.1, 1, 'Tamaño de compra con tensión alta'),
  N('mercado.bearMinScore', 80, 50, 100, 'En mercado bajista solo compra con puntuación ≥ este valor'),
  // compras
  N('compras.entryPct', 8, 0.5, 50, 'Compra «base» = este % del patrimonio (varía según convicción)'),
  N('compras.convictionFloorScore', 66, 30, 95, 'Puntuación con la que la convicción es mínima (tamaño 0,6×)'),
  N('compras.convictionSpan', 24, 5, 60, 'Puntos por encima del suelo hasta convicción máxima (tamaño 1,4×)'),
  N('compras.maxPerReview', 3, 1, 20, 'Compras máximas por revisión'),
  N('compras.minConfidence', 0.5, 0.1, 1, 'El análisis debe cubrir al menos esta fracción del modelo'),
  N('compras.minHoldHours', 24, 0, 720, 'No vende por tesis en las primeras horas tras comprar'),
  N('compras.maxDayRisePct', 10, 1, 50, 'No persigue valores que ya suben más de este % hoy'),
  N('compras.maxDayFallPct', 5, 1, 50, 'No compra valores que caen más de este % hoy'),
  N('compras.maxExistingWeightPct', 15, 1, 100, 'No añade a un valor que ya pesa más de este %'),
  // veredictos
  N('veredictos.attractiveMin', 66, 40, 95, 'Puntuación mínima para «Atractiva»'),
  N('veredictos.attractiveMinValuation', 45, 0, 100, '...y valoración mínima (si hay dato)'),
  N('veredictos.avoidMax', 38, 0, 60, 'Puntuación máxima para «Evitar»'),
  N('veredictos.expensiveValuationMax', 30, 0, 60, 'Valoración máxima para «Cara»'),
  N('veredictos.expensiveMaxScore', 75, 40, 100, '«Cara» solo si la puntuación total es menor que esto'),
  // ventas por tesis
  N('ventas.expensiveGainPct', 10, 0, 200, 'Vende la mitad de una «Cara» si ya gana más de este %'),
  N('ventas.redFlagsToReduce', 2, 1, 10, 'Reduce si hay tantos titulares de riesgo grave'),
  // rotación
  N('rotacion.gap', 12, 3, 60, 'Ventaja mínima de puntos de la candidata para rotar'),
  N('rotacion.minHoldDays', 3, 0, 60, 'Una posición comprada por rotación no rota en estos días'),
  N('rotacion.maxPerDay', 2, 0, 20, 'Rotaciones máximas en 24 h (0 = desactivada)'),
  N('rotacion.sectorMaxPct', 35, 10, 100, 'La rotación no deja un sector por encima de este %'),
  // análisis
  N('analisis.minCoverage', 0.35, 0, 1, 'Fracción del universo analizada antes de comprar o vender por tesis'),
  B('analisis.allowMomentumOnly', false, 'Sin datos fundamentales, permite comprar solo por tendencia'),
  // pesos del modelo de puntuación (se normalizan para sumar 100 %)
  ...Object.entries({ valuation: 27, growth: 22, quality: 18, analysts: 8, earnings: 8, revisions: 12, sentiment: 5, momentum: 12, insiders: 6, shorts: 4 })
    .map(([k, v]) => N(`pesos.${k}`, v, 0, 100, `Peso de «${k}» en la puntuación total`)),
  // costes de operar
  S('costes.modelo', 'realista', '«realista» (spread, comisiones, divisa, impuestos) o «simple» (1 US$ por orden)'),
  N('costes.usPerShare', 0.005, 0, 1, 'EE. UU.: comisión por acción (US$)'),
  N('costes.usMin', 1, 0, 100, 'EE. UU.: comisión mínima por orden (US$)'),
  N('costes.usMaxPct', 1, 0, 10, 'EE. UU.: comisión máxima (% del importe)'),
  N('costes.esPct', 0.10, 0, 5, 'España: comisión (% del importe)'),
  N('costes.esMin', 2, 0, 100, 'España: comisión mínima (US$ equivalentes)'),
  N('costes.fxBps', 15, 0, 500, 'Cambio EUR↔USD en operaciones del IBEX (puntos básicos)'),
  N('costes.itfEsPct', 0.2, 0, 5, 'Impuesto sobre transacciones financieras en compras españolas (%)'),
  N('costes.maxParticipationPct', 5, 0.1, 100, 'Una orden no puede superar este % del volumen diario'),
  N('costes.impactK', 0.5, 0, 5, 'Impacto de mercado: k × volatilidad × √participación'),
  N('costes.slipCapBps', 100, 0, 2000, 'Techo del deslizamiento (puntos básicos)'),
  N('costes.divTaxUS', 15, 0, 50, 'Retención sobre dividendos de EE. UU. (%)'),
  N('costes.divTaxES', 19, 0, 50, 'Retención sobre dividendos españoles (%)'),
];

// ---- utilidades ----
const getIn = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setIn = (o, p, v) => { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = (a[k] ??= {}); a[ks[ks.length - 1]] = v; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const defaults = () => { const o = {}; for (const s of SCHEMA) setIn(o, s.path, Array.isArray(s.def) ? [...s.def] : s.def); return o; };

// Valida un objeto leído del fichero. Devuelve { values, warnings, changed }.
export function validate(raw) {
  const warnings = [], values = defaults(), changed = [];
  const known = new Set(SCHEMA.map((s) => s.path));
  const sections = new Set(SCHEMA.map((s) => s.path.split('.')[0]));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { values, warnings: ['mandato.json no es un objeto: se usan los valores por defecto'], changed };
  // claves desconocidas (se ignoran las que empiezan por «_», pensadas para comentarios)
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      if (known.has(p)) continue;
      if (!prefix && sections.has(k) && v && typeof v === 'object' && !Array.isArray(v)) { walk(v, k); continue; }
      warnings.push(`Clave desconocida «${p}»: se ignora (¿errata?)`);
    }
  };
  walk(raw, '');
  for (const s of SCHEMA) {
    const v = getIn(raw, s.path);
    if (v === undefined) continue;
    let ok = false, val = v;
    if (s.type === 'number') { ok = typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max; if (!ok) warnings.push(`«${s.path}» = ${JSON.stringify(v)} no es válido (debe ser un número entre ${s.min} y ${s.max}): se usa ${s.def}`); }
    else if (s.type === 'string') { ok = typeof v === 'string' && v.trim().length > 0 && v.length <= 80; if (s.path === 'costes.modelo' && ok && !['realista', 'simple'].includes(v)) ok = false; if (!ok) warnings.push(`«${s.path}» = ${JSON.stringify(v)} no es válido: se usa «${s.def}»`); }
    else if (s.type === 'bool') { ok = typeof v === 'boolean'; if (!ok) warnings.push(`«${s.path}» debe ser true o false: se usa ${s.def}`); }
    else if (s.type === 'list') {
      ok = Array.isArray(v) && v.every((x) => typeof x === 'string');
      if (ok && s.allowed) { const bad = v.filter((x) => !s.allowed.includes(x)); if (bad.length) { warnings.push(`«${s.path}»: valores no válidos ${JSON.stringify(bad)} (permitidos: ${s.allowed.join(', ')}); se ignoran`); val = v.filter((x) => s.allowed.includes(x)); } }
      if (ok && s.path === 'universo.markets' && val.length === 0) { ok = false; warnings.push('«universo.markets» no puede estar vacío: se usan todos los mercados'); }
      if (ok && s.path === 'universo.excludedSymbols') val = [...new Set(val.map((x) => x.trim().toUpperCase()).filter(Boolean))];
      if (!ok && !warnings.some((w) => w.includes(s.path))) warnings.push(`«${s.path}» debe ser una lista de textos: se usa el valor por defecto`);
    }
    if (ok) { setIn(values, s.path, val); if (!same(val, s.def)) changed.push(s.path); }
  }
  // coherencia entre parámetros
  const chk = (cond, msg, fix) => { if (!cond) { warnings.push(msg); fix(); } };
  const R = values.riesgo;
  chk(R.stopMinPct <= R.stopMaxPct, 'riesgo.stopMinPct no puede superar stopMaxPct: se usan los valores por defecto de ambos', () => { R.stopMinPct = 6; R.stopMaxPct = 15; });
  chk(R.targetWeightPct <= R.overweightPct, 'riesgo.targetWeightPct no puede superar overweightPct: se usan los valores por defecto de ambos', () => { R.targetWeightPct = 20; R.overweightPct = 25; });
  chk(R.overweightPct <= R.maxPositionPct, 'riesgo.overweightPct no puede superar maxPositionPct: se usan los valores por defecto de ambos', () => { R.overweightPct = 25; R.maxPositionPct = 30; R.targetWeightPct = 20; });
  chk(R.sizeMin <= 1 && R.sizeMax >= 1, 'riesgo.sizeMin/sizeMax deben rodear a 1: se usan los valores por defecto', () => { R.sizeMin = 0.5; R.sizeMax = 1.2; });
  chk(values.mercado.vixElevated <= values.mercado.vixHigh, 'mercado.vixElevated no puede superar vixHigh: se usan los valores por defecto', () => { values.mercado.vixElevated = 25; values.mercado.vixHigh = 30; });
  chk(values.veredictos.avoidMax < values.veredictos.attractiveMin, 'veredictos.avoidMax debe ser menor que attractiveMin: se usan los valores por defecto', () => { values.veredictos.avoidMax = 38; values.veredictos.attractiveMin = 66; });
  chk(Object.values(values.pesos).some((w) => w > 0), 'pesos: al menos uno debe ser mayor que 0: se usan los valores por defecto', () => { Object.assign(values.pesos, defaults().pesos); });
  if (values.efectivo.floorPct > Math.min(values.efectivo.floorCautionPct, values.efectivo.floorBearPct) && values.efectivo.floorPct < 90) { /* el colchón efectivo es el máximo de todos: sin problema */ }
  return { values, warnings, changed };
}

// ---- carga ----
const state = { M: defaults(), info: { file: MANDATE_FILE, found: false, warnings: [], changed: [], hash: null, loadedAt: null }, rawMain: {} };
export const M = state.M; // objeto vivo: se rellena en sitio para que las importaciones lo vean

function apply(values, info) {
  for (const k of Object.keys(M)) delete M[k];
  Object.assign(M, values);
  state.info = info;
}
export function loadMandate(file = MANDATE_FILE) {
  let raw = null, found = false, warnings = [];
  try {
    if (fs.existsSync(file)) { found = true; raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  } catch (e) { warnings.push(`No se pudo leer ${path.basename(file)} (${e.message}): se usan los valores por defecto`); raw = null; }
  state.rawMain = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const v = validate(raw ?? {});
  const hash = crypto.createHash('sha1').update(JSON.stringify(v.values)).digest('hex').slice(0, 8);
  apply(v.values, { file, found, warnings: [...warnings, ...v.warnings], changed: v.changed, hash, loadedAt: Date.now() });
  return state.info;
}
// Mezcla en profundidad: lo de `over` pisa a `base` (las listas se sustituyen enteras)
export function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}
// Carteras en paralelo: el mandato de una cartera = mandato principal + sus cambios. Devuelve los avisos de esos cambios.
export function useLaneMandate(overrides = {}, label = null) {
  const v = validate(deepMerge(state.rawMain, overrides));
  const name = label ?? v.values.nombre;
  v.values.nombre = name;
  const hash = crypto.createHash('sha1').update(JSON.stringify(v.values)).digest('hex').slice(0, 8);
  apply(v.values, { file: null, found: true, warnings: v.warnings, changed: v.changed, hash, loadedAt: Date.now() });
  return state.info;
}
export function useMainMandate() { return useLaneMandate({}, null); }
export const mandateHash = () => state.info.hash;
// Parámetros de `overrides` que realmente cambian algo respecto al mandato principal
export function diffFromMain(overrides = {}) {
  const base = validate(state.rawMain).values, lane = validate(deepMerge(state.rawMain, overrides)).values;
  const rows = [];
  for (const s of SCHEMA) { const a = getIn(base, s.path), b = getIn(lane, s.path); if (!same(a, b)) rows.push({ path: s.path, main: a, value: b, desc: s.desc }); }
  return rows;
}
// Para pruebas: aplica un objeto ya preparado
export function setMandate(raw) {
  const v = validate(raw);
  apply(v.values, { file: null, found: true, warnings: v.warnings, changed: v.changed, hash: crypto.createHash('sha1').update(JSON.stringify(v.values)).digest('hex').slice(0, 8), loadedAt: Date.now() });
  return state.info;
}

export const weights = () => { const p = M.pesos, sum = Object.values(p).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / sum])); };

// Para la web: qué mandato está activo, qué se ha cambiado y qué avisos hay
export function mandateInfo() {
  const rows = SCHEMA.filter((s) => state.info.changed.includes(s.path)).map((s) => ({ path: s.path, value: getIn(M, s.path), default: s.def, desc: s.desc }));
  return { name: M.nombre, version: M.version, hash: state.info.hash, file: state.info.found, warnings: state.info.warnings, changed: rows, initialCash: M.capital.initialCash,
    summary: { stop: `${M.riesgo.stopAtrMult}× ATR (${M.riesgo.stopMinPct}–${M.riesgo.stopMaxPct} %)`, maxPositionPct: M.riesgo.maxPositionPct, cashFloorPct: M.efectivo.floorPct, entryPct: M.compras.entryPct, markets: M.universo.markets,
      excludedSymbols: M.universo.excludedSymbols, excludedSectors: M.universo.excludedSectors, maxPositions: M.riesgo.maxPositions, sectorMaxPct: M.riesgo.sectorMaxPct, costModel: M.costes.modelo } };
}
// ¿Puede comprarse este valor según el mandato? (mercado, símbolo y sector)
export function allowedByMandate(q) {
  if (!q) return { ok: false, why: 'sin datos' };
  if (!M.universo.markets.includes(q.market)) return { ok: false, why: `mercado ${q.market} fuera del mandato` };
  if (M.universo.excludedSymbols.includes(q.symbol)) return { ok: false, why: `${q.symbol} excluido por el mandato` };
  if (M.universo.excludedSectors.includes(q.sector)) return { ok: false, why: `sector ${q.sector} excluido por el mandato` };
  return { ok: true };
}

// Genera el contenido de un mandato.json completo con los valores por defecto (o los actuales)
export function template(values = defaults()) {
  const out = { _ayuda: 'Cambia solo los valores que quieras. Los que borres o dejes igual usan el valor por defecto. Las claves que empiezan por _ son comentarios. Valida con: node mandato.js' };
  const secs = [...new Set(SCHEMA.map((s) => s.path.split('.')[0]))];
  for (const sec of secs) {
    const items = SCHEMA.filter((s) => s.path.split('.')[0] === sec);
    if (items.length === 1 && !items[0].path.includes('.')) { out[sec] = getIn(values, sec); continue; }
    out[sec] = {};
    for (const s of items) out[sec][s.path.split('.')[1]] = getIn(values, s.path);
  }
  return out;
}

loadMandate();

// ---- línea de comandos ----
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2];
  if (cmd === 'plantilla') { console.log(JSON.stringify(template(), null, 2)); }
  else if (cmd === 'parametros') { for (const s of SCHEMA) console.log(`${s.path.padEnd(36)} ${String(JSON.stringify(s.def)).padEnd(26)} ${s.min != null ? `[${s.min}–${s.max}] ` : ''}${s.desc}`); }
  else {
    const i = state.info;
    console.log(`Mandato «${M.nombre}» v${M.version} (${i.hash}) · fichero ${i.found ? 'encontrado' : 'no encontrado (valores por defecto)'}: ${i.file}`);
    console.log(i.changed.length ? `Cambios respecto a los valores por defecto (${i.changed.length}):\n` + mandateInfo().changed.map((c) => `  ${c.path}: ${JSON.stringify(c.value)} (por defecto ${JSON.stringify(c.default)})`).join('\n') : 'Sin cambios respecto a los valores por defecto.');
    if (i.warnings.length) { console.log('\nAvisos:'); for (const w of i.warnings) console.log('  ⚠ ' + w); process.exitCode = 1; } else console.log('\nSin avisos: el mandato es válido.');
  }
}
