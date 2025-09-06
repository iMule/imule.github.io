/* Web Mapper — Iowa Wind Turbines
   - Loads all USWTDB turbines where t_state = IA via official API
   - Builds clustered, capacity-scaled markers with stylized popups
   - Restricts map panning to data extent + ~15° padding (per defaults)
*/

// ---------- Map setup ----------
const map = L.map('map', {
  zoomControl: false, // per defaults: no +/- UI
  scrollWheelZoom: true,
  preferCanvas: true
});

// Dark basemap (free/open)
const darkTiles = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  {
    attribution:
      '© <a href="https://www.openstreetmap.org/">OSM</a> · © <a href="https://carto.com/">CARTO</a> · Data: USWTDB v8.1 · Map: <a href="https://chatgpt.com/g/g-68af432e3ee481919b9605d8593bb913-web-mapper" target="_blank" rel="noopener">Web Mapper GPT</a>'
  }
).addTo(map);

// Start near Iowa; we’ll fit to data after load
map.setView([42.0, -93.5], 7);

// Cluster group (chunked for perf)
const clusters = L.markerClusterGroup({
  maxClusterRadius: 35,
  showCoverageOnHover: false,
  spiderfyOnEveryZoom: false,
  chunkedLoading: true,
  chunkDelay: 25,
  chunkInterval: 250
});
map.addLayer(clusters);

// ---------- Data fetch ----------
const API_BASE = 'https://energy.usgs.gov/api/uswtdb/v1/turbines';
const STATE_FILTER = 't_state=eq.IA';
const ORDER = 'order=case_id.asc';
const LIMIT = 2000;

const loadingEl = document.getElementById('loading');

(async function loadIowa() {
  try {
    let offset = 0;
    let total = 0;
    const bounds = L.latLngBounds([]);

    while (true) {
      const url = `${API_BASE}?${STATE_FILTER}&${ORDER}&limit=${LIMIT}&offset=${offset}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`USWTDB request failed: ${resp.status}`);
      const batch = await resp.json();

      if (!Array.isArray(batch) || batch.length === 0) break;

      const markers = batch
        .filter(t => typeof t.ylat === 'number' && typeof t.xlong === 'number')
        .map(t => {
          const latlng = [t.ylat, t.xlong];
          bounds.extend(latlng);
          return L.marker(latlng, { icon: turbineIcon(t) })
                  .bindPopup(popupHTML(t), { maxWidth: 360, autoPanPadding: [24,24] });
        });

      clusters.addLayers(markers);
      total += markers.length;
      offset += LIMIT;

      // Small yield to the main thread for smoother UX
      await new Promise(r => setTimeout(r, 10));
    }

    // Fit to all IA turbines
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24] });
      // Restrict panning to ~15° pad per cartographic defaults
      const padDeg = 15;
      const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
      const maxBounds = L.latLngBounds(
        [ clampLat(sw.lat - padDeg), clampLon(sw.lng - padDeg) ],
        [ clampLat(ne.lat + padDeg), clampLon(ne.lng + padDeg) ]
      );
      map.setMaxBounds(maxBounds.pad(0.05));
    }

  } catch (err) {
    console.error(err);
    alert('Sorry — the USWTDB service is unavailable right now.');
  } finally {
    loadingEl.style.display = 'none';
  }
})();

function clampLat(lat) { return Math.max(-90, Math.min(90, lat)); }
function clampLon(lon) { return Math.max(-180, Math.min(180, lon)); }

// ---------- Symbology ----------
function turbineIcon(t) {
  // Size by rated capacity (kW). Convert to MW for a gentle visual scale.
  const mw = (typeof t.t_cap === 'number' ? t.t_cap : 0) / 1000;
  // radius in pixels: base 8, add 2.5px per MW, cap at 18
  const r = Math.max(6, Math.min(18, 8 + mw * 2.5));
  return L.divIcon({
    className: 'turbine-icon',
    html: `<div class="turbine-dot" style="--r:${r}px" title="${mw ? mw.toFixed(1):'N/A'} MW"></div>`,
    iconSize: [r, r],
    iconAnchor: [r/2, r/2]
  });
}

// ---------- Popup content ----------
function popupHTML(t) {
  const toFixed = (v, n=1) => (typeof v === 'number' ? v.toFixed(n) : 'N/A');
  const mw = typeof t.t_cap === 'number' ? (t.t_cap/1000) : null;

  return `
    <div>
      <h3 class="popup-title">${safe(t.p_name) || 'Unnamed Project'}</h3>
      <div class="popup-grid">
        <div class="label">County</div><div>${safe(t.t_county) || '—'}</div>
        <div class="label">Online (yr)</div><div>${t.p_year ?? '—'}</div>
        <div class="label">Rated Capacity</div><div>${t.t_cap ?? '—'} kW (${mw ? toFixed(mw,1) : '—'} MW)</div>
        <div class="label">Manufacturer</div><div>${safe(t.t_manu) || '—'}</div>
        <div class="label">Model</div><div>${safe(t.t_model) || '—'}</div>
        <div class="label">Hub Height</div><div>${t.t_hh != null ? toFixed(t.t_hh,0) + ' m' : '—'}</div>
        <div class="label">Rotor Diameter</div><div>${t.t_rd != null ? toFixed(t.t_rd,0) + ' m' : '—'}</div>
        <div class="label">Total Height</div><div>${t.t_ttlh != null ? toFixed(t.t_ttlh,0) + ' m' : '—'}</div>
        <div class="label">Attr. Confidence</div><div>${t.t_conf_atr ?? '—'} (1–3)</div>
        <div class="label">Loc. Confidence</div><div>${t.t_conf_loc ?? '—'} (1–3)</div>
      </div>
      <div style="margin-top:8px; font-size:.85rem; color:#9ab0c6;">
        USWTDB case_id: ${t.case_id ?? '—'} • ${safe(t.t_state) || '—'}
      </div>
    </div>
  `;
}

function safe(v) {
  if (v == null) return v;
  return String(v).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

// ---------- Legend & Info UI ----------
const legendToggle = document.getElementById('legendToggle');
const legendBody = document.getElementById('legendBody');
legendToggle.addEventListener('click', () => {
  const isHidden = legendBody.style.display === 'none';
  legendBody.style.display = isHidden ? 'block' : 'none';
  legendToggle.setAttribute('aria-expanded', String(isHidden));
});

const infoBtn = document.getElementById('infoBtn');
const infoPanel = document.getElementById('infoPanel');
const closeInfo = document.getElementById('closeInfo');

infoBtn.addEventListener('click', () => {
  infoPanel.hidden = false;
});
closeInfo.addEventListener('click', () => { infoPanel.hidden = true; });
// Click outside to close
infoPanel.addEventListener('click', (e) => {
  if (e.target === infoPanel) infoPanel.hidden = true;
});
