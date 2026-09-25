import type { BuildRecipe } from "./recipe";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { PackManifest } from "@/lib/contracts";
import type { CoveragePlan, CoverageSnapshot, CoverageUnit } from "./types";
import { areaBounds, lineIsInsideArea } from "@/lib/graph/geometry";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { DatabaseSync } from "node:sqlite";
import { createPreparedSchema } from "@/lib/data/sqlite-writer";
import { exportPreparedRelease, preparedReleaseId } from "@/lib/data/prepared-release";
import { writeProgressiveTopology } from "@/lib/data/progressive/topology";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { readOsmSourceConfig, readPinnedOsmSnapshot, refreshPinnedOsmSnapshot } from "@/lib/data/osm/source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { insertGraph, selectProgressiveEdges } from "@/lib/data/progressive/publish";
import { calculateEdgeMetricsBatch, type EdgeMetrics } from "@/lib/data/metrics";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import { applyRestriction, readCuratedAccessFile } from "@/lib/data/curated-access";
import type { NormalizedWay, NormalizedNode, Coordinate } from "@/lib/data/types";
import type { CoverageRunnerContext, CoverageRunResult } from "./types";
import { coverageExclusions, coverageSources, legacyRegionIds, planCoverageGeometry } from "./collections";
import { contentId, intersectCoverage, rectangle, unionCoverage } from "./geometry";
import { CoverageSourceStore, sourceStoreFileName } from "./source-store";
import { describeCanonicalElevation, elevationCache, elevationFor, elevationPinsFingerprint } from "./elevation";
import { classifyIntendedInventory, reconcileInventory } from "./inventory";
import { preparedNamedAreas } from "./named-areas";
import { CoverageResourceGuard } from "./resources";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION as DEM_METRIC_ALGORITHM_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
import { readOfficialTrailSourceConfig, readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot } from "@/lib/data/official-trails/source";
import { auditOfficialTrailReferences, officialSourceEnvelope, type OfficialReferenceAudit } from "./references";
import type { SourceSnapshot } from "@/lib/data/adapters";

import { COVERAGE_PACK_ID, COVERAGE_BUILD_VERSION as BUILD_VERSION } from "./planning";
export { COVERAGE_PACK_ID, plan } from "./planning";
const preparationRoot = () => path.resolve(/* turbopackIgnore: true */ process.env.ALPINE_COVERAGE_ROOT ?? ".local-data/coverage");
const releaseRoot = () => path.resolve(process.env.ALPINE_RELEASE_ROOT ?? ".local-data/releases/prepared");
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
    if (++steps % 1000 === 0) await checkpoint();
    if (way.edgeClass !== "trail") continue;
    for (let index=1;index<way.coordinates.length;index++) {
      if (++steps % 1000 === 0) await checkpoint();
      const line=way.coordinates.slice(index-1,index+1);
      if (!segmentTouches(line,bounds) || !lineIsInsideArea(line,eligible)) continue;
      for (const [x,y] of line) { minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y); }
    }
  }
  return Number.isFinite(minX) ? rectangle([Math.floor(minX),Math.ceil(minY)-1,Math.floor(maxX)+1,Math.ceil(maxY)]) : null;
}

