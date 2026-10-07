import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { SectionCatalog, SectionGeometry, SectionGraph } from '../../src/data-format.js';
import type { Position, SearchQuery } from '../../src/model.js';

export const query: SearchQuery = {
  sections: ['fixture-0'],
  distance: [600, 600], gain: [0, 100], repetition: 0, includeUnknown: true,
};

/** Manually specified independent graphs; no production preparation helpers. */
export async function createNetworkFixture({ dense = false, startCount = 1, routeCount = 1, connectorSections = [], directional = false, sectionCount = 1 }: {
  dense?: boolean; startCount?: number; routeCount?: number; connectorSections?: number[]; directional?: boolean; sectionCount?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-sections-test-'));
  const catalog: SectionCatalog = { version: 2, info: { id: 'fixture', name: 'Offline trails', bounds: [-122.01, 47.04, -121.98, 47.06],
    sourceDate: '2026-01-01', attribution: [], limitations: [], startCount: startCount * sectionCount }, sections: [] };
  let firstLoop: Position[] = [];
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
    const id = `fixture-${sectionIndex}`;
    const positions: Position[] = [[-122.0005, 47.05, 100], [-121.999, 47.0505, 120], [-121.999, 47.0495, 100]];
    if (!dense) for (let index = 1; index < routeCount; index++) {
      positions.push([-121.999, 47.0505 + index / 1_000_000, 120], [-121.999, 47.0495 - index / 1_000_000, 100]);
    }
    if (dense) for (let index = 3; index < 14; index++) positions.push([-122.0004 + (index - 3) / 10000, 47.05 + (index % 3 - 1) / 10000, 100]);
    positions.forEach(p => { p[0] += sectionIndex * .01; });
    if (!sectionIndex) firstLoop = [positions[0]!, positions[1]!, positions[2]!, positions[0]!];
    const pairs: [number, number][] = dense
      ? positions.flatMap((_, from) => positions.flatMap((_, to): [number, number][] => from < to ? [[from, to]] : []))
      : Array.from({ length: routeCount }, (_, index): [number, number][] => [[0, index * 2 + 1], [index * 2 + 1, index * 2 + 2], [index * 2 + 2, 0]]).flat();
    const starts = Array.from({ length: startCount }, (_, index) => ({ id: `start-${index}`, node: 0, name: `Creek & Ridge <loop> ${index}`, access: 'public' as const, kind: 'trailhead' as const }));
    const data: SectionGraph = { graph: { version: 1, info: catalog.info, nodes: positions, edges: [], starts }, trails: [] };
    const geometry: SectionGeometry = [];
    for (const [trail, [from, to]] of pairs.entries()) {
      const connector = connectorSections.includes(trail);
      const facts = { trail, connector, distance: 200, gain: 20, access: 'public' as const };
      data.graph.edges.push({ ...facts, from, to, reverse: false }, { ...facts, from: to, to: from, reverse: true,
        ...(directional && trail === 0 ? { gain: 40, access: 'unknown' as const } : {}) });
      data.trails.push({ name: 'Creek & Ridge', kind: connector ? 'connector' : 'trail' });
      geometry.push({ id: `corridor-${trail}`, name: 'Creek & Ridge', coordinates: [positions[from]!, positions[to]!] });
    }
    const west = -122.01 + sectionIndex * .01, east = -122 + (sectionIndex + 1) * .01;
    const section: SectionCatalog['sections'][number] = { id, regionId: 'offline', name: `Test section ${sectionIndex}`, sourceSegments: pairs.length,
      startCount, bounds: [west, 47.04, east, 47.06], boundary: { type: 'MultiPolygon', coordinates: [[[[west,47.04],[east,47.04],[east,47.06],[west,47.06],[west,47.04]]]] }, files: {} as never };
    await mkdir(join(directory, 'sections', id), { recursive: true });
    for (const [family, value] of Object.entries({ graph: data, starts: starts.map(start => [start, positions[start.node]]), geometry })) {
      const raw = Buffer.from(family === 'geometry' ? geometry.map(shape => JSON.stringify(shape.coordinates) + '\n').join('') : JSON.stringify(value)), compressed = gzipSync(raw), path = `sections/${id}/${family}.${family === 'geometry' ? 'jsonl' : 'json'}.gz`;
      await writeFile(join(directory, path), compressed);
      section.files[family as keyof typeof section.files] = { path, bytes: compressed.length, jsonBytes: raw.length, sha256: createHash('sha256').update(compressed).digest('hex') };
    }
    catalog.sections.push(section);
  }
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog));
  return { directory, missingTopology: join(directory, catalog.sections[0]!.files.graph.path), firstLoop, catalog };
}
