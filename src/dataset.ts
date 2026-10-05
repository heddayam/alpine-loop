import type { Boundary, PreparedSection, SectionGeometry, SectionGraph, SectionStarts, StoredRoute } from './data-format.js';
import type { Bounds, HikeRoute, Position, RouteCandidate, SearchQuery } from './model.js';
import { openSections } from './sections.js';

const inside = ([x, y]: readonly (number | undefined)[], [w, s, e, n]: Bounds) => x! >= w && x! <= e && y! >= s && y! <= n;
const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function onSegment(p: number[], a: number[], b: number[]) {
  return Math.abs((p[0]! - a[0]!) * (b[1]! - a[1]!) - (p[1]! - a[1]!) * (b[0]! - a[0]!)) < 1e-12
    && p[0]! >= Math.min(a[0]!, b[0]!) && p[0]! <= Math.max(a[0]!, b[0]!)
    && p[1]! >= Math.min(a[1]!, b[1]!) && p[1]! <= Math.max(a[1]!, b[1]!);
}
function inRing(p: number[], ring: number[][]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    if (onSegment(p, a, b)) return true;
    if ((a[1]! > p[1]!) !== (b[1]! > p[1]!) && p[0]! < (b[0]! - a[0]!) * (p[1]! - a[1]!) / (b[1]! - a[1]!) + a[0]!) result = !result;
  }
  return result;
}
function contains(p: number[], boundary: Boundary) {
  return boundary.coordinates.some(rings => inRing(p, rings[0]!) && !rings.slice(1).some(ring => inRing(p, ring)));
}
/** Exact rectangle/footprint overlap, including sparse crossings and polygon holes. */
export function intersects(area: Bounds, section: Pick<PreparedSection, 'bounds' | 'boundary'>): boolean {
  if (!overlaps(area, section.bounds)) return false;
  const corners = [[area[0], area[1]], [area[2], area[1]], [area[2], area[3]], [area[0], area[3]]];
  if (corners.some(p => contains(p, section.boundary))) return true;
  for (const rings of section.boundary.coordinates) for (const ring of rings) {
    if (ring.some(p => inside(p, area))) return true;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1]!, b = ring[i]!;
      let low = 0, high = 1;
      for (const [start, delta, min, max] of [[a[0]!, b[0]! - a[0]!, area[0], area[2]], [a[1]!, b[1]! - a[1]!, area[1], area[3]]]) {
        if (delta === 0) { if (start! < min! || start! > max!) { low = 1; high = 0; } }
        else { const x = (min! - start!) / delta!, y = (max! - start!) / delta!; low = Math.max(low, Math.min(x, y)); high = Math.min(high, Math.max(x, y)); }
      }
      if (low <= high) return true;
    }
  }
  return false;
}

