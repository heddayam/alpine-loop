import type { Feature, FeatureCollection, MultiLineString } from "geojson";
import type { HikeRoute, RouteSegment } from "../model.js";

type Drawing = Feature<MultiLineString, { id: string; name?: string }>;

/** Group named continuations in walk order, drawing each physical trail once. */
export function routeDrawing(route: Pick<HikeRoute, "id" | "geometry" | "segments">): FeatureCollection<MultiLineString> {
  const steps = route.segments ?? [];
  const unique = new Map<string, RouteSegment>();
  for (const step of steps) if (!unique.has(step.id)) unique.set(step.id, step);
  const segments = [...unique.values()];
  const indices = new Map(segments.map((segment, index) => [segment.id, index]));
  const parents = segments.map((_, index) => index), sizes = segments.map(() => 1);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const join = (a: RouteSegment, b: RouteSegment) => {
    if (!a.name || a.name !== b.name) return;
    let left = root(indices.get(a.id)!), right = root(indices.get(b.id)!);
    if (left === right) return;
    if (sizes[left]! < sizes[right]!) [left, right] = [right, left];
    parents[right] = left;
    sizes[left]! += sizes[right]!;
  };
  // Examine transitions before deduplicating: return walks can extend a group.
  for (let index = 1; index < steps.length; index++) {
    const previous = steps[index - 1]!, current = steps[index]!;
    if (previous.end === current.start) join(previous, current);
  }
  const first = steps[0], last = steps.at(-1);
  const start = route.geometry[0], end = route.geometry.at(-1);
  if (first?.start === 0 && last?.end === route.geometry.length - 1
    && start && end && start[0] === end[0] && start[1] === end[1]) join(last, first);

  const groups = new Map<number, Drawing>();
  for (const [index, segment] of segments.entries()) {
    const id = root(index);
    let feature = groups.get(id);
    if (!feature) {
      feature = {
        type: "Feature",
        // Numeric IDs survive MapLibre's vector tile encoding and feature state.
        id,
        properties: { id: route.id, name: segment.name === undefined ? "Trail name unavailable" : segment.name || "Unnamed trail" },
        geometry: { type: "MultiLineString", coordinates: [] },
      };
      groups.set(id, feature);
    }
    feature.geometry.coordinates.push(route.geometry.slice(segment.start, segment.end + 1).map(point => [point[0], point[1]]));
  }
  return { type: "FeatureCollection", features: segments.length ? [...groups.values()] : [{
    type: "Feature", properties: { id: route.id },
    geometry: { type: "MultiLineString", coordinates: [route.geometry.map(point => [point[0], point[1]])] },
  }] };
}
