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
  const components = [];
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
    components.push([...componentSegmentIds].sort());
  }
  const isolatedSegmentIds = components.filter((ids) => ids.length === 1).flat().sort();
  return {
    connectedComponents: components.length,
    isolatedSegments: isolatedSegmentIds.length,
    isolatedSegmentIds,
  };
}

function elevationMetrics(segments) {
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
    if (segment.maxGradePct > 80) reasons.push("max-grade-over-80-pct");
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
  return {
    completeSegments: complete.length,
    missingSegments: segments.length - complete.length,
    coveragePct: segments.length === 0 ? 0 : Number((complete.length / segments.length * 100).toFixed(1)),
    implausibleMetricOutliers,
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
  artifactHashes = {},
}) {
  const ambiguousSnaps = accessIssues.filter(({ type }) => type === "ambiguous-connection");
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
    accessPoints: countEnum(
      accessPoints,
      "confidence",
      ENUM_VALUES.accessPointConfidence,
    ),
    merge: {
      conflicts: mergeConflicts.length,
      details: mergeConflicts,
    },
    snapping: {
      ambiguous: ambiguousSnaps.length,
      details: ambiguousSnaps,
    },
    elevation: elevationMetrics(segments),
    issues: [...pipelineIssues, ...accessIssues],
    artifactHashes,
  };
}

export default buildQaReport;
