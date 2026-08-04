import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createOSMStream } from "osm-pbf-parser-node";

export const HIKING_HIGHWAYS = Object.freeze([
  "path",
  "footway",
  "steps",
  "bridleway",
]);

const HIKING_HIGHWAY_SET = new Set(HIKING_HIGHWAYS);
const POSITIVE_FOOT_VALUES = new Set(["yes", "designated", "permissive", "official"]);
const PUBLIC_ACCESS_VALUES = new Set(["yes", "designated", "permissive", "public"]);
const BLOCKED_VALUES = new Set(["no", "private"]);
const HIKING_ROUTE_VALUES = new Set(["hiking", "foot"]);
const RESTRICTED_WAY_POLICIES = new Set(["exclude", "mark"]);
const PUBLIC_ROAD_HIGHWAYS = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
  "residential", "living_street",
]);
const CONDITIONAL_PUBLIC_ROAD_HIGHWAYS = new Set(["service", "track"]);

function requireRestrictedWayPolicy(value) {
  if (!RESTRICTED_WAY_POLICIES.has(value)) {
    throw new TypeError("restrictedWayPolicy must be \"exclude\" or \"mark\"");
  }
  return value;
}

function compareOsmIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const difference = BigInt(a) - BigInt(b);
    if (difference < 0n) return -1;
    if (difference > 0n) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

function normalizeId(value, path) {
  if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
      !String(value).trim()) {
    throw new TypeError(`${path} must be a non-empty OSM identifier`);
  }
  return String(value);
}

function normalizeTagValue(value) {
  return String(value).normalize("NFKC").trim();
}

