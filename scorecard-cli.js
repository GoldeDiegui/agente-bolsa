// Muestra el marcador de aciertos en la consola:  npm.cmd run marcador
import { summary, evaluate } from './scorecard.js';
if (process.argv.includes('--evaluar')) console.log('Evaluando…', await evaluate({ budgetMs: 120000 }));
const s = summary();
console.log(s.status);
for (const [h, d] of Object.entries(s.horizons)) {
  console.log(`\n== A ${h} sesiones (n=${d.n})`);
  for (const [v, g] of Object.entries(d.groups)) console.log(`  ${v.padEnd(11)} n=${String(g.n).padEnd(4)} extra medio ${String(g.mean).padStart(6)} % ${g.ci != null ? '(±' + g.ci + ')' : ''}  supera al índice: ${g.hit} %`);
  console.log('  Correlación puntuación↔rentabilidad extra:', JSON.stringify(d.ic));
}
