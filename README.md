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

Activá los avisos en la PWA y elegí cuáles recibir. Los resúmenes usan el pronóstico de Open-Meteo para San Miguel y se programan a las 05:00 y 20:00 de Argentina. El segundo resume las temperaturas previstas entre las 00:00 y las 05:00 de la madrugada siguiente.

El Worker consulta el canal CAP del SMN cada cinco minutos. Cruza sus polígonos con los límites de CABA y los 31 partidos del GBA según el INDEC. Destaca las alertas que incluyen el partido de San Miguel o se acercan a unos 10 km de su centro. Cartografía de IGN y API Georef.

Si el canal del SMN limita las descargas, el Worker consulta los avisos CAP del mismo emisor publicados por el FOSS Public Alert Server de KDE. [Canal oficial del SMN](https://ssl.smn.gob.ar/CAP/AR.php) · [Fuentes de KDE](https://alerts.kde.org/sources/status)

Para actualizar una base D1 anterior que todavía no tenga la preferencia nocturna, ejecutar una sola vez `ALTER TABLE push_subscriptions ADD COLUMN night_minimum INTEGER NOT NULL DEFAULT 1` antes de desplegar.
