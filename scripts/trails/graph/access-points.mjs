import {
  createAccessPointId,
  validateAccessPoint,
  validateSourceRef,
  validateTrailNode,
  validateTrailSegment,
} from "../model.mjs";
import { geodesicDistanceMeters } from "../spatial/length.mjs";
import { findSnapCandidate } from "../spatial/snap.mjs";

export const DEFAULT_ACCESS_POINT_OPTIONS = Object.freeze({
  trailheadSnapMeters: 75,
  walkingDistanceMeters: 200,
  derivedSnapMeters: 25,
  duplicateDistanceMeters: 30,
  ambiguityToleranceMeters: 0.001,
});

const PUBLIC_VALUES = new Set(["public", "yes", "designated", "permissive"]);
const PRIVATE_VALUES = new Set(["private", "no"]);
const OFFICIAL_PROVIDERS = new Set(["usgs", "usfs", "nps", "state_parks", "ebrpd"]);

function text(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).normalize("NFKC").trim();
  return normalized || undefined;
}

function token(value) {
  return text(value)?.toLowerCase().replace(/[\s-]+/g, "_");
}

function candidateTags(candidate) {
  const tags = candidate.tags ?? candidate.properties?.tags ?? candidate.properties ?? {};
  return tags && typeof tags === "object" && !Array.isArray(tags) ? tags : {};
}

function coordinate(candidate, path) {
  const value = Array.isArray(candidate.coordinate)
    ? candidate.coordinate
    : Array.isArray(candidate.coordinates)
      ? candidate.coordinates
      : candidate.geometry?.type === "Point"
        ? candidate.geometry.coordinates
        : [candidate.longitude, candidate.latitude];
  if (
    !Array.isArray(value) || value.length < 2 ||
    !Number.isFinite(value[0]) || value[0] < -180 || value[0] > 180 ||
    !Number.isFinite(value[1]) || value[1] < -90 || value[1] > 90
  ) {
    throw new TypeError(`${path} must have valid longitude and latitude`);
  }
  return [value[0], value[1]];
}

function sourceRefs(candidate, path) {
  const refs = candidate.sourceRefs ?? (candidate.sourceRef ? [candidate.sourceRef] : undefined);
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new TypeError(`${path}.sourceRefs must contain at least one source reference`);
  }
  refs.forEach((sourceRef, index) => validateSourceRef(sourceRef, `${path}.sourceRefs[${index}]`));
  return refs.map((sourceRef) => ({ ...sourceRef }));
}

function explicitAccess(candidate) {
  const tags = candidateTags(candidate);
  return token(
    candidate.landAccess ?? candidate.access ?? candidate.properties?.landAccess ??
      candidate.properties?.access ?? tags.access,
  );
}

function explicitlyPrivate(candidate) {
  const tags = candidateTags(candidate);
  return candidate.onPrivateLand === true || candidate.privateLand === true ||
    candidate.properties?.onPrivateLand === true || candidate.properties?.privateLand === true ||
    PRIVATE_VALUES.has(explicitAccess(candidate)) ||
    PRIVATE_VALUES.has(token(tags.foot));
}

function explicitlyPublic(candidate) {
  return candidate.publicAccess === true || candidate.properties?.publicAccess === true ||
    PUBLIC_VALUES.has(explicitAccess(candidate));
}

function providerIsOsm(refs) {
  return refs.some(({ provider }) => token(provider) === "osm" || token(provider) === "openstreetmap");
}

