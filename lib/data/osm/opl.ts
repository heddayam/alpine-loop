import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { NormalizedNode, NormalizedPortalEvidence, NormalizedTopology, NormalizedWay } from "../types";
import {
  classifyOsmWay,
  contextualTrailWayIds,
  osmAccessState,
  osmFootDirection,
  osmPortalEvidenceKinds,
  osmWayFlags,
} from "./normalize";

type OplNode = { id: string; lon: number; lat: number; tags: Record<string, string> };
type OplWay = { id: string; nodeIds: string[]; tags: Record<string, string> };

/** OPL escapes delimit a Unicode code point, not a URL-encoded UTF-8 byte. */
function decode(value: string): string {
  return value.replace(/%([^%]*)%|%/g, (escape: string, hex: string | undefined) => {
    if (!hex || !/^[a-fA-F0-9]{1,6}$/.test(hex)) throw new Error(`Invalid OPL escape: ${escape}`);
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
      throw new Error(`Invalid OPL Unicode code point: ${escape}`);
    return String.fromCodePoint(codePoint);
  });
}

function field(tokens: readonly string[], prefix: string): string | undefined {
  return tokens.find((token) => token.startsWith(prefix))?.slice(prefix.length);
}

export function parseOplTags(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const result: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const equals = pair.indexOf("=");
    if (equals < 0) throw new Error(`Invalid OPL tag: ${pair}`);
    result[decode(pair.slice(0, equals))] = decode(pair.slice(equals + 1));
  }
  return result;
}

function parseOplLine(nodes: Map<string, OplNode>, inputWays: OplWay[], rawLine: string, index: number): void {
  const line = rawLine.trim();
  if (!line) return;
  const tokens = line.split(" ");
  const object = tokens[0];
  if (object.startsWith("n")) {
    const longitude = Number(field(tokens, "x"));
    const latitude = Number(field(tokens, "y"));
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error(`OSM OPL node has invalid coordinates at line ${index + 1}`);
    }
    nodes.set(object.slice(1), { id: object.slice(1), lon: longitude, lat: latitude, tags: parseOplTags(field(tokens, "T")) });
  } else if (object.startsWith("w")) {
    const refs = field(tokens, "N")?.split(",").filter(Boolean).map((ref) => ref.replace(/^n/, "")) ?? [];
    if (refs.length < 2) throw new Error(`OSM OPL way has fewer than two nodes at line ${index + 1}`);
    inputWays.push({ id: object.slice(1), nodeIds: refs, tags: parseOplTags(field(tokens, "T")) });
  }
}

function normalizeOsmRecords(nodes: Map<string, OplNode>, inputWays: OplWay[], sourceId: string): NormalizedTopology {
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
  const contextualTrails = contextualTrailWayIds(inputWays.map((way) => ({
    id: way.id,
    nodeIds: way.nodeIds,
    values: way.tags,
  })));
  for (const way of inputWays) {
    const edgeClass = contextualTrails.has(way.id) ? "trail" : classifyOsmWay(way.tags);
    if (!edgeClass) {
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
      edgeClass,
      sourceRefs: [sourceId],
      flags: osmWayFlags(way.tags, `way/${way.id}`, direction),
    });
  }
  if (ways.length === 0) throw new Error("OSM extraction produced no supported ways");

  const portalEvidence: NormalizedPortalEvidence[] = [];
  for (const node of nodes.values()) {
    const kinds = osmPortalEvidenceKinds(node.tags);
    if (kinds.length === 0) continue;
    const normalizedNode = retainNode(node.id);
    for (const kind of kinds) {
      portalEvidence.push({
        id: `osm-evidence-${kind}-node-${node.id}`,
        externalId: `node/${node.id}`,
        kind,
        name: node.tags.name ?? null,
        nodeIds: [normalizedNode.id],
        coordinates: [[normalizedNode.lon, normalizedNode.lat]],
        accessState: osmAccessState(node.tags),
        sourceRefs: [sourceId],
      });
    }
  }
  for (const way of inputWays) {
    const kinds = osmPortalEvidenceKinds(way.tags);
    if (kinds.length === 0) continue;
    const wayNodes = way.nodeIds.map(retainNode);
    for (const kind of kinds) {
      portalEvidence.push({
        id: `osm-evidence-${kind}-way-${way.id}`,
        externalId: `way/${way.id}`,
        kind,
        name: way.tags.name ?? null,
        nodeIds: wayNodes.map(({ id }) => id),
        coordinates: wayNodes.map(({ lon, lat }) => [lon, lat] as const),
        accessState: osmAccessState(way.tags),
        sourceRefs: [sourceId],
      });
    }
  }
  return { nodes: [...retainedNodes.values()], ways, accessPoints: [], portalEvidence, rejectedWayCount };
}

export function normalizeOsmOpl(contents: string, sourceId: string): NormalizedTopology {
  const nodes = new Map<string, OplNode>();
  const inputWays: OplWay[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) parseOplLine(nodes, inputWays, line, index);
  return normalizeOsmRecords(nodes, inputWays, sourceId);
}

export async function readAndNormalizeOsmOpl(filePath: string, sourceId: string): Promise<NormalizedTopology> {
  const nodes = new Map<string, OplNode>();
  const inputWays: OplWay[] = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  let nonempty = false;
  try {
    for await (const line of lines) {
      if (line.trim()) nonempty = true;
      parseOplLine(nodes, inputWays, line, index++);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!nonempty) throw new Error(`OSM OPL extraction is empty: ${filePath}`);
  return normalizeOsmRecords(nodes, inputWays, sourceId);
}
