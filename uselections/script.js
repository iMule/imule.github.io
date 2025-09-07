/* US Elections Map — Albers USA with AK/HI insets (states-albers TopoJSON)
 * Network-sane version:
 *  • Loads a single local file: /data/elections.json  (full 1948–2020 you’ll generate)
 *  • If missing, falls back to /data/elections.sample.json and shows a toast
 *  • No live fetches to Harvard/Wikipedia ⇒ no CORS problems at runtime
 *  • Year slider HUD on-map; winner glow; candidate caricatures; hover sparkline; EV strip chart
 *  • ME/NE treated WTA (can add CD splits later)
 */
(async function () {
  // ---------- Config ----------
  // Use the official us-atlas TopoJSON (already projected Albers USA; AK/HI insets)
  const topoUrl = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-albers-10m.json";
  // Primary dataset (place this file locally); fallback to a tiny sample if absent
  const dataPrimary = "data/elections.json";
  const dataFallback = "data/elections.sample.json";

  const MAP_SEL = d3.select("#map");
  const WIDTH  = MAP_SEL.node().clientWidth;
  const HEIGHT = MAP_SEL.node().clientHeight;

  // Party & swing colors
  const colorParty = d3.scaleOrdinal()
    .domain(["DEM", "REP", "OTH"])
    .range(["#1f77b4", "#d62728", "#f2c744"]);

  // ---------- Loading state ----------
  const loading = MAP_SEL.append("text")
    .attr("x", WIDTH/2).attr("y", HEIGHT/2)
    .attr("fill", "#a8b0ba").attr("text-anchor", "middle")
    .text("Loading map & data…");

  // ---------- tiny toast ----------
  function toast(msg, ms=3800){
    const t = document.body.appendChild(Object.assign(document.createElement("div"), {
      className:"toast",
      textContent:msg
    }));
    Object.assign(t.style,{
      position:"fixed", left:"1rem", bottom:"1rem", zIndex:9999,
      background:"#1d2130", color:"#e8eaed", border:"1px solid #2b3140",
      padding:".5rem .65rem", borderRadius:"10px", boxShadow:"0 8px 24px rgba(0,0,0,.4)",
      font:"13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial"
    });
    setTimeout(()=>t.remove(), ms);
  }

  // ---------- Safe dataset loader ----------
  async function loadJSON(url){
    const res = await fetch(url, {cache:"no-store"});
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  let rows;
  try {
    rows = await loadJSON(dataPrimary);
  } catch (e) {
    toast("Full dataset not found. Using sample data (drop elections.json in /data/ to enable all years).");
    rows = await loadJSON(dataFallback);
  }

  try {
    const topology = await fetch(topoUrl, {cache:"force-cache"}).then(r=>r.json());
    loading.remove();

    // ---------- Topology & layers ----------
    const states = topojson.feature(topology, topology.objects.states).features;
    const nation = topojson.feature(topology, topology.objects.nation);
    const stCentroid = new Map(states.map(d => [d.id, d3.geoPath().centroid(d)]));
    const path = d3.geoPath(); // works because geometry is pre-projected Albers USA

    const gNation = MAP_SEL.append("g").attr("class", "nation");
    const gStates = MAP_SEL.append("g").attr("class", "states");
    const gLabels = MAP_SEL.append("g").attr("class", "labels");

    gNation.append("path").datum(nation)
      .attr("fill", "#0f141c").attr("stroke", "#0b0d12").attr("d", path);

    gStates.selectAll("path.state")
      .data(states).join("path")
      .attr("class","state").attr("id", d => `s${d.id}`).attr("d", path);

    // USPS labels
    gLabels.selectAll("text.stateLabel")
      .data(states).join("text")
      .attr("class", "stateLabel")
      .attr("x", d => stCentroid.get(d.id)[0])
      .attr("y", d => stCentroid.get(d.id)[1])
      .text(d => d.properties?.abbr || d.properties?.name?.slice(0,2).toUpperCase() || "");

    // ---------- Data shaping ----------
    // Expected row: {year, state_fips, state, abbr, ev, dem_pct, rep_pct, oth_pct, winner_party, winner_name, runner_name, dem_name, rep_name}
    const byYear  = d3.group(rows, d => +d.year);
    const byState = d3.group(rows, d => d.state_fips);

    const years = Array.from(byYear.keys()).sort((a,b)=>a-b);

    // HUD controls (ensure these exist only once!)
    const slider = document.getElementById("year");
    const yearVal = document.getElementById("yearVal");
    slider.min = years[0]; slider.max = years.at(-1);
    if (!slider.value) slider.value = years[0];
    yearVal.textContent = slider.value;

    // HUD / chart collapse toggles (optional elements)
    const hud = document.getElementById("hud");
    const hudToggle = document.getElementById("hudToggle");
    if (hud && hudToggle) hudToggle.onclick = () => hud.classList.toggle("collapsed");
    const chartWrap = document.getElementById("chartWrap");
    const chartToggle = document.getElementById("chartToggle");
    if (chartWrap && chartToggle) chartToggle.onclick = () => chartWrap.classList.toggle("collapsed");

    // ---------- Caricatures ----------
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

    // ---------- Hover popover + sparkline ----------
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

      // spark
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

    // ---------- Rendering ----------
    const chartSel = d3.select("#evChart");
    const chartW = chartSel.node().clientWidth;
    const chartH = chartSel.node().clientHeight;
    const chartG = chartSel.append("g").attr("transform", `translate(10,${chartH/2})`);
    const chartX = d3.scaleLinear().range([0, chartW - 20]);

    function render(year) {
      yearVal.textContent = year;
      const data = byYear.get(+year) || [];

      // National EV tallies by winner
      const national = {
        dem: d3.sum(data, d => (d.winner_party === "DEM" ? (+d.ev||0) : 0)),
        rep: d3.sum(data, d => (d.winner_party === "REP" ? (+d.ev||0) : 0)),
        oth: d3.sum(data, d => (d.winner_party === "OTH" ? (+d.ev||0) : 0))
      };
      const winnerParty = national.dem>national.rep && national.dem>national.oth ? "DEM"
                         : national.rep>national.dem && national.rep>national.oth ? "REP" : "OTH";

      // Update states & interactivity
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

      // (Re)attach simple native title tooltips
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

      // Candidate panels
      const demName = data.find(d=>d.dem_name)?.dem_name || "Democratic";
      const repName = data.find(d=>d.rep_name)?.rep_name || "Republican";
      nameA && (nameA.textContent = demName);
      nameB && (nameB.textContent = repName);
      evA && (evA.textContent = `EV: ${national.dem}`);
      evB && (evB.textContent = `EV: ${national.rep}`);
      drawFace(faceA, demName, "DEM", winnerParty==="DEM");
      drawFace(faceB, repName, "REP", winnerParty==="REP");

      // Bottom EV strip chart (order by margin blue→red)
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

    // Wire slider & autoplay
    slider.addEventListener("input", e => render(+e.target.value));
    render(+slider.value);

    let timer=null;
    const playBtn = document.getElementById("play");
    if (playBtn){
      playBtn.onclick = () => {
        if (timer){ clearInterval(timer); timer=null; playBtn.textContent="▶︎"; return; }
        playBtn.textContent="❚❚";
        timer=setInterval(()=>{
          const y=+slider.value; const max=+slider.max;
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
