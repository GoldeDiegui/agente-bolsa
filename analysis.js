// Motor de análisis: valoración relativa al sector, crecimiento, calidad, analistas, resultados y catalizadores.
// Es un modelo de reglas transparente (cada punto se explica); NO predice precios ni es asesoramiento financiero.
import { UNIVERSE, getQuote } from './market.js';
import { getFundamentals, getNews, getNextEarnings, fundamentalsStats } from './fundamentals.js';

const BY = new Map(UNIVERSE.map((u) => [u.symbol, u]));
const DAY = 86400e3;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fmt = (n, d = 1) => n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (n, d = 1) => (n > 0 ? '+' : '') + fmt(n, d);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

// interpolación lineal entre puntos [x, puntuación]
function lin(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
  }
  return pts[pts.length - 1][1];
}
const wavg = (parts) => {
  const w = parts.reduce((a, p) => a + p.w, 0);
  return w ? parts.reduce((a, p) => a + p.s * p.w, 0) / w : null;
};

// ---------- catalizadores en titulares (palabras clave) ----------
// [patrón, peso, etiqueta, ¿riesgo grave?]
const LEX = [
  [/\b(beats?|tops?|surpass(es|ed)?|exceeds?|crush(es|ed)?)\b.*\b(estimates?|expectations?|forecasts?|consensus)\b/, 2, 'resultados'],
  [/\b(raises?|lifts?|boosts?|hikes?)\b.*\b(guidance|outlook|forecast)\b/, 2.5, 'previsiones'],
  [/\b(upgrade[sd]?|upgrading)\b|\braised? to (buy|outperform|overweight)\b|\binitiat(es|ed) .* (buy|outperform|overweight)\b/, 2, 'analistas'],
  [/\b(raises?|lifts?|boosts?|hikes?)\b.*\bprice target\b/, 1.5, 'analistas'],
  [/\brecord (revenue|profit|earnings|sales|quarter|high|orders?)\b/, 1.5, 'resultados'],
  [/\b(wins?|awarded|secures?|lands?)\b.*\b(contract|deal|order)\b/, 1.5, 'contratos'],
  [/\bfda (approv|clear)|\bapproval\b.*\b(fda|ema)\b|\b(fda|ema)\b.*\bapprov/, 2, 'regulatorio'],
  [/\b(buyback|share repurchase|repurchase program)\b/, 1, 'capital'],
  [/\bdividend (hike|increase|raise)|\b(raises?|boosts?) (its |the )?dividend\b/, 1, 'capital'],
  [/\b(strong|robust|solid) (demand|sales|growth|results|quarter)\b/, 1, 'resultados'],
  [/\b(surges?|soars?|jumps?|rall(y|ies)|rockets?)\b/, 1, 'precio'],
  [/\b(acquires?|to acquire|takeover bid|buyout offer)\b/, 0.5, 'M&A'],
  [/\bsupera(n)?\b.*\b(previsiones|estimaciones|expectativas)\b|\beleva(n)?\b.*\b(previsi|objetivo|gu[ií]a|dividendo)/, 2, 'resultados'],
  [/\bbeneficios? (r[eé]cord|hist[oó]ric)|\bm[aá]ximos hist[oó]ricos\b|\bmejora (su )?(recomendaci|rating)/, 1.5, 'resultados'],
  [/\b(miss(es|ed)?|falls? short of|lags?)\b.*\b(estimates?|expectations?|forecasts?|consensus)\b/, -2.5, 'resultados'],
  [/\b(cuts?|lowers?|slashes?|trims?|reduces?)\b.*\b(guidance|outlook|forecast)\b/, -3, 'previsiones', true],
  [/\bprofit warning\b|\bwarns?\b.*\b(profit|earnings|revenue|sales|demand)\b/, -3, 'previsiones', true],
  [/\b(downgrade[sd]?|downgrading)\b|\bcut to (sell|underperform|underweight|neutral)\b/, -2, 'analistas'],
  [/\b(cuts?|lowers?|slashes?)\b.*\bprice target\b/, -1.5, 'analistas'],
  [/\b(lawsuit|sued|sues|probe|investigation|investigat(es|ed)|subpoena|antitrust|class action|sec charges?|doj)\b/, -2, 'legal', true],
  [/\b(fraud|accounting (irregularit|problem|scandal)|restate(s|d|ment)?|short[- ]seller report)\b/, -3, 'fraude', true],
  [/\b(bankruptcy|chapter 11|going concern|defaults?|defaulted)\b/, -4, 'solvencia', true],
  [/\b(recall|data breach|cyber ?attack|outage)\b/, -2, 'operativo'],
  [/\b(layoffs?|job cuts?|lays off|plant closure)\b/, -1, 'operativo'],
  [/\b(ceo|cfo|chairman)\b.*\b(resign|steps? down|exits?|departs?|ousted|fired)\b/, -1.5, 'directivos'],
  [/\b(plunges?|tumbles?|sinks?|slumps?|crash(es)?|tanks?)\b/, -1, 'precio'],
  [/\b(delays?|delayed|halts?|suspends?|pauses?)\b/, -1, 'operativo'],
  [/\b(tariffs?|sanctions?)\b/, -0.5, 'regulatorio'],
  [/\b(rebaja(n)?|recorta(n)?)\b.*\b(previsi|objetivo|gu[ií]a|recomendaci|dividendo)/, -2, 'previsiones'],
  [/\b(multa|sanci[oó]n|expediente|investigaci[oó]n|demanda|querella)\b/, -2, 'legal', true],
  [/\b(quiebra|concurso de acreedores|suspensi[oó]n de pagos|impago)\b/, -4, 'solvencia', true],
  [/\b(se hunde|se desploma|cae con fuerza|desploma)\b/, -1, 'precio'],
];

