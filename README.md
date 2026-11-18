# Agente de Bolsa · cartera virtual en tiempo real

Gestor que opera una cartera simulada de 100.000 USD y la muestra en una web con datos en vivo. **Funciona gratis por defecto**, sin claves ni APIs de pago.

## Arranque (gratis)

```bash
npm install
npm start
# abre http://localhost:3000
```

En Windows PowerShell, si `npm` da error de scripts, usa `npm.cmd install` y `npm.cmd start`.

## Dos modos de gestor

- **Reglas (por defecto, gratis):** no necesita nada. Revisa la cartera cada 5 minutos (`REVIEW_MINUTES`), aplica stop-loss (-8 %), toma de beneficios (+15 %), recorte si un valor pesa más del 25 %, colchón mínimo de efectivo (15 %) y **decide compras y ventas con análisis fundamental** (ver abajo). El chat entiende frases como "revisa la cartera", "compra 10 AAPL", "riesgo", "precios", "oportunidades", "analiza apple", "¿está cara nvidia?", "por qué compraste X", "estado de los datos" y explica conceptos básicos de bolsa.
- **Claude (opcional, de pago):** si defines `ANTHROPIC_API_KEY`, el chat y las revisiones pasan a usar la API de Claude con herramientas (consulta mercado, cartera y riesgo, y opera). Variables opcionales: `CLAUDE_MODEL`, `REVIEW_MINUTES` (30 por defecto con Claude).

## Gestión autónoma basada en datos

El gestor no compra "por tendencia": valora cada empresa con datos públicos y deja por escrito el porqué de cada operación (columna *Motivo* del historial y panel de decisiones).

**Puntuación 0-100** = valoración 30 % + crecimiento 25 % + calidad 20 % + analistas 10 % + sorpresas en resultados 10 % + noticias 5 %.
- *Valoración:* PER, EV/EBITDA, precio/ventas y PEG **frente a la mediana de su sector** (calculada con el propio universo, por mercado cuando hay suficientes empresas).
- *Crecimiento:* ingresos y beneficio por acción. *Calidad:* márgenes, ROE, deuda y liquidez.
- *Analistas:* recomendación media y precio objetivo frente al precio actual. *Resultados:* cuántos trimestres superó estimaciones.
- *Noticias:* lectura por palabras clave (inglés y español) con alertas de riesgo grave (investigaciones, recortes de previsiones, solvencia…).

**Veredictos:** Atractiva, Neutral, Cara, Evitar, Precaución, Sin datos suficientes.

**Reglas de decisión**
- Solo compra valores *Atractiva*, sin resultados trimestrales en los próximos 3 días, con tamaño según convicción y repartiendo por sectores (máx. 3 compras por revisión).
- Revisa la tesis de lo que tiene en cartera (tras 24 h de tenencia mínima): vende si pasa a *Evitar* o *Cara*, o si cambia de forma clara.
- Las reglas de riesgo (stop-loss, toma de beneficios, peso máximo, efectivo mínimo) siguen mandando sobre la tesis.
- **Hasta que haya analizados al menos el 35 % del universo (`MIN_COVERAGE`) no compra ni vende por tesis**, porque las medianas del sector aún no serían fiables. Se ve en la cabecera ("Análisis X/Y"). `ALLOW_MOMENTUM_ONLY=1` permite operar por tendencia mientras tanto.

