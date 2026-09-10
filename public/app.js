// Ojo Global — Alertas de Catástrofes (frontend)
// Globo 3D con CesiumJS. Combina varias fuentes publicas y gratuitas:
//   - Sismos:    /api/sismos (USGS + EMSC fusionados) + websocket EMSC en vivo
//   - Incendios: /api/incendios (NASA FIRMS — necesita FIRMS_API_KEY, ver README)
//   - Otras:     /api/catastrofes (GDACS: tsunamis, ciclones, inundaciones, volcanes)
//
// Al abrir la app, el globo gira hasta detectar tu ubicacion (geolocalizacion
// del navegador) y hace zoom ahi. Si no se puede detectar, hace zoom a
// Mendoza (el origen de este proyecto) como respaldo.
//
// IMPORTANTE: esto avisa apenas las fuentes CONFIRMAN un evento, nunca en el
// instante exacto en que empieza. No reemplaza a las Alertas de Sismos de
// Android ni a los sistemas oficiales de alerta de tsunami de cada pais.

const REFRESCO_SISMOS_MS = 60 * 1000;
const REFRESCO_OTRAS_MS = 5 * 60 * 1000; // incendios/catastrofes cambian mas lento
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const MENDOZA = { lat: -32.8908, lon: -68.8272 };
const UMBRAL_EVACUACION_KM = 300; // no sugerir "alejate" de algo que esta a medio mundo

// ---------------------------------------------------------------------
// Config que manda el servidor (tokens gratuitos opcionales, ver server.js)
// ---------------------------------------------------------------------
const CONFIG = window.APP_CONFIG || { cesiumIonToken: '', firmsConfigurado: false };
Cesium.Ion.defaultAccessToken = CONFIG.cesiumIonToken || undefined;

// ---------------------------------------------------------------------
// Estado general
// ---------------------------------------------------------------------
let viewer = null;
let girandoGlobo = false;

let ultimosSismos = [];        // crudos, tal como los manda /api/sismos
let ultimosIncendios = [];
let ultimasCatastrofes = [];
let eventosCombinados = [];    // normalizados, para la lista y el calculo de "mas cercano"

let regionBBox = null;         // bbox que manda el backend (hoy: global)
let idsVistos = new Set();
let primeraCargaCompleta = false;

let miUbicacion = null;        // { lat, lon, precision }
let entidadUbicacion = null;
let entidadFlechaEvacuacion = null;

let dsSismos, dsIncendios, dsCatastrofes; // Cesium.CustomDataSource por capa

// ---------------------------------------------------------------------
// Utilidades generales
// ---------------------------------------------------------------------

function colorPorMagnitud(mag) {
  if (mag >= 5) return '#e74c3c';
  if (mag >= 4) return '#e67e22';
  if (mag >= 3) return '#f1c40f';
  return '#2ecc71';
}

function colorPorAlerta(nivel) {
  if (nivel === 'red') return '#e74c3c';
  if (nivel === 'orange') return '#e67e22';
  return '#f1c40f'; // green de GDACS igual se muestra en amarillo tenue: sigue siendo una alerta activa
}

function formatearHora(epochMs) {
  if (!epochMs) return 'hora desconocida';
  return new Date(epochMs).toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function distanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Rumbo (bearing) inicial en grados desde el punto 1 hacia el punto 2.
function rumbo(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function rumboATexto(deg) {
  const direcciones = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
  return direcciones[Math.round(deg / 45) % 8];
}

function textoDistancia(lat, lon) {
  if (!miUbicacion) return '';
  const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, lat, lon);
  return `<span class="distancia">a ${Math.round(km)} km de vos</span>`;
}

// Beep corto generado con Web Audio API — no hace falta ningun archivo externo.
function reproducirAlerta() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch (e) {
    console.warn('No se pudo reproducir el sonido de alerta', e);
  }
}

function mostrarBanner(sismo) {
  const banner = document.getElementById('banner-alerta');
  banner.innerHTML = `⚠️ <strong>Sismo nuevo:</strong> M${sismo.magnitud.toFixed(1)} — ${sismo.lugar} (${formatearHora(sismo.hora)})`;
  banner.classList.remove('oculto');
}