function normalizedToken(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeTagValue(value).toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeOsmTags(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("OSM tags must be an object");
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, tagValue]) => tagValue !== undefined && tagValue !== null)
      .map(([key, tagValue]) => [normalizeTagValue(key), normalizeTagValue(tagValue)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function normalizeOsmSurface(value) {
  return normalizedToken(value);
}

export function normalizeSacScale(value) {
  return normalizedToken(value);
}

export function normalizeTrailVisibility(value) {
  return normalizedToken(value);
}

function lifecycleBlocked(tags) {
  const highway = normalizedToken(tags.highway);
  const status = normalizedToken(tags.status);
  const construction = normalizedToken(tags.construction);
  const proposed = normalizedToken(tags.proposed);
  return highway === "construction" || highway === "proposed" ||
    (construction !== undefined && construction !== "no") ||
    (proposed !== undefined && proposed !== "no") ||
    status === "construction" || status === "proposed" || status === "planned" ||
    tags["construction:highway"] !== undefined || tags["proposed:highway"] !== undefined;
}

function explicitRestriction(tags) {
  const access = normalizedToken(tags.access);
  const foot = normalizedToken(tags.foot);
  return BLOCKED_VALUES.has(access) || BLOCKED_VALUES.has(foot);
}

function explicitClosure(tags) {
  const status = normalizedToken(tags.status);
  const disusedHighway = normalizedToken(tags["disused:highway"]);
  return status === "closed" || normalizedToken(tags.closed) === "yes" ||
    normalizedToken(tags.disused) === "yes" ||
    (disusedHighway !== undefined && disusedHighway !== "no");
}

function explicitlyPublic(tags) {
  return PUBLIC_ACCESS_VALUES.has(normalizedToken(tags.access));
}

function isPublicRoadWay(way) {
  if (!way || way.type !== "way") return false;
  const tags = normalizeOsmTags(way.tags);
  const highway = normalizedToken(tags.highway);
  const access = normalizedToken(tags.access);
  const motorVehicle = normalizedToken(tags.motor_vehicle ?? tags.motorcar ?? tags.vehicle);
  if (BLOCKED_VALUES.has(access) || BLOCKED_VALUES.has(motorVehicle) || lifecycleBlocked(tags)) {
    return false;
  }
  return PUBLIC_ROAD_HIGHWAYS.has(highway) ||
    (CONDITIONAL_PUBLIC_ROAD_HIGHWAYS.has(highway) && explicitlyPublic(tags));
}

function accessCandidateType(tags) {
  if (normalizedToken(tags.highway) === "trailhead" ||
      normalizedToken(tags.information) === "trailhead") return "trailhead";
  if ((normalizedToken(tags.entrance) === "yes" || normalizedToken(tags.barrier) === "entrance") &&
      explicitlyPublic(tags)) return "entrance";
  if (normalizedToken(tags.amenity) === "parking" && explicitlyPublic(tags)) return "parking";
  return undefined;
}

/** Shared by the explicit regional preparation workflow without widening build-time I/O. */
export function osmAccessCandidateType(tags) {
  return accessCandidateType(normalizeOsmTags(tags));
}

/** Identify explicit public-road evidence while preparing a bounded OSM extract. */
export function isOsmPublicRoadWay(way) {
  return isPublicRoadWay(way);
}

export function classifyOsmWay(tagsValue, { hikingRouteMemberships = [] } = {}) {
  const tags = normalizeOsmTags(tagsValue);
  const accessTag = normalizedToken(tags.access);
  const footTag = normalizedToken(tags.foot);
  const isBlocked = explicitRestriction(tags) || explicitClosure(tags);
  const isOnHikingRoute = hikingRouteMemberships.length > 0;

  let hiking = "unknown";
  if (isBlocked) hiking = "blocked";
  else if (POSITIVE_FOOT_VALUES.has(footTag) || isOnHikingRoute) hiking = "allowed";

  let access = "unknown";
  if (accessTag === "private") access = "private";
  else if (PUBLIC_ACCESS_VALUES.has(accessTag) || POSITIVE_FOOT_VALUES.has(footTag)) {
    access = "public";
  }

  let status = "unknown";
  const statusTag = normalizedToken(tags.status);
  if (isBlocked || statusTag === "closed") status = "closed";
  else if (normalizedToken(tags.seasonal) === "yes" || statusTag === "seasonal" || tags["access:conditional"]) {
    status = "seasonal";
  } else if (statusTag === "open") {
    status = "open";
  }

  return { hiking, access, status };
}

export function isHikingRelevantWay(way, { restrictedWayPolicy = "exclude" } = {}) {
  if (!way || way.type !== "way") return false;
  requireRestrictedWayPolicy(restrictedWayPolicy);
  const tags = normalizeOsmTags(way.tags);
  if (lifecycleBlocked(tags) || !HIKING_HIGHWAY_SET.has(normalizedToken(tags.highway))) return false;
  return restrictedWayPolicy === "mark" || !(explicitRestriction(tags) || explicitClosure(tags));
}

function normalizeSourceUpdatedAt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return undefined;
  return date.toISOString();
}

function normalizeRelationMember(member, index) {
  const type = normalizeTagValue(member?.type ?? "").toLowerCase();
  if (!["node", "way", "relation"].includes(type)) {
    throw new TypeError(`relation member ${index} has an invalid type`);
  }
  return {
    type,
    id: normalizeId(member.id ?? member.ref, `relation member ${index}.id`),
    role: normalizeTagValue(member.role ?? ""),
  };
}

function normalizeRelation(relation) {
  const tags = normalizeOsmTags(relation.tags);
  return {
    id: normalizeId(relation.id, "relation.id"),
    tags,
    members: (relation.members ?? []).map(normalizeRelationMember),
  };
}

function hikingRouteDetails(relation) {
  return {
    id: relation.id,
    ...(relation.tags.name ? { name: relation.tags.name } : {}),
    ...(relation.tags.network ? { network: relation.tags.network } : {}),
    ...(relation.tags.ref ? { ref: relation.tags.ref } : {}),
    ...(relation.tags.operator ? { operator: relation.tags.operator } : {}),
  };
}

function isHikingRouteRelation(relation) {
  return normalizedToken(relation.tags.type) === "route" &&
    HIKING_ROUTE_VALUES.has(normalizedToken(relation.tags.route));
}

function wayNodeIds(way) {
  const values = way.nodes ?? way.refs ?? way.nodeIds;
  if (!Array.isArray(values)) throw new TypeError(`way/${way.id} must have an ordered node list`);
  return values.map((value, index) => normalizeId(value, `way/${way.id}.nodes[${index}]`));
}

function normalizeNode(node) {
  const longitude = Number(node.lon ?? node.longitude);
  const latitude = Number(node.lat ?? node.latitude);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new TypeError(`node/${node.id} has an invalid longitude`);
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new TypeError(`node/${node.id} has an invalid latitude`);
  }
  return {
    id: normalizeId(node.id, "node.id"),
    longitude,
    latitude,
    tags: normalizeOsmTags(node.tags),
  };
}

function tagProvenance(tags, tag) {
  return tags[tag] === undefined ? undefined : { tag, rawValue: tags[tag] };
}

