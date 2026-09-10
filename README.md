# Ojo Global — Alertas de Catástrofes

Mapa en vivo con alertas de catástrofes naturales **donde sea que estés**:
sismos, incendios activos y otras catástrofes (tsunamis, ciclones, inundaciones,
volcanes). Gratis, sin necesidad de ninguna cuenta paga. Nació como un
proyecto solo para Mendoza — ahora que la app detecta tu ubicación, el
alcance es global, pero el espíritu sigue siendo el mismo: alertar rápido y
ser honesto sobre qué es y qué no es cada cosa.

Estética "dark híbrido" (satélite oscurecido + calles con glow cian): mapa
satelital real (Esri World Imagery) oscurecido por CSS + calles/etiquetas
(CARTO dark_only_labels) con halo cian. Al abrir la app, si le das permiso
de ubicación, el mapa hace zoom directo ahí.

Combina varias fuentes públicas y gratuitas:

- **Sismos** — USGS (Estados Unidos, sondeo cada 60 s) + EMSC/SeismicPortal
  (Europa, sondeo + **websocket en tiempo casi real**). El servidor fusiona
  las dos y elimina duplicados.
- **Incendios activos** — NASA FIRMS (detecciones satelitales VIIRS, últimas
  24 h, resolución ~375 m). Necesita una API key **gratuita** propia (ver
  abajo cómo conseguirla) — sin ella, la app funciona igual, solo que sin
  esta capa.
- **Otras catástrofes** (tsunamis, ciclones, inundaciones, volcanes) — GDACS
  (Global Disaster Alert and Coordination System). No necesita ninguna key.

