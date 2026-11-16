// Usado por el flujo de GitHub Actions: decide si merece la pena ejecutar un ciclo.
//   node gate.js trade   -> solo si hay algún mercado abierto
//   node gate.js datos   -> siempre
import fs from 'node:fs';
import { openMarkets } from './hours.js';

const mode = process.argv[2] || 'trade';
const open = openMarkets();
const go = mode !== 'trade' || open.length > 0 || process.env.FORCE_RUN === '1';
console.log(`Modo ${mode}. Mercados abiertos: ${open.join(', ') || 'ninguno'}. ${go ? 'Se ejecuta el ciclo.' : 'Se omite el ciclo.'}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\n`);
