// Ojo Global — Alertas de Catástrofes (antes "Mendoza en Vivo — Sismos")
// Servidor Node/Express que actua de proxy y "fusionador" de varias fuentes
// publicas y gratuitas de datos de catastrofes naturales:
//
//   - Sismos:   USGS (Estados Unidos) + EMSC/SeismicPortal (Europa)
//   - Incendios: NASA FIRMS (necesita una API key GRATUITA propia, ver README)
//   - Otras catastrofes (tsunamis, ciclones, inundaciones, volcanes): GDACS
//
// Nacio como un proyecto solo para Mendoza y la region de Cuyo. Ahora que la
// app detecta la ubicacion del usuario, el alcance paso a ser global: por
// defecto ya NO se filtra por ningun bbox fijo, se puede pedir uno opcional
// por query string si alguien quiere acotar la vista a una region.
//
// Requiere Node 18 o superior (usa el "fetch" global de Node).

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Key opcional y gratuita para la capa de incendios (NASA FIRMS). Sin ella
// la app sigue funcionando igual, solo que sin esa capa — ver README.
const FIRMS_API_KEY = process.env.FIRMS_API_KEY || '';

// ---------------------------------------------------------------------
// Bbox global por defecto (todo el planeta). Se puede acotar mandando
// minlat/maxlat/minlon/maxlon por query string si alguien quiere una vista
// regional en vez de global (por ejemplo, para una version "solo Cuyo").
// ---------------------------------------------------------------------
const BBOX_GLOBAL = { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 };

function bboxDesdeQuery(query) {
  const minLat = Number(query.minlat);
  const maxLat = Number(query.maxlat);
  const minLon = Number(query.minlon);
  const maxLon = Number(query.maxlon);
  if ([minLat, maxLat, minLon, maxLon].every((n) => Number.isFinite(n))) {
    return { minLat, maxLat, minLon, maxLon };
  }
  return BBOX_GLOBAL;
}

// Cuanto duran en cache los resultados antes de volver a pedirle a las
// APIs de afuera (para no golpearlas de mas si varias pestañas del
// navegador estan abiertas a la vez).
const CACHE_MS = 25 * 1000;
const cacheSismos = new Map(); // key: `${range}:${minmag}:${bbox}` -> { at, data }
let cacheIncendios = null; // { at, data }
let cacheCatastrofes = null; // { at, data }

const RANGES_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function isoNoMillis(date) {
  return date.toISOString().split('.')[0];
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

// =====================================================================
// SISMOS: USGS + EMSC
// =====================================================================

async function fetchUSGS(startTime, endTime, minMag, bbox) {
  const url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('starttime', isoNoMillis(startTime));
  url.searchParams.set('endtime', isoNoMillis(endTime));
  url.searchParams.set('minlatitude', bbox.minLat);
  url.searchParams.set('maxlatitude', bbox.maxLat);
  url.searchParams.set('minlongitude', bbox.minLon);
  url.searchParams.set('maxlongitude', bbox.maxLon);
  url.searchParams.set('minmagnitude', minMag);
  url.searchParams.set('orderby', 'time');

  const res = await fetch(url, { headers: { 'User-Agent': 'ojo-global/0.2' } });
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

async function fetchEMSC(startTime, endTime, minMag, bbox) {
  const url = new URL('https://www.seismicportal.eu/fdsnws/event/1/query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('start', isoNoMillis(startTime));
  url.searchParams.set('end', isoNoMillis(endTime));
  url.searchParams.set('minlat', bbox.minLat);
  url.searchParams.set('maxlat', bbox.maxLat);
  url.searchParams.set('minlon', bbox.minLon);
  url.searchParams.set('maxlon', bbox.maxLon);
  url.searchParams.set('minmag', minMag);
  url.searchParams.set('limit', '1000');

  const res = await fetch(url, { headers: { 'User-Agent': 'ojo-global/0.2' } });
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
  const range = RANGES_MS[req.query.range] ? req.query.range : '24h';
  const minMag = Number.isFinite(Number(req.query.minmag)) ? Number(req.query.minmag) : 2.5;
  const bbox = bboxDesdeQuery(req.query);
  const cacheKey = `${range}:${minMag}:${JSON.stringify(bbox)}`;

  const cached = cacheSismos.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return res.json(cached.data);
  }

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - RANGES_MS[range]);

  const [usgsResult, emscResult] = await Promise.allSettled([
    fetchUSGS(startTime, endTime, minMag, bbox),
    fetchEMSC(startTime, endTime, minMag, bbox),
  ]);

  const errores = [];
  let eventos = [];

  if (usgsResult.status === 'fulfilled') eventos = eventos.concat(usgsResult.value);
  else errores.push(`USGS: ${usgsResult.reason.message}`);

  if (emscResult.status === 'fulfilled') eventos = eventos.concat(emscResult.value);
  else errores.push(`EMSC: ${emscResult.reason.message}`);

  const data = {
    generado: new Date().toISOString(),
    region: bbox,
    rango: range,
    magnitud_minima: minMag,
    total: 0,
    errores,
    sismos: fusionarYDeduplicar(eventos),
  };
  data.total = data.sismos.length;

  cacheSismos.set(cacheKey, { at: Date.now(), data });
  res.json(data);
});

