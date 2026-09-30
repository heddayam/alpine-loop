/** Offline source-contact comparison. This audits source interpretations, not regional accuracy. */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { NORMALIZATION_VERSION, CoverageSourceStore } from "../lib/coverage/source-store";
import { rectangle } from "../lib/coverage/geometry";
import { ProgressiveGraphStore } from "../lib/data/progressive/store";
import { ConnectedEntryProof } from "../lib/data/progressive/entry-proof";
import { selectProgressiveEdges } from "../lib/data/progressive/publish";
import { compiledEdgesForSegment } from "../lib/data/compiled-edges";
import { distanceMeters } from "../lib/data/metrics";
import { parseOplTags } from "../lib/data/osm/opl";
import { OSM_TOPOLOGY_ADAPTER_VERSION } from "../lib/data/osm/pipeline";
import { countNearbyBuildings } from "../lib/data/building-context";
import { prepareAreaGeometry } from "../lib/graph/geometry";
import type { NormalizedAccessPoint, NormalizedNode, NormalizedWay, CompiledEdge } from "../lib/data/types";
import type { PreparedEntry } from "../lib/data/progressive/entry-proof";
import type { SourceSnapshot } from "../lib/data/adapters";

type Window = { id: string; source: string; context: string; bbox: [number, number, number, number]; contextBbox?: [number, number, number, number] };
type RawWay = { id: string; tags: Record<string, string>; nodeIds: string[] };
type AuditPoint = NormalizedAccessPoint & { lon: number; lat: number };
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_BUILDING_RADIUS_M = 500;
const HISTORICAL_BUILDING_SOURCE_COMMIT = "204f8fb";
const legacyDensityAllows = (point: { nearbyBuildingCount: number }) => point.nearbyBuildingCount < 10;
const usable = (access: string) => access === "public" || access === "unknown";
const argument = (name: string, fallback = "") => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fileHash(path: string): Promise<`sha256:${string}`> { const digest = createHash("sha256"); for await (const part of createReadStream(path)) digest.update(part); return `sha256:${digest.digest("hex")}`; }
async function* lines(path: string) { const input = createReadStream(path); const reader = createInterface({ input, crlfDelay: Infinity }); try { yield* reader; } finally { reader.close(); input.destroy(); } }

/** Observe native RSS directly; no host access to any existing database. */
async function osmium(args: string[]) {
  const started = performance.now(), child = spawn("osmium", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "", peakRssBytes = 0;
  child.stderr.on("data", part => { stderr = (stderr + String(part)).slice(-8192); });
  const timer = setInterval(() => {
    if (!child.pid) return;
    try { const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); if (Number.isFinite(rss)) peakRssBytes = Math.max(peakRssBytes, rss * 1024); } catch { /* Process may exit between samples. */ }
  }, 250);
  try { await new Promise<void>((done, fail) => { child.once("error", fail); child.once("close", code => code === 0 ? done() : fail(new Error(`osmium ${args[0]} failed (${code}): ${stderr}`))); }); }
  finally { clearInterval(timer); }
  return { elapsedMs: performance.now() - started, sampledPeakRssBytes: peakRssBytes || null };
}

export function profileCounts(points: readonly AuditPoint[]) {
  return { inclusiveWithoutDensity: points.filter(point => usable(point.accessState)).length,
    knownWithoutDensity: points.filter(point => point.accessState === "public").length,
    inclusiveWithDensity: points.filter(point => usable(point.accessState) && legacyDensityAllows({ nearbyBuildingCount: point.nearbyBuildingCount! })).length,
    knownWithDensity: points.filter(point => point.accessState === "public" && legacyDensityAllows({ nearbyBuildingCount: point.nearbyBuildingCount! })).length };
}

