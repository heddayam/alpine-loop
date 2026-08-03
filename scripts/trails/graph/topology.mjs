import {
  createNodeId,
  createStableId,
  validateTrailNode,
  validateTrailSegment,
} from "../model.mjs";

const EARTH_RADIUS_METERS = 6_371_008.8;

function radians(value) {
  return value * Math.PI / 180;
}

function edgeLengthMeters(left, right) {
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.max(0, Math.min(1, haversine));
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(boundedHaversine));
}

function compareIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareOsmIds(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const difference = BigInt(left) - BigInt(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRefForWay(way, retrievedAt) {
  return {
    provider: "osm",
    sourceId: `way/${way.id}`,
    ...(way.sourceUpdatedAt ? { sourceUpdatedAt: way.sourceUpdatedAt } : {}),
    retrievedAt,
    sourceUrl: `https://www.openstreetmap.org/way/${way.id}`,
  };
}

function nodeIdentity(osmNode) {
  const sourceNodeIds = [`osm:${osmNode.id}`];
  return {
    id: createNodeId({
      sourceNodeIds,
      longitude: osmNode.longitude,
      latitude: osmNode.latitude,
    }),
    longitude: osmNode.longitude,
    latitude: osmNode.latitude,
    sourceNodeIds,
    incidentSegmentIds: [],
  };
}

/**
 * Turn normalized OSM ways into a provisional edge graph. A segment is emitted
 * for every consecutive way-node pair, which preserves interior junctions and
 * makes shared OSM nodes shared graph nodes without geometric snapping.
 */
export function buildOsmTopology(snapshot, { strict = false } = {}) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.ways)) {
    throw new TypeError("snapshot must contain normalized OSM nodes and ways");
  }
  if (Number.isNaN(Date.parse(snapshot.retrievedAt))) {
    throw new TypeError("snapshot.retrievedAt must be a valid timestamp");
  }

  const sourceNodesByOsmId = new Map(snapshot.nodes.map((node) => [String(node.id), node]));
  const nodesByOsmId = new Map(snapshot.nodes.map((node) => [String(node.id), nodeIdentity(node)]));
  const segments = [];
  const issues = [];
  const wayMetadata = [];

  for (const way of snapshot.ways) {
    const sourceRef = sourceRefForWay(way, snapshot.retrievedAt);
    const segmentIds = [];
    for (let index = 0; index < way.nodeIds.length - 1; index += 1) {
      const fromOsmId = String(way.nodeIds[index]);
      const toOsmId = String(way.nodeIds[index + 1]);
      const fromSource = sourceNodesByOsmId.get(fromOsmId);
      const toSource = sourceNodesByOsmId.get(toOsmId);
      const fromNode = nodesByOsmId.get(fromOsmId);
      const toNode = nodesByOsmId.get(toOsmId);
      if (!fromSource || !toSource || !fromNode || !toNode) {
        const issue = {
          type: "missing-node",
          wayId: String(way.id),
          edgeIndex: index,
          missingNodeIds: [
            ...(!fromNode ? [fromOsmId] : []),
            ...(!toNode ? [toOsmId] : []),
          ],
        };
        if (strict) throw new Error(`way/${way.id} references missing OSM node(s): ${issue.missingNodeIds.join(", ")}`);
        issues.push(issue);
        continue;
      }
      if (fromOsmId === toOsmId) {
        issues.push({ type: "zero-node-edge", wayId: String(way.id), edgeIndex: index });
        continue;
      }

      const geometry = {
        type: "LineString",
        coordinates: [
          [fromSource.longitude, fromSource.latitude],
          [toSource.longitude, toSource.latitude],
        ],
      };
      const id = createStableId("segment", {
        sourceRefs: [sourceRef],
        geometry,
        osmNodeIds: [fromOsmId, toOsmId].sort(),
        edgeIndex: index,
      });
      const segment = {
        id,
        fromNodeId: fromNode.id,
        toNodeId: toNode.id,
        geometry,
        ...(way.name ? { name: way.name } : {}),
        hiking: way.hiking,
        access: way.access,
        status: way.status,
        ...(way.surface ? { surface: way.surface } : {}),
        lengthMeters: edgeLengthMeters(fromSource, toSource),
        sourceRefs: [sourceRef],
      };
      validateTrailSegment(segment);
      segments.push(segment);
      segmentIds.push(id);
      fromNode.incidentSegmentIds.push(id);
      toNode.incidentSegmentIds.push(id);
    }
    wayMetadata.push({
      wayId: String(way.id),
      nodeIds: [...way.nodeIds],
      segmentIds,
      ...(way.sacScale ? { sacScale: way.sacScale } : {}),
      ...(way.visibility ? { visibility: way.visibility } : {}),
      fieldProvenance: Object.fromEntries(
        Object.entries(way.fieldProvenance ?? {}).map(([field, provenance]) => [
          field,
          Array.isArray(provenance.relationIds)
            ? { ...provenance, relationIds: [...provenance.relationIds] }
            : { ...provenance },
        ]),
      ),
      hikingRouteMemberships: way.hikingRouteMemberships.map((membership) => ({ ...membership })),
    });
  }

  segments.sort(compareIds);
  const connectedNodes = [...nodesByOsmId.values()]
    .filter((node) => node.incidentSegmentIds.length > 0)
    .map((node) => ({ ...node, incidentSegmentIds: [...new Set(node.incidentSegmentIds)].sort() }))
    .sort(compareIds);
  connectedNodes.forEach(validateTrailNode);
  wayMetadata.sort((left, right) => compareOsmIds(left.wayId, right.wayId));
  issues.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return { nodes: connectedNodes, segments, wayMetadata, issues };
}

export const buildTopology = buildOsmTopology;
