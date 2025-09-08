/* US Elections Map — runtime loader
 * Priority:
 *   1) Load /data/elections.json  (full 1948–2020 if you have it)
 *   2) else load /data/1976-2020-president.csv, aggregate to state-level (1976–2020),
 *      and fetch EV per state/year from Wikipedia (cached in localStorage)
 * Rendering:
 *   - Albers USA (TopoJSON from us-atlas CDN)
 *   - Slider HUD, winner glow, popover sparkline, EV strip chart
 * Notes:
 *   - ME/NE treated WTA (we can add CD splits later)
 */

(async function () {
  // ---------- Config ----------
  const topoUrl = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-albers-10m.json"; // Albers USA with AK/HI insets
  const dataPrimaryJSON = "data/elections.json"; // if present, we’ll use this
  const medslCSV = "data/1976-2020-president.csv"; // your local CSV (county/precinct aggregate)
  const fallbackSample = "data/elections.sample.json";

  const MAP_SEL = d3.select("#map");
  const WIDTH  = MAP_SEL.node().clientWidth;
  const HEIGHT = MAP_SEL.node().clientHeight;

  const colorParty = d3.scaleOrdinal()
    .domain(["DEM", "REP", "OTH"]).range(["#1f77b4","#d62728","#f2c744"]);

  // ---------- UI: loading text ----------
  const loading = MAP_SEL.append("text")
    .attr("x", WIDTH/2).attr("y", HEIGHT/2)
    .attr("fill", "#a8b0ba").attr("text-anchor", "middle")
    .text("Loading map & data…");

  // ---------- tiny toast ----------
  function toast(msg, ms=4000){
    const t = document.body.appendChild(Object.assign(document.createElement("div"), {
      className:"toast", textContent:msg
    }));
    Object.assign(t.style,{
      position:"fixed", left:"1rem", bottom:"1rem", zIndex:9999,
      background:"#1d2130", color:"#e8eaed", border:"1px solid #2b3140",
      padding:".5rem .65rem", borderRadius:"10px",
      boxShadow:"0 8px 24px rgba(0,0,0,.4)", font:"13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial"
    });
    setTimeout(()=>t.remove(), ms);
  }

  // ---------- helpers ----------
  const pct = x => (x==null||x==="")? null : (+x>1? +x/100 : +x);
  const pad2 = s => String(s ?? "").padStart(2,"0");
  function parseCSV(text){
    const rows = text.trim().split(/\r?\n/);
    const head = rows[0].split(",");
    return rows.slice(1).map(line=>{
      const v = line.split(",");
      const o={}; head.forEach((c,i)=>o[c]=v[i]); return o;
    });
  }

  // —— EV cache (per year → {abbr→EV})
  const EVCACHE_KEY = "wm_ev_cache_v1";
  const evCache = JSON.parse(localStorage.getItem(EVCACHE_KEY) || "{}");

  // Pull EV by state for a given year by scraping the “Results by state” table.
  async function fetchEVForYear(year){
    if (evCache[year]) return evCache[year];
    const url = `https://en.wikipedia.org/api/rest_v1/page/html/${year}_United_States_presidential_election`;
    const html = await fetch(url, {headers:{accept:"text/html"}}).then(r=>r.ok?r.text():Promise.reject(r.statusText));
    // Find a wikitable that contains “Results by state”
    const dom = new DOMParser().parseFromString(html, "text/html");
    const table = Array.from(dom.querySelectorAll("table")).find(t => /Results by state/i.test(t.textContent)) ||
                  dom.querySelector("table.wikitable");
    if (!table) { console.warn("No state table for", year); evCache[year]={}; localStorage.setItem(EVCACHE_KEY, JSON.stringify(evCache)); return {}; }
    const map = {};
    const rows = Array.from(table.querySelectorAll("tr")).slice(1);
    rows.forEach(tr=>{
      const cells = tr.querySelectorAll("td,th");
      if (cells.length < 4) return;
      const txt0 = cells[0].textContent.trim();
      const abbrMatch = txt0.match(/\b([A-Z]{2})\b/);
      const abbr = abbrMatch ? abbrMatch[1] : null;
      if (!abbr) return;
      // EV tends to be a small integer cell near the end; pick last numeric
      const nums = Array.from(cells).map(td => {
        const s = td.textContent.replace(/[^\d.]/g,"");
        return s ? +s : null;
      }).filter(x => x!=null && x<=100);
      const ev = nums.length ? nums[nums.length-1] : null;
      if (ev!=null) map[abbr] = ev;
    });
    evCache[year] = map;
    localStorage.setItem(EVCACHE_KEY, JSON.stringify(evCache));
    return map;
  }

  // Aggregate county-level MEDSL CSV to state-level percentages (1976–2020).
  async function buildFromLocalCSV(){
    toast("Building 1976–2020 from local CSV…");
    const txt = await fetch(medslCSV, {cache:"no-store"}).then(r=>r.ok?r.text():Promise.reject("Cannot read data/1976-2020-president.csv"));
    const rows = parseCSV(txt);
    // Shape varies by version; we try to be flexible:
    // Expected columns often include: year, state, state_po, state_fips, party, candidate, candidatevotes, totalvotes
    const key = r => `${r.year}|${r.state_po || r.state_po || r.state}`;
    const buckets = new Map();
    for (const r of rows){
      if ((r.office && r.office!=="President") || !r.year || !(r.state_po || r.state)) continue;
      const k = key(r);
      if (!buckets.has(k)) buckets.set(k, {year:+r.year, state:r.state, abbr:r.state_po, fips: pad2(r.state_fips), totals:0, dem:0, rep:0, oth:0});
      const b = buckets.get(k);
      const party = (r.party || r.party_detailed || "").toUpperCase();
      const votes = +r.candidatevotes || 0;
      b.totals += votes;
      if (party.includes("DEMOCRAT")) b.dem += votes;
      else if (party.includes("REPUBLICAN")) b.rep += votes;
      else b.oth += votes;
    }

    // Convert to target schema per state×year; fill EV via Wikipedia (cached)
    const list = [];
    const byYearIntent = new Map(); // abbr list per year to know which EVs to fetch
    for (const b of buckets.values()){
      const year = b.year, abbr = b.abbr;
      if (!byYearIntent.has(year)) byYearIntent.set(year, new Set());
      byYearIntent.get(year).add(abbr);
    }
    // fetch EV for all years we need (sequential to be nice)
    const evByYear = {};
    for (const year of Array.from(byYearIntent.keys()).sort((a,b)=>a-b)) {
      evByYear[year] = await fetchEVForYear(year);
    }

    for (const b of buckets.values()){
      const dem_pct = b.totals ? b.dem / b.totals : null;
      const rep_pct = b.totals ? b.rep / b.totals : null;
      const oth_pct = (dem_pct!=null && rep_pct!=null) ? Math.max(0, 1 - dem_pct - rep_pct) : null;
      const winner_party = (dem_pct!=null && rep_pct!=null) ? (dem_pct>rep_pct?"DEM":"REP") : "OTH";
      const ev = evByYear[b.year]?.[b.abbr] ?? null;
      list.push({
        year:b.year, state:b.state, abbr:b.abbr, state_fips:b.fips, ev,
        dem_pct, rep_pct, oth_pct, winner_party,
        winner_name:"", runner_name:"", dem_name:"", rep_name:""
      });
    }
    // 1976–2020 only; OK.
    return list;
  }

  // ---------- Load dataset ----------
  async function loadDataset(){
    // 1) try elections.json
    try{
      const res = await fetch(dataPrimaryJSON, {cache:"no-store"});
      if (res.ok) {
        const j = await res.json();
        return j.map(d => ({...d, state_fips: pad2(d.state_fips)}));
      }
    }catch(_){}
    // 2) build from local CSV
    try{
      const j = await buildFromLocalCSV();
      toast("Loaded 1976–2020 from local CSV.");
      return j;
    }catch(e){
      console.error(e);
      toast("Could not build from CSV; falling back to sample data.");
      // 3) last resort: sample
      const samp = await fetch(fallbackSample).then(r=>r.json());
      return samp.map(d => ({...d, state_fips: pad2(d.state_fips)}));
    }
  }

  // ---------- Boot ----------
  let rows;
  try {
    const [topology, data] = await Promise.all([
      fetch(topoUrl).then(r => r.json()),
      loadDataset()
    ]);
    rows = data;
    loading.remove();

    // ----- topo & layers -----
    const states = topojson.feature(topology, topology.objects.states).features;
    const nation = topojson.feature(topology, topology.objects.nation);
    const stCentroid = new Map(states.map(d => [d.id, d3.geoPath().centroid(d)]));
    const path = d3.geoPath(); // already projected

    const gNation = MAP_SEL.append("g").attr("class", "nation");
    const gStates = MAP_SEL.append("g").attr("class", "states");
    const gLabels = MAP_SEL.append("g").attr("class", "labels");

    gNation.append("path").datum(nation)
      .attr("fill", "#0f141c").attr("stroke", "#0b0d12").attr("d", path);

    gStates.selectAll("path.state")
      .data(states).join("path")
      .attr("class","state").attr("id", d => `s${d.id}`).attr("d", path);

    gLabels.selectAll("text.stateLabel")
      .data(states).join("text")
      .attr("class", "stateLabel")
      .attr("x", d => stCentroid.get(d.id)[0])
      .attr("y", d => stCentroid.get(d.id)[1])
      .text(d => d.properties?.abbr || d.properties?.name?.slice(0,2).toUpperCase() || "");

    // ----- data shaping -----
    const byYear  = d3.group(rows, d => +d.year);
    const byState = d3.group(rows, d => d.state_fips);

    const years = Array.from(byYear.keys()).sort((a,b)=>a-b);
    const slider = document.getElementById("year");
    const yearVal = document.getElementById("yearVal");
    slider.min = years[0]; slider.max = years.at(-1);
    if (!slider.value) slider.value = years[0];
    yearVal.textContent = slider.value;

    // HUD toggles (if present)
    const hud = document.getElementById("hud");
    const hudToggle = document.getElementById("hudToggle");
    if (hud && hudToggle) hudToggle.onclick = () => hud.classList.toggle("collapsed");
    const chartWrap = document.getElementById("chartWrap");
    const chartToggle = document.getElementById("chartToggle");
    if (chartWrap && chartToggle) chartToggle.onclick = () => chartWrap.classList.toggle("collapsed");

    // ----- caricatures -----
    const faceA = document.getElementById("faceA");
    const faceB = document.getElementById("faceB");
    const nameA = document.getElementById("nameA");
    const nameB = document.getElementById("nameB");
    const evA = document.getElementById("evA");
    const evB = document.getElementById("evB");
    function drawFace(el, name, party, winner=false) {
      const seed = Array.from(name||"X").reduce((a,c)=>a+c.charCodeAt(0),0);
      const r = 26 + (seed % 6);
      const stroke = party === "DEM" ? "#1f77b4" : party === "REP" ? "#d62728" : "#f2c744";
      const fill = "#f1d7c8";
      const brow = 10 + (seed % 4);
      const smile = (seed % 2) ? 6 : -4;
      if (!el) return;
      el.innerHTML = `
        <svg viewBox="0 0 100 100" width="72" height="72" aria-label="caricature ${name}">
          <circle cx="50" cy="50" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${winner?4:2}" />
          <path d="M ${50-r+6},${40} q ${r},-22 ${2*r-12},0" fill="${stroke}" opacity="0.25"/>
          <line x1="32" y1="${45-brow}" x2="45" y2="${45-brow-3}" stroke="#333" stroke-width="3" />
          <line x1="55" y1="${45-brow-3}" x2="68" y2="${45-brow}" stroke="#333" stroke-width="3" />
          <circle cx="38" cy="50" r="3.5" fill="#333"/>
          <circle cx="62" cy="50" r="3.5" fill="#333"/>
          <path d="M 35,${66+smile} q 15,${smile} 30,0" fill="none" stroke="#333" stroke-width="3" stroke-linecap="round"/>
        </svg>`;
    }

    // ----- hover popover + sparkline -----
    const hp = document.getElementById("hoverPanel");
    const hpName = document.getElementById("hpName");
    const hpEV = document.getElementById("hpEV");
    const hpWinner = document.getElementById("hpWinner");
    const hpPct = document.getElementById("hpPct");
    const spark = d3.select("#spark");
    const sx = d3.scaleLinear().range([6, 214]).domain([years[0], years.at(-1)]);
    const sy = d3.scaleLinear().range([46, 10]).domain([-0.6, 0.6]); // D−R margin
    const sG = spark.append("g");

    function showPopover(stateFips, year, evt) {
      if (!hp) return;
      const series = (byState.get(stateFips) || []).filter(d=>d.dem_pct!=null&&d.rep_pct!=null).sort((a,b)=>a.year-b.year);
      const cur = (byYear.get(+year) || []).find(r=>r.state_fips===stateFips);
      if (!cur) return;
      hp.hidden = false;
      hp.style.left = Math.min(evt.clientX+12, window.innerWidth-260) + "px";
      hp.style.top = Math.max(evt.clientY-10, 10) + "px";
      hpName.textContent = `${cur.state ?? ""} (${cur.abbr ?? ""})`;
      hpEV.textContent = `EV ${cur.ev ?? "–"}`;
      const margin = (cur.dem_pct ?? 0) - (cur.rep_pct ?? 0);
      const winner = cur.winner_party==="DEM"?"Democratic":cur.winner_party==="REP"?"Republican":"Third party";
      hpWinner.textContent = `${winner} win`;
      hpPct.textContent = (cur.dem_pct!=null&&cur.rep_pct!=null)
        ? `D ${Math.round(cur.dem_pct*100)}% · R ${Math.round(cur.rep_pct*100)}%${cur.oth_pct?` · O ${Math.round(cur.oth_pct*100)}%`:""} · Δ(D−R) ${(margin*100).toFixed(1)}`
        : "shares unavailable";

      sG.selectAll("*").remove();
      if (series.length) {
        const line = d3.line().x(d=>sx(d.year)).y(d=>sy((d.dem_pct??0) - (d.rep_pct??0))).curve(d3.curveMonotoneX);
        for (let i=0;i<series.length-1;i++){
          const a=series[i], b=series[i+1];
          sG.append("path")
            .attr("d", line([a,b]))
            .attr("stroke", a.winner_party==="DEM"?"#5fa9e5":a.winner_party==="REP"?"#ee6b6b":"#f2c744")
            .attr("fill","none").attr("stroke-width", (a.year===+year?3:1.75));
        }
        sG.append("line").attr("x1", sx(years[0])).attr("x2", sx(years.at(-1)))
          .attr("y1", sy(0)).attr("y2", sy(0)).attr("stroke","#2c3342").attr("stroke-dasharray","3,3");
        sG.append("circle").attr("cx", sx(+year)).attr("cy", sy(margin)).attr("r",4.5).attr("fill","#fff");
      }
    }
    function hidePopover(){ if (hp) hp.hidden = true; }

    // ----- EV strip chart -----
    const chartSel = d3.select("#evChart");
    const chartW = chartSel.node().clientWidth;
    const chartH = chartSel.node().clientHeight;
    const chartG = chartSel.append("g").attr("transform", `translate(10,${chartH/2})`);
    const chartX = d3.scaleLinear().range([0, chartW - 20]);

    function render(year) {
      yearVal.textContent = year;
      const data = byYear.get(+year) || [];

      const national = {
        dem: d3.sum(data, d => (d.winner_party === "DEM" ? (+d.ev||0) : 0)),
        rep: d3.sum(data, d => (d.winner_party === "REP" ? (+d.ev||0) : 0)),
        oth: d3.sum(data, d => (d.winner_party === "OTH" ? (+d.ev||0) : 0))
      };
      const winnerParty = national.dem>national.rep && national.dem>national.oth ? "DEM"
                         : national.rep>national.dem && national.rep>national.oth ? "REP" : "OTH";

      gStates.selectAll("path.state")
        .attr("fill", d => {
          const row = data.find(r => r.state_fips == d.id);
          return row ? colorParty(row.winner_party) : "#444c57";
        })
        .classed("winner", d => {
          const row = data.find(r => r.state_fips == d.id);
          return row && row.winner_party === winnerParty;
        })
        .on("mousemove", (evt, d) => {
          const row = data.find(r => r.state_fips == d.id);
          if (!row) return;
          showPopover(d.id, year, evt);
        })
        .on("mouseleave", hidePopover)
        .select("title").remove();

      gStates.selectAll("path.state").append("title")
        .text(d => {
          const row = data.find(r => r.state_fips == d.id);
          if (!row) return d.properties.name;
          const dPct = row.dem_pct!=null? Math.round(row.dem_pct*100)+"%":"–";
          const rPct = row.rep_pct!=null? Math.round(row.rep_pct*100)+"%":"–";
          const oPct = row.oth_pct!=null? Math.round(row.oth_pct*100)+"%":"–";
          const margin = (row.dem_pct!=null&&row.rep_pct!=null) ? ((row.dem_pct - row.rep_pct) * 100).toFixed(1)+" pts" : "n/a";
          const winnerName = row.winner_name || (row.winner_party==="DEM"?"Democratic":"Republican");
          return `${d.properties.name} (${row.abbr})\nEV ${row.ev ?? "–"}\nWinner: ${winnerName}\nDem ${dPct}  Rep ${rPct}  Oth ${oPct}\nΔ(D−R): ${margin}`;
        });

      // Candidate panels (best-effort names if present)
      const demName = data.find(d=>d.dem_name)?.dem_name || "Democratic";
      const repName = data.find(d=>d.rep_name)?.rep_name || "Republican";
      if (nameA) nameA.textContent = demName;
      if (nameB) nameB.textContent = repName;
      if (evA) evA.textContent = `EV: ${national.dem}`;
      if (evB) evB.textContent = `EV: ${national.rep}`;
      drawFace(faceA, demName, "DEM", winnerParty==="DEM");
      drawFace(faceB, repName, "REP", winnerParty==="REP");

      // EV strip chart
      const order = d3.sort(data, d => (d.dem_pct ?? 0) - (d.rep_pct ?? 0));
      const totalEV = d3.sum(order, d => +d.ev || 0) || 538;
      let x0 = 0;
      chartX.domain([0, totalEV]);

      const bars = chartG.selectAll("rect.seg").data(order, d => d.state_fips + ":" + year);
      bars.join(
        enter => enter.append("rect")
          .attr("class","seg")
          .attr("x", () => chartX(x0))
          .attr("y", -26)
          .attr("width", d => { const w = chartX(x0 + (+d.ev||0)) - chartX(x0); x0 += (+d.ev||0); return Math.max(1,w); })
          .attr("height", 52)
          .attr("fill", d => {
            if (d.winner_party === "OTH") return "#f2c744";
            if (d.dem_pct==null||d.rep_pct==null) return "#999";
            const delta = d.dem_pct - d.rep_pct;      // [-1,1]
            return d3.interpolateRdBu(0.5 - delta/2); // 0→red, 1→blue
          })
          .attr("stroke","#0b0d12")
          .append("title").text(d => `${d.state ?? d.abbr} • EV ${d.ev ?? "–"}`)
        ,
        update => update,
        exit => exit.remove()
      );
    }

    // slider & autoplay
    const slider = document.getElementById("year");
    const yearVal = document.getElementById("yearVal");
    slider.addEventListener("input", e => render(+e.target.value));
    render(+slider.value);

    let timer=null;
    const playBtn = document.getElementById("play");
    if (playBtn){
      playBtn.onclick = () => {
        if (timer){ clearInterval(timer); timer=null; playBtn.textContent="▶︎"; return; }
        playBtn.textContent="❚❚";
        timer=setInterval(()=>{
          const y=+slider.value, max=+slider.max;
          slider.value = (y>=max? +slider.min : y+4);
          render(+slider.value);
        }, 1200);
      };
    }

    // About modal
    const about = document.getElementById("about");
    const aboutBtn = document.getElementById("aboutBtn");
    const aboutClose = document.getElementById("aboutClose");
    if (about && aboutBtn && aboutClose){
      aboutBtn.onclick = () => about.showModal();
      aboutClose.onclick = () => about.close();
    }

  } catch (err) {
    console.error(err);
    loading.text("Failed to load map/data.");
  }
})();
