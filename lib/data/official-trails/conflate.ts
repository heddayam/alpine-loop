import { createHash } from "node:crypto";
import type { Coordinate, EdgeClass, NormalizedNode, NormalizedTopology, NormalizedWay } from "../types";
import type {
  OfficialTrailConflationAudit,
  OfficialTrailConflationPolicy,
  OfficialTrailConflationResult,
  OfficialTrailFeature,
} from "./types";

export const OFFICIAL_TRAIL_CONFLATION_VERSION = "official-trail-conflation-v3";

type Point = { x: number; y: number };
type IndexedSegment = {
  wayIndex: number;
  segmentIndex: number;
  edgeClass: EdgeClass;
  a: Coordinate;
  b: Coordinate;
  pa: Point;
  pb: Point;
};
type NearestSegment = IndexedSegment & { distanceM: number; t: number; coordinate: Coordinate };
type EndpointName = "start" | "end";
type Candidate = {
  id: string;
  feature: OfficialTrailFeature;
  coordinates: Coordinate[];
  lengthM: number;
  naturalStart: boolean;
  naturalEnd: boolean;
  truncatedStart: boolean;
  truncatedEnd: boolean;
  startBase: NearestSegment | null;
  endBase: NearestSegment | null;
};

const DEFAULT_POLICY: OfficialTrailConflationPolicy = {
  sampleStepM: 20,
  representedDistanceM: 100,
  internalConnectionDistanceM: 30,
  maximumConnectionAngleDegrees: 45,
  endpointConnectionDistanceM: 30,
  candidateConnectionDistanceM: 20,
  maximumTransitionLengthM: 250,
  duplicateDistanceM: 25,
  duplicateCoverageRatio: 0.8,
  minimumGapLengthM: 500,
};

class Projector {
  private readonly xScale: number;
  private readonly yScale = 110_540;

  constructor(latitude: number) {
    this.xScale = 111_320 * Math.cos(latitude * Math.PI / 180);
  }

  project([lon, lat]: Coordinate): Point { return { x: lon * this.xScale, y: lat * this.yScale }; }
  unproject({ x, y }: Point): Coordinate { return [x / this.xScale, y / this.yScale]; }
  distance(first: Coordinate, second: Coordinate): number {
    const a = this.project(first); const b = this.project(second);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  direction(first: Coordinate, second: Coordinate): Point {
    const a = this.project(first); const b = this.project(second);
    return { x: b.x - a.x, y: b.y - a.y };
  }
}

function projection(point: Point, a: Point, b: Point): { distanceM: number; t: number; point: Point } {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator));
  const projected = { x: a.x + dx * t, y: a.y + dy * t };
  return { distanceM: Math.hypot(point.x - projected.x, point.y - projected.y), t, point: projected };
}

class SegmentIndex {
  private readonly cells = new Map<string, IndexedSegment[]>();

  constructor(private readonly projector: Projector, private readonly cellSizeM: number) {}

  private cell(value: number): number { return Math.floor(value / this.cellSizeM); }
  private key(x: number, y: number): string { return `${x},${y}`; }

