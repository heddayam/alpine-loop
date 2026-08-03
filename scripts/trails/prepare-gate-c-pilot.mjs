#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { refreshArcGisSnapshot, readArcGisField } from "./sources/arcgis.mjs";
import { NPS_SOURCE } from "./sources/nps.mjs";

export const GATE_C_PILOT = Object.freeze({
  id: "happy-isles-mist-trail",
  regionId: "yosemite-stanislaus",
  label: "Happy Isles–Mist Trail",
  bbox: Object.freeze([-119.565, 37.718, -119.532, 37.736]),
  trailNamePattern: /\bmist trail\b/i,
  osmMapUrl: "https://api.openstreetmap.org/api/0.6/map",
  elevationUrl:
    "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples",
});

const ELEVATION_PIXEL_DEGREES = 0.00025;
const ELEVATION_PADDING_DEGREES = 0.0003;

function xmlText(value) {
  return String(value)
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(/([:\w-]+)="([^"]*)"/g)) {
    result[match[1]] = xmlText(match[2]);
  }
  return result;
}

function tags(body = "") {
  return Object.fromEntries([...body.matchAll(/<tag\b([^>]*?)\/>/g)].map((match) => {
    const parsed = attributes(match[1]);
    return [parsed.k, parsed.v];
  }).filter(([key]) => key !== undefined));
}

