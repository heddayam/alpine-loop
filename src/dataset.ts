import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { HikeRoute, Position, RouteCandidate, TrailGeometry, TrailGraph } from './model.js';

export async function readGraph(directory: string): Promise<TrailGraph> {
  const graph = JSON.parse(gunzipSync(await readFile(join(directory, 'graph.json.gz'))).toString()) as TrailGraph;
  if (graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.starts)) {
    throw new Error('Unsupported trail dataset');
  }
  return graph;
}

export async function readDataset(directory: string) {
  const graph = await readGraph(directory);
  const geometry = JSON.parse(gunzipSync(await readFile(join(directory, 'geometry.json.gz'))).toString()) as TrailGeometry[];
  function route(candidate: RouteCandidate): HikeRoute {
    const start = graph.starts[candidate.start];
    if (!start) throw new Error('Route has an unknown start');
    const coordinates: Position[] = [];
    const names = new Set<string>();
    for (const index of candidate.edges) {
      const edge = graph.edges[index];
      const trail = edge && geometry[edge.trail];
      if (!edge || !trail?.coordinates.length) throw new Error('Route drawing is missing');
      if (trail.name) names.add(trail.name);
      const points = edge.reverse ? trail.coordinates.toReversed() : trail.coordinates;
      for (const point of points) {
        const previous = coordinates.at(-1);
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) coordinates.push(point);
      }
    }
    const id = createHash('sha256').update(candidate.id).digest('hex').slice(0, 32);
    return { ...candidate, id, startId: start.id, startName: start.name, geometry: coordinates, trailNames: [...names] };
  }
  return { graph, route };
}

export function gpx(route: HikeRoute): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
  const points = route.geometry.map(([lon, lat, elevation]) =>
    `    <trkpt lat="${lat}" lon="${lon}">${elevation === undefined ? '' : `<ele>${elevation}</ele>`}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Alpine Loop" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${escape(route.startName)}</name><trkseg>\n${points}\n  </trkseg></trk>\n</gpx>\n`;
}