  add(segment: IndexedSegment): void {
    const minX = this.cell(Math.min(segment.pa.x, segment.pb.x));
    const maxX = this.cell(Math.max(segment.pa.x, segment.pb.x));
    const minY = this.cell(Math.min(segment.pa.y, segment.pb.y));
    const maxY = this.cell(Math.max(segment.pa.y, segment.pb.y));
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      const key = this.key(x, y);
      const values = this.cells.get(key);
      if (values) values.push(segment); else this.cells.set(key, [segment]);
    }
  }

  addLine(coordinates: readonly Coordinate[], wayIndex = -1, edgeClass: EdgeClass = "trail"): void {
    for (let segmentIndex = 0; segmentIndex < coordinates.length - 1; segmentIndex += 1) {
      const a = coordinates[segmentIndex]!; const b = coordinates[segmentIndex + 1]!;
      this.add({ wayIndex, segmentIndex, edgeClass, a, b, pa: this.projector.project(a), pb: this.projector.project(b) });
    }
  }

  nearest(coordinate: Coordinate, maximumDistanceM: number, direction?: Point, maximumAngleDegrees?: number): NearestSegment | null {
    const point = this.projector.project(coordinate);
    const radius = Math.ceil(maximumDistanceM / this.cellSizeM);
    const centerX = this.cell(point.x); const centerY = this.cell(point.y);
    const candidates = new Set<IndexedSegment>();
    for (let dx = -radius; dx <= radius; dx += 1) for (let dy = -radius; dy <= radius; dy += 1) {
      for (const segment of this.cells.get(this.key(centerX + dx, centerY + dy)) ?? []) candidates.add(segment);
    }
    let nearest: NearestSegment | null = null;
    for (const segment of candidates) {
      if (direction && maximumAngleDegrees !== undefined) {
        const segmentDirection = { x: segment.pb.x - segment.pa.x, y: segment.pb.y - segment.pa.y };
        const denominator = Math.hypot(direction.x, direction.y) * Math.hypot(segmentDirection.x, segmentDirection.y);
        if (denominator === 0) continue;
        const cosine = Math.min(1, Math.abs((direction.x * segmentDirection.x + direction.y * segmentDirection.y) / denominator));
        const angle = Math.acos(cosine) * 180 / Math.PI;
        if (angle > maximumAngleDegrees) continue;
      }
      const result = projection(point, segment.pa, segment.pb);
      if (result.distanceM > maximumDistanceM || nearest && result.distanceM >= nearest.distanceM) continue;
      nearest = { ...segment, distanceM: result.distanceM, t: result.t, coordinate: this.projector.unproject(result.point) };
    }
    return nearest;
  }
}

function topologyLatitude(topology: NormalizedTopology, features: readonly OfficialTrailFeature[]): number {
  const nodeLatitudes = topology.nodes.slice(0, 10_000).map(({ lat }) => lat);
  const featureLatitudes = features.slice(0, 1_000).flatMap(({ coordinates }) => coordinates.slice(0, 10).map(([, lat]) => lat));
  const values = [...nodeLatitudes, ...featureLatitudes];
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function topologyIndexes(topology: NormalizedTopology, projector: Projector, cellSizeM: number): {
  trails: SegmentIndex;
  all: SegmentIndex;
} {
  const trails = new SegmentIndex(projector, cellSizeM);
  const all = new SegmentIndex(projector, cellSizeM);
  topology.ways.forEach((way, wayIndex) => {
    const edgeClass = way.edgeClass ?? "trail";
    all.addLine(way.coordinates, wayIndex, edgeClass);
    if (edgeClass === "trail") trails.addLine(way.coordinates, wayIndex, edgeClass);
  });
  return { trails, all };
}

function lineLength(coordinates: readonly Coordinate[], projector: Projector): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) length += projector.distance(coordinates[index - 1]!, coordinates[index]!);
  return length;
}