function candidateClass(candidate, refs) {
  const tags = candidateTags(candidate);
  const directType = token(candidate.type) === "feature" ? undefined : candidate.type;
  const type = token(directType ?? candidate.kind ?? candidate.featureType ??
    candidate.recordType ?? candidate.properties?.type ?? candidate.properties?.recordType);
  const confidence = token(candidate.confidence ?? candidate.authority ??
    candidate.properties?.confidence ?? candidate.properties?.authority);
  const official = candidate.official === true || candidate.properties?.official === true ||
    confidence === "official" || refs.some(({ provider }) => OFFICIAL_PROVIDERS.has(token(provider)));
  const trailhead = type === "trailhead" || token(tags.highway) === "trailhead" ||
    token(tags.information) === "trailhead";
  const entrance = type === "entrance" || token(tags.entrance) === "yes" ||
    token(tags.barrier) === "entrance";
  const parking = type === "parking" || token(tags.amenity) === "parking";
  const derived = type === "derived" || confidence === "derived";

  if (official && (trailhead || entrance)) {
    return { priority: 1, type: trailhead ? "trailhead" : "entrance", confidence: "official" };
  }
  if (trailhead && (providerIsOsm(refs) || confidence === "mapped")) {
    return { priority: 2, type: "trailhead", confidence: "mapped" };
  }
  if ((parking || entrance) && explicitlyPublic(candidate)) {
    return { priority: 3, type: parking ? "parking" : "entrance", confidence: "mapped" };
  }
  if (derived && (candidate.publicRoad === true || candidate.publicNetwork === true ||
      candidate.properties?.publicRoad === true || candidate.properties?.publicNetwork === true ||
      candidate.publicRoadNodeId !== undefined || candidate.properties?.publicRoadNodeId !== undefined)) {
    return { priority: 4, type: "derived", confidence: "derived" };
  }
  return undefined;
}

function normalizeCandidate(candidate, index) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`candidates[${index}] must be an object`);
  }
  const refs = sourceRefs(candidate, `candidates[${index}]`);
  const position = coordinate(candidate, `candidates[${index}]`);
  const classification = candidateClass(candidate, refs);
  const osmSourceNodeIds = refs.flatMap(({ provider, sourceId }) => {
    const match = providerIsOsm([{ provider }]) && /^node\/(.+)$/i.exec(sourceId);
    return match ? [`osm:${match[1]}`] : [];
  });
  return {
    key: createAccessPointId(refs, { longitude: position[0], latitude: position[1] }),
    longitude: position[0],
    latitude: position[1],
    ...(text(candidate.name ?? candidate.properties?.name) ? {
      name: text(candidate.name ?? candidate.properties?.name),
    } : {}),
    sourceRefs: refs,
    requestedNodeIds: [
      ...(Array.isArray(candidate.connectedNodeIds) ? candidate.connectedNodeIds :
        Array.isArray(candidate.properties?.connectedNodeIds)
          ? candidate.properties.connectedNodeIds
          : []),
      ...(candidate.nodeId !== undefined ? [candidate.nodeId] :
        candidate.properties?.nodeId !== undefined ? [candidate.properties.nodeId] : []),
      ...(candidate.publicRoadNodeId !== undefined ? [candidate.publicRoadNodeId] :
        candidate.properties?.publicRoadNodeId !== undefined
          ? [candidate.properties.publicRoadNodeId]
          : []),
    ].map(String),
    sourceNodeIds: [
      ...(Array.isArray(candidate.sourceNodeIds) ? candidate.sourceNodeIds : []),
      ...(candidate.sourceNodeId !== undefined ? [candidate.sourceNodeId] : []),
      ...(candidate.osmNodeId !== undefined ? [`osm:${candidate.osmNodeId}`] : []),
      ...osmSourceNodeIds,
    ].map(String),
    private: explicitlyPrivate(candidate),
    classification,
  };
}

function compareCandidate(left, right) {
  return (left.classification?.priority ?? Infinity) -
    (right.classification?.priority ?? Infinity) || left.key.localeCompare(right.key);
}

function validateOptions(options) {
  const merged = { ...DEFAULT_ACCESS_POINT_OPTIONS, ...options };
  for (const name of Object.keys(DEFAULT_ACCESS_POINT_OPTIONS)) {
    if (!Number.isFinite(merged[name]) || merged[name] < 0) {
      throw new TypeError(`${name} must be a non-negative finite number`);
    }
  }
  return merged;
}

