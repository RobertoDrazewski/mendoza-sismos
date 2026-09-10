// Ojo Global — Alertas de Catástrofes (frontend)
// Mapa con Leaflet (satelital oscurecido + calles con glow cian — el mismo
// diseño "dark híbrido" que ya funcionaba bien). Combina varias fuentes
// publicas y gratuitas:
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
const UMBRAL_EVACUACION_KM = 300; // no sugerir "alejate" de algo que esta a medio mundo

const mapa = L.map('mapa', { zoomControl: false, worldCopyJump: true }).setView([10, 0], 2);
L.control.zoom({ position: 'bottomleft' }).addTo(mapa);

// Base "satelital oscura": imagenes reales de Esri World Imagery, oscurecidas
// y desaturadas por CSS (ver .capa-satelite en style.css) para el look hibrido.
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 18,
    className: 'capa-satelite',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
  }
).addTo(mapa);

// Calles/nombres de lugares por encima, en modo oscuro con un halo cian sutil
// (CARTO dark_only_labels: fondo transparente, solo calles y etiquetas).
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 18,
  className: 'capa-labels',
  attribution: '&copy; OpenStreetMap, &copy; CARTO',
}).addTo(mapa);

const capaSismos = L.layerGroup().addTo(mapa);
const capaIncendios = L.layerGroup().addTo(mapa);
const capaCatastrofes = L.layerGroup().addTo(mapa);
let capaEvacuacion = L.layerGroup().addTo(mapa);

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
let marcadorUbicacion = null;
let circuloPrecision = null;

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------

function colorPorMagnitud(mag) {
  if (mag >= 5) return '#e74c3c';
  if (mag >= 4) return '#e67e22';
  if (mag >= 3) return '#f1c40f';
  return '#2ecc71';
}

function clasePorMagnitud(mag) {
  if (mag >= 5) return 'sismo-rojo';
  if (mag >= 4) return 'sismo-naranja';
  if (mag >= 3) return 'sismo-amarillo';
  return 'sismo-verde';
}

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

