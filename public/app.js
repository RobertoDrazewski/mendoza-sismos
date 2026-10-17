// Ojo Global — Alertas de Catástrofes (frontend)
// Mapa: globo 3D con imagenes satelitales reales (MapLibre GL, ver globo.js) —
// al acercar el zoom se ve el mapa real, no una esfera decorativa.
// Combina varias fuentes publicas y gratuitas:
//   - Sismos:    /api/sismos (USGS + EMSC fusionados) + websocket EMSC en vivo
//   - Incendios: /api/incendios (NASA FIRMS — necesita FIRMS_API_KEY, ver README)
//   - Otras:     /api/catastrofes (GDACS: tsunamis, ciclones, inundaciones, volcanes)
//
// Al abrir la app, si el navegador te da permiso, el mapa hace zoom directo
// a tu ubicación (geolocalizacion). Si no, arranca con una vista global.
//
// IMPORTANTE: esto avisa apenas las fuentes CONFIRMAN un evento, nunca en el
// instante exacto en que empieza. No reemplaza a las Alertas de Sismos de
// Android ni a los sistemas oficiales de alerta de tsunami de cada pais.

const REFRESCO_SISMOS_MS = 60 * 1000;
const REFRESCO_OTRAS_MS = 5 * 60 * 1000; // incendios/catastrofes cambian mas lento
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const MENDOZA = { lat: -32.8908, lon: -68.8272 };
const UMBRAL_EVACUACION_KM = 150; // no sugerir "alejate" de algo que esta a medio mundo
const MAGNITUD_MIN_EVACUACION = 4.0; // un sismo M2.5-3.9 casi nunca se siente: no amerita "sugerencia de evacuacion"
const UMBRAL_ALERTA_KM = 500; // sonido/banner/notificacion solo para sismos nuevos dentro de este radio

// Punto de referencia para "cerca"/"lejos": tu ubicacion real si la diste,
// si no Mendoza (la base de la app) — nunca "en todo el mundo a la vez".
function referenciaDistancia() {
  return miUbicacion || MENDOZA;
}

// Mapa: globo 3D (ver globo.js), no mas tiles de Esri/CARTO. GlobeMap.init
// recibe un callback que arma el HTML del popup cuando se toca un pin —
// el contenido es el mismo que antes vivia en cada bindPopup() de Leaflet.
const mapa = GlobeMap;
mapa.init(document.getElementById('mapa'), { onPinClick: armarPopupPin });

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
let ultimosSismos = [];
let ultimosIncendios = [];
let ultimasCatastrofes = [];
let eventosCombinados = [];

let regionBBox = null;
let idsVistos = new Set();
let primeraCargaCompleta = false;

let miUbicacion = null;

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------

function colorPorMagnitud(mag) {
  if (mag >= 5) return '#e74c3c';
  if (mag >= 4) return '#e67e22';
  if (mag >= 3) return '#f1c40f';
  return '#2ecc71';
}

// Radio del circulo en pixeles (circle-radius del layer de sismos). Clamp
// para que un M1 no desaparezca y un M9 no tape el mapa.
function radioPorMagnitud(mag) {
  return Math.max(5, mag * 4);
}

function colorPorAlerta(nivel) {
  if (nivel === 'red') return '#e74c3c';
  if (nivel === 'orange') return '#e67e22';
  return '#f1c40f';
}

function formatearHora(epochMs) {
  if (!epochMs) return 'hora desconocida';
  return new Date(epochMs).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'medium' });
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

function textoDistancia(lat, lon) {
  if (!miUbicacion) return '';
  const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, lat, lon);
  return `<span class="distancia">a ${Math.round(km)} km de vos</span>`;
}

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
    new Notification('Nuevo sismo detectado', { body: `M${sismo.magnitud.toFixed(1)} — ${sismo.lugar}` });
  }
}

// Alertar (sonido + banner + notificacion) solo tiene sentido para sismos
// que te podrian afectar a VOS — nunca para cualquier sismo en el mundo.
// Entre los sismos nuevos de este ciclo, devuelve el mas cercano a tu
// ubicacion (o a Mendoza si todavia no la diste) si esta dentro del radio
// de alerta; si ninguno califica, no hay nada que avisar.
function sismoNuevoMasCercano(lista) {
  const ref = referenciaDistancia();
  let mejor = null;
  let mejorKm = Infinity;
  lista.forEach((s) => {
    const km = distanciaKm(ref.lat, ref.lon, s.lat, s.lon);
    if (km <= UMBRAL_ALERTA_KM && km < mejorKm) {
      mejorKm = km;
      mejor = s;
    }
  });
  return mejor;
}

