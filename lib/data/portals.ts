import type { AccessState } from "@/lib/graph/types";
import type { NormalizedAccessEvidence } from "./adapters";
import type {
  Coordinate,
  NormalizedAccessPoint,
  NormalizedNode,
  NormalizedPortalEvidence,
  NormalizedTopology,
  NormalizedWay,
} from "./types";

export const PORTAL_CLUSTER_DISTANCE_M = 150;
export const PORTAL_EVIDENCE_DISTANCE_M = 250;
export const PARKING_ROAD_CONTACT_DISTANCE_M = 25;
export const PORTAL_DERIVATION_VERSION = "portal-derivation-v3";

const EARTH_RADIUS_M = 6_371_008.8;
const RESTRICTIVE_ACCESS = new Set<AccessState>(["private", "closed", "prohibited"]);
const RESTRICTION_PRIORITY: readonly AccessState[] = ["closed", "prohibited", "private"];

type SpatialEntry<T> = {
  coordinate: Coordinate;
  value: T;
};

type PortalCandidate = {
  node: NormalizedNode;
  directStreetIntersection: boolean;
  roadClass: "street" | "service-road";
  nearbyEvidence: Array<{ evidence: NormalizedPortalEvidence; distanceM: number }>;
  componentId: string;
  reachableTrailKm: number;
  incidentTrails: NormalizedWay[];
};

type OfficialAssignment = {
  evidence: NormalizedAccessEvidence;
  distanceM: number;
};

function radians(value: number): number {
  return value * Math.PI / 180;
}

