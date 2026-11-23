// Noticias: fuentes adicionales gratuitas (Google News RSS y comunicados 8-K de la SEC), eliminación de duplicados y peso por fuente.
// Las funciones de red devuelven listas de { t, headline, summary, source, url, ... }; mergeNews las une.
const UA = 'Mozilla/5.0';
const SEC_UA = process.env.SEC_USER_AGENT || 'AgenteBolsa/1.0 (proyecto educativo; github.com/GoldeDiegui/agente-bolsa)';

const decode = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };

async function getText(url, headers = {}, timeout = 10000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.text();
}

// ---------- Google News (RSS por empresa) ----------
const cleanName = (n) => n.replace(/\(.*?\)/g, ' ').replace(/\b(inc|corp|corporation|company|co|ltd|plc|holdings?|group|sa|s\.a\.)\b\.?/gi, ' ').replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
export function parseGoogleRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    let headline = decode(tag(it, 'title')), source = decode(tag(it, 'source'));
    if (source && headline.endsWith(' - ' + source)) headline = headline.slice(0, -(source.length + 3)); // "Titular - Reuters" -> "Titular"
    else if (!source) { const k = headline.lastIndexOf(' - '); if (k > 20) { source = headline.slice(k + 3); headline = headline.slice(0, k); } }
    const t = Date.parse(decode(tag(it, 'pubDate')));
    if (headline && Number.isFinite(t)) out.push({ t, headline, summary: '', source: source || 'Google News', url: decode(tag(it, 'link')), via: 'google' });
  }
  return out;
}
export async function fetchGoogleNews(u) {
  const es = u.market === 'IBEX 35';
  const q = encodeURIComponent(`"${cleanName(u.name)}" ${es ? 'bolsa' : 'stock'} when:7d`);
  const loc = es ? 'hl=es&gl=ES&ceid=ES:es' : 'hl=en-US&gl=US&ceid=US:en';
  return parseGoogleRss(await getText(`https://news.google.com/rss/search?q=${q}&${loc}`)).slice(0, 15);
}

