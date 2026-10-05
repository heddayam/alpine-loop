import type { SectionGeometry, SectionGraph, SectionStarts, StoredRoute } from './data-format.js';
import type { HikeRoute, JobInputs, Position, RouteCandidate, SearchQuery } from './model.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openSections } from './sections.js';

/** Catalog/starts stay small. Each worker loads one independently bounded graph at a time. */
export async function readDataset(directory: string) {
  const sections = await openSections(directory);
  const { catalog } = sections;
  const byId = new Map(catalog.sections.map(section => [section.id, section]));
  const selected = (query: SearchQuery) => query.sections.map(id => {
    const section = byId.get(id);
    if (!section) throw Object.assign(new Error('A selected search region is unavailable in this catalog.'), { statusCode: 400 });
    return section;
  });
  async function coverage(query: SearchQuery) {
    const required = selected(query), missing: string[] = [];
    let bytes = 0;
    for (const section of required) if (!await sections.installed(section).catch(() => false)) {
      missing.push(section.id); bytes += Object.values(section.files).reduce((sum, file) => sum + file.bytes, 0);
    }
    return { sections: required.map(section => section.id), missing, bytes };
  }
  async function starts(query: SearchQuery) {
    const result = [];
    for (const section of selected(query)) {
      const records = await sections.read<SectionStarts>(section, 'starts');
      const eligible = records.filter(([start]) => query.includeUnknown || start.access === 'public').map(([start]) => start);
      result.push({ section, eligible });
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
        summary: { id, distance, gain, roadDistance, repetition, kind, uncertain, startId: start.id, startName: start.name, startKind: start.kind,
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
  async function verifyInputs(inputs: JobInputs): Promise<void> {
    const file = join(directory, 'catalog.json');
    if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('Prepared catalog changed during this job.');
    const current = JSON.parse(await readFile(file, 'utf8')) as typeof catalog;
    if (current.info?.id !== inputs.version) throw new Error('Prepared data changed during this job. Submit a new job.');
    for (const pinned of inputs.sections) {
      const entry = current.sections?.find(section => section.id === pinned.id);
      const facts = entry && { id: entry.id, name: entry.name, bounds: entry.bounds, boundary: entry.boundary, files: entry.files };
      if (!isDeepStrictEqual(facts, pinned)) throw new Error(`Prepared region changed during this job: ${pinned.name}`);
      if (!await sections.installed(pinned.id)) throw new Error(`Prepared region was removed during this job: ${pinned.name}`);
    }
  }
  return { info: catalog.info, catalog, selectedSections: selected, coverage, starts, select, route, verifyInputs,
    readGeometry: (id: string) => sections.read<SectionGeometry>(id, 'geometry'),
    view: sections.view, downloads: sections.downloads };
}

export function gpx(route: HikeRoute): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
  const points = route.geometry.map(([lon, lat, elevation]) =>
    `    <trkpt lat="${lat}" lon="${lon}">${elevation === undefined ? '' : `<ele>${elevation}</ele>`}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Alpine Loop" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${escape(route.startName)}</name><trkseg>\n${points}\n  </trkseg></trk>\n</gpx>\n`;
}