function haversineDistanceM(first: Coordinate, second: Coordinate): number {
  const firstLat = radians(first[1]);
  const secondLat = radians(second[1]);
  const latitudeDelta = secondLat - firstLat;
  const longitudeDelta = radians(second[0] - first[0]);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function cartesianCoordinate([lon, lat]: Coordinate): readonly [number, number, number] {
  const latitude = radians(lat);
  const longitude = radians(lon);
  const radiusAtLatitude = EARTH_RADIUS_M * Math.cos(latitude);
  return [
    radiusAtLatitude * Math.cos(longitude),
    radiusAtLatitude * Math.sin(longitude),
    EARTH_RADIUS_M * Math.sin(latitude),
  ];
}

/**
 * A three-dimensional Earth-centred grid avoids latitude-dependent longitude
 * buckets. Points within the query radius can differ by at most one bucket in
 * each dimension, and the final inclusion check still uses great-circle
 * distance.
 */
class SpatialGrid<T> {
  private readonly buckets = new Map<string, SpatialEntry<T>[]>();

  constructor(private readonly cellSizeM: number) {}

  private cell(coordinate: Coordinate): readonly [number, number, number] {
    return cartesianCoordinate(coordinate).map((value) => Math.floor(value / this.cellSizeM)) as unknown as readonly [number, number, number];
  }

  private key(x: number, y: number, z: number): string {
    return `${x}:${y}:${z}`;
  }

  add(entry: SpatialEntry<T>): void {
    const [x, y, z] = this.cell(entry.coordinate);
    const key = this.key(x, y, z);
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(entry);
    else this.buckets.set(key, [entry]);
  }

  within(coordinate: Coordinate, distanceM: number): Array<SpatialEntry<T> & { distanceM: number }> {
    const [centerX, centerY, centerZ] = this.cell(coordinate);
    const cellRadius = Math.ceil(distanceM / this.cellSizeM);
    const result: Array<SpatialEntry<T> & { distanceM: number }> = [];
    for (let x = centerX - cellRadius; x <= centerX + cellRadius; x += 1) {
      for (let y = centerY - cellRadius; y <= centerY + cellRadius; y += 1) {
        for (let z = centerZ - cellRadius; z <= centerZ + cellRadius; z += 1) {
          for (const entry of this.buckets.get(this.key(x, y, z)) ?? []) {
            const measuredDistanceM = haversineDistanceM(coordinate, entry.coordinate);
            if (measuredDistanceM <= distanceM) result.push({ ...entry, distanceM: measuredDistanceM });
          }
        }
      }
    }
    return result;
  }
}

class DisjointSet {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(index: number): number {
    const parent = this.parent[index]!;
    if (parent !== index) this.parent[index] = this.find(parent);
    return this.parent[index]!;
  }

  union(first: number, second: number): void {
    let firstRoot = this.find(first);
    let secondRoot = this.find(second);
    if (firstRoot === secondRoot) return;
    if (this.rank[firstRoot]! < this.rank[secondRoot]!) [firstRoot, secondRoot] = [secondRoot, firstRoot];
    this.parent[secondRoot] = firstRoot;
    if (this.rank[firstRoot] === this.rank[secondRoot]) this.rank[firstRoot]! += 1;
  }
}

function coordinateForNode(node: NormalizedNode): Coordinate {
  return [node.lon, node.lat];
}

function nonRestrictive(way: NormalizedWay): boolean {
  return !RESTRICTIVE_ACCESS.has(way.accessState);
}

function accessStateForIncidentTrails(ways: readonly NormalizedWay[]): AccessState {
  const states = new Set(ways.map(({ accessState }) => accessState));
  for (const restriction of RESTRICTION_PRIORITY) {
    if (states.has(restriction)) return restriction;
  }
  if (states.has("unknown")) return "unknown";
  return states.has("public") ? "public" : "unknown";
}

function buildWaysByNode(ways: readonly NormalizedWay[]): Map<string, NormalizedWay[]> {
  const result = new Map<string, NormalizedWay[]>();
  for (const way of ways) {
    for (const nodeId of new Set(way.nodeIds)) {
      const existing = result.get(nodeId);
      if (existing) existing.push(way);
      else result.set(nodeId, [way]);
    }
  }
  return result;
}

function trailComponents(
  trailWays: readonly NormalizedWay[],
  nodesById: ReadonlyMap<string, NormalizedNode>,
): Map<string, { id: string; lengthKm: number }> {
  const adjacency = new Map<string, Set<string>>();
  const uniqueSegments = new Map<string, { first: string; second: string; lengthM: number }>();
  const ensureAdjacency = (nodeId: string): Set<string> => {
    const existing = adjacency.get(nodeId);
    if (existing) return existing;
    const created = new Set<string>();
    adjacency.set(nodeId, created);
    return created;
  };

  for (const way of trailWays) {
    for (const nodeId of way.nodeIds) ensureAdjacency(nodeId);
    for (let index = 1; index < way.nodeIds.length; index += 1) {
      const first = way.nodeIds[index - 1]!;
      const second = way.nodeIds[index]!;
      if (first === second) continue;
      const firstNode = nodesById.get(first);
      const secondNode = nodesById.get(second);
      if (!firstNode || !secondNode) throw new Error(`Trail way ${way.id} references a missing node`);
      ensureAdjacency(first).add(second);
      ensureAdjacency(second).add(first);
      const key = first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
      if (!uniqueSegments.has(key)) {
        uniqueSegments.set(key, {
          first,
          second,
          lengthM: haversineDistanceM(coordinateForNode(firstNode), coordinateForNode(secondNode)),
        });
      }
    }
  }

  const componentRootByNode = new Map<string, string>();
  for (const startNodeId of [...adjacency.keys()].sort()) {
    if (componentRootByNode.has(startNodeId)) continue;
    const members: string[] = [];
    const stack = [startNodeId];
    componentRootByNode.set(startNodeId, startNodeId);
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      members.push(nodeId);
      for (const neighbor of adjacency.get(nodeId) ?? []) {
        if (componentRootByNode.has(neighbor)) continue;
        componentRootByNode.set(neighbor, startNodeId);
        stack.push(neighbor);
      }
    }
    const stableRoot = members.sort()[0]!;
    for (const member of members) componentRootByNode.set(member, stableRoot);
  }

  const lengthByRoot = new Map<string, number>();
  for (const segment of uniqueSegments.values()) {
    const root = componentRootByNode.get(segment.first);
    if (!root || root !== componentRootByNode.get(segment.second)) {
      throw new Error("Trail component construction produced an inconsistent segment");
    }
    lengthByRoot.set(root, (lengthByRoot.get(root) ?? 0) + segment.lengthM);
  }

  const result = new Map<string, { id: string; lengthKm: number }>();
  for (const [nodeId, root] of componentRootByNode) {
    result.set(nodeId, {
      id: `trail-component:${root}`,
      lengthKm: (lengthByRoot.get(root) ?? 0) / 1_000,
    });
  }
  return result;
}

