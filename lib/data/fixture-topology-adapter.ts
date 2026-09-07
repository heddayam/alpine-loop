import { z } from "zod";
import type { AccessState } from "@/lib/graph/types";
import type { SourceSnapshot } from "./adapters";
import { readValidatedSnapshot } from "./file-source";
import type { NormalizedAccessPoint, NormalizedTopology } from "./types";

const tagsSchema = z.record(z.string(), z.string());
const topologySchema = z.object({
  version: z.literal(1),
  nodes: z.array(z.object({
    id: z.string().min(1),
    lon: z.number().finite().min(-180).max(180),
    lat: z.number().finite().min(-90).max(90),
    tags: tagsSchema,
  }).strict()).min(2),
  ways: z.array(z.object({
    id: z.string().min(1),
    nodeIds: z.array(z.string().min(1)).min(2),
    tags: tagsSchema,
  }).strict()).min(1),
}).strict();

type TopologyInput = z.infer<typeof topologySchema>;

const PEDESTRIAN_HIGHWAYS = new Set(["path", "footway", "track", "pedestrian", "steps", "bridleway"]);

function osmAccess(tags: Record<string, string>): AccessState {
  const value = tags.foot ?? tags.access;
  if (value === "no") return "prohibited";
  if (value === "private") return "private";
  if (["yes", "designated", "permissive", "public"].includes(value ?? "")) return "public";
  return "unknown";
}

function accessPointForNode(node: TopologyInput["nodes"][number], sourceId: string): NormalizedAccessPoint | null {
  const kind = node.tags.highway === "trailhead"
    ? "trailhead"
    : node.tags.amenity === "parking"
      ? "parking"
      : null;
  if (!kind) return null;
  return {
    id: `access-${node.id}`,
    externalId: node.id,
    nodeId: node.id,
    name: node.tags.name ?? `Access ${node.id}`,
    kind,
    accessState: osmAccess(node.tags),
    confidence: node.tags.access ? "medium" : "low",
    parkingEvidence: kind === "parking" ? "osm:amenity=parking" : null,
    sourceRefs: [sourceId],
  };
}

export async function prepareFixtureTopology(snapshot: SourceSnapshot): Promise<NormalizedTopology> {
  const input = topologySchema.parse(await readValidatedSnapshot(snapshot));
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  if (nodeById.size !== input.nodes.length) throw new Error("Topology contains duplicate node IDs");
  for (const way of input.ways) {
    for (const nodeId of way.nodeIds) {
      if (!nodeById.has(nodeId)) throw new Error(`Way ${way.id} references missing node ${nodeId}`);
    }
  }
  const acceptedWays = input.ways.filter((way) =>
    PEDESTRIAN_HIGHWAYS.has(way.tags.highway ?? "") && way.tags.foot !== "no",
  );
  return {
    nodes: input.nodes.map((node) => ({
      id: node.id,
      externalId: node.id,
      lon: node.lon,
      lat: node.lat,
      elevationM: null,
      flags: [],
      sourceRefs: [snapshot.id],
    })),
    ways: acceptedWays.map((way) => ({
      id: way.id,
      externalId: way.id,
      nodeIds: [...way.nodeIds],
      coordinates: way.nodeIds.map((nodeId) => {
        const node = nodeById.get(nodeId)!;
        return [node.lon, node.lat] as const;
      }),
      name: way.tags.name ?? null,
      accessState: osmAccess(way.tags),
      bidirectional: way.tags.oneway !== "yes" && way.tags["foot:backward"] !== "no",
      sourceRefs: [snapshot.id],
      flags: way.tags.oneway === "yes" ? ["oneway"] : [],
    })),
    accessPoints: input.nodes
      .map((node) => accessPointForNode(node, snapshot.id))
      .filter((point): point is NormalizedAccessPoint => point !== null),
    rejectedWayCount: input.ways.length - acceptedWays.length,
  };
}