export function scoreHeadline(text) {
  const t = String(text).toLowerCase();
  const resolved = /\b(dismiss(es|ed)?|settle[sd]?|settles|clear(s|ed)|drops? (the )?(probe|case|lawsuit)|archiva|absuelt)/.test(t);
  let score = 0, red = false;
  const tags = new Set();
  for (const [re, w, tag, grave] of LEX) {
    if (!re.test(t)) continue;
    if (resolved && tag === 'legal') continue; // "se archiva la investigación" no es una mala noticia
    score += w; tags.add(tag);
    if (grave && w < 0) red = true;
  }
  return { score: clamp(score, -4, 4), tags: [...tags], red };
}

export function scoreNews(items) {
  const now = Date.now();
  let S = 0, pos = 0, neg = 0, redCount = 0;
  const scored = [];
  for (const it of items ?? []) {
    const age = (now - it.t) / DAY;
    if (!(age <= 7)) continue;
    const r = scoreHeadline(it.headline);
    S += Math.exp(-Math.max(age, 0) / 3) * r.score; // las noticias recientes pesan más
    if (r.score >= 1) pos++;
    if (r.score <= -1) neg++;
    if (r.red && age <= 5) redCount++;
    scored.push({ ...it, sentiment: r.score, tags: r.tags, red: r.red });
  }
  if (!scored.length) return null;
  return { score: 50 + 50 * Math.tanh(S / 3), pos, neg, red: redCount, items: scored };
}

// ---------- referencias por sector (medianas calculadas con los propios datos) ----------
let statsCache = { t: 0, groups: {} };
function sectorStats() {
  if (Date.now() - statsCache.t < 60e3) return statsCache.groups; // se recalcula cada minuto: al principio llegan datos nuevos sin parar
  const raw = {};
  const add = (key, m) => {
    const g = (raw[key] ??= { pe: [], ps: [], evEbitda: [] });
    if (m.pe > 0 && m.pe < 150) g.pe.push(m.pe);
    if (m.ps > 0 && m.ps < 60) g.ps.push(m.ps);
    if (m.evEbitda > 0 && m.evEbitda < 80) g.evEbitda.push(m.evEbitda);
  };
  for (const u of UNIVERSE) {
    const f = getFundamentals(u.symbol);
    if (!f) continue;
    add(`${u.market}|${u.sector}`, f.m);
    add(`*|${u.sector}`, f.m);
  }
  const groups = {};
  for (const [k, g] of Object.entries(raw)) {
    groups[k] = {};
    for (const metric of ['pe', 'ps', 'evEbitda']) groups[k][metric] = g[metric].length >= 4 ? { value: median(g[metric]), n: g[metric].length } : null;
  }
  statsCache = { t: Date.now(), groups };
  return groups;
}
function benchmark(u, metric) {
  const g = sectorStats();
  const own = g[`${u.market}|${u.sector}`]?.[metric];
  if (own) return { value: own.value, scope: `${u.sector.toLowerCase()} de ${u.market} (${own.n} empresas)` };
  const all = g[`*|${u.sector}`]?.[metric];
  return all ? { value: all.value, scope: `${u.sector.toLowerCase()} (${all.n} empresas)` } : null;
}