/** Catalog/starts stay small. Each worker loads one independently bounded graph at a time. */
export async function readDataset(directory: string) {
  const sections = await openSections(directory);
  const { catalog } = sections;
  const selected = (query: SearchQuery) => catalog.sections.filter(section => intersects(query.area, section));
  async function coverage(query: SearchQuery) {
    const required = selected(query), missing: string[] = [];
    let bytes = 0;
    for (const section of required) if (!await sections.installed(section).catch(() => false)) {
      missing.push(section.id); bytes += Object.values(section.files).reduce((sum, file) => sum + file.bytes, 0);
    }
    const bounds = catalog.info.bounds;
    const unavailable = catalog.unavailable?.filter(section => intersects(query.area, section));
    const coverageNote = unavailable?.length ? `Some selected mountain coverage is unavailable: ${unavailable.map(section => `${section.name} (${section.reason})`).join('; ')}. Only prepared sections can be explored.`
      : query.area[0] < bounds[0] || query.area[1] < bounds[1] || query.area[2] > bounds[2] || query.area[3] > bounds[3]
      ? 'Part of the selected start area lies beyond this catalog’s mountain coverage. Exploration there is unavailable.'
      : required.length === 0 ? 'No prepared mountain section overlaps the selected start area.' : undefined;
    return { sections: required.map(section => section.id), missing, bytes, coverageNote };
  }
  async function starts(query: SearchQuery) {
    const result = [];
    for (const section of selected(query)) {
      const records = await sections.read<SectionStarts>(section, 'starts');
      const eligible = records.filter(([start, point]) => inside(point, query.area) && (query.includeUnknown || start.access === 'public')).map(([start]) => start);
      if (eligible.length) result.push({ section, eligible });
    }
    return result;
  }
  async function select(query: SearchQuery, chosen: Awaited<ReturnType<typeof starts>>[number]) {
    const { graph, trails } = await sections.read<SectionGraph>(chosen.section, 'graph');
    graph.starts = chosen.eligible.map(start => ({ ...start, id: `${chosen.section.id}/${start.id}` }));
    if (!query.includeUnknown) graph.edges = graph.edges.filter(edge => edge.access === 'public');
    function isHike(candidate: RouteCandidate) { return candidate.edges.some(index => !graph.edges[index]!.connector); }
    function describe(candidate: RouteCandidate): StoredRoute {
      const start = graph.starts[candidate.start]!;
      const steps = candidate.edges.map(index => graph.edges[index]!);
      let first = 0, last = steps.length - 1;
      while (first < last && steps[first]!.trail === steps[last]!.trail) { first++; last--; }
      const names = new Map<string, number>();
      for (const [index, edge] of steps.entries()) {
        const trail = trails[edge.trail]!;
        if (!edge.connector && trail.name) names.set(trail.name, (names.get(trail.name) ?? 0) + (index >= first && index <= last ? edge.distance : 0));
      }
      const { id, distance, gain, roadDistance, repetition, kind, uncertain } = candidate;
      return {
        summary: { id, distance, gain, roadDistance, repetition, kind, uncertain, startId: start.id, startName: start.name,
          startPosition: graph.nodes[start.node]!, trailNames: [...names].sort((a, b) => b[1] - a[1]).map(([name]) => name) },
        sections: steps.map(edge => ({ section: chosen.section.id, id: edge.trail, reverse: edge.reverse })),
      };
    }
    return { graph, isHike, describe };
  }
  async function route(stored: StoredRoute): Promise<HikeRoute> {
    const shapes = new Map<string, SectionGeometry>();
    for (const id of new Set(stored.sections.map(step => step.section))) {
      const section = catalog.sections.find(section => section.id === id);
      if (!section) throw new Error('Route belongs to unavailable trail data');
      shapes.set(id, await sections.read<SectionGeometry>(section, 'geometry'));
    }
    const coordinates: Position[] = [];
    for (const step of stored.sections) {
      const shape = shapes.get(step.section)?.[step.id];
      if (!shape?.coordinates.length) throw new Error('Route drawing is missing');
      const points = step.reverse ? shape.coordinates.toReversed() : shape.coordinates;
      const previous = coordinates.at(-1);
      if (previous && (previous[0] !== points[0]![0] || previous[1] !== points[0]![1])) throw new Error('Route drawing has a broken connection');
      for (let index = previous ? 1 : 0; index < points.length; index++) coordinates.push(points[index]!);
    }
    return { ...stored.summary, geometry: coordinates };
  }
  return { info: catalog.info, coverage, starts, select, route, view: sections.view, downloads: sections.downloads };
}

export function gpx(route: HikeRoute): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
  const points = route.geometry.map(([lon, lat, elevation]) =>
    `    <trkpt lat="${lat}" lon="${lon}">${elevation === undefined ? '' : `<ele>${elevation}</ele>`}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Alpine Loop" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${escape(route.startName)}</name><trkseg>\n${points}\n  </trkseg></trk>\n</gpx>\n`;
}
