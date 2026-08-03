const BLOCKED_VALUES = new Set(["n", "no", "private", "closed", "prohibited"]);
const ALLOWED_VALUES = new Set(["y", "yes", "designated", "permissive", "official"]);

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function normalizeTrailName(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .replace(/\b(the|trail|trails|route)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function readProperty(properties, fields) {
  if (!properties || typeof properties !== "object") return "";
  const entries = new Map(
    Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const field of fields) {
    const value = entries.get(field.toLowerCase());
    if (text(value)) return text(value);
  }
  return "";
}

function classifyHiking(sourceId, properties) {
  if (sourceId === "usgs") {
    const value = readProperty(properties, ["hikerpedestrian"]).toLowerCase();
    if (BLOCKED_VALUES.has(value)) return "blocked";
    if (ALLOWED_VALUES.has(value)) return "allowed";
  }

  if (sourceId === "usfs") {
    const accepted = readProperty(properties, [
      "hiker_pedestrian_managed",
      "hiker_pedestrian_accpt",
      "hiker_pedestrian_accpt_disc",
    ]).toLowerCase();
    if (accepted && !BLOCKED_VALUES.has(accepted)) return "allowed";
  }

  if (sourceId === "nps") {
    const open = readProperty(properties, ["opentopublic"]).toLowerCase();
    if (BLOCKED_VALUES.has(open)) return "blocked";
    const use = readProperty(properties, ["trluse", "trailuse"]).toLowerCase();
    if (/hike|hiker|pedestrian|foot/.test(use)) return "allowed";
  }

  if (sourceId === "osm") {
    const foot = readProperty(properties, ["foot"]).toLowerCase();
    const access = readProperty(properties, ["access"]).toLowerCase();
    if (BLOCKED_VALUES.has(foot) || BLOCKED_VALUES.has(access)) return "blocked";
    if (ALLOWED_VALUES.has(foot)) return "allowed";
  }

  return "unknown";
}

function classifyAccess(sourceId, properties) {
  if (sourceId === "nps") {
    const value = readProperty(properties, ["opentopublic"]).toLowerCase();
    if (BLOCKED_VALUES.has(value)) return "blocked";
    if (ALLOWED_VALUES.has(value)) return "public";
  }
  if (sourceId === "osm") {
    const access = readProperty(properties, ["access"]).toLowerCase();
    if (BLOCKED_VALUES.has(access)) return "blocked";
    if (ALLOWED_VALUES.has(access)) return "public";
  }
  return "unknown";
}

function positionsFromGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  const positions = [];
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      typeof value[1] === "number" &&
      Number.isFinite(value[1])
    ) {
      positions.push(value);
      return;
    }
    value.forEach(visit);
  }
  visit(geometry.coordinates);
  return positions;
}

function lineEndpoints(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    const positions = geometry.coordinates;
    return positions.length > 1 ? [positions[0], positions[positions.length - 1]] : [];
  }
  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flatMap((line) =>
      Array.isArray(line) && line.length > 1 ? [line[0], line[line.length - 1]] : [],
    );
  }
  return [];
}

function percentage(count, total) {
  return total ? Number(((count / total) * 100).toFixed(1)) : 0;
}

