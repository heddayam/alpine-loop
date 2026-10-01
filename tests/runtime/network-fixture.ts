import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { NetworkCell, NetworkGeometry, NetworkManifest, NetworkSection, NetworkStarts } from '../../src/data-format.js';
import type { Position, SearchQuery } from '../../src/model.js';

export const query: SearchQuery = {
  area: [-122.0006, 47.0499, -122.0004, 47.0501],
  distance: [600, 600], gain: [0, 100], repetition: 0, includeUnknown: true,
};

/** Two manually assigned cells, independent of production partition/load helpers. */
export async function createNetworkFixture(dense = false, startCount = 1, routeCount = 1, connectorSections: number[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-network-test-'));
  const west = '-1221_470', east = '-1220_470';
  const positions: Position[] = [[-122.0005, 47.05, 100], [-121.999, 47.0505, 120], [-121.999, 47.0495, 100]];
  if (!dense) for (let index = 1; index < routeCount; index++) {
    positions.push([-121.999, 47.0505 + index / 1_000_000, 120], [-121.999, 47.0495 - index / 1_000_000, 100]);
  }
  if (dense) for (let index = 3; index < 14; index++) positions.push([-122.0004 + (index - 3) / 10000, 47.05 + (index % 3 - 1) / 10000, 100]);
  const pairs: [number, number][] = dense
    ? positions.flatMap((_, from) => positions.flatMap((_, to): [number, number][] => from < to ? [[from, to]] : []))
    : Array.from({ length: routeCount }, (_, index): [number, number][] => [[0, index * 2 + 1], [index * 2 + 1, index * 2 + 2], [index * 2 + 2, 0]]).flat();
  const sections: NetworkSection[] = [];
  const drawings = new Map<string, NetworkGeometry>();
  for (const [id, [from, to]] of pairs.entries()) {
    const a = positions[from]!, b = positions[to]!;
    const radians = Math.PI / 180;
    const haversine = Math.sin((b[1] - a[1]) * radians / 2) ** 2
      + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
    if (12742017.6 * Math.asin(Math.sqrt(haversine)) > 200) throw new Error('Fixture edge violates the geographic lower bound');
    const bounds: NetworkSection['bounds'] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const facts = { trail: id, distance: 200, gain: 20, access: 'public' as const };
    sections.push({ id, bounds, name: 'Creek & Ridge', kind: connectorSections.includes(id) ? 'connector' : 'trail', edges: [
      [id * 2, { ...facts, from, to, reverse: false }],
      [id * 2 + 1, { ...facts, from: to, to: from, reverse: true }],
    ] });
    const owner = (bounds[0] + bounds[2]) / 2 < -122 ? west : east;
    const entries = drawings.get(owner) ?? [];
    entries.push([id, { id: `corridor-${id}`, name: 'Creek & Ridge', coordinates: [a, b] }]);
    drawings.set(owner, entries);
  }
  const manifest: NetworkManifest = {
    version: 2, cellDegrees: 0.1, distanceMetric: 'haversine-6371008.8',
    info: { id: 'fixture', name: 'Offline trails', bounds: [-122.01, 47.04, -121.99, 47.06],
      sourceDate: '2026-01-01', attribution: [], limitations: [], places: [], startCount },
    files: {},
  };
  async function file(name: string, value: unknown) {
    const json = Buffer.from(JSON.stringify(value));
    const compressed = gzipSync(json);
    await mkdir(join(directory, name.split('/')[0]!), { recursive: true });
    await writeFile(join(directory, name), compressed);
    manifest.files[name] = { bytes: compressed.length, jsonBytes: json.length,
      sha256: createHash('sha256').update(compressed).digest('hex') };
  }
  for (const cell of [west, east]) {
    // Crossing sections are whole in both cells, including their outside endpoints.
    const selected = sections.filter(section => cell === west ? section.bounds[0] < -122 : section.bounds[2] >= -122);
    const nodes = [...new Set(selected.flatMap(section => section.edges.flatMap(([, edge]) => [edge.from, edge.to])))].sort((a, b) => a - b);
    await file(`graph/${cell}.json.gz`, { nodes: nodes.map(id => [id, positions[id]!]), sections: selected } satisfies NetworkCell);
  }
  // Aliases at one entrance must not multiply the independently drawn circuits.
  const starts: NetworkStarts = Array.from({ length: startCount }, (_, index) => [index,
    { id: `start-${index}`, node: 0, name: 'Creek & Ridge <loop>', access: 'public' }, positions[0]!]);
  await file(`starts/${west}.json.gz`, starts);
  for (const [cell, geometry] of drawings) await file(`geometry/${cell}.json.gz`, geometry);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, geometryDirectory: join(directory, 'geometry'), missingTopology: join(directory, `graph/${east}.json.gz`) };
}
