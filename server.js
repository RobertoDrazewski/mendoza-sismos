// Mendoza en Vivo — Sismos
// Servidor Node/Express que actua de proxy y "fusionador" de dos fuentes
// publicas y gratuitas de sismos (no hace falta ninguna API key):
//
//   - USGS (Estados Unidos): https://earthquake.usgs.gov/fdsnws/event/1/
//   - EMSC/SeismicPortal (Europa): https://www.seismicportal.eu/fdsn-wsevent.html
//
// Ambas exponen un webservice estandar FDSN-Event. Se consultan las dos,
// se combinan los resultados y se eliminan duplicados (el mismo sismo
// reportado por las dos fuentes), y se sirve todo en un unico JSON
// simple para el frontend.
//
// Requiere Node 18 o superior (usa el "fetch" global de Node).

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// Region monitoreada: Cuyo (Mendoza + zonas sismicas vecinas de San Juan,
// San Luis y el limite con Chile, de donde suelen originarse los sismos
// que se sienten en Mendoza). Ajusta estos numeros si queres agrandar o
// achicar el area.
// ---------------------------------------------------------------------
const BBOX = {
  minLat: -37.0,
  maxLat: -30.0,
  minLon: -71.0,
  maxLon: -64.0,
};

// Cuanto duran en cache los resultados antes de volver a pedirle a las
// APIs de afuera (para no golpearlas de mas si varias pestañas del
// navegador estan abiertas a la vez).
const CACHE_MS = 25 * 1000;
const cache = new Map(); // key: `${range}:${minmag}` -> { at, data }

const RANGES_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function isoNoMillis(date) {
  return date.toISOString().split('.')[0];
}

// --- Fuente 1: USGS ------------------------------------------------
async function fetchUSGS(startTime, endTime, minMag) {
  const url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('starttime', isoNoMillis(startTime));
  url.searchParams.set('endtime', isoNoMillis(endTime));
  url.searchParams.set('minlatitude', BBOX.minLat);
  url.searchParams.set('maxlatitude', BBOX.maxLat);
  url.searchParams.set('minlongitude', BBOX.minLon);
  url.searchParams.set('maxlongitude', BBOX.maxLon);
  url.searchParams.set('minmagnitude', minMag);
  url.searchParams.set('orderby', 'time');

  const res = await fetch(url, { headers: { 'User-Agent': 'mendoza-sismos-local/0.1' } });
  if (!res.ok) throw new Error(`USGS respondio ${res.status}`);
  const geojson = await res.json();

  return (geojson.features || []).map((f) => {
    const [lon, lat, depth] = f.geometry.coordinates;
    return {
      id: `usgs:${f.id}`,
      fuente: 'USGS',
      magnitud: f.properties.mag,
      lugar: f.properties.place || 'Ubicacion desconocida',
      lat,
      lon,
      profundidad_km: depth,
      hora: f.properties.time, // epoch ms
      url: f.properties.url,
    };
  });
}

// --- Fuente 2: EMSC / SeismicPortal ---------------------------------
async function fetchEMSC(startTime, endTime, minMag) {
  const url = new URL('https://www.seismicportal.eu/fdsnws/event/1/query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('start', isoNoMillis(startTime));
  url.searchParams.set('end', isoNoMillis(endTime));
  url.searchParams.set('minlat', BBOX.minLat);
  url.searchParams.set('maxlat', BBOX.maxLat);
  url.searchParams.set('minlon', BBOX.minLon);
  url.searchParams.set('maxlon', BBOX.maxLon);
  url.searchParams.set('minmag', minMag);
  url.searchParams.set('limit', '500');

  const res = await fetch(url, { headers: { 'User-Agent': 'mendoza-sismos-local/0.1' } });
  if (!res.ok) throw new Error(`EMSC respondio ${res.status}`);
  const geojson = await res.json();

  return (geojson.features || []).map((f) => {
    const p = f.properties || {};
    const [lon, lat, depth] = f.geometry ? f.geometry.coordinates : [p.lon, p.lat, p.depth];
    const timeMs = p.time ? Date.parse(p.time) : null;
    return {
      id: `emsc:${p.unid || f.id}`,
      fuente: 'EMSC',
      magnitud: p.mag,
      lugar: p.flynn_region || p.region || 'Ubicacion desconocida',
      lat,
      lon,
      profundidad_km: p.depth ?? depth,
      hora: timeMs,
      url: `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid || ''}`,
    };
  });
}

// Distancia aproximada entre dos puntos (formula de Haversine), en km.
function distanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Si USGS y EMSC reportan el mismo sismo (parecido en tiempo y lugar),
// nos quedamos con uno solo para no mostrarlo dos veces.
function fusionarYDeduplicar(eventos) {
  const resultado = [];
  for (const ev of eventos) {
    if (!ev.lat || !ev.lon || !ev.hora) continue;
    const duplicado = resultado.find(
      (r) =>
        Math.abs(r.hora - ev.hora) < 90 * 1000 && // menos de 90 seg de diferencia
        distanciaKm(r.lat, r.lon, ev.lat, ev.lon) < 60 // menos de 60 km de diferencia
    );
    if (duplicado) {
      if (!duplicado.fuentes.includes(ev.fuente)) duplicado.fuentes.push(ev.fuente);
    } else {
      resultado.push({ ...ev, fuentes: [ev.fuente] });
    }
  }
  resultado.sort((a, b) => b.hora - a.hora);
  return resultado;
}

app.get('/api/sismos', async (req, res) => {
  const range = RANGES_MS[req.query.range] ? req.query.range : '30d';
  const minMag = Number(req.query.minmag) || 2.0;
  const cacheKey = `${range}:${minMag}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return res.json(cached.data);
  }

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - RANGES_MS[range]);

  const [usgsResult, emscResult] = await Promise.allSettled([
    fetchUSGS(startTime, endTime, minMag),
    fetchEMSC(startTime, endTime, minMag),
  ]);

  const errores = [];
  let eventos = [];

  if (usgsResult.status === 'fulfilled') eventos = eventos.concat(usgsResult.value);
  else errores.push(`USGS: ${usgsResult.reason.message}`);

  if (emscResult.status === 'fulfilled') eventos = eventos.concat(emscResult.value);
  else errores.push(`EMSC: ${emscResult.reason.message}`);

  const data = {
    generado: new Date().toISOString(),
    region: BBOX,
    rango: range,
    magnitud_minima: minMag,
    total: 0,
    errores,
    sismos: fusionarYDeduplicar(eventos),
  };
  data.total = data.sismos.length;

  cache.set(cacheKey, { at: Date.now(), data });
  res.json(data);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Mendoza en Vivo (sismos) corriendo en http://localhost:${PORT}`);
});