/** Parse the bounded OSM API XML format used by the explicit pilot refresh. */
export function parseOsmXml(xml) {
  if (typeof xml !== "string" || !/<osm\b/.test(xml)) {
    throw new TypeError("OSM map response must be XML with an osm root");
  }
  const elements = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const value = attributes(match[1]);
    elements.push({
      type: "node",
      id: value.id,
      lon: Number(value.lon),
      lat: Number(value.lat),
      tags: tags(match[2]),
      info: { ...(value.timestamp ? { timestamp: value.timestamp } : {}) },
    });
  }
  for (const match of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const value = attributes(match[1]);
    elements.push({
      type: "way",
      id: value.id,
      nodes: [...match[2].matchAll(/<nd\b([^>]*?)\/>/g)]
        .map((nodeMatch) => attributes(nodeMatch[1]).ref),
      tags: tags(match[2]),
      info: { ...(value.timestamp ? { timestamp: value.timestamp } : {}) },
    });
  }
  for (const match of xml.matchAll(/<relation\b([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const value = attributes(match[1]);
    elements.push({
      type: "relation",
      id: value.id,
      members: [...match[2].matchAll(/<member\b([^>]*?)\/>/g)].map((memberMatch) => {
        const member = attributes(memberMatch[1]);
        return { type: member.type, ref: member.ref, role: member.role ?? "" };
      }),
      tags: tags(match[2]),
    });
  }
  return elements;
}

function isAccessNode(element) {
  if (element.type !== "node") return false;
  const tagsValue = element.tags ?? {};
  const access = String(tagsValue.access ?? "").toLowerCase();
  const explicitPublic = ["yes", "public", "designated", "permissive"].includes(access);
  return tagsValue.highway === "trailhead" || tagsValue.information === "trailhead" ||
    (explicitPublic && (tagsValue.entrance === "yes" || tagsValue.barrier === "entrance" ||
      tagsValue.amenity === "parking"));
}

function isPublicRoad(element) {
  if (element.type !== "way") return false;
  const highway = element.tags?.highway;
  const access = String(element.tags?.access ?? "").toLowerCase();
  if (["no", "private"].includes(access)) return false;
  return [
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
    "residential", "living_street",
  ].includes(highway) || (["service", "track"].includes(highway) &&
    ["yes", "public", "designated", "permissive"].includes(access));
}

function isUsableHikingWay(element) {
  if (element.type !== "way" ||
      !["path", "footway", "steps", "bridleway"].includes(element.tags?.highway)) return false;
  return !["no", "private"].includes(String(element.tags?.access ?? "").toLowerCase()) &&
    !["no", "private"].includes(String(element.tags?.foot ?? "").toLowerCase());
}

function distanceMeters(left, right) {
  const latitude = (left.lat + right.lat) * Math.PI / 360;
  const x = (right.lon - left.lon) * Math.cos(latitude) * 111_195;
  const y = (right.lat - left.lat) * 111_195;
  return Math.hypot(x, y);
}

function connectorWayIds(elements, selectedNodeIds) {
  const nodes = new Map(elements.filter(({ type }) => type === "node")
    .map((node) => [String(node.id), node]));
  const hikingWays = elements.filter(isUsableHikingWay);
  const adjacency = new Map();
  for (const way of hikingWays) {
    for (let index = 1; index < way.nodes.length; index += 1) {
      const left = nodes.get(String(way.nodes[index - 1]));
      const right = nodes.get(String(way.nodes[index]));
      if (!left || !right) continue;
      const weight = distanceMeters(left, right);
      for (const [from, to] of [[left.id, right.id], [right.id, left.id]]) {
        const edges = adjacency.get(String(from)) ?? [];
        edges.push({ to: String(to), wayId: String(way.id), weight });
        adjacency.set(String(from), edges);
      }
    }
  }
  const result = new Set();
  for (const access of elements.filter(isAccessNode)) {
    let start;
    for (const nodeId of adjacency.keys()) {
      const candidate = nodes.get(nodeId);
      const distance = distanceMeters(access, candidate);
      if (distance <= 100 && (!start || distance < start.distance)) start = { nodeId, distance };
    }
    if (!start) continue;
    const distances = new Map([[start.nodeId, 0]]);
    const previous = new Map();
    const pending = [{ nodeId: start.nodeId, distance: 0 }];
    let destination;
    while (pending.length > 0) {
      pending.sort((left, right) => left.distance - right.distance ||
        left.nodeId.localeCompare(right.nodeId));
      const current = pending.shift();
      if (current.distance !== distances.get(current.nodeId) || current.distance > 2_000) continue;
      if (selectedNodeIds.has(current.nodeId)) {
        destination = current.nodeId;
        break;
      }
      for (const edge of adjacency.get(current.nodeId) ?? []) {
        const nextDistance = current.distance + edge.weight;
        if (nextDistance >= (distances.get(edge.to) ?? Infinity)) continue;
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, { nodeId: current.nodeId, wayId: edge.wayId });
        pending.push({ nodeId: edge.to, distance: nextDistance });
      }
    }
    while (destination && destination !== start.nodeId) {
      const step = previous.get(destination);
      if (!step) break;
      result.add(step.wayId);
      destination = step.nodeId;
    }
  }
  return result;
}

export function selectPilotOsmElements(elements, pattern = GATE_C_PILOT.trailNamePattern) {
  const selectedWays = elements.filter((element) => element.type === "way" &&
    ["path", "footway", "steps", "bridleway"].includes(element.tags?.highway) &&
    pattern.test(String(element.tags?.name ?? "")));
  const selectedWayIds = new Set(selectedWays.map(({ id }) => String(id)));
  const selectedNodeIds = new Set(selectedWays.flatMap(({ nodes }) => nodes.map(String)));
  const connectorIds = connectorWayIds(elements, selectedNodeIds);
  const connectorWays = elements.filter((element) =>
    element.type === "way" && connectorIds.has(String(element.id)) && !selectedWayIds.has(String(element.id)));
  connectorWays.forEach(({ nodes }) => nodes.forEach((id) => selectedNodeIds.add(String(id))));
  const roadWays = elements.filter((element) => isPublicRoad(element) &&
    element.nodes.some((id) => selectedNodeIds.has(String(id))));
  const relationElements = elements.filter((element) => element.type === "relation" &&
    element.members.some(({ type, ref }) => type === "way" && selectedWayIds.has(String(ref))));
  const retainedNodeIds = new Set([
    ...selectedNodeIds,
    ...roadWays.flatMap(({ nodes }) => nodes.map(String)),
  ]);
  const nodeElements = elements.filter((element) => element.type === "node" &&
    (retainedNodeIds.has(String(element.id)) || isAccessNode(element)));
  return [...nodeElements, ...selectedWays, ...connectorWays, ...roadWays, ...relationElements];
}

export function selectPilotAgencyFeatures(snapshot, pattern = GATE_C_PILOT.trailNamePattern) {
  return snapshot.features.filter((feature) => {
    const name = readArcGisField(feature.properties ?? feature.attributes, NPS_SOURCE.nameFields);
    return pattern.test(String(name?.value ?? ""));
  });
}

function geometryPositions(agencyFeatures, osmElements) {
  const positions = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      positions.push([value[0], value[1]]);
    } else value.forEach(visit);
  };
  agencyFeatures.forEach((feature) => visit(feature.geometry?.coordinates));
  const trailNodeIds = new Set(osmElements.filter((element) =>
    element.type === "way" &&
    ["path", "footway", "steps", "bridleway"].includes(element.tags?.highway) &&
    GATE_C_PILOT.trailNamePattern.test(String(element.tags?.name ?? "")))
    .flatMap(({ nodes }) => nodes.map(String)));
  osmElements.filter(({ type, id }) => type === "node" && trailNodeIds.has(String(id)))
    .forEach(({ lon, lat }) => {
      if (Number.isFinite(lon) && Number.isFinite(lat)) positions.push([lon, lat]);
    });
  if (positions.length === 0) throw new Error("selected pilot sources contain no geometry");
  return positions;
}

