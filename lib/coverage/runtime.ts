import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { createPreparedSchema } from "@/lib/data/sqlite-writer";
import { exportPreparedRelease, preparedReleaseId, publishPreparedCatalog } from "@/lib/data/prepared-release";
import { compactPreparedGraph } from "@/lib/data/compact-prepared-graph";
import { writeProgressiveTopology } from "@/lib/data/progressive/topology";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { insertGraph } from "@/lib/data/progressive/publish";
import { readOsmSourceConfig } from "@/lib/data/osm/source";
import { readOfficialTrailSourceConfig, readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot } from "@/lib/data/official-trails/source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { sha256File } from "@/lib/data/file-source";
import { calculateEdgeMetricsBatch, densifyGeometry, distanceMeters, type EdgeMetrics } from "@/lib/data/metrics";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import { applyRestriction } from "@/lib/data/curated-access";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION as METRIC_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { containsCoverage } from "@/lib/graph/coverage-containment";
import { contentId, intersectCoverage, rectangle, unionCoverage } from "./geometry";
import { NORMALIZATION_VERSION } from "./source-store";
import { elevationCache, elevationFor, describeCanonicalElevation } from "./elevation";
import { reconcileInventory } from "./inventory";
import { auditOfficialTrailReferences, officialSourceEnvelope } from "./references";
import { preparationSession, preparationInputs, importLocalSources } from "./preparation";
import { planCoverageRegion } from "./plan";
import { sourceRecipeSchema } from "./recipe";
import { pruneWalkingGraph, PRUNING_ALGORITHM_VERSION } from "./prune";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { NormalizedWay } from "@/lib/data/types";
import { coordinateIsInsideArea, lineIsInsideArea } from "@/lib/graph/geometry";
import type { CoverageRegion, CoverageRunnerContext, CoverageRunResult } from "./types";
export const COVERAGE_PACK_ID = "regional-coverage";
const BUILD_VERSION = `compact-regions-v2:${NORMALIZATION_VERSION}:${PRUNING_ALGORITHM_VERSION}`;
type ReferenceAudit = Awaited<ReturnType<typeof auditOfficialTrailReferences>>;
type Receipt = { release: DataRelease; compressedHash: string; demGeometry: AreaGeometry; elevationFingerprint: string; references: ReferenceAudit[]; referenceSources: DataRelease["sources"] };
const durable = (source: SourceSnapshot) => { const { localPath, ...value } = source; void localPath; return value; };

