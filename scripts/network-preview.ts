import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NetworkCatalog } from "@/lib/coverage/discovery-catalog";

/** Offline inspection only: no data preparation, publication, or external resources. */
export async function writeNetworkPreview(catalog: NetworkCatalog, catalogPath: string): Promise<string> {
  const destination = path.join(path.dirname(catalogPath), "networks.html");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const networks = catalog.networks.map(({ geometry, ...network }) => {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygons) for (const ring of polygon) for (const coordinate of ring) {
      bounds[0] = Math.min(bounds[0]!, coordinate[0]!); bounds[1] = Math.min(bounds[1]!, coordinate[1]!);
      bounds[2] = Math.max(bounds[2]!, coordinate[0]!); bounds[3] = Math.max(bounds[3]!, coordinate[1]!);
    }
    return { ...network, bounds };
  }).sort((a, b) => b.lengthMeters - a.lengthMeters || a.id.localeCompare(b.id));
  // '<' cannot terminate the embedded JSON script, even in untrusted source labels.
  const data = JSON.stringify({ networks, catalogPath: path.relative(process.cwd(), catalogPath), sources: catalog.recipe.sources.map(source => `${source.config.id} (${source.config.version})`) })
    .replace(/</g, "\\u003c").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Trail network discovery</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f3;color:#202a27;font:15px/1.5 system-ui,sans-serif}header,main{max-width:1200px;margin:auto;padding:24px}header{padding-bottom:0}h1{font-size:28px;margin:0}h2{font-size:18px;margin:0 0 12px}p{margin:8px 0;color:#53605a}.sources,code{overflow-wrap:anywhere}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,1fr);gap:24px}.panel{background:white;border:1px solid #d8ded8;border-radius:8px;padding:18px}label{display:block;font-size:13px;font-weight:600}input[type=search],select{width:100%;padding:9px;border:1px solid #a5b0a8;border-radius:4px;font:inherit}input[type=checkbox]{margin:12px 6px 12px 0}.filters{display:grid;grid-template-columns:1fr 160px;gap:12px}button{font:inherit;cursor:pointer;border:1px solid #bbc5bc;border-radius:4px;padding:7px 12px;background:white;color:inherit}button:hover{background:#edf3ec}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #176f54;outline-offset:2px}button:disabled{opacity:.45;cursor:default}#networks{list-style:none;margin:12px 0;padding:0;max-height:560px;overflow:auto}#networks button{display:block;text-align:left;width:100%;margin:0 0 6px;padding:10px}#networks button[aria-pressed=true]{border-color:#176f54;background:#e9f4eb}.network-id{display:block;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.metrics{display:block;font-size:13px;color:#53605a}.pagination{display:flex;align-items:center;gap:12px;justify-content:space-between}#map{display:block;width:100%;height:auto;aspect-ratio:4/3;background:#f2f5f0;border:1px solid #d8ded8;margin:12px 0}#map rect{vector-effect:non-scaling-stroke}#details{overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}dt{color:#53605a}dd{margin:0;text-align:right}code{display:block;padding:12px;background:#f1f3f0;font-size:12px;white-space:pre-wrap}small{color:#53605a}#map-caption,#copy-status{font-size:13px}@media(max-width:760px){header,main{padding:16px}.layout{grid-template-columns:1fr}.filters{grid-template-columns:1fr}#networks{max-height:330px}h1{font-size:24px}}
