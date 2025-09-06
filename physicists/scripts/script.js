/* Web Mapper – Physicists Map
   - Uses Leaflet + MarkerCluster
   - Data: data/physicists.json (100 entries)
   - Cartographic notes:
     * Visual hierarchy: subtle dark UI, high-contrast popups, colored dot markers by era.
     * Interaction: clustering, search, century filter, bounded panning.
     * Layout: top bar controls, collapsible legend, bottom-left brand link.
*/

const eraColor = (year) => {
  if (year < 1600) return '#9b5de5';     // 1400-1500s
  if (year < 1800) return '#f15bb5';     // 1600-1700s
  if (year < 1900) return '#fee440';     // 1800s
  if (year < 2000) return '#00bbf9';     // 1900s
  return '#00f5d4';                      // 2000s
};

// Simple circle marker factory to keep a consistent look
function circleMarker(lat, lon, yr){
  const r = 8;
  return L.circleMarker([lat, lon], {
    radius: r,
    color: '#1f2630',
    weight: 1,
    fillColor: eraColor(yr),
    fillOpacity: 0.9
  });
}

// Setup map
const map = L.map('map', {
  zoomControl: false, // design default: no zoom +/- buttons
  worldCopyJump: false
});

// CARTO Positron basemap (subtle, readable labels)
const tiles = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
  { attribution: '&copy; OpenStreetMap & CARTO' }
).addTo(map);

// Load data
fetch('data/physicists.json')
  .then(r => r.json())
  .then(data => init(data))
  .catch(err => console.error(err));

let cluster, allFeatures = [], currentCentury = 'all';

function init(rows){
  // Build markers
  cluster = L.markerClusterGroup({
    maxClusterRadius: 46,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false
  });

  rows.forEach(d => {
    const m = circleMarker(d.lat, d.lon, d.birth_year);
    const yrs = `${d.birth_year}${d.death_year ? '–' + d.death_year : '–'}`;
    const srcLinks = d.sources.map(u => `<a href="${u}" target="_blank" rel="noopener">${new URL(u).hostname.replace('www.','')}</a>`).join(' · ');

    const html = `
      <div class="popup">
        <h3>${d.name}</h3>
        <div class="meta">${yrs} • Born in ${d.birthplace}</div>
        <div class="bio">${d.bio}</div>
        <div class="src"><strong>Source:</strong> ${srcLinks}</div>
      </div>
    `;

    m.bindPopup(html, { maxWidth: 340 });
    m.feature = d; // store data for filtering/searching
    cluster.addLayer(m);
    allFeatures.push(m);
  });

  cluster.addTo(map);

  // Fit to data + pad 15° lat/lon (as per design default)
  const bounds = L.latLngBounds(allFeatures.map(m => m.getLatLng()));
  const pad = 15; // degrees
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const padded = L.latLngBounds(
    L.latLng(sw.lat - pad, sw.lng - pad),
    L.latLng(ne.lat + pad, ne.lng + pad)
  );
  map.fitBounds(padded);
  map.setMaxBounds(padded.pad(0.05)); // gentle extra pad to avoid sticky edges

  // UI wiring
  const s = document.getElementById('searchInput');
  const f = document.getElementById('centuryFilter');
  const resetBtn = document.getElementById('resetBtn');

  s.addEventListener('input', () => applyFilters());
  f.addEventListener('change', () => { currentCentury = f.value; applyFilters(); });
  resetBtn.addEventListener('click', () => {
    s.value = ''; f.value = 'all'; currentCentury = 'all'; applyFilters(true);
  });

  // Legend toggle
  const legend = document.getElementById('legendPanel');
  const legendToggle = document.getElementById('legendToggle');
  const legendClose = document.getElementById('legendClose');
  legendToggle.addEventListener('click', () => {
    const isHidden = legend.hasAttribute('hidden');
    if (isHidden) legend.removeAttribute('hidden'); else legend.setAttribute('hidden', '');
    legendToggle.setAttribute('aria-expanded', String(isHidden));
  });
  legendClose.addEventListener('click', () => { legend.setAttribute('hidden',''); legendToggle.setAttribute('aria-expanded','false'); });

  // Sources dialog
  const infoBtn = document.getElementById('infoBtn');
  const srcDlg = document.getElementById('sourcePanel');
  const srcClose = document.getElementById('sourceClose');
  infoBtn.addEventListener('click', () => srcDlg.showModal());
  srcClose.addEventListener('click', () => srcDlg.close());
  srcDlg.addEventListener('click', (e) => { if (e.target === srcDlg) srcDlg.close(); });
}

// Filtering logic
function applyFilters(fit=false){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  cluster.clearLayers();
  const filtered = allFeatures.filter(m => {
    const d = m.feature;

    const nameOK = !q || d.name.toLowerCase().includes(q);
    const cent = Math.floor(d.birth_year/100) + 1; // 1400 -> 15th
    const centStr = String(cent);
    const centOK = (currentCentury === 'all') || (centStr === currentCentury);

    return nameOK && centOK;
  });

  filtered.forEach(m => cluster.addLayer(m));
  if (fit && filtered.length) map.fitBounds(L.latLngBounds(filtered.map(m => m.getLatLng())));
}
