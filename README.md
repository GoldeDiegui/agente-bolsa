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

**Puntuación 0-100** = valoración 27 % + crecimiento 22 % + calidad 18 % + analistas 8 % + sorpresas en resultados 8 % + revisiones de estimaciones 12 % + noticias 5 %.
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

## Rotación de cartera

Con la cartera llena (efectivo en el mínimo, sin margen para comprar), el gestor puede **cambiar la posición más débil por una candidata claramente mejor**:
- Solo si la candidata es *Atractiva*, sin resultados inminentes, con precio de hoy y mercado abierto, y puntúa **al menos 12 puntos más** que la posición más débil (`ROTATION_GAP`).
- La posición a vender debe llevar más de 24 h en cartera y no haber sido comprada por rotación en los últimos 3 días.
- Máximo 2 rotaciones cada 24 horas, y la rotación no deja ningún sector por encima del 35 % de la cartera.
- Vende toda la posición débil y compra la candidata con el tamaño habitual según convicción; el resto queda como efectivo para las siguientes revisiones.
- Cada operación lleva el motivo "Rotación: X puntúa a/100 y Y b/100". Si no rota, el registro indica cuál es la posición más débil y qué ventaja se exige.

## Splits y dividendos

`corporate.js` revisa en cada ciclo (y cada 10 min en local) los splits y dividendos de los valores en cartera con los datos gratuitos de Yahoo.
- **Split:** multiplica las acciones y divide el coste medio, de modo que el valor de la posición no cambia; se ajustan también las órdenes límite pendientes y las fracciones se abonan en efectivo. Solo se aplica cuando el precio de mercado ya refleja el split.
- **Dividendo:** se abona en efectivo (en USD, al cambio actual) el día ex-dividendo, sin retención de impuestos.
- **Guarda anti-venta falsa:** si un valor cae de golpe a ~1/2, 1/3, 1/5, 1/10… de su coste y los eventos no se han podido revisar en los últimos 45 min, el gestor no vende por stop-loss hasta confirmarlo (podría ser un split sin ajustar).
- Aparecen en el historial como SPLIT y DIVIDENDO.

## Guidance y revisiones de estimaciones

La *guidance* oficial de las empresas (lo que la directiva prevé ingresar o ganar) no está disponible como dato en fuentes gratuitas: va dentro de las notas de resultados. Se aproxima de dos formas:
- **Revisiones de estimaciones (componente "Revisiones", peso 12 %):** cuánto han cambiado en 30 y 90 días las estimaciones de beneficio por acción de los analistas (año en curso y siguiente) y cuántos las han subido o bajado en 30 días. Si tras resultados la empresa da buena guidance, las estimaciones suben. Datos de Yahoo (módulo `earningsTrend`). Se piden una vez al día **solo para lo que tienes en cartera y para los candidatos**; el resto de valores se puntúa sin este componente (los pesos se reescalan).
- **Titulares de guidance:** el léxico reconoce "sube/recorta/retira/reitera previsiones", "guía por encima/por debajo" y "perspectivas débiles/fuertes". Las retiradas o recortes graves cuentan como riesgo grave y bloquean la compra.
- Pesos actuales: valoración 27 %, crecimiento 22 %, calidad 18 %, analistas 8 %, resultados 8 %, revisiones 12 %, noticias 5 %. El marcador de aciertos mide también si las revisiones predicen algo.

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

## Precios de todo el universo en la web (nube)

Cada ciclo de GitHub Actions es un proceso nuevo, así que los precios se guardan en `data/prices.json` (rama `estado`, junto a la cartera).
- Ciclo de datos (cada 3 h): refresca los 542 valores (tope de 200 s).
- Ciclo de operar (cada 5 min): cartera, órdenes pendientes y candidatos primero, más un lote de 120 valores de fondo (`PRICE_BATCH_TRADE`); el resto conserva su último precio.
- Un precio guardado nunca se usa para operar si lleva más de 45 min sin actualizarse (los de cartera y candidatos se refrescan en cada ciclo).
- La web publica además `analyses.json` con el análisis de todos los valores; se descarga solo al abrir un valor que no esté en `state.json`.

## Cuentas de la empresa (ingresos, gastos, balance)

En el detalle de cada valor aparece la tabla «Cuentas»: resultados (ingresos, costes, gastos, beneficio bruto/operativo/neto, EBITDA, BPA), balance (activos, pasivos, patrimonio, efectivo, deuda) y flujo de caja, con tres vistas:
- **Trimestral · interanual:** cada trimestre frente al mismo trimestre del año anterior.
- **Trimestral · secuencial:** frente al trimestre anterior.
- **Anual:** frente al año anterior.
Los costes, pasivos y deuda se marcan en rojo al subir. Fuente: Yahoo Finance (S&P 500 e IBEX), sin registro; se descargan poco a poco (primero cartera y candidatos) y se renuevan cada 5 días (`YAHOO_STMT_PER_MIN`, 40 por defecto). Yahoo suele dar unos 4-5 trimestres y 4 años. En la nube se publican en `financials.json`; en local, el servidor los pide al abrir el valor (`/api/financials/:símbolo`).

