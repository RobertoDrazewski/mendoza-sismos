// Mendoza en Vivo — Sismos (frontend)
// Mapa con Leaflet + OpenStreetMap (gratis, sin API key). Consulta a
// nuestro propio backend (/api/sismos), que a su vez combina USGS y
// EMSC. Se refresca solo cada 60 segundos y avisa (visual + sonido)
// cuando aparece un sismo nuevo desde que se abrio la pagina.

const REFRESCO_MS = 60 * 1000;

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

// Calles/nombres de lugares por encima, en modo oscuro con glow cian
// (CARTO dark_only_labels: fondo transparente, solo calles y etiquetas).
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 18,
  className: 'capa-labels',
  attribution: '&copy; OpenStreetMap, &copy; CARTO',
}).addTo(mapa);

let marcadores = L.layerGroup().addTo(mapa);
let idsVistos = new Set();
let primeraCarga = true;

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

function actualizarLista(sismos) {
  const contenedor = document.getElementById('lista');
  contenedor.innerHTML = '';
  sismos.slice(0, 25).forEach((s) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <span class="mag" style="color:${colorPorMagnitud(s.magnitud)}">M${s.magnitud.toFixed(1)}</span>
      <span class="lugar">${s.lugar}</span>
      <span class="hora">${formatearHora(s.hora)} · ${s.profundidad_km ? s.profundidad_km.toFixed(0) + ' km de profundidad' : ''} · ${s.fuentes.join(' + ')}</span>
    `;
    contenedor.appendChild(div);
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

    marcadores.clearLayers();

    let nuevos = [];
    data.sismos.forEach((s) => {
      if (!idsVistos.has(s.id)) {
        nuevos.push(s);
      }
      idsVistos.add(s.id);

      const esNuevo = !primeraCarga && nuevos.includes(s);
      const clases = clasePorMagnitud(s.magnitud) + (esNuevo ? ' sismo-nuevo' : '');

      const marcador = L.circleMarker([s.lat, s.lon], {
        radius: radioPorMagnitud(s.magnitud),
        color: colorPorMagnitud(s.magnitud),
        fillColor: colorPorMagnitud(s.magnitud),
        fillOpacity: 0.65,
        weight: 1.5,
        className: clases,
      });

      marcador.bindPopup(`
        <strong>M${s.magnitud.toFixed(1)}</strong> — ${s.lugar}<br/>
        ${formatearHora(s.hora)}<br/>
        Profundidad: ${s.profundidad_km ? s.profundidad_km.toFixed(1) + ' km' : 'sin dato'}<br/>
        Fuente: ${s.fuentes.join(' + ')}<br/>
        <a href="${s.url}" target="_blank" rel="noopener">Ver detalle</a>
      `);
      marcador.addTo(marcadores);
    });

    if (!primeraCarga && nuevos.length > 0) {
      reproducirAlerta();
      mostrarBanner(nuevos[0]);
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Nuevo sismo detectado', {
          body: `M${nuevos[0].magnitud.toFixed(1)} — ${nuevos[0].lugar}`,
        });
      }
    }
    primeraCarga = false;

    actualizarLista(data.sismos);

    const hora = new Date(data.generado).toLocaleTimeString('es-AR', {
      timeZone: 'America/Argentina/Mendoza',
    });
    estado.textContent = `${data.total} sismos · actualizado ${hora}`;
    if (data.errores && data.errores.length) {
      console.warn('Errores al consultar fuentes:', data.errores);
      estado.textContent += ' (una fuente no respondió)';
    }

    const contadorMovil = document.getElementById('contador-movil');
    if (contadorMovil) contadorMovil.textContent = data.total;
  } catch (err) {
    console.error(err);
    estado.textContent = 'error al actualizar';
  }
}

document.getElementById('rango').addEventListener('change', () => {
  idsVistos.clear();
  primeraCarga = true;
  cargarSismos();
});
document.getElementById('minmag').addEventListener('change', () => {
  idsVistos.clear();
  primeraCarga = true;
  cargarSismos();
});

if (window.Notification && Notification.permission === 'default') {
  Notification.requestPermission();
}

// Detecta si el visitante usa Android o iPhone para mostrarle el camino
// correcto de alerta temprana real (ver sección "Alerta temprana real").
// Esto NO es la fuente de sismos del mapa — es un cartel informativo aparte.
function mostrarAlertaSegunPlataforma() {
  const ua = navigator.userAgent || '';
  const esAndroid = /Android/i.test(ua);
  const esIOS = /iPhone|iPad|iPod/i.test(ua);
  const idAMostrar = esAndroid ? 'alerta-android' : esIOS ? 'alerta-ios' : 'alerta-otro';
  const el = document.getElementById(idAMostrar);
  if (el) el.classList.remove('oculto');
}

// Panel deslizable en mobile: el mapa ocupa toda la pantalla y el panel
// de sismos/recomendaciones se abre como una bandeja desde abajo.
const botonPanelMovil = document.getElementById('boton-panel-movil');
const panelLateral = document.getElementById('panel-lateral');
if (botonPanelMovil && panelLateral) {
  botonPanelMovil.addEventListener('click', () => {
    panelLateral.classList.toggle('abierto');
  });
  // Tocar el mapa con el panel abierto lo cierra, para volver a ver el mapa completo.
  mapa.on('click dragstart', () => {
    panelLateral.classList.remove('abierto');
  });
}

mostrarAlertaSegunPlataforma();
cargarSismos();
setInterval(cargarSismos, REFRESCO_MS);
