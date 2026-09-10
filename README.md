# Mendoza en Vivo — Sismos

Mapa en vivo de sismos en Mendoza y la región de Cuyo (Mendoza, San Juan,
San Luis y el límite con Chile), gratis, sin necesidad de ninguna API key.
Estética "dark híbrido" (satélite oscurecido + calles con glow cian),
pensado para verse bien en escritorio y en el celular.

Combina dos fuentes públicas:

- **USGS** (Estados Unidos) — cobertura global, respaldo por sondeo cada 60s.
- **EMSC / SeismicPortal** (Europa) — además del sondeo, se conecta por
  **websocket en tiempo casi real**, así un sismo nuevo puede aparecer en
  segundos en vez de esperar al próximo sondeo. Si el websocket se cae, la
  app sigue funcionando igual con el sondeo de 60s (mirá el indicador
  "● en vivo / reconectando" en la barra superior).

El servidor fusiona las dos fuentes y elimina duplicados cuando ambas
reportan el mismo sismo.

> **Nota:** esto NO es una fuente oficial argentina, y **no predice sismos**.
> Avisa apenas la red sismológica confirma un evento — normalmente entre 20
> segundos y 2 minutos después de que empezó, nunca en el instante exacto.
> INPRES (el organismo nacional) no publica una API pública, así que no está
> incluido acá. Para información oficial, siempre consultá
> [inpres.gob.ar](https://www.inpres.gob.ar/). Para una alarma que sí avisa
> segundos antes de la sacudida en Android, activá las
> [Alertas de Sismos de Google](https://support.google.com/android/answer/12464968?hl=es)
> (la propia app te lo sugiere si te detecta en Android).

## Requisitos

- [Node.js](https://nodejs.org/) versión 18 o superior (usa el `fetch`
  incorporado de Node). Comprobá tu versión con:

  ```bash
  node -v
  ```

## Cómo correrlo

```bash
cd mendoza-sismos
npm install
npm start
```

Después abrí [http://localhost:3000](http://localhost:3000) en el navegador.

Si el puerto 3000 ya lo estás usando para otra cosa, corré:

```bash
PORT=4000 npm start
```

Podés instalarla como app (PWA): en el navegador, "Agregar a pantalla de
inicio" (iPhone) o el ícono de instalar de Chrome (Android/desktop). Sirve
sobre todo en iPhone, donde no hay alerta nativa de sismos.

## Qué vas a ver

- Mapa satelital oscurecido con calles/nombres en glow cian, círculos de
  colores por magnitud (verde < 3.0, amarillo 3-4, naranja 4-5, rojo 5+),
  con su propio glow y un pulso cuando un sismo es nuevo.
- Indicador "● en vivo / reconectando" que muestra honestamente si el canal
  rápido (websocket) está conectado o si la app está corriendo solo con el
  sondeo de respaldo.
- Botón **📍 Mi ubicación** (arriba a la derecha del mapa): pide permiso de
  geolocalización, te marca en el mapa y le suma a cada sismo (en la lista y
  en el popup) la distancia real en km hasta tu posición, más un resumen del
  sismo más cercano a vos.
- Botón **🆘 Emergencias**: números reales de Mendoza con un toque —
  911 (policía/bomberos/ambulancia), Ecogas (fuga de gas) y EDEMSA
  (emergencia eléctrica) — y un botón para **compartir tu ubicación actual**
  por WhatsApp/lo que elijas con un link a Google Maps y la hora. Esto
  **no es un rastreador automático** ni un reemplazo de los equipos de
  rescate: es un atajo de un toque para que tus contactos sepan dónde
  estabas parado/a por última vez.
- Panel con recomendaciones ampliadas de qué hacer antes, durante y después
  de un sismo (agacharse-cubrirse-sujetarse, no usar ascensor, qué hacer si
  hay olor a gas, réplicas, etc.).
- Selector de rango de tiempo (24 h / 7 días / 30 días) y de magnitud
  mínima a mostrar.
- Un aviso sonoro y visual cuando aparece un sismo nuevo.
- Bandeja deslizable en mobile: el mapa ocupa toda la pantalla y el panel
  se abre tocando el botón flotante "📡 Sismos".

## Sobre los números de emergencia

Son los que encontré vigentes y con fuente reciente al armar esto (911,
Ecogas 0800-999-1600, EDEMSA 0800-3-333672). A propósito **no** incluí un
número directo de Defensa Civil Mendoza: la única fuente que encontré es de
2016 y no quise arriesgarme a dejar un número viejo en algo tan sensible —
el panel linkea a su página oficial en su lugar. Si conseguís el número
vigente, agregalo en `public/index.html` dentro del `#fondo-sos`.

## Sobre "compartir mi ubicación" — qué es y qué NO es

Es un botón que toma tu posición GPS actual y arma un mensaje con un link a
Google Maps para que lo mandes vos mismo/a por WhatsApp o el mensajero que
uses. Es manual, con un solo toque, y no requiere backend.

Deliberadamente **no** implementé un "rastreador automático en segundo
plano" que reporte posición sola en caso de derrumbe. No es un capricho:
en iPhone (Safari) la geolocalización en segundo plano de una página web
está muy restringida —deja de funcionar apenas se cierra o bloquea la
pantalla—, así que un sistema así daría una falsa sensación de seguridad.
Tampoco hay forma de que esto llegue a un rescatista real sin integrarse
con un servicio de emergencias de verdad, cosa que este proyecto no tiene.
Si en algún momento se quiere ir en esa dirección en serio, hace falta:
una app nativa (no una web) con permisos de ubicación en segundo plano,
un backend que guarde los últimos reportes, y sobre todo un acuerdo con
Defensa Civil o el sistema de emergencias para que esos datos realmente
lleguen a quien busca. Mientras tanto, el botón de compartir manual es lo
honesto: rápido, útil, sin prometer de más.

## Cómo ajustar la zona monitoreada

En `server.js`, al principio del archivo, está el objeto `BBOX` con los
límites de latitud/longitud. Podés agrandar o achicar la región editando
esos cuatro números (el frontend usa el mismo bbox que te devuelve la API
para filtrar los eventos del websocket, así que no hace falta tocar nada
en `app.js`).

## Ideas para seguir (no incluidas todavía)

- Agregar la capa histórica del IGN (sismos INPRES 2013-2021) como fondo
  de referencia — es un dataset congelado, no en vivo, pero sirve para
  mostrar la sismicidad histórica de la provincia.
- Escribirle a INPRES o a Defensa Civil de Mendoza para conseguir un
  acceso a datos más finos (magnitudes menores a 2.5) y un número de
  contacto vigente para el panel de emergencias.
- Notificaciones push reales (Web Push) para avisar aunque la pestaña esté
  cerrada — hoy la PWA instala pero las notificaciones solo llegan con la
  página abierta o en segundo plano reciente.
- Integrarlo al globo 3D de God's Eye View (Cesium) si en algún momento
  querés sumar también vuelos (OpenSky) e incendios (NASA FIRMS) — este
  proyecto quedó como una versión chica y enfocada solo en sismos, para
  probar rápido.

## Licencia

MIT. Los datos de USGS son de dominio público; los de EMSC se distribuyen
bajo licencia Creative Commons Attribution 4.0 — si compartís capturas o
datos públicamente, mencioná la fuente.