## Stop-loss por volatilidad y filtro de mercado

**Stop-loss propio de cada valor.** En vez de un -8 % fijo, el stop es 3,5 veces la volatilidad diaria del valor (ATR de 14 sesiones, en % del precio), con suelo del -6 % y techo del -15 %. Un valor tranquilo (KO) sale antes; uno muy volátil (AMD) aguanta el ruido normal. Sin datos de volatilidad se usa el -8 % de siempre. La toma de beneficios (vende la mitad) es el doble del stop, mínimo +15 %. La web muestra el stop de cada posición (columna «Stop»).

**Tamaño según volatilidad.** La compra base se multiplica por 2,5 / ATR del valor, entre 0,5 y 1,2: menos dinero en los valores más volátiles.

**Filtro de mercado.** Se compara el S&P 500 (el IBEX 35 para sus valores) con sus medias de 50 y 200 sesiones:
- *Alcista* (por encima de ambas): todo normal.
- *Cautela* (por debajo de la de 50): compras a ¾ del tamaño y colchón de efectivo del 20 %.
- *Bajista* (por debajo de la de 200): solo compra con tesis de 80+/100, a medio tamaño, y colchón del 25 %. Las rotaciones siguen la misma regla.
El filtro nunca fuerza ventas: solo frena compras nuevas. Si no hay datos del índice, no se aplica. El estado aparece en el panel de riesgo y en el registro del gestor.

Los datos salen del gráfico diario de Yahoo y se guardan en `vol.json` (rama `estado`); se renuevan cada 12 h (valores) y 4 h (índices). Parámetros en `volatility.js`.

## Resumen del día

Tarjeta al principio de la web (`daily.js`): rentabilidad del día de la cartera frente al S&P 500, resultado en US$, rentabilidad desde el inicio, efectivo, las operaciones y eventos (splits/dividendos) del día con su motivo, y la última decisión del gestor. El día se cuenta en hora de Madrid; si aún no hay datos de hoy (fin de semana, antes de abrir), muestra la última sesión con actividad. En la nube viaja dentro de `state.json`; en local, `/api/daily`.

## Señales de precio y gráfico (`technicals.js`)

Nuevo componente **Momentum** del análisis (peso 10 %; el resto de pesos se reduce un 10 % proporcionalmente), calculado con el gráfico diario de Yahoo (2 años, ajustado por splits):
- Rentabilidad de 12 meses saltándose el último mes («12-1») y de 6 meses, como **percentil dentro de su mercado** (S&P 500 o IBEX 35).
- Tendencia: precio y medias de 50 y 200 sesiones.
- RSI de 14 sesiones (penaliza la sobrecompra), distancia al máximo de 52 semanas y fuerza relativa de 6 meses frente a su índice.
En el detalle de cada valor, las razones a favor/en contra incluyen estas señales, y hay un **gráfico de precios** (3M/6M/1A) con las medias de 50 y 200 y marcas de tus compras y ventas. El marcador de aciertos mide el componente por separado, así que se verá si aporta; si no, se baja su peso.
Datos: ciclo de datos (cada 3 h) descarga todo el universo (TECH_BUDGET_SECONDS, 90 por defecto; TTL 20 h); el ciclo de operar solo refresca cartera y candidatos (6 h). Se guardan en `technicals.json` y la web lee `charts.json`. Límite de un ciclo: 780 s (el de datos reparte: fundamentales 270 s).

## Operaciones de directivos (insiders)

Nuevo componente **Directivos** del análisis (peso ≈ 5 %), solo para el S&P 500 (los Form 4 de la SEC son de EE. UU.; en el IBEX queda sin dato y no puntúa ni penaliza). Fuente: Yahoo Finance (módulos `netSharePurchaseActivity` e `insiderTransactions`), sin registro.
- Compras de directivos en mercado abierto en 6 meses: puntúan alto (60 + 8 por compra, hasta 92; varias compras = señal fuerte).
- Ventas: casi neutras (suelen ser rutina de retribución); solo penalizan algo si no hay compras y hay muchas ventas.
- En el detalle de cada valor aparecen las últimas operaciones (fecha, quién, cargo, acciones e importe). Se filtran concesiones, ejercicios de opciones y regalos.
- Descarga: cartera y candidatos cada 24 h; el resto del S&P 500 cada 3 días (`YAHOO_INS_PER_MIN`, 30 por defecto). Se guarda en `fundamentals.json`.
Los pesos se normalizan en `analysis.js` (`W_RAW`). El marcador de aciertos mide Directivos por separado.

## Posición corta y propiedad

Nuevo componente **Posición corta** (peso ≈ 3 %), solo S&P 500: porcentaje de las acciones en circulación vendidas en corto (por tramos: ≤2 % neutro-favorable, ≥10 % negativo, ≥20 % muy negativo), con el cambio frente al mes anterior y los días necesarios para cubrirla. Avisa de posible *short squeeze* si es muy alta y difícil de cubrir. Además se muestra la propiedad (instituciones y directivos, % de las acciones) como dato informativo, sin puntuar. Se descarga en la misma petición de Yahoo que las operaciones de directivos (sin coste extra de peticiones) y se guarda en `fundamentals.json`.