</style></head><body><header><h1>Trail network discovery</h1><p>Choose a complete connected network to prepare.</p><p class="sources" id="sources"></p></header>
<main class="layout"><section class="panel" aria-labelledby="list-title"><h2 id="list-title">Discovered networks</h2><div class="filters"><label>Find network ID<input type="search" id="filter" placeholder="Paste all or part of an ID"></label><label>Sort by<select id="sort"><option value="lengthMeters">Trail length</option><option value="cycleRank">Structural cycle rank</option><option value="physicalEdgeCount">Trail edges</option></select></label></div><label><input type="checkbox" id="loops">Only networks with structural cycles</label><p id="count" role="status"></p><ul id="networks"></ul><nav class="pagination" aria-label="Network pages"><button id="previous">Previous</button><span id="page"></span><button id="next">Next</button></nav></section>
<section class="panel" aria-labelledby="map-title"><h2 id="map-title">Network extents</h2><p>Bounding boxes only, not trail geometry or exact coverage. North is up; coordinates are longitude / latitude.</p><svg id="map" viewBox="0 0 640 480" role="img" aria-label="Network extent overview"></svg><p id="map-caption"></p><button id="overview" hidden>Show this page’s extents</button><div id="details"><p>Select a network to inspect its full extent and build command.</p></div><p><small>Structural cycle rank is edges − nodes + 1 in the undirected graph. It is not a count of viable hike routes. Rank zero has no simple loops. Direction, access and hiking constraints still matter.</small></p><p><small>Preparation and download size: unknown until built. Trail length counts each physical segment once.</small></p></section></main>
<script id="catalog" type="application/json">${data}</script><script>
const data = JSON.parse(document.getElementById('catalog').textContent);
const byId = new Map(data.networks.map(network => [network.id, network]));
const get = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const quote = value => "'" + value.replace(/'/g, "'\\\"'\\\"'") + "'";
let matches = data.networks, page = 0, selected = null;
const pageSize = 100;
get('sources').textContent = 'Pinned sources: ' + (data.sources.join(', ') || 'none');
function element(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function current() { return matches.slice(page * pageSize, (page + 1) * pageSize); }
function draw(focus) {
  const visible = focus ? [focus] : current();
  get('map').replaceChildren(); get('overview').hidden = !focus;
  if (!visible.length) { get('map-caption').textContent = 'No network extents to display.'; return; }
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const network of visible) { bounds[0] = Math.min(bounds[0], network.bounds[0]); bounds[1] = Math.min(bounds[1], network.bounds[1]); bounds[2] = Math.max(bounds[2], network.bounds[2]); bounds[3] = Math.max(bounds[3], network.bounds[3]); }
  const factor = Math.max(0.01, Math.cos((bounds[1] + bounds[3]) / 2 * Math.PI / 180));
  const scale = Math.min(580 / Math.max((bounds[2] - bounds[0]) * factor, 0.000001), 420 / Math.max(bounds[3] - bounds[1], 0.000001));
  const x = value => 320 + (value - (bounds[0] + bounds[2]) / 2) * factor * scale;
  const y = value => 240 - (value - (bounds[1] + bounds[3]) / 2) * scale;
  for (const network of visible) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'), b = network.bounds;
    for (const [key, value] of Object.entries({x:x(b[0]),y:y(b[3]),width:Math.max(2,x(b[2])-x(b[0])),height:Math.max(2,y(b[1])-y(b[3])),fill:focus?'#7bbb93':'#bfd3c4','fill-opacity':0.3,stroke:'#176f54','stroke-width':focus?2:1})) rect.setAttribute(key, String(value));
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = network.id; rect.append(title); get('map').append(rect);
  }
  get('map-caption').textContent = (focus ? 'Full selected network extent' : 'Extents on this page (' + visible.length + ' networks)') + ': west ' + bounds[0].toFixed(5) + ', south ' + bounds[1].toFixed(5) + ', east ' + bounds[2].toFixed(5) + ', north ' + bounds[3].toFixed(5) + '.';
}
function clearSelection() { selected = null; get('details').replaceChildren(element('p', 'Select a network to inspect its full extent and build command.')); }
function select(id) {
  selected = byId.get(id);
  for (const button of get('networks').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === id));
  const details = get('details'); details.replaceChildren(element('h2', 'Selected network'), element('code', id));
  const stats = document.createElement('dl');
  for (const [label, value] of [['Physical trail length', number(selected.lengthMeters / 1000) + ' km'], ['Nodes', number(selected.nodeCount)], ['Physical trail edges', number(selected.physicalEdgeCount)], ['Structural cycle rank', number(selected.cycleRank)]]) stats.append(element('dt', label), element('dd', value));
  details.append(stats, element('p', selected.sourceBoundaryLimited ? 'Source-boundary limited: this network reaches the supported source boundary. It may continue beyond the available data.' : 'No source-boundary truncation detected. This does not prove that source data is complete.'));
  if (!selected.cycleRank) details.append(element('p', 'This network has no simple loops and cannot produce loop or lollipop routes.'));
  details.append(element('h2', 'Prepare this network'));
  const command = 'npm run data -- build ' + quote(data.catalogPath) + ' --network ' + quote(id);
  details.append(element('code', command), element('p', 'Run from the repository root. For Docker, use the same catalog path and network ID with your data service command.'));
  const copy = element('button', 'Copy network ID'), status = element('span', ''); status.id = 'copy-status'; status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(id); status.textContent = ' Copied'; } catch { status.textContent = ' Clipboard unavailable; select and copy the ID above.'; } });
  details.append(copy, status); draw(selected);
}
function render() {
  const list = get('networks'); list.replaceChildren();
  for (const network of current()) {
    const item = document.createElement('li'), button = document.createElement('button'); button.dataset.id = network.id; button.setAttribute('aria-pressed', String(selected?.id === network.id));
    button.append(element('span', network.id, 'network-id'), element('span', number(network.lengthMeters / 1000) + ' km · ' + number(network.physicalEdgeCount) + ' edges · cycle rank ' + number(network.cycleRank) + (network.sourceBoundaryLimited ? ' · boundary limited' : ''), 'metrics'));
    button.addEventListener('click', () => select(network.id)); item.append(button); list.append(item);
  }
  get('count').textContent = number(matches.length) + ' matching / ' + number(data.networks.length) + ' total networks';
  get('page').textContent = matches.length ? 'Page ' + (page + 1) + ' of ' + Math.ceil(matches.length / pageSize) : 'No matches';
  get('previous').disabled = page === 0; get('next').disabled = (page + 1) * pageSize >= matches.length; list.scrollTop = 0; draw(selected);
}
function filter() {
  const query = get('filter').value.trim().toLowerCase(), key = get('sort').value;
  matches = data.networks.filter(network => network.id.includes(query) && (!get('loops').checked || network.cycleRank > 0)).sort((a,b) => b[key] - a[key] || a.id.localeCompare(b.id));
  page = 0; clearSelection(); render();
}
get('filter').addEventListener('input', filter); get('sort').addEventListener('change', filter); get('loops').addEventListener('change', filter);
get('previous').addEventListener('click', () => { page--; clearSelection(); render(); }); get('next').addEventListener('click', () => { page++; clearSelection(); render(); });
get('overview').addEventListener('click', () => draw(null)); render();
</script></body></html>`;
  try {
    await writeFile(temporary, html, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return destination;
}
