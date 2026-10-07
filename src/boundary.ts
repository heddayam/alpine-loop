import { intersection, type Geom } from 'polyclip-ts';
import type { Boundary } from './data-format.js';
import type { Bounds, Position, SearchBoundary } from './model.js';

export const MAX_BOUNDARY_VERTICES = 128;
const cross = (a: Position, b: Position, c: Position) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (point: Position, a: Position, b: Position) =>
  Math.abs(cross(a, b, point)) <= 1e-12 &&
  point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) &&
  point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1]);
const intersects = (a: Position, b: Position, c: Position, d: Position) =>
  onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d) ||
  cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;

/** Shared by drawing and request validation; reject crossings instead of repairing the user's area. */
export function boundaryError(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_BOUNDARY_VERTICES)
    return `Draw a boundary with 3–${MAX_BOUNDARY_VERTICES} points.`;
  if (value.some(point => !Array.isArray(point) || point.length !== 2 ||
    point.some(number => typeof number !== 'number' || !Number.isFinite(number)) ||
    point[0] < -180 || point[0] > 180 || point[1] < -85 || point[1] > 85))
    return 'Draw a boundary within the map.';
  const vertices = value as SearchBoundary;
  if (new Set(vertices.map(point => `${point[0]},${point[1]}`)).size !== vertices.length)
    return 'Boundary points must be distinct.';
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!;
    const previous = vertices[(i + vertices.length - 1) % vertices.length]!;
    if (onSegment(previous, a, b) || onSegment(b, previous, a))
      return 'Boundary edges must not overlap.';
    for (let j = i + 2; j < vertices.length; j++) {
      if (i === 0 && j === vertices.length - 1) continue;
      if (intersects(a, b, vertices[j]!, vertices[(j + 1) % vertices.length]!))
        return 'Boundary edges must not cross. Undo a point and try again.';
    }
  }
  const origin = vertices[0]!;
  const area = vertices.reduce((sum, a, i) => sum + cross(origin, a, vertices[(i + 1) % vertices.length]!), 0);
  return Math.abs(area) <= 1e-12 ? 'Draw a boundary with a nonzero area.' : null;
}

export function pointInBoundary(point: Position, vertices: SearchBoundary): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[j]!, b = vertices[i]!;
    if (onSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export const boundaryBounds = (vertices: SearchBoundary): Bounds => [
  Math.min(...vertices.map(point => point[0])), Math.min(...vertices.map(point => point[1])),
  Math.max(...vertices.map(point => point[0])), Math.max(...vertices.map(point => point[1])),
];
export const boundaryGeometry = (vertices: SearchBoundary) => ({
  type: 'Polygon' as const, coordinates: [[...vertices, vertices[0]!]],
});

/** Include every prepared section that overlaps the polygon, respecting holes and disconnected footprints. */
export function boundarySections<T extends { bounds: Bounds; boundary: Boundary }>(vertices: SearchBoundary, sections: T[]): T[] {
  const bounds = boundaryBounds(vertices);
  return sections.filter(section => section.bounds[0] <= bounds[2] && section.bounds[2] >= bounds[0] &&
    section.bounds[1] <= bounds[3] && section.bounds[3] >= bounds[1] &&
    intersection(boundaryGeometry(vertices).coordinates as Geom, section.boundary.coordinates as Geom).length > 0);
}