function alertarSismoNuevo(sismo) {
  reproducirAlerta();
  mostrarBanner(sismo);
  if (window.Notification && Notification.permission === 'granted') {
    new Notification('Nuevo sismo detectado', {
      body: `M${sismo.magnitud.toFixed(1)} — ${sismo.lugar}`,
    });
  }
}

// ---------------------------------------------------------------------
// Texturas "glow" generadas en canvas (Cesium dibuja en WebGL, asi que el
// glow cian/de colores no se puede lograr con CSS como en Leaflet: se
// "hornea" directamente en la imagen del billboard).
// ---------------------------------------------------------------------

const cacheTexturas = new Map();

function crearTexturaGlow(colorHex, emoji) {
  const clave = `${colorHex}|${emoji || ''}`;
  if (cacheTexturas.has(clave)) return cacheTexturas.get(clave);

  const tam = 64;
  const canvas = document.createElement('canvas');
  canvas.width = tam;
  canvas.height = tam;
  const ctx = canvas.getContext('2d');
  const cx = tam / 2;
  const cy = tam / 2;

  const gradiente = ctx.createRadialGradient(cx, cy, 0, cx, cy, tam / 2);
  gradiente.addColorStop(0, colorHex);
  gradiente.addColorStop(0.35, colorHex + 'cc');
  gradiente.addColorStop(1, colorHex + '00');
  ctx.fillStyle = gradiente;
  ctx.beginPath();
  ctx.arc(cx, cy, tam / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, tam / 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;

  if (emoji) {
    ctx.font = `${Math.floor(tam * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, cx, cy - 1);
  }

  const url = canvas.toDataURL();
  cacheTexturas.set(clave, url);
  return url;
}

// ---------------------------------------------------------------------
// Inicializacion del globo Cesium
// ---------------------------------------------------------------------

async function inicializarViewer() {
  const opcionesBase = {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  };

  if (CONFIG.cesiumIonToken) {
    // Con token de Cesium Ion: terreno + imagenes de calidad de Ion.
    viewer = new Cesium.Viewer('cesiumContainer', opcionesBase);
    try {
      const terreno = await Cesium.createWorldTerrainAsync();
      viewer.terrainProvider = terreno;
    } catch (e) {
      console.warn('No se pudo cargar el terreno de Cesium Ion, sigo con terreno plano.', e);
    }
    try {
      const tileset3D = await Cesium.createGooglePhotorealistic3DTileset();
      viewer.scene.primitives.add(tileset3D);
    } catch (e) {
      console.warn('No se pudieron cargar los 3D Tiles fotorrealistas (puede que tu cuenta de Ion no los tenga habilitados).', e);
    }
  } else {
    // Sin token: globo 3D igual, con imagenes libres de OpenStreetMap (sin
    // terreno/edificios fotorrealistas, pero sin necesitar ninguna cuenta).
    viewer = new Cesium.Viewer('cesiumContainer', {
      ...opcionesBase,
      imageryProvider: new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    });
  }

  viewer.scene.globe.enableLighting = true; // dia/noche real sobre el globo, se ve mejor
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#05080c');
  viewer.scene.skyAtmosphere.hueShift = -0.03;
  viewer.scene.skyAtmosphere.saturationShift = -0.2;
  viewer.clock.shouldAnimate = true; // para que el terminador dia/noche se mueva

  dsSismos = new Cesium.CustomDataSource('sismos');
  dsIncendios = new Cesium.CustomDataSource('incendios');
  dsCatastrofes = new Cesium.CustomDataSource('catastrofes');
  await Promise.all([
    viewer.dataSources.add(dsSismos),
    viewer.dataSources.add(dsIncendios),
    viewer.dataSources.add(dsCatastrofes),
  ]);

  // Vista inicial: todo el planeta, antes de arrancar el giro.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-58, -10, 22000000),
  });
}

function empezarGiroGlobo() {
  girandoGlobo = true;
  viewer.scene.postRender.addEventListener(tickGiroGlobo);
}

function tickGiroGlobo() {
  if (!girandoGlobo) return;
  viewer.scene.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0007);
}

function detenerGiroGlobo() {
  girandoGlobo = false;
  viewer.scene.postRender.removeEventListener(tickGiroGlobo);
}

function volarHacia(lat, lon, alturaMetros = 25000) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, alturaMetros),
    duration: 3,
  });
}

// ---------------------------------------------------------------------
// Capa: sismos (USGS + EMSC)
// ---------------------------------------------------------------------

function claveNuevo(hora) {
  return Date.now() - hora < 5 * 60 * 1000; // "nuevo" durante 5 minutos
}

function dibujarSismos() {
  dsSismos.entities.removeAll();
  ultimosSismos.forEach((s) => {
    const color = colorPorMagnitud(s.magnitud);
    const esNuevo = claveNuevo(s.hora);
    dsSismos.entities.add({
      id: `sismo:${s.id}`,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
      billboard: {
        image: crearTexturaGlow(color, ''),
        scale: esNuevo ? 0.85 : 0.6,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      description: `<strong>M${s.magnitud.toFixed(1)}</strong> — ${s.lugar}`,
      properties: { tipo: 'sismo', datos: s },
    });
  });
}

async function cargarSismos() {
  const rango = document.getElementById('rango').value;
  const minmag = document.getElementById('minmag').value;
  const estado = document.getElementById('estado');

  try {
    estado.textContent = 'actualizando...';
    const res = await fetch(`/api/sismos?range=${rango}&minmag=${minmag}`);
    const data = await res.json();
    regionBBox = data.region;

    const nuevos = data.sismos.filter((s) => !idsVistos.has(s.id));
    data.sismos.forEach((s) => idsVistos.add(s.id));

    ultimosSismos = data.sismos;

    if (primeraCargaCompleta && nuevos.length > 0) {
      alertarSismoNuevo(nuevos[0]);
    }
    primeraCargaCompleta = true;

    dibujarSismos();
    reconstruirCombinadoYRenderPanel();

    const hora = new Date(data.generado).toLocaleTimeString('es-AR');
    estado.textContent = `${data.total} sismos · actualizado ${hora}`;
    if (data.errores && data.errores.length) {
      console.warn('Errores al consultar fuentes de sismos:', data.errores);
      estado.textContent += ' (una fuente no respondió)';
    }
  } catch (err) {
    console.error(err);
    estado.textContent = 'error al actualizar';
  }
}

document.getElementById('rango').addEventListener('change', () => {
  idsVistos.clear();
  primeraCargaCompleta = false;
  cargarSismos();
});
document.getElementById('minmag').addEventListener('change', () => {
  idsVistos.clear();
  primeraCargaCompleta = false;
  cargarSismos();
});

// --- Websocket EMSC (tiempo casi real) -------------------------------

let socketEMSC = null;
let intentosReconexion = 0;

function estaDentroDeLaRegion(lat, lon) {
  if (!regionBBox) return true;
  return (
    lat >= regionBBox.minLat &&
    lat <= regionBBox.maxLat &&
    lon >= regionBBox.minLon &&
    lon <= regionBBox.maxLon
  );
}

function ponerEstadoVivo(estado, texto) {
  const el = document.getElementById('estado-vivo');
  const textoEl = document.getElementById('estado-vivo-texto');
  if (!el || !textoEl) return;
  el.classList.remove('conectado', 'reconectando');
  el.classList.add(estado);
  textoEl.textContent = texto;
}

function parsearMensajeEMSC(msg) {
  const accion = msg.action || 'insert';
  const feature = msg.data || msg;
  const props = feature.properties || feature;
  const geom = feature.geometry;
  const coords = geom ? (geom.geometry ? geom.geometry.coordinates : geom.coordinates) : null;

  const lat = props.lat ?? (coords ? coords[1] : undefined);
  const lon = props.lon ?? (coords ? coords[0] : undefined);
  const depth = props.depth ?? (coords ? coords[2] : undefined);
  const unid = props.unid || feature.id || props.id;
  const mag = Number(props.mag);
  const time = props.time ? Date.parse(props.time) : null;
  const lugar = props.flynn_region || props.region || 'Ubicación desconocida';

  if (!unid || lat === undefined || lon === undefined || !time || Number.isNaN(mag)) {
    return null;
  }

  return {
    accion,
    sismo: {
      id: `emsc:${unid}`,
      fuente: 'EMSC',
      magnitud: mag,
      lugar,
      lat,
      lon,
      profundidad_km: depth,
      hora: time,
      url: `https://www.seismicportal.eu/eventdetails.html?unid=${unid}`,
      fuentes: ['EMSC (en vivo)'],
    },
  };
}