/** One named place is an independently usable graph, with reusable physical measurements. */
export async function buildCoverageRegion(region: CoverageRegion, context: CoverageRunnerContext): Promise<CoverageRunResult> {
  const recipe = sourceRecipeSchema.parse(region.recipe), area = planCoverageRegion({...region, recipe});
  const session = await preparationSession(recipe, context);
  const {root, outputRoot, cacheRoot, raws, units, check, report} = session;
  let scratch: string | undefined;
  try {
    let previous: DataRelease | undefined;
    try { previous = dataReleaseSchema.parse(JSON.parse(await readFile(path.join(outputRoot, "release.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous && previous.partitioning !== "local-areas") throw new Error("Remove the old network release before publishing named regions");
    // A named replacement must preserve the effective footprint, including holes
    // and route boundaries. This checks geometry, not source or trail completeness.
    const retiredIds = new Set(region.replaces ?? []);
    for (const section of previous?.sections ?? []) {
      if (!retiredIds.has(section.id)) continue;
      if (!containsCoverage(area.startGeometry, section.geometry))
        throw new Error(`Cannot replace ${section.id}: ${area.id} does not preserve its complete eligible-start coverage`);
      for (const artifact of previous!.artifacts.filter(artifact => section.artifactIds.includes(artifact.id)))
        if (!containsCoverage(area.geometry, artifact.geometry))
          throw new Error(`Cannot replace ${section.id}: ${area.id} does not preserve its complete routing coverage`);
    }
    const inputs = await preparationInputs(recipe, session, area.geometry);
    const declared = contentId({id:area.id, startGeometry:area.startGeometry, geometry:area.geometry, maximumRouteMiles:area.maximumRouteMiles,
      sources:inputs.snapshots.map(durable), restrictions:inputs.restrictions.map(({snapshot,...rest})=>({...rest,snapshot:durable(snapshot)})), boundarySources:region.sources ?? [], reviewedApproaches:region.reviewedApproaches ?? [],
      recipe, compiler:BUILD_VERSION, metric:METRIC_VERSION, topology:CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION});
    const receipts = path.join(root, "regions"), receiptPath = path.join(receipts, `${declared}.json`);
    await mkdir(receipts, {recursive:true});
    units.push({id:area.id, geometry:area.geometry, status:"processing"});
    const unit = units[0]!, dem = elevationCache();
    const searchRegion = (sources: DataRelease["sources"]) => ({id:region.id, name:region.name, geometry:area.startGeometry,
      aliases:[...new Set([...(region.aliases ?? []), `region-id:${region.id}`])], sourceIds:(region.sources?.length ? region.sources : sources).map(source => source.id)});
    const identity = (elevationFingerprint: string) => ({id:area.id, name:area.name, inputFingerprint:contentId({declared,elevationFingerprint}),
      startGeometry:area.startGeometry, maximumRouteMiles:area.maximumRouteMiles, bufferMiles:area.bufferMiles});
    let cached: Receipt | undefined;
    try { cached = JSON.parse(await readFile(receiptPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let prepared: DataRelease | undefined, referenceAudits: ReferenceAudit[] = [], referenceSources: DataRelease["sources"] = [];
    if (cached) {
      const stored = dataReleaseSchema.parse(cached.release);
      if (stored.sections.length !== 1 || stored.sections[0]!.id !== area.id || stored.artifacts.length !== 1 ||
        stored.id !== preparedReleaseId({...stored, area:identity(cached.elevationFingerprint)}) ||
        contentId(stored.geometry) !== contentId(area.geometry) || contentId(stored.sections[0]!.geometry) !== contentId(area.startGeometry))
        throw new Error(`Region checkpoint identity failed verification: ${area.id}`);
      await report(`Verifying cached elevation: ${area.name}`);
      const actual = await describeCanonicalElevation(cached.demGeometry, cacheRoot, root, dem);
      if (actual?.productFingerprint === cached.elevationFingerprint) {
        const artifact = stored.artifacts[0]!, file = path.join(outputRoot, artifact.path);
        if (artifact.graphId !== stored.id || (await stat(file)).size !== artifact.compressedBytes || await sha256File(file) !== cached.compressedHash)
          throw new Error(`Region checkpoint failed verification: ${area.id}`);
        prepared = {...stored, regions:[searchRegion(stored.sources)], sections:[{...stored.sections[0]!, name:area.name}]};
        referenceAudits = cached.references; referenceSources = cached.referenceSources;
        unit.status = "prepared";
        await report(`Reused ${area.name}`, {reusedRegions:1});
      }
    }
    if (!prepared) {
      await importLocalSources(session, inputs, area.geometry);
      scratch = await mkdtemp(path.join(root, ".region-"));
      const databasePath = path.join(scratch, "region.sqlite");
      const store = openProgressiveGraphStore({stagingPath:path.join(scratch,"stage.sqlite"), buildIdentity:area.id});
      let demGeometry: AreaGeometry, elevationFingerprint: string;
      try {
        await report(`Reading walking links and access context: ${area.name}`);
        const memberSources = new Set<string>();
        let pending: Array<() => void> = [], work = 0, unsupportedBuildings = 0;
        const flush = () => { if (pending.length) store.transaction(() => { for (const write of pending) write(); }); pending = []; };
        const enqueue = (write: () => void) => { pending.push(write); if (pending.length < 1000) return false; flush(); return true; };
        store.database.exec("CREATE TEMP TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT NOT NULL,to_node TEXT NOT NULL,length_m REAL NOT NULL) STRICT");
        const eligible = store.database.prepare("INSERT OR IGNORE INTO eligible_segments VALUES (?,?,?,?)");
        for (const raw of raws) {
          unsupportedBuildings += Number(raw.db.prepare("SELECT count(*) AS n FROM inventory WHERE disposition='unsupported'").get()!.n);
          const sourceCoverage = intersectCoverage(area.geometry, recipe.sources.find(source => source.config.id === raw.source.id)!.geometry)!;
          for (const {way, nodes} of raw.ways(sourceCoverage)) {
            for (const node of nodes) if (enqueue(() => store.putNode(node))) await check();
            let current = way;
            for (const file of inputs.restrictions) { const rule = file.restrictions.find(rule => rule.externalId === current.externalId); if (rule) current = applyRestriction(current,rule,file.snapshot.id); }
            if (enqueue(() => store.putWay(current))) await check();
            if (current.edgeClass === "trail" && ["public", "unknown"].includes(current.accessState)) {
              for (let segment = 0; segment < current.nodeIds.length - 1; segment++) {
                if (++work % 1000 === 0) await check();
                if (lineIsInsideArea(current.coordinates.slice(segment,segment+2),area.geometry)) {
                  const a = current.coordinates[segment]!, b = current.coordinates[segment+1]!;
                  if (enqueue(() => { eligible.run(`${current.id}:${segment}`,current.nodeIds[segment]!,current.nodeIds[segment+1]!,distanceMeters(a,b)*(1-1e-10)); })) await check();
                }
              }
            }
            current.sourceRefs.forEach(id => memberSources.add(id)); memberSources.add(raw.source.id);
          }
          for (const building of raw.buildings(area.geometry)) { if (enqueue(() => store.putBuilding(building))) await check(); memberSources.add(raw.source.id); }
          for (const evidence of raw.evidence(area.geometry)) {
            if (enqueue(() => store.putPortalEvidence(evidence))) await check();
            evidence.sourceRefs.forEach(id => memberSources.add(id)); memberSources.add(raw.source.id);
          }
        }
        flush(); await check();
        await report(`Keeping trails within the route distance: ${area.name}`);
        const pruned = await pruneWalkingGraph(store.database,area.startGeometry,area.bufferMiles*2*1609.344,check,Math.min(512,recipe.memoryLimitMiB/2)*1024**2);
        await report(`Planning elevation for ${pruned.retainedSegments} retained segments`,pruned);
        const tiles = new Set<string>();
        for (const row of store.database.prepare(`SELECT a.lon AS x,a.lat AS y,b.lon AS x2,b.lat AS y2 FROM eligible_segments e
          JOIN nodes a ON a.id=e.from_node JOIN nodes b ON b.id=e.to_node`).iterate()) {
          if (++work % 1000 === 0) await check();
          for (const [lon,lat] of densifyGeometry([[Number(row.x),Number(row.y)],[Number(row.x2),Number(row.y2)]])) tiles.add(`${Math.floor(lon)},${Math.ceil(lat)-1}`);
        }
        demGeometry = unionCoverage([...tiles].sort().map(key => { const [x,y] = key.split(",").map(Number); return rectangle([x!,y!,x!+1,y!+1]); }));
        await report(`Verifying or acquiring ${tiles.size} elevation tiles`,{requiredDemTiles:tiles.size});
        const elevation = await elevationFor({...unit,geometry:demGeometry},cacheRoot,root,recipe.offline,dem,path.join(scratch,"sample-dem.json"),
          async (tile:string|null)=>report(tile ? `Acquiring 30 m elevation backup for ${tile}` : `Measuring retained trails: ${area.name}`));
        await report(`Measuring retained trails: ${area.name}`);
        const measured = await prepareMetrics(store,path.join(root,"metrics.sqlite"),elevation,check);
        // Sampling can acquire NoData backup products. Pin the final inventory in
        // graph identity, provenance and the resume receipt only after it finishes.
        elevationFingerprint = elevation.productFingerprint;
        const sources: DataRelease["sources"] = [...raws.map(raw => raw.source),...inputs.restrictions.map(file => file.snapshot)].filter(source => memberSources.has(source.id)).map(durable);
        sources.push(durable(elevation.source));
        for (const source of region.sources ?? []) if (!sources.some(prior => prior.id === source.id)) sources.push(source);
        sources.sort((a,b)=>a.id.localeCompare(b.id));
        for (const source of sources) store.putSource({...source,contentHash:source.contentHash as `sha256:${string}`,localPath:""});
        const limitations = [...recipe.limitations,...(elevation.limitations??[]),
          ...(unsupportedBuildings ? [`The local context contains ${unsupportedBuildings} unsupported building relations. Building-based trailhead filtering may be incomplete; individual reasons are recorded in its context inventory.`] : []),
          "Access and building context uses buffered, node-based source extracts; features without a node inside that buffer can be absent.",
          "Regional graphs preserve supported routes within the configured distance budget; missing source trails may still exist."];
        const options = {databasePath,outputRoot,geometry:area.geometry,sources,regions:[searchRegion(sources)],
          builtAt:sources.map(source => source.retrievedAt).sort().at(-1)!,compilerVersion:BUILD_VERSION,metricAlgorithmVersion:METRIC_VERSION,
          limitations,checkpoint:check,publish:false,area:identity(elevationFingerprint)};
        await report(`Checking retained source membership: ${area.name}`,measured);
        const member = store.database.prepare("SELECT 1 FROM eligible_segments WHERE id=?");
        for (const raw of raws) await reconcileInventory(raw,store,area.geometry,check,id=>Boolean(member.get(id)),inputs.restrictions);
        await report(`Finding access trailheads: ${area.name}`);
        await store.derivePortals(area.geometry,check);
        const db = new DatabaseSync(databasePath);
        try {
          db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=DELETE;PRAGMA cache_size=-16384;PRAGMA temp_store=FILE");
          createPreparedSchema(db);
          await insertGraph(store,db,topologySha256(area.geometry),new Set(sources.map(source=>source.id)),check,true);
          const remove = db.prepare("DELETE FROM access_points WHERE id=?");
          const excluded: string[] = [];
          for (const row of db.prepare("SELECT a.id,n.lon,n.lat FROM access_points a JOIN nodes n ON n.id=a.node_id").iterate())
            if (!coordinateIsInsideArea([Number(row.lon),Number(row.lat)],area.startGeometry)) excluded.push(String(row.id));
          for (const id of excluded) remove.run(id);
          await report(`Compressing trail paths: ${area.name}`);
          const compact = await compactPreparedGraph(db,check);
          await report(`Analyzing loops and approaches: ${area.name}`,compact);
          await writeProgressiveTopology(db,check);
          await report(`Checking reviewed approach starts: ${area.name}`);
          await checkReviewedApproaches(db,region,check);
          db.prepare("INSERT INTO metadata VALUES ('schemaVersion','7')").run();
          db.prepare("INSERT INTO metadata VALUES ('releaseId',?)").run(preparedReleaseId(options));
          const add = db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)");
          for (const source of sources) add.run(source.id,source.authority,source.dataset,source.version,source.retrievedAt,source.url,source.license,source.contentHash);
          await report(`Finalizing compact storage: ${area.name}`);
          await check();
          db.exec("VACUUM");
          await check();
        } finally { db.close(); }
        await report(`Auditing and exporting ${area.name}`);
        prepared = await exportPreparedRelease(options);
      } finally { store.close(); await rm(scratch,{recursive:true,force:true}); scratch=undefined; }
      await report(`Comparing independent trail references: ${area.name}`);
      for (const raw of raws) {
        let compared = false;
        for (const reviewed of recipe.reviewedRegionIds) {
          try {
            const config = await readOfficialTrailSourceConfig(path.resolve(`data/regions/${reviewed}/official-trail-source.json`));
            if (!intersectCoverage(rectangle(officialSourceEnvelope(config)),area.geometry) ||
              (await readOsmSourceConfig(path.resolve(`data/regions/${reviewed}/osm-source.json`))).id !== raw.source.id) continue;
            const snapshot = await readPinnedOfficialTrailSnapshot(cacheRoot,config).catch(async (error: unknown) => {
              if (recipe.offline && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              if (recipe.offline) throw error;
              return (await refreshPinnedOfficialTrailSnapshot(cacheRoot,config)).snapshot;
            });
            if (!snapshot) continue;
            referenceSources.push(durable(snapshot)); compared = true;
            referenceAudits.push(await auditOfficialTrailReferences({checkpoint:check,osm:raw,coverage:area.geometry,installedCoverage:area.geometry,officialSnapshot:snapshot,sourceEnvelope:officialSourceEnvelope(config)}));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (!compared) referenceAudits.push(await auditOfficialTrailReferences({checkpoint:check,osm:raw,coverage:area.geometry,installedCoverage:area.geometry}));
      }
      await writeJsonAtomically(receiptPath,{release:prepared,compressedHash:await sha256File(path.join(outputRoot,prepared.artifacts[0]!.path)),demGeometry,elevationFingerprint,references:referenceAudits,referenceSources} satisfies Receipt);
      unit.status = "prepared";
      await report(`Prepared ${area.name}`,{compressedBytes:prepared.artifacts[0]!.compressedBytes,installedBytes:prepared.artifacts[0]!.bytes});
    }
    // Replacement policy belongs to publication, not immutable graph identity.
    // Reusing a receipt must still apply the region's current retirement policy.
    const results = [{...prepared, sections:prepared.sections.map(section=>({...section,
      ...(retiredIds.size ? {replaces:[...retiredIds].sort()} : {})}))}];
    if (previous) {
      const replacedIds = new Set([area.id, ...retiredIds]);
      const sections = previous.sections.filter(section => !replacedIds.has(section.id) && section.artifactIds.some(id=>previous!.artifacts.some(artifact=>artifact.id===id && artifact.regionId))), ids = new Set(sections.flatMap(section=>section.artifactIds));
      // Regional provenance belongs only to the replaced regions. Retained artifacts
      // still pin every shared provider/restriction source through the merge below.
      const replacedSources = new Set([...replacedIds].flatMap(id=>[`region-boundary-${id}`,`region-approaches-${id}`]));
      if (sections.length) results.unshift({...previous,sections,
        regions:previous.regions.filter(region=>sections.some(section=>section.id===region.id)),
        sources:previous.sources.filter(source=>!replacedSources.has(source.id)),
        artifacts:previous.artifacts.filter(artifact=>ids.has(artifact.id)),geometry:unionCoverage(previous.artifacts.filter(artifact=>ids.has(artifact.id)).map(artifact=>artifact.geometry))});
    }
    const sources = new Map<string,DataRelease["sources"][number]>();
    for (const source of [...results.flatMap(result=>result.sources),...referenceSources]) {
      const prior = sources.get(source.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(source)) throw new Error(`Conflicting source metadata ${source.id}`);
      sources.set(source.id,source);
    }
    const geometry = unionCoverage(results.map(result=>result.geometry));
    const release: DataRelease = {...prepared,id:"pending",geometry,builtAt:[...sources.values()].map(source=>source.retrievedAt).sort().at(-1)!,sources:[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id)),
      regions:[...new Map(results.flatMap(result=>result.regions).map(region=>[region.id,region])).values()], sections:results.flatMap(result=>result.sections),artifacts:results.flatMap(result=>result.artifacts),
      limitations:[...new Set([...results.flatMap(result=>result.limitations),...referenceAudits.map(audit=>audit.limitation),"Independent reference comparisons are source proximity diagnostics; they do not establish installed official-feature membership."])]};
    release.sections.sort((a,b)=>a.id.localeCompare(b.id)); release.artifacts.sort((a,b)=>a.id.localeCompare(b.id)); release.regions.sort((a,b)=>a.id.localeCompare(b.id)); release.limitations.sort();
    release.id = `release-${contentId({...release,id:undefined}).slice(0,32)}`;
    await check();
    await writeJsonAtomically(path.join(outputRoot,"references.json"),referenceAudits);
    await report(`Publishing ${area.name}`);
    await publishPreparedCatalog(release,outputRoot,check);
    unit.status = "installed";
    await report(`Ready: ${area.name}`);
    return {status:"completed",units,completedUnits:1,snapshot:{schemaVersion:1,id:COVERAGE_PACK_ID,dataVersion:release.id,geometry,unitIds:[area.id],createdAt:release.builtAt,sourceFingerprint:contentId(release.sources),auditStatus:"passed",limitations:release.limitations}};
  } finally {
    if (scratch) await rm(scratch,{recursive:true,force:true});
    await session.close();
  }
}

/** Reviewed neighborhoods must contain actual starts in the final graph. */
async function checkReviewedApproaches(db: DatabaseSync, region: CoverageRegion, checkpoint: () => Promise<void>) {
  const starts=db.prepare("SELECT n.lon,n.lat FROM access_points a JOIN nodes n ON n.id=a.node_id WHERE a.access_state IN ('public','unknown')");
  const missing:string[]=[];
  for(const approach of region.reviewedApproaches??[]) {
    await checkpoint();
    let matched=false;
    for(const row of starts.iterate()) {
      if(distanceMeters(approach.coordinates,[Number(row.lon),Number(row.lat)])<=approach.radiusMeters) {matched=true;break;}
    }
    if(!matched) missing.push(`${approach.name} (${approach.radiusMeters} m)`);
  }
  if(missing.length) throw new Error(`Reviewed approaches have no mapped starting point in the final graph: ${missing.join(", ")}. Review source topology and the start footprint before publishing.`);
}

async function prepareMetrics(store: ReturnType<typeof openProgressiveGraphStore>, cachePath: string, elevation: Awaited<ReturnType<typeof elevationFor>>, check: () => Promise<void>) {
  const cache = new DatabaseSync(cachePath);
  cache.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; CREATE TABLE IF NOT EXISTS metrics(id TEXT NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(id,fingerprint)) STRICT");
  type Part = {id:string;segment:number;way:NormalizedWay};
  let pending: Part[] = [], measuredSegments = 0, reusedSegments = 0;
  const eligible = store.database.prepare("SELECT 1 FROM eligible_segments WHERE id=?");
  const get = cache.prepare("SELECT value FROM metrics WHERE id=? AND fingerprint=?"), put = cache.prepare("INSERT OR REPLACE INTO metrics VALUES(?,?,?)");
  const readMetric = (id:string,fingerprint:string):EdgeMetrics|undefined => {
    const cached=get.get(id,fingerprint);
    const value=cached?JSON.parse(String(cached.value)) as EdgeMetrics:undefined;
    // Failed builds from older runtimes could commit NoData metrics. Those rows
    // are misses, including when a valid legacy segment-keyed value still exists.
    return value?.elevationProfile?.length ? value : undefined;
  };
  const fingerprintFor = (part:Part) => {
    const geometry=part.way.coordinates.slice(part.segment,part.segment+2);
    return contentId({geometry,algorithm:METRIC_VERSION,sampler:elevation.sampler.algorithmVersion,elevation:elevation.fingerprintForGeometry(geometry)});
  };
  const flush = async () => {
    const values: EdgeMetrics[] = [], missing: number[] = [], fingerprints: string[] = [];
    for (let i=0;i<pending.length;i++) {
      const part = pending[i]!, fingerprint = fingerprintFor(part);
      fingerprints[i] = fingerprint;
      const cached = readMetric("geometry",fingerprint) ?? readMetric(part.id,fingerprint);
      if (cached) { values[i] = cached; reusedSegments++; } else missing.push(i);
    }
    if (missing.length) {
      const measured = await calculateEdgeMetricsBatch(missing.map(i=>{const part=pending[i]!;return part.way.coordinates.slice(part.segment,part.segment+2);}),{...elevation.sampler, sample:async coordinates=>{await check(); const samples=await elevation.sampler.sample(coordinates); await check(); return samples;}});
      // Only newly measured values depend on products discovered by this batch.
      // A reused primary-only value keeps its original key, even if sampling a
      // different segment acquires a backup for the same owned tile.
      missing.forEach((i,j)=>{values[i]=measured[j]!;fingerprints[i]=fingerprintFor(pending[i]!);}); measuredSegments += missing.length;
    }
    for (const [i,part] of pending.entries()) if (!values[i]?.elevationProfile?.length) throw new Error(`Missing elevation on ${part.id}`);
    cache.exec("BEGIN");
    try { pending.forEach((_part,i)=>put.run("geometry",fingerprints[i]!,JSON.stringify(values[i]))); cache.exec("COMMIT"); }
    catch (error) { cache.exec("ROLLBACK"); throw error; }
    store.transaction(()=>{
      for (const [i,part] of pending.entries()) {
        const metric = values[i]!;
        store.setNodeElevation(part.way.nodeIds[part.segment]!,metric.elevationProfile![0]!.elevationMeters);
        store.setNodeElevation(part.way.nodeIds[part.segment+1]!,metric.elevationProfile!.at(-1)!.elevationMeters);
        for (const edge of compiledEdgesForSegment(part.way,part.segment,part.way.coordinates.slice(part.segment,part.segment+2),metric)) store.putEdge(edge);
      }
    });
    pending = []; await check();
  };
  try {
    let work = 0;
    for (const row of store.database.prepare("SELECT record FROM ways WHERE edge_class='trail' AND access_state IN ('public','unknown') ORDER BY id").iterate()) {
      const way = JSON.parse(String(row.record)) as NormalizedWay;
      for (let segment=0;segment<way.nodeIds.length-1;segment++) {
        if (++work%1000===0) await check();
        if (!eligible.get(`${way.id}:${segment}`)) continue;
        pending.push({id:`${way.id}:${segment}`,way,segment}); if (pending.length>=4000) await flush();
      }
    }
    if (pending.length) await flush();
    return {measuredSegments,reusedSegments};
  } finally {cache.close();}
}