export function analyzeRecords(records, source) {
  const features = records.filter((record) => record.recordType !== "trailhead");
  const trailheads = records.length - features.length;
  const names = new Set();
  let named = 0;
  let withGeometry = 0;
  let withTopology = 0;
  let withSurface = 0;
  let withLength = 0;
  let withStatus = 0;
  let withZ = 0;
  let vertices = 0;
  let hikingAllowed = 0;
  let hikingBlocked = 0;
  let publicAccess = 0;
  let blockedAccess = 0;
  const endpointCounts = new Map();

  for (const feature of features) {
    const properties = feature.properties ?? {};
    const name = readProperty(properties, source.nameFields);
    if (name) {
      named += 1;
      const normalized = normalizeTrailName(name);
      if (normalized) names.add(normalized);
    }
    if (readProperty(properties, source.surfaceFields)) withSurface += 1;
    if (readProperty(properties, source.lengthFields)) withLength += 1;
    if (readProperty(properties, source.statusFields)) withStatus += 1;

    const hiking = classifyHiking(source.id, properties);
    if (hiking === "allowed") hikingAllowed += 1;
    if (hiking === "blocked") hikingBlocked += 1;
    const access = classifyAccess(source.id, properties);
    if (access === "public") publicAccess += 1;
    if (access === "blocked") blockedAccess += 1;

    const positions = positionsFromGeometry(feature.geometry);
    const topologyEndpoints = Array.isArray(feature.topologyEndpoints)
      ? feature.topologyEndpoints
      : [];
    if (positions.length) {
      withGeometry += 1;
      vertices += positions.length;
      if (positions.some((position) => position.length >= 3 && Number.isFinite(position[2]))) {
        withZ += 1;
      }
    } else if (Array.isArray(feature.nodeRefs) && feature.nodeRefs.length > 1) {
      vertices += feature.nodeRefs.length;
    }
    const endpoints = topologyEndpoints.length
      ? topologyEndpoints.map((endpoint) => [`node:${endpoint}`])
      : lineEndpoints(feature.geometry);
    if (endpoints.length) withTopology += 1;
    for (const endpoint of endpoints) {
      const key = endpoint.length === 1
        ? String(endpoint[0])
        : `${Number(endpoint[0]).toFixed(5)},${Number(endpoint[1]).toFixed(5)}`;
      endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
    }
  }

  const endpointTotal = [...endpointCounts.values()].reduce((sum, count) => sum + count, 0);
  const sharedEndpoints = [...endpointCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);

  return {
    features: features.length,
    trailheads,
    uniqueNames: names.size,
    names: [...names].sort(),
    coverage: {
      namedPct: percentage(named, features.length),
      geometryPct: percentage(withGeometry, features.length),
      topologyPct: percentage(withTopology, features.length),
      surfacePct: percentage(withSurface, features.length),
      sourceLengthPct: percentage(withLength, features.length),
      statusPct: percentage(withStatus, features.length),
      zCoordinatePct: percentage(withZ, features.length),
      explicitHikingAllowedPct: percentage(hikingAllowed, features.length),
      explicitHikingBlockedPct: percentage(hikingBlocked, features.length),
      explicitPublicAccessPct: percentage(publicAccess, features.length),
      explicitBlockedAccessPct: percentage(blockedAccess, features.length),
      sharedEndpointPct: percentage(sharedEndpoints, endpointTotal),
    },
    averageVertices: features.length ? Number((vertices / features.length).toFixed(1)) : 0,
  };
}

export function buildNameOverlap(regionResults) {
  const available = regionResults.filter((result) => !result.error && result.analysis);
  const rows = [];
  for (let leftIndex = 0; leftIndex < available.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < available.length; rightIndex += 1) {
      const left = available[leftIndex];
      const right = available[rightIndex];
      const rightNames = new Set(right.analysis.names);
      const shared = left.analysis.names.filter((name) => rightNames.has(name)).length;
      rows.push({ left: left.sourceId, right: right.sourceId, sharedNames: shared });
    }
  }
  return rows.sort((a, b) => b.sharedNames - a.sharedNames);
}

function formatPct(value) {
  return `${Number(value ?? 0).toFixed(1)}%`;
}

