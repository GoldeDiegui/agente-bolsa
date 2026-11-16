// Comprueba desde TU ordenador que los datos fundamentales y las noticias llegan bien.
// Uso:  npm.cmd run diagnostico            (valores por defecto)
//       npm.cmd run diagnostico -- AAPL SAN.MC TSLA
import { diagnose, providerFor, hasFinnhub } from './fundamentals.js';

const symbols = process.argv.slice(2).map((s) => s.toUpperCase());
if (!symbols.length) symbols.push('AAPL', 'MSFT', 'SAN.MC', 'ITX.MC');

console.log(`Proveedor S&P 500: ${hasFinnhub() ? 'Finnhub (clave detectada)' : 'Yahoo (sin clave de Finnhub)'} · IBEX 35: Yahoo\n`);
let bad = 0;
for (const s of symbols) {
  const d = await diagnose(s);
  const f = d.fundamentals;
  const m = f?.m ?? f ?? {};
  const keys = Object.entries(m).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  console.log(`== ${s} (${providerFor(s)})`);
  if (d.fundamentalsError) { bad++; console.log(`   ✗ fundamentales: ${d.fundamentalsError}`); }
  else console.log(`   ${keys.length >= 5 ? '✓' : '✗'} fundamentales: ${keys.length} métricas con valor` + (keys.length ? ` (${keys.slice(0, 6).map(([k, v]) => `${k}=${+v.toFixed(2)}`).join(', ')})` : ''));
  if (keys.length < 5) bad++;
  if (d.newsError) console.log(`   ✗ noticias: ${d.newsError}`);
  else console.log(`   ${d.news?.length ? '✓' : '·'} noticias: ${d.news?.length ?? 0}` + (d.news?.[0] ? ` — "${d.news[0].headline}"` : ''));
}
console.log(bad ? `\nHay ${bad} problema(s). Copia este resultado y envíamelo para corregirlo.` : '\nTodo correcto: el agente podrá analizar estos valores.');
process.exit(0);