function resample(coordinates: readonly Coordinate[], stepM: number, projector: Projector): Coordinate[] {
  const result: Coordinate[] = [coordinates[0]!];
  for (let index = 1; index < coordinates.length; index += 1) {
    const a = coordinates[index - 1]!; const b = coordinates[index]!;
    const length = projector.distance(a, b);
    const count = Math.max(1, Math.ceil(length / stepM));
    for (let step = 1; step <= count; step += 1) {
      const t = step / count;
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return result;
}

function midpoint(a: Coordinate, b: Coordinate): Coordinate { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function candidateGaps(
  feature: OfficialTrailFeature,
  trailIndex: SegmentIndex,
  allIndex: SegmentIndex,
  projector: Projector,
  policy: OfficialTrailConflationPolicy,
): { candidates: Candidate[]; rejected: OfficialTrailConflationAudit["rejected"] } {
  const samples = resample(feature.coordinates, policy.sampleStepM, projector);
  const absent = samples.slice(0, -1).map((coordinate, index) =>
    trailIndex.nearest(midpoint(coordinate, samples[index + 1]!), policy.representedDistanceM) === null);
  const candidates: Candidate[] = [];
  const rejected: OfficialTrailConflationAudit["rejected"] = [];
  let run = 0;
  for (let index = 0; index < absent.length;) {
    if (!absent[index]) { index += 1; continue; }
    const rawStart = index;
    while (index < absent.length && absent[index]) index += 1;
    const rawEnd = index;
    const naturalStart = rawStart === 0;
    const naturalEnd = rawEnd === absent.length;
    let start = rawStart;
    let end = rawEnd;
    let truncatedStart = false;
    let truncatedEnd = false;
    let startBase: NearestSegment | null = naturalStart
      ? allIndex.nearest(samples[start]!, policy.endpointConnectionDistanceM)
      : null;
    let endBase: NearestSegment | null = naturalEnd
      ? allIndex.nearest(samples[end]!, policy.endpointConnectionDistanceM)
      : null;
    if (!naturalStart) {
      while (start >= 0) {
        const direction = projector.direction(samples[start]!, samples[Math.min(start + 1, samples.length - 1)]!);
        startBase = trailIndex.nearest(samples[start]!, policy.endpointConnectionDistanceM)
          ?? trailIndex.nearest(samples[start]!, policy.internalConnectionDistanceM, direction, policy.maximumConnectionAngleDegrees);
        if (startBase) break;
        start -= 1;
      }
      const transitionLength = start >= 0 ? lineLength(samples.slice(start, rawStart + 1), projector) : Number.POSITIVE_INFINITY;
      if (!startBase || transitionLength > policy.maximumTransitionLengthM) {
        start = rawStart;
        startBase = null;
        truncatedStart = true;
      }
    }
    if (!naturalEnd) {
      while (end < samples.length) {
        const direction = projector.direction(samples[Math.max(0, end - 1)]!, samples[end]!);
        endBase = trailIndex.nearest(samples[end]!, policy.endpointConnectionDistanceM)
          ?? trailIndex.nearest(samples[end]!, policy.internalConnectionDistanceM, direction, policy.maximumConnectionAngleDegrees);
        if (endBase) break;
        end += 1;
      }
      const transitionLength = end < samples.length ? lineLength(samples.slice(rawEnd, end + 1), projector) : Number.POSITIVE_INFINITY;
      if (!endBase || transitionLength > policy.maximumTransitionLengthM) {
        end = rawEnd;
        endBase = null;
        truncatedEnd = true;
      }
    }
    const coordinates = samples.slice(start, end + 1);
    const lengthM = lineLength(coordinates, projector);
    if (lengthM < policy.minimumGapLengthM) {
      rejected.push({ externalId: feature.externalId, name: feature.name, reason: "below-minimum-gap-length", lengthM });
      continue;
    }
    run += 1;
    candidates.push({
      id: `official-gap-${stableId(`${feature.externalId}\0${run}\0${coordinates[0]!.join(",")}\0${coordinates.at(-1)!.join(",")}`)}`,
      feature,
      coordinates,
      lengthM,
      naturalStart,
      naturalEnd,
      truncatedStart,
      truncatedEnd,
      startBase,
      endBase,
    });
  }
  return { candidates, rejected };
}

function deduplicateCandidates(
  input: readonly Candidate[],
  projector: Projector,
  policy: OfficialTrailConflationPolicy,
): { candidates: Candidate[]; rejected: OfficialTrailConflationAudit["rejected"] } {
  const index = new SegmentIndex(projector, Math.max(10, policy.duplicateDistanceM));
  const candidates: Candidate[] = [];
  const rejected: OfficialTrailConflationAudit["rejected"] = [];
  for (const candidate of [...input].sort((first, second) => first.id.localeCompare(second.id))) {
    const samples = resample(candidate.coordinates, policy.sampleStepM, projector);
    const matched = samples.filter((coordinate) => index.nearest(coordinate, policy.duplicateDistanceM) !== null).length;
    if (samples.length > 0 && matched / samples.length >= policy.duplicateCoverageRatio) {
      rejected.push({ externalId: candidate.feature.externalId, name: candidate.feature.name, reason: "duplicate-official-gap", lengthM: candidate.lengthM });
      continue;
    }
    candidates.push(candidate);
    index.addLine(candidate.coordinates);
  }
  return { candidates, rejected };
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[value] !== root) { const next = this.parent[value]!; this.parent[value] = root; value = next; }
    return root;
  }
  union(first: number, second: number): void {
    const a = this.find(first); const b = this.find(second);
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b);
  }
}

