import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { type CoveragePlan, type CoverageSnapshot, type CoverageUnit, type PackManifest } from "@/lib/contracts";
import { areaBounds, lineIsInsideArea } from "@/lib/graph/geometry";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { loadInstalledPack, localPackRoot } from "@/lib/packs/installed-pack";
import { withGenerationLock } from "@/lib/packs/generation-pins";
import { readOsmSourceConfig, readPinnedOsmSnapshot, refreshPinnedOsmSnapshot } from "@/lib/data/osm/source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { publishProgressiveGraph } from "@/lib/data/progressive/publish";
import { calculateEdgeMetricsBatch, type EdgeMetrics } from "@/lib/data/metrics";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import { applyRestriction, readCuratedAccessFile } from "@/lib/data/curated-access";
import type { NormalizedWay, Coordinate } from "@/lib/data/types";
import type { CoverageRunnerContext, CoverageRunResult } from "@/lib/coverage-jobs/types";
import { collections, coverageExclusions, coverageSources, legacyRegionIds, planCoverageGeometry } from "./collections";
import { contentId, intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import { CoverageSourceStore } from "./source-store";
import { describeCanonicalElevation, elevationCache, elevationFor, elevationPinsFingerprint } from "./elevation";
import { cleanupCoverageGenerations } from "./retention";
import { reconcileInventory } from "./inventory";
import { coverageNamedAreas } from "./named-areas";
import { CoverageResourceGuard } from "./resources";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION as DEM_METRIC_ALGORITHM_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
import { readOfficialTrailSourceConfig, readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot } from "@/lib/data/official-trails/source";
import { auditOfficialTrailReferences, officialSourceEnvelope, type OfficialReferenceAudit } from "./references";
import type { SourceSnapshot } from "@/lib/data/adapters";

import { COVERAGE_PACK_ID, COVERAGE_BUILD_VERSION as BUILD_VERSION, installedSnapshot } from "./planning";
export { COVERAGE_PACK_ID, installedSnapshot, catalog, plan } from "./planning";
const preparationRoot = () => path.resolve(/* turbopackIgnore: true */ process.env.ALPINE_COVERAGE_ROOT ?? ".local-data/coverage");
const cacheRoot = () => path.resolve(/* turbopackIgnore: true */ process.env.ALPINE_SOURCE_CACHE ?? ".cache/sources");

function segmentTouches(line: Coordinate[], [west,south,east,north]: readonly number[]): boolean {
  return Math.max(line[0]![0],line[1]![0]) >= west! && Math.min(line[0]![0],line[1]![0]) <= east!
    && Math.max(line[0]![1],line[1]![1]) >= south! && Math.min(line[0]![1],line[1]![1]) <= north!;
}

/** Whole eligible segments can cross installation seams but not the supported outer boundary. */
async function metricArea(raws: CoverageSourceStore[], geometry: CoverageUnit["geometry"], eligible: CoverageUnit["geometry"], checkpoint: () => Promise<void>): Promise<CoverageUnit["geometry"] | null> {
  const bounds=areaBounds(geometry);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity, steps=0;
  for (const raw of raws) for (const {way} of raw.ways(geometry)) {
    if (way.edgeClass !== "trail") continue;
    for (let index=1;index<way.coordinates.length;index++) {
      if (++steps % 1000 === 0) await checkpoint();
      const line=way.coordinates.slice(index-1,index+1);
      if (!segmentTouches(line,bounds) || !lineIsInsideArea(line,eligible)) continue;
      for (const [x,y] of line) { minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y); }
    }
  }
  return Number.isFinite(minX) ? rectangle([Math.floor(minX),Math.floor(minY),Math.floor(maxX)+1,Math.floor(maxY)+1]) : null;
}

