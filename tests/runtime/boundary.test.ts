import { describe, expect, it } from 'vitest';
import { boundaryError, boundarySections, restrictDriveArea, pointInArea, pointInBoundary, MAX_BOUNDARY_VERTICES } from '../../src/boundary.js';
import { parseQuery } from '../../src/jobs.js';
import type { SearchBoundary } from '../../src/model.js';

describe('drawn starting-point boundaries', () => {
  const concave: SearchBoundary = [[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]];
  it('includes edges and vertices but excludes the concave cutout, in either drawing direction', () => {
    expect(boundaryError(concave)).toBeNull();
    for (const ring of [concave, [...concave].reverse()]) {
      for (const point of [[0, 0], [0, 2], [3, 3], [2, 1]] as SearchBoundary)
        expect(pointInBoundary(point, ring)).toBe(true);
      for (const point of [[2, 3], [-1, 1], [5, 2]] as SearchBoundary)
        expect(pointInBoundary(point, ring)).toBe(false);
    }
  });

  it('rejects malformed, degenerate, overlapping and self-crossing areas before persisting a job', () => {
    const base = { sections: [], distance: [1, 1000], gain: [0, 1000], stem: 0, includeUnknown: true };
    for (const boundary of [null, [], [[0, 0], [1, 0]], [[0, 0], [1, 1], [2, 2]],
      [[0, 0], [2, 2], [0, 2], [2, 0]], [[0, 0], [2, 0], [1, 0], [1, 1]],
      [[0, 0], [1, 0], [0, 0], [0, 1]], [[0, 0], [NaN, 0], [0, 1]],
      [[0, 0], [181, 0], [0, 1]], [[0, 0, 4], [1, 0], [0, 1]],
      Array.from({ length: MAX_BOUNDARY_VERTICES + 1 }, (_, i) => [Math.cos(i), Math.sin(i)]),
    ]) expect(() => parseQuery({ ...base, boundary })).toThrow();
    const parsed = parseQuery({ ...base, boundary: concave });
    expect(parsed.boundary).toEqual(concave);
    expect(parsed.boundary![0]).not.toBe(concave[0]);
  });

  it('selects actual overlapping prepared polygons, excluding their holes and bounding-box gaps', () => {
    const section = { id: 'with-hole', bounds: [0, 0, 4, 4] as [number, number, number, number],
      boundary: { type: 'MultiPolygon' as const, coordinates: [[
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
      ]] } };
    expect(boundarySections([[1.5, 1.5], [2.5, 1.5], [2, 2.5]], [section])).toEqual([]);
    expect(boundarySections([[0.5, 0.5], [2, 0.5], [2, 2]], [section])).toEqual([section]);
    const disconnected = { ...section, boundary: { type: 'MultiPolygon' as const, coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[3, 3], [4, 3], [4, 4], [3, 4], [3, 3]]],
    ] } };
    expect(boundarySections([[1.5, 1.5], [2.5, 1.5], [2, 2.5]], [disconnected])).toEqual([]);
  });

  it('clips driving scope to the search area, preserving reachable islands, holes and drawn limits', () => {
    const rectangle = (west: number, south: number, east: number, north: number) =>
      [[west, south], [east, south], [east, north], [west, north], [west, south]];
    const scope = { type: 'MultiPolygon' as const, coordinates: [[rectangle(0, 0, 10, 10)]] };
    const reachable = { type: 'MultiPolygon' as const, coordinates: [
      [rectangle(1, 1, 6, 6), rectangle(2, 2, 3, 3).reverse()], [rectangle(7, 7, 9, 9)],
    ] };
    const drawn: SearchBoundary = [[0, 0], [8, 0], [8, 8], [0, 8]];
    const clipped = restrictDriveArea(reachable, [{ boundary: scope }], drawn);
    expect(pointInArea([0.5, 0.5], clipped)).toBe(false);
    expect(pointInArea([2.5, 2.5], clipped)).toBe(false); // Unreachable hole stays excluded.
    expect(pointInArea([4, 4], clipped)).toBe(true);
    expect(pointInArea([7.5, 7.5], clipped)).toBe(true); // Reachable island survives.
    expect(pointInArea([8.5, 8.5], clipped)).toBe(false); // Driving area outside the drawing is excluded.
    expect(restrictDriveArea(scope, [{ boundary: scope }])).toEqual(scope);
    expect(restrictDriveArea({ type: 'MultiPolygon', coordinates: [] }, [{ boundary: scope }]).coordinates).toEqual([]);
    expect(restrictDriveArea(reachable, []).coordinates).toEqual([]);
  });
});