export function renderCoverageReport(report) {
  const lines = [
    "# Hiking trail source coverage spike",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This is a representative-source audit, not a full regional trail count. It samples five areas that exercise the data conditions Alpine Search will encounter from the Bay Area through the central Sierra.",
    "",
    "## What the spike measures",
    "",
    "- Named trail coverage and source-provided length/status/surface attributes",
    "- Explicit hiking and public-access evidence (unknown is intentionally not treated as allowed)",
    "- Geometry detail, Z coordinates, and endpoint snapping as indicators of routing readiness",
    "- Native trailhead records and overlapping normalized names between sources",
    "- Availability of a public USGS elevation lookup at a representative point",
    "",
    "## Findings and ingestion decision",
    "",
    "- Use USGS as the broad named-geometry baseline, but not as the sole authority for surface or access.",
    "- In National Forest land, enrich or replace USGS attributes with the Forest Service layer; it consistently provides names, source length, surface, and strong hiking-use evidence.",
    "- In Yosemite and other NPS units, use NPS for hiking use, status, and surface while retaining USGS/OSM names where NPS segments are unnamed.",
    "- Use State Parks and EBRPD as named local geometry overlays, then validate hiking/public access from land-manager context because those simplified layers do not encode it explicitly.",
    "- Preserve OSM node identity for the future routing graph and use its trailheads and surface tags, but clip it to relevant public recreation land and exclude explicitly restricted ways. Raw path/footway counts are far too broad to ship directly.",
    "- Derive canonical distance from normalized geometry and elevation gain/loss from a common 3DEP elevation product. Do not mix source-specific length or elevation calculations.",
    "- Treat trailhead/access-point construction as its own ingestion stage. OSM supplies some explicit trailheads, but none of the audited line layers supplies enough access points by itself.",
    "",
  ];

  for (const region of report.regions) {
    lines.push(`## ${region.label}`, "", `Sample bounds: \`${region.bbox.join(", ")}\``, "");
    lines.push(
      "| Source | Features | Named | Hiking explicit | Public access explicit | Surface | Source length | Geometry | Topology | Shared endpoints | Trailheads |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const result of region.sources) {
      if (result.error) {
        lines.push(`| ${result.label} | error | — | — | — | — | — | — | — | — | — |`);
        continue;
      }
      const { analysis } = result;
      lines.push(
        `| ${result.label} | ${analysis.features} | ${formatPct(analysis.coverage.namedPct)} | ${formatPct(analysis.coverage.explicitHikingAllowedPct)} | ${formatPct(analysis.coverage.explicitPublicAccessPct)} | ${formatPct(analysis.coverage.surfacePct)} | ${formatPct(analysis.coverage.sourceLengthPct)} | ${formatPct(analysis.coverage.geometryPct)} | ${formatPct(analysis.coverage.topologyPct)} | ${formatPct(analysis.coverage.sharedEndpointPct)} | ${analysis.trailheads} |`,
      );
    }
    lines.push("");
    const strongest = region.nameOverlap.filter((row) => row.sharedNames > 0).slice(0, 5);
    if (strongest.length) {
      lines.push("Normalized-name overlaps:", "");
      strongest.forEach((row) =>
        lines.push(`- ${row.left} ↔ ${row.right}: ${row.sharedNames} shared names`),
      );
      lines.push("");
    }
    if (region.elevation?.ok) {
      lines.push(
        `Elevation probe: ${region.elevation.value} ${region.elevation.units} at \`${region.elevation.latitude}, ${region.elevation.longitude}\`.`,
        "",
      );
    } else {
      lines.push("Elevation probe: unavailable during this run.", "");
    }
  }

  lines.push(
    "## Interpretation rules",
    "",
    "- A low explicit-hiking percentage does not mean hiking is forbidden; it means that source does not reliably encode permission and must be combined with an official/public-land source.",
    "- Shared endpoints are only a rough topology signal. The production graph must retain OSM node identity where available and snap official geometries under controlled tolerances.",
    "- Source length is audited but will not be trusted as the canonical value. Alpine Search should calculate geodesic length from normalized geometry.",
    "- Z coordinates are not expected to be complete or consistent. Elevation gain should be derived from a common DEM with smoothing and documented sampling resolution.",
    "- A trail line intersecting a drive-time polygon is not sufficient. Search eligibility will require a credible trailhead, entrance, or derived public access point inside the polygon.",
    "",
    "## Source endpoints",
    "",
  );
  report.sources.forEach((source) => lines.push(`- ${source.label}: ${source.url}`));
  lines.push("");
  return `${lines.join("\n")}\n`;
}