/** Load one historical detector over the same corrected source/movement projection. */
async function legacyDetector(commit: string, output: string) {
  const original = "lib/data/progressive/portals.ts";
  const source = execFileSync("git", ["show", `${commit}:${original}`], { cwd: ownRoot, encoding: "utf8" });
  const legacyDensity = join(output, "legacy-building-context.ts");
  await writeFile(legacyDensity, "export const BUILDING_RADIUS_M = 500;\nexport const accessPointIsWildEnough = (point: { nearbyBuildingCount: number }) => point.nearbyBuildingCount < 10;\n");
  const translated = source.replace(/from "([^"]+)"/g, (match, spec: string) => {
    if (spec.startsWith("node:")) return match;
    if (spec === "../wilderness") return `from "${pathToFileURL(legacyDensity).href}"`;
    const location = spec.startsWith("@/") ? resolve(ownRoot, spec.slice(2)) : resolve(ownRoot, dirname(original), spec);
    const file = existsSync(`${location}.ts`) ? `${location}.ts` : join(location, "index.ts");
    return `from "${pathToFileURL(file).href}"`;
  });
  const path = join(output, "legacy-detector.ts"); await writeFile(path, translated);
  return await import(pathToFileURL(path).href) as { deriveProgressivePortals: (store: ProgressiveGraphStore, coverage: ReturnType<typeof rectangle>) => Promise<number> };
}

/** Density is a historical research control, never current preparation.
 * Pin its old parser so centroid/relation semantics remain reproducible.
 */
export async function historicalBuildingSource(output:string) {
  const original="lib/coverage/source-store.ts";
  const source=execFileSync("git",["show",`${HISTORICAL_BUILDING_SOURCE_COMMIT}:${original}`],{cwd:ownRoot,encoding:"utf8"});
  const translated=source.replace(/from "([^"]+)"/g,(match,spec:string)=>{
    if(spec.startsWith("node:"))return match;
    const location=spec.startsWith("@/")?resolve(ownRoot,spec.slice(2)):resolve(ownRoot,dirname(original),spec);
    return `from "${pathToFileURL(existsSync(`${location}.ts`)?`${location}.ts`:join(location,"index.ts")).href}"`;
  });
  const file=join(output,"historical-building-source.ts");await writeFile(file,translated);
  return (await import(pathToFileURL(file).href)).CoverageSourceStore as new(path:string,source:SourceSnapshot,geometry:ReturnType<typeof rectangle>)=>{
    import(checkpoint:()=>Promise<void>,options:{lines:AsyncIterable<string>}):Promise<void>;
    buildings(geometry:ReturnType<typeof rectangle>):Iterable<readonly[number,number]>;
    close():void;
  };
}

function sourceIndex(ways: readonly RawWay[]) {
  const index = new Map<string, RawWay[]>();
  for (const way of ways) for (const nodeId of new Set(way.nodeIds)) {
    const incident = index.get(nodeId) ?? []; incident.push(way); index.set(nodeId, incident);
  }
  return index;
}
function tracePoint(point: AuditPoint, incident: Map<string, RawWay[]>, tags: Map<string, Record<string, string>>, nodes: Map<string, NormalizedNode>, ways: Map<string, NormalizedWay>, edges: Map<string, CompiledEdge[]>) {
  const sourceNode = point.nodeId.replace(/^osm-node-/, ""), witness = point.entryWitness;
  const rootNode = witness?.rootNodeId.replace(/^osm-node-/, "");
  const departure = witness?.departurePhysicalId;
  return { ...point, originalNodeTags: tags.get(sourceNode) ?? {}, incidentSourceWays: incident.get(sourceNode) ?? [],
    rootOriginalNodeTags: rootNode ? tags.get(rootNode) ?? {} : null,
    rootNodeFlags: witness ? nodes.get(witness.rootNodeId)?.flags ?? [] : [],
    rootSourceWays: rootNode ? (incident.get(rootNode) ?? []).map(way => ({ ...way, normalized: ways.get(`osm-way-${way.id.slice(1)}`) ?? null })) : [],
    departureMovements: departure ? (edges.get(departure) ?? []).filter(edge => edge.fromNode === point.nodeId).map(edge => ({
      fromNode: edge.fromNode, toNode: edge.toNode, accessState: edge.accessState,
      fromFlags: nodes.get(edge.fromNode)?.flags ?? [], toFlags: nodes.get(edge.toNode)?.flags ?? [],
      originalWay: incident.get(sourceNode)?.find(way => departure.startsWith(`osm-way-${way.id.slice(1)}:`)) ?? null,
    })) : [],
  };
}