function evidenceCoordinates(
  evidence: NormalizedPortalEvidence,
  nodesById: ReadonlyMap<string, NormalizedNode>,
): Coordinate[] {
  if (evidence.coordinates.length > 0) return evidence.coordinates;
  return evidence.nodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is NormalizedNode => node !== undefined)
    .map(coordinateForNode);
}

function nearbyEvidenceForCandidate(
  coordinate: Coordinate,
  evidenceGrid: SpatialGrid<NormalizedPortalEvidence>,
): Array<{ evidence: NormalizedPortalEvidence; distanceM: number }> {
  const nearestById = new Map<string, { evidence: NormalizedPortalEvidence; distanceM: number }>();
  for (const match of evidenceGrid.within(coordinate, PORTAL_EVIDENCE_DISTANCE_M)) {
    const existing = nearestById.get(match.value.id);
    if (!existing || match.distanceM < existing.distanceM) {
      nearestById.set(match.value.id, { evidence: match.value, distanceM: match.distanceM });
    }
  }
  return [...nearestById.values()].sort((first, second) =>
    first.distanceM - second.distanceM || first.evidence.id.localeCompare(second.evidence.id));
}

function evidenceQuality(candidate: PortalCandidate): number {
  if (candidate.nearbyEvidence.some(({ evidence }) => evidence.kind === "trailhead")) return 5;
  if (candidate.nearbyEvidence.some(({ evidence }) => evidence.kind === "information")) return 4;
  if (candidate.nearbyEvidence.some(({ evidence }) => evidence.kind === "gate")) return 3;
  if (candidate.nearbyEvidence.some(({ evidence }) => evidence.kind === "parking")) return 2;
  return candidate.directStreetIntersection ? 1 : 0;
}

function representativeForCluster(candidates: readonly PortalCandidate[]): PortalCandidate {
  return [...candidates].sort((first, second) =>
    second.reachableTrailKm - first.reachableTrailKm
      || evidenceQuality(second) - evidenceQuality(first)
      || first.node.id.localeCompare(second.node.id))[0]!;
}

function preferredLabel(candidate: PortalCandidate): string {
  const namedEvidence = candidate.nearbyEvidence.filter(({ evidence }) => evidence.name?.trim());
  for (const kind of ["trailhead", "information", "gate"] as const) {
    const match = namedEvidence.find(({ evidence }) => evidence.kind === kind);
    if (match?.evidence.name) return match.evidence.name;
  }
  const trailNames = [...new Set(candidate.incidentTrails.map(({ name }) => name?.trim()).filter((name): name is string => Boolean(name)))].sort();
  return trailNames.length > 0 ? `${trailNames[0]} trailhead` : "Trailhead";
}

function accessPointForCandidate(candidate: PortalCandidate): NormalizedAccessPoint {
  const parking = candidate.nearbyEvidence
    .filter(({ evidence }) => evidence.kind === "parking")
    .sort((first, second) => first.distanceM - second.distanceM || first.evidence.id.localeCompare(second.evidence.id))[0];
  const hasTrailhead = candidate.nearbyEvidence.some(({ evidence }) => evidence.kind === "trailhead");
  const hasSupportingEvidence = candidate.nearbyEvidence.some(({ evidence }) => evidence.kind !== "parking");
  const evidenceSourceRefs = candidate.nearbyEvidence.flatMap(({ evidence }) => evidence.sourceRefs);
  return {
    id: `portal:${candidate.node.id}`,
    externalId: candidate.node.externalId,
    nodeId: candidate.node.id,
    name: preferredLabel(candidate),
    kind: "trailhead",
    accessState: accessStateForIncidentTrails(candidate.incidentTrails),
    confidence: hasTrailhead ? "high" : hasSupportingEvidence || parking ? "medium" : "low",
    parkingEvidence: parking ? `portal-evidence:${parking.evidence.externalId}` : null,
    sourceRefs: [...new Set([
      ...candidate.node.sourceRefs,
      ...candidate.incidentTrails.flatMap(({ sourceRefs }) => sourceRefs),
      ...evidenceSourceRefs,
    ])].sort(),
    reachableTrailKm: candidate.reachableTrailKm,
    trailComponentId: candidate.componentId,
    portalRoadClass: candidate.roadClass,
    parkingDistanceM: parking?.distanceM ?? null,
  };
}