function iconoEmoji(emoji, claseExtra) {
  return L.divIcon({
    className: `icono-emoji ${claseExtra || ''}`,
    html: `<span>${emoji}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// ---------------------------------------------------------------------
// Capa: sismos
// ---------------------------------------------------------------------

function render() {
  capaSismos.clearLayers();

  const ordenados = [...ultimosSismos].sort((a, b) => b.hora - a.hora);

  ordenados.forEach((s) => {
    const marcador = L.circleMarker([s.lat, s.lon], {
      radius: radioPorMagnitud(s.magnitud),
      color: colorPorMagnitud(s.magnitud),
      fillColor: colorPorMagnitud(s.magnitud),
      fillOpacity: 0.65,
      weight: 1.5,
      className: clasePorMagnitud(s.magnitud),
    });

    marcador.bindPopup(`
      <strong>M${s.magnitud.toFixed(1)}</strong> — ${s.lugar}<br/>
      ${formatearHora(s.hora)}<br/>
      Profundidad: ${s.profundidad_km ? s.profundidad_km.toFixed(1) + ' km' : 'sin dato'}<br/>
      ${miUbicacion ? textoDistancia(s.lat, s.lon) + '<br/>' : ''}
      Fuente: ${s.fuentes.join(' + ')}<br/>
      <a href="${s.url}" target="_blank" rel="noopener">Ver detalle</a>
    `);
    marcador.addTo(capaSismos);
  });

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
      alertarSismoNuevo(nuevos[0]);
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
      alertarSismoNuevo(sismo);
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

    capaIncendios.clearLayers();
    ultimosIncendios.forEach((f) => {
      const marcador = L.marker([f.lat, f.lon], { icon: iconoEmoji('🔥', 'icono-fuego') });
      marcador.bindPopup(
        `<strong>Foco de incendio activo</strong>${f.frp ? ` — potencia ${Math.round(f.frp)} MW` : ''}<br/>` +
        `${f.fecha || ''} ${f.hora_utc || ''} UTC<br/>${miUbicacion ? textoDistancia(f.lat, f.lon) : ''}`
      );
      marcador.addTo(capaIncendios);
    });

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

    capaCatastrofes.clearLayers();
    ultimasCatastrofes.forEach((c) => {
      const marcador = L.marker([c.lat, c.lon], {
        icon: iconoEmoji(c.emoji, `icono-catastrofe alerta-${c.nivel_alerta}`),
      });
      marcador.bindPopup(
        `<strong>${c.tipo_nombre}</strong><br/>${c.titulo}<br/>${c.pais || ''}<br/>` +
        `${formatearHora(c.hora)}<br/>${miUbicacion ? textoDistancia(c.lat, c.lon) + '<br/>' : ''}` +
        `<a href="${c.url}" target="_blank" rel="noopener">Ver detalle</a>`
      );
      marcador.addTo(capaCatastrofes);
    });

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
  }));
  const deIncendios = ultimosIncendios.map((f) => ({
    tipo: 'incendio', icono: '🔥',
    titulo: 'Foco de incendio activo' + (f.frp ? ` (potencia ${Math.round(f.frp)} MW)` : ''),
    lat: f.lat, lon: f.lon, hora: horaDesdeFIRMS(f.fecha, f.hora_utc),
  }));
  const deCatastrofes = ultimasCatastrofes.map((c) => ({
    tipo: 'catastrofe', icono: c.emoji, titulo: `${c.tipo_nombre} — ${c.titulo}`, lat: c.lat, lon: c.lon, hora: c.hora,
  }));

  eventosCombinados = [...deSismos, ...deIncendios, ...deCatastrofes].sort((a, b) => (b.hora || 0) - (a.hora || 0));

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
  capaEvacuacion.clearLayers();

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

  const destino = destinoDesdeRumbo(miUbicacion.lat, miUbicacion.lon, direccionGrados, 60);
  L.polyline(
    [[miUbicacion.lat, miUbicacion.lon], [destino.lat, destino.lon]],
    { className: 'linea-evacuacion', color: '#00e5ff', weight: 3, opacity: 0.85 }
  ).addTo(capaEvacuacion);
}

// ---------------------------------------------------------------------
// "Mi ubicacion": geolocalizacion + distancia real + centrado
// ---------------------------------------------------------------------

function actualizarMarcadorUbicacion() {
  if (marcadorUbicacion) mapa.removeLayer(marcadorUbicacion);
  if (circuloPrecision) mapa.removeLayer(circuloPrecision);

  marcadorUbicacion = L.circleMarker([miUbicacion.lat, miUbicacion.lon], {
    radius: 8,
    color: '#00e5ff',
    fillColor: '#00e5ff',
    fillOpacity: 0.9,
    weight: 2,
    className: 'marcador-ubicacion',
  }).addTo(mapa).bindPopup('Estás acá (aproximado)');

  circuloPrecision = L.circle([miUbicacion.lat, miUbicacion.lon], {
    radius: miUbicacion.precision || 500,
    color: '#00e5ff',
    weight: 1,
    fillOpacity: 0.07,
  }).addTo(mapa);
}

function pedirUbicacion({ boton, centrar = true, esAutomatico = false, zoom = 9 } = {}) {
  if (!navigator.geolocation) {
    if (!esAutomatico) alert('Tu navegador no soporta geolocalización.');
    return;
  }
  if (boton) boton.classList.add('activo');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      miUbicacion = { lat: pos.coords.latitude, lon: pos.coords.longitude, precision: pos.coords.accuracy };
      actualizarMarcadorUbicacion();
      if (centrar) mapa.flyTo([miUbicacion.lat, miUbicacion.lon], Math.max(mapa.getZoom(), zoom));
      reconstruirCombinadoYRenderPanel();
    },
    (err) => {
      if (boton) boton.classList.remove('activo');
      if (!esAutomatico) {
        alert('No pudimos obtener tu ubicación: ' + err.message);
      } else {
        console.warn('No se pudo detectar la ubicación automáticamente', err.message);
      }
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

const ControlUbicacion = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const btn = L.DomUtil.create('a', 'control-mapa', div);
    btn.href = '#';
    btn.title = 'Ver mi ubicación y la distancia a cada evento';
    btn.innerHTML = '📍';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    L.DomEvent.on(btn, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      pedirUbicacion({ boton: btn });
    });
    return div;
  },
});
mapa.addControl(new ControlUbicacion());

// ---------------------------------------------------------------------
// Capas: checkboxes
// ---------------------------------------------------------------------

document.getElementById('capa-incendios').addEventListener('change', (e) => {
  if (e.target.checked) capaIncendios.addTo(mapa);
  else mapa.removeLayer(capaIncendios);
});
document.getElementById('capa-catastrofes').addEventListener('change', (e) => {
  if (e.target.checked) capaCatastrofes.addTo(mapa);
  else mapa.removeLayer(capaCatastrofes);
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

const ControlSOS = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const btn = L.DomUtil.create('a', 'control-mapa control-sos', div);
    btn.href = '#';
    btn.title = 'Números de emergencia y compartir ubicación';
    btn.innerHTML = '🆘';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    L.DomEvent.on(btn, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      abrirSOS();
    });
    return div;
  },
});
mapa.addControl(new ControlSOS());

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
    (err) => alert('No pudimos obtener tu ubicación: ' + err.message),
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
  mapa.on('click dragstart', () => {
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
pedirUbicacion({ centrar: true, esAutomatico: true, zoom: 9 });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // si falla el registro, la app sigue funcionando igual, solo sin
    // instalacion PWA offline.
  });
}
