import { packManifestSchema, type PackManifest } from "@/lib/contracts";
import { writePackDatabase } from "@/lib/data/sqlite-writer";
import { buildClosedRouteTopology } from "@/lib/data/topology-compiler";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "@/lib/data/types";
import type { AccessPointCandidate, GraphAccessPoint, InducedGraph } from "./types";

export const GRAPH_FIXTURE_IDENTITY = {
  id: "fixture-pack", dataVersion: "fixture-v6", builtAt: "2026-01-01T00:00:00.000Z",
};

/** Write explicit graph measurements through the production schema and topology builder. */
export function writeGraphFixture(
  databasePath: string,
  graph: InducedGraph,
  points: Array<GraphAccessPoint & Partial<AccessPointCandidate>> = graph.accessPoints,
): PackManifest {
  const nodes: NormalizedNode[] = [...graph.nodes.values()].map((node) => ({
    id: node.id, externalId: node.id, lon: node.lon, lat: node.lat,
    elevationM: node.elevationMeters, flags: node.flags, sourceRefs: ["fixture"],
  }));
  const edges: CompiledEdge[] = graph.edges.map((edge) => {
    const from = graph.nodes.get(edge.fromNodeId)!;
    const to = graph.nodes.get(edge.toNodeId)!;
    const intervals = Math.ceil(edge.lengthMeters / 25);
    const profile = from.elevationMeters !== null && to.elevationMeters !== null
      ? Array.from({ length: intervals + 1 }, (_, index) => ({
        distanceMeters: edge.lengthMeters * index / intervals,
        elevationMeters: from.elevationMeters! + (to.elevationMeters! - from.elevationMeters!) * index / intervals,
      }))
      : null;
    return {
      id: edge.id, stablePhysicalId: String(edge.physicalEdgeKey ?? edge.id),
      fromNode: edge.fromNodeId, toNode: edge.toNodeId, geometry: edge.coordinates,
      lengthM: edge.lengthMeters, gainM: edge.gainMeters, lossM: edge.lossMeters,
      maxElevationM: edge.maximumElevationMeters, maxSustainedGradePct: edge.maximumSustainedGradePct,
      elevationProfile: edge.elevationProfile ?? profile, edgeClass: edge.edgeClass ?? "trail",
      accessState: edge.accessState, sourceRefs: edge.sourceIds,
      flags: [...edge.flags, ...(edge.trailName ? [`trail-name:${edge.trailName}`] : [])],
    };
  });
  const accessPoints: NormalizedAccessPoint[] = points.map((point) => ({
    id: point.id, externalId: point.id, nodeId: point.nodeId, name: point.name,
    kind: point.kind === "parking" ? "parking" : "trailhead", accessState: point.accessState,
    confidence: point.confidence, parkingEvidence: point.parkingEvidence, sourceRefs: point.sourceIds,
    nearbyBuildingCount: point.nearbyBuildingCount,
    knownConnectivity: point.knownConnectivity ?? 1, inclusiveConnectivity: point.inclusiveConnectivity ?? 1,
    knownOutDegree: point.knownOutDegree ?? 1, inclusiveOutDegree: point.inclusiveOutDegree ?? 1,
    reachableTrailKm: point.reachableTrailKm ?? 5, trailComponentId: point.trailComponentId ?? point.nodeId,
    portalRoadClass: point.portalRoadClass ?? "street", parkingDistanceM: point.parkingDistanceM ?? null,
  }));
  const topologyOptions = {
    builtAt: GRAPH_FIXTURE_IDENTITY.builtAt, runtimeMode: "reachable-graph-fallback" as const,
    algorithmVersion: "closed-route-topology-v1", policyVersion: "closed-route-decision-graph-v1",
  };
  const topology = buildClosedRouteTopology(nodes, edges, accessPoints, topologyOptions);
  const manifest = packManifestSchema.parse({
    ...GRAPH_FIXTURE_IDENTITY, schemaVersion: "6", name: "Graph fixture",
    compilerVersion: "fixture-compiler", metricAlgorithmVersion: "fixture-metrics",
    coverage: {
      bbox: [-180, -85, 180, 85],
      boundary: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] },
    },
    display: { center: [0, 0], zoom: 10 },
    capabilities: { elevation: true, officialAccess: true, namedAreas: true, closedRouteTopology: true,
      batchSearchRegions: true, elevationProfiles: true, portalAccessPoints: true },
    fieldConfidence: { topology: "high" },
    sources: [{ id: "fixture", authority: "Fixture", dataset: "Graph cases", version: "1",
      retrievedAt: GRAPH_FIXTURE_IDENTITY.builtAt, url: "https://example.invalid/fixture", license: "CC0-1.0",
      contentHash: `sha256:${"0".repeat(64)}` }],
    closedRouteTopology: { runtimeMode: topology.runtimeMode, algorithmVersion: topology.algorithmVersion,
      policyVersion: topology.policyVersion, profiles: ["known", "inclusive"] },
  });
  writePackDatabase(databasePath, {
    nodes, edges, accessPoints, namedAreas: [], searchRegions: [],
    sources: manifest.sources.map((source) => ({ ...source, contentHash: source.contentHash as `sha256:${string}`, localPath: databasePath })),
    metadata: { schemaVersion: "6", packId: manifest.id, dataVersion: manifest.dataVersion, builtAt: manifest.builtAt,
      compilerVersion: manifest.compilerVersion, metricAlgorithmVersion: manifest.metricAlgorithmVersion,
      topologyContentHash: topology.contentHash },
    closedRouteTopology: topology,
  });
  return manifest;
}