// ---------- componentes de la puntuación ----------
const REL = [[0.5, 96], [0.7, 85], [0.9, 68], [1.1, 52], [1.35, 35], [1.7, 18], [2.4, 6]];

function valuation(u, m) {
  const parts = [], reasons = [];
  const rel = (value, metric, label, w) => {
    const b = benchmark(u, metric);
    if (!b) { reasons.push({ type: 'info', text: `${label} ${fmt(value)} (sin referencia suficiente del sector)` }); return; }
    const r = value / b.value;
    parts.push({ s: lin(r, REL), w });
    reasons.push({ type: r <= 0.9 ? 'pos' : r >= 1.25 ? 'neg' : 'info', text: `${label} ${fmt(value)} frente a una mediana de ${fmt(b.value)} en ${b.scope}: ${sgn((r - 1) * 100, 0)} %`, short: `${label} ${fmt(value)} vs mediana ${fmt(b.value)} (${sgn((r - 1) * 100, 0)} %)` });
  };
  const lossMaking = m.pe != null && m.pe <= 0;
  if (m.pe > 0) rel(m.pe, 'pe', 'PER', 0.4);
  else if (lossMaking) reasons.push({ type: 'neg', text: 'La empresa no tiene beneficios (PER no aplicable)' });
  if (m.evEbitda > 0) rel(m.evEbitda, 'evEbitda', 'EV/EBITDA', 0.25);
  if (m.ps > 0 && (m.pe == null || lossMaking)) rel(m.ps, 'ps', 'Precio/ventas', 0.3);
  const g = m.epsGrowth3y ?? m.epsGrowth;
  const peg = m.peg > 0 ? m.peg : m.pe > 0 && g > 0 ? m.pe / g : null;
  if (peg != null) {
    parts.push({ s: lin(peg, [[0.5, 95], [1, 80], [1.5, 62], [2, 45], [3, 22], [4.5, 8]]), w: 0.35 });
    reasons.push({ type: peg <= 1.2 ? 'pos' : peg >= 2.2 ? 'neg' : 'info', text: `PEG ${fmt(peg, 2)} (por debajo de 1 suele considerarse barato; por encima de 2, caro)`, short: `PEG ${fmt(peg, 2)}` });
  } else if (m.pe > 0 && g != null && g <= 0) {
    parts.push({ s: 25, w: 0.3 });
    reasons.push({ type: 'neg', text: 'El beneficio no crece, así que el PER no está respaldado por crecimiento' });
  }
  return { score: wavg(parts), reasons };
}

function growth(m) {
  const blend = (a, b) => (a != null && b != null ? a * 0.65 + b * 0.35 : a ?? b);
  const rev = blend(m.revGrowth, m.revGrowth3y), eps = blend(m.epsGrowth, m.epsGrowth3y);
  const parts = [], reasons = [];
  if (rev != null) {
    parts.push({ s: lin(rev, [[-10, 5], [0, 25], [5, 45], [10, 62], [20, 82], [35, 96]]), w: 1 });
    reasons.push({ type: rev >= 10 ? 'pos' : rev < 0 ? 'neg' : 'info', text: `Ingresos creciendo ${sgn(rev)} % anual` });
  }
  if (eps != null) {
    parts.push({ s: lin(eps, [[-30, 5], [0, 28], [8, 50], [15, 68], [30, 86], [50, 96]]), w: 1 });
    reasons.push({ type: eps >= 12 ? 'pos' : eps < 0 ? 'neg' : 'info', text: `Beneficio por acción ${sgn(eps)} % anual` });
  }
  return { score: wavg(parts), reasons };
}

