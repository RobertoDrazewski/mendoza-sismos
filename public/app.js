// Mendoza en Vivo — Sismos (frontend)
// Mapa con Leaflet. Combina dos canales de datos:
//   1) Nuestro backend /api/sismos (USGS + EMSC fusionados), cada 60s — la
//      fuente de verdad, con historial.
//   2) El websocket publico de EMSC/SeismicPortal, en tiempo casi real —
//      para que un sismo nuevo aparezca en segundos y no haya que esperar
//      al proximo sondeo. Si el websocket se cae, seguimos andando con
//      el sondeo de 60s igual (ver REFRESCO_MS).
//
// IMPORTANTE (ver seccion "Cuando suena la alarma" en index.html): esto
// avisa apenas la red sismologica CONFIRMA un evento, nunca en el instante
// exacto en que empieza. No reemplaza a las Alertas de Sismos de Android.

const REFRESCO_MS = 60 * 1000;
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';

const mapa = L.map('mapa', { zoomControl: false }).setView([-33.0, -68.6], 6);
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

let marcadores = L.layerGroup().addTo(mapa);

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
let ultimosSismos = [];       // lista fusionada que se esta mostrando
let regionBBox = null;        // la manda el backend en cada respuesta
let idsVistos = new Set();    // para no re-alertar dos veces el mismo sismo
let primeraCargaCompleta = false;

let miUbicacion = null;       // { lat, lon, precision }
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

function formatearHora(epochMs) {
  return new Date(epochMs).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Mendoza',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

// Misma formula que usa el backend, pero corrida en el navegador para no
// tener que ir y volver al servidor cada vez que se mueve el usuario.
function distanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function textoDistancia(s) {
  if (!miUbicacion) return '';
  const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, s.lat, s.lon);
  return `<span class="distancia">a ${Math.round(km)} km de vos</span>`;
}

// Beep corto generado con Web Audio API — no hace falta ningun archivo
// de sonido externo.
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
// Render: dibuja ultimosSismos en el mapa, la lista y el resumen "mas cercano"
// ---------------------------------------------------------------------

function render() {
  marcadores.clearLayers();

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
      ${miUbicacion ? textoDistancia(s) + '<br/>' : ''}
      Fuente: ${s.fuentes.join(' + ')}<br/>
      <a href="${s.url}" target="_blank" rel="noopener">Ver detalle</a>
    `);
    marcador.addTo(marcadores);
  });

  actualizarLista(ordenados);
  actualizarMasCercano(ordenados);

  const contadorMovil = document.getElementById('contador-movil');
  if (contadorMovil) contadorMovil.textContent = ordenados.length;
}

function actualizarLista(sismos) {
  const contenedor = document.getElementById('lista');
  contenedor.innerHTML = '';
  sismos.slice(0, 25).forEach((s) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <span class="mag" style="color:${colorPorMagnitud(s.magnitud)}">M${s.magnitud.toFixed(1)}</span>
      <span class="lugar">${s.lugar}</span>
      <span class="hora">${formatearHora(s.hora)} · ${s.profundidad_km ? s.profundidad_km.toFixed(0) + ' km de profundidad' : ''} · ${s.fuentes.join(' + ')}${miUbicacion ? ' · ' + textoDistancia(s) : ''}</span>
    `;
    contenedor.appendChild(div);
  });
}

function actualizarMasCercano(sismos) {
  const el = document.getElementById('mas-cercano');
  if (!miUbicacion || sismos.length === 0) {
    el.classList.add('oculto');
    return;
  }
  let masCercano = sismos[0];
  let minKm = Infinity;
  sismos.forEach((s) => {
    const km = distanciaKm(miUbicacion.lat, miUbicacion.lon, s.lat, s.lon);
    if (km < minKm) {
      minKm = km;
      masCercano = s;
    }
  });
  el.innerHTML = `📍 El sismo más cercano a tu ubicación: <strong>M${masCercano.magnitud.toFixed(1)}</strong> a <strong>${Math.round(minKm)} km</strong> — ${masCercano.lugar}`;
  el.classList.remove('oculto');
}

