import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { createPreparedSchema } from "@/lib/data/sqlite-writer";
import { exportPreparedRelease, preparedReleaseId, publishPreparedCatalog } from "@/lib/data/prepared-release";
import { compactPreparedGraph } from "@/lib/data/compact-prepared-graph";
import { rebuildPreparedSpatialIndexes } from "@/lib/data/prepared-spatial-index";
import { writeProgressiveTopology } from "@/lib/data/progressive/topology";
import { ENTRANCE_FAMILY_ALGORITHM_VERSION } from "@/lib/data/progressive/entrance-families";
import { PORTAL_ADMISSION_ALGORITHM_VERSION } from "@/lib/data/progressive/portal-policy";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { prepareSparsePortalCandidates } from "@/lib/data/progressive/portals";
import { ACCESS_ENTRY_POLICY_VERSION } from "@/lib/contracts/access-policy";
import { insertGraph } from "@/lib/data/progressive/publish";
import { readOsmSourceConfig } from "@/lib/data/osm/source";
import { readOfficialTrailSourceConfig, readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot } from "@/lib/data/official-trails/source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { sha256File } from "@/lib/data/file-source";
import { mergeCatalogSources } from "@/lib/data/source-metadata";
import { calculateEdgeMetricsBatch, densifyGeometry, distanceMeters, type EdgeMetrics } from "@/lib/data/metrics";
import { compiledEdgesForSegment, footSegmentAccessState } from "@/lib/data/compiled-edges";
import { applyRestriction } from "@/lib/data/curated-access";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION as METRIC_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { containsCoverage } from "@/lib/graph/coverage-containment";
import { contentId, intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import { NORMALIZATION_VERSION } from "./source-store";
import { elevationCache, elevationFor, describeCanonicalElevation } from "./elevation";
import { reconcileInventory } from "./inventory";
import { auditOfficialTrailReferences, officialSourceEnvelope } from "./references";
import { preparationSession, preparationInputs, importLocalSources } from "./preparation";
import { expandCoveragePlan, planCoverageRegion } from "./plan";
import { sourceRecipeSchema } from "./recipe";
import { qualifyMountainStarts, pruneWalkingGraph, PRUNING_ALGORITHM_VERSION } from "./prune";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { NormalizedWay } from "@/lib/data/types";
import { coordinateIsInsideArea, prepareAreaGeometry } from "@/lib/graph/geometry";
import { unavailableReviewedStartSchema, type CoverageRegion, type CoverageRunnerContext, type CoverageRunResult } from "./types";
export const COVERAGE_PACK_ID = "regional-coverage";
const BUILD_VERSION = `named-mountain-regions-v4:${NORMALIZATION_VERSION}:${PRUNING_ALGORITHM_VERSION}:${ENTRANCE_FAMILY_ALGORITHM_VERSION}:${PORTAL_ADMISSION_ALGORITHM_VERSION}`;
// The shared distance helper halves this return-distance budget: preserve the
// existing 25-mile one-way inclusive association, independently of the route
// envelope. This identifies destinations; routes need not visit the core.
const MOUNTAIN_ASSOCIATION_METERS = 50 * 1609.344;
const HIKING_HIGHWAYS=new Set(["path","track","bridleway","steps","footway","pedestrian"].map(kind=>`osm-highway:${kind}`));
type ReferenceAudit = Awaited<ReturnType<typeof auditOfficialTrailReferences>>;
type Receipt = { release: DataRelease; approaches: [number,number][]; compressedHash: string; demGeometry: AreaGeometry; elevationFingerprint: string; references: ReferenceAudit[]; referenceSources: DataRelease["sources"]; unavailableReviewedApproaches?: number };
const durable = (source: SourceSnapshot) => { const { localPath, ...value } = source; void localPath; return value; };

/** One named place is an independently usable graph, with reusable physical measurements. */
export async function buildCoverageRegion(region: CoverageRegion, context: CoverageRunnerContext, buildOptions: {rebuild?:boolean} = {}): Promise<CoverageRunResult> {
  const recipe = sourceRecipeSchema.parse(region.recipe), initialArea = planCoverageRegion({...region, recipe});
  let area = initialArea;
  const session = await preparationSession(recipe, context);
  const {root, scratchRoot, outputRoot, cacheRoot, raws, units, check, report} = session;
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
    const verifiedInputs = async (geometry: AreaGeometry) => {
      const inputs = await preparationInputs(recipe, session, geometry);
      validateUnavailableReviewedStarts(region, inputs.snapshots);
      return inputs;
    };
    let inputs = await verifiedInputs(area.geometry);
    const declared = contentId({id:area.id, startGeometry:area.startGeometry, geometry:area.geometry, maximumRouteMiles:area.maximumRouteMiles,
      sources:inputs.snapshots.map(durable), restrictions:inputs.restrictions.map(({snapshot,...rest})=>({...rest,snapshot:durable(snapshot)})), boundarySources:region.sources ?? [], reviewedApproaches:region.reviewedApproaches ?? [],
      recipe, startLimitGeometry:region.startLimitGeometry,
      startPolicy:{accessPolicyVersion:ACCESS_ENTRY_POLICY_VERSION,mountainAssociationMeters:MOUNTAIN_ASSOCIATION_METERS},
      compiler:BUILD_VERSION, metric:METRIC_VERSION, topology:CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION});
    const receipts = path.join(root, "regions"), receiptPath = path.join(receipts, `${declared}.json`);
    await mkdir(receipts, {recursive:true});
    units.push({id:area.id, geometry:area.geometry, status:"processing"});
    const unit = units[0]!, dem = elevationCache();
    const searchRegion = (sources: DataRelease["sources"]) => ({id:region.id, name:region.name, geometry:area.startGeometry,
      aliases:[...new Set([...(region.aliases ?? []), `region-id:${region.id}`])], sourceIds:(region.sources?.length ? region.sources : sources).map(source => source.id)});
    const identity = (elevationFingerprint: string) => ({id:area.id, name:area.name, inputFingerprint:contentId({declared,elevationFingerprint}),
      startGeometry:area.startGeometry, maximumRouteMiles:area.maximumRouteMiles, bufferMiles:area.bufferMiles});
    let cached: Receipt | undefined;
    if (!buildOptions.rebuild) {
      try { cached = JSON.parse(await readFile(receiptPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let unavailableReviewedApproaches=0;
    let prepared: DataRelease | undefined, approaches: [number,number][] = [], referenceAudits: ReferenceAudit[] = [], referenceSources: DataRelease["sources"] = [];
    if (cached) {
      const stored = dataReleaseSchema.parse(cached.release);
      if (!Array.isArray(cached.approaches) || cached.approaches.some(point =>
        !Array.isArray(point) || point.length!==2 || !point.every(Number.isFinite) ||
        (region.startLimitGeometry && !coordinateIsInsideArea(point,region.startLimitGeometry))))
        throw new Error(`Invalid region checkpoint approaches: ${area.id}`);
      area = expandCoveragePlan(initialArea,recipe,cached.approaches);
      unit.geometry=area.geometry;
      if (stored.sections.length !== 1 || stored.sections[0]!.id !== area.id || stored.artifacts.length !== 1 ||
        stored.id !== preparedReleaseId({...stored, area:identity(cached.elevationFingerprint)}) ||
        contentId(stored.geometry) !== contentId(area.geometry) || contentId(stored.sections[0]!.geometry) !== contentId(area.startGeometry))
        throw new Error(`Region checkpoint identity failed verification: ${area.id}. Run build ${area.id} --rebuild to prepare it again while retaining source and elevation caches.`);
      await report(`Verifying cached elevation: ${area.name}`);
      // Approaches can add another provider. Verify every final-extent pin even
      // when the completed receipt avoids all normalization and graph work.
      inputs = await verifiedInputs(area.geometry);
      const actual = await describeCanonicalElevation(cached.demGeometry, cacheRoot, root, dem);
      if (actual?.productFingerprint === cached.elevationFingerprint) {
        const artifact = stored.artifacts[0]!, file = path.join(outputRoot, artifact.path);
        if (artifact.graphId !== stored.id || (await stat(file)).size !== artifact.compressedBytes || await sha256File(file) !== cached.compressedHash)
          throw new Error(`Region checkpoint failed verification: ${area.id}`);
        prepared = {...stored, regions:[searchRegion(stored.sources)], sections:[{...stored.sections[0]!, name:area.name}]};
        approaches=cached.approaches;
        referenceAudits = cached.references; referenceSources = cached.referenceSources;
        unavailableReviewedApproaches=cached.unavailableReviewedApproaches ?? 0;
        if(!Number.isSafeInteger(unavailableReviewedApproaches) || unavailableReviewedApproaches<0 || unavailableReviewedApproaches>(region.reviewedApproaches?.length ?? 0))
          throw new Error(`Invalid region checkpoint unavailable approaches: ${area.id}`);
        unit.status = "prepared";
        await report(`Reused ${area.name}`, {reusedRegions:1,unavailableReviewedApproaches});
      }
    }
    if (!prepared) {
      area = initialArea;
      unit.geometry=area.geometry;
      if(cached) inputs=await verifiedInputs(area.geometry);
      await importLocalSources(session, inputs, area.geometry);
      scratch = await mkdtemp(path.join(scratchRoot, ".region-"));
      const databasePath = path.join(scratch, "region.sqlite");
      const store = openProgressiveGraphStore({stagingPath:path.join(scratch,"stage.sqlite"), buildIdentity:area.id, deferLookupIndexes:true});
      let demGeometry: AreaGeometry, elevationFingerprint: string;
      try {
        await report(`Reading walking links and access context: ${area.name}`);
        const mountain = prepareAreaGeometry(initialArea.startGeometry);
        const memberSources = new Set<string>();
        let pending: Array<() => void> = [], work = 0;
        const flush = () => { if (pending.length) store.transaction(() => { for (const write of pending) write(); }); pending = []; };
        const enqueue = (write: () => void) => { pending.push(write); if (pending.length < 1000) return false; flush(); return true; };
        store.database.exec(`CREATE TEMP TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT NOT NULL,to_node TEXT NOT NULL,length_m REAL NOT NULL,approach_link INTEGER NOT NULL,core_hiking INTEGER NOT NULL) STRICT;
          CREATE TEMP TABLE unsupported_buildings(id TEXT PRIMARY KEY) STRICT`);
        const unsupported=store.database.prepare("INSERT OR IGNORE INTO unsupported_buildings VALUES (?)");
        const eligible = store.database.prepare("INSERT OR IGNORE INTO eligible_segments VALUES (?,?,?,?,?,?)");
        const loadContext = async (readGeometry: AreaGeometry, selected: typeof raws) => {
          const boundary = prepareAreaGeometry(area.geometry);
          for (const raw of selected) {
            for(const row of raw.db.prepare("SELECT id FROM inventory WHERE disposition='unsupported'").iterate()) {
              if(++work%1000===0) await check();
              unsupported.run(row.id);
            }
            const sourceCoverage = intersectCoverage(readGeometry, recipe.sources.find(source => source.config.id === raw.source.id)!.geometry);
            if (!sourceCoverage) continue;
            for (const entry of raw.context(readGeometry,sourceCoverage)) {
              if (entry.kind === "building") {
                if (enqueue(() => store.putBuilding(entry.centroid))) await check();
                memberSources.add(raw.source.id);
                continue;
              }
              if (entry.kind === "evidence") {
                if (enqueue(() => store.putPortalEvidence(entry.evidence))) await check();
                entry.evidence.sourceRefs.forEach(id => memberSources.add(id)); memberSources.add(raw.source.id);
                continue;
              }
              const {way,nodes}=entry;
              const nodeFlags=new Map(nodes.map(node=>[node.id,node.flags]));
              for (const node of nodes) if (enqueue(() => store.putNode(node))) await check();
              let current = way;
              for (const file of inputs.restrictions) { const rule = file.restrictions.find(rule => rule.externalId === current.externalId); if (rule) current = applyRestriction(current,rule,file.snapshot.id); }
              if (enqueue(() => store.putWay(current))) await check();
              if (current.edgeClass === "trail" && ["public", "unknown"].includes(current.accessState)) {
                const approachLink=current.flags.some(flag=>HIKING_HIGHWAYS.has(flag));
                const hiking=approachLink && !current.flags.includes("possible-walking-link");
                for (let segment = 0; segment < current.nodeIds.length - 1; segment++) {
                  if (++work % 1000 === 0) await check();
                  if(!["public","unknown"].includes(footSegmentAccessState(current.accessState,
                    [nodeFlags.get(current.nodeIds[segment]!)??[],nodeFlags.get(current.nodeIds[segment+1]!)??[]]))) continue;
                  const a = current.coordinates[segment]!, b = current.coordinates[segment+1]!;
                  if (boundary.containsSegment(a,b)) {
                    const coreHiking=Number(hiking && (mountain.containsPoint(a)||mountain.containsPoint(b)||mountain.intersectsSegment(a,b)));
                    if (enqueue(() => { eligible.run(`${current.id}:${segment}`,current.nodeIds[segment]!,current.nodeIds[segment+1]!,distanceMeters(a,b)*(1-1e-10),Number(approachLink),coreHiking); })) await check();
                  }
                }
              }
              current.sourceRefs.forEach(id => memberSources.add(id)); memberSources.add(raw.source.id);
            }
          }
          flush(); await check();
        };
        await loadContext(area.geometry,raws);
        await report(`Indexing walking link memberships: ${area.name}`);
        await store.prepareLookupIndexes("ways",check);
        await report(`Finding sparse access points: ${area.name}`);
        const discoveryGeometry=region.startLimitGeometry ? intersectCoverage(area.geometry,region.startLimitGeometry) : area.geometry;
        if(!discoveryGeometry) throw new Error(`No approach discovery area remains for ${area.name}`);
        const candidates=await prepareSparsePortalCandidates(store,discoveryGeometry,check);
        await report(`Found ${candidates.eligibleAccessPoints} sparse entrance candidates: ${area.name}`,candidates);
        if(!candidates.eligibleAccessPoints)
          throw new Error(`No eligible access points in ${area.name}: no connected mapped entrances have permitted or unknown foot departures. Elevation was not acquired; prior published areas are unchanged.`);
        await report(`Selecting mountain entrances and nearby trails: ${area.name}`);
        const budget=Math.min(512,recipe.memoryLimitMiB/2)*1024**2;
        const qualified = await qualifyMountainStarts(store.database,MOUNTAIN_ASSOCIATION_METERS,check,budget);
        approaches=[];
        for(const row of store.database.prepare(`SELECT n.lon,n.lat FROM sparse_start_nodes s JOIN nodes n ON n.id=s.node_id ORDER BY s.node_id`).iterate()) {
          if(++work%1000===0) await check();
          const point:[number,number]=[Number(row.lon),Number(row.lat)];
          if(!mountain.containsPoint(point)) approaches.push(point);
        }
        area=expandCoveragePlan(initialArea,recipe,approaches);
        unit.geometry=area.geometry;
        const additional=subtractCoverage(area.geometry,initialArea.geometry);
        if(additional) {
          await report(`Completing route coverage for ${approaches.length} outside entrances: ${area.name}`);
          // Freeze membership before extending support: distant approaches may
          // have loops going away from the core, but support cannot nominate starts.
          inputs=await verifiedInputs(area.geometry);
          const begin=raws.length;
          await importLocalSources(session,{...inputs,snapshots:inputs.snapshots.filter(snapshot=>
            intersectCoverage(additional,recipe.sources.find(source=>source.config.id===snapshot.id)!.geometry))},additional);
          await loadContext(additional,raws.slice(begin));
        }
        const pruned = await pruneWalkingGraph(store.database,area.bufferMiles*2*1609.344,check,budget);
        await report(`Planning elevation for ${pruned.retainedSegments} retained segments`,{...pruned,terrainExcludedAccessPoints:qualified.terrainExcludedAccessPoints,approachAccessPoints:approaches.length,eligibleAccessPoints:pruned.seedNodes});
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
        await report(`Indexing measured trails: ${area.name}`,measured);
        await store.prepareLookupIndexes("edges",check);
        // Sampling can acquire NoData backup products. Pin the final inventory in
        // graph identity, provenance and the resume receipt only after it finishes.
        elevationFingerprint = elevation.productFingerprint;
        const sources: DataRelease["sources"] = [...new Map([...raws.map(raw => raw.source),...inputs.restrictions.map(file => file.snapshot)]
          .filter(source => memberSources.has(source.id)).map(source=>[source.id,durable(source)])).values()];
        sources.push(durable(elevation.source));
        for (const source of region.sources ?? []) if (!sources.some(prior => prior.id === source.id)) sources.push(source);
        sources.sort((a,b)=>a.id.localeCompare(b.id));
        for (const source of sources) store.putSource({...source,contentHash:source.contentHash as `sha256:${string}`,localPath:""});
        const unsupportedBuildings=Number(store.database.prepare("SELECT count(*) AS n FROM unsupported_buildings").get()!.n);
        const limitations = [...recipe.limitations,...(elevation.limitations??[]),
          ...(unsupportedBuildings ? [`The local context contains ${unsupportedBuildings} unsupported building relations. Descriptive building counts may be incomplete; individual reasons are recorded in its context inventory.`] : []),
          "Access and building context uses buffered, node-based source extracts; features without a node inside that buffer can be absent.",
          "Starts must connect through hiking links within 25 walking miles to a mapped hiking trail touching this area's GMBA Standard mountain core. Ordinary roads do not establish mountain approaches. Unknown access is included; low foothills and disconnected source trails can be excluded. This qualifies starts, not every generated route's terrain.",
          "Regional graphs preserve supported routes within the configured distance budget; missing source trails may still exist."];
        const options = {databasePath,outputRoot,geometry:area.geometry,sources,regions:[searchRegion(sources)],
          builtAt:sources.map(source => source.retrievedAt).sort().at(-1)!,compilerVersion:BUILD_VERSION,metricAlgorithmVersion:METRIC_VERSION,
          limitations,checkpoint:check,publish:false,area:identity(elevationFingerprint)};
        await report(`Checking retained source membership: ${area.name}`,measured);
        const member = store.database.prepare("SELECT 1 FROM eligible_segments WHERE id=?");
        for (const raw of raws) await reconcileInventory(raw,store,area.geometry,check,id=>Boolean(member.get(id)),inputs.restrictions);
        await report(`Ranking retained access points: ${area.name}`);
        await store.derivePortals(area.geometry,check);
        await report(`Writing prepared graph: ${area.name}`);
        const db = new DatabaseSync(databasePath);
        try {
          db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=DELETE;PRAGMA cache_size=-16384;PRAGMA temp_store=FILE");
          createPreparedSchema(db);
          await insertGraph(store,db,topologySha256(area.geometry),new Set(sources.map(source=>source.id)),check,true,{spatialIndexes:false});
          const remove = db.prepare("DELETE FROM access_points WHERE id=?");
          const excluded: string[] = [];
          for (const row of db.prepare("SELECT a.id,n.lon,n.lat FROM access_points a JOIN nodes n ON n.id=a.node_id").iterate())
            if (!coordinateIsInsideArea([Number(row.lon),Number(row.lat)],area.startGeometry)) excluded.push(String(row.id));
          for (const id of excluded) remove.run(id);
          await report(`Compressing trail paths: ${area.name}`);
          const compact = await compactPreparedGraph(db,check,{spatialIndexes:false});
          await report(`Indexing compact trails: ${area.name}`);
          await rebuildPreparedSpatialIndexes(db,check);
          await report(`Analyzing loops and approaches: ${area.name}`,compact);
          await writeProgressiveTopology(db,check);
          await report(`Checking reviewed approach starts: ${area.name}`);
          const {terrainExcluded,unavailable}=await checkReviewedApproaches(db,store.database,region,check);
          unavailableReviewedApproaches=unavailable.length;
          limitations.push(...unavailable);
          if(terrainExcluded.length) limitations.push(`Reviewed approaches excluded because no mountain hiking trail is reachable within the route-distance bound: ${terrainExcluded.join(", ")}.`);
          await report(`Reviewed approach checks complete: ${area.name}`,{terrainExcludedReviewedApproaches:terrainExcluded.length,unavailableReviewedApproaches});
          db.prepare("INSERT INTO metadata VALUES ('schemaVersion','7')").run();
          db.prepare("INSERT INTO metadata VALUES ('access_policy_version',?)").run(ACCESS_ENTRY_POLICY_VERSION);
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
        const referenceCoverage=intersectCoverage(raw.geometry,area.geometry)!;
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
            referenceAudits.push(await auditOfficialTrailReferences({checkpoint:check,osm:raw,coverage:referenceCoverage,installedCoverage:area.geometry,officialSnapshot:snapshot,sourceEnvelope:officialSourceEnvelope(config)}));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (!compared) referenceAudits.push(await auditOfficialTrailReferences({checkpoint:check,osm:raw,coverage:referenceCoverage,installedCoverage:area.geometry}));
      }
      await writeJsonAtomically(receiptPath,{release:prepared,approaches,compressedHash:await sha256File(path.join(outputRoot,prepared.artifacts[0]!.path)),demGeometry,elevationFingerprint,references:referenceAudits,referenceSources,unavailableReviewedApproaches} satisfies Receipt);
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
    const sourceInputs = [...results.flatMap(result=>result.sources),...referenceSources];
    const sources = mergeCatalogSources(sourceInputs);
    const geometry = unionCoverage(results.map(result=>result.geometry));
    // Canonical source dates must not erase a retained graph's later acquisition.
    const builtAt = [...results.map(result=>result.builtAt),...sourceInputs.map(source=>source.retrievedAt)]
      .sort((a,b)=>Date.parse(a)-Date.parse(b)||a.localeCompare(b)).at(-1)!;
    const release: DataRelease = {...prepared,id:"pending",geometry,builtAt,sources,
      regions:[...new Map(results.flatMap(result=>result.regions).map(region=>[region.id,region])).values()], sections:results.flatMap(result=>result.sections),artifacts:results.flatMap(result=>result.artifacts),
      limitations:[...new Set([...results.flatMap(result=>result.limitations),...referenceAudits.map(audit=>audit.limitation),"Independent reference comparisons are source proximity diagnostics; they do not establish installed official-feature membership."])]};
    release.sections.sort((a,b)=>a.id.localeCompare(b.id)); release.artifacts.sort((a,b)=>a.id.localeCompare(b.id)); release.regions.sort((a,b)=>a.id.localeCompare(b.id)); release.limitations.sort();
    release.id = `release-${contentId({...release,id:undefined}).slice(0,32)}`;
    await check();
    await writeJsonAtomically(path.join(outputRoot,"references.json"),referenceAudits);
    await report(`Publishing ${area.name}`);
    await publishPreparedCatalog(release,outputRoot,check);
    unit.status = "installed";
    await report(`Ready: ${area.name}`,{unavailableReviewedApproaches});
    return {status:"completed",units,completedUnits:1,snapshot:{schemaVersion:1,id:COVERAGE_PACK_ID,dataVersion:release.id,geometry,unitIds:[area.id],createdAt:release.builtAt,sourceFingerprint:contentId(release.sources),auditStatus:"passed",limitations:release.limitations}};
  } finally {
    if (scratch) await rm(scratch,{recursive:true,force:true});
    await session.close();
  }
}

/** Gap reviews apply only to the verified input bytes, never recipe declarations alone. */
function validateUnavailableReviewedStarts(region: CoverageRegion, snapshots: SourceSnapshot[]) {
  for(const approach of region.reviewedApproaches ?? []) {
    if(approach.unavailableStart === undefined) continue;
    const reviewed=unavailableReviewedStartSchema.parse(approach.unavailableStart);
    const source=snapshots.find(snapshot=>snapshot.id===reviewed.sourceId);
    if(!source || source.contentHash!==reviewed.sourceHash)
      throw new Error(`Unavailable reviewed start ${approach.name} requires verified source ${reviewed.sourceId} at ${reviewed.sourceHash}; ${source ? `actual hash is ${source.contentHash}` : "source is absent from verified inputs"}. Review the gap against the current source before publishing.`);
  }
}

/** Keep missing topology distinct from an actual candidate rejected by policy. */
async function checkReviewedApproaches(db: DatabaseSync, stage: DatabaseSync, region: CoverageRegion, checkpoint: () => Promise<void>) {
  const starts=db.prepare("SELECT n.lon,n.lat FROM access_points a JOIN nodes n ON n.id=a.node_id WHERE a.access_state IN ('public','unknown')");
  const rejected=stage.prepare(`SELECT n.lon,n.lat
    FROM portal_candidate_audit a JOIN nodes n ON n.id=a.node_id
    WHERE a.access_state IN ('public','unknown') AND a.node_id IN (SELECT node_id FROM terrain_excluded_start_nodes)`);
  const missing:string[]=[],terrainExcluded:string[]=[],unavailable:string[]=[];
  let work=0;
  for(const approach of region.reviewedApproaches??[]) {
    await checkpoint();
    let matched=false;
    for(const row of starts.iterate()) {
      if(++work%1000===0) await checkpoint();
      if(distanceMeters(approach.coordinates,[Number(row.lon),Number(row.lat)])<=approach.radiusMeters) {matched=true;break;}
    }
    if(!matched) for(const row of rejected.iterate()) {
      if(++work%1000===0) await checkpoint();
      if(distanceMeters(approach.coordinates,[Number(row.lon),Number(row.lat)])<=approach.radiusMeters) {
        terrainExcluded.push(approach.name);matched=true;break;
      }
    }
    if(!matched) {
      if(approach.unavailableStart) unavailable.push(unavailableReviewedStartSchema.parse(approach.unavailableStart).reason);
      else missing.push(`${approach.name} (${approach.radiusMeters} m)`);
    }
  }
  if(missing.length) throw new Error(`Reviewed approaches have no mapped starting point in the final graph: ${missing.join(", ")}. Review source topology and the start footprint before publishing.`);
  return {terrainExcluded,unavailable};
}

async function prepareMetrics(store: ReturnType<typeof openProgressiveGraphStore>, cachePath: string, elevation: Awaited<ReturnType<typeof elevationFor>>, check: () => Promise<void>) {
  const cache = new DatabaseSync(cachePath);
  cache.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; CREATE TABLE IF NOT EXISTS metrics(id TEXT NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(id,fingerprint)) STRICT");
  type Part = {id:string;segment:number;way:NormalizedWay;nodeFlags:readonly (readonly string[])[]};
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
    const values: EdgeMetrics[] = [], missing: number[] = [], writes: number[] = [], fingerprints: string[] = [];
    for (let i=0;i<pending.length;i++) {
      const part = pending[i]!, fingerprint = fingerprintFor(part);
      fingerprints[i] = fingerprint;
      const geometryCached = readMetric("geometry",fingerprint);
      const cached = geometryCached ?? readMetric(part.id,fingerprint);
      if (!geometryCached) writes.push(i);
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
    // Valid geometry hits are already durable. Only measurements and legacy-key
    // promotions need writes; invalid geometry rows are repaired by either path.
    if (writes.length) {
      cache.exec("BEGIN");
      try { writes.forEach(i=>put.run("geometry",fingerprints[i]!,JSON.stringify(values[i]))); cache.exec("COMMIT"); }
      catch (error) { cache.exec("ROLLBACK"); throw error; }
    }
    store.transaction(()=>{
      for (const [i,part] of pending.entries()) {
        const metric = values[i]!;
        store.setNodeElevation(part.way.nodeIds[part.segment]!,metric.elevationProfile![0]!.elevationMeters);
        store.setNodeElevation(part.way.nodeIds[part.segment+1]!,metric.elevationProfile!.at(-1)!.elevationMeters);
        for (const edge of compiledEdgesForSegment(part.way,part.segment,part.way.coordinates.slice(part.segment,part.segment+2),metric,{nodeFlags:part.nodeFlags})) store.putEdge(edge);
      }
    });
    pending = []; await check();
  };
  try {
    let work = 0;
    const readNodeFlags=store.database.prepare(`SELECT n.id,json_extract(n.record,'$.flags') AS flags FROM way_nodes w JOIN nodes n ON n.id=w.node_id WHERE w.way_id=? ORDER BY w.ordinal`);
    for (const row of store.database.prepare("SELECT record FROM ways WHERE edge_class='trail' AND access_state IN ('public','unknown') ORDER BY id").iterate()) {
      const way = JSON.parse(String(row.record)) as NormalizedWay;
      const flags=new Map(readNodeFlags.all(way.id).map(node=>[String(node.id),JSON.parse(String(node.flags)) as string[]]));
      for (let segment=0;segment<way.nodeIds.length-1;segment++) {
        if (++work%1000===0) await check();
        if (!eligible.get(`${way.id}:${segment}`)) continue;
        pending.push({id:`${way.id}:${segment}`,way,segment,nodeFlags:[flags.get(way.nodeIds[segment]!)??[],flags.get(way.nodeIds[segment+1]!)??[]]}); if (pending.length>=4000) await flush();
      }
    }
    if (pending.length) await flush();
    return {measuredSegments,reusedSegments};
  } finally {cache.close();}
}