/** Developer-only resumable build; a release appears only after every unit completes. */
export async function run(plan: CoveragePlan, context: CoverageRunnerContext, recipe?: BuildRecipe): Promise<CoverageRunResult> {
  return runAttempt(plan,context,true,recipe);
}
class ChangedMetricInputs extends Error {}
async function runAttempt(plan: CoveragePlan, context: CoverageRunnerContext, retryChangedMetrics: boolean, recipe?: BuildRecipe): Promise<CoverageRunResult> {
  const root = preparationRoot();
  await mkdir(root, { recursive: true });
  let store!: ReturnType<typeof openProgressiveGraphStore>;
  let inputFingerprint = "";
  let stageKey = "";
  const unitContents = async (id: string) => {
    const hash = createHash("sha256");
    let rowCount = 0;
    for (const row of store!.database.prepare("SELECT e.id,e.record FROM edges e JOIN unit_edges u ON u.edge=e.id WHERE u.unit=? ORDER BY e.id").iterate(id) as Iterable<{id:string;record:string}>) {
      hash.update(`${row.id.length}:${row.id}${row.record.length}:${row.record}`); rowCount++;
      if (rowCount % 1000 === 0) await check();
    }
    return { rowCount, contentHash: hash.digest("hex") };
  };
  const units = structuredClone(plan.units);
  let snapshot: CoverageSnapshot | null = null;
  const requestedCoverage = plan.geometry;
  const prepared: CoverageUnit[] = [];
  const rawStores: CoverageSourceStore[] = [];
  const close = () => { for (const raw of rawStores.splice(0)) raw.close(); store?.close(); store=undefined!; };
  const referenceSources: { snapshot: SourceSnapshot; osmId: string; envelope: readonly [number, number, number, number] }[] = [];
  const demCache = elevationCache();
  const resources = new CoverageResourceGuard({ memoryLimitBytes: plan.request.memoryLimitMiB * 1024 ** 2, diskPaths: [root, releaseRoot()] });
  resources.start();
  const check = async () => {
    await setImmediate();
    await resources.checkpoint();
    const control = await context.checkpoint();
    if (context.signal.aborted || control === "pause" || control === "cancel") throw new Error("Coverage build interrupted at a checkpoint");
  };
  const report = (stage: string) => context.report({ stage, units, completedUnits: units.filter((unit) => ["prepared", "installed"].includes(unit.status)).length, snapshot });
  const publish = async () => {
    if (!prepared.length) return;
    await check();
    const geometry = unionCoverage(prepared.map((unit) => unit.geometry));
    await report("Recomputing combined trailheads and connectivity");
    await store!.derivePortals(geometry, check);
    const publishedMetricArea = await metricArea(rawStores,geometry,geometry,check);
    const finalElevation = publishedMetricArea ? await describeCanonicalElevation(publishedMetricArea, cacheRoot(), root, demCache) : null;
    if (finalElevation) store!.putSource(finalElevation.source);
    // A DEM mosaic supersedes earlier mosaics; graph records refer to OSM
    // sources, so only the final raster receipt belongs in the publication.
    store!.database.prepare("DELETE FROM sources WHERE id LIKE 'usgs-dem-%' AND id<>?").run(finalElevation?.source.id ?? "");
    const currentSources = [...store!.database.prepare("SELECT record FROM sources ORDER BY id").iterate()]
      .map((row) => JSON.parse(String(row.record)) as PackManifest["sources"][number]);
    const metadata = await preparedNamedAreas({ geometry, sources: currentSources, snapshots: rawStores.map(raw=>raw.source), preparationRoot: root, regionIds: recipe?.reviewedRegionIds });
    const sources = metadata.sources;
    for (const source of sources) store!.putSource({ ...source, contentHash: source.contentHash as `sha256:${string}`, localPath: "" });
    const sourceFingerprint = contentId({ sources, version: BUILD_VERSION, metricVersion: DEM_METRIC_ALGORITHM_VERSION, topologyVersion: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION });
    const unitIds = [...new Set([...([]), ...prepared.map((unit) => unit.id)])].sort();
    const dataVersion = `coverage-${contentId({ geometry, sourceFingerprint, unitIds, namedAreas: metadata.namedAreas, searchRegions: metadata.searchRegions }).slice(0, 24)}`;
    const createdAt = sources.map((source) => source.retrievedAt).sort().at(-1)!;
    const next: CoverageSnapshot = { schemaVersion: 1, id: COVERAGE_PACK_ID, dataVersion, geometry, unitIds, createdAt, sourceFingerprint, auditStatus: "passed", limitations: recipe?.limitations ?? [] };
    await report("Reconciling source inventory");
    const inventory: Awaited<ReturnType<typeof reconcileInventory>>[] = [];
    for (const raw of rawStores) inventory.push(await reconcileInventory(raw, store!, geometry, check));
    const references: OfficialReferenceAudit[] = [];
    await report("Comparing independent reference inventories");
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
    const outputRoot=releaseRoot();
    await mkdir(outputRoot,{recursive:true});
    const databasePath=path.join(root,`${stageKey}-complete.sqlite`);
    const selectedRegions=new Set(metadata.searchRegions.map(item=>item.namedAreaId));
    const exportOptions={databasePath,outputRoot,geometry,sources,
      regions:metadata.namedAreas.filter(area=>selectedRegions.has(area.id)).map(({id,name,geometry,aliases,sourceIds})=>({id,name,geometry,aliases,sourceIds})),
      builtAt:createdAt,compilerVersion:`prepared-v2:${BUILD_VERSION}`,metricAlgorithmVersion:DEM_METRIC_ALGORITHM_VERSION,limitations:next.limitations,checkpoint:check};
    await rm(databasePath,{force:true});
    const db=new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
      createPreparedSchema(db);
      await selectProgressiveEdges(store!,geometry,check);
      await insertGraph(store!,db,topologySha256(geometry),new Set(sources.map(source=>source.id)),check);
      await writeProgressiveTopology(db,check);
      db.prepare("INSERT INTO metadata VALUES ('schemaVersion','7')").run();
      db.prepare("INSERT INTO metadata VALUES ('releaseId',?)").run(preparedReleaseId(exportOptions));
      const add=db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)");
      for(const source of sources) add.run(source.id,source.authority,source.dataset,source.version,source.retrievedAt,source.url,source.license,source.contentHash);
    } finally {db.close();}
    await writeJsonAtomically(path.join(outputRoot,"inventory.json"),inventory);
    await writeJsonAtomically(path.join(outputRoot,"references.json"),references);
    const release=await exportPreparedRelease(exportOptions);
    snapshot={...next,dataVersion:release.id};
    for(const unit of prepared) unit.status="installed";
    prepared.length=0;
    await report("Coherent release exported");
  };
  try {
    const restrictions: Awaited<ReturnType<typeof readCuratedAccessFile>>[] = [];
    for (const region of recipe?.reviewedRegionIds ?? legacyRegionIds) {
      try { restrictions.push(await readCuratedAccessFile(path.resolve(`data/regions/${region}/access-restrictions.json`))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const configuredSources = (recipe?.sources ?? await coverageSources()).filter((source) => intersectCoverage(source.geometry, requestedCoverage));
    const exclusions = recipe?.exclusions ?? await coverageExclusions();
    const coveragePlan = planCoverageGeometry(requestedCoverage, configuredSources, exclusions);
    const supportedCoverage = coveragePlan.supported;
    for (const region of recipe?.reviewedRegionIds ?? legacyRegionIds) {
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
      const expectedHash=recipe?.sources.find(item=>item.config.id===source.config.id)?.sha256;
      if(expectedHash && input.contentHash!==expectedHash) throw new Error(`Pinned source hash differs for ${source.config.id}`);
      const raw = new CoverageSourceStore(path.join(root, sourceStoreFileName(input)), input);
      rawStores.push(raw);
      await report(`Inventorying ${source.config.dataset}`);
      await raw.import(check, { onStage: async (stage) => {
        const label = stage === "context-promotion" ? "Resolving connected trail context"
          : stage === "integrity-check" ? "Verifying source inventory" : "Verifying source checkpoints";
        await report(`${label}: ${source.config.dataset}`);
      } });
      await report(`Classifying intended coverage: ${source.config.dataset}`);
      await classifyIntendedInventory(raw, requestedCoverage, exclusions, check);
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
    stageKey = `graph-${inputFingerprint}`;
    store = openProgressiveGraphStore({ stagingPath: path.join(root, `${stageKey}.sqlite`), buildIdentity: stageKey });
    store.database.exec("CREATE TABLE IF NOT EXISTS unit_edges(unit TEXT NOT NULL,edge TEXT NOT NULL,PRIMARY KEY(unit,edge)) STRICT");
    for (const restriction of restrictions) store.putSource(restriction.snapshot);
    for (const reference of referenceSources) store.putSource(reference.snapshot);
    for (const raw of rawStores) store.putSource(raw.source);
    for (const unit of units) {
      if (unit.status === "unavailable") continue;
      const receipt = store.getReceipt(`unit:${unit.id}`);
      let contextRows = 0;
      const stageBuildings = async (raw: CoverageSourceStore) => {
        const buildings = raw.buildings(unit.geometry);
        let next = buildings.next();
        while (!next.done) {
          store!.transaction(() => {
            for (let count = 0; count < 1000 && !next.done; count++) {
              store!.putBuilding(next.value);
              next = buildings.next();
            }
          });
          await check();
        }
      };
      const stageWays = async function* (raw: CoverageSourceStore) {
        const ways = raw.ways(unit.geometry);
        let next = ways.next();
        while (!next.done) {
          const batch: {way: NormalizedWay; nodes: NormalizedNode[]}[] = [];
          let nodes = 0;
          do {
            const item = next.value;
            let way = item.way;
            for (const source of restrictions) {
              const restriction = source.restrictions.find((entry) => entry.externalId === way.externalId);
              if (restriction) way = applyRestriction(way, restriction, source.snapshot.id);
            }
            batch.push({way, nodes: item.nodes});
            nodes += Math.max(1, item.nodes.length);
            next = ways.next();
          } while (!next.done && nodes + Math.max(1, next.value.nodes.length) <= 1000);
          store!.transaction(() => {
            for (const item of batch) { for (const node of item.nodes) store!.putNode(node); store!.putWay(item.way); }
          });
          await check();
          // Commit context before yielding: metric flushes open their own transactions.
          for (const item of batch) yield item.way;
        }
      };
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
          await stageBuildings(raw);
          for await (const way of stageWays(raw)) { void way; }
          for (const evidence of raw.evidence(unit.geometry)) {
            store.putPortalEvidence(evidence);
            if (++contextRows % 1000 === 0) await check();
          }
        }
        const actual = await unitContents(unit.id);
        if (receipt.rowCount !== actual.rowCount || receipt.contentHash !== actual.contentHash) {
          throw new Error(`Installation checkpoint ${unit.id} failed verification`);
        }
        if (receipt.fingerprint !== fingerprint) throw new ChangedMetricInputs(`Elevation inputs changed for ${unit.id}`);
        unit.status = "prepared"; prepared.push(unit);
      }
      else {
        await check();
        unit.status = "processing";
        await report(`Preparing installation unit ${unit.id}`);
        for (const raw of rawStores) {
          await stageBuildings(raw);
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
          for await (const way of stageWays(raw)) {
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
          for (const evidence of raw.evidence(unit.geometry)) {
            store.putPortalEvidence(evidence);
            if (++contextRows % 1000 === 0) await check();
          }
        }
        store.putReceipt({ stage: `unit:${unit.id}`, fingerprint, ...await unitContents(unit.id) });
        unit.status = "prepared"; prepared.push(unit);
        await report(`Prepared ${unit.id}`);
      }
    }
    await publish();
    return { snapshot, units, completedUnits: units.filter((unit) => unit.status === "installed").length, status: "completed" };
  } catch (error) {
    if (!(error instanceof ChangedMetricInputs) || !retryChangedMetrics) throw error;
    // Staging is disposable; immutable published generations stay active. A
    // missing stage makes the retry rebuild the installed union before activation.
    // Verified source and metric caches retain unchanged work.
    close(); await resources.stop();
    for (const suffix of ["","-wal","-shm"]) await rm(path.join(root,`${stageKey}.sqlite${suffix}`),{force:true});
    await context.report({stage:"Elevation inputs changed; replaying affected preparation"});
    return runAttempt(plan,context,false,recipe);
  } finally { close(); await resources.stop(); }
}
