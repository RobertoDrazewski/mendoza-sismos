# Mendoza en Vivo — Sismos

Mapa en vivo de sismos en Mendoza y la región de Cuyo (Mendoza, San Juan,
San Luis y el límite con Chile), gratis, sin necesidad de ninguna API key.

Combina dos fuentes públicas:

- **USGS** (Estados Unidos) — cobertura global, buena para sismos M3+.
- **EMSC / SeismicPortal** (Europa) — suele detectar sismos moderados en
  Sudamérica más rápido y con más densidad que USGS.

El servidor fusiona las dos fuentes y elimina duplicados cuando ambas
reportan el mismo sismo.

> **Nota:** esto NO es una fuente oficial argentina. INPRES (el organismo
> nacional) no publica una API pública, así que no está incluido acá.
> Para información oficial, siempre consultá [inpres.gob.ar](https://www.inpres.gob.ar/).

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

## Qué vas a ver

- Un mapa centrado en Mendoza con círculos de colores por cada sismo
  (verde = menor a 3.0, amarillo = 3-4, naranja = 4-5, rojo = 5+).
- Un panel con la lista de los últimos sismos, con hora en horario de
  Mendoza (America/Argentina/Mendoza).
- Selector de rango de tiempo (24 h / 7 días / 30 días) y de magnitud
  mínima a mostrar.
- Un aviso sonoro y visual cuando aparece un sismo nuevo mientras tenés
  la página abierta (se refresca sola cada 60 segundos).
- Un panel fijo con las recomendaciones de Defensa Civil (antes/durante/después).

## Cómo ajustar la zona monitoreada

En `server.js`, al principio del archivo, está el objeto `BBOX` con los
límites de latitud/longitud. Podés agrandar o achicar la región editando
esos cuatro números.

## Ideas para seguir (no incluidas todavía)

- Agregar la capa histórica del IGN (sismos INPRES 2013-2021) como fondo
  de referencia — es un dataset congelado, no en vivo, pero sirve para
  mostrar la sismicidad histórica de la provincia.
- Escribirle a INPRES o a Defensa Civil de Mendoza para conseguir un
  acceso a datos más finos (magnitudes menores a 2.5, que localmente se
  sienten seguido pero las redes globales no siempre captan bien).
- Convertirlo en PWA con notificaciones push para recibir el aviso aunque
  no tengas la pestaña abierta.
- Integrarlo al globo 3D de God's Eye View (Cesium) si en algún momento
  querés sumar también vuelos (OpenSky) e incendios (NASA FIRMS) — este
  proyecto quedó como una versión chica y enfocada solo en sismos, para
  probar rápido.

## Licencia

MIT. Los datos de USGS son de dominio público; los de EMSC se distribuyen
bajo licencia Creative Commons Attribution 4.0 — si compartís capturas o
datos públicamente, mencioná la fuente.