function usableNodeIds(nodes, segments) {
  if (segments.length === 0) return new Set(nodes.map(({ id }) => id));
  const usableSegments = new Set(segments
    .filter((segment) => segment.access !== "private" && segment.hiking !== "blocked" &&
      segment.status !== "closed")
    .map(({ id }) => id));
  return new Set(nodes
    .filter((node) => node.incidentSegmentIds.some((id) => usableSegments.has(id)))
    .map(({ id }) => id));
}

function directConnections(candidate, nodesById, nodesBySourceId, usableIds) {
  const direct = new Set();
  for (const id of candidate.requestedNodeIds) {
    if (nodesById.has(id) && usableIds.has(id)) direct.add(id);
  }
  for (const sourceId of candidate.sourceNodeIds) {
    for (const id of nodesBySourceId.get(sourceId) ?? []) {
      if (usableIds.has(id)) direct.add(id);
    }
  }
  return [...direct].sort();
}

function connectionDistance(classification, options) {
  if (classification.priority <= 2) return options.trailheadSnapMeters;
  if (classification.priority === 3) return options.walkingDistanceMeters;
  return options.derivedSnapMeters;
}

function connectCandidate(candidate, graphNodes, indexes, options) {
  const direct = directConnections(
    candidate,
    indexes.nodesById,
    indexes.nodesBySourceId,
    indexes.usableNodeIds,
  );
  if (direct.length > 0) return { status: "connected", nodeIds: direct };

  const snap = findSnapCandidate(
    [candidate.longitude, candidate.latitude],
    graphNodes.filter(({ id }) => indexes.usableNodeIds.has(id)),
    {
      toleranceMeters: connectionDistance(candidate.classification, options),
      ambiguityToleranceMeters: options.ambiguityToleranceMeters,
    },
  );
  if (snap.status === "snapped") return { status: "connected", nodeIds: [snap.candidateId] };
  return snap;
}

function refIdentity(ref) {
  return `${token(ref.provider)}:${text(ref.sourceId)?.toLowerCase()}`;
}

function mergeSourceRefs(groups) {
  const byIdentity = new Map();
  for (const group of groups) {
    for (const ref of group.sourceRefs) {
      const identity = refIdentity(ref);
      const current = byIdentity.get(identity);
      if (!current || JSON.stringify(ref) < JSON.stringify(current)) byIdentity.set(identity, ref);
    }
  }
  return [...byIdentity.values()].sort((left, right) => refIdentity(left).localeCompare(refIdentity(right)));
}

function areDuplicates(left, right, distanceMeters) {
  if (!left.connectedNodeIds.some((id) => right.connectedNodeIds.includes(id))) return false;
  return geodesicDistanceMeters(
    [left.longitude, left.latitude],
    [right.longitude, right.latitude],
  ) <= distanceMeters;
}