type Endpoint = { candidateIndex: number; name: EndpointName; coordinate: Coordinate; base: NearestSegment | null };

function endpointComponents(candidates: readonly Candidate[], projector: Projector, policy: OfficialTrailConflationPolicy): {
  components: UnionFind;
  endpointGroups: UnionFind;
  endpoints: Endpoint[];
} {
  const endpoints = candidates.flatMap((candidate, candidateIndex): Endpoint[] => [
    { candidateIndex, name: "start", coordinate: candidate.coordinates[0]!, base: candidate.startBase },
    { candidateIndex, name: "end", coordinate: candidate.coordinates.at(-1)!, base: candidate.endBase },
  ]);
  const components = new UnionFind(candidates.length);
  const endpointGroups = new UnionFind(endpoints.length);
  for (let first = 0; first < endpoints.length; first += 1) {
    for (let second = first + 1; second < endpoints.length; second += 1) {
      if (projector.distance(endpoints[first]!.coordinate, endpoints[second]!.coordinate) > policy.candidateConnectionDistanceM) continue;
      components.union(endpoints[first]!.candidateIndex, endpoints[second]!.candidateIndex);
      endpointGroups.union(first, second);
    }
  }
  return { components, endpointGroups, endpoints };
}

function filterDisconnectedCandidates(
  candidates: readonly Candidate[],
  projector: Projector,
  policy: OfficialTrailConflationPolicy,
): { candidates: Candidate[]; rejected: OfficialTrailConflationAudit["rejected"]; endpoints: Endpoint[]; endpointGroups: UnionFind } {
  const { components, endpoints, endpointGroups } = endpointComponents(candidates, projector, policy);
  const attachedComponents = new Set(endpoints.filter(({ base }) => base).map(({ candidateIndex }) => components.find(candidateIndex)));
  const acceptedIndexes = new Set<number>();
  const rejected: OfficialTrailConflationAudit["rejected"] = [];
  candidates.forEach((candidate, index) => {
    if (attachedComponents.has(components.find(index))) acceptedIndexes.add(index);
    else rejected.push({ externalId: candidate.feature.externalId, name: candidate.feature.name, reason: "disconnected-official-component", lengthM: candidate.lengthM });
  });
  const accepted = candidates.filter((_candidate, index) => acceptedIndexes.has(index));
  if (accepted.length === candidates.length) return { candidates: accepted, rejected, endpoints, endpointGroups };
  const regrouped = endpointComponents(accepted, projector, policy);
  return { candidates: accepted, rejected, endpoints: regrouped.endpoints, endpointGroups: regrouped.endpointGroups };
}

function endpointKey(candidate: Candidate, name: EndpointName): string { return `${candidate.id}:${name}`; }
function coordinateKey(coordinate: Coordinate): string { return `${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`; }

