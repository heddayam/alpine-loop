import { readFile } from "node:fs/promises";
import type { NormalizedAccessPoint, NormalizedNode, NormalizedTopology, NormalizedWay } from "../types";
import { osmAccessState, osmFootDirection } from "./normalize";

type OplNode = { id: string; lon: number; lat: number; tags: Record<string, string> };
type OplWay = { id: string; nodeIds: string[]; tags: Record<string, string> };

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new Error(`Invalid percent encoding in OPL value: ${value}`, { cause: error });
  }
}

function field(tokens: readonly string[], prefix: string): string | undefined {
  return tokens.find((token) => token.startsWith(prefix))?.slice(prefix.length);
}

function parseTags(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const result: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const equals = pair.indexOf("=");
    if (equals < 0) throw new Error(`Invalid OPL tag: ${pair}`);
    result[decode(pair.slice(0, equals))] = decode(pair.slice(equals + 1));
  }
  return result;
}

export function normalizeOsmOpl(contents: string, sourceId: string): NormalizedTopology {
  const nodes = new Map<string, OplNode>();
  const inputWays: OplWay[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(" ");
    const object = tokens[0];
    if (object.startsWith("n")) {
      const longitude = Number(field(tokens, "x"));
      const latitude = Number(field(tokens, "y"));
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        throw new Error(`OSM OPL node has invalid coordinates at line ${index + 1}`);
      }
      nodes.set(object.slice(1), { id: object.slice(1), lon: longitude, lat: latitude, tags: parseTags(field(tokens, "T")) });
    } else if (object.startsWith("w")) {
      const refs = field(tokens, "N")?.split(",").filter(Boolean).map((ref) => ref.replace(/^n/, "")) ?? [];
      if (refs.length < 2) throw new Error(`OSM OPL way has fewer than two nodes at line ${index + 1}`);
      inputWays.push({ id: object.slice(1), nodeIds: refs, tags: parseTags(field(tokens, "T")) });
    }
  }

  const acceptedHighways = new Set([
    "path", "footway", "track", "pedestrian", "steps", "bridleway",
    "service", "unclassified", "residential", "living_street",
  ]);
  const retainedNodes = new Map<string, NormalizedNode>();
  const retainNode = (id: string): NormalizedNode => {
    const existing = retainedNodes.get(id);
    if (existing) return existing;
    const input = nodes.get(id);
    if (!input) throw new Error(`OSM way references missing node ${id}`);
    const normalized: NormalizedNode = {
      id: `osm-node-${id}`,
      externalId: `node/${id}`,
      lon: input.lon,
      lat: input.lat,
      elevationM: null,
      flags: [],
      sourceRefs: [sourceId],
    };
    retainedNodes.set(id, normalized);
    return normalized;
  };
  const ways: NormalizedWay[] = [];
  let rejectedWayCount = 0;
  for (const way of inputWays) {
    if (!acceptedHighways.has(way.tags.highway ?? "")) {
      rejectedWayCount += 1;
      continue;
    }
    const nodeIds = [...way.nodeIds];
    const direction = osmFootDirection(way.tags);
    if (direction === "reverse") nodeIds.reverse();
    const wayNodes = nodeIds.map(retainNode);
    ways.push({
      id: `osm-way-${way.id}`,
      externalId: `way/${way.id}`,
      nodeIds: wayNodes.map(({ id }) => id),
      coordinates: wayNodes.map(({ lon, lat }) => [lon, lat] as const),
      name: way.tags.name ?? null,
      accessState: osmAccessState(way.tags),
      bidirectional: direction === "both",
      sourceRefs: [sourceId],
      flags: [
        `osm-highway:${way.tags.highway}`,
        ...(direction === "both" ? [] : [direction === "reverse" ? "oneway-reversed" : "oneway"]),
        ...(way.tags.surface ? [`surface:${way.tags.surface}`] : []),
        ...(way.tags.sac_scale ? [`sac-scale:${way.tags.sac_scale}`] : []),
      ],
    });
  }
  if (ways.length === 0) throw new Error("OSM extraction produced no supported pedestrian ways");

  const accessPoints: NormalizedAccessPoint[] = [];
  for (const node of nodes.values()) {
    const kind = node.tags.highway === "trailhead" ? "trailhead" : node.tags.amenity === "parking" ? "parking" : null;
    if (!kind) continue;
    const normalizedNode = retainNode(node.id);
    accessPoints.push({
      id: `osm-access-node-${node.id}`,
      externalId: `node/${node.id}`,
      nodeId: normalizedNode.id,
      name: node.tags.name ?? `OSM ${kind}`,
      kind,
      accessState: osmAccessState(node.tags),
      confidence: node.tags.foot || node.tags.access ? "medium" : "low",
      parkingEvidence: kind === "parking" ? "osm:amenity=parking" : null,
      sourceRefs: [sourceId],
    });
  }
  return { nodes: [...retainedNodes.values()], ways, accessPoints, rejectedWayCount };
}

export async function readAndNormalizeOsmOpl(filePath: string, sourceId: string): Promise<NormalizedTopology> {
  const contents = await readFile(filePath, "utf8");
  if (!contents.trim()) throw new Error(`OSM OPL extraction is empty: ${filePath}`);
  return normalizeOsmOpl(contents, sourceId);
}
