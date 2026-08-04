import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analyzeRecords, buildNameOverlap, renderCoverageReport } from "./coverage-lib.mjs";
import { requireRegion } from "./regions.mjs";

const AUDIT_REGIONS = [
  "bay-midpen",
  "bay-east",
  "sierra-national-forest",
  "yosemite-stanislaus",
  "tahoe-eldorado",
].map(requireRegion).map((region) => ({
  id: region.id,
  label: `${region.label} sample`,
  bbox: region.bbox,
  elevationProbe: region.elevationProbe,
}));

const COMMON_FIELDS = {
  surfaceFields: ["surface", "trail_surface", "trlsurface", "routesur", "surf_type"],
  statusFields: ["status", "trlstatus", "route_status", "opentopublic", "seasonal"],
};

const SOURCES = [
  {
    id: "usgs",
    label: "USGS National Digital Trails",
    kind: "arcgis",
    url: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37",
    nameFields: ["name", "maplabel", "trailname", "trail_name"],
    lengthFields: ["lengthmiles", "networklength"],
    ...COMMON_FIELDS,
  },
  {
    id: "usfs",
    label: "US Forest Service NFS Trails",
    kind: "arcgis",
    url: "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0",
    nameFields: ["trail_name", "trail_no"],
    lengthFields: ["gis_miles", "segment_length"],
    pageSize: 100,
    ...COMMON_FIELDS,
  },
  {
    id: "nps",
    label: "National Park Service Public Trails",
    kind: "arcgis",
    url: "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0",
    nameFields: ["trlname", "maplabel", "trlaltname"],
    lengthFields: [],
    ...COMMON_FIELDS,
  },
  {
    id: "state-parks",
    label: "California State Parks Recreational Routes",
    kind: "arcgis",
    url: "https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/RecreationalRoutes/FeatureServer/0",
    nameFields: ["routename", "unitname"],
    lengthFields: ["seglngth"],
    ...COMMON_FIELDS,
  },
  {
    id: "ebrpd",
    label: "East Bay Regional Park District Trails",
    kind: "arcgis",
    url: "https://services2.arcgis.com/jeEP9c9zZoQQwtck/ArcGIS/rest/services/DistrictTrails_ByTrailName/FeatureServer/0",
    regions: ["bay-east"],
    nameFields: ["trailname", "name_1"],
    lengthFields: ["miles"],
    ...COMMON_FIELDS,
  },
  {
    id: "osm",
    label: "OpenStreetMap hiking network",
    kind: "overpass",
    url: "https://overpass-api.de/api/interpreter",
    nameFields: ["name", "ref"],
    lengthFields: ["distance", "length"],
    ...COMMON_FIELDS,
  },
];

const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const REFRESH_ARGUMENT = process.argv.find((argument) => argument.startsWith("--refresh="));
const REFRESH_TARGETS = new Set(
  (REFRESH_ARGUMENT?.slice("--refresh=".length) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

async function readCachedReport() {
  try {
    return JSON.parse(await readFile("data/trails/coverage-spike.json", "utf8"));
  } catch {
    return null;
  }
}

function shouldRefresh(sourceId, cached) {
  return !cached || REFRESH_TARGETS.has("all") || REFRESH_TARGETS.has(sourceId);
}

async function fetchJson(url, options = {}, timeoutMs = 120_000) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": "AlpineSearch-Personal-Trail-Audit/0.1",
      ...options.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  }
  return payload;
}

async function fetchArcGis(source, region) {
  const metadata = await fetchJson(`${source.url}?f=json`);
  const countParams = new URLSearchParams({
    where: "1=1",
    geometry: region.bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnCountOnly: "true",
    f: "json",
  });
  const countPayload = await fetchJson(`${source.url}/query?${countParams}`);
  const expectedCount = Number(countPayload.count) || 0;
  if (!expectedCount) return [];

  const pageSize = Math.min(
    source.pageSize ?? Number(metadata.maxRecordCount) ?? 2000,
    Number(metadata.maxRecordCount) || 2000,
    2000,
  );
  const records = [];
  let offset = 0;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: region.bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "*",
      returnGeometry: "true",
      returnZ: "false",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "geojson",
    });
    const payload = await fetchJson(`${source.url}/query?${params}`);
    const features = Array.isArray(payload.features) ? payload.features : [];
    records.push(
      ...features.map((feature) => ({
        recordType: "trail",
        properties: feature.properties ?? {},
        geometry: feature.geometry ?? null,
      })),
    );
    offset += features.length;
    if (!features.length || records.length >= expectedCount) break;
  }
  return records;
}