function quality(m, u) {
  const parts = [], reasons = [];
  const financial = u.sector === 'Finanzas' || u.sector === 'Inmobiliario'; // su deuda y liquidez no son comparables
  if (m.netMargin != null) {
    parts.push({ s: lin(m.netMargin, [[-5, 5], [0, 18], [5, 40], [10, 60], [20, 85], [30, 96]]), w: 1 });
    reasons.push({ type: m.netMargin >= 18 ? 'pos' : m.netMargin < 3 ? 'neg' : 'info', text: `Margen neto ${fmt(m.netMargin)} %` });
  }
  if (m.roe != null) {
    parts.push({ s: lin(m.roe, [[0, 15], [8, 42], [15, 66], [25, 90]]), w: 1 });
    reasons.push({ type: m.roe >= 18 ? 'pos' : m.roe < 5 ? 'neg' : 'info', text: `Rentabilidad sobre recursos propios (ROE) ${fmt(m.roe)} %` });
  }
  if (!financial && m.debtToEquity != null && m.debtToEquity >= 0) {
    parts.push({ s: lin(m.debtToEquity, [[0, 95], [0.5, 82], [1, 66], [2, 42], [3.5, 15]]), w: 0.8 });
    reasons.push({ type: m.debtToEquity <= 0.6 ? 'pos' : m.debtToEquity > 2 ? 'neg' : 'info', text: `Deuda/recursos propios ${fmt(m.debtToEquity, 2)}` });
  }
  if (!financial && m.currentRatio != null) {
    parts.push({ s: lin(m.currentRatio, [[0.5, 20], [1, 50], [1.5, 72], [2.5, 88]]), w: 0.5 });
    if (m.currentRatio < 0.9) reasons.push({ type: 'neg', text: `Liquidez ajustada (ratio corriente ${fmt(m.currentRatio, 2)})` });
  }
  return { score: wavg(parts), reasons };
}

function analystsScore(f, priceNative) {
  const an = f.analysts;
  if (!an) return { score: null, reasons: [] };
  const parts = [], reasons = [];
  if (an.score != null) {
    parts.push({ s: ((an.score + 2) / 4) * 100, w: 0.6 });
    const detail = an.buy != null ? `${an.buy} compra / ${an.hold} mantener / ${an.sell} venta` : an.recKey ? `recomendación media «${an.recKey}»` : 'consenso disponible';
    reasons.push({ type: an.score >= 1 ? 'pos' : an.score <= 0 ? 'neg' : 'info', text: `Analistas: ${detail}${an.total ? ` (${an.total} opiniones)` : ''}` });
  }
  if (an.targetMean && priceNative) {
    const up = (an.targetMean / priceNative - 1) * 100;
    parts.push({ s: lin(up, [[-15, 8], [0, 35], [10, 58], [20, 78], [35, 92]]), w: 0.4 });
    reasons.push({ type: up >= 15 ? 'pos' : up < 0 ? 'neg' : 'info', text: `Precio objetivo medio de los analistas ${fmt(an.targetMean, 2)} (${sgn(up, 0)} % sobre el precio actual)`, short: `objetivo de analistas ${sgn(up, 0)} %` });
  }
  return { score: wavg(parts), reasons };
}

function earningsScore(f) {
  const e = f.earnings;
  if (!e?.total) return { score: null, reasons: [] };
  const avg = e.surprises.reduce((a, b) => a + b, 0) / e.surprises.length;
  const s = (lin(avg, [[-10, 5], [-2, 30], [0, 50], [3, 70], [8, 90]]) + (e.beats / e.total) * 100) / 2;
  const ratio = e.beats / e.total;
  return { score: s, reasons: [{ type: ratio >= 0.75 && avg > 0 ? 'pos' : ratio <= 0.25 ? 'neg' : 'info', text: `Superó las estimaciones de beneficio en ${e.beats} de los últimos ${e.total} trimestres (sorpresa media ${sgn(avg)} %)`, short: `superó estimaciones en ${e.beats} de ${e.total} trimestres` }] };
}

// ---------- análisis completo ----------
const WEIGHTS = { valuation: 0.30, growth: 0.25, quality: 0.20, analysts: 0.10, earnings: 0.10, sentiment: 0.05 };
const memo = new Map();