> **Nota:** esto NO es una fuente oficial de ningún país, y **no predice
> nada**. Avisa apenas cada fuente CONFIRMA un evento — para sismos,
> normalmente entre 20 segundos y 2 minutos después de que empezó, nunca en
> el instante exacto; para incendios y GDACS, cada pocos minutos. Para
> información oficial en Argentina consultá
> [inpres.gob.ar](https://www.inpres.gob.ar/). Para una alarma que sí avisa
> segundos antes de la sacudida en Android, activá las
> [Alertas de Sismos de Google](https://support.google.com/android/answer/12464968?hl=es).

## Requisitos

- [Node.js](https://nodejs.org/) versión 18 o superior (usa el `fetch`
  incorporado de Node). Comprobá tu versión con `node -v`.

## Cómo correrlo

```bash
cd mendoza-sismos
npm install
npm start
```

Después abrí [http://localhost:3000](http://localhost:3000) en el navegador.
Si el puerto 3000 ya lo estás usando para otra cosa, corré `PORT=4000 npm start`.

**Así, sin configurar nada, ya funciona:** vas a ver el mapa dark híbrido,
sismos en vivo, y la capa de "otras catástrofes" (GDACS). Lo único que no
vas a ver sin configurar una key gratuita es la capa de incendios — ver
abajo.

Podés instalarla como app (PWA): en el navegador, "Agregar a pantalla de
inicio" (iPhone) o el ícono de instalar de Chrome (Android/desktop). Sirve
sobre todo en iPhone, donde no hay alerta nativa de sismos.

## Variable de entorno opcional (gratis)

No es obligatoria — la app arranca y funciona sin ella, solo que sin la capa
de incendios. Se configura como variable de entorno, nunca como texto
pegado en el código.

### `FIRMS_API_KEY` — capa de incendios activos

Sin esta variable, la capa de incendios queda vacía (la app te avisa con un
cartel, no falla ni rompe nada). Con una key gratuita de [NASA
FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/) (registro
gratuito, un email), se activa la capa de incendios detectados por satélite
en las últimas 24 h en todo el mundo.

```bash
FIRMS_API_KEY=tu_key_aca npm start
```

## Qué vas a ver

- Mapa satelital oscurecido con calles/nombres en glow cian, que hace zoom
  directo a tu ubicación si le das permiso (o se queda en la vista global
  si no).
- **Sismos** con el mismo esquema de colores de siempre (verde < 3.0, amarillo
  3-4, naranja 4-5, rojo 5+), con su propio glow, más rápido con el websocket
  de EMSC.
- **Incendios activos** 🔥 (si configuraste `FIRMS_API_KEY`) y **otras
  catástrofes** 🌊🌀🌋 de GDACS, cada una con checkbox propio para
  mostrar/ocultar la capa.
- Indicador **"● en vivo / reconectando"** honesto sobre el estado del canal
  rápido (websocket).
- Botón **📍 Mi ubicación**: geolocalización, marcador en el mapa, y una
  sección de "**sugerencia de evacuación**" — ver aclaración importante abajo.
- Botón **🆘 Emergencias**: números reales de Argentina (911, Ecogas, EDEMSA)
  con una nota clara para quien esté fuera de Argentina, y un botón para
  **compartir tu ubicación actual** por WhatsApp — **no es un rastreador
  automático** (ver por qué, más abajo).
- Protocolos de qué hacer ante sismo, incendio cercano y alerta de tsunami.
- Selector de rango de tiempo (24 h / 7 días / 30 días) y magnitud mínima
  para sismos.
- Aviso sonoro y visual cuando aparece un sismo nuevo.
- Bandeja deslizable en mobile.

## Sobre la "sugerencia de evacuación" — qué es y qué NO es

**No existe ningún dataset público y oficial de rutas de evacuación**, ni
para Mendoza ni para el resto del mundo. Por eso, lo que muestra la app
cuando hay un evento cerca de tu ubicación es una **heurística simple**: la
dirección opuesta al evento más cercano (por ejemplo, "alejate hacia el
noreste"), calculada con geometría básica, nada más.

Esto **no es una ruta de evacuación oficial**, no sabe dónde hay edificios,
cortes de calle, zonas seguras reales ni puntos de encuentro — es una
orientación general para no quedarte parado/a pensando hacia dónde ir.
Seguí siempre las indicaciones de Defensa Civil o la autoridad de tu zona
cuando estén disponibles. La app lo aclara en la propia UI cada vez que
aparece.

## Sobre "compartir mi ubicación" — qué es y qué NO es

Es un botón que toma tu posición GPS actual y arma un mensaje con un link a
Google Maps para que lo mandes vos mismo/a por WhatsApp o el mensajero que
uses. Es manual, con un solo toque, y no requiere backend.

Deliberadamente **no** implementé un "rastreador automático en segundo
plano". En iPhone (Safari) la geolocalización en segundo plano de una
página web está muy restringida —deja de funcionar apenas se cierra o
bloquea la pantalla—, así que un sistema así daría una falsa sensación de
seguridad. Tampoco hay forma de que esto llegue a un rescatista real sin
integrarse con un servicio de emergencias de verdad. Mientras tanto, el
botón de compartir manual es lo honesto: rápido, útil, sin prometer de más.

## Sobre los números de emergencia

Son los que encontré vigentes y con fuente reciente para Argentina (911,
Ecogas 0800-999-1600, EDEMSA 0800-3-333672). A propósito **no** incluí un
número directo de Defensa Civil Mendoza: la única fuente que encontré es de
2016 — el panel linkea a su página oficial en su lugar. Si estás fuera de
Argentina, el panel te lo aclara: marcá el número de emergencias de tu país
(112 en la Unión Europea y gran parte del mundo, 911 en gran parte de
América, 000 en Australia, etc.).

## Qué tiene el proyecto original (God's Eye View) que esto NO tiene

Este proyecto se inspira en [God's Eye
View](https://github.com/bilawalsidhu/gods-eye-view) (que usa un globo 3D
con CesiumJS) pero no es un fork completo, y tampoco usa Cesium: se probó
esa vía (ver sección de abajo) y se volvió a un mapa 2D porque, sin
configurar una cuenta de Cesium Ion, ni siquiera el mapa base de respaldo
cargaba bien en producción — el mapa satelital 2D de toda la vida es gratis,
simple, y se ve bien de entrada. Cosas del original que acá no están:
tráfico aéreo (OpenSky), barcos (AIS), satélites (CelesTrak), cámaras CCTV
públicas (~800 en el mundo, ninguna en Mendoza), control por voz, globo 3D
y "street view".

### Por qué no Cesium/globo 3D (decisión tomada, 10/09/2026)

Se probó una versión completa con CesiumJS (globo 3D que giraba hasta la
ubicación detectada). Anduvo bien en las pruebas automatizadas, pero al
deployarla de verdad, sin un token de Cesium Ion configurado, el mapa base
de respaldo (tiles de OpenStreetMap) tampoco cargó en producción — el
resultado fue un globo azul liso, sin calles, con los marcadores de sismos
mostrados como manchas de glow gigantes sin ningún mapa debajo. Conseguir
un token de Cesium Ion gratis es un paso extra que había que dar antes de
que el mapa se viera bien, y el objetivo del proyecto es que funcione bien
de entrada, sin configuración. Por eso se volvió al mapa 2D con Esri World
Imagery + CARTO (el mismo que ya andaba bien en la primera versión), que no
necesita ninguna cuenta para verse completo.

## Cómo ajustar la zona monitoreada (opcional)

Por defecto, `/api/sismos` es global. Si querés acotar la vista a una
región (por ejemplo, volver a una versión "solo Cuyo"), podés pedirle al
endpoint un bbox por query string: `/api/sismos?minlat=-37&maxlat=-30&minlon=-71&maxlon=-64`.
El frontend usa el bbox que le devuelve el backend para filtrar los eventos
del websocket, así que no hace falta tocar `app.js`.

## Ideas para seguir (no incluidas todavía)

- Notificaciones push reales (Web Push) para avisar aunque la pestaña esté
  cerrada — hoy la PWA instala pero las notificaciones solo llegan con la
  página abierta o en segundo plano reciente.
- Capa de tráfico aéreo (OpenSky) y satélites (CelesTrak), como en el
  proyecto original, si en algún momento se quiere sumar más contexto.
- Una fuente específica de alertas de tsunami más fina que GDACS (por
  ejemplo, feeds regionales de NOAA/tsunami.gov) si GDACS se queda corto en
  cobertura o latencia para algún océano en particular.
- Escribirle a INPRES o a Defensa Civil de Mendoza para conseguir acceso a
  datos sísmicos más finos (magnitudes menores a 2.5) y un número de
  contacto vigente para el panel de emergencias.

## Aviso honesto sobre las integraciones nuevas

La capa de incendios (FIRMS) y la de otras catástrofes (GDACS) se
escribieron siguiendo la documentación pública de cada API, pero no se
pudieron probar contra una respuesta real de esos servidores durante el
desarrollo (el entorno donde se armó esto tiene la red restringida). Si al
correrlo con tu propia key ves que algo no carga bien, es más probable que
sea un detalle del formato de respuesta que no coincidió exactamente que un
error de lógica — avisame y lo ajustamos.

## Licencia

MIT. Los datos de USGS son de dominio público; los de EMSC se distribuyen
bajo licencia Creative Commons Attribution 4.0; NASA FIRMS y GDACS piden
atribución. Si compartís capturas o datos públicamente, mencioná la fuente.
