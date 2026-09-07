import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessPointCandidate, GraphEdge, GraphNode, InducedGraph } from "../../lib/graph";
import type { RouteSearchRequest } from "../../lib/solver";

export type BenchmarkCase = { id: string; graph: InducedGraph; start: AccessPointCandidate;
  request: RouteSearchRequest; graphTruncated?: boolean };
type PhysicalEdge = { id: string; from: string; to: string; directions: string; lengthMeters: number };

export function request(overrides: Partial<RouteSearchRequest> = {}): RouteSearchRequest {
  return {
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 2, max: 8 }, includeUncertainAccess: true,
    searchEffort: "quick", limit: 10, ...overrides,
  };
}

function makeGraph(nodeIds: string[], physical: PhysicalEdge[], startNodeId: string): {
  graph: InducedGraph; start: AccessPointCandidate;
} {
  const nodes = new Map<string, GraphNode>(nodeIds.map((id, index) => [id, {
    id, lon: -122 + Math.cos(index * 2.4) * index * 0.0001,
    lat: 37 + Math.sin(index * 2.4) * index * 0.0001, elevationMeters: 100, flags: [],
  }]));
  const edges: GraphEdge[] = [];
  for (const [physicalIndex, edge] of physical.entries()) {
    for (const [from, to] of edge.directions === "both"
      ? [[edge.from, edge.to], [edge.to, edge.from]] : [[edge.from, edge.to]]) {
      const a = nodes.get(from)!;
      const b = nodes.get(to)!;
      edges.push({
        id: `${edge.id}:${from}->${to}`, edgeKey: edges.length + 1, physicalEdgeKey: physicalIndex + 1,
        fromNodeId: from, toNodeId: to, coordinates: [[a.lon, a.lat], [b.lon, b.lat]],
        lengthMeters: edge.lengthMeters, gainMeters: 0, lossMeters: 0,
        maximumElevationMeters: 100, maximumSustainedGradePct: 2,
        accessState: "public", trailName: edge.id, sourceIds: ["fixture"], flags: [], edgeClass: "trail",
      });
    }
  }
  const node = nodes.get(startNodeId)!;
  const start: AccessPointCandidate = {
    id: `access-${startNodeId}`, nodeId: startNodeId, name: "Benchmark start", kind: "trailhead",
    accessState: "public", confidence: "high", parkingEvidence: "fixture", sourceIds: ["fixture"],
    nearbyBuildingCount: 0, lon: node.lon, lat: node.lat, knownConnectivity: 10, inclusiveConnectivity: 10,
    knownOutDegree: 2, inclusiveOutDegree: 2,
  };
  return { graph: { nodes, edges, accessPoints: [start] }, start };
}

export function fixtureCases(root: string): BenchmarkCase[] {
  const source = JSON.parse(readFileSync(join(root, "data/fixtures/graph/closed-route-topologies.json"), "utf8")) as {
    cases: Array<{ id: string; nodes: string[]; edges: PhysicalEdge[]; access: { node: string } }>;
  };
  const cases = source.cases.map((item): BenchmarkCase => {
    const edges = item.edges.map((edge) => ({ ...edge, lengthMeters: edge.lengthMeters * 10 }));
    const total = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
    return {
      id: `fixture/${item.id}`, ...makeGraph(item.nodes, edges, item.access.node),
      request: request({ distanceMiles: { min: total * 0.85 / 1609.344, max: total * 1.25 / 1609.344 } }),
    };
  });
  const loop = cases[0]!;
  const lollipop = cases[1]!;
  const eight = cases[2]!;
  const uncertain = { ...loop.graph, edges: loop.graph.edges.map((edge) => ({ ...edge,
    accessState: edge.physicalEdgeKey === 1 ? "unknown" as const : edge.accessState })) };
  cases.push(
    { ...loop, id: "fixture/unknown-included", graph: uncertain },
    { ...loop, id: "fixture/unknown-excluded", graph: uncertain, request: { ...loop.request, includeUncertainAccess: false } },
    { ...loop, id: "fixture/distance-near", request: request({ distanceMiles: { min: 2, max: 2.1 } }) },
    { ...loop, id: "fixture/gain-near", request: request({ ...loop.request, elevationGainFeet: { min: 500, max: 1000 } }) },
    { ...loop, id: "fixture/grade-near", request: request({ ...loop.request, steepestSustainedGradePct: { min: 0, max: 1 } }) },
    { ...loop, id: "fixture/elevation-near", request: request({ ...loop.request, maximumElevationFeet: { min: 0, max: 250 } }) },
    { ...lollipop, id: "fixture/no-repetition", request: request({ ...lollipop.request,
      closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true } }) },
    { ...lollipop, id: "fixture/stem-cap", request: request({ ...lollipop.request,
      closedRoute: { maximumRepeatedTrailPct: 100, maximumSharedStemMiles: 0.1, allowMultiCycle: true } }) },
    { ...eight, id: "fixture/single-cycle", request: request({ ...eight.request,
      closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: false } }) },
  );
  for (const width of [8, 20]) {
    const ids = Array.from({ length: width * width }, (_, index) => `n${index}`);
    const edges: PhysicalEdge[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      for (const other of [index % width < width - 1 ? index + 1 : -1, index + width]) {
        if (other < 0 || other >= ids.length) continue;
        edges.push({ id: `grid-${index}-${other}`, from: ids[index]!, to: ids[other]!,
          directions: "both", lengthMeters: 200 + (index * 17 + other * 13) % 100 });
      }
    }
    cases.push({ id: `fixture/grid-${width}`, ...makeGraph(ids, edges, ids[0]!),
      request: request({ distanceMiles: { min: 2, max: 5 }, closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: false } }) });
  }
  return cases;
}
