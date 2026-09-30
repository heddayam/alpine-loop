/** Temporary, offline bridge from sealed evidence to the replacement's model.
 * This is not a supported runtime format migration or a regional compiler.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = access => access === 'public' || access === 'unknown';
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

export const pilotPlaces = {
  'snoqualmie-region': [
    { name: 'North Bend trails', bounds: [-121.82, 47.43, -121.68, 47.54] },
    { name: 'Middle Fork Snoqualmie', bounds: [-121.62, 47.50, -121.43, 47.61] },
    { name: 'Snoqualmie Pass', bounds: [-121.54, 47.35, -121.35, 47.47] },
  ],
  'central-cascades': [
    { name: 'Stevens Pass', bounds: [-121.15, 47.70, -120.94, 47.84] },
    { name: 'Lake Wenatchee', bounds: [-120.94, 47.75, -120.70, 47.91] },
  ],
  'mount-rainier-area': [
    { name: 'Paradise', bounds: [-121.80, 46.76, -121.67, 46.82] },
    { name: 'Sunrise', bounds: [-121.70, 46.87, -121.57, 46.95] },
    { name: 'Carbon River', bounds: [-122.04, 46.96, -121.88, 47.04] },
  ],
};

/** Preserve whole physical corridors and source metrics; never clip to a view. */
export function convertDatabase(db, info) {
  const nodes = [];
  const nodeIds = [];
  const nodeIndex = new Map();
  for (const row of db.prepare('SELECT id,lon,lat,elevation_m FROM nodes ORDER BY id').iterate()) {
    nodeIndex.set(row.id, nodes.length);
    nodeIds.push(row.id);
    nodes.push(row.elevation_m === null ? [row.lon, row.lat] : [row.lon, row.lat, row.elevation_m]);
  }
  const trails = [];
  const edges = [];
  const edgeIds = [];
  const physicalIndex = new Map();
  const directions = new Set();
  for (const row of db.prepare(`SELECT e.*,p.stable_physical_id FROM edges e
    JOIN physical_edges p USING(physical_edge_key) ORDER BY e.id`).iterate()) {
    if (!allowed(row.access_state)) continue;
    const coordinates = JSON.parse(row.geometry);
    const from = nodeIndex.get(row.from_node);
    const to = nodeIndex.get(row.to_node);
    if (from === undefined || to === undefined || !samePoint(nodes[from], coordinates[0])
      || !samePoint(nodes[to], coordinates.at(-1))) throw new Error(`Endpoint mismatch: ${row.id}`);
    if (!(row.length_m > 0) || !Number.isFinite(row.gain_m) || row.gain_m < 0)
      throw new Error(`Missing or invalid measured metric: ${row.id}`);
    let trail = physicalIndex.get(row.physical_edge_key);
    if (trail === undefined) {
      trail = trails.length;
      physicalIndex.set(row.physical_edge_key, trail);
      const name = JSON.parse(row.flags).find(flag => flag.startsWith('trail-name:'))?.slice(11) ?? null;
      trails.push({ id: row.stable_physical_id, name, coordinates });
    }
    const stored = trails[trail].coordinates;
    const forward = JSON.stringify(stored) === JSON.stringify(coordinates);
    const reverse = !forward && JSON.stringify([...stored].reverse()) === JSON.stringify(coordinates);
    if (!forward && !reverse) throw new Error(`Physical geometry conflict: ${row.id}`);
    const direction = `${trail}:${reverse}`;
    if (directions.has(direction)) throw new Error(`Duplicate physical direction: ${row.id}`);
    directions.add(direction);
    edges.push({ from, to, trail, reverse, distance: row.length_m, gain: row.gain_m, access: row.access_state });
    edgeIds.push(row.id);
  }
  const departures = new Set(edges.map(edge => edge.from));
  const starts = [];
  for (const row of db.prepare('SELECT id,node_id,name,access_state FROM access_points ORDER BY id').iterate()) {
    const node = nodeIndex.get(row.node_id);
    if (allowed(row.access_state) && node !== undefined && departures.has(node))
      starts.push({ id: row.id, node, name: row.name, access: row.access_state });
  }
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of nodes) {
    bounds[0] = Math.min(bounds[0], lon);
    bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon);
    bounds[3] = Math.max(bounds[3], lat);
  }
  return {
    graph: { version: 1, info: { ...info, bounds, startCount: starts.length }, nodes, edges, starts },
    geometry: trails,
    sourceIndex: { nodeIds, edgeIds },
  };
}