function estaCercaParaAlertar(lat, lon) {
  const ref = referenciaDistancia();
  return distanciaKm(ref.lat, ref.lon, lat, lon) <= UMBRAL_ALERTA_KM;
}

// Arma el HTML de cada tipo de popup — mismo contenido que antes tenian los
// bindPopup() de Leaflet, ahora mostrado en el popup flotante del globo
// (ver GlobeMap.onPinClick / .globo-popup en style.css).
function armarPopupPin(tipo, raw) {
  if (tipo === 'sismo') {
    const s = raw;
    return `
      <strong>M${s.magnitud.toFixed(1)}</strong> — ${s.lugar}<br/>
      ${formatearHora(s.hora)}<br/>
      Profundidad: ${s.profundidad_km ? s.profundidad_km.toFixed(1) + ' km' : 'sin dato'}<br/>
      ${miUbicacion ? textoDistancia(s.lat, s.lon) + '<br/>' : ''}
      Fuente: ${s.fuentes.join(' + ')}<br/>
      <a href="${s.url}" target="_blank" rel="noopener">Ver detalle</a>
    `;
  }
  if (tipo === 'incendio') {
    const f = raw;
    return (
      `<strong>Foco de incendio activo</strong>${f.frp ? ` — potencia ${Math.round(f.frp)} MW` : ''}<br/>` +
      `${f.fecha || ''} ${f.hora_utc || ''} UTC<br/>${miUbicacion ? textoDistancia(f.lat, f.lon) : ''}`
    );
  }
  if (tipo === 'catastrofe') {
    const c = raw;
    return (
      `<strong>${c.tipo_nombre}</strong><br/>${c.titulo}<br/>${c.pais || ''}<br/>` +
      `${formatearHora(c.hora)}<br/>${miUbicacion ? textoDistancia(c.lat, c.lon) + '<br/>' : ''}` +
      `<a href="${c.url}" target="_blank" rel="noopener">Ver detalle</a>`
    );
  }
  if (tipo === 'ubicacion') {
    return 'Estás acá (aproximado)';
  }
  return null;
}

// ---------------------------------------------------------------------
// Capa: sismos
// ---------------------------------------------------------------------

function render() {
  const ordenados = [...ultimosSismos].sort((a, b) => b.hora - a.hora);

  mapa.setSismos(ordenados.map((s) => ({
    lat: s.lat,
    lon: s.lon,
    color: colorPorMagnitud(s.magnitud),
    radio: radioPorMagnitud(s.magnitud),
    raw: s,
  })));

  reconstruirCombinadoYRenderPanel();

  const contadorMovil = document.getElementById('contador-movil');
  if (contadorMovil) contadorMovil.textContent = ordenados.length;
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
      const cercano = sismoNuevoMasCercano(nuevos);
      if (cercano) alertarSismoNuevo(cercano);
    }
    primeraCargaCompleta = true;

    render();

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
  return lat >= regionBBox.minLat && lat <= regionBBox.maxLat && lon >= regionBBox.minLon && lon <= regionBBox.maxLon;
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

  if (!unid || lat === undefined || lon === undefined || !time || Number.isNaN(mag)) return null;

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
      render();
      return;
    }

    if (!estaDentroDeLaRegion(sismo.lat, sismo.lon) || sismo.magnitud < minmag) return;

    const yaExistia = ultimosSismos.some((s) => s.id === sismo.id);
    ultimosSismos = ultimosSismos.filter((s) => s.id !== sismo.id);
    ultimosSismos.push(sismo);
    render();

    if (!yaExistia && !idsVistos.has(sismo.id) && primeraCargaCompleta) {
      idsVistos.add(sismo.id);
      if (estaCercaParaAlertar(sismo.lat, sismo.lon)) alertarSismoNuevo(sismo);
    }
  };

  socketEMSC.onerror = () => ponerEstadoVivo('reconectando', 'reconectando');
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

function horaDesdeFIRMS(fecha, horaUtc) {
  if (!fecha || !horaUtc) return null;
  const limpio = String(horaUtc).padStart(4, '0');
  const parseado = Date.parse(`${fecha}T${limpio.slice(0, 2)}:${limpio.slice(2)}:00Z`);
  return Number.isNaN(parseado) ? null : parseado;
}