/**
 * Replaces source access rows with deterministic topology-derived trailhead
 * portals. Street edges are evidence-only: only trail-class ways contribute
 * reachability or portal access state.
 */
export function deriveTrailheadPortals(topology: NormalizedTopology): NormalizedTopology {
  const trailWays = topology.ways.filter(({ edgeClass }) => edgeClass === "trail");
  const streetWays = topology.ways.filter(({ edgeClass }) => edgeClass === "street");
  const parkingRoadWays = topology.ways.filter(({ edgeClass }) =>
    edgeClass === "street" || edgeClass === "service-road");
  if (trailWays.length === 0 || parkingRoadWays.length === 0) {
    throw new Error("Portal derivation requires classified trail and road ways");
  }

  const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));
  const trailsByNode = buildWaysByNode(trailWays);
  const nonRestrictiveStreetNodes = new Set(
    streetWays.filter(nonRestrictive).flatMap(({ nodeIds }) => nodeIds),
  );
  const nonRestrictiveServiceRoadNodes = new Set(
    parkingRoadWays.filter(({ edgeClass }) => edgeClass === "service-road")
      .filter(nonRestrictive).flatMap(({ nodeIds }) => nodeIds),
  );
  const nonRestrictiveParkingRoadNodes = new Set(
    parkingRoadWays.filter(nonRestrictive).flatMap(({ nodeIds }) => nodeIds),
  );
  const componentsByNode = trailComponents(trailWays, nodesById);
  const evidence = topology.portalEvidence ?? [];
  const evidenceGrid = new SpatialGrid<NormalizedPortalEvidence>(PORTAL_EVIDENCE_DISTANCE_M);
  for (const item of evidence) {
    for (const coordinate of evidenceCoordinates(item, nodesById)) evidenceGrid.add({ coordinate, value: item });
  }

  const candidateKinds = new Map<string, {
    directStreetIntersection: boolean;
    roadClass: "street" | "service-road";
  }>();
  for (const nodeId of trailsByNode.keys()) {
    if (nonRestrictiveStreetNodes.has(nodeId)) {
      candidateKinds.set(nodeId, { directStreetIntersection: true, roadClass: "street" });
      continue;
    }
    if (nonRestrictiveServiceRoadNodes.has(nodeId)) {
      const node = nodesById.get(nodeId);
      if (node && nearbyEvidenceForCandidate(coordinateForNode(node), evidenceGrid).length > 0) {
        candidateKinds.set(nodeId, { directStreetIntersection: true, roadClass: "service-road" });
      }
    }
  }

  const parkingRoadGrid = new SpatialGrid<"street" | "service-road">(PARKING_ROAD_CONTACT_DISTANCE_M);
  for (const nodeId of nonRestrictiveParkingRoadNodes) {
    const node = nodesById.get(nodeId);
    if (!node) throw new Error(`Road context references missing node ${nodeId}`);
    parkingRoadGrid.add({
      coordinate: coordinateForNode(node),
      value: nonRestrictiveStreetNodes.has(nodeId) ? "street" : "service-road",
    });
  }

  const trailNodeGrid = new SpatialGrid<NormalizedNode>(PORTAL_EVIDENCE_DISTANCE_M);
  for (const nodeId of trailsByNode.keys()) {
    const node = nodesById.get(nodeId);
    if (!node) throw new Error(`Trail references missing node ${nodeId}`);
    trailNodeGrid.add({ coordinate: coordinateForNode(node), value: node });
  }
  for (const parking of evidence.filter(({ kind }) => kind === "parking")) {
    let parkingRoadClass: "street" | "service-road" | undefined = parking.nodeIds.some((nodeId) =>
      nonRestrictiveStreetNodes.has(nodeId)) ? "street"
      : parking.nodeIds.some((nodeId) => nonRestrictiveServiceRoadNodes.has(nodeId)) ? "service-road"
        : undefined;
    if (!parkingRoadClass) {
      const contact = evidenceCoordinates(parking, nodesById).flatMap((coordinate) =>
        parkingRoadGrid.within(coordinate, PARKING_ROAD_CONTACT_DISTANCE_M))
        .sort((first, second) => first.distanceM - second.distanceM
          || Number(second.value === "street") - Number(first.value === "street"))[0];
      parkingRoadClass = contact?.value;
    }
    if (!parkingRoadClass) continue;
    let nearest: { node: NormalizedNode; distanceM: number } | undefined;
    for (const coordinate of evidenceCoordinates(parking, nodesById)) {
      for (const match of trailNodeGrid.within(coordinate, PORTAL_EVIDENCE_DISTANCE_M)) {
        if (!nearest || match.distanceM < nearest.distanceM
          || (match.distanceM === nearest.distanceM && match.value.id < nearest.node.id)) {
          nearest = { node: match.value, distanceM: match.distanceM };
        }
      }
    }
    if (nearest && !candidateKinds.has(nearest.node.id)) {
      candidateKinds.set(nearest.node.id, {
        directStreetIntersection: false,
        roadClass: parkingRoadClass,
      });
    }
  }

  const candidates = [...candidateKinds.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([nodeId, kind]) => {
    const node = nodesById.get(nodeId)!;
    const component = componentsByNode.get(nodeId);
    if (!component) throw new Error(`Portal candidate ${nodeId} is outside the trail graph`);
    return {
      node,
      directStreetIntersection: kind.directStreetIntersection,
      roadClass: kind.roadClass,
      nearbyEvidence: nearbyEvidenceForCandidate(coordinateForNode(node), evidenceGrid),
      componentId: component.id,
      reachableTrailKm: component.lengthKm,
      incidentTrails: trailsByNode.get(nodeId) ?? [],
    } satisfies PortalCandidate;
  });

  const candidateGrid = new SpatialGrid<number>(PORTAL_CLUSTER_DISTANCE_M);
  const clusters = new DisjointSet(candidates.length);
  candidates.forEach((candidate, index) => {
    const coordinate = coordinateForNode(candidate.node);
    for (const match of candidateGrid.within(coordinate, PORTAL_CLUSTER_DISTANCE_M)) clusters.union(index, match.value);
    candidateGrid.add({ coordinate, value: index });
  });
  const candidatesByCluster = new Map<number, PortalCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = clusters.find(index);
    const existing = candidatesByCluster.get(root);
    if (existing) existing.push(candidate);
    else candidatesByCluster.set(root, [candidate]);
  });
  const accessPoints = [...candidatesByCluster.values()]
    .map(representativeForCluster)
    .map(accessPointForCandidate)
    .sort((first, second) => first.id.localeCompare(second.id));
  return { ...topology, accessPoints };
}