function conectarEMSC() {
  try {
    socketEMSC = new WebSocket(EMSC_WS_URL);
  } catch (e) {
    console.warn('No se pudo abrir el websocket de EMSC', e);
    programarReconexion();
    return;
  }

  socketEMSC.onopen = () => {
    intentosReconexion = 0;
    ponerEstadoVivo('conectado', 'en vivo');
  };

  socketEMSC.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    const parseado = parsearMensajeEMSC(msg);
    if (!parseado) return;

    const { accion, sismo } = parseado;
    const minmag = Number(document.getElementById('minmag').value) || 0;

    if (accion === 'delete') {
      ultimosSismos = ultimosSismos.filter((s) => s.id !== sismo.id);
      dibujarSismos();
      reconstruirCombinadoYRenderPanel();
      return;
    }

    if (!estaDentroDeLaRegion(sismo.lat, sismo.lon) || sismo.magnitud < minmag) {
      return;
    }

    const yaExistia = ultimosSismos.some((s) => s.id === sismo.id);
    ultimosSismos = ultimosSismos.filter((s) => s.id !== sismo.id);
    ultimosSismos.push(sismo);
    dibujarSismos();
    reconstruirCombinadoYRenderPanel();

    if (!yaExistia && !idsVistos.has(sismo.id) && primeraCargaCompleta) {
      idsVistos.add(sismo.id);
      alertarSismoNuevo(sismo);
    }
  };

  socketEMSC.onerror = () => {
    ponerEstadoVivo('reconectando', 'reconectando');
  };

  socketEMSC.onclose = () => {
    ponerEstadoVivo('reconectando', 'reconectando');
    programarReconexion();
  };
}