/** Buckets retain alternative root facts instead of selecting favorable motor evidence. */
function sourceBreakdown(points: readonly AuditPoint[], incident: Map<string, RawWay[]>, ways: Map<string, NormalizedWay>) {
  const counts: Record<string, number> = {};
  for (const point of points) {
    const witness = point.entryWitness!, root = witness.rootNodeId.replace(/^osm-node-/, "");
    const arrivals = (incident.get(root) ?? []).map(way => ways.get(`osm-way-${way.id.slice(1)}`)).filter((way): way is NormalizedWay => !!way)
      .filter(way => way.flags.some(flag => /^osm-highway:(track|service|residential|unclassified|living_street|tertiary|secondary|primary|road)$/.test(flag)));
    const roles = [...new Set(arrivals.map(way => way.flags.includes("osm-highway:track") ? "track" : way.flags.includes("osm-highway:service") ? "service" : "street"))].sort().join("+") || "place/walking";
    const motor = [...new Set(arrivals.map(way => way.flags.find(flag => flag.startsWith("motor-access:"))?.slice(13) ?? "unknown"))].sort().join("+") || "place/walking";
    const departureWay = (incident.get(point.nodeId.replace(/^osm-node-/, "")) ?? []).find(way => witness.departurePhysicalId.startsWith(`osm-way-${way.id.slice(1)}:`));
    const frontier = (incident.get(point.nodeId.replace(/^osm-node-/, "")) ?? []).filter(way => way.id !== departureWay?.id)
      .filter(way => /^(track|service|residential|unclassified|living_street|tertiary|secondary|primary|road)$/.test(way.tags.highway ?? ""));
    const context = [...new Set(frontier.map(way => way.tags.highway === "track" ? "track" : way.tags.highway === "service" ? "service" : "street"))].sort().join("+") || "walking/place";
    const key = [witness.kind, `root=${roles}`, `frontier=${context}->${departureWay?.tags.highway ?? "unknown"}`, `rootMotor=${motor}`, `foot=${point.accessState}`].join(" | ");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Purely geometric/permission support; null elevation is never passed off as an assessed hike. */
export function cycleComponents(edges: readonly CompiledEdge[], profile: "known" | "inclusive") {
  const physical = new Map<string, CompiledEdge>();
  for (const edge of edges) if (edge.edgeClass === "trail" && (profile === "known" ? edge.accessState === "public" : usable(edge.accessState))) physical.set(edge.stablePhysicalId, edge);
  const incident = new Map<string, CompiledEdge[]>();
  for (const edge of physical.values()) for (const id of new Set([edge.fromNode, edge.toNode])) { const list = incident.get(id) ?? []; list.push(edge); incident.set(id, list); }
  const visited = new Set<string>(), result = new Map<string, { nodeCount: number; physicalSegments: number; lengthMeters: number; undirectedCyclePotential: boolean }>();
  for (const node of incident.keys()) {
    if (visited.has(node)) continue;
    const pending = [node], members: string[] = [], links = new Map<string, CompiledEdge>(); visited.add(node);
    while (pending.length) { const next = pending.pop()!; members.push(next); for (const edge of incident.get(next) ?? []) { links.set(edge.stablePhysicalId, edge); const other = edge.fromNode === next ? edge.toNode : edge.fromNode; if (!visited.has(other)) { visited.add(other); pending.push(other); } } }
    const stats = { nodeCount: members.length, physicalSegments: links.size, lengthMeters: [...links.values()].reduce((sum, edge) => sum + edge.lengthM, 0), undirectedCyclePotential: links.size >= members.length };
    for (const member of members) result.set(member, stats);
  }
  return result;
}

async function auditWindow(window: Window, pbf: string, contentHash: `sha256:${string}`, output: string, legacy: Awaited<ReturnType<typeof legacyDetector>>, BuildingSource:Awaited<ReturnType<typeof historicalBuildingSource>>) {
  const directory = join(output, window.id); await mkdir(directory, { recursive: true });
  const padded = window.contextBbox ?? [window.bbox[0] - .008, window.bbox[1] - .008, window.bbox[2] + .008, window.bbox[3] + .008] as const;
  const extractionIdentity = hash([contentHash, padded, "complete_ways"]), receipt = join(directory, "extract-identity.txt");
  const extracted = join(directory, "source.osm.pbf"), opl = join(directory, "original.opl");
  let extraction: Awaited<ReturnType<typeof osmium>> | { reused: true };
  if (argument("reuse-extracts", "false") === "true" && existsSync(opl) && await readFile(receipt, "utf8").catch(() => "") === extractionIdentity) extraction = { reused: true };
  else { extraction = await osmium(["extract", pbf, "--bbox", padded.join(","), "--strategy", "complete_ways", "--overwrite", "--output", extracted]); await osmium(["cat", extracted, "--output-format", "opl", "--overwrite", "--output", opl]); await writeFile(receipt, extractionIdentity); }
  const source: SourceSnapshot = { id: window.source, authority: "OSM/Geofabrik", dataset: "pinned OSM", version: contentHash, retrievedAt: "pinned receipt", url: "offline cached source", license: "ODbL", contentHash, localPath: pbf };
  const rawWays: RawWay[] = [], rawNodes = new Map<string, Record<string, string>>(); let rawNodeCount = 0;
  for await (const line of lines(opl)) { const fields = line.split(" "), tags = parseOplTags(fields.find(value => value.startsWith("T"))?.slice(1)); if (line[0] === "n") { rawNodeCount++; if (Object.keys(tags).length) rawNodes.set(fields[0]!.slice(1), tags); } else if (line[0] === "w") rawWays.push({ id: fields[0]!, tags, nodeIds: fields.find(value => value.startsWith("N"))?.slice(1).split(",").map(value => value.slice(1)) ?? [] }); }
  const rawPath = join(directory, "raw.sqlite"), stagePath = join(directory, "audit.sqlite"),buildingPath=join(directory,"historical-buildings.sqlite");
  for (const path of [rawPath, stagePath,buildingPath]) for (const suffix of ["", "-wal", "-shm"]) await rm(path + suffix, { force: true });
  const raw = new CoverageSourceStore(rawPath, source, rectangle(padded)), stage = new ProgressiveGraphStore({ stagingPath: stagePath, buildIdentity: extractionIdentity });
  const historical=new BuildingSource(buildingPath,source,rectangle(padded));
  const started = performance.now(), nodeMap = new Map<string, NormalizedNode>(), ways: NormalizedWay[] = [], edges: CompiledEdge[] = [];
  try {
    await raw.import(async () => {}, { lines: lines(opl) });
    stage.transaction(() => { for (const item of raw.context(rectangle(padded))) { if (item.kind === "evidence") stage.putPortalEvidence(item.evidence); else { ways.push(item.way); stage.putWay(item.way); for (const node of item.nodes) { nodeMap.set(node.id, node); stage.putNode(node); } } } });
    await historical.import(async()=>{},{lines:lines(opl)});
    const buildings=[...historical.buildings(rectangle(padded))];
    // Only the pinned historical detector reads these research scratch tables.
    stage.database.exec("CREATE TABLE buildings(id INTEGER PRIMARY KEY,lon REAL NOT NULL,lat REAL NOT NULL,UNIQUE(lon,lat)); CREATE VIRTUAL TABLE building_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat)");
    const put=stage.database.prepare("INSERT OR IGNORE INTO buildings(lon,lat) VALUES (?,?)"),spatial=stage.database.prepare("INSERT OR IGNORE INTO building_spatial SELECT id,lon,lon,lat,lat FROM buildings");
    stage.transaction(()=>{for(const centroid of buildings)put.run(...centroid);spatial.run();});
    const context = prepareAreaGeometry(rectangle(padded));
    stage.transaction(() => { for (const way of ways) if (way.edgeClass === "trail") for (let index = 0; index < way.nodeIds.length - 1; index++) { const a = way.coordinates[index]!, b = way.coordinates[index + 1]!; if (!context.containsSegment(a, b)) continue; const segment = compiledEdgesForSegment(way, index, [a, b], { lengthM: distanceMeters(a, b), gainM: null, lossM: null, maxElevationM: null, maxSustainedGradePct: null, elevationProfile: null }, { nodeFlags: [nodeMap.get(way.nodeIds[index]!)!.flags, nodeMap.get(way.nodeIds[index + 1]!)!.flags] }); edges.push(...segment); for (const edge of segment) stage.putEdge(edge); } });
    await selectProgressiveEdges(stage, rectangle(padded));
    const preparationMs = performance.now() - started, proofStarted = performance.now(), proof = new ConnectedEntryProof(stage.database, async () => {});
    let current: AuditPoint[];
    try { await proof.prepare("measured"); await proof.discover(rectangle(window.bbox)); current = (stage.database.prepare("SELECT node_id,witness FROM portal_candidates ORDER BY node_id").all() as { node_id: string; witness: string }[]).map(row => { const witness = JSON.parse(row.witness) as PreparedEntry, node = nodeMap.get(row.node_id)!; return { id: `portal:${node.id}`, externalId: node.externalId, nodeId: node.id, lon: node.lon, lat: node.lat, name: witness.name ?? "Trailhead", kind: "trailhead", accessState: witness.known ? "public" : "unknown", confidence: "low", parkingEvidence: null, sourceRefs: witness.sourceRefs, entryWitness: witness }; }); }
    finally { proof.clear(); }
    const proofMs = performance.now() - proofStarted, legacyStarted = performance.now();
    await legacy.deriveProgressivePortals(stage, rectangle(padded));
    const selected = prepareAreaGeometry(rectangle(window.bbox));
    const previous = (stage.database.prepare("SELECT record FROM derived_portals ORDER BY node_id").all() as { record: string }[]).map(row => { const point = JSON.parse(row.record) as NormalizedAccessPoint, node = nodeMap.get(point.nodeId)!; return { ...point, lon: node.lon, lat: node.lat }; }).filter(point => selected.containsPoint([point.lon, point.lat]));
    const counts = countNearbyBuildings(buildings, [...current, ...previous], [...nodeMap.values()], LEGACY_BUILDING_RADIUS_M); for (const point of [...current, ...previous]) point.nearbyBuildingCount = counts.get(point.id)!;
    const before = new Map(previous.filter(point => usable(point.accessState)).map(point => [point.nodeId, point])), after = new Map(current.map(point => [point.nodeId, point]));
    const knownCycles = cycleComponents(edges, "known"), inclusiveCycles = cycleComponents(edges, "inclusive");
    const incident = sourceIndex(rawWays), normalizedWays = new Map(ways.map(way => [way.id, way])), movements = new Map<string, CompiledEdge[]>();
    for (const edge of edges) { const list = movements.get(edge.stablePhysicalId) ?? []; list.push(edge); movements.set(edge.stablePhysicalId, list); }
    const changes = [...new Set([...before.keys(), ...after.keys()])].sort().map(nodeId => ({ nodeId, status: before.has(nodeId) ? after.has(nodeId) ? "both" : "old-only" : "new-only", before: before.has(nodeId) ? tracePoint(before.get(nodeId)!, incident, rawNodes, nodeMap, normalizedWays, movements) : null, after: after.has(nodeId) ? tracePoint(after.get(nodeId)!, incident, rawNodes, nodeMap, normalizedWays, movements) : null, knownTopology: knownCycles.get(nodeId) ?? null, inclusiveTopology: inclusiveCycles.get(nodeId) ?? null }));
    const assertions = (stage.database.prepare("SELECT record FROM evidence WHERE kind IN ('parking','trailhead')").all() as { record: string }[]).map(row => JSON.parse(row.record) as { externalId: string; kind: string; nodeIds: string[]; coordinates: Array<readonly [number, number]>; accessState: string }).filter(item => item.coordinates.some(point => selected.containsPoint(point))).map(item => ({ ...item, nominatedNodeIds: item.nodeIds.filter(id => after.has(id)), mappedWayContacts: item.nodeIds.filter(id => ways.some(way => way.nodeIds.includes(id))) }));
    const turningCircles = [...rawNodes].filter(([, tags]) => tags.highway === "turning_circle")
      .map(([id, tags]) => ({ node: nodeMap.get(`osm-node-${id}`), tags }))
      .filter(({ node }) => node && selected.containsPoint([node.lon, node.lat]))
      .map(({ node, tags }) => ({ nodeId: node!.id, originalTags: tags, flags: node!.flags,
        incidentSourceWays: incident.get(node!.id.replace(/^osm-node-/, "")) ?? [], nominated: after.has(node!.id) }));
    const pedestrianDirections = rawWays.filter(way => ["path", "footway", "steps", "bridleway", "pedestrian"].includes(way.tags.highway ?? ""));
    const genericPedestrianOneway = pedestrianDirections.filter(way => way.tags.oneway !== undefined && way.tags["oneway:foot"] === undefined
      && !Object.keys(way.tags).some(key => /^foot:(forward|backward)/.test(key))).map(way => ({
        id: way.id, tags: way.tags, refs: way.nodeIds.length,
        anySourceNodeInsideWindow: normalizedWays.get(`osm-way-${way.id.slice(1)}`)?.coordinates.some(point => selected.containsPoint(point)) ?? false,
      }));
    const areaRoutes = ways.filter(way => way.edgeClass === "trail" && way.flags.includes("area:yes")).map(way => ({ externalId: way.externalId, flags: way.flags, accessState: way.accessState, usableCompiledSegments: edges.filter(edge => edge.stablePhysicalId.startsWith(`${way.id}:`) && usable(edge.accessState)).length }));
    const report = { window, sourceHash: contentHash, originalOplHash: await fileHash(opl), rawNodeCount, rawWayCount: rawWays.length, retainedNodeCount: nodeMap.size, retainedWayCount: ways.length, buildingCentroids: buildings.length, directedSegments: edges.length, pedestrianWays: pedestrianDirections.length, genericPedestrianOneway,
      timings: { extraction, preparationMs, proofMs, legacyMs: performance.now() - legacyStarted }, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      baseline: profileCounts(previous), proposed: profileCounts(current), sourceBreakdown: sourceBreakdown(current, incident, normalizedWays), newOnlyBreakdown: sourceBreakdown(current.filter(point => !before.has(point.nodeId)), incident, normalizedWays), changes, assertions, turningCircles, areaRoutes,
      limitations: ["No independent complete entrance labels: precision/recall unassessable", "Same corrected normalization/movement geometry for both detectors", "No mountain-association, DEM, route suitability, or full-region denominator", "Undirected cycle potential is not a directed or criteria-valid route", "Complete source-way references do not certify complete arrival/parking mapping"] };
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    return { id: window.id, context: window.context, sourceHash: contentHash, rawNodeCount, retainedWayCount: ways.length, directedSegments: edges.length, baseline: report.baseline, proposed: report.proposed, changes: { newOnly: changes.filter(item => item.status === "new-only").length, oldOnly: changes.filter(item => item.status === "old-only").length, both: changes.filter(item => item.status === "both").length }, assertions: assertions.length, areaRoutes, timings: report.timings, processPeakRssBytes: report.processPeakRssBytes };
  } finally { historical.close(); raw.close(); stage.close(); }
}

async function main() {
  const output = resolve(argument("output", ".cache/access-entry-audit")); if (!output.includes(`${join(ownRoot, ".cache")}/`) && !output.startsWith("/private/tmp/")) throw new Error("Use an ignored .cache directory or a temporary directory for audit output");
  await mkdir(output, { recursive: true });
  const windows = JSON.parse(await readFile(resolve(argument("windows", "data/fixtures/access-review/study-windows.json")), "utf8")) as Window[];
  const legacyCommit = argument("legacy-commit", "7894ea3"), legacy = await legacyDetector(legacyCommit, output), BuildingSource=await historicalBuildingSource(output), fingerprints = new Map<string, `sha256:${string}`>();
  const reports = [];
  for (const window of windows) {
    const pbf = resolve(argument(window.source)); if (!argument(window.source)) throw new Error(`Provide --${window.source}=<cached pinned PBF>`);
    let digest = fingerprints.get(pbf); if (!digest) { digest = await fileHash(pbf); fingerprints.set(pbf, digest); }
    console.error(`Auditing ${window.id}: ${window.context}`);
    const report = await auditWindow(window, pbf, digest, output, legacy,BuildingSource); reports.push(report); console.error(JSON.stringify(report));
  }
  const summary = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ownRoot, encoding: "utf8" }).trim(), legacyCommit, historicalBuildingSourceCommit:HISTORICAL_BUILDING_SOURCE_COMMIT, proofSourceHash: await fileHash(join(ownRoot, "lib/data/progressive/entry-proof.ts")), observedAt: new Date().toISOString(), normalizationVersion: NORMALIZATION_VERSION, standaloneAdapterVersion: OSM_TOPOLOGY_ADAPTER_VERSION, windows: reports };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
