// Mapa: globo 3D con imagenes satelitales REALES (MapLibre GL JS, proyeccion
// "globe") en modo HIBRIDO — imagenes de Esri + sus capas de referencia
// gratuitas de rutas/calles y nombres de lugares por encima, para que al
// acercar el zoom se vea lo que hace falta para pensar una evacuacion real,
// no solo una foto satelital muda.
//
// Los pines (sismos/incendios/catastrofes) se dibujan como una CAPA del
// mapa (fuente GeoJSON + circle/symbol layer), no como cientos de elementos
// HTML sueltos: con 200+ eventos, reposicionar esa cantidad de divs en cada
// frame de la rotacion es mas trabajo del que el hilo principal puede
// sostener, y eso es lo que se veia como "el mundo gira pero los puntos
// quedan fijos" (y, con el tiempo, el globo trabado). Dibujados en la misma
// capa WebGL que el propio mapa, quedan pegados a el sin importar que tan
// rapido rote. Solo Mendoza, "tu ubicacion" y el pin de evacuacion siguen
// siendo marcadores HTML de verdad (son 1-3, no un problema).
//
// Expone window.GlobeMap con una API minima que usa app.js.

window.GlobeMap = (function () {
  const ESRI_IMAGENES_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  // Calles + nombres de calles: tiles VECTORIALES de OpenFreeMap (gratis,
  // sin cuenta, sin limite) — las capas de referencia rasterizadas de Esri
  // (World_Transportation/World_Boundaries_and_Places) nunca llegaron a
  // pintar nada sobre el globo pese a tener datos reales (un limite propio
  // de como MapLibre compone varias capas raster semi-transparentes ahi);
  // el formato vectorial es el que MapLibre usa de forma nativa y sí
  // renderiza de forma confiable.
  const OFM_VECTOR_URL = 'https://tiles.openfreemap.org/planet';
  const OFM_GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const MENDOZA = { lat: -32.8908, lon: -68.8272 };
  const VACIO_FC = { type: 'FeatureCollection', features: [] };

  // Velocidad de rotacion (patron estandar de Mapbox/MapLibre para un globo
  // que gira solo). Un solo easeTo encadenado por 'moveend', nunca un jumpTo
  // en loop por frame — eso peleaba con el render del mapa.
  const SEGUNDOS_POR_VUELTA = 140;
  const ZOOM_MAX_GIRO = 5; // mas cerca que esto, el globo no gira mas
  const ZOOM_GIRO_LENTO = 3; // entre esto y ZOOM_MAX_GIRO, frena gradualmente

  let map;
  let mapaListo = false;
  let colaPostCarga = [];
  let onPinClickCb = null;
  let onInteractionCb = null;
  let popupActivo = null;
  let girarHabilitado = true;
  let usuarioInteractuando = false;

  const capaVisible = { sismos: true, incendios: true, catastrofes: true };
  const datosPorId = { sismos: new Map(), incendios: new Map(), catastrofes: new Map() };
  const marcadoresFijos = { ubicacion: [], evacuacion: [] };

  // Los marcadores HTML (Mendoza, tu ubicacion, el pin de evacuacion) son
  // pocos, pero en proyeccion "globe" MapLibre tiene un bug conocido: un
  // punto del lado de ATRAS del globo puede proyectarse en cualquier lugar
  // de la pantalla en vez de ocultarse (maplibre-gl-js#8292) — se veia como
  // un pin flotando afuera de la esfera. Lo evitamos a mano: ocultamos
  // cualquier marcador HTML cuyo punto este a mas de ~80° del centro actual
  // de la camara (del otro lado del horizonte), y lo recalculamos en cada
  // 'move' de la camara.
  const marcadoresGeoreferenciados = []; // {lat, lon, el}

  function anguloCentral(lat1, lon1, lat2, lon2) {
    const r = (x) => (x * Math.PI) / 180;
    const coseno = Math.sin(r(lat1)) * Math.sin(r(lat2)) + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.cos(r(lon1 - lon2));
    return (Math.acos(Math.max(-1, Math.min(1, coseno))) * 180) / Math.PI;
  }

  function registrarVisibilidadGlobo(lat, lon, el) {
    marcadoresGeoreferenciados.push({ lat, lon, el });
  }

  function actualizarVisibilidadMarcadores() {
    const c = map.getCenter();
    marcadoresGeoreferenciados.forEach((m) => {
      m.el.style.display = anguloCentral(c.lat, c.lng, m.lat, m.lon) < 80 ? '' : 'none';
    });
  }

  function cuandoListo(fn) {
    if (mapaListo) fn();
    else colaPostCarga.push(fn);
  }

  function cerrarPopup() {
    // .remove() dispara el evento 'close' del popup (pasa lo mismo si lo
    // cierra el usuario con el boton "×" propio de MapLibre, o tocando el
    // mapa): ese 'close' es el UNICO lugar que limpia popupActivo y retoma
    // el giro, asi no queda "pegado" sin importar como se haya cerrado.
    if (popupActivo) popupActivo.remove();
  }

  function abrirPopupEnPunto(tipo, raw, lngLat) {
    if (!onPinClickCb) return;
    const html = onPinClickCb(tipo, raw);
    if (!html) return;
    cerrarPopup();
    // ojo: Popup.on() en esta version de MapLibre NO devuelve el propio
    // popup (no es encadenable como .addTo()) — por eso .on() va aparte,
    // no colgado al final de la cadena.
    popupActivo = new maplibregl.Popup({ offset: 14, closeButton: true, className: 'globo-popup', maxWidth: '260px' })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
    popupActivo.on('close', () => {
      popupActivo = null;
      girarGlobo();
    });
  }

  function crearPinSimple(color, diametroPx) {
    const el = document.createElement('div');
    el.className = 'pin-sismo';
    el.style.width = diametroPx + 'px';
    el.style.height = diametroPx + 'px';
    el.style.background = color;
    el.style.boxShadow = `0 0 5px ${color}, 0 0 10px ${color}`;
    return el;
  }

  // Dibuja un emoji en un canvas chico y lo registra como imagen del mapa —
  // los symbol layers de MapLibre necesitan una imagen (no un glyph SDF) si
  // queremos color de verdad, y asi corre en la GPU junto con todo lo demas.
  function idImagenEmoji(emoji) {
    const id = 'emoji-' + emoji;
    if (map.hasImage(id)) return id;
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.font = '34px "Segoe UI Emoji","Apple Color Emoji",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 24, 26);
    map.addImage(id, ctx.getImageData(0, 0, 48, 48));
    return id;
  }

  // Circulo geodesico (aprox.) de radio en metros, como poligono GeoJSON —
  // para la precision real de la geolocalizacion sobre el globo.
  function circuloGeoJSON(lat, lon, radioMetros) {
    const puntos = 64;
    const coords = [];
    const distRad = radioMetros / 6371000;
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    for (let i = 0; i <= puntos; i++) {
      const brng = (i / puntos) * 2 * Math.PI;
      const lat2 = Math.asin(Math.sin(latRad) * Math.cos(distRad) + Math.cos(latRad) * Math.sin(distRad) * Math.cos(brng));
      const lon2 = lonRad + Math.atan2(
        Math.sin(brng) * Math.sin(distRad) * Math.cos(latRad),
        Math.cos(distRad) - Math.sin(latRad) * Math.sin(lat2)
      );
      coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
  }

  // Un paso de giro, revisado cada 1s por un setInterval (no encadenado por
  // el evento 'moveend' del propio mapa): encadenarlo por 'moveend' hacia
  // esta misma funcion entraba en carrera con el 'moveend' INTERNO de
  // MapLibre durante un doble click para hacer zoom, y eso rompia su
  // maquina de estados de animacion (el zoom dejaba de responder). Con
  // `!map.isMoving()` alcanza para no pisar ninguna animacion en curso —
  // la del usuario (drag, zoom, doble click) o la nuestra (focusOn) — y
  // retomamos solos un segundo despues de que se asiente.
  function girarGlobo() {
    if (map.isMoving()) return;
    const zoom = map.getZoom();
    if (!girarHabilitado || usuarioInteractuando || popupActivo || zoom >= ZOOM_MAX_GIRO) return;
    let gradosPorSegundo = 360 / SEGUNDOS_POR_VUELTA;
    if (zoom > ZOOM_GIRO_LENTO) {
      gradosPorSegundo *= (ZOOM_MAX_GIRO - zoom) / (ZOOM_MAX_GIRO - ZOOM_GIRO_LENTO);
    }
    const centro = map.getCenter();
    centro.lng -= gradosPorSegundo;
    map.easeTo({ center: centro, duration: 1000, easing: (n) => n });
  }

  function limpiarMarcadoresFijos(tipo) {
    marcadoresFijos[tipo].forEach((m) => {
      const el = m.getElement();
      const idx = marcadoresGeoreferenciados.findIndex((g) => g.el === el);
      if (idx !== -1) marcadoresGeoreferenciados.splice(idx, 1);
      m.remove();
    });
    marcadoresFijos[tipo] = [];
  }

  function featureCollectionDesde(lista, prefijoId, mapaDatos, propsExtra) {
    mapaDatos.clear();
    const features = lista.map((item, i) => {
      const id = prefijoId + i;
      mapaDatos.set(id, item.raw);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
        properties: Object.assign({ id }, propsExtra ? propsExtra(item) : {}),
      };
    });
    return { type: 'FeatureCollection', features };
  }

  // -----------------------------------------------------------------
  // API publica
  // -----------------------------------------------------------------

  function init(container, opciones) {
    onPinClickCb = (opciones && opciones.onPinClick) || null;

    map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: OFM_GLYPHS_URL,
        sources: {
          'esri-imagenes': {
            type: 'raster',
            tiles: [ESRI_IMAGENES_URL],
            tileSize: 256,
            attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
          },
          'ofm': { type: 'vector', url: OFM_VECTOR_URL, attribution: '&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap' },
        },
        // Hibrido: imagenes satelitales de Esri abajo, calles y sus nombres
        // (vectoriales, OpenFreeMap) arriba, recoloreados para el HUD —
        // asi al acacer el zoom se ve por donde se podria evacuar, no solo
        // una foto satelital muda.
        layers: [
          { id: 'esri-imagenes', type: 'raster', source: 'esri-imagenes' },
          {
            id: 'ofm-rutas-mayores', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 7,
            filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#5fe6ff', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 20, 14] },
          },
          {
            id: 'ofm-rutas-menores', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 11,
            filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary', 'minor', 'service', 'track']]],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#5fe6ff', 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 20, 9] },
          },
          {
            id: 'ofm-lugares-nombres', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 2, maxzoom: 13,
            filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'country']]],
            layout: {
              'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
              'text-font': ['Noto Sans Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 13, 16],
            },
            paint: { 'text-color': '#eaf5ff', 'text-halo-color': '#04141a', 'text-halo-width': 1.2 },
          },
          {
            id: 'ofm-calles-nombres', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 13,
            layout: {
              'symbol-placement': 'line',
              'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
              'text-font': ['Noto Sans Regular'],
              'text-rotation-alignment': 'map',
              'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 17, 14],
            },
            paint: { 'text-color': '#eaf5ff', 'text-halo-color': '#04141a', 'text-halo-width': 1.2 },
          },
        ],
        // Proyeccion de globo — va en el estilo, no en setProjection()
        // (ese metodo no existe en esta version de MapLibre).
        projection: { type: 'globe' },
      },
      center: [MENDOZA.lon, MENDOZA.lat],
      zoom: 2,
      attributionControl: false,
    });

    // El tamaño de #mapa lo decide el layout flex/CSS, no un numero fijo —
    // si se asienta DESPUES de que MapLibre arranca (fuentes que cargan,
    // el panel que termina de medirse, etc.) el canvas interno queda mas
    // chico que el contenedor real y los clicks/zoom se calculan mal (doble
    // click para zoom no respondia). Un ResizeObserver lo mantiene
    // sincronizado pase lo que pase.
    if (window.ResizeObserver) {
      new ResizeObserver(() => map.resize()).observe(container);
    }
    window.addEventListener('resize', () => map.resize());

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      map.addSource('precision', { type: 'geojson', data: VACIO_FC });
      map.addLayer({ id: 'precision-fill', type: 'fill', source: 'precision', paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'precision-linea', type: 'line', source: 'precision', paint: { 'line-color': '#00e5ff', 'line-width': 1, 'line-opacity': 0.5 } });

      map.addSource('evacuacion', { type: 'geojson', data: VACIO_FC });
      map.addLayer({ id: 'evacuacion-glow', type: 'line', source: 'evacuacion', paint: { 'line-color': '#00e5ff', 'line-width': 7, 'line-opacity': 0.22, 'line-blur': 3 } });
      map.addLayer({ id: 'evacuacion-linea', type: 'line', source: 'evacuacion', paint: { 'line-color': '#00e5ff', 'line-width': 2.5, 'line-opacity': 0.9, 'line-dasharray': [2, 1.4] } });

      // Sismos: un circle layer — color y radio ya vienen calculados desde
      // app.js (mismas reglas de siempre), en properties por feature.
      map.addSource('sismos', { type: 'geojson', data: VACIO_FC });
      map.addLayer({
        id: 'sismos-circulos',
        type: 'circle',
        source: 'sismos',
        paint: {
          'circle-radius': ['get', 'radio'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.8,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(255,255,255,0.3)',
        },
      });

      // Incendios: symbol layer con el emoji 🔥 como imagen (un solo icono,
      // se registra una vez).
      map.addSource('incendios', { type: 'geojson', data: VACIO_FC });
      map.addLayer({
        id: 'incendios-simbolos',
        type: 'symbol',
        source: 'incendios',
        layout: { 'icon-image': ['get', 'icono'], 'icon-size': 0.5, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      });

      // Catastrofes: un halo de color segun nivel de alerta detras del
      // icono (como antes el drop-shadow), mas el symbol layer.
      map.addSource('catastrofes', { type: 'geojson', data: VACIO_FC });
      map.addLayer({
        id: 'catastrofes-halo',
        type: 'circle',
        source: 'catastrofes',
        paint: { 'circle-radius': 13, 'circle-color': ['get', 'colorHalo'], 'circle-opacity': 0.3, 'circle-blur': 0.7 },
      });
      map.addLayer({
        id: 'catastrofes-simbolos',
        type: 'symbol',
        source: 'catastrofes',
        layout: { 'icon-image': ['get', 'icono'], 'icon-size': 0.5, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      });

      const pinMendoza = crearPinSimple('#38d7f5', 14);
      pinMendoza.classList.add('pin-mendoza');
      new maplibregl.Marker({ element: pinMendoza }).setLngLat([MENDOZA.lon, MENDOZA.lat]).addTo(map);
      registrarVisibilidadGlobo(MENDOZA.lat, MENDOZA.lon, pinMendoza);
      actualizarVisibilidadMarcadores();

      ['sismos-circulos', 'incendios-simbolos', 'catastrofes-simbolos'].forEach((idCapa) => {
        map.on('click', idCapa, (e) => {
          const f = e.features[0];
          const grupo = idCapa.startsWith('sismos') ? 'sismos' : idCapa.startsWith('incendios') ? 'incendios' : 'catastrofes';
          const tipo = grupo === 'sismos' ? 'sismo' : grupo === 'incendios' ? 'incendio' : 'catastrofe';
          const raw = datosPorId[grupo].get(f.properties.id);
          if (raw) abrirPopupEnPunto(tipo, raw, e.lngLat);
        });
        map.on('mouseenter', idCapa, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', idCapa, () => { map.getCanvas().style.cursor = ''; });
      });

      mapaListo = true;
      colaPostCarga.forEach((fn) => fn());
      colaPostCarga = [];

      setInterval(girarGlobo, 1000);
    });

    map.on('move', actualizarVisibilidadMarcadores);

    function marcarInteraccion() {
      usuarioInteractuando = true;
      if (onInteractionCb) onInteractionCb();
    }
    function soltarInteraccion() {
      usuarioInteractuando = false;
    }
    map.on('mousedown', marcarInteraccion);
    map.on('touchstart', marcarInteraccion);
    map.on('mouseup', soltarInteraccion);
    map.on('touchend', soltarInteraccion);
    map.on('dragend', soltarInteraccion);
    map.on('pitchend', soltarInteraccion);
    map.on('rotateend', soltarInteraccion);
  }

  function setSismos(lista) {
    cuandoListo(() => {
      const fc = featureCollectionDesde(lista, 'sismo-', datosPorId.sismos, (s) => ({ color: s.color, radio: s.radio }));
      map.getSource('sismos').setData(fc);
    });
  }

  function setIncendios(lista) {
    cuandoListo(() => {
      const icono = idImagenEmoji('🔥');
      const fc = featureCollectionDesde(lista, 'incendio-', datosPorId.incendios, () => ({ icono }));
      map.getSource('incendios').setData(fc);
    });
  }

  function setCatastrofes(lista) {
    cuandoListo(() => {
      const fc = featureCollectionDesde(lista, 'catastrofe-', datosPorId.catastrofes, (c) => ({
        icono: idImagenEmoji(c.emoji),
        colorHalo: c.colorHalo || '#38d7f5',
      }));
      map.getSource('catastrofes').setData(fc);
    });
  }

  function setCapaVisible(nombre, visible) {
    capaVisible[nombre] = visible;
    cuandoListo(() => {
      const capas = nombre === 'sismos' ? ['sismos-circulos']
        : nombre === 'incendios' ? ['incendios-simbolos']
        : ['catastrofes-halo', 'catastrofes-simbolos'];
      capas.forEach((id) => map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'));
    });
  }

  function setMiUbicacion(ubicacion) {
    cuandoListo(() => {
      limpiarMarcadoresFijos('ubicacion');
      if (!ubicacion) {
        map.getSource('precision').setData(VACIO_FC);
        return;
      }
      const el = document.createElement('div');
      el.className = 'pin-ubicacion';
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        abrirPopupEnPunto('ubicacion', ubicacion, [ubicacion.lon, ubicacion.lat]);
      });
      const marker = new maplibregl.Marker({ element: el }).setLngLat([ubicacion.lon, ubicacion.lat]).addTo(map);
      marcadoresFijos.ubicacion.push(marker);
      registrarVisibilidadGlobo(ubicacion.lat, ubicacion.lon, el);
      actualizarVisibilidadMarcadores();
      map.getSource('precision').setData(circuloGeoJSON(ubicacion.lat, ubicacion.lon, ubicacion.precision || 500));
    });
  }

  function setEvacuacionLinea(info) {
    cuandoListo(() => {
      limpiarMarcadoresFijos('evacuacion');
      if (!info) {
        map.getSource('evacuacion').setData(VACIO_FC);
        return;
      }
      map.getSource('evacuacion').setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[info.from.lon, info.from.lat], [info.to.lon, info.to.lat]] },
      });
      const el = document.createElement('div');
      el.className = 'pin-evacuacion';
      el.innerHTML = '<span class="pin-evacuacion-icono">🧭</span><span class="pin-evacuacion-etiqueta">Sugerencia de evacuación (no oficial)</span>';
      const marker = new maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat([info.to.lon, info.to.lat]).addTo(map);
      marcadoresFijos.evacuacion.push(marker);
      registrarVisibilidadGlobo(info.to.lat, info.to.lon, el);
      actualizarVisibilidadMarcadores();
    });
  }

  function focusOn(lat, lon) {
    cerrarPopup();
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), speed: 0.75, curve: 1.3, essential: true });
  }

  function onInteractionStart(cb) {
    onInteractionCb = cb;
  }

  function closePopup() {
    cerrarPopup();
  }

  return {
    init, setSismos, setIncendios, setCatastrofes, setCapaVisible,
    setMiUbicacion, setEvacuacionLinea, focusOn, onInteractionStart, closePopup,
  };
})();