## Contexto macro (`macro.js`)

Tarjeta «Contexto macro» en la web con el VIX (miedo del mercado), el bono de EE. UU. a 10 años, la letra a 3 meses, la curva 10 años − 3 meses, el índice dólar, el petróleo WTI y el oro, con su variación del día y del mes y avisos en lenguaje claro (curva invertida, subida rápida de tipos, dólar fuerte, petróleo disparado). Datos del gráfico diario de Yahoo, sin clave; se renuevan cada 30 min y se guardan en `macro.json`.

**Cómo lo usa el gestor:** solo el VIX actúa sobre las órdenes. VIX ≥ 25 («tensión elevada»): compras a ¾ del tamaño y colchón de efectivo del 20 %. VIX ≥ 30 («alta»): compras al 60 % y colchón del 25 %. Se combina con la tendencia del S&P 500 (se aplica lo más prudente). El resto de indicadores es informativo por ahora. Si no hay datos del VIX, no se aplica nada. El resumen del día y el registro del gestor mencionan la tensión cuando existe.

## Noticias mejoradas (`news.js`)

Para la cartera y los candidatos, las noticias vienen ahora de tres sitios y se unen:
1. La fuente de siempre (Finnhub para el S&P 500 con clave, Yahoo en el resto).
2. **Google News** (RSS por empresa, en inglés para el S&P 500 y en español para el IBEX; sin clave).
3. **Comunicados 8-K de la SEC** (hechos relevantes de empresas de EE. UU.; sin clave). Cada apartado del 8-K tiene su propia valoración: p. ej. 4.02 «las cuentas anteriores no son fiables» (riesgo grave), 1.03 quiebra, 3.01 aviso de exclusión de bolsa, 2.06 deterioro de activos, 5.02 salida de directivos, 2.02 resultados (neutro).
- **Sin duplicados:** el mismo titular en varios medios cuenta una vez (similitud de palabras ≥ 60 % en 3 días); si lo cuentan varios medios, pesa algo más (hasta ×1,3).
- **Peso por fuente:** Reuters, Bloomberg, WSJ, FT, CNBC, SEC, Expansión… ×1; medios intermedios ×0,8; Motley Fool, Seeking Alpha, Zacks, MarketBeat… ×0,5; titulares de «clickbait» («3 reasons to buy…») ×0,5 adicional. Las noticias de poco peso no cuentan como positivas/negativas ni como riesgo grave.
- En el detalle de cada valor, los titulares son enlaces con fecha, medio y número de medios que lo cuentan.
Límites: Google 20/min, SEC 60/min (`GOOGLE_NEWS_PER_MIN`, `SEC_PER_MIN`; `SEC_USER_AGENT` para identificarte ante la SEC). Si una fuente extra falla, se sigue con las demás.

## Costes de operar realistas (`costs.js`)

Cada orden ahora paga lo que costaría de verdad (antes: 1 US$ fijo y precio exacto de mercado):
- **Diferencial y deslizamiento:** el precio de ejecución es peor que el de mercado (compras más caras, ventas más baratas) según la liquidez del valor, calculada con su volumen diario medio de 30 sesiones: de 2 puntos básicos en los gigantes a 30 en los poco negociados (10 si no hay datos), más un impacto que crece con el tamaño de la orden y la volatilidad del valor. Tope: 100 pb. Las órdenes límite se ejecutan al precio del límite o mejor, sin deslizamiento.
- **Comisión:** EE. UU. 0,005 US$/acción (mín. 1 US$, máx. 1 %); IBEX 0,10 % (mín. 2 US$).
- **Divisa (IBEX):** 0,15 % en cada operación.
- **Impuesto sobre transacciones financieras (España):** 0,2 % en las compras de acciones españolas.
- **Liquidez:** una orden no puede superar el 5 % del volumen diario medio; si lo supera se ejecuta solo lo que el volumen permite.
- **Dividendos:** se abonan netos de la retención en origen (15 % EE. UU., 19 % España); es una simplificación (no se modela la tributación final en tu IRPF).
- El coste medio de cada posición incluye los costes de compra, así que el P&L y el stop-loss ya van «netos».
- La web muestra en el panel de riesgo los **costes acumulados** (con desglose) y, al pasar el ratón sobre el precio de una operación, su precio de mercado, deslizamiento y comisiones. Las operaciones anteriores a esta versión cuentan 1 US$ de comisión.
Todo es configurable por variables de entorno (`COST_US_PER_SHARE`, `COST_ES_PCT`, `COST_FX_BPS`, `COST_ITF_ES_PCT`, `COST_MAX_PARTICIPATION_PCT`, `COST_IMPACT_K`, `DIV_TAX_US`, `DIV_TAX_ES`…). `COST_MODEL=simple` vuelve al modelo antiguo para comparar.
