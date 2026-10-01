import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { NetworkCell, NetworkGeometry, NetworkManifest, NetworkSection, NetworkStarts, StoredRoute } from './data-format.js';
import type { Bounds, HikeRoute, Position, RouteCandidate, SearchQuery, TrailEdge, TrailGraph } from './model.js';

const inside = ([x, y]: Position, [w, s, e, n]: Bounds) => x >= w && x <= e && y >= s && y <= n;
const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const contained = (a: Bounds, b: Bounds) => inside([a[0], a[1]], b) && inside([a[2], a[3]], b);
const owner = (b: Bounds) => `${Math.floor((b[0] + b[2]) * 5)}_${Math.floor((b[1] + b[3]) * 5)}`;

/** Every point on a closed route of length D is geographically at most D/2
 * from its start. This belongs to the measured data reader, not the abstract
 * weighted-graph engine. Full intersecting sections are retained, never cut. */
function envelope(points: Position[], maximumDistance: number): Bounds | null {
  if (!points.length) return null;
  const degrees = 180 / Math.PI;
  const angle = (maximumDistance / 2 + 1) / 6371008.8;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of points) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  south -= angle * degrees; north += angle * degrees;
  if (south <= -90 || north >= 90) return [-180, Math.max(-90, south), 180, Math.min(90, north)];
  const longitude = angle * degrees / Math.cos(Math.max(Math.abs(south), Math.abs(north)) / degrees);
  west -= longitude; east += longitude;
  // An enclosing rectangle crossing the dateline safely overfetches longitude.
  return west <= -180 || east >= 180 ? [-180, south, 180, north] : [west, south, east, north];
}

/** Opening the app reads only this small manifest. Search and drawings have
 * separate lifetimes; neither keeps the entire installed network in memory. */