**Datos (gratis)**
- S&P 500: [Finnhub](https://finnhub.io) si defines `FINNHUB_API_KEY` (clave gratuita, 60 llamadas/min; `FINNHUB_PER_MIN`). Sin clave, usa Yahoo.
- IBEX 35 (y S&P 500 sin clave): Yahoo Finance (no oficial; `YAHOO_FUND_PER_MIN`).
- Se descargan en segundo plano priorizando lo que tienes en cartera y las órdenes pendientes. Sin clave de Finnhub, llegar al 35 % tarda del orden de 15 minutos y a todo el universo, unos 35 minutos. Se guardan en `data/fundamentals.json` (`FUNDAMENTALS_FILE`) y se refrescan solos.
- **Comprobar que llegan bien desde tu PC:** `npm.cmd run diagnostico` (o `npm.cmd run diagnostico -- AAPL SAN.MC`).

**Interfaz:** tabla *Oportunidades* con filtros, columna *Tesis* en tus posiciones y ficha detallada al pulsar cualquier símbolo (puntuación por área, argumentos a favor y en contra, catalizadores y titulares).

**Límites honestos:** es un modelo orientativo basado en reglas; no predice precios, depende de datos públicos que pueden tener errores o retraso y no es asesoramiento financiero.

## Funcionamiento 24 h en GitHub (con tu ordenador apagado)

El gestor puede trabajar solo en los servidores gratuitos de GitHub Actions. No hay servidor propio: cada pocos minutos GitHub ejecuta una pasada (`cycle.js`), guarda el estado en la rama `estado` y la web (GitHub Pages) lo muestra en solo lectura.

- **Horario de bolsa (lunes a viernes, hora local de cada bolsa):** Madrid 9:00-17:30 y Nueva York 9:30-16:00 (15:30-22:00 en Madrid). Cada 5 min se actualizan precios, se ejecutan órdenes límite, se aplica stop-loss/toma de beneficios y se revisa la tesis para comprar o vender. Con ambos mercados cerrados la ejecución termina en segundos.
- **Fuera de horario:** cada 3 horas se descargan fundamentales y noticias (sin operar). Las decisiones de un valor cuyo mercado está cerrado esperan a la siguiente sesión.
- **Festivos:** no hay calendario; si en horario de mercado el precio no tiene cotización de hoy o lleva más de 45 min sin moverse, no se opera con ese valor.
- Estas reglas valen también en local. `ENFORCE_MARKET_HOURS=0` las desactiva (útil para probar a cualquier hora).
- `NO_SIMULATION=1` (lo usa la nube) quita el respaldo simulado: solo se opera con precios reales. Si Yahoo bloquea, el S&P 500 usa cotizaciones de Finnhub como respaldo (requiere `FINNHUB_API_KEY`).
- **Límites:** la frecuencia real es de 5 a 15 min (GitHub puede retrasar los ciclos), así que el stop-loss y las órdenes límite reaccionan con ese retraso. El repositorio debe ser público (gratis ilimitado) y por tanto la web y la cartera virtual son visibles; las claves van como *secretos* y no se publican.
- La cartera de la nube es independiente de la de tu ordenador (`data/state.json`). Para empezar con la tuya, copia ese fichero a `seed/state.json` antes de la primera ejecución.
- Comandos: `npm.cmd run ciclo` (una pasada de operar, solo si hay mercado abierto; `FORCE_RUN=1` para forzarla) y `npm.cmd run ciclo-datos`.

## Splits y dividendos

`corporate.js` revisa en cada ciclo (y cada 10 min en local) los splits y dividendos de los valores en cartera con los datos gratuitos de Yahoo.
- **Split:** multiplica las acciones y divide el coste medio, de modo que el valor de la posición no cambia; se ajustan también las órdenes límite pendientes y las fracciones se abonan en efectivo. Solo se aplica cuando el precio de mercado ya refleja el split.
- **Dividendo:** se abona en efectivo (en USD, al cambio actual) el día ex-dividendo, sin retención de impuestos.
- **Guarda anti-venta falsa:** si un valor cae de golpe a ~1/2, 1/3, 1/5, 1/10… de su coste y los eventos no se han podido revisar en los últimos 45 min, el gestor no vende por stop-loss hasta confirmarlo (podría ser un split sin ajustar).
- Aparecen en el historial como SPLIT y DIVIDENDO.

## Marcador de aciertos (¿funciona el modelo?)

`scorecard.js` mide con datos reales si los veredictos predicen algo. Es una prueba hacia adelante (los fundamentales del pasado no están disponibles gratis, así que no hay backtest histórico).
- Cada semana se guarda una **cohorte**: veredicto, puntuación y componentes de todos los valores *Atractiva / Cara / Evitar / Precaución* y una muestra fija de 60 *Neutral* (`data/scorecard.json`, en la rama `estado` en la nube).
- A 5, 20 y 60 sesiones se calcula la rentabilidad de cada valor (con dividendos, entrando al cierre anterior) frente a su índice: SPY para el S&P 500 y ^IBEX para el IBEX 35.
- Se muestra, por veredicto: nº de valores, rentabilidad extra media (con margen ±) y % que supera al índice; y la **correlación de Spearman** entre puntuación y rentabilidad extra, total y por componente (valoración, crecimiento, calidad, analistas, resultados, noticias). Si un componente sale negativo de forma sostenida, es candidato a perder peso.
- Hasta tener ~30 valores "Atractiva" por horizonte, la web avisa de que la muestra es insuficiente. Las cohortes semanales se solapan y el mercado pesa mucho: hacen falta muchas semanas para que sea fiable.
- En local: `npm.cmd run marcador` (y `-- --evaluar` para descargar resultados ya maduros). En la nube se evalúa en las pasadas de "datos".

## Arquitectura

- `universe.json`: los valores disponibles (S&P 500 con su sector GICS + IBEX 35) y SPY como referencia. Se puede editar a mano: `symbol` es el ticker de Yahoo Finance (`SAN.MC` para la bolsa española, `BRK-B` con guion).
- `market.js`: precios desde Yahoo Finance. Cada 5 s refresca lo que tienes en cartera y un lote de 15 valores del resto (`UNIVERSE_BATCH`), así que los ~540 valores se cargan en unos 3 minutos sin saturar Yahoo. Los valores del IBEX cotizan en EUR y se convierten a USD con el cambio EUR/USD. Solo 10 valores tienen respaldo simulado si no hay conexión; el resto queda "sin datos" y no se puede operar hasta tener precio.
- `portfolio.js`: efectivo, posiciones, órdenes (comisión 1 USD), límite del 30 % por valor, métricas de riesgo y comparación con SPY. También las **órdenes límite**: una compra límite se ejecuta cuando el precio baja al nivel indicado (o menos) y una venta límite cuando sube a él (o más). El límite va en la moneda del valor (EUR en el IBEX). No reservan efectivo, caducan a los 30 días y se guardan con la cartera. Se crean desde la web (tipo "Límite") o por chat: `compra 10 AAPL a 300`, `órdenes pendientes`, `cancela la orden 2`.
- `fundamentals.js`: descarga y caché de fundamentales, calendario de resultados y noticias (Finnhub/Yahoo, con límites de ritmo y reintentos). `analysis.js`: modelo de puntuación y veredictos. `diagnostico.js`: prueba de conexión con los datos.
- `hours.js`: horarios de NYSE y Bolsa de Madrid y condiciones para operar. `corporate.js`: splits y dividendos. `scorecard.js`: marcador de aciertos. `cycle.js` y `gate.js`: modo "una pasada" para la nube. `.github/workflows/`: ciclo del gestor, publicación de la web y latido mensual.
- `rules.js`: gestor gratuito (revisión autónoma, decisiones por tesis y chat por palabras clave).
- `agent.js`: elige entre reglas y Claude según haya clave.
- `server.js`: API REST + Server-Sent Events para el tiempo real.
- `public/index.html`: panel con gráficos (Chart.js), posiciones, mercado, chat, orden manual, decisiones del gestor e historial.

## Notas

- La composición del IBEX 35 cambia cada 6 meses y no he podido contrastarla con la lista oficial: `universe.json` incluye 38 valores (Indra, CIE Automotive y PharmaMar figuran solo en una de las fuentes). Del S&P 500 vienen 503 valores; algún ticker recién cambiado puede no existir en Yahoo y quedará "sin datos".
- La cartera se valora en USD; los valores en EUR mezclan en su P&L el efecto del tipo de cambio.
- La cartera, el historial y las decisiones se guardan en `data/state.json` y se recuperan al arrancar. Para empezar de cero, para el servidor y borra ese fichero (o usa el botón *Reiniciar cartera*). Se puede cambiar la ruta con `DATA_FILE`.
- Es una simulación educativa, no asesoramiento financiero. Yahoo Finance no es una API oficial y puede cambiar o limitar el acceso.
- Siguientes pasos útiles: backtesting del modelo, órdenes stop, autenticación y SQLite.
