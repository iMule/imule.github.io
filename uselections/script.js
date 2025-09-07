/* US Elections Map — Albers USA with AK/HI insets (states-albers TopoJSON)
 * Features:
 *  • Full 1948–2020 dataset downloaded on first load (Wikipedia 1948–1972; MEDSL 1976–2020), cached in localStorage
 *  • Year slider, state fills (RED/BLUE/YELLOW), winner glow
 *  • Candidate caricatures (procedural SVG)
 *  • Per-state EV labels (abbr), tooltips
 *  • Hover popover with sparkline of D–R margin across years (color by winner)
 *  • Bottom D3 EV-share strip chart colored by |margin from 50%|
 * Notes: ME/NE treated as winner-take-all here; we can add CD splits later.
 */
(async function () {
  // ---------- Config ----------
  const topoUrl = "data/states-albers-10m.json"; // Albers USA projection with AK/HI insets (us-atlas)
  const MEDSL_URL = "https://dataverse.harvard.edu/api/access/datafile/3440651"; // U.S. President 1976–2020 (state-level). :contentReference[oaicite:4]{index=4}
  // Curated JSON for 1948–1972 (clean parse from Wikipedia "Results by state" tables).
  const WIKI48_72 = "https://raw.githubusercontent.com/vis-utils/us-presidential-1948-1972/main/wiki_1948_1972.json"; // 1948–1972. :contentReference[oaicite:5]{index=5}

  const MAP_SEL = d3.select("#map");
  const WIDTH  = MAP_SEL.node().clientWidth;
  const HEIGHT = MAP_SEL.node().clientHeight;

  const colorParty = d3.scaleOrdinal()
    .domain(["DEM", "REP", "OTH"])
    .range(["#1f77b4", "#d62728", "#f2c744"]); // blue, red, yellow

  // ---------- Loading state ----------
  const loading = MAP_SEL.append("text")
    .attr("x", WIDTH/2).attr("y", HEIGHT/2)
    .attr("fill", "#a8b0ba").attr("text-anchor", "middle")
    .text("Loading map & data…");

  // ---------- Helpers ----------
  const csvParseSimple = (text) => {
    // lightweight parser for MEDSL CSV (fields are simple)
    const lines = text.trim().split(/\r?\n/);
    const cols = lines[0].split(",");
    return lines.slice(1).map(line=>{
      const vals = line.split(",");
      const o={}; cols.forEach((c,i)=>o[c]=vals[i]); return o;
    });
  };
  const pct = (n) => {
    const x = +n; if (!isFinite(x)) return null;
    // MEDSL sometimes stores pct as 0-100; normalize to 0-1
    return (x>1? x/100 : x);
  };
  const pad2 = (s) => (s==null? "": String(s).padStart(2,"0"));

  // ---------- Fetch / cache dataset ----------
  async function getDataset() {
    const key = "usPres_1948_2020_v1";
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);

    // Fetch 1948–1972 (precompiled from Wikipedia)
    const oldRows = await fetch(WIKI48_72).then(r=>r.json());

    // Fetch MEDSL 1976–2020 CSV (state returns)
    const medsl = await fetch(MEDSL_URL).then(r=>r.text());
    const rows = csvParseSimple(medsl)
      .filter(r => r.office === "President" && r.state_po && +r.year >= 1976)
      .map(r => {
        // Try flexible field names (MEDSL schema revs)
        const dem = pct(r.democratic_percentage ?? r.dem_pct);
        const rep = pct(r.republican_percentage ?? r.rep_pct);
        const oth = (dem!=null && rep!=null) ? Math.max(0, 1 - dem - rep) : null;
        // Normalize winner
        const w = (r.winner || r.winner_party || r.party || "").toUpperCase();
        const winner_party = w.includes("DEMOCRAT")||w==="DEM" ? "DEM" : w.includes("REPUBLICAN")||w==="REP" ? "REP" : "OTH";
        return {
          year:+r.year,
          state:r.state,
          abbr:r.state_po,
          state_fips: pad2(r.state_fips),
          ev:+(r.total_electoral_votes || r.ev || 0),
          dem_pct:dem, rep_pct:rep, oth_pct:oth,
          winner_party,
          winner_name: r.winner_name || "",
          runner_name: r.runnerup_name || "",
          dem_name: r.dem_candidate || "",
          rep_name: r.rep_candidate || ""
        };
      });

    // Merge
    const merged = [...oldRows, ...rows].map(d => ({...d, state_fips: pad2(d.state_fips)}));
    localStorage.setItem(key, JSON.stringify(merged));
    return merged;
  }

  try {
    const [topology, rows] = await Promise.all([
      fetch(topoUrl).then(r => r.json()),
      getDataset()
    ]);
    loading.remove();

    // ---------- Topology & layers ----------
    const states = topojson.feature(topology, topology.objects.states).features;
    const nation = topojson.feature(topology, topology.objects.nation);
    const stById = new Map(states.map(d => [d.id, d]));
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
    // Expected schema per row:
    // {year, state_fips, state, abbr, ev, dem_pct, rep_pct, oth_pct, winner_party, winner_name, runner_name, dem_name, rep_name}
    const byYear = d3.group(rows, d => +d.year);
    const byState = d3.group(rows, d => d.state_fips);

    const years = Array.from(byYear.keys()).sort((a,b)=>a-b);
    const slider = document.getElementById("year");
    const yearVal = document.getElementById("yearVal");
    slider.min = years[0]; slider.max = years.at(-1); slider.value = years[0]; yearVal.textContent = slider.value;

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
      const series = (byState.get(stateFips) || []).filter(d=>d.dem_pct!=null&&d.rep_pct!=null).sort((a,b)=>a.year-b.year);
      const cur = (byYear.get(+year) || []).find(r=>r.state_fips===stateFips);
      if (!cur) return;
      hp.hidden = false;
      hp.style.left = Math.min(evt.clientX+12, window.innerWidth-260) + "px";
      hp.style.top = Math.max(evt.clientY-10, 10) + "px";
      hpName.textContent = `${cur.state} (${cur.abbr})`;
      hpEV.textContent = `EV ${cur.ev}`;
      const margin = (cur.dem_pct - cur.rep_pct);
      const winner = cur.winner_party==="DEM"?"Democratic":cur.winner_party==="REP"?"Republican":"Third party";
      hpWinner.textContent = `${winner} win`;
      hpPct.textContent = (cur.dem_pct!=null&&cur.rep_pct!=null)
        ? `D ${Math.round(cur.dem_pct*100)}% · R ${Math.round(cur.rep_pct*100)}%${cur.oth_pct?` · O ${Math.round(cur.oth_pct*100)}%`:""} · Δ(D−R) ${(margin*100).toFixed(1)}`
        : "shares unavailable";

      // Sparkline segments colored by winner that year
      sG.selectAll("*").remove();
      if (series.length) {
        const line = d3.line().x(d=>sx(d.year)).y(d=>sy(d.dem_pct - d.rep_pct)).curve(d3.curveMonotoneX);
        // segmented path per year pair to color by winner
        for (let i=0;i<series.length-1;i++){
          const a=series[i], b=series[i+1];
          sG.append("path")
            .attr("d", line([a,b]))
            .attr("stroke", a.winner_party==="DEM"?"#5fa9e5":a.winner_party==="REP"?"#ee6b6b":"#f2c744")
            .attr("fill","none").attr("stroke-width", (a.year===+year?3:1.75));
        }
        // baseline at 0
        sG.append("line").attr("x1", sx(years[0])).attr("x2", sx(years.at(-1)))
          .attr("y1", sy(0)).attr("y2", sy(0)).attr("stroke","#2c3342").attr("stroke-dasharray","3,3");
        // pin
        sG.append("circle").attr("cx", sx(+year)).attr("cy", sy(margin)).attr("r",4.5).attr("fill","#fff").attr("filter","url(#softGlow)");
      }
    }
    function hidePopover(){ hp.hidden = true; }

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
        dem: d3.sum(data, d => (d.winner_party === "DEM" ? d.ev : 0)),
        rep: d3.sum(data, d => (d.winner_party === "REP" ? d.ev : 0)),
        oth: d3.sum(data, d => (d.winner_party === "OTH" ? d.ev : 0))
      };
      const winnerParty = national.dem>national.rep && national.dem>national.oth ? "DEM"
                         : national.rep>national.dem && national.rep>national.oth ? "REP" : "OTH";

      // Update states & tooltips/hover
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
        .append("title")
        .text(d => {
          const row = data.find(r => r.state_fips == d.id);
          if (!row) return d.properties.name;
          const margin = (row.dem_pct!=null&&row.rep_pct!=null) ? ((row.dem_pct - row.rep_pct) * 100).toFixed(1)+" pts" : "n/a";
          const winnerName = row.winner_name || (row.winner_party==="DEM"?"Democratic":"Republican");
          const dPct = row.dem_pct!=null? Math.round(row.dem_pct*100)+"%":"–";
          const rPct = row.rep_pct!=null? Math.round(row.rep_pct*100)+"%":"–";
          const oPct = row.oth_pct!=null? Math.round(row.oth_pct*100)+"%":"–";
          return `${d.properties.name} (${row.abbr})\nEV ${row.ev}\nWinner: ${winnerName}\nDem ${dPct}  Rep ${rPct}  Oth ${oPct}\nΔ(D−R): ${margin}`;
        });

      // Candidate panels (best-effort names)
      const demName = data.find(d=>d.dem_name)?.dem_name || "Democratic";
      const repName = data.find(d=>d.rep_name)?.rep_name || "Republican";
      nameA.textContent = demName;
      nameB.textContent = repName;
      evA.textContent = `EV: ${national.dem}`;
      evB.textContent = `EV: ${national.rep}`;
      drawFace(faceA, demName, "DEM", winnerParty==="DEM");
      drawFace(faceB, repName, "REP", winnerParty==="REP");

      // Bottom EV strip chart (order by margin blue→red)
      const order = d3.sort(data, d => (d.dem_pct ?? 0) - (d.rep_pct ?? 0));
      const totalEV = d3.sum(order, d => d.ev) || 538;
      let x0 = 0;
      chartX.domain([0, totalEV]);

      const bars = chartG.selectAll("rect.seg").data(order, d => d.state_fips + ":" + year);
      bars.join(
        enter => enter.append("rect")
          .attr("class","seg")
          .attr("x", () => chartX(x0))
          .attr("y", -26)
          .attr("width", d => { const w = chartX(x0 + d.ev) - chartX(x0); x0 += d.ev; return Math.max(1,w); })
          .attr("height", 52)
          .attr("fill", d => {
            if (d.winner_party === "OTH") return "#f2c744";
            if (d.dem_pct==null||d.rep_pct==null) return "#999"; // fallback
            const delta = d.dem_pct - d.rep_pct;      // [-1,1]
            return d3.interpolateRdBu(0.5 - delta/2); // 0→red, 1→blue
          })
          .attr("stroke","#0b0d12")
          .append("title").text(d => `${d.state} • EV ${d.ev}`)
        ,
        update => update,
        exit => exit.remove()
      );
    }

    // Wire slider & autoplay
    const slider = document.getElementById("year");
    const yearVal = document.getElementById("yearVal");
    slider.addEventListener("input", e => render(+e.target.value));
    render(+slider.value);

    let timer=null;
    document.getElementById("play").onclick = () => {
      if (timer){ clearInterval(timer); timer=null; document.getElementById("play").textContent="▶︎ Play"; return; }
      document.getElementById("play").textContent="❚❚ Pause";
      timer=setInterval(()=>{
        const y=+slider.value; const max=+slider.max;
        slider.value = (y>=max? +slider.min : y+4);
        render(+slider.value);
      }, 1200);
    };

    // About modal
    const about = document.getElementById("about");
    document.getElementById("aboutBtn").onclick = () => about.showModal();
    document.getElementById("aboutClose").onclick = () => about.close();

  } catch (err) {
    console.error(err);
    loading.text("Failed to load map/data.");
  }
})();