export async function readDataset(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as NetworkManifest;
  if (manifest.version !== 2 || manifest.cellDegrees !== 0.1 || manifest.distanceMetric !== 'haversine-6371008.8'
    || !manifest.info?.id || !manifest.files || !Array.isArray(manifest.info.bounds)) throw new Error('Unsupported trail network');
  const files = Object.entries(manifest.files).map(([path, facts]) => {
    const match = /^(graph|starts|geometry)\/(-?\d+)_(-?\d+)\.json\.gz$/.exec(path);
    if (!match || !Number.isSafeInteger(facts.bytes) || facts.bytes <= 0 || !Number.isSafeInteger(facts.jsonBytes)
      || facts.jsonBytes <= 0 || !/^[a-f0-9]{64}$/.test(facts.sha256)) throw new Error('Invalid network file manifest');
    return { path, family: match[1]!, x: Number(match[2]), y: Number(match[3]) };
  });
  function selectedFiles(family: string, bounds: Bounds) {
    const [w, s, e, n] = bounds.map(value => Math.floor(value * 10));
    return files.filter(file => file.family === family && file.x >= w! && file.x <= e! && file.y >= s! && file.y <= n!);
  }
  async function load<T>(path: string): Promise<T> {
    const expected = manifest.files[path];
    if (!expected) throw new Error(`Network data is unavailable: ${path}`);
    const bytes = await readFile(join(directory, path));
    if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error(`Network file is incomplete or belongs to another snapshot: ${path}`);
    }
    const raw = gunzipSync(bytes, { maxOutputLength: expected.jsonBytes });
    if (raw.length !== expected.jsonBytes) throw new Error(`Incomplete network file: ${path}`);
    return JSON.parse(raw.toString()) as T;
  }
  async function select(query: SearchQuery) {
    const starts = new Map<number, NetworkStarts[number]>();
    const positions = new Map<number, Position>();
    function position(id: number, point: Position | undefined) {
      if (!point || point.length < 2 || point.some(value => !Number.isFinite(value))) throw new Error('Missing network junction');
      const previous = positions.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(point)) throw new Error('Conflicting network junction identity');
      positions.set(id, point);
    }
    for (const { path } of selectedFiles('starts', query.area)) {
      for (const record of await load<NetworkStarts>(path)) {
        const [index, start, point] = record;
        if (inside(point, query.area) && (query.includeUnknown || start.access === 'public')) {
          if (starts.has(index)) throw new Error('Duplicate network start');
          starts.set(index, record); position(start.node, point);
        }
      }
    }
    const bounds = envelope([...starts.values()].map(record => record[2]), query.distance[1]);
    const sections = new Map<number, NetworkSection>();
    const edges = new Map<number, TrailEdge>();
    if (bounds) for (const { path } of selectedFiles('graph', bounds)) {
      const tile = await load<NetworkCell>(path);
      const endpoints = new Map(tile.nodes);
      for (const section of tile.sections) {
        if (!overlaps(section.bounds, bounds)) continue;
        const previous = sections.get(section.id);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(section)) throw new Error('Conflicting physical trail identity');
          continue;
        }
        if (!['trail', 'connector'].includes(section.kind)) throw new Error('Missing trail classification');
        sections.set(section.id, section);
        for (const [id, edge] of section.edges) {
          if (edge.trail !== section.id || edges.has(id)) throw new Error('Conflicting trail direction identity');
          if (!query.includeUnknown && edge.access !== 'public') continue;
          position(edge.from, endpoints.get(edge.from)); position(edge.to, endpoints.get(edge.to));
          edges.set(id, edge);
        }
      }
    }
    const nodes = [...positions].sort((a, b) => a[0] - b[0]);
    const local = new Map(nodes.map(([id], index) => [id, index]));
    const graph: TrailGraph = {
      version: 1, info: manifest.info, nodes: nodes.map(([, point]) => point),
      edges: [...edges].sort((a, b) => a[0] - b[0]).map(([, edge]) => ({ ...edge, from: local.get(edge.from)!, to: local.get(edge.to)! })),
      starts: [...starts].sort((a, b) => a[0] - b[0]).map(([, [, start]]) => ({ ...start, node: local.get(start.node)! })),
    };
    const coverageNote = !contained(query.area, manifest.info.bounds)
      ? 'Part of the selected start area has no prepared data. Only available mapped starts can be searched.'
      : bounds && !contained(bounds, manifest.info.bounds)
        ? 'This hike length may reach beyond prepared trail data. Found routes are valid within the data, but missing alternatives cannot be ruled out.'
        : undefined;
    // Roads and sidewalks can connect a hike. Check this before diversity so
    // connector-only walks cannot suppress a later qualifying trail hike.
    function isHike(candidate: RouteCandidate): boolean {
      return candidate.edges.some(index => sections.get(graph.edges[index]!.trail)!.kind === 'trail');
    }
    function describe(candidate: RouteCandidate): StoredRoute {
      const start = graph.starts[candidate.start];
      if (!start) throw new Error('Route has an unknown start');
      const steps = candidate.edges.map(index => {
        const edge = graph.edges[index];
        const section = edge && sections.get(edge.trail);
        if (!edge || !section) throw new Error('Route has an unknown trail');
        return { edge, section };
      });
      let first = 0, last = steps.length - 1;
      while (first < last && steps[first]!.section.id === steps[last]!.section.id) { first++; last--; }
      const names = new Map<string, number>();
      for (const [index, { edge, section }] of steps.entries()) {
        if (section.name) names.set(section.name, (names.get(section.name) ?? 0) + (index >= first && index <= last ? edge.distance : 0));
      }
      const { id, distance, gain, repetition, kind, uncertain } = candidate;
      return {
        summary: { id, distance, gain, repetition, kind, uncertain, startId: start.id, startName: start.name,
          startPosition: graph.nodes[start.node]!, trailNames: [...names].sort((a, b) => b[1] - a[1]).map(([name]) => name) },
        sections: steps.map(({ edge, section }) => ({ cell: owner(section.bounds), id: section.id, reverse: edge.reverse })),
      };
    }
    return { graph, coverageNote, isHike, describe };
  }
  async function route(stored: StoredRoute): Promise<HikeRoute> {
    const shapes = new Map<number, NetworkGeometry[number][1]>();
    for (const cell of new Set(stored.sections.map(section => section.cell))) {
      const needed = new Set(stored.sections.filter(section => section.cell === cell).map(section => section.id));
      for (const [id, shape] of await load<NetworkGeometry>(`geometry/${cell}.json.gz`)) if (needed.has(id)) shapes.set(id, shape);
    }
    const coordinates: Position[] = [];
    for (const section of stored.sections) {
      const shape = shapes.get(section.id);
      if (!shape?.coordinates.length) throw new Error('Route drawing is missing');
      const points = section.reverse ? shape.coordinates.toReversed() : shape.coordinates;
      const previous = coordinates.at(-1);
      if (previous && (previous[0] !== points[0]![0] || previous[1] !== points[0]![1])) throw new Error('Route drawing has a broken connection');
      for (let index = previous ? 1 : 0; index < points.length; index++) coordinates.push(points[index]!);
    }
    return { ...stored.summary, geometry: coordinates };
  }
  return { info: manifest.info, select, route };
}

export function gpx(route: HikeRoute): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
  const points = route.geometry.map(([lon, lat, elevation]) =>
    `    <trkpt lat="${lat}" lon="${lon}">${elevation === undefined ? '' : `<ele>${elevation}</ele>`}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Alpine Loop" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${escape(route.startName)}</name><trkseg>\n${points}\n  </trkseg></trk>\n</gpx>\n`;
}