function attachToBaseTopology(
  topology: NormalizedTopology,
  candidates: readonly Candidate[],
): { topology: NormalizedTopology; endpointNodes: Map<string, string>; attachmentCount: number } {
  const nodes = topology.nodes.map((node) => ({ ...node, flags: [...node.flags], sourceRefs: [...node.sourceRefs] }));
  const ways = topology.ways.map((way) => ({ ...way, nodeIds: [...way.nodeIds], coordinates: [...way.coordinates], flags: [...way.flags], sourceRefs: [...way.sourceRefs] }));
  const endpointNodes = new Map<string, string>();
  const bySegment = new Map<string, Array<{ candidate: Candidate; name: EndpointName; nearest: NearestSegment }>>();
  for (const candidate of candidates) for (const name of ["start", "end"] as const) {
    const nearest = name === "start" ? candidate.startBase : candidate.endBase;
    if (!nearest) continue;
    const key = `${nearest.wayIndex}:${nearest.segmentIndex}`;
    const values = bySegment.get(key) ?? [];
    values.push({ candidate, name, nearest });
    bySegment.set(key, values);
  }
  const additionsByWay = new Map<number, Map<number, Array<{ t: number; coordinate: Coordinate; node: NormalizedNode; endpointKeys: string[] }>>>();
  for (const attachments of bySegment.values()) {
    const first = attachments[0]!.nearest;
    const way = ways[first.wayIndex]!;
    for (const attachment of attachments.sort((a, b) => a.nearest.t - b.nearest.t || endpointKey(a.candidate, a.name).localeCompare(endpointKey(b.candidate, b.name)))) {
      const { nearest, candidate, name } = attachment;
      if (nearest.t <= 1e-7) { endpointNodes.set(endpointKey(candidate, name), way.nodeIds[nearest.segmentIndex]!); continue; }
      if (nearest.t >= 1 - 1e-7) { endpointNodes.set(endpointKey(candidate, name), way.nodeIds[nearest.segmentIndex + 1]!); continue; }
      const segmentAdditions = additionsByWay.get(nearest.wayIndex)
        ?? new Map<number, Array<{ t: number; coordinate: Coordinate; node: NormalizedNode; endpointKeys: string[] }>>();
      const additions = segmentAdditions.get(nearest.segmentIndex) ?? [] as Array<{
        t: number; coordinate: Coordinate; node: NormalizedNode; endpointKeys: string[];
      }>;
      const existing = additions.find(({ coordinate }) => coordinateKey(coordinate) === coordinateKey(nearest.coordinate));
      if (existing) {
        existing.endpointKeys.push(endpointKey(candidate, name));
      } else {
        const id = `official-attachment-${stableId(`${way.externalId}\0${nearest.segmentIndex}\0${coordinateKey(nearest.coordinate)}`)}`;
        const sourceRefs = [...new Set([...way.sourceRefs, ...candidate.feature.sourceRefs])].sort();
        additions.push({
          t: nearest.t,
          coordinate: nearest.coordinate,
          node: { id, externalId: id, lon: nearest.coordinate[0], lat: nearest.coordinate[1], elevationM: null, flags: ["official-trail-attachment"], sourceRefs },
          endpointKeys: [endpointKey(candidate, name)],
        });
      }
      segmentAdditions.set(nearest.segmentIndex, additions);
      additionsByWay.set(nearest.wayIndex, segmentAdditions);
    }
  }
  for (const [wayIndex, additionsBySegment] of additionsByWay) {
    const way = ways[wayIndex]!;
    const coordinates: Coordinate[] = [way.coordinates[0]!];
    const nodeIds: string[] = [way.nodeIds[0]!];
    for (let segmentIndex = 0; segmentIndex < way.coordinates.length - 1; segmentIndex += 1) {
      for (const addition of (additionsBySegment.get(segmentIndex) ?? []).sort((a, b) => a.t - b.t)) {
        nodes.push(addition.node);
        coordinates.push(addition.coordinate);
        nodeIds.push(addition.node.id);
        for (const key of addition.endpointKeys) endpointNodes.set(key, addition.node.id);
      }
      coordinates.push(way.coordinates[segmentIndex + 1]!);
      nodeIds.push(way.nodeIds[segmentIndex + 1]!);
    }
    ways[wayIndex] = { ...way, coordinates, nodeIds };
  }
  return { topology: { ...topology, nodes, ways }, endpointNodes, attachmentCount: endpointNodes.size };
}