// =====================================================================
// INCENDIOS: NASA FIRMS (necesita FIRMS_API_KEY, gratuita por registro en
// https://firms.modaps.eosdis.nasa.gov/api/map_key/)
// =====================================================================

function parsearCSV(texto) {
  const lineas = texto.trim().split('\n');
  if (lineas.length < 2) return [];
  const encabezados = lineas[0].split(',').map((h) => h.trim());
  return lineas.slice(1).map((linea) => {
    const valores = linea.split(',');
    const fila = {};
    encabezados.forEach((h, i) => (fila[h] = valores[i]));
    return fila;
  });
}

app.get('/api/incendios', async (req, res) => {
  if (!FIRMS_API_KEY) {
    return res.json({
      generado: new Date().toISOString(),
      configurado: false,
      mensaje:
        'Falta configurar FIRMS_API_KEY (gratuita) para ver incendios activos. Ver README para conseguirla.',
      total: 0,
      incendios: [],
    });
  }

  const cached = cacheIncendios;
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return res.json(cached.data);
  }

  try {
    // VIIRS_SNPP_NRT: deteccion casi en tiempo real, resolucion ~375m, ultimas
    // 24 horas, cobertura mundial. Devuelve CSV.
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_API_KEY}/VIIRS_SNPP_NRT/world/1`;
    const respuesta = await fetch(url, { headers: { 'User-Agent': 'ojo-global/0.2' } });
    if (!respuesta.ok) throw new Error(`FIRMS respondio ${respuesta.status}`);
    const texto = await respuesta.text();

    // Si la key es invalida, FIRMS devuelve un mensaje de texto en vez de CSV.
    if (!texto.toLowerCase().includes('latitude')) {
      throw new Error('Respuesta inesperada de FIRMS (revisá que FIRMS_API_KEY sea válida)');
    }

    const filas = parsearCSV(texto);
    const incendios = filas
      .map((f, i) => {
        const lat = Number(f.latitude);
        const lon = Number(f.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          id: `firms:${f.acq_date}:${f.acq_time}:${i}`,
          lat,
          lon,
          confianza: f.confidence || null,
          brillo: Number(f.bright_ti4) || null,
          frp: Number(f.frp) || null, // potencia radiativa del fuego (MW), proxy de intensidad
          fecha: f.acq_date,
          hora_utc: f.acq_time,
          dia_noche: f.daynight === 'D' ? 'dia' : f.daynight === 'N' ? 'noche' : null,
          satelite: f.satellite || null,
        };
      })
      .filter(Boolean);

    const data = {
      generado: new Date().toISOString(),
      configurado: true,
      total: incendios.length,
      incendios,
    };
    cacheIncendios = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    res.json({
      generado: new Date().toISOString(),
      configurado: true,
      error: err.message,
      total: 0,
      incendios: [],
    });
  }
});

// =====================================================================
// OTRAS CATASTROFES: GDACS (Global Disaster Alert and Coordination System)
// Tsunamis, ciclones, inundaciones, volcanes y sequías — sin necesidad de
// API key. NO incluimos sismos de GDACS aca para no duplicar con USGS/EMSC.
//
// Nota honesta: esta integracion se escribio siguiendo la documentacion
// publica de gdacs.org, pero no se pudo probar contra una respuesta real
// desde este entorno de desarrollo (red restringida). Si algo no coincide
// con el formato real, revisa gdacs.org/gdacsapi o avisame para ajustarlo.
// =====================================================================

const TIPOS_GDACS = {
  TC: { nombre: 'Ciclón / huracán', emoji: '🌀' },
  FL: { nombre: 'Inundación', emoji: '🌊' },
  TS: { nombre: 'Tsunami', emoji: '🌊' },
  VO: { nombre: 'Volcán', emoji: '🌋' },
  DR: { nombre: 'Sequía', emoji: '🏜️' },
  WF: { nombre: 'Incendio forestal (alerta)', emoji: '🔥' },
};

app.get('/api/catastrofes', async (req, res) => {
  const cached = cacheCatastrofes;
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return res.json(cached.data);
  }

  try {
    const url =
      'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC,FL,TS,VO,DR,WF';
    const respuesta = await fetch(url, { headers: { 'User-Agent': 'ojo-global/0.2' } });
    if (!respuesta.ok) throw new Error(`GDACS respondio ${respuesta.status}`);
    const json = await respuesta.json();
    const features = json.features || json.Features || [];

    const catastrofes = features
      .map((f) => {
        const p = f.properties || f;
        const geom = f.geometry || {};
        const coords = geom.coordinates || [p.longitude, p.latitude];
        const lon = Number(coords[0] ?? p.longitude);
        const lat = Number(coords[1] ?? p.latitude);
        const tipo = p.eventtype || p.type;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !tipo || !TIPOS_GDACS[tipo]) return null;

        const info = TIPOS_GDACS[tipo];
        const hora = p.fromdate || p.todate || p.datemodified;

        return {
          id: `gdacs:${p.eventid || p.eventtype + '-' + lat + '-' + lon}`,
          tipo,
          tipo_nombre: info.nombre,
          emoji: info.emoji,
          nivel_alerta: (p.alertlevel || 'Green').toLowerCase(), // green | orange | red
          titulo: p.eventname || p.name || p.htmldescription || info.nombre,
          pais: p.country || p.iso3 || null,
          lat,
          lon,
          hora: hora ? Date.parse(hora) : null,
          url: p.url && p.url.report ? p.url.report : p.url || 'https://www.gdacs.org/',
        };
      })
      .filter(Boolean);

    const data = {
      generado: new Date().toISOString(),
      total: catastrofes.length,
      catastrofes,
    };
    cacheCatastrofes = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    res.json({
      generado: new Date().toISOString(),
      error: err.message,
      total: 0,
      catastrofes: [],
    });
  }
});

// =====================================================================
// Config publica para el frontend (tokens gratuitos que cada quien pone
// como variable de entorno — nunca se hardcodea ninguna key en el codigo).
// =====================================================================

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.APP_CONFIG = ${JSON.stringify({
      firmsConfigurado: Boolean(FIRMS_API_KEY),
    })};`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Ojo Global corriendo en http://localhost:${PORT}`);
  if (!FIRMS_API_KEY) {
    console.log('  (sin FIRMS_API_KEY: la capa de incendios va a estar vacía — ver README)');
  }
});