function overpassQuery(region) {
  const [west, south, east, north] = region.bbox;
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:90];
way["highway"~"^(path|footway|bridleway|steps)$"](${bbox});
out body;
relation["route"~"^(hiking|foot)$"](${bbox});
out tags;
nwr["information"="trailhead"](${bbox});
out tags center;
nwr["highway"="trailhead"](${bbox});
out tags center;`;
}

async function fetchOverpass(region) {
  const body = new URLSearchParams({ data: overpassQuery(region) });
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const payload = await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        150_000,
      );
      const uniqueElements = new Map();
      for (const element of payload.elements ?? []) {
        uniqueElements.set(`${element.type}:${element.id}`, element);
      }
      return [...uniqueElements.values()].map((element) => {
        const nodeRefs = Array.isArray(element.nodes) ? element.nodes : [];
        return {
          recordType:
            element.tags?.information === "trailhead" || element.tags?.highway === "trailhead"
              ? "trailhead"
              : "trail",
          properties: { ...element.tags, osm_type: element.type, osm_id: element.id },
          geometry: null,
          nodeRefs,
          topologyEndpoints: nodeRefs.length > 1
            ? [nodeRefs[0], nodeRefs[nodeRefs.length - 1]]
            : [],
        };
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No Overpass endpoint was available.");
}

async function fetchElevation(region) {
  const { latitude, longitude } = region.elevationProbe;
  const params = new URLSearchParams({
    x: String(longitude),
    y: String(latitude),
    units: "Feet",
    wkid: "4326",
    includeDate: "false",
  });
  try {
    const payload = await fetchJson(`https://epqs.nationalmap.gov/v1/json?${params}`, {}, 30_000);
    const value = Number(
      payload.value ?? payload.USGS_Elevation_Point_Query_Service?.Elevation_Query?.Elevation,
    );
    if (!Number.isFinite(value)) throw new Error("The elevation response had no numeric value.");
    return { ok: true, latitude, longitude, value, units: "feet" };
  } catch (error) {
    return { ok: false, latitude, longitude, error: error instanceof Error ? error.message : String(error) };
  }
}

async function auditSource(source, region) {
  if (source.regions && !source.regions.includes(region.id)) {
    return null;
  }
  try {
    const records = source.kind === "arcgis"
      ? await fetchArcGis(source, region)
      : await fetchOverpass(region);
    return {
      sourceId: source.id,
      label: source.label,
      analysis: analyzeRecords(records, source),
    };
  } catch (error) {
    return {
      sourceId: source.id,
      label: source.label,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const cachedReport = await readCachedReport();
  const cachedRegions = new Map(
    (cachedReport?.regions ?? []).map((region) => [region.id, region]),
  );
  const regionReports = [];
  for (const region of AUDIT_REGIONS) {
    const cachedRegion = cachedRegions.get(region.id);
    process.stdout.write(`${REFRESH_TARGETS.size ? "Auditing" : "Rendering cached"} ${region.label}...\n`);
    const sourceResults = [];
    for (const source of SOURCES) {
      const cached = cachedRegion?.sources?.find((result) => result.sourceId === source.id);
      const result = shouldRefresh(source.id, cached)
        ? await auditSource(source, region)
        : cached;
      if (result) sourceResults.push(result);
    }
    const refreshElevation =
      !cachedRegion?.elevation ||
      REFRESH_TARGETS.has("all") ||
      REFRESH_TARGETS.has("elevation");
    regionReports.push({
      ...region,
      sources: sourceResults,
      nameOverlap: buildNameOverlap(sourceResults),
      elevation: refreshElevation ? await fetchElevation(region) : cachedRegion.elevation,
    });
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    regions: regionReports,
    sources: SOURCES.map(({ id, label, kind, url }) => ({ id, label, kind, url })),
  };
  await mkdir("data/trails", { recursive: true });
  await mkdir("docs/trails", { recursive: true });
  await writeFile("data/trails/coverage-spike.json", `${JSON.stringify(report, null, 2)}\n`);
  await writeFile("docs/trails/coverage-spike.md", renderCoverageReport(report));
  process.stdout.write("Wrote data/trails/coverage-spike.json and docs/trails/coverage-spike.md\n");
}

await main();
