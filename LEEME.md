# Copias de seguridad del gestor de cartera

Se generan solas cada día (flujo «Copias de seguridad»). Esta rama no la lee la web.

- diarias/AAAA-MM-DD/: state.json.gz (cartera, órdenes, diario) y scorecard.json.gz (marcador de aciertos). Últimos 30 días.
- semanales/AAAA-MM-DD/: lo anterior más fundamentals.json.gz, de los lunes. Últimas 26 semanas.
- previas/: lo que había justo antes de cada restauración.
- indice.json: lista de copias con el patrimonio, operaciones y posiciones de cada una.

Para volver a una copia: Actions → «Restaurar copia» → Run workflow → escribe la fecha (o deja «ultima»).