function programarReconexion() {
  intentosReconexion += 1;
  const espera = Math.min(30000, 3000 * intentosReconexion);
  setTimeout(conectarEMSC, espera);
}

// ---------------------------------------------------------------------
// Capa: incendios (NASA FIRMS)
// ---------------------------------------------------------------------

async function cargarIncendios() {
  try {
    const res = await fetch('/api/incendios');
    const data = await res.json();
    ultimosIncendios = data.incendios || [];

    dsIncendios.entities.removeAll();
    ultimosIncendios.forEach((f) => {
      dsIncendios.entities.add({
        id: `incendio:${f.id}`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat),
        billboard: {
          image: crearTexturaGlow('#ff5722', '🔥'),
          scale: 0.55,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { tipo: 'incendio', datos: f },
      });
    });

    const notaIncendios = document.getElementById('nota-incendios');
    if (!data.configurado) {
      if (notaIncendios) notaIncendios.textContent = '🔥 Incendios: falta configurar FIRMS_API_KEY (gratis) — ver README.';
    } else if (data.error) {
      if (notaIncendios) notaIncendios.textContent = `🔥 Incendios: no se pudo actualizar (${data.error}).`;
    } else if (notaIncendios) {
      notaIncendios.textContent = `🔥 ${data.total} incendios activos detectados en las últimas 24 h (NASA FIRMS).`;
    }

    reconstruirCombinadoYRenderPanel();
  } catch (err) {
    console.error('Error al cargar incendios', err);
  }
}

// ---------------------------------------------------------------------
// Capa: otras catástrofes (GDACS)
// ---------------------------------------------------------------------