function fieldProvenance(tags, hikingRouteMemberships) {
  const hiking = tagProvenance(tags, "foot") ?? tagProvenance(tags, "access") ??
    (hikingRouteMemberships.length
      ? { relationIds: hikingRouteMemberships.map(({ id }) => id) }
      : undefined);
  return Object.fromEntries(Object.entries({
    name: tagProvenance(tags, "name"),
    surface: tagProvenance(tags, "surface"),
    sacScale: tagProvenance(tags, "sac_scale"),
    visibility: tagProvenance(tags, "trail_visibility"),
    hiking,
    access: tagProvenance(tags, "access") ?? tagProvenance(tags, "foot"),
    status: tagProvenance(tags, "status") ?? tagProvenance(tags, "seasonal") ??
      tagProvenance(tags, "access:conditional") ?? tagProvenance(tags, "access") ??
      tagProvenance(tags, "foot"),
  }).filter(([, provenance]) => provenance !== undefined));
}

function prepareElements(elements, { restrictedWayPolicy }) {
  const relations = elements
    .filter((element) => element?.type === "relation")
    .map(normalizeRelation)
    .filter(isHikingRouteRelation)
    .sort((left, right) => compareOsmIds(left.id, right.id));
  const membershipsByWay = new Map();
  for (const relation of relations) {
    const details = hikingRouteDetails(relation);
    for (const member of relation.members) {
      if (member.type !== "way") continue;
      const memberships = membershipsByWay.get(member.id) ?? [];
      memberships.push({ ...details, role: member.role });
      membershipsByWay.set(member.id, memberships);
    }
  }

  const ways = elements
    .filter((element) => element?.type === "way")
    .filter((way) => isHikingRelevantWay(way, { restrictedWayPolicy }))
    .map((way) => {
      const id = normalizeId(way.id, "way.id");
      const tags = normalizeOsmTags(way.tags);
      const hikingRouteMemberships = (membershipsByWay.get(id) ?? [])
        .sort((left, right) => compareOsmIds(left.id, right.id));
      const sourceUpdatedAt = normalizeSourceUpdatedAt(way.info?.timestamp);
      const surface = normalizeOsmSurface(tags.surface);
      const sacScale = normalizeSacScale(tags.sac_scale);
      const visibility = normalizeTrailVisibility(tags.trail_visibility);
      return {
        id,
        nodeIds: wayNodeIds(way),
        tags,
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
        ...(tags.name ? { name: tags.name } : {}),
        ...(surface ? { surface } : {}),
        ...(sacScale ? { sacScale } : {}),
        ...(visibility ? { visibility } : {}),
        hikingRouteMemberships,
        fieldProvenance: fieldProvenance(tags, hikingRouteMemberships),
        ...classifyOsmWay(tags, { hikingRouteMemberships }),
      };
    })
    .sort((left, right) => compareOsmIds(left.id, right.id));

  const referencedNodeIds = new Set();
  ways.forEach((way) => way.nodeIds.forEach((nodeId) => referencedNodeIds.add(nodeId)));
  const allNodes = elements
    .filter((element) => element?.type === "node")
    .map(normalizeNode)
    .sort((left, right) => compareOsmIds(left.id, right.id));
  const nodes = allNodes.filter((node) => referencedNodeIds.has(node.id));
  const accessNodes = allNodes.filter((node) => accessCandidateType(node.tags));
  const publicRoadNodeIds = new Set();
  elements.filter(isPublicRoadWay).forEach((way) => {
    wayNodeIds(way).forEach((nodeId) => {
      if (referencedNodeIds.has(nodeId)) publicRoadNodeIds.add(nodeId);
    });
  });

  return {
    nodes,
    ways,
    relations,
    accessNodes,
    publicRoadNodeIds: [...publicRoadNodeIds].sort(compareOsmIds),
  };
}

function elementsFromJson(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.elements)) return payload.elements;
  if (payload && [payload.nodes, payload.ways, payload.relations].some(Array.isArray)) {
    return [
      ...(payload.nodes ?? []).map((element) => ({ type: "node", ...element })),
      ...(payload.ways ?? []).map((element) => ({ type: "way", ...element })),
      ...(payload.relations ?? []).map((element) => ({ type: "relation", ...element })),
    ];
  }
  throw new TypeError("OSM JSON must contain an elements array or nodes/ways/relations arrays");
}