function materializeOfficialWays(
  topology: NormalizedTopology,
  candidates: readonly Candidate[],
  endpoints: readonly Endpoint[],
  endpointGroups: UnionFind,
  baseEndpointNodes: Map<string, string>,
): { topology: NormalizedTopology; auditRows: OfficialTrailConflationAudit["accepted"]; candidateAttachmentCount: number } {
  const nodes = [...topology.nodes];
  const ways = [...topology.ways];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const endpointNodeIds = new Map(baseEndpointNodes);
  const groups = new Map<number, number[]>();
  endpoints.forEach((_endpoint, index) => {
    const root = endpointGroups.find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  });
  let candidateAttachmentCount = 0;
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const baseNodeId = indices.map((index) => {
      const endpoint = endpoints[index]!;
      return endpointNodeIds.get(endpointKey(candidates[endpoint.candidateIndex]!, endpoint.name));
    }).find(Boolean);
    let sharedNodeId = baseNodeId;
    if (!sharedNodeId) {
      const members = indices.map((index) => endpoints[index]!).sort((a, b) =>
        endpointKey(candidates[a.candidateIndex]!, a.name).localeCompare(endpointKey(candidates[b.candidateIndex]!, b.name)));
      const coordinate = members[0]!.coordinate;
      sharedNodeId = `official-junction-${stableId(members.map((endpoint) => endpointKey(candidates[endpoint.candidateIndex]!, endpoint.name)).join("\0"))}`;
      const sourceRefs = [...new Set(members.flatMap(({ candidateIndex }) => candidates[candidateIndex]!.feature.sourceRefs))].sort();
      const node: NormalizedNode = { id: sharedNodeId, externalId: sharedNodeId, lon: coordinate[0], lat: coordinate[1], elevationM: null, flags: ["official-trail-junction"], sourceRefs };
      nodes.push(node); nodesById.set(node.id, node);
    }
    for (const index of indices) {
      const endpoint = endpoints[index]!;
      const key = endpointKey(candidates[endpoint.candidateIndex]!, endpoint.name);
      if (!endpointNodeIds.has(key)) { endpointNodeIds.set(key, sharedNodeId); candidateAttachmentCount += 1; }
    }
  }

  const auditRows: OfficialTrailConflationAudit["accepted"] = [];
  for (const candidate of candidates) {
    const coordinateNodeIds: string[] = [];
    const outputCoordinates: Coordinate[] = [];
    for (let index = 0; index < candidate.coordinates.length; index += 1) {
      const endpointName = index === 0 ? "start" : index === candidate.coordinates.length - 1 ? "end" : null;
      const endpointNodeId = endpointName ? endpointNodeIds.get(endpointKey(candidate, endpointName)) : undefined;
      if (endpointNodeId) {
        const node = nodesById.get(endpointNodeId)!;
        coordinateNodeIds.push(endpointNodeId); outputCoordinates.push([node.lon, node.lat]);
        continue;
      }
      const coordinate = candidate.coordinates[index]!;
      const id = `official-node-${stableId(`${candidate.id}\0${index}\0${coordinateKey(coordinate)}`)}`;
      if (!nodesById.has(id)) {
        const node: NormalizedNode = { id, externalId: id, lon: coordinate[0], lat: coordinate[1], elevationM: null, flags: ["official-trail-node"], sourceRefs: [...candidate.feature.sourceRefs] };
        nodes.push(node); nodesById.set(id, node);
      }
      coordinateNodeIds.push(id); outputCoordinates.push(coordinate);
    }
    if (new Set(coordinateNodeIds).size < 2) continue;
    const way: NormalizedWay = {
      id: candidate.id,
      externalId: candidate.feature.externalId,
      nodeIds: coordinateNodeIds,
      coordinates: outputCoordinates,
      name: candidate.feature.name,
      accessState: candidate.feature.accessState,
      bidirectional: true,
      edgeClass: "trail",
      sourceRefs: [...candidate.feature.sourceRefs],
      flags: [
        ...candidate.feature.flags,
        `official-gap-id:${candidate.id}`,
        ...(candidate.truncatedStart ? ["official-trail-truncated-start"] : []),
        ...(candidate.truncatedEnd ? ["official-trail-truncated-end"] : []),
      ],
    };
    ways.push(way);
    const attachment = (name: EndpointName, natural: boolean, truncated: boolean): "base" | "official" | "terminal" | "truncated" => {
      if (baseEndpointNodes.has(endpointKey(candidate, name))) return "base";
      if (endpointNodeIds.has(endpointKey(candidate, name))) return "official";
      if (truncated) return "truncated";
      return natural ? "terminal" : "official";
    };
    auditRows.push({
      id: candidate.id,
      externalId: candidate.feature.externalId,
      name: candidate.feature.name,
      lengthM: candidate.lengthM,
      startAttachment: attachment("start", candidate.naturalStart, candidate.truncatedStart),
      endAttachment: attachment("end", candidate.naturalEnd, candidate.truncatedEnd),
    });
  }
  return { topology: { ...topology, nodes, ways }, auditRows, candidateAttachmentCount };
}