export function analyze(symbol) {
  const u = BY.get(symbol);
  if (!u) return null;
  // se reutiliza el resultado solo si no han llegado datos nuevos (fundamentales o noticias) y es reciente
  const f = getFundamentals(symbol), n = getNews(symbol);
  const hit = memo.get(symbol);
  if (hit && hit.f === f && hit.n === n && Date.now() - hit.t < 60e3) return hit.a;
  const a = compute(u);
  memo.set(symbol, { t: Date.now(), a, f, n });
  return a;
}

function compute(u) {
  const q = getQuote(u.symbol);
  const f = getFundamentals(u.symbol);
  const base = { symbol: u.symbol, name: u.name, sector: u.sector, market: u.market, currency: u.currency, priceNative: q?.priceNative ?? null };
  if (!f) return { ...base, verdict: 'Sin datos', score: null, confidence: 0, scores: {}, reasons: [], catalysts: [], headlines: [], redFlags: 0, eventRisk: false, nextEarnings: null, dataAgeH: null, source: null };

  const m = f.m, reasons = [];
  const val = valuation(u, m), gro = growth(m), qua = quality(m, u), ana = analystsScore(f, q?.priceNative), ear = earningsScore(f);
  const news = scoreNews(getNews(u.symbol)?.items);
  const scores = { valuation: val.score, growth: gro.score, quality: qua.score, analysts: ana.score, earnings: ear.score, sentiment: news?.score ?? null };
  reasons.push(...val.reasons, ...gro.reasons, ...qua.reasons, ...ana.reasons, ...ear.reasons);

  if (m.high52 && q?.priceNative) {
    const off = (q.priceNative / m.high52 - 1) * 100;
    if (off <= -20) reasons.push({ type: 'info', text: `Cotiza un ${fmt(-off, 0)} % por debajo de su máximo de 52 semanas` });
  }

  const present = Object.entries(WEIGHTS).filter(([k]) => scores[k] != null);
  const wsum = present.reduce((s, [, w]) => s + w, 0);
  const confidence = wsum; // 0..1: qué parte del modelo tiene datos
  const score = wsum ? present.reduce((s, [k, w]) => s + scores[k] * w, 0) / wsum : null;

  const nextEarnings = getNextEarnings(u.symbol);
  const daysToEarnings = nextEarnings ? (nextEarnings - Date.now()) / DAY : null;
  const eventRisk = daysToEarnings != null && daysToEarnings >= -0.5 && daysToEarnings <= 3;

  const catalysts = [];
  if (nextEarnings && daysToEarnings != null && daysToEarnings <= 14 && daysToEarnings >= -0.5) {
    const d = new Date(nextEarnings).toLocaleDateString('es-ES');
    catalysts.push({ tag: 'resultados', text: `Presenta resultados el ${d}${daysToEarnings <= 3 ? ' (muy cerca: riesgo de movimiento brusco)' : ''}` });
    if (eventRisk) reasons.push({ type: 'neg', text: `Resultados trimestrales en ${Math.max(0, Math.round(daysToEarnings))} día(s): evento de riesgo, se evita abrir posición` });
  }
  const headlines = (news?.items ?? []).slice(0, 6);
  if (news) {
    if (news.pos || news.neg) reasons.push({ type: news.score >= 58 ? 'pos' : news.score <= 42 ? 'neg' : 'info', text: `Titulares de la última semana: ${news.pos} positivos y ${news.neg} negativos (lectura por palabras clave)` });
    for (const h of headlines) if (Math.abs(h.sentiment) >= 1.5) catalysts.push({ tag: h.tags[0] ?? 'noticia', text: `${h.sentiment > 0 ? '▲' : '▼'} ${h.headline}` });
    if (news.red) reasons.push({ type: 'neg', text: `${news.red} titular(es) con posible riesgo grave (legal, previsiones recortadas, solvencia…)` });
  }

  let verdict;
  if (confidence < 0.45 || (scores.valuation == null && scores.growth == null)) verdict = 'Sin datos suficientes';
  else if (score <= 38) verdict = 'Evitar';
  else if (scores.valuation != null && scores.valuation <= 30 && score < 75) verdict = 'Cara';
  else if (score >= 66 && (scores.valuation == null || scores.valuation >= 45)) verdict = 'Atractiva';
  else verdict = 'Neutral';
  if ((verdict === 'Atractiva' || verdict === 'Neutral') && news && news.red >= 1) verdict = 'Precaución';

  return {
    ...base, verdict, score: score == null ? null : Math.round(score), confidence: +confidence.toFixed(2),
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v == null ? null : Math.round(v)])),
    reasons, catalysts, headlines, redFlags: news?.red ?? 0, eventRisk, nextEarnings,
    dataAgeH: Math.round((Date.now() - f.fetchedAt) / 3600e3), source: f.source,
  };
}