/**
 * Removes build-only road, sidewalk, and POI context after portals have been
 * derived. The published graph keeps every trail-class walking connector and
 * exactly the nodes needed by hiking edges and portal attachments.
 */
export function stripPortalBuildContext(topology: NormalizedTopology): NormalizedTopology {
  const ways = topology.ways.filter(({ edgeClass }) => edgeClass === "trail");
  if (ways.length === 0) throw new Error("Published portal topology requires trail ways");
  if (topology.accessPoints.some(({ reachableTrailKm, trailComponentId, portalRoadClass }) =>
    typeof reachableTrailKm !== "number" || !trailComponentId || !portalRoadClass)) {
    throw new Error("Published portal topology requires derived portal measurements");
  }
  const retainedNodeIds = new Set([
    ...ways.flatMap(({ nodeIds }) => nodeIds),
    ...topology.accessPoints.map(({ nodeId }) => nodeId),
  ]);
  const nodes = topology.nodes.filter(({ id }) => retainedNodeIds.has(id));
  return { ...topology, nodes, ways, portalEvidence: [] };
}

function confidenceScore(confidence: NormalizedAccessEvidence["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

/** Applies official entrance records as labels/evidence on existing portals. */
export function applyOfficialEntranceOverlay(
  topology: NormalizedTopology,
  evidence: readonly NormalizedAccessEvidence[],
): NormalizedTopology {
  return applyOfficialEntranceOverlayWithReport(topology, evidence).topology;
}

/** Reports actual assignments, including records already represented on a portal. */
export function applyOfficialEntranceOverlayWithReport(
  topology: NormalizedTopology,
  evidence: readonly NormalizedAccessEvidence[],
): {
  topology: NormalizedTopology;
  report: {
    inputCount: number;
    matchedEvidenceCount: number;
    unmatchedExternalIds: string[];
    matchedPortalCount: number;
    changedPortalCount: number;
  };
} {
  const portals = topology.accessPoints.filter(({ kind }) => kind === "trailhead");
  const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));
  const portalGrid = new SpatialGrid<NormalizedAccessPoint>(PORTAL_EVIDENCE_DISTANCE_M);
  for (const portal of portals) {
    const node = nodesById.get(portal.nodeId);
    if (!node) throw new Error(`Portal ${portal.id} references missing node ${portal.nodeId}`);
    portalGrid.add({ coordinate: coordinateForNode(node), value: portal });
  }

  const assignments = new Map<string, OfficialAssignment[]>();
  const unmatchedExternalIds: string[] = [];
  for (const item of [...evidence].sort((first, second) =>
    first.sourceId.localeCompare(second.sourceId) || first.externalId.localeCompare(second.externalId))) {
    if (!Number.isFinite(item.lon) || !Number.isFinite(item.lat)) {
      throw new Error(`Official entrance ${item.sourceId} / ${item.externalId} has invalid coordinates`);
    }
    const nearest = portalGrid.within([item.lon, item.lat], PORTAL_EVIDENCE_DISTANCE_M)
      .sort((first, second) => first.distanceM - second.distanceM || first.value.id.localeCompare(second.value.id))[0];
    if (!nearest) {
      unmatchedExternalIds.push(item.externalId);
      continue;
    }
    const existing = assignments.get(nearest.value.id);
    const assignment = { evidence: item, distanceM: nearest.distanceM };
    if (existing) existing.push(assignment);
    else assignments.set(nearest.value.id, [assignment]);
  }

  let changedPortalCount = 0;
  const accessPoints = topology.accessPoints.map((portal) => {
    const assigned = assignments.get(portal.id);
    if (!assigned || assigned.length === 0) return portal;
    const ordered = [...assigned].sort((first, second) =>
      first.distanceM - second.distanceM
        || first.evidence.sourceId.localeCompare(second.evidence.sourceId)
        || first.evidence.externalId.localeCompare(second.evidence.externalId));
    const best = ordered[0]!.evidence;
    const bestConfidence = ordered.map(({ evidence: item }) => item.confidence)
      .sort((first, second) => confidenceScore(second) - confidenceScore(first))[0]!;
    const confidence = confidenceScore(bestConfidence) > confidenceScore(portal.confidence) ? bestConfidence : portal.confidence;
    const sourceRefs = [...new Set([...portal.sourceRefs, ...ordered.map(({ evidence: item }) => item.sourceId)])].sort();
    if (portal.name !== best.name || portal.confidence !== confidence
      || portal.sourceRefs.length !== sourceRefs.length
      || portal.sourceRefs.some((sourceId, index) => sourceId !== sourceRefs[index])) {
      changedPortalCount += 1;
    }
    return { ...portal, name: best.name, confidence, sourceRefs };
  });
  return {
    topology: { ...topology, accessPoints },
    report: {
      inputCount: evidence.length,
      matchedEvidenceCount: evidence.length - unmatchedExternalIds.length,
      unmatchedExternalIds,
      matchedPortalCount: assignments.size,
      changedPortalCount,
    },
  };
}
