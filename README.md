# Clima Consenso

PWA personal de pronóstico meteorológico basado en consenso entre SMN, ECMWF, GFS e ICON.

## Versión 1 — ECMWF

La PWA obtiene la ubicación GPS del dispositivo y consulta directamente el modelo **ECMWF IFS HRES de 9 km** mediante Open-Meteo.

Muestra:
- temperatura actual
- sensación térmica
- probabilidad de precipitación
- humedad
- próximas 6 horas
- próximos 7 días

La documentación actual de Open-Meteo indica que el endpoint ECMWF expone IFS HRES a 9 km y variables horarias de temperatura, humedad, temperatura aparente, precipitación y códigos meteorológicos.

## Próximos pasos

1. Validar ECMWF en Android.
2. Agregar GFS.
3. Agregar ICON.
4. Integrar SMN/WRF.
5. Implementar motor de consenso.
6. Agregar detalle por modelo.
## Avisos meteorológicos

Activá los avisos en la PWA y elegí cuáles recibir:
- **Alertas oficiales SMN**: Monitoreo CAP cada 5 minutos para CABA y GBA.
- **Tormentas importantes**: Consenso multimodelo con aviso anticipado de 1 a 2 horas.
- **Temperatura máxima del día**: Aviso en tiempo real en el momento en que se alcanza el pico térmico diario (sin horario fijo, detectado dinámicamente).
- **Resumen diario (05:00)**: Pronóstico del día y probabilidad de lluvia en San Miguel.
- **Temperaturas de madrugada (20:00)**: Resumen térmico para la madrugada siguiente (00:00 a 05:00).

El Worker consulta el canal CAP del SMN cada cinco minutos. Cruza sus polígonos con los límites de CABA y los 31 partidos del GBA según el INDEC. Destaca las alertas que incluyen el partido de San Miguel o se acercan a unos 10 km de su centro. Cartografía de IGN y API Georef.

Si el canal del SMN limita las descargas, el Worker consulta los avisos CAP del mismo emisor publicados por el FOSS Public Alert Server de KDE. [Canal oficial del SMN](https://ssl.smn.gob.ar/CAP/AR.php) · [Fuentes de KDE](https://alerts.kde.org/sources/status)

Para actualizar una base D1 anterior que todavía no tenga la preferencia nocturna, ejecutar una sola vez `ALTER TABLE push_subscriptions ADD COLUMN night_minimum INTEGER NOT NULL DEFAULT 1` antes de desplegar.

Antes de habilitar Gemini, aplicar la migración D1 `0003_gemini_quota_cache.sql` y configurar `GEMINI_API_KEY` como secreto del Worker. El parte, el chat y los avisos comparten un límite de 500 llamadas diarias por modelo, con reinicio a medianoche del Pacífico.

Aplicar también la migración `0004_smn_cap_index.sql` para que las rutas de Gemini consulten el índice oficial de alertas por coordenadas. El cron del Worker actualiza este índice cada cinco minutos. Durante la primera carga o ante fallas de la fuente, la respuesta distingue cobertura parcial o no disponible de una consulta completa sin alertas.

El parte se genera cuando se carga el pronóstico y **Preguntale al clima** abre el chat. El botón **Dictar** aparece en navegadores con reconocimiento de voz y deja el texto listo para revisar antes de enviarlo.

La PWA puede recuperar durante 24 horas el último pronóstico guardado en el dispositivo. Si se abre sin conexión, la pantalla indica la ubicación y la fecha del pronóstico guardado. Gemini requiere un pronóstico actualizado y las alertas se vuelven a consultar al recuperar la conexión.

La jurisdicción de Buenos Aires se valida con el [Servicio Georef](https://www.argentina.gob.ar/georef).