function elevationLocations(positions) {
  const west = Math.min(...positions.map(([longitude]) => longitude)) - ELEVATION_PADDING_DEGREES;
  const east = Math.max(...positions.map(([longitude]) => longitude)) + ELEVATION_PADDING_DEGREES;
  const south = Math.min(...positions.map(([, latitude]) => latitude)) - ELEVATION_PADDING_DEGREES;
  const north = Math.max(...positions.map(([, latitude]) => latitude)) + ELEVATION_PADDING_DEGREES;
  const width = Math.ceil((east - west) / ELEVATION_PIXEL_DEGREES) + 1;
  const height = Math.ceil((north - south) / ELEVATION_PIXEL_DEGREES) + 1;
  const locations = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      locations.push([west + column * ELEVATION_PIXEL_DEGREES, north - row * ELEVATION_PIXEL_DEGREES]);
    }
  }
  return { west, north, width, height, locations };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "User-Agent": "AlpineSearch-GateCPilot/1", ...options.headers },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

async function fetchElevationValues(locations, sourceUrl) {
  const values = [];
  for (let offset = 0; offset < locations.length; offset += 100) {
    const points = locations.slice(offset, offset + 100);
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryMultipoint",
      inSR: "4326",
      returnFirstValueOnly: "true",
      f: "json",
    });
    const text = await fetchText(sourceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = JSON.parse(text);
    if (payload.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
    const samples = payload.samples ?? [];
    if (samples.length !== points.length) {
      throw new Error(`3DEP returned ${samples.length} samples for ${points.length} points`);
    }
    values.push(...samples.map((sample) => {
      const value = Number(Array.isArray(sample.value) ? sample.value[0] : sample.value);
      return Number.isFinite(value) ? value : -9999;
    }));
  }
  return values;
}

