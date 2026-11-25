// Agente gestor: usa la API de Claude con herramientas para consultar el mercado y operar la cartera virtual.
import { getAllQuotes, getQuote, getHistory } from './market.js';
import { placeOrder, getSummary, getRisk, getOrders, addLimitOrder, getPending, INITIAL_CASH } from './portfolio.js';
import { analyze, rank } from './analysis.js';
import { getNews } from './fundamentals.js';
import { ruleChat, autonomousReview as ruleReview } from './rules.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
// Modo gratuito por defecto (reglas). Solo si defines ANTHROPIC_API_KEY se carga el SDK y se usa Claude.
let client = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  } catch (e) {
    console.warn('No se pudo cargar @anthropic-ai/sdk; se usa el gestor por reglas:', e.message);
  }
}

const SYSTEM = `Eres un gestor de carteras con sólidos conocimientos de bolsa y mercados de valores. Gestionas una cartera VIRTUAL de simulación (dinero ficticio, ${INITIAL_CASH.toLocaleString('es-ES')} USD iniciales) y tienes autonomía para comprar y vender.

Principios:
- Puedes operar con el S&P 500 y el IBEX 35 (los valores del IBEX cotizan en EUR y la cartera los valora en USD).
- Decide con fundamento: antes de comprar un valor llama a analyze_stock (valoración frente al sector, crecimiento, calidad, analistas, resultados) y a get_news, y lee tú mismo los titulares para interpretar los catalizadores (resultados, previsiones, litigios, cambios de directivos...). La lectura automática por palabras clave del análisis es solo orientativa: contrástala con los titulares.
- Usa rank_opportunities para encontrar candidatos. No compres valores caros para su crecimiento ni justo antes de presentar resultados; explica la tesis, el riesgo principal y qué te haría cambiar de opinión.
- Si faltan datos de un valor, dilo y no inventes cifras.
- Antes de operar, consulta siempre la cartera, el riesgo y los precios con tus herramientas. No inventes datos.
- Diversifica por sectores, evita concentrar más del 30% en un valor y mantén algo de efectivo.
- Cada orden debe llevar un motivo breve y concreto en el parámetro "reason".
- Explica tu razonamiento en español de forma clara, y menciona riesgos y alternativas.
- Es una simulación educativa: no es asesoramiento financiero real, y no puedes garantizar rentabilidades.`;

const TOOLS = [
  {
    name: 'get_market_overview',
    description: 'Resumen del mercado: cuántos valores tienen precio, y los 15 que más suben y más bajan hoy (S&P 500 e IBEX 35).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_quotes',
    description: 'Cotización actual de hasta 20 valores concretos por símbolo (ej. AAPL, SAN.MC, BRK-B).',
    input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['symbols'] },
  },
  {
    name: 'screen_stocks',
    description: 'Busca valores filtrando por mercado ("S&P 500" o "IBEX 35") y/o sector (Tecnología, Salud, Finanzas, Consumo discrecional, Consumo defensivo, Comunicaciones, Industriales, Energía, Servicios públicos, Materiales, Inmobiliario). Ordenados por variación diaria.',
    input_schema: { type: 'object', properties: { market: { type: 'string' }, sector: { type: 'string' }, limit: { type: 'integer', maximum: 30 } } },
  },
  {
    name: 'get_price_history',
    description: 'Devuelve la serie reciente de precios de un valor (últimos puntos registrados) con su tendencia.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_portfolio',
    description: 'Estado actual de la cartera: efectivo, posiciones, patrimonio y rentabilidad.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_risk_metrics',
    description: 'Métricas de riesgo: drawdown, volatilidad, concentración, pesos por sector y comparación con el S&P 500.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_orders',
    description: 'Últimas órdenes ejecutadas en la cartera.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'analyze_stock',
    description: 'Análisis fundamental de un valor: veredicto (Atractiva, Neutral, Cara, Evitar, Precaución, Sin datos), puntuación 0-100, subpuntuaciones (valoración, crecimiento, calidad, analistas, resultados, noticias), motivos con cifras, catalizadores y próxima fecha de resultados.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_news',
    description: 'Titulares de la última semana de un valor (con fecha y fuente) para que interpretes los catalizadores tú mismo.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'rank_opportunities',
    description: 'Valores mejor puntuados por el análisis fundamental. Filtros opcionales: market ("S&P 500" o "IBEX 35"), sector, verdict ("Atractiva", "Neutral", "Cara"...).',
    input_schema: { type: 'object', properties: { market: { type: 'string' }, sector: { type: 'string' }, verdict: { type: 'string' }, limit: { type: 'integer', maximum: 20 } } },
  },
  {
    name: 'get_pending_orders',
    description: 'Órdenes límite pendientes (aún no ejecutadas).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'place_limit_order',
    description: 'Crea una orden límite: compra cuando el precio baje a "limit" o menos; venta cuando suba a "limit" o más. "limit" va en la moneda del valor (EUR para el IBEX, USD para el S&P 500). Caduca a los 30 días; no reserva efectivo.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        shares: { type: 'integer', minimum: 1 },
        limit: { type: 'number', description: 'Precio límite en la moneda del valor' },
        reason: { type: 'string' },
      },
      required: ['symbol', 'side', 'shares', 'limit', 'reason'],
    },
  },
  {
    name: 'place_order',
    description: 'Ejecuta una orden de mercado en la cartera virtual. Puede ser rechazada por falta de efectivo o por el límite de concentración.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        shares: { type: 'integer', minimum: 1 },
        reason: { type: 'string', description: 'Motivo breve de la operación' },
      },
      required: ['symbol', 'side', 'shares', 'reason'],
    },
  },
];

