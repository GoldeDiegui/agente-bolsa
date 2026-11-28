// Splits y dividendos de los valores en cartera (Yahoo Finance, gratis). Se revisan en cada ciclo.
import { getEventWatch, applyCorporateEvents } from './portfolio.js';

export async function fetchEvents(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d&events=div%2Csplit`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const ev = (await res.json())?.chart?.result?.[0]?.events ?? {};
  const out = [];
  for (const s of Object.values(ev.splits ?? {})) if (s.numerator > 0 && s.denominator > 0 && s.date) out.push({ type: 'split', t: s.date * 1000, num: s.numerator, den: s.denominator });
  for (const d of Object.values(ev.dividends ?? {})) if (d.amount > 0 && d.date) out.push({ type: 'dividend', t: d.date * 1000, amount: d.amount });
  return out;
}

// Varias carteras pueden tener el mismo valor: la consulta a Yahoo se reutiliza unos minutos
const evCache = new Map();
async function fetchEventsShared(symbol) {
  const hit = evCache.get(symbol);
  if (hit && Date.now() - hit.t < 5 * 60e3) return hit.v;
  const v = await fetchEvents(symbol);
  evCache.set(symbol, { t: Date.now(), v });
  return v;
}

// Revisa todas las posiciones. Si Yahoo falla para un valor, no se marca como revisado y se reintenta en el siguiente ciclo.
export async function checkCorporateEvents() {
  const applied = [];
  let failures = 0;
  for (const { symbol } of getEventWatch()) {
    const checkedTo = Date.now();
    try { applied.push(...applyCorporateEvents(symbol, await fetchEventsShared(symbol), checkedTo)); }
    catch { failures++; }
  }
  return { applied, failures };
}