/** The same durable runner is used by the app and CLI; publication alone changes the active graph. */
export async function run(plan: CoveragePlan, context: CoverageRunnerContext): Promise<CoverageRunResult> {
  return runAttempt(plan,context,true);
}
class ChangedMetricInputs extends Error {}
async function runAttempt(plan: CoveragePlan, context: CoverageRunnerContext, retryChangedMetrics: boolean): Promise<CoverageRunResult> {
  const root = preparationRoot();
  await mkdir(root, { recursive: true });
  let store!: ReturnType<typeof openProgressiveGraphStore>;
  let inputFingerprint = "";
  let stageKey = "";
  let demFingerprint = "";
  const unitContents = async (id: string) => {
    const hash = createHash("sha256");
    let rowCount = 0;
    for (const row of store!.database.prepare("SELECT e.id,e.record FROM edges e JOIN unit_edges u ON u.edge=e.id WHERE u.unit=? ORDER BY e.id").iterate(id) as Iterable<{id:string;record:string}>) {
      hash.update(`${row.id.length}:${row.id}${row.record.length}:${row.record}`); rowCount++;
      if (rowCount % 1000 === 0) await check();
    }
    return { rowCount, contentHash: hash.digest("hex") };
  };
  let units = structuredClone(plan.units);
  let snapshot = await installedSnapshot();
  const previousSnapshot = snapshot;
  let rebuilding = false;
  let requiredOldUnits = new Set<string>();
  const requestedCoverage = snapshot ? unionCoverage([snapshot.geometry, plan.geometry]) : plan.geometry;
  const prepared: CoverageUnit[] = [];
  const rawStores: CoverageSourceStore[] = [];
  const close = () => { for (const raw of rawStores.splice(0)) raw.close(); store?.close(); store=undefined!; };
  const referenceSources: { snapshot: SourceSnapshot; osmId: string; envelope: readonly [number, number, number, number] }[] = [];
  const demCache = elevationCache();
  const resources = new CoverageResourceGuard({ memoryLimitBytes: plan.request.memoryLimitMiB * 1024 ** 2, diskPaths: [root, localPackRoot()] });
  resources.start();
  const check = async () => {
    await setImmediate();
    await resources.checkpoint();
    const control = await context.checkpoint();
    if (context.signal.aborted || control === "pause" || control === "cancel") throw new Error("Coverage build interrupted at a checkpoint");
  };
  const report = (stage: string) => context.report({ stage, units, completedUnits: units.filter((unit) => ["prepared", "installed"].includes(unit.status)).length, snapshot });
  const oldAreaReady = () => {
    if (!rebuilding || requiredOldUnits.size) return false;
    if (!prepared.length || subtractCoverage(previousSnapshot!.geometry, unionCoverage(prepared.map((unit) => unit.geometry))))
      throw new Error("Rebuilt units do not cover all previously installed coverage; active installation remains unchanged");
    return true;
  };
  const publish = async () => {
    if (!prepared.length) return;
    await check();
    const geometry = unionCoverage([...(snapshot ? [snapshot.geometry] : []), ...prepared.map((unit) => unit.geometry)]);
    await report("Recomputing combined trailheads and connectivity");
    await store!.derivePortals(geometry, check);
    const publishedMetricArea = await metricArea(rawStores,geometry,geometry,check);
    const finalElevation = publishedMetricArea ? await describeCanonicalElevation(publishedMetricArea, cacheRoot(), root, demCache) : null;
    demFingerprint = finalElevation?.productFingerprint ?? "no-trail-metrics";
    if (finalElevation) store!.putSource(finalElevation.source);
    // A DEM mosaic supersedes earlier mosaics; graph records refer to OSM
    // sources, so only the final raster receipt belongs in the publication.
    store!.database.prepare("DELETE FROM sources WHERE id LIKE 'usgs-dem-%' AND id<>?").run(finalElevation?.source.id ?? "");
    const currentSources = [...store!.database.prepare("SELECT record FROM sources ORDER BY id").iterate()]
      .map((row) => JSON.parse(String(row.record)) as PackManifest["sources"][number]);
    const metadata = await coverageNamedAreas({ geometry, collections: await collections(), sources: currentSources });
    const sources = metadata.sources;
    for (const source of sources) store!.putSource({ ...source, contentHash: source.contentHash as `sha256:${string}`, localPath: "" });
    const sourceFingerprint = contentId({ sources, version: BUILD_VERSION });
    const unitIds = [...new Set([...(snapshot?.unitIds ?? []), ...prepared.map((unit) => unit.id)])].sort();
    const dataVersion = `coverage-${contentId({ geometry, sourceFingerprint, unitIds, namedAreas: metadata.namedAreas, searchRegions: metadata.searchRegions }).slice(0, 24)}`;
    const createdAt = sources.map((source) => source.retrievedAt).sort().at(-1)!;
    const next: CoverageSnapshot = { schemaVersion: 1, id: COVERAGE_PACK_ID, dataVersion, geometry, unitIds, createdAt, sourceFingerprint, auditStatus: "passed", limitations: plan.warnings };
    const bbox = areaBounds(geometry);
    const manifest: PackManifest = { schemaVersion: "6", id: COVERAGE_PACK_ID, name: "Installed coverage", dataVersion, builtAt: createdAt,
      compilerVersion: BUILD_VERSION, metricAlgorithmVersion: DEM_METRIC_ALGORITHM_VERSION, coverage: { boundary: geometry, bbox: [...bbox] },
      display: { center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], zoom: 8 },
      capabilities: { elevation: true, officialAccess: false, namedAreas: true, closedRouteTopology: true, batchSearchRegions: true, elevationProfiles: true, portalAccessPoints: true },
      fieldConfidence: { topology: "high", access: "medium", elevation: "high" }, sources,
      closedRouteTopology: { runtimeMode: "reachable-graph-fallback", algorithmVersion: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION, policyVersion: "closed-route-decision-graph-v1", profiles: ["known", "inclusive"] } };
    await report("Auditing and publishing installed coverage");
    const inventory: Awaited<ReturnType<typeof reconcileInventory>>[] = [];
    for (const raw of rawStores) inventory.push(await reconcileInventory(raw, store!, geometry, check));
    const references: OfficialReferenceAudit[] = [];
    for (const raw of rawStores) {
      const applicable = referenceSources.filter((reference) => reference.osmId === raw.source.id && intersectCoverage(requestedCoverage, rectangle(reference.envelope)));
      if (!applicable.length) references.push(await auditOfficialTrailReferences({ checkpoint: check, osm: raw, coverage: requestedCoverage, installedCoverage: geometry }));
      for (const reference of applicable) references.push(await auditOfficialTrailReferences({ checkpoint: check, osm: raw, coverage: requestedCoverage, installedCoverage: geometry, officialSnapshot: reference.snapshot, sourceEnvelope: reference.envelope }));
    }
    const frontierCount = inventory.reduce((count, item) => count + item.frontierCount, 0);
    const crossingCount = inventory.reduce((count, item) => count + item.crossingSegmentCount, 0);
    const referenceGaps = references.reduce((count, item) => count + item.unresolved.length, 0);
    const unsupportedContext = inventory.reduce((count,item) => count + item.dispositions.reduce((sum,row) => sum + (row.disposition === "unsupported" ? Number(row.count) : 0),0),0);
    next.limitations = [...next.limitations,
      ...(unsupportedContext ? [`The source inventory contains ${unsupportedContext} unsupported building relations. Building-based trailhead filtering may be incomplete; individual reasons are recorded in the inventory.`] : []),
      ...(frontierCount ? [`${frontierCount} mapped trail connections reach uninstalled coverage. Their source identities and locations are recorded in the coverage inventory.`] : []),
      ...(crossingCount ? [`${crossingCount} source trail segments cross the installed boundary and are not yet routable in full. Their locations are recorded in the coverage inventory.`] : []),
      ...(referenceGaps ? [`${referenceGaps} independent reference features have unresolved source coverage differences; installation completeness does not resolve these source limitations.`] : []),
      ...(references.some(item => item.status !== "audited") ? ["Independent reference data does not cover the entire installed area."] : []),
    ];
    await publishProgressiveGraph(store!, { checkpoint: check, onProgress: report, outputRoot: localPackRoot(), manifest, namedAreas: metadata.namedAreas, searchRegions: metadata.searchRegions,
      commitPublication: async (activate) => {
        await check();
        const lockedActivate = () => withGenerationLock(localPackRoot(), async () => { await activate(); });
        if (context.commitPublication) await context.commitPublication(lockedActivate);
        else await lockedActivate();
      },
      beforePublish: async (result) => {
        await check();
        await writeJsonAtomically(path.join(result.packDirectory, "coverage-snapshot.json"), next);
        await writeJsonAtomically(path.join(result.packDirectory, "coverage-generation.json"), { inputFingerprint, demFingerprint, stageKey });
        await writeJsonAtomically(path.join(result.packDirectory, "coverage-inventory.json"), inventory);
        await writeJsonAtomically(path.join(result.packDirectory, "coverage-references.json"), references);
      },
    });
    snapshot = next;
    for (const unit of prepared) unit.status = "installed";
    prepared.length = 0;
    await report("Coverage published");
    try { await cleanupCoverageGenerations({ deleteEligible: true }); }
    catch (error) { await report(`Old generations retained: ${(error as Error).message}`); }
  };
  try {
    const restrictions = [];
    for (const region of legacyRegionIds) {
      try { restrictions.push(await readCuratedAccessFile(path.resolve(`data/regions/${region}/access-restrictions.json`))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const configuredSources = (await coverageSources()).filter((source) => intersectCoverage(source.geometry, requestedCoverage));
    const exclusions = await coverageExclusions();
    const coveragePlan = planCoverageGeometry(requestedCoverage, configuredSources, exclusions);
    const supportedCoverage = coveragePlan.supported;
    for (const region of legacyRegionIds) {
      let config;
      try { config = await readOfficialTrailSourceConfig(path.resolve(`data/regions/${region}/official-trail-source.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const envelope = officialSourceEnvelope(config);
      if (!intersectCoverage(requestedCoverage, rectangle(envelope))) continue;
      const snapshot = await readPinnedOfficialTrailSnapshot(cacheRoot(), config).catch(async (error: unknown) => {
        if (plan.request.offline && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        if (plan.request.offline) throw error;
        return (await refreshPinnedOfficialTrailSnapshot(cacheRoot(), config)).snapshot;
      });
      if (!snapshot) continue;
      const osm = await readOsmSourceConfig(path.resolve(`data/regions/${region}/osm-source.json`));
      referenceSources.push({ snapshot, envelope, osmId: osm.id });
    }
    for (const source of configuredSources) {
      if (rawStores.some((raw) => raw.source.id === source.config.id)) continue;
      await report(`Verifying ${source.config.dataset}`);
      const input = await readPinnedOsmSnapshot(cacheRoot(), source.config).catch(async (error: unknown) => {
        if (plan.request.offline) throw error;
        return (await refreshPinnedOsmSnapshot(cacheRoot(), source.config)).snapshot;
      });
      const raw = new CoverageSourceStore(path.join(root, `source-${input.contentHash.slice(7)}.sqlite`), input);
      rawStores.push(raw);
      await report(`Inventorying ${source.config.dataset}`);
      await raw.import(check, { onStage: async (stage) => {
        const label = stage === "context-promotion" ? "Resolving connected trail context"
          : stage === "integrity-check" ? "Verifying source inventory" : "Verifying source checkpoints";
        await report(`${label}: ${source.config.dataset}`);
      } });
    }
    const requestedMetricArea = supportedCoverage ? await metricArea(rawStores, supportedCoverage, supportedCoverage, check) : null;
    const pinnedDem = requestedMetricArea ? await elevationPinsFingerprint(cacheRoot(), requestedMetricArea, demCache) : "no-trail-metrics";
    const durable = (source: SourceSnapshot) => {
      const record = { ...source };
      delete (record as Partial<SourceSnapshot>).localPath;
      return record;
    };
    const sourceIdentity = {
      version: BUILD_VERSION, metricVersion: DEM_METRIC_ALGORITHM_VERSION, topologyVersion: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION,
      osm: rawStores.map((raw) => durable(raw.source)).sort((a, b) => a.id.localeCompare(b.id)),
      sourceCoverage: configuredSources.map((source) => [source.config, source.geometry]).sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
      exclusions,
      restrictions: restrictions.map((item) => durable(item.snapshot)).sort((a, b) => a.id.localeCompare(b.id)),
      references: referenceSources.map((item) => durable(item.snapshot)).sort((a, b) => a.id.localeCompare(b.id)),
    };
    // Cache metrics by their own inputs, so adding distant DEM pins can rebuild
    // staging without recalculating unchanged source segments.
    const metricSourceFingerprint = contentId({ version: BUILD_VERSION, metricVersion: DEM_METRIC_ALGORITHM_VERSION,
      osm: sourceIdentity.osm, restrictions: sourceIdentity.restrictions });
    inputFingerprint = contentId({ ...sourceIdentity, pinnedDem });
    let installedGeneration: {inputFingerprint:string;demFingerprint:string;stageKey:string} | null = null;
    if (snapshot) {
      const installed = await loadInstalledPack(COVERAGE_PACK_ID);
      try {
        const marker = JSON.parse(await readFile(path.join(installed!.directory, "coverage-generation.json"), "utf8")) as Record<string,unknown>;
        if (typeof marker.inputFingerprint === "string" && typeof marker.demFingerprint === "string" &&
          typeof marker.stageKey === "string" && /^graph-[a-f0-9-]+$/.test(marker.stageKey))
          installedGeneration = { inputFingerprint: marker.inputFingerprint, demFingerprint: marker.demFingerprint, stageKey: marker.stageKey };
      } catch { /* Older or invalid metadata requires rebuilding the installed union. */ }
    }
    const priorMetricArea = snapshot ? await metricArea(rawStores,snapshot.geometry,snapshot.geometry,check) : null;
    const priorDemFingerprint = snapshot
      ? priorMetricArea ? (await describeCanonicalElevation(priorMetricArea, cacheRoot(), root, demCache))?.productFingerprint ?? "no-trail-metrics" : "no-trail-metrics"
      : null;
    let stagePresent = false;
    if (installedGeneration) {
      try { stagePresent = (await stat(path.join(root, `${installedGeneration.stageKey}.sqlite`))).isFile(); }
      catch { /* The published pack is complete; a missing stage is rebuilt. */ }
    }
    const compatible = snapshot && stagePresent && installedGeneration?.inputFingerprint === inputFingerprint && installedGeneration.demFingerprint === priorDemFingerprint;
    stageKey = compatible ? installedGeneration!.stageKey : snapshot
      ? `graph-${inputFingerprint}-${contentId(priorDemFingerprint).slice(0,16)}`
      : `graph-${inputFingerprint}`;
    if (snapshot && !compatible) {
      const oldGeometry = snapshot.geometry;
      if (!supportedCoverage || subtractCoverage(oldGeometry, supportedCoverage))
        throw new Error("Changed source coverage cannot rebuild every installed area; existing installation remains active");
      const oldUnits = coveragePlan.units.filter((unit) => unit.status !== "unavailable" && intersectCoverage(unit.geometry, oldGeometry));
      requiredOldUnits = new Set(oldUnits.map((unit) => unit.id));
      units = [...oldUnits, ...coveragePlan.units.filter((unit) => !requiredOldUnits.has(unit.id))];
      snapshot = null;
      rebuilding = true;
      await report("Source inputs changed; rebuilding installed coverage before activation");
    }
    store = openProgressiveGraphStore({ stagingPath: path.join(root, `${stageKey}.sqlite`), buildIdentity: stageKey });
    store.database.exec("CREATE TABLE IF NOT EXISTS unit_edges(unit TEXT NOT NULL,edge TEXT NOT NULL,PRIMARY KEY(unit,edge)) STRICT");
    if (compatible && snapshot) for (const id of snapshot.unitIds) {
      const receipt = store.getReceipt(`unit:${id}`);
      const actual = await unitContents(id);
      if (!receipt || receipt.rowCount !== actual.rowCount || receipt.contentHash !== actual.contentHash)
        throw new Error(`Installed staging checkpoint ${id} failed verification; active coverage remains unchanged`);
    }
    for (const restriction of restrictions) store.putSource(restriction.snapshot);
    for (const reference of referenceSources) store.putSource(reference.snapshot);
    for (const raw of rawStores) store.putSource(raw.source);
    for (const unit of units) {
      if (unit.status === "unavailable") continue;
      if (snapshot?.unitIds.includes(unit.id)) { unit.status = "installed"; continue; }
      const receipt = store.getReceipt(`unit:${unit.id}`);
      if (context.publishOnly && !receipt) continue;
      const unitBounds = areaBounds(unit.geometry);
      const requiredDem = supportedCoverage ? await metricArea(rawStores,unit.geometry,supportedCoverage,check) : null;
      const elevation = requiredDem ? await elevationFor({...unit,geometry:requiredDem}, cacheRoot(), root, plan.request.offline, demCache) : null;
      if (elevation) store.putSource(elevation.source);
      const fingerprint = contentId({ inputFingerprint, elevation: elevation?.productFingerprint ?? "no-trail-metrics", unit: unit.id });
      const metricFingerprint = contentId({ source: metricSourceFingerprint, elevation: elevation?.productFingerprint ?? "no-trail-metrics" });
      if (receipt) {
        // A receipt covers metric edges. Re-read cheap source context so missing
        // or conflicting ways, nodes, buildings, and evidence cannot be hidden.
        for (const raw of rawStores) {
          for (const building of raw.buildings(unit.geometry)) store.putBuilding(building);
          for (const item of raw.ways(unit.geometry)) {
            let way = item.way;
            for (const source of restrictions) {
              const restriction = source.restrictions.find((entry) => entry.externalId === way.externalId);
              if (restriction) way = applyRestriction(way, restriction, source.snapshot.id);
            }
            store.transaction(() => { for (const node of item.nodes) store.putNode(node); store.putWay(way); });
          }
          for (const evidence of raw.evidence(unit.geometry)) store.putPortalEvidence(evidence);
        }
        const actual = await unitContents(unit.id);
        if (receipt.rowCount !== actual.rowCount || receipt.contentHash !== actual.contentHash) {
          throw new Error(`Installation checkpoint ${unit.id} failed verification`);
        }
        if (receipt.fingerprint !== fingerprint) throw new ChangedMetricInputs(`Elevation inputs changed for ${unit.id}`);
        unit.status = "prepared"; prepared.push(unit);
      }
      else if (!context.publishOnly) {
        await check();
        unit.status = "processing";
        await report(`Preparing installation unit ${unit.id}`);
        for (const raw of rawStores) {
          for (const building of raw.buildings(unit.geometry)) store.putBuilding(building);
          let pending: { way: NormalizedWay; segment: number; geometry: Coordinate[] }[] = [];
          const flush = async () => {
            if (!pending.length) return;
            const metrics: EdgeMetrics[] = [];
            const missing: number[] = [];
            for (let index = 0; index < pending.length; index++) {
              const edge = pending[index]!;
              const cached = raw.db.prepare("SELECT value FROM metrics WHERE id=? AND fingerprint=?").get(`${edge.way.id}:${edge.segment}`, metricFingerprint);
              if (cached) metrics[index] = JSON.parse(String(cached.value)) as EdgeMetrics;
              else missing.push(index);
            }
            const calculated = await calculateEdgeMetricsBatch(missing.map((index) => pending[index]!.geometry), elevation!.sampler);
            for (let offset = 0; offset < missing.length; offset++) {
              const index = missing[offset]!, edge = pending[index]!;
              metrics[index] = calculated[offset]!;
              raw.db.prepare("INSERT OR REPLACE INTO metrics VALUES(?,?,?)").run(`${edge.way.id}:${edge.segment}`, metricFingerprint, JSON.stringify(metrics[index]));
            }
            store.transaction(() => pending.forEach(({ way, segment, geometry }, index) => {
              const metric = metrics[index]!;
              if (!metric.elevationProfile) throw new Error(`Missing elevation on ${way.externalId}`);
              store.setNodeElevation(way.nodeIds[segment]!, metric.elevationProfile[0]!.elevationMeters);
              store.setNodeElevation(way.nodeIds[segment + 1]!, metric.elevationProfile.at(-1)!.elevationMeters);
              for (const edge of compiledEdgesForSegment(way, segment, geometry, metric)) {
                store.putEdge(edge);
                store.database.prepare("INSERT OR IGNORE INTO unit_edges VALUES(?,?)").run(unit.id, edge.id);
              }
            }));
            pending = [];
            await check();
          };
          for (const item of raw.ways(unit.geometry)) {
            let way = item.way;
            for (const source of restrictions) {
              const restriction = source.restrictions.find((entry) => entry.externalId === way.externalId);
              if (restriction) way = applyRestriction(way, restriction, source.snapshot.id);
            }
            store.transaction(() => { for (const node of item.nodes) store.putNode(node); store.putWay(way); });
            if (way.edgeClass !== "trail") continue;
            for (let segment = 0; segment < way.nodeIds.length - 1; segment++) {
              const geometry = way.coordinates.slice(segment, segment + 2);
              // Keep complete source segments spanning adjacent units. Publication applies the installed union.
              if (!supportedCoverage || !segmentTouches(geometry,unitBounds) || !lineIsInsideArea(geometry,supportedCoverage)) continue;
              pending.push({ way, segment, geometry });
              if (pending.length >= 500) await flush();
            }
          }
          await flush();
          for (const evidence of raw.evidence(unit.geometry)) store.putPortalEvidence(evidence);
        }
        store.putReceipt({ stage: `unit:${unit.id}`, fingerprint, ...await unitContents(unit.id) });
        unit.status = "prepared"; prepared.push(unit);
        await report(`Prepared ${unit.id}`);
      }
      if (rebuilding) {
        if (unit.status === "prepared") requiredOldUnits.delete(unit.id);
        if (!context.publishOnly && oldAreaReady()) { await publish(); rebuilding = false; }
      } else if (!context.publishOnly && (!snapshot || prepared.length >= 8)) await publish();
    }
    if (rebuilding && !oldAreaReady()) {
      return { snapshot: previousSnapshot, units, completedUnits: units.filter((unit) => unit.status === "prepared").length, status: "paused" };
    }
    await publish();
    return { snapshot, units, completedUnits: units.filter((unit) => unit.status === "installed").length, status: context.publishOnly ? "paused" : "completed" };
  } catch (error) {
    if (!(error instanceof ChangedMetricInputs) || !retryChangedMetrics) throw error;
    // Staging is disposable; immutable published generations stay active. A
    // missing stage makes the retry rebuild the installed union before activation.
    // Verified source and metric caches retain unchanged work.
    close(); await resources.stop();
    for (const suffix of ["","-wal","-shm"]) await rm(path.join(root,`${stageKey}.sqlite${suffix}`),{force:true});
    await context.report({stage:"Elevation inputs changed; replaying affected preparation"});
    return runAttempt(plan,context,false);
  } finally { close(); await resources.stop(); }
}