function mergeCandidates(candidates, duplicateDistanceMeters) {
  const groups = [];
  for (const candidate of [...candidates].sort(compareCandidate)) {
    const matching = groups.filter((group) =>
      group.members.some((member) => areDuplicates(member, candidate, duplicateDistanceMeters)));
    if (matching.length === 0) {
      groups.push({ members: [candidate] });
      continue;
    }
    const primary = matching[0];
    primary.members.push(candidate);
    for (const extra of matching.slice(1)) {
      primary.members.push(...extra.members);
      groups.splice(groups.indexOf(extra), 1);
    }
  }

  return groups.map(({ members }) => {
    members.sort(compareCandidate);
    const winner = members[0];
    const refs = mergeSourceRefs(members);
    const point = {
      id: createAccessPointId(refs, {
        longitude: winner.longitude,
        latitude: winner.latitude,
      }),
      longitude: winner.longitude,
      latitude: winner.latitude,
      ...(members.find(({ name }) => name)?.name ? {
        name: members.find(({ name }) => name).name,
      } : {}),
      type: winner.classification.type,
      confidence: winner.classification.confidence,
      connectedNodeIds: [...new Set(members.flatMap(({ connectedNodeIds }) =>
        connectedNodeIds))].sort(),
      sourceRefs: refs,
    };
    validateAccessPoint(point);
    return point;
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function derivedCandidate(node, sourceRefsValue) {
  return {
    longitude: node.longitude,
    latitude: node.latitude,
    type: "derived",
    confidence: "derived",
    publicRoad: true,
    connectedNodeIds: [node.id],
    sourceRefs: sourceRefsValue,
  };
}

function derivedCandidates(publicRoadNodeIds, nodesById, segmentsById) {
  return [...new Set(publicRoadNodeIds.map(String))].sort().flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    if (!node) return [];
    const refs = mergeSourceRefs(node.incidentSegmentIds
      .map((segmentId) => segmentsById.get(segmentId))
      .filter((segment) => segment && segment.access !== "private" &&
        segment.hiking !== "blocked" && segment.status !== "closed"));
    return refs.length > 0 ? [derivedCandidate(node, refs)] : [];
  });
}

/**
 * Construct canonical graph-connected access points from offline candidates.
 * `publicRoadNodeIds` is explicit road/network evidence; graph endpoints are
 * never promoted to derived access points merely because they are degree one.
 */
export function buildAccessPoints(
  { nodes, segments = [], candidates = [], publicRoadNodeIds = [] },
  options = {},
) {
  if (!Array.isArray(nodes)) throw new TypeError("nodes must be an array");
  if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (!Array.isArray(publicRoadNodeIds)) throw new TypeError("publicRoadNodeIds must be an array");
  nodes.forEach(validateTrailNode);
  segments.forEach(validateTrailSegment);
  const settings = validateOptions(options);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (nodesById.size !== nodes.length) throw new TypeError("node ids must be unique");
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  if (segmentsById.size !== segments.length) throw new TypeError("segment ids must be unique");
  const nodesBySourceId = new Map();
  for (const node of nodes) {
    for (const sourceNodeId of node.sourceNodeIds) {
      const ids = nodesBySourceId.get(sourceNodeId) ?? [];
      ids.push(node.id);
      nodesBySourceId.set(sourceNodeId, ids);
    }
  }
  const indexes = {
    nodesById,
    nodesBySourceId,
    usableNodeIds: usableNodeIds(nodes, segments),
  };

  const allCandidates = [
    ...candidates,
    ...derivedCandidates(publicRoadNodeIds, nodesById, segmentsById),
  ];
  const connected = [];
  const issues = [];
  allCandidates.map(normalizeCandidate).sort(compareCandidate).forEach((candidate) => {
    if (candidate.private) {
      issues.push({
        type: "private-candidate",
        candidateId: candidate.key,
        resolution: "omitted-conservative-access-rule",
      });
      return;
    }
    if (!candidate.classification) {
      issues.push({
        type: "ineligible-candidate",
        candidateId: candidate.key,
        resolution: "omitted-without-credible-access-classification",
      });
      return;
    }
    const connection = connectCandidate(candidate, nodes, indexes, settings);
    if (connection.status !== "connected") {
      issues.push({
        type: connection.status === "ambiguous" ? "ambiguous-connection" : "disconnected-candidate",
        candidateId: candidate.key,
        ...(connection.candidates ? {
          nodeIds: connection.candidates.map(({ id }) => id),
        } : {}),
        resolution: connection.status === "ambiguous"
          ? "omitted-without-arbitrary-node-choice"
          : "omitted-without-connected-graph-node",
      });
      return;
    }
    connected.push({ ...candidate, connectedNodeIds: connection.nodeIds });
  });

  issues.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    accessPoints: mergeCandidates(connected, settings.duplicateDistanceMeters),
    issues,
  };
}

export const constructAccessPoints = buildAccessPoints;