// ---------- Comunicados 8-K de la SEC (hechos relevantes de empresas de EE. UU.) ----------
// código -> [texto en español, puntuación, etiqueta, ¿riesgo grave?]
export const SEC_ITEMS = {
  '1.01': ['firma un acuerdo material', 0.5, 'contratos'],
  '1.02': ['rescinde un acuerdo material', -1.5, 'contratos'],
  '1.03': ['quiebra o concurso de acreedores', -4, 'solvencia', true],
  '2.01': ['completa una adquisición o venta de activos', 0.5, 'M&A'],
  '2.02': ['publica resultados trimestrales', 0, 'resultados'],
  '2.04': ['hechos que aceleran obligaciones de deuda', -2.5, 'solvencia', true],
  '2.05': ['costes de reestructuración o cierres', -1, 'operativo'],
  '2.06': ['deterioro material de activos', -2.5, 'resultados', true],
  '3.01': ['aviso de exclusión de bolsa o incumplimiento de requisitos de cotización', -3.5, 'solvencia', true],
  '4.01': ['cambio de auditor', -1.5, 'fraude'],
  '4.02': ['las cuentas anteriores no son fiables y habrá que reformularlas', -4, 'fraude', true],
  '5.01': ['cambio de control', 0.5, 'M&A'],
  '5.02': ['salida o nombramiento de directivos', -0.5, 'directivos'],
  '5.07': ['resultados de votación de accionistas', 0, 'capital'],
  '7.01': ['información divulgada a inversores (Reg FD)', 0, 'resultados'],
  '8.01': ['otros hechos relevantes', 0, 'otros'],
};
export function parseSecAtom(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const e = m[1];
    const form = decode(tag(e, 'title')).split(/\s+-\s+/)[0];
    if (!/^8-K/i.test(form)) continue;
    const t = Date.parse(decode(tag(e, 'updated')));
    const text = decode(tag(e, 'content')) + ' ' + decode(tag(e, 'summary'));
    const codes = [...new Set([...text.matchAll(/Item\s+(\d\.\d{2})/gi)].map((x) => x[1]))].filter((c) => c !== '9.01'); // 9.01 = anexos
    const link = (e.match(/<link[^>]*href="([^"]+)"/i) ?? [])[1] ?? '';
    if (!Number.isFinite(t)) continue;
    const known = codes.filter((c) => SEC_ITEMS[c]);
    const worst = known.map((c) => SEC_ITEMS[c]).sort((a, b) => a[1] - b[1])[0];
    const best = known.map((c) => SEC_ITEMS[c]).sort((a, b) => b[1] - a[1])[0];
    const pick = worst && worst[1] < 0 ? worst : best;
    const desc = known.length ? known.map((c) => `${c}: ${SEC_ITEMS[c][0]}`).join('; ') : 'comunicado de hechos relevantes';
    out.push({
      t, headline: `SEC 8-K · ${desc}`, summary: '', source: 'SEC', url: link, via: 'sec', codes,
      override: pick ? { score: pick[1], tags: [pick[2]], red: Boolean(pick[3]) } : { score: 0, tags: ['otros'], red: false },
    });
  }
  return out;
}
export async function fetchSecFilings(symbol) {
  const sym = symbol.replace('.', '-');
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(sym)}&type=8-K&dateb=&owner=include&count=10&output=atom`;
  return parseSecAtom(await getText(url, { 'User-Agent': SEC_UA, Accept: 'application/atom+xml' })).filter((x) => Date.now() - x.t < 14 * 86400e3);
}

// ---------- Peso por fuente y eliminación de duplicados ----------
const HIGH = /reuters|bloomberg|wall street journal|\bwsj\b|financial times|\bft\.com|cnbc|barron|associated press|\bap news\b|\bsec\b|expansi[oó]n|cinco d[ií]as|europa press|efe\b|la vanguardia|el pa[ií]s|bbc|the economist/i;
const LOW = /motley fool|seeking alpha|zacks|insider monkey|tipranks|24\/7 wall|simply wall|investorplace|stocktwits|benzinga|gurufocus|marketbeat|msn\b|yahoo.*(sponsor)|the globe and mail.*(promo)|finbold|coincentral/i;
const CLICKBAIT = /\b(should you|is it (a )?(good|smart|wise)|reasons? (to|why)|best (stocks?|buys?)|top \d+|\d+ (stocks?|reasons|things)|here'?s why|what you need to know|prediction|could (soar|double|skyrocket)|buy now|better buy)\b/i;
export function sourceWeight(source, headline = '') {
  let w = HIGH.test(source ?? '') ? 1 : LOW.test(source ?? '') ? 0.5 : 0.8;
  if (CLICKBAIT.test(headline)) w *= 0.5;
  return +w.toFixed(2);
}

const STOP = new Set('the a an and or of to in on for with as at by from is are be its it this that after over amid says said stock stocks shares share inc corp company de la el los las y en del por con para un una su sus se que al'.split(' '));
const tokens = (h) => new Set(h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9% ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; }

// Une listas de noticias: quita las repetidas (mismo titular en varios medios), conserva la de mejor fuente y anota cuántos medios la cuentan.
export function mergeNews(...lists) {
  const all = lists.flat().filter((x) => x && x.headline && x.t).map((x) => ({ ...x, w: sourceWeight(x.source, x.headline) }));
  all.sort((a, b) => b.t - a.t);
  const kept = [];
  for (const it of all) {
    const tk = tokens(it.headline);
    const dup = kept.find((k) => Math.abs(k.t - it.t) < 3 * 86400e3 && (k.via === 'sec' || it.via === 'sec' ? false : jaccard(k._tk, tk) >= 0.6));
    if (dup) {
      dup.n += 1;
      if (it.w > dup.w) { Object.assign(dup, { headline: it.headline, source: it.source, url: it.url, w: it.w }); }
      continue;
    }
    kept.push({ ...it, n: 1, _tk: tk });
  }
  return kept.map(({ _tk, ...x }) => x);
}