async function prepareElevationGrid(positions, retrievedAt) {
  const layout = elevationLocations(positions);
  const values = await fetchElevationValues(layout.locations, GATE_C_PILOT.elevationUrl);
  return {
    type: "ElevationGrid",
    crs: "EPSG:4326",
    width: layout.width,
    height: layout.height,
    origin: [layout.west, layout.north],
    pixelSize: [ELEVATION_PIXEL_DEGREES, -ELEVATION_PIXEL_DEGREES],
    noDataValue: -9999,
    values: Array.from({ length: layout.height }, (_, row) =>
      values.slice(row * layout.width, (row + 1) * layout.width)),
    source: {
      provider: "USGS",
      product: "3DEP Elevation ImageServer",
      version: retrievedAt.slice(0, 10),
      verticalDatum: "NAVD88",
      sourceUrl: GATE_C_PILOT.elevationUrl,
    },
  };
}

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The only T7.1 operation that contacts public source services. */
export async function refreshGateCPilot({ cacheDirectory, retrievedAt = new Date().toISOString() }) {
  const cacheRoot = resolve(cacheDirectory);
  await mkdir(cacheRoot, { recursive: true });
  const rawAgencyPath = resolve(cacheRoot, "nps-raw.json");
  const rawAgency = await refreshArcGisSnapshot(NPS_SOURCE, {
    bbox: GATE_C_PILOT.bbox,
    cachePath: rawAgencyPath,
    retrievedAt,
  });
  const agencySnapshot = { ...rawAgency, features: selectPilotAgencyFeatures(rawAgency) };
  if (agencySnapshot.features.length === 0) throw new Error("NPS returned no Mist Trail features");

  const osmUrl = new URL(GATE_C_PILOT.osmMapUrl);
  osmUrl.searchParams.set("bbox", GATE_C_PILOT.bbox.join(","));
  const rawOsm = await fetchText(osmUrl);
  await writeFile(resolve(cacheRoot, "osm-raw.osm"), rawOsm);
  const osmElements = selectPilotOsmElements(parseOsmXml(rawOsm));
  const trailWayCount = osmElements.filter(({ type, tags: value }) =>
    type === "way" && GATE_C_PILOT.trailNamePattern.test(String(value?.name ?? ""))).length;
  if (trailWayCount === 0) throw new Error("OSM returned no Mist Trail ways");

  const elevationGrid = await prepareElevationGrid(
    geometryPositions(agencySnapshot.features, osmElements),
    retrievedAt,
  );
  const buildInput = {
    regionId: GATE_C_PILOT.regionId,
    buildTimestamp: retrievedAt,
    agencySnapshots: { nps: "nps.json" },
    osmSnapshotPath: "osm.json",
    elevationGridPath: "3dep-grid.json",
    reconciliationOptions: {
      snapToleranceMeters: 25,
      minimumCoverageRatio: 0.85,
      maximumGapMeters: 40,
    },
  };
  await Promise.all([
    writeFile(resolve(cacheRoot, "nps.json"), pretty(agencySnapshot)),
    writeFile(resolve(cacheRoot, "osm.json"), pretty({ retrievedAt, elements: osmElements })),
    writeFile(resolve(cacheRoot, "3dep-grid.json"), pretty(elevationGrid)),
    writeFile(resolve(cacheRoot, "build-input.json"), pretty(buildInput)),
  ]);
  return {
    cacheDirectory: cacheRoot,
    agencyFeatures: agencySnapshot.features.length,
    osmTrailWays: trailWayCount,
    osmAccessNodes: osmElements.filter(isAccessNode).length,
    elevationCells: elevationGrid.width * elevationGrid.height,
  };
}

async function main() {
  const unknown = process.argv.slice(2).filter((argument) =>
    !argument.startsWith("--cache="));
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}`);
  const cacheDirectory = process.argv.find((argument) => argument.startsWith("--cache="))
    ?.slice("--cache=".length) ?? `.cache/trails/${GATE_C_PILOT.regionId}/gate-c-pilot`;
  const result = await refreshGateCPilot({ cacheDirectory });
  process.stdout.write(
    `Prepared ${result.agencyFeatures} NPS feature(s), ${result.osmTrailWays} OSM trail way(s), ` +
    `${result.osmAccessNodes} access node(s), and ${result.elevationCells} 3DEP cells in ` +
    `${result.cacheDirectory}\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
