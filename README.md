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
7. Agregar alertas y notificaciones.