export async function exportPilot(releaseRoot, regionId, outputRoot) {
  if (!pilotPlaces[regionId]) throw new Error(`Unsupported pilot region: ${regionId}`);
  const release = JSON.parse(await readFile(path.join(releaseRoot, 'release.json'), 'utf8'));
  const artifact = release.artifacts.find(entry => entry.regionId === regionId);
  if (!artifact) throw new Error(`Missing sealed artifact: ${regionId}`);
  const receipt = JSON.parse(await readFile(path.join(releaseRoot, '.audits', `${artifact.id}.json`), 'utf8'));
  const compressed = await readFile(path.join(releaseRoot, artifact.path));
  if (compressed.length !== artifact.compressedBytes || digest(compressed) !== receipt.compressedHash)
    throw new Error('Compressed artifact does not match its semantic audit receipt');
  const raw = gunzipSync(compressed);
  if (raw.length !== artifact.bytes || digest(raw) !== artifact.id) throw new Error('Sealed raw artifact hash mismatch');
  // Only decompress a completed immutable object; never open the build/cache DB.
  if (raw[18] !== 1 || raw[19] !== 1) throw new Error('Pilot input must use DELETE journal mode, not WAL');
  const temporary = await mkdtemp(path.join(tmpdir(), 'alpine-sealed-pilot-'));
  let db;
  try {
    const file = path.join(temporary, 'source.sqlite');
    await writeFile(file, raw);
    db = new DatabaseSync(file, { readOnly: true });
    const metadata = new Map(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, row.value]));
    if (metadata.get('releaseId') !== artifact.graphId || metadata.get('schemaVersion') !== '7')
      throw new Error('Sealed graph identity mismatch');
    const sources = db.prepare('SELECT * FROM sources ORDER BY id').all();
    const section = release.sections.find(entry => entry.id === regionId);
    const result = convertDatabase(db, {
      id: `pilot-${regionId}-${artifact.id.slice(0, 12)}`,
      name: `${section.name} — real-data pilot`,
      sourceDate: '2026-08-01',
      attribution: sources.map(source => ({ name: source.authority, url: source.url, license: source.license })),
      limitations: [
        'Temporary evidence dataset exported from an existing sealed graph; not complete Washington coverage.',
        'Starts inherit obsolete mountain-core qualification. Many valid non-mountain starts are absent.',
        'The source graph inherited fixed 50-mile preparation bounds and geographic exclusions. Longer searches may miss routes outside that finite graph.',
        'Unknown mapped access is retained and labeled. Source topology, permissions and elevation can be incomplete or stale.',
        'Drawing geometry preserves source coordinates; measured distance and gain come from the sealed artifact, not newly sampled elevations.',
      ],
      places: pilotPlaces[regionId],
    });
    await mkdir(outputRoot, { recursive: true });
    const files = {};
    for (const [name, value] of [['graph', result.graph], ['geometry', result.geometry], ['source-index', result.sourceIndex]]) {
      const json = Buffer.from(JSON.stringify(value));
      const bytes = gzipSync(json, { level: 9 });
      await writeFile(path.join(outputRoot, `${name}.json.gz`), bytes);
      files[name] = { bytes: bytes.length, jsonBytes: json.length, sha256: digest(bytes) };
    }
    const evidence = {
      datasetId: result.graph.info.id, regionId, releaseId: release.id,
      artifact: { id: artifact.id, graphId: artifact.graphId, compressedHash: receipt.compressedHash,
        compressedBytes: compressed.length, bytes: raw.length },
      sourceSnapshots: sources.map(source => ({ id: source.id, version: source.version,
        contentHash: source.content_hash, url: source.url })),
      counts: { nodes: result.graph.nodes.length, directedEdges: result.graph.edges.length,
        physicalTrails: result.geometry.length, starts: result.graph.starts.length },
      files, limitations: result.graph.info.limitations,
    };
    await writeFile(path.join(outputRoot, 'provenance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    db?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseRoot, regionId, outputRoot] = process.argv.slice(2);
  if (!releaseRoot || !regionId || !outputRoot) throw new Error('Usage: node tools/pilot/export.mjs RELEASE_ROOT REGION OUTPUT_ROOT');
  console.log(JSON.stringify(await exportPilot(releaseRoot, regionId, outputRoot), null, 2));
}