export const brief = (symbol) => {
  const a = analyze(symbol);
  return a ? { verdict: a.verdict, score: a.score, valuation: a.scores.valuation ?? null, confidence: a.confidence } : null;
};

export function rank({ limit = 10, market, sector, verdicts = ['Atractiva'], minConfidence = 0.5, sortBy = 'score' } = {}) {
  const out = [];
  for (const u of UNIVERSE) {
    if (u.symbol === 'SPY' || (market && u.market !== market) || (sector && u.sector !== sector)) continue;
    const a = analyze(u.symbol);
    if (a && a.score != null && a.confidence >= minConfidence && verdicts.includes(a.verdict)) out.push(a);
  }
  out.sort(sortBy === 'valuation' ? (x, y) => (x.scores.valuation ?? 100) - (y.scores.valuation ?? 100) : (x, y) => y.score - x.score);
  return out.slice(0, limit);
}

// valores a los que conviene tener las noticias al día: los mejor puntuados
export function shortlist(n = 25) {
  return rank({ limit: n, verdicts: ['Atractiva', 'Neutral', 'Precaución'], minConfidence: 0.45 }).map((a) => a.symbol);
}

export const analysisCoverage = () => { const s = fundamentalsStats(); return { analyzed: s.analyzed, total: s.total }; };

const ICON = { pos: '＋', neg: '－', info: '·' };
export function analysisText(a) {
  if (!a) return 'No conozco ese valor.';
  const head = `${a.name} (${a.symbol}, ${a.market}, ${a.sector})`;
  if (a.score == null) return `${head}: todavía no tengo datos fundamentales de este valor. Se descargan poco a poco en segundo plano; prueba de nuevo en unos minutos.`;
  const s = a.scores, p = (k, n) => (s[k] == null ? null : `${n} ${s[k]}`);
  const lines = [
    `${head} — Veredicto: ${a.verdict.toUpperCase()} · puntuación ${a.score}/100 (cobertura de datos ${Math.round(a.confidence * 100)} %)`,
    [p('valuation', 'Valoración'), p('growth', 'Crecimiento'), p('quality', 'Calidad'), p('analysts', 'Analistas'), p('earnings', 'Resultados'), p('sentiment', 'Noticias')].filter(Boolean).join(' · '),
    ...a.reasons.slice(0, 9).map((r) => `${ICON[r.type]} ${r.text}`),
  ];
  if (a.catalysts.length) lines.push('Catalizadores:', ...a.catalysts.slice(0, 5).map((c) => `• [${c.tag}] ${c.text}`));
  if (a.verdict === 'Cara') lines.push('Lectura: sus múltiplos están por encima de lo que justifican su crecimiento y su sector; el gestor no abre posición y recorta si ya ha subido.');
  if (a.verdict === 'Atractiva') lines.push('Lectura: buen equilibrio entre precio, crecimiento y calidad; es candidata a compra si encaja en la diversificación.');
  if (a.verdict === 'Precaución') lines.push('Lectura: hay titulares con posible riesgo grave; el gestor no compra hasta que se aclare.');
  lines.push(`Datos de ${a.source} (hace ${a.dataAgeH ?? '?'} h). Es un modelo de reglas orientativo; no predice precios ni es asesoramiento financiero.`);
  return lines.join('\n');
}

const brevity = (r) => r.short ?? r.text;
export const thesisLine = (a, n = 3) => a.reasons.filter((r) => r.type === 'pos').slice(0, n).map(brevity).join('; ') || a.reasons.slice(0, 2).map(brevity).join('; ');
export const worstLine = (a, n = 2) => a.reasons.filter((r) => r.type === 'neg').slice(0, n).map(brevity).join('; ');
export const clearAnalysisCache = () => memo.clear();