async function cargarCatastrofes() {
  try {
    const res = await fetch('/api/catastrofes');
    const data = await res.json();
    ultimasCatastrofes = data.catastrofes || [];

    dsCatastrofes.entities.removeAll();
    ultimasCatastrofes.forEach((c) => {
      dsCatastrofes.entities.add({
        id: `catastrofe:${c.id}`,
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
        billboard: {
          image: crearTexturaGlow(colorPorAlerta(c.nivel_alerta), c.emoji),
          scale: 0.6,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { tipo: 'catastrofe', datos: c },
      });
    });

    const notaCatastrofes = document.getElementById('nota-catastrofes');
    if (notaCatastrofes) {
      notaCatastrofes.textContent = data.error
        ? `🌊 Otras catástrofes: no se pudo actualizar (${data.error}).`
        : `🌊 ${data.total} alertas activas de GDACS (tsunamis, ciclones, inundaciones, volcanes).`;
    }

    reconstruirCombinadoYRenderPanel();
  } catch (err) {
    console.error('Error al cargar catástrofes GDACS', err);
  }
}

// ---------------------------------------------------------------------
// Panel lateral: lista combinada + "más cercano" + sugerencia de evacuación
// ---------------------------------------------------------------------

function horaDesdeFIRMS(fecha, horaUtc) {
  if (!fecha || !horaUtc) return null;
  const limpio = String(horaUtc).padStart(4, '0');
  const parseado = Date.parse(`${fecha}T${limpio.slice(0, 2)}:${limpio.slice(2)}:00Z`);
  return Number.isNaN(parseado) ? null : parseado;
}

function reconstruirCombinadoYRenderPanel() {
  const deSismos = ultimosSismos.map((s) => ({
    tipo: 'sismo',
    icono: '🔴',
    titulo: `M${s.magnitud.toFixed(1)} — ${s.lugar}`,
    lat: s.lat,
    lon: s.lon,
    hora: s.hora,
    url: s.url,
  }));
  const deIncendios = ultimosIncendios.map((f) => ({
    tipo: 'incendio',
    icono: '🔥',
    titulo: 'Foco de incendio activo' + (f.frp ? ` (potencia ${Math.round(f.frp)} MW)` : ''),
    lat: f.lat,
    lon: f.lon,
    hora: horaDesdeFIRMS(f.fecha, f.hora_utc),
    url: 'https://firms.modaps.eosdis.nasa.gov/',
  }));
  const deCatastrofes = ultimasCatastrofes.map((c) => ({
    tipo: 'catastrofe',
    icono: c.emoji,
    titulo: `${c.tipo_nombre} — ${c.titulo}`,
    lat: c.lat,
    lon: c.lon,
    hora: c.hora,
    url: c.url,
  }));

  eventosCombinados = [...deSismos, ...deIncendios, ...deCatastrofes].sort(
    (a, b) => (b.hora || 0) - (a.hora || 0)
  );

  actualizarLista();
  actualizarMasCercano();
  actualizarSugerenciaEvacuacion();

  const contadorMovil = document.getElementById('contador-movil');
  if (contadorMovil) contadorMovil.textContent = eventosCombinados.length;
}

function actualizarLista() {
  const contenedor = document.getElementById('lista');
  contenedor.innerHTML = '';
  eventosCombinados.slice(0, 30).forEach((e) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <span class="mag">${e.icono}</span>
      <span class="lugar">${e.titulo}</span>
      <span class="hora">${formatearHora(e.hora)}${miUbicacion ? ' · ' + textoDistancia(e.lat, e.lon) : ''}</span>
    `;
    contenedor.appendChild(div);
  });
}

function actualizarMasCercano() {
  const el = document.getElementById('mas-cercano');
  if (!miUbicacion || eventosCombinados.length === 0) {
    el.classList.add('oculto');
    return;
  }
  let masCercano = null;
  let minKm = Infinity;
  eventosCombinados.forEach((e) => {
    const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, e.lat, e.lon);
    if (km < minKm) {
      minKm = km;
      masCercano = e;
    }
  });
  if (!masCercano) {
    el.classList.add('oculto');
    return;
  }
  el.innerHTML = `📍 Lo más cercano a tu ubicación: <strong>${masCercano.icono} ${masCercano.titulo}</strong> a <strong>${Math.round(minKm)} km</strong>`;
  el.classList.remove('oculto');
}

// Sugerencia de evacuacion: HEURISTICA, no una ruta oficial. Calcula el
// rumbo desde el evento mas cercano hacia tu ubicacion, y sugiere seguir
// alejandote en esa misma direccion. Solo se muestra si el evento esta
// razonablemente cerca (ver UMBRAL_EVACUACION_KM).
function actualizarSugerenciaEvacuacion() {
  const el = document.getElementById('sugerencia-evacuacion');
  if (entidadFlechaEvacuacion) {
    viewer.entities.remove(entidadFlechaEvacuacion);
    entidadFlechaEvacuacion = null;
  }

  if (!miUbicacion || eventosCombinados.length === 0) {
    el.classList.add('oculto');
    return;
  }

  let masCercano = null;
  let minKm = Infinity;
  eventosCombinados.forEach((e) => {
    const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, e.lat, e.lon);
    if (km < minKm) {
      minKm = km;
      masCercano = e;
    }
  });

  if (!masCercano || minKm > UMBRAL_EVACUACION_KM) {
    el.classList.add('oculto');
    return;
  }

  const direccionGrados = rumbo(masCercano.lat, masCercano.lon, miUbicacion.lat, miUbicacion.lon);
  const direccionTexto = rumboATexto(direccionGrados);

  el.innerHTML = `
    🧭 <strong>Sugerencia de evacuación (no oficial):</strong> el evento más cercano
    (${masCercano.icono} ${masCercano.titulo}) está a ${Math.round(minKm)} km. Si tenés que moverte,
    una opción razonable es seguir alejándote hacia el <strong>${direccionTexto}</strong> — en dirección
    opuesta al evento. <span class="aviso-chico">Esto NO es una ruta de evacuación oficial: no existe un
    dataset público de rutas de evacuación para calcular una real. Seguí siempre las indicaciones de
    Defensa Civil o la autoridad local.</span>
  `;
  el.classList.remove('oculto');

  // Flecha visual en el globo: una linea corta desde tu ubicacion en la
  // direccion sugerida.
  const destKm = 60;
  const destino = destinoDesdeRumbo(miUbicacion.lat, miUbicacion.lon, direccionGrados, destKm);
  entidadFlechaEvacuacion = viewer.entities.add({
    id: 'flecha-evacuacion',
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        miUbicacion.lon, miUbicacion.lat,
        destino.lon, destino.lat,
      ]),
      width: 3,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.3,
        color: Cesium.Color.fromCssColorString('#00e5ff'),
      }),
      clampToGround: false,
    },
  });
}

function destinoDesdeRumbo(lat, lon, rumboDeg, km) {
  const R = 6371;
  const brng = (rumboDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(km / R) + Math.cos(lat1) * Math.sin(km / R) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(km / R) * Math.cos(lat1),
    Math.cos(km / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

// ---------------------------------------------------------------------
// "Mi ubicacion": geolocalizacion + giro/zoom del globo
// ---------------------------------------------------------------------

function actualizarEntidadUbicacion() {
  if (entidadUbicacion) viewer.entities.remove(entidadUbicacion);
  entidadUbicacion = viewer.entities.add({
    id: 'mi-ubicacion',
    position: Cesium.Cartesian3.fromDegrees(miUbicacion.lon, miUbicacion.lat),
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString('#00e5ff'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    description: 'Estás acá (aproximado)',
  });
}

function pedirUbicacion({ centrar = true, esAutomatico = false } = {}) {
  if (!navigator.geolocation) {
    detenerGiroGlobo();
    volarHacia(MENDOZA.lat, MENDOZA.lon, 900000);
    if (!esAutomatico) alert('Tu navegador no soporta geolocalización.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      miUbicacion = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        precision: pos.coords.accuracy,
      };
      actualizarEntidadUbicacion();
      detenerGiroGlobo();
      if (centrar) volarHacia(miUbicacion.lat, miUbicacion.lon, 400000);
      reconstruirCombinadoYRenderPanel();
    },
    (err) => {
      detenerGiroGlobo();
      volarHacia(MENDOZA.lat, MENDOZA.lon, 900000);
      if (!esAutomatico) {
        alert('No pudimos obtener tu ubicación: ' + err.message);
      } else {
        const estado = document.getElementById('estado');
        estado.textContent = 'No detectamos tu ubicación — mostrando Mendoza, el origen del proyecto.';
      }
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

document.getElementById('boton-ubicacion').addEventListener('click', () => pedirUbicacion());

// ---------------------------------------------------------------------
// Capas: checkboxes
// ---------------------------------------------------------------------

document.getElementById('capa-incendios').addEventListener('change', (e) => {
  dsIncendios.show = e.target.checked;
});
document.getElementById('capa-catastrofes').addEventListener('change', (e) => {
  dsCatastrofes.show = e.target.checked;
});

// ---------------------------------------------------------------------
// Panel de Emergencias (SOS)
// ---------------------------------------------------------------------

function abrirSOS() {
  document.getElementById('fondo-sos').classList.remove('oculto');
}

function cerrarSOS() {
  document.getElementById('fondo-sos').classList.add('oculto');
}

document.getElementById('boton-abrir-sos').addEventListener('click', abrirSOS);
document.getElementById('boton-abrir-sos-2').addEventListener('click', abrirSOS);
document.getElementById('boton-cerrar-sos').addEventListener('click', cerrarSOS);
document.getElementById('fondo-sos').addEventListener('click', (e) => {
  if (e.target.id === 'fondo-sos') cerrarSOS();
});

document.getElementById('boton-compartir-ubicacion').addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Tu navegador no soporta geolocalización.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const ahora = new Date().toLocaleString('es-AR');
      const texto =
        `🚨 Mi ubicación de emergencia (${ahora}):\n` +
        `https://www.google.com/maps?q=${latitude},${longitude}\n\n` +
        `Enviado desde Ojo Global`;

      if (navigator.share) {
        try {
          await navigator.share({ text: texto });
          return;
        } catch (e) {
          // el usuario cancelo el panel de compartir, seguimos al fallback
        }
      }
      window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank');
    },
    (err) => {
      alert('No pudimos obtener tu ubicación: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
});

// ---------------------------------------------------------------------
// Cartel de alerta temprana segun plataforma (Android/iPhone/otro)
// ---------------------------------------------------------------------

function mostrarAlertaSegunPlataforma() {
  const ua = navigator.userAgent || '';
  const esAndroid = /Android/i.test(ua);
  const esIOS = /iPhone|iPad|iPod/i.test(ua);
  const idAMostrar = esAndroid ? 'alerta-android' : esIOS ? 'alerta-ios' : 'alerta-otro';
  const el = document.getElementById(idAMostrar);
  if (el) el.classList.remove('oculto');
}

// ---------------------------------------------------------------------
// Panel deslizable en mobile
// ---------------------------------------------------------------------

const botonPanelMovil = document.getElementById('boton-panel-movil');
const panelLateral = document.getElementById('panel-lateral');
if (botonPanelMovil && panelLateral) {
  botonPanelMovil.addEventListener('click', () => {
    panelLateral.classList.toggle('abierto');
  });
}

// ---------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------

async function arrancar() {
  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  mostrarAlertaSegunPlataforma();

  await inicializarViewer();
  empezarGiroGlobo();

  // Aviso opcional sobre modo degradado sin token de Cesium Ion.
  if (!CONFIG.cesiumIonToken) {
    const estado = document.getElementById('estado');
    estado.title = 'Modo sin Cesium Ion: mapa base OpenStreetMap, sin 3D fotorrealista. Configurá CESIUM_ION_TOKEN para mejorarlo (ver README).';
  }

  cargarSismos();
  setInterval(cargarSismos, REFRESCO_SISMOS_MS);
  conectarEMSC();

  cargarIncendios();
  setInterval(cargarIncendios, REFRESCO_OTRAS_MS);

  cargarCatastrofes();
  setInterval(cargarCatastrofes, REFRESCO_OTRAS_MS);

  // Giro del globo hasta detectar ubicacion (o Mendoza como respaldo a los 10s).
  pedirUbicacion({ centrar: true, esAutomatico: true });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // si falla el registro, la app sigue funcionando igual, solo sin
      // instalacion PWA offline.
    });
  }
}

arrancar();