function runTool(name, input) {
  switch (name) {
    case 'get_market_overview': {
      const all = getAllQuotes();
      const live = all.filter((q) => q.price != null && q.symbol !== 'SPY').sort((a, b) => b.changePct - a.changePct);
      const slim = (q) => ({ symbol: q.symbol, name: q.name, sector: q.sector, market: q.market, priceUSD: q.price, changePct: q.changePct });
      return { withPrice: live.length, total: all.length - 1, topGainers: live.slice(0, 15).map(slim), topLosers: live.slice(-15).reverse().map(slim) };
    }
    case 'get_quotes': return (input.symbols ?? []).slice(0, 20).map((s) => getQuote(String(s).toUpperCase()) ?? { symbol: s, error: 'símbolo desconocido' });
    case 'screen_stocks': {
      const lim = Math.min(Number(input.limit) || 15, 30);
      return getAllQuotes()
        .filter((q) => q.price != null && q.symbol !== 'SPY' && (!input.market || q.market === input.market) && (!input.sector || q.sector === input.sector))
        .sort((a, b) => b.changePct - a.changePct).slice(0, lim)
        .map((q) => ({ symbol: q.symbol, name: q.name, sector: q.sector, market: q.market, priceUSD: q.price, changePct: q.changePct }));
    }
    case 'get_price_history': {
      const h = getHistory(String(input.symbol).toUpperCase());
      const pts = h.slice(-60).map((x) => x.p);
      const trend = pts.length > 1 ? +(((pts[pts.length - 1] / pts[0]) - 1) * 100).toFixed(3) : 0;
      return { symbol: input.symbol, points: pts, trendPct: trend, quote: getQuote(String(input.symbol).toUpperCase()) };
    }
    case 'get_portfolio': return getSummary();
    case 'get_risk_metrics': return getRisk();
    case 'get_recent_orders': return getOrders().slice(0, 15);
    case 'place_order': return placeOrder({ ...input, by: 'agente' });
    case 'analyze_stock': {
      const a = analyze(String(input.symbol).toUpperCase());
      if (!a) return { error: 'símbolo desconocido' };
      return { symbol: a.symbol, name: a.name, sector: a.sector, market: a.market, verdict: a.verdict, score: a.score, confidence: a.confidence, scores: a.scores,
        reasons: a.reasons.map((r) => `${r.type === 'pos' ? '+' : r.type === 'neg' ? '-' : '·'} ${r.text}`), catalysts: a.catalysts.map((c) => c.text),
        nextEarnings: a.nextEarnings ? new Date(a.nextEarnings).toISOString().slice(0, 10) : null, dataAgeHours: a.dataAgeH, source: a.source };
    }
    case 'get_news': {
      const items = getNews(String(input.symbol).toUpperCase())?.items ?? [];
      return items.slice(0, 10).map((x) => ({ date: new Date(x.t).toISOString().slice(0, 10), headline: x.headline, summary: x.summary, source: x.source }));
    }
    case 'rank_opportunities':
      return rank({ limit: Math.min(Number(input.limit) || 10, 20), market: input.market, sector: input.sector, verdicts: [input.verdict || 'Atractiva'] })
        .map((a) => ({ symbol: a.symbol, name: a.name, sector: a.sector, market: a.market, verdict: a.verdict, score: a.score, scores: a.scores, why: a.reasons.filter((r) => r.type === 'pos').slice(0, 3).map((r) => r.text) }));
    case 'get_pending_orders': return getPending();
    case 'place_limit_order': return addLimitOrder({ ...input, by: 'agente' });
    default: return { error: 'Herramienta desconocida' };
  }
}

// Bucle de herramientas: el modelo pide herramientas hasta dar una respuesta final.
async function runAgent(messages, onToolEvent) {
  if (!client) {
    return 'El agente no está activo: falta la variable de entorno ANTHROPIC_API_KEY. Arranca el servidor con tu clave para habilitarlo.';
  }
  const convo = [...messages];
  for (let i = 0; i < 10; i++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 2048, system: SYSTEM, tools: TOOLS, messages: convo });
    convo.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }
    const results = uses.map((u) => {
      const out = runTool(u.name, u.input);
      onToolEvent?.({ tool: u.name, input: u.input, result: out });
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
    });
    convo.push({ role: 'user', content: results });
  }
  return 'He alcanzado el límite de pasos de razonamiento en este turno.';
}

const chatHistory = [];

export async function chat(userText, onToolEvent, onReview) {
  if (!client) return ruleChat(userText, () => onToolEvent?.({ tool: 'place_order' }), onReview);
  chatHistory.push({ role: 'user', content: userText });
  const answer = await runAgent(chatHistory, onToolEvent);
  chatHistory.push({ role: 'assistant', content: answer });
  if (chatHistory.length > 30) chatHistory.splice(0, chatHistory.length - 30);
  return answer;
}

// Revisión autónoma periódica de la cartera (sin tocar el historial del chat).
export async function autonomousReview(onToolEvent) {
  if (!client) return ruleReview();
  const prompt = 'Revisión periódica autónoma: analiza el mercado, la cartera y el riesgo. Si ves oportunidades o desequilibrios, ejecuta las operaciones que consideres razonables (con motivo) y, si no, mantén. Termina con un resumen breve de 2-4 frases de lo que has decidido y por qué.';
  return runAgent([{ role: 'user', content: prompt }], onToolEvent);
}

export const agentEnabled = () => true; // siempre hay gestor: Claude si hay clave, reglas si no
export const agentMode = () => (client ? 'claude' : 'reglas');