async function readJsonElements(filePath) {
  const text = await readFile(filePath, "utf8");
  try {
    const payload = JSON.parse(text);
    return { elements: elementsFromJson(payload), retrievedAt: payload?.retrievedAt };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const elements = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    return { elements };
  }
}

async function forEachPbfElement(filePath, parserOptions, visit) {
  for await (const element of createOSMStream(filePath, parserOptions)) visit(element);
}

async function readPbfElements(filePath, options) {
  const candidateWays = [];
  const publicRoadWays = [];
  const relations = [];
  await forEachPbfElement(filePath, {
    withInfo: true,
    withTags: {
      node: false,
      way: true,
      relation: ["type", "route", "name", "network", "ref", "operator"],
    },
  }, (element) => {
    if (element.type === "relation" &&
        normalizedToken(element.tags?.type) === "route" &&
        HIKING_ROUTE_VALUES.has(normalizedToken(element.tags?.route))) relations.push(element);
    else if (element.type === "way" && isHikingRelevantWay(element, options)) candidateWays.push(element);
    else if (element.type === "way" && isPublicRoadWay(element)) publicRoadWays.push(element);
  });

  const referencedNodeIds = new Set();
  candidateWays.forEach((way) => wayNodeIds(way).forEach((nodeId) => referencedNodeIds.add(nodeId)));
  publicRoadWays.forEach((way) => wayNodeIds(way).forEach((nodeId) => referencedNodeIds.add(nodeId)));
  const nodes = [];
  await forEachPbfElement(filePath, {
    withTags: {
      node: ["highway", "information", "entrance", "barrier", "amenity", "access", "foot", "name"],
      way: false,
      relation: false,
    },
    withInfo: false,
  }, (element) => {
    if (element.type !== "node") return;
    if (referencedNodeIds.has(String(element.id)) || accessCandidateType(normalizeOsmTags(element.tags))) {
      nodes.push(element);
    }
  });
  return [...nodes, ...candidateWays, ...publicRoadWays, ...relations];
}

function sourceRefForElement(type, id, retrievedAt) {
  return {
    provider: "osm",
    sourceId: `${type}/${id}`,
    retrievedAt,
    sourceUrl: `https://www.openstreetmap.org/${type}/${id}`,
  };
}

function accessCandidate(node, retrievedAt) {
  const type = accessCandidateType(node.tags);
  return {
    longitude: node.longitude,
    latitude: node.latitude,
    ...(node.tags.name ? { name: node.tags.name } : {}),
    type,
    confidence: "mapped",
    osmNodeId: node.id,
    tags: { ...node.tags },
    sourceRefs: [sourceRefForElement("node", node.id, retrievedAt)],
  };
}

/**
 * Read an offline OSM snapshot. JSON/NDJSON is intended for fixtures; `.pbf`
 * and `.osm.pbf` inputs are streamed in two passes so unrelated California
 * nodes do not have to remain in memory.
 */
export async function readOsmSnapshot(filePath, options = {}) {
  const sourcePath = filePath instanceof URL ? fileURLToPath(filePath) : filePath;
  if (typeof sourcePath !== "string" || !sourcePath) throw new TypeError("filePath is required");
  const restrictedWayPolicy = requireRestrictedWayPolicy(options.restrictedWayPolicy ?? "exclude");
  const isPbf = extname(sourcePath).toLowerCase() === ".pbf";
  let elements;
  let embeddedRetrievedAt;
  if (isPbf) {
    elements = await readPbfElements(sourcePath, { restrictedWayPolicy });
  } else {
    ({ elements, retrievedAt: embeddedRetrievedAt } = await readJsonElements(sourcePath));
  }
  const fileStats = await stat(sourcePath);
  const retrievedAt = options.retrievedAt ?? embeddedRetrievedAt ?? fileStats.mtime.toISOString();
  if (Number.isNaN(Date.parse(retrievedAt))) throw new TypeError("retrievedAt must be a valid timestamp");
  const prepared = prepareElements(elements, { restrictedWayPolicy });
  return {
    format: "osm",
    retrievedAt: new Date(retrievedAt).toISOString(),
    sourcePath,
    nodes: prepared.nodes,
    ways: prepared.ways,
    relations: prepared.relations,
    accessPointCandidates: prepared.accessNodes.map((node) =>
      accessCandidate(node, new Date(retrievedAt).toISOString())),
    publicRoadSourceNodeIds: prepared.publicRoadNodeIds.map((id) => `osm:${id}`),
  };
}

export const loadOsmSnapshot = readOsmSnapshot;
