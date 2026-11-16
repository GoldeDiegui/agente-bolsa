// Horarios de mercado y condiciones para poder operar.
//  - S&P 500: Nueva York, 9:30-16:00 (hora de Nueva York), lunes a viernes.
//  - IBEX 35: Bolsa de Madrid, 9:00-17:30 (hora de Madrid), lunes a viernes.
// Los festivos no están en una lista: si en horario de mercado el precio no se ha movido hoy (o lleva
// más de 45 minutos sin actualizarse), se considera que no hay cotización y no se opera.
// ENFORCE_MARKET_HOURS=0 desactiva todas estas comprobaciones.
export const ENFORCE = process.env.ENFORCE_MARKET_HOURS !== '0';
const MAX_QUOTE_AGE_MS = 45 * 60 * 1000;

export const MARKETS = {
  'S&P 500': { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60, name: 'Nueva York', local: 'hora de Nueva York' },
  'IBEX 35': { tz: 'Europe/Madrid', open: 9 * 60, close: 17 * 60 + 30, name: 'Madrid', local: 'hora de Madrid' },
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmts = new Map();
function localParts(tz, now) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { wd: DAYS.indexOf(p.weekday), min: Number(p.hour) * 60 + Number(p.minute), sec: Number(p.second) };
}
const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

// Estado del mercado en un instante: { open, sessionStart } (sessionStart = apertura de la sesión de hoy, en ms)
export function marketClock(market, now = Date.now()) {
  const m = MARKETS[market];
  if (!m) return null;
  const { wd, min, sec } = localParts(m.tz, now);
  const open = wd >= 1 && wd <= 5 && min >= m.open && min < m.close;
  return { open, sessionStart: now - ((min - m.open) * 60 + sec) * 1000 - (now % 1000) };
}
export const isMarketOpen = (market, now = Date.now()) => marketClock(market, now)?.open ?? false;
export const openMarkets = (now = Date.now()) => Object.keys(MARKETS).filter((k) => isMarketOpen(k, now));
export const anyMarketOpen = (now = Date.now()) => openMarkets(now).length > 0;
export const scheduleText = (market) => { const m = MARKETS[market]; return `${m.name}: ${hhmm(m.open)}-${hhmm(m.close)} ${m.local}, de lunes a viernes`; };

// ¿Se puede operar ahora con este valor? q = cotización (de getQuote)
export function tradeStatus(q, now = Date.now()) {
  if (!ENFORCE) return { ok: true };
  const c = q ? marketClock(q.market, now) : null;
  if (!c) return { ok: false, reason: 'Mercado desconocido' };
  if (!c.open) return { ok: false, reason: `Mercado cerrado (${scheduleText(q.market)})` };
  if (q.source !== 'simulado' && q.marketTime != null) {
    if (q.marketTime < c.sessionStart - 60e3) return { ok: false, reason: 'Sin cotización hoy todavía (¿festivo o la sesión acaba de abrir?)' };
    if (now - q.marketTime > MAX_QUOTE_AGE_MS) return { ok: false, reason: 'El precio lleva más de 45 min sin actualizarse (¿suspendido o festivo?)' };
  }
  return { ok: true };
}