function increment(counts: Record<string, number>, reason: string): void { counts[reason] = (counts[reason] ?? 0) + 1; }

export function conflateOfficialTrails(input: {
  topology: NormalizedTopology;
  features: readonly OfficialTrailFeature[];
  sourceId: string;
  policy?: Partial<OfficialTrailConflationPolicy>;
}): OfficialTrailConflationResult {
  const policy = { ...DEFAULT_POLICY, ...input.policy };
  const projector = new Projector(topologyLatitude(input.topology, input.features));
  const indexes = topologyIndexes(input.topology, projector, Math.max(policy.representedDistanceM, policy.internalConnectionDistanceM));
  const rejected: OfficialTrailConflationAudit["rejected"] = [];
  const rawCandidates: Candidate[] = [];
  const representedFeatures = new Set<string>();
  for (const feature of input.features) {
    if (!feature.eligible) {
      rejected.push({ externalId: feature.externalId, name: feature.name, reason: feature.eligibilityReason ?? "ineligible", lengthM: lineLength(feature.coordinates, projector) });
      continue;
    }
    const result = candidateGaps(feature, indexes.trails, indexes.all, projector, policy);
    rawCandidates.push(...result.candidates); rejected.push(...result.rejected);
    if (result.candidates.length === 0 && result.rejected.length === 0) representedFeatures.add(feature.externalId);
  }
  const deduplicated = deduplicateCandidates(rawCandidates, projector, policy);
  rejected.push(...deduplicated.rejected);
  const connected = filterDisconnectedCandidates(deduplicated.candidates, projector, policy);
  rejected.push(...connected.rejected);
  const attached = attachToBaseTopology(input.topology, connected.candidates);
  const materialized = materializeOfficialWays(
    attached.topology,
    connected.candidates,
    connected.endpoints,
    connected.endpointGroups,
    attached.endpointNodes,
  );
  const rejectionCounts: Record<string, number> = {};
  for (const row of rejected) increment(rejectionCounts, row.reason);
  const audit: OfficialTrailConflationAudit = {
    schemaVersion: "1",
    algorithmVersion: OFFICIAL_TRAIL_CONFLATION_VERSION,
    sourceId: input.sourceId,
    policy,
    inputFeatureCount: input.features.length,
    eligibleFeatureCount: input.features.filter(({ eligible }) => eligible).length,
    ineligibleFeatureCount: input.features.filter(({ eligible }) => !eligible).length,
    representedFeatureCount: representedFeatures.size,
    candidateGapCount: rawCandidates.length,
    acceptedGapCount: materialized.auditRows.length,
    rejectedGapCount: rawCandidates.length - materialized.auditRows.length,
    acceptedFeatureCount: new Set(materialized.auditRows.map(({ externalId }) => externalId)).size,
    addedLengthM: materialized.auditRows.reduce((sum, row) => sum + row.lengthM, 0),
    baseAttachmentCount: attached.attachmentCount,
    candidateAttachmentCount: materialized.candidateAttachmentCount,
    truncatedEndpointCount: materialized.auditRows.reduce((sum, row) =>
      sum + Number(row.startAttachment === "truncated") + Number(row.endAttachment === "truncated"), 0),
    rejectionCounts,
    accepted: materialized.auditRows,
    rejected: rejected.sort((first, second) => first.reason.localeCompare(second.reason) || first.externalId.localeCompare(second.externalId)),
  };
  return { topology: materialized.topology, audit };
}
