const ENUM_VALUES = Object.freeze({
  hiking: ["allowed", "blocked", "unknown"],
  access: ["public", "private", "unknown"],
  accessPointConfidence: ["official", "mapped", "derived"],
});

function emptyEnumCounts(values) {
  return Object.fromEntries(values.map((value) => [value, 0]));
}

function countEnum(records, field, values) {
  const counts = emptyEnumCounts(values);
  for (const record of records) counts[record[field]] += 1;
  return counts;
}

function sourceProviders(record) {
  return [...new Set((record.sourceRefs ?? []).map(({ provider }) => provider.toLowerCase()))]
    .sort();
}

function countsBySource(recordGroups) {
  const result = {};
  for (const [kind, records] of Object.entries(recordGroups)) {
    for (const record of records) {
      for (const provider of sourceProviders(record)) {
        result[provider] ??= {};
        result[provider][kind] = (result[provider][kind] ?? 0) + 1;
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) =>
    left.localeCompare(right)).map(([provider, counts]) => [provider, counts]));
}

function graphMetrics(nodes, segments) {
  const adjacency = new Map(nodes.map(({ id }) => [id, new Set()]));
  const segmentIdsByNode = new Map(nodes.map(({ id }) => [id, []]));
  for (const segment of segments) {
    adjacency.get(segment.fromNodeId)?.add(segment.toNodeId);
    adjacency.get(segment.toNodeId)?.add(segment.fromNodeId);
    segmentIdsByNode.get(segment.fromNodeId)?.push(segment.id);
    segmentIdsByNode.get(segment.toNodeId)?.push(segment.id);
  }

  const visited = new Set();
  let connectedComponents = 0;
  const isolatedSegmentIds = [];
  for (const nodeId of [...adjacency.keys()].sort()) {
    if (visited.has(nodeId) || (segmentIdsByNode.get(nodeId)?.length ?? 0) === 0) continue;
    const pending = [nodeId];
    const componentSegmentIds = new Set();
    visited.add(nodeId);
    while (pending.length > 0) {
      const current = pending.pop();
      for (const segmentId of segmentIdsByNode.get(current) ?? []) {
        componentSegmentIds.add(segmentId);
      }
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    connectedComponents += 1;
    if (componentSegmentIds.size === 1) {
      isolatedSegmentIds.push(componentSegmentIds.values().next().value);
    }
  }
  isolatedSegmentIds.sort();
  return {
    connectedComponents,
    isolatedSegments: isolatedSegmentIds.length,
    isolatedSegmentIds,
    explanation: "isolated source-backed geometry is retained for review but is searchable only when credible access connects it",
  };
}

function shortestWindows(startNodeId, adjacency, nodeElevations, minimumMeters, maximumMeters) {
  const distances = new Map([[startNodeId, 0]]);
  const pending = [{ nodeId: startNodeId, distance: 0 }];
  const windows = [];
  while (pending.length > 0) {
    pending.sort((left, right) => left.distance - right.distance ||
      left.nodeId.localeCompare(right.nodeId));
    const current = pending.shift();
    if (current.distance !== distances.get(current.nodeId) || current.distance > maximumMeters) continue;
    if (current.distance >= minimumMeters && Number.isFinite(nodeElevations[current.nodeId])) {
      windows.push(current);
    }
    for (const edge of adjacency.get(current.nodeId) ?? []) {
      const distance = current.distance + edge.lengthMeters;
      if (distance > maximumMeters || distance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, distance);
      pending.push({ nodeId: edge.to, distance });
    }
  }
  return windows;
}

function aggregateElevationWindows(segments, nodeElevations, {
  minimumMeters = 50,
  maximumMeters = 200,
  maximumGradePct = 80,
} = {}) {
  const shortSegments = segments.filter(({ lengthMeters }) => lengthMeters < minimumMeters);
  const adjacency = new Map();
  for (const segment of segments) {
    for (const [from, to] of [
      [segment.fromNodeId, segment.toNodeId],
      [segment.toNodeId, segment.fromNodeId],
    ]) {
      const edges = adjacency.get(from) ?? [];
      edges.push({ to, lengthMeters: segment.lengthMeters });
      adjacency.set(from, edges);
    }
  }
  const startNodeIds = [...new Set(shortSegments.flatMap(({ fromNodeId, toNodeId }) =>
    [fromNodeId, toNodeId]))].sort();
  const coveredStartNodeIds = new Set();
  const outlierMap = new Map();
  let checkedWindows = 0;
  for (const nodeId of startNodeIds) {
    if (!Number.isFinite(nodeElevations[nodeId])) continue;
    const windows = shortestWindows(
      nodeId,
      adjacency,
      nodeElevations,
      minimumMeters,
      maximumMeters,
    );
    checkedWindows += windows.length;
    if (windows.length > 0) coveredStartNodeIds.add(nodeId);
    for (const window of windows) {
      const key = nodeId < window.nodeId
        ? `${nodeId}\u0000${window.nodeId}`
        : `${window.nodeId}\u0000${nodeId}`;
      const gradePct = Math.abs(nodeElevations[nodeId] - nodeElevations[window.nodeId]) /
        window.distance * 100;
      if (gradePct <= maximumGradePct || outlierMap.has(key)) continue;
      outlierMap.set(key, {
        fromNodeId: nodeId,
        toNodeId: window.nodeId,
        distanceMeters: Number(window.distance.toFixed(1)),
        elevationChangeMeters: Number(Math.abs(
          nodeElevations[nodeId] - nodeElevations[window.nodeId],
        ).toFixed(1)),
        gradePct: Number(gradePct.toFixed(1)),
        reason: `aggregate-${minimumMeters}-${maximumMeters}m-grade-over-${maximumGradePct}-pct`,
      });
    }
  }
  return {
    method: "shortest-path-endpoint-elevation-windows",
    minimumWindowMeters: minimumMeters,
    maximumWindowMeters: maximumMeters,
    maximumGradePct,
    shortSegments: shortSegments.length,
    coveredShortSegments: shortSegments.filter((segment) =>
      coveredStartNodeIds.has(segment.fromNodeId) ||
      coveredStartNodeIds.has(segment.toNodeId)).length,
    uncompensatedShortSegmentIds: shortSegments
      .filter((segment) => !coveredStartNodeIds.has(segment.fromNodeId) &&
        !coveredStartNodeIds.has(segment.toNodeId)).map(({ id }) => id).sort(),
    checkedWindows,
    outliers: [...outlierMap.values()].sort((left, right) =>
      left.fromNodeId.localeCompare(right.fromNodeId) || left.toNodeId.localeCompare(right.toNodeId)),
  };
}

function elevationMetrics(segments, namedTrails, elevationQa = {}) {
  const metricFields = [
    "ascentForwardMeters",
    "descentForwardMeters",
    "minElevationMeters",
    "maxElevationMeters",
    "maxGradePct",
  ];
  const complete = segments.filter((segment) =>
    metricFields.every((field) => Number.isFinite(segment[field])));
  const implausibleMetricOutliers = segments.flatMap((segment) => {
    const reasons = [];
    if (segment.maxGradePct > 80) {
      reasons.push(segment.lengthMeters < 50
        ? "short-edge-max-grade-over-80-pct"
        : "max-grade-over-80-pct");
    }
    if (segment.ascentForwardMeters > segment.lengthMeters * 1.5) {
      reasons.push("ascent-over-150-pct-of-length");
    }
    if (segment.descentForwardMeters > segment.lengthMeters * 1.5) {
      reasons.push("descent-over-150-pct-of-length");
    }
    if (segment.minElevationMeters < -500) reasons.push("elevation-below-minus-500m");
    if (segment.maxElevationMeters > 9_000) reasons.push("elevation-over-9000m");
    return reasons.length > 0 ? [{ segmentId: segment.id, reasons }] : [];
  });
  const routable = segments.filter(({ hiking, access, status }) =>
    hiking !== "blocked" && access !== "private" && status !== "closed");
  const completeIds = new Set(complete.map(({ id }) => id));
  const namedTrailSegmentIds = new Set(namedTrails.flatMap(({ segmentIds }) => segmentIds));
  const aggregateWindows = aggregateElevationWindows(
    complete,
    elevationQa.nodeElevations ?? {},
  );
  return {
    completeSegments: complete.length,
    missingSegments: segments.length - complete.length,
    coveragePct: segments.length === 0 ? 0 : Number((complete.length / segments.length * 100).toFixed(1)),
    routableCoveragePct: routable.length === 0 ? 0 : Number((
      routable.filter(({ id }) => completeIds.has(id)).length / routable.length * 100
    ).toFixed(1)),
    searchableNamedTrailSegments: namedTrailSegmentIds.size,
    searchableNamedTrailMissingSegmentIds: [...namedTrailSegmentIds]
      .filter((id) => !completeIds.has(id)).sort(),
    shortSegmentGradeChecksSkipped: [],
    perEdgeShortSegmentsChecked: segments.filter(({ lengthMeters }) => lengthMeters < 50).length,
    aggregateWindows,
    implausibleMetricOutliers,
    review: {
      status: implausibleMetricOutliers.length > 0 || aggregateWindows.outliers.length > 0
        ? "manual-review-required"
        : "passed",
      explanation: "1 arc-second terrain cells can cross cliffs beside switchbacks; aggregate windows identify persistent spikes instead of hiding them in short edges",
    },
  };
}

/** Build the deterministic, machine-readable T7 QA report. */
export function buildQaReport({
  region,
  input,
  segments,
  nodes,
  accessPoints,
  namedTrails,
  mergeConflicts = [],
  accessIssues = [],
  pipelineIssues = [],
  regionalFiltering = {},
  reconciliation = {},
  segmentProvenance = {},
  elevationQa = {},
  sourceManifest,
  artifactHashes = {},
}) {
  const ambiguousSnaps = accessIssues.filter(({ type }) => type === "ambiguous-connection");
  const unresolvedMergeConflicts = mergeConflicts.filter(({ resolution }) => !resolution);
  return {
    schemaVersion: 1,
    region: { id: region.id, label: region.label, bounds: [...region.bbox] },
    counts: {
      input: {
        segments: input.segmentCandidates.length,
        nodes: input.sourceNodes.length,
        accessPointCandidates: input.accessPointCandidates.length,
        bySource: countsBySource({
          segments: input.segmentCandidates,
          accessPointCandidates: input.accessPointCandidates,
        }),
      },
      output: {
        segments: segments.length,
        nodes: nodes.length,
        accessPoints: accessPoints.length,
        namedTrails: namedTrails.length,
        bySource: countsBySource({ segments, accessPoints, namedTrails }),
      },
    },
    segments: {
      named: segments.filter(({ name }) => name).length,
      unnamed: segments.filter(({ name }) => !name).length,
      hiking: countEnum(segments, "hiking", ENUM_VALUES.hiking),
      access: countEnum(segments, "access", ENUM_VALUES.access),
    },
    graph: graphMetrics(nodes, segments),
    regionalFiltering,
    reconciliation,
    provenance: {
      segments: Object.keys(segmentProvenance).length,
      missingSegmentIds: segments.filter(({ id }) => !segmentProvenance[id]).map(({ id }) => id),
    },
    accessPoints: countEnum(
      accessPoints,
      "confidence",
      ENUM_VALUES.accessPointConfidence,
    ),
    merge: {
      conflicts: mergeConflicts.length,
      resolved: mergeConflicts.length - unresolvedMergeConflicts.length,
      unexplained: unresolvedMergeConflicts.length,
      details: mergeConflicts,
    },
    snapping: {
      ambiguous: ambiguousSnaps.length,
      details: ambiguousSnaps,
    },
    elevation: elevationMetrics(segments, namedTrails, elevationQa),
    ...(sourceManifest ? { sources: sourceManifest } : {}),
    issues: [...pipelineIssues, ...accessIssues],
    artifactHashes,
  };
}

export default buildQaReport;
