import { readFile } from "node:fs/promises";
import type { NormalizedNode, NormalizedPortalEvidence, NormalizedTopology, NormalizedWay } from "../types";
import { classifyOsmWay, osmAccessState, osmFootDirection, osmPortalEvidenceKinds } from "./normalize";

type OplNode = { id: string; lon: number; lat: number; tags: Record<string, string> };
type OplWay = { id: string; nodeIds: string[]; tags: Record<string, string> };

function decode(value: string): string {
  let result = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "%") {
      result += value[index];
      index += 1;
      continue;
    }
    const hex = value.slice(index + 1, index + 3);
    if (!/^[a-fA-F0-9]{2}$/.test(hex)) {
      if (value[index + 1] === "%") {
        // Osmium inserts a percent separator between adjacent escaped bytes,
        // for example `%2c%%20%Kennedy` for `, Kennedy`.
        index += 1;
        continue;
      }
      // OPL also prefixes a single syntax-sensitive character with `%`.
      // For example, `Black%20%Oak` represents `Black Oak`.
      result += value[index + 1] ?? "%";
      index += value[index + 1] === undefined ? 1 : 2;
      continue;
    }
    const first = Number.parseInt(hex, 16);
    const byteCount = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    const bytes: number[] = [];
    let valid = byteCount > 0;
    for (let byteIndex = 0; byteIndex < byteCount; byteIndex += 1) {
      const offset = index + byteIndex * 3;
      const pair = value.slice(offset + 1, offset + 3);
      if (value[offset] !== "%" || !/^[a-fA-F0-9]{2}$/.test(pair)) {
        valid = false;
        break;
      }
      const byte = Number.parseInt(pair, 16);
      if (byteIndex > 0 && (byte < 0x80 || byte > 0xbf)) valid = false;
      bytes.push(byte);
    }
    if (valid) {
      try {
        result += new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
        index += byteCount * 3;
        continue;
      } catch { /* Preserve a malformed encoded byte below. */ }
    }
    result += value[index + 1] ?? "%";
    index += value[index + 1] === undefined ? 1 : 2;
  }
  return result;
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
    const edgeClass = classifyOsmWay(way.tags);
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
      flags: [
        `osm-highway:${way.tags.highway}`,
        ...(direction === "both" ? [] : [direction === "reverse" ? "oneway-reversed" : "oneway"]),
        ...(way.tags.surface ? [`surface:${way.tags.surface}`] : []),
        ...(way.tags.sac_scale ? [`sac-scale:${way.tags.sac_scale}`] : []),
      ],
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

export async function readAndNormalizeOsmOpl(filePath: string, sourceId: string): Promise<NormalizedTopology> {
  const contents = await readFile(filePath, "utf8");
  if (!contents.trim()) throw new Error(`OSM OPL extraction is empty: ${filePath}`);
  return normalizeOsmOpl(contents, sourceId);
}
