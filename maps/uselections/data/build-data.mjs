// Node 18+ recommended. If on Node 16, add: npm i node-fetch@3
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const OUT_JSON = path.join(DATA_DIR, "elections.json");
const LOCAL_MEDSL = path.join(DATA_DIR, "medsl_1976_2020.csv");

// MEDSL (state-level, President 1976–2020). Browser is blocked by CORS; Node is fine.
const MEDSL_URL = "https://dataverse.harvard.edu/api/access/datafile/3440651";

// ---- utilities ----
const pct = (x) => (x==null||x==="")? null : (+x>1? +x/100 : +x);
const pad2 = (s) => String(s ?? "").padStart(2,"0");
function parseCSV(text){
  const rows = text.trim().split(/\r?\n/);
  const cols = rows[0].split(",");
  return rows.slice(1).map(line=>{
    const vals = line.split(",");
    const o={}; cols.forEach((c,i)=>o[c]=vals[i]); return o;
  });
}
async function ensureDir(p){ try{ await fs.mkdir(p, {recursive:true}); }catch{} }

// ---- 1948–1972 from Wikipedia REST (server-side) ----
async function fetchWikiStates(start=1948,end=1972){
  const out=[];
  for(let y=start; y<=end; y+=4){
    const url = `https://en.wikipedia.org/api/rest_v1/page/html/${y}_United_States_presidential_election`;
    try{
      const html = await fetch(url, {headers:{accept:"text/html"}}).then(r=>r.ok?r.text():Promise.reject(new Error(r.statusText)));
      const rows = extractStateRowsFromHtml(html);
      rows.forEach(r => out.push({...r, year:y}));
      console.log(`✓ ${y} (${rows.length} states)`);
    }catch(e){
      console.warn(`! Could not parse ${y}:`, e.message);
    }
  }
  return out;
}
function extractStateRowsFromHtml(html){
  // super-lightweight parse: no DOM; regex-friendly extraction
  // Find the first "Results by state" table and pull rows heuristically
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?Results by state[\s\S]*?)<\/table>/i)
                    || html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if(!tableMatch) return [];
  const tableHtml = tableMatch[0];

  // split rows
  const rows = tableHtml.split(/<\/tr>/i).slice(1);
  const out=[];
  for(const tr of rows){
    const cells = Array.from(tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m=>m[1]);
    if(cells.length < 5) continue;

    // pull USPS abbrev if appears like (CA) or a bare 2-letter token
    const stateCell = cells[0].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    const abbrMatch = stateCell.match(/\(([A-Z]{2})\)/) || stateCell.match(/\b([A-Z]{2})\b/);
    const abbr = abbrMatch ? abbrMatch[1] : null;
    if(!abbr) continue;

    const num = (s) => {
      const m = String(s).replace(/<[^>]+>/g," ").replace(/[^\d.]/g,"").trim();
      return m ? +m : null;
    };
    const toPct = (s) => {
      const m = String(s).replace(/<[^>]+>/g," ").match(/(\d+(?:\.\d+)?)\s*%/);
      return m ? (+m[1]/100) : null;
    };

    // collect percentages from row, take top two as dem/rep (order unknown in old tables)
    const pcts = cells.map(toPct).filter(v => v!=null).sort((a,b)=>b-a);
    if(!pcts.length) continue;
    const dem_pct = pcts[0] ?? null;
    const rep_pct = pcts[1] ?? null;
    const oth_pct = (dem_pct!=null && rep_pct!=null) ? Math.max(0, 1-dem_pct-rep_pct) : null;

    // EV typically last or near-last numeric cell
    const evCandidates = cells.map(num).filter(v => v!=null && v<=100); // EV per state is modest
    const ev = evCandidates.length ? evCandidates[evCandidates.length-1] : null;

    const winner_party = (dem_pct!=null && rep_pct!=null) ? (dem_pct>rep_pct?"DEM":"REP") : "OTH";
    out.push({
      state:null, abbr, state_fips:null, ev,
      dem_pct, rep_pct, oth_pct, winner_party,
      winner_name:"", runner_name:"", dem_name:"", rep_name:""
    });
  }
  return out;
}

// ---- MEDSL 1976–2020 (state level) ----
async function loadMEDSL(){
  // try download first
  try{
    console.log("Downloading MEDSL (1976–2020) from Dataverse…");
    const buf = await fetch(MEDSL_URL).then(r=>r.ok?r.arrayBuffer():Promise.reject(new Error(r.statusText)));
    const txt = Buffer.from(buf).toString("utf8");
    return txt;
  }catch(e){
    console.warn("Could not download MEDSL:", e.message);
    // fallback to local file if user manually saved it
    try{
      console.log("Trying local data/medsl_1976_2020.csv …");
      return await fs.readFile(LOCAL_MEDSL, "utf8");
    }catch{
      throw new Error("MEDSL CSV unavailable. Download it in your browser and save to data/medsl_1976_2020.csv");
    }
  }
}

async function main(){
  await ensureDir(DATA_DIR);

  // 1) MEDSL
  const medTxt = await loadMEDSL();
  const med = parseCSV(medTxt)
    .filter(r => r.office==="President" && r.state_po && +r.year>=1976)
    .map(r=>{
      const dem = pct(r.democratic_percentage ?? r.dem_pct);
      const rep = pct(r.republican_percentage ?? r.rep_pct);
      const oth = (dem!=null && rep!=null) ? Math.max(0, 1-dem-rep) : null;
      const w = (r.winner || r.winner_party || r.party || "").toUpperCase();
      const winner_party = w.includes("DEMOCRAT")||w==="DEM" ? "DEM" : w.includes("REPUBLICAN")||w==="REP" ? "REP" : "OTH";
      return {
        year:+r.year, state:r.state, abbr:r.state_po, state_fips:pad2(r.state_fips),
        ev:+(r.total_electoral_votes || r.ev || 0),
        dem_pct:dem, rep_pct:rep, oth_pct:oth, winner_party,
        winner_name:r.winner_name||"", runner_name:r.runnerup_name||"",
        dem_name:r.dem_candidate||"", rep_name:r.rep_candidate||""
      };
    });
  console.log(`MEDSL rows: ${med.length}`);

  // 2) 1948–1972 from Wikipedia
  console.log("Building 1948–1972 from Wikipedia (state tables) …");
  const early = await fetchWikiStates(1948, 1972);
  console.log(`1948–1972 rows: ${early.length}`);

  // 3) Merge & write
  const merged = [...early, ...med].map(d => ({...d, state_fips: pad2(d.state_fips)}));
  await fs.writeFile(OUT_JSON, JSON.stringify(merged, null, 2));
  console.log(`✓ Wrote ${OUT_JSON} (${merged.length} rows).`);
}

main().catch(err => { console.error(err); process.exit(1); });