async function cargarIncendios() {
  try {
    const res = await fetch('/api/incendios');
    const data = await res.json();
    ultimosIncendios = data.incendios || [];

    mapa.setIncendios(ultimosIncendios.map((f) => ({ lat: f.lat, lon: f.lon, raw: f })));

    const nota = document.getElementById('nota-incendios');
    if (!data.configurado) {
      if (nota) nota.textContent = '🔥 Incendios: falta configurar FIRMS_API_KEY (gratis) — ver README.';
    } else if (data.error) {
      if (nota) nota.textContent = `🔥 Incendios: no se pudo actualizar (${data.error}).`;
    } else if (nota) {
      nota.textContent = `🔥 ${data.total} incendios activos detectados en las últimas 24 h (NASA FIRMS).`;
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

    mapa.setCatastrofes(ultimasCatastrofes.map((c) => ({
      lat: c.lat, lon: c.lon, emoji: c.emoji, colorHalo: colorPorAlerta(c.nivel_alerta), raw: c,
    })));

    const nota = document.getElementById('nota-catastrofes');
    if (nota) {
      nota.textContent = data.error
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

function reconstruirCombinadoYRenderPanel() {
  const deSismos = ultimosSismos.map((s) => ({
    tipo: 'sismo', icono: '🔴', titulo: `M${s.magnitud.toFixed(1)} — ${s.lugar}`, lat: s.lat, lon: s.lon, hora: s.hora,
    magnitud: s.magnitud,
  }));
  const deIncendios = ultimosIncendios.map((f) => ({
    tipo: 'incendio', icono: '🔥',
    titulo: 'Foco de incendio activo' + (f.frp ? ` (potencia ${Math.round(f.frp)} MW)` : ''),
    lat: f.lat, lon: f.lon, hora: horaDesdeFIRMS(f.fecha, f.hora_utc),
  }));
  const deCatastrofes = ultimasCatastrofes.map((c) => ({
    tipo: 'catastrofe', icono: c.emoji, titulo: `${c.tipo_nombre} — ${c.titulo}`, lat: c.lat, lon: c.lon, hora: c.hora,
  }));

  // El historico muestra primero lo mas cercano a vos (o a Mendoza si todavia
  // no sabemos donde estas) — no lo mas reciente. Funciona en cualquier parte
  // del mundo porque la referencia es tu ubicacion real, no algo fijo.
  const ref = referenciaDistancia();
  eventosCombinados = [...deSismos, ...deIncendios, ...deCatastrofes].sort(
    (a, b) => distanciaKm(ref.lat, ref.lon, a.lat, a.lon) - distanciaKm(ref.lat, ref.lon, b.lat, b.lon)
  );

  const contadorMapa = document.getElementById('mapa-eventos-count');
  if (contadorMapa) contadorMapa.textContent = `${eventosCombinados.length} EVENTOS DETECTADOS`;
  const contadorMovil = document.getElementById('contador-movil');
  if (contadorMovil) contadorMovil.textContent = String(eventosCombinados.length);
  actualizarLista();
  actualizarMasCercano();
  actualizarSugerenciaEvacuacion();
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

// Sugerencia de evacuacion: HEURISTICA, no una ruta oficial.
function actualizarSugerenciaEvacuacion() {
  const el = document.getElementById('sugerencia-evacuacion');

  if (!miUbicacion || eventosCombinados.length === 0) {
    mapa.setEvacuacionLinea(null);
    el.classList.add('oculto');
    return;
  }

  let masCercano = null;
  let minKm = Infinity;
  eventosCombinados.forEach((e) => {
    // Un sismo chico (M2.5-3.9) casi nunca se siente y no amerita "alejate" —
    // solo cuenta para esta sugerencia si es M4+ (incendios/catastrofes de
    // GDACS ya vienen filtrados como significativos por la fuente).
    if (e.tipo === 'sismo' && (e.magnitud || 0) < MAGNITUD_MIN_EVACUACION) return;
    const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, e.lat, e.lon);
    if (km < minKm) {
      minKm = km;
      masCercano = e;
    }
  });

  if (!masCercano || minKm > UMBRAL_EVACUACION_KM) {
    mapa.setEvacuacionLinea(null);
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

  const destino = destinoDesdeRumbo(miUbicacion.lat, miUbicacion.lon, direccionGrados, 60);
  // El globo dibuja el arco + la etiqueta permanente "🧭" en la punta.
  mapa.setEvacuacionLinea({ from: miUbicacion, to: destino });
}

// ---------------------------------------------------------------------
// "Mi ubicacion": geolocalizacion + distancia real + centrado
// ---------------------------------------------------------------------

function actualizarMarcadorUbicacion() {
  mapa.setMiUbicacion(miUbicacion);
}

function pedirUbicacion({ boton, centrar = true, esAutomatico = false } = {}) {
  if (!navigator.geolocation) {
    if (!esAutomatico) alert('Tu navegador no soporta geolocalización.');
    return;
  }
  if (boton) boton.classList.add('activo');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      miUbicacion = { lat: pos.coords.latitude, lon: pos.coords.longitude, precision: pos.coords.accuracy };
      actualizarMarcadorUbicacion();
      if (centrar) mapa.focusOn(miUbicacion.lat, miUbicacion.lon);
      reconstruirCombinadoYRenderPanel();
    },
    (err) => {
      if (boton) boton.classList.remove('activo');
      if (!esAutomatico) {
        alert(mensajeErrorUbicacion(err));
      } else {
        console.warn('No se pudo detectar la ubicación automáticamente', err.message);
      }
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
  );
}

// Mensaje de error mas util que el generico del navegador: el motivo mas
// comun de "timeout" en desktop es que el sistema operativo tiene apagado
// el permiso de ubicacion para el navegador (no algo que la app pueda
// arreglar), asi que se lo decimos directo en vez de solo repetir el error.
function mensajeErrorUbicacion(err) {
  if (err.code === err.PERMISSION_DENIED) {
    return 'No pudimos obtener tu ubicación: le negaste el permiso al navegador. Para reactivarlo, revisá los permisos de ubicación del sitio (ícono de candado en la barra de direcciones).';
  }
  if (err.code === err.TIMEOUT) {
    return 'No pudimos obtener tu ubicación a tiempo. En computadoras esto suele pasar porque el sistema operativo tiene apagado el permiso de ubicación para el navegador (en Mac: Preferencias del Sistema → Privacidad y seguridad → Localización → activar para tu navegador). Probá de nuevo, o desde el celular donde el GPS suele responder más rápido.';
  }
  return 'No pudimos obtener tu ubicación: ' + err.message;
}

const botonUbicarMapa = document.getElementById('boton-ubicar-mapa');
if (botonUbicarMapa) {
  botonUbicarMapa.addEventListener('click', () => pedirUbicacion({ boton: botonUbicarMapa }));
}

// ---------------------------------------------------------------------
// Capas: checkboxes
// ---------------------------------------------------------------------

document.getElementById('capa-sismos').addEventListener('change', (e) => {
  mapa.setCapaVisible('sismos', e.target.checked);
});
document.getElementById('capa-incendios').addEventListener('change', (e) => {
  mapa.setCapaVisible('incendios', e.target.checked);
});
document.getElementById('capa-catastrofes').addEventListener('change', (e) => {
  mapa.setCapaVisible('catastrofes', e.target.checked);
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

const botonSosMapa = document.getElementById('boton-sos-mapa');
if (botonSosMapa) botonSosMapa.addEventListener('click', abrirSOS);

document.getElementById('boton-sos-top').addEventListener('click', abrirSOS);
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
    (err) => alert(mensajeErrorUbicacion(err)),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
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
  mapa.onInteractionStart(() => {
    panelLateral.classList.remove('abierto');
  });
}

// ---------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------

if (window.Notification && Notification.permission === 'default') {
  Notification.requestPermission();
}

mostrarAlertaSegunPlataforma();
cargarSismos();
setInterval(cargarSismos, REFRESCO_SISMOS_MS);
conectarEMSC();

cargarIncendios();
setInterval(cargarIncendios, REFRESCO_OTRAS_MS);

cargarCatastrofes();
setInterval(cargarCatastrofes, REFRESCO_OTRAS_MS);

// Si el navegador ya tiene permiso (o lo concede al toque), centramos solos;
// si no, el mapa se queda en la vista global y el usuario usa el botón 📍.
pedirUbicacion({ centrar: true, esAutomatico: true });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // si falla el registro, la app sigue funcionando igual, solo sin
    // instalacion PWA offline.
  });
}


// Accesibilidad: cerrar el diálogo de emergencia con Escape.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cerrarSOS();
});