// ---------------------------------------------------------------------
// Canal 1: sondeo REST cada 60s (fuente de verdad + respaldo)
// ---------------------------------------------------------------------

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

    const hora = new Date(data.generado).toLocaleTimeString('es-AR', {
      timeZone: 'America/Argentina/Mendoza',
    });
    estado.textContent = `${data.total} sismos · actualizado ${hora}`;
    if (data.errores && data.errores.length) {
      console.warn('Errores al consultar fuentes:', data.errores);
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

// ---------------------------------------------------------------------
// Canal 2: websocket EMSC en tiempo casi real (mas rapido que el sondeo)
// ---------------------------------------------------------------------

let socketEMSC = null;
let intentosReconexion = 0;

function estaDentroDeLaRegion(lat, lon) {
  if (!regionBBox) return true; // todavia no sabemos el bbox, no filtramos
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
  // El mensaje puede venir como {action, data: {properties, geometry}} o
  // variantes mas planas — probamos varias formas sin romper si cambia algo.
  const accion = msg.action || 'insert';
  const feature = msg.data || msg;
  const props = feature.properties || feature;
  const geom = feature.geometry;
  const coords = geom ? geom.geometry ? geom.geometry.coordinates : geom.coordinates : null;

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
      render();
      return;
    }

    if (!estaDentroDeLaRegion(sismo.lat, sismo.lon) || sismo.magnitud < minmag) {
      return; // fuera de la zona o por debajo del filtro actual, lo ignoramos
    }

    const yaExistia = ultimosSismos.some((s) => s.id === sismo.id);
    ultimosSismos = ultimosSismos.filter((s) => s.id !== sismo.id);
    ultimosSismos.push(sismo);
    render();

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
// "Mi ubicacion": geolocalizacion + distancia real al epicentro
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
  })
    .addTo(mapa)
    .bindPopup('Estás acá (aproximado)');

  circuloPrecision = L.circle([miUbicacion.lat, miUbicacion.lon], {
    radius: miUbicacion.precision || 500,
    color: '#00e5ff',
    weight: 1,
    fillOpacity: 0.07,
  }).addTo(mapa);
}

function pedirUbicacion(boton) {
  if (!navigator.geolocation) {
    alert('Tu navegador no soporta geolocalización.');
    return;
  }
  if (boton) boton.classList.add('activo');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      miUbicacion = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        precision: pos.coords.accuracy,
      };
      actualizarMarcadorUbicacion();
      mapa.flyTo([miUbicacion.lat, miUbicacion.lon], Math.max(mapa.getZoom(), 9));
      render();
    },
    (err) => {
      if (boton) boton.classList.remove('activo');
      alert('No pudimos obtener tu ubicación: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

const ControlUbicacion = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const btn = L.DomUtil.create('a', 'control-mapa', div);
    btn.href = '#';
    btn.title = 'Ver mi ubicación y la distancia a cada sismo';
    btn.innerHTML = '📍';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    L.DomEvent.on(btn, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      pedirUbicacion(btn);
    });
    return div;
  },
});
mapa.addControl(new ControlUbicacion());

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

document.getElementById('boton-abrir-sos').addEventListener('click', abrirSOS);
document.getElementById('boton-cerrar-sos').addEventListener('click', cerrarSOS);
document.getElementById('fondo-sos').addEventListener('click', (e) => {
  if (e.target.id === 'fondo-sos') cerrarSOS();
});

// Compartir ubicacion de emergencia: NO es un rastreador automatico, es un
// atajo de un toque para mandar la posicion exacta por WhatsApp/mensajes.
document.getElementById('boton-compartir-ubicacion').addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Tu navegador no soporta geolocalización.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' });
      const texto =
        `🚨 Mi ubicación de emergencia (${ahora}):\n` +
        `https://www.google.com/maps?q=${latitude},${longitude}\n\n` +
        `Enviado desde Mendoza en Vivo`;

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
setInterval(cargarSismos, REFRESCO_MS);
conectarEMSC();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // si falla el registro (por ejemplo, sirviendo sin HTTPS en la red local),
    // la app sigue funcionando igual, solo sin instalacion PWA offline.
  });
}
