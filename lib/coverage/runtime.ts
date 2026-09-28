import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { createPreparedSchema } from "@/lib/data/sqlite-writer";
import { exportPreparedRelease, preparedReleaseId, publishPreparedCatalog } from "@/lib/data/prepared-release";
import { writeProgressiveTopology } from "@/lib/data/progressive/topology";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { insertGraph, selectProgressiveEdges } from "@/lib/data/progressive/publish";
import { readOsmSourceConfig } from "@/lib/data/osm/source";
import { readOfficialTrailSourceConfig, readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot } from "@/lib/data/official-trails/source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { sha256File } from "@/lib/data/file-source";
import { calculateEdgeMetricsBatch, type EdgeMetrics } from "@/lib/data/metrics";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import { applyRestriction } from "@/lib/data/curated-access";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION as METRIC_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { contentId, intersectCoverage, rectangle, unionCoverage } from "./geometry";
import { NORMALIZATION_VERSION } from "./source-store";
import { elevationCache, elevationFor, describeCanonicalElevation } from "./elevation";
import { reconcileInventory } from "./inventory";
import { preparedNamedAreas } from "./named-areas";
import { auditOfficialTrailReferences, officialSourceEnvelope } from "./references";
import { preparationSession, preparationInputs, importLocalSources } from "./preparation";
import { planLocalCoverage } from "./plan";
import { sourceRecipeSchema, type SourceRecipe } from "./recipe";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { NormalizedWay } from "@/lib/data/types";
import { lineIsInsideArea } from "@/lib/graph/geometry";
import type { CoverageRunnerContext, CoverageRunResult } from "./types";
export const COVERAGE_PACK_ID = "local-coverage";
const BUILD_VERSION = `local-areas-v1:${NORMALIZATION_VERSION}`;

/** Prepare one bounded routing graph and advertise only its eligible start area. */
export async function buildLocalCoverage(input: SourceRecipe, startGeometry: AreaGeometry, context: CoverageRunnerContext): Promise<CoverageRunResult> {
  const recipe = sourceRecipeSchema.parse(input), area = planLocalCoverage(recipe, startGeometry);
  const session = await preparationSession(recipe, context);
  const {root, outputRoot, cacheRoot, raws, units, check, report} = session;
  let scratch: string | undefined;
  const durable = (source: SourceSnapshot) => { const { localPath, ...value } = source; void localPath; return value; };
  const references: { snapshot: SourceSnapshot; osmId: string; envelope: readonly [number, number, number, number] }[] = [];
  try {
    let previous: DataRelease | undefined;
    try { previous = dataReleaseSchema.parse(JSON.parse(await readFile(path.join(outputRoot, "release.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous && previous.partitioning !== "local-areas") throw new Error("Remove the old network release before publishing local areas");
    const inputs = await preparationInputs(recipe, session, area.geometry);
    await importLocalSources(session, inputs, area.geometry);
    const {restrictions} = inputs;
    await mkdir(outputRoot, {recursive:true});
    scratch = await mkdtemp(path.join(root, ".area-"));
    units.push({id:area.id, geometry:area.geometry, status:"pending"});
    for (const region of recipe.reviewedRegionIds) {
      try {
        const config = await readOfficialTrailSourceConfig(path.resolve(`data/regions/${region}/official-trail-source.json`));
        if (!intersectCoverage(rectangle(officialSourceEnvelope(config)), area.geometry)) continue;
        const snapshot = await readPinnedOfficialTrailSnapshot(cacheRoot, config).catch(async (error: unknown) => {
          if (recipe.offline && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          if (recipe.offline) throw error;
          return (await refreshPinnedOfficialTrailSnapshot(cacheRoot, config)).snapshot;
        });
        if (snapshot)
          references.push({ snapshot, envelope: officialSourceEnvelope(config), osmId: (await readOsmSourceConfig(path.resolve(`data/regions/${region}/osm-source.json`))).id });
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
    }
    const dem = elevationCache(), results: DataRelease[] = [], receipts = path.join(root, "areas");
    await mkdir(receipts, { recursive: true });
    {
      const unit = units.find(unit => unit.id === area.id)!;
      unit.status = "processing";
      await report(`Preparing ${area.id}`);
      const stagePath = path.join(scratch, "stage.sqlite"), databasePath = path.join(scratch, "area.sqlite");
      const store = openProgressiveGraphStore({ stagingPath: stagePath, buildIdentity: area.id });
      try {
        const memberSources = new Set<string>();
        let work = 0;
        let pending: Array<() => void> = [];
        const flush = () => {
          if (pending.length) store.transaction(() => { for (const write of pending) write(); });
          pending = [];
        };
        const enqueue = (write: () => void) => {
          pending.push(write);
          if (pending.length < 1000) return false;
          flush();
          return true;
        };
        store.database.exec("CREATE TEMP TABLE eligible_segments(id TEXT PRIMARY KEY) STRICT");
        const eligible = store.database.prepare("INSERT OR IGNORE INTO eligible_segments VALUES (?)");
        let unsupportedBuildings = 0;
        for (const raw of raws) {
          unsupportedBuildings += Number(raw.db.prepare("SELECT count(*) AS n FROM inventory WHERE disposition='unsupported'").get()!.n);
          const sourceCoverage = intersectCoverage(area.geometry, recipe.sources.find(source => source.config.id === raw.source.id)!.geometry)!;
          for (const {way, nodes} of raw.ways(sourceCoverage)) {
            for (const node of nodes) if (enqueue(() => store.putNode(node))) await check();
            let current = way;
            for (const file of restrictions) {
              const rule = file.restrictions.find(rule => rule.externalId === current.externalId);
              if (rule) current = applyRestriction(current, rule, file.snapshot.id);
            }
            if (enqueue(() => store.putWay(current))) await check();
            if (current.edgeClass === "trail" && ["public", "unknown"].includes(current.accessState)) {
              for (let segment = 0; segment < current.nodeIds.length - 1; segment++) {
                if (++work % 1000 === 0) await check();
                // Complete OSM ways can cross adjacent provider extents. The plan
                // verifies their union covers the route buffer; do not cut this seam.
                if (lineIsInsideArea(current.coordinates.slice(segment, segment + 2), area.geometry)) {
                  if (enqueue(() => { eligible.run(`${current.id}:${segment}`); })) await check();
                }
              }
            }
            current.sourceRefs.forEach(id => memberSources.add(id));
            memberSources.add(raw.source.id);
          }
          for (const building of raw.buildings(area.geometry)) {
            if (enqueue(() => store.putBuilding(building))) await check();
            memberSources.add(raw.source.id);
          }
          for (const evidence of raw.evidence(area.geometry)) {
            if (enqueue(() => store.putPortalEvidence(evidence))) await check();
            evidence.sourceRefs.forEach(id => memberSources.add(id));
            memberSources.add(raw.source.id);
          }
        }
        flush();
        await check();
        if (!Number(store.database.prepare("SELECT count(*) AS n FROM eligible_segments").get()!.n)) throw new Error("No eligible walking links occur inside this route buffer");
        let sampled: Awaited<ReturnType<typeof elevationFor>> | undefined;
        const elevation = await describeCanonicalElevation(area.geometry, cacheRoot, root, dem) ?? (sampled = await elevationFor(unit, cacheRoot, root, recipe.offline, dem));
        const sources = [...raws.map(raw => raw.source), ...restrictions.map(file => file.snapshot)].filter(source => memberSources.has(source.id));
        sources.push(elevation.source);
        sources.sort((a,b)=>a.id.localeCompare(b.id));
        sources.forEach(source => store.putSource(source));
        const metadata = await preparedNamedAreas({ geometry: area.geometry, sources: sources.map(durable), snapshots: raws.filter(raw => memberSources.has(raw.source.id)).map(raw => raw.source), preparationRoot: root, regionIds: recipe.reviewedRegionIds });
        for (const source of metadata.sources)
          store.putSource({ ...source, contentHash: source.contentHash as `sha256:${string}`, localPath: "" });
        const hash = createHash("sha256");
        for (const table of ["nodes", "ways", "evidence", "buildings", "eligible_segments"] as const) {
          const query = table === "buildings" ? "SELECT lon,lat FROM buildings ORDER BY lon,lat" : table === "eligible_segments" ? "SELECT id FROM eligible_segments ORDER BY id" : `SELECT id,record FROM ${table} ORDER BY id`;
          for (const row of store.database.prepare(query).iterate()) {
            hash.update(JSON.stringify([table, row]));
            if (++work % 1000 === 0) await check();
          }
        }
        const selectedRegions = new Set(metadata.searchRegions.map(region => region.namedAreaId));
        const limitations = [...recipe.limitations,
          ...(unsupportedBuildings ? [`The local context contains ${unsupportedBuildings} unsupported building relations. Building-based trailhead filtering may be incomplete; individual reasons are recorded in its context inventory.`] : []), "Access and building context uses buffered, node-based source extracts; features without a node inside that buffer can be absent.", "Local graphs preserve routes within the configured distance budget and source coverage; missing source trails may still exist."];
        const inputFingerprint = contentId({ area: area.id, context: hash.digest("hex"), sources: metadata.sources, topology: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION, metric: METRIC_VERSION, compiler: BUILD_VERSION, elevation: elevation.productFingerprint });
        const options = {
          databasePath, outputRoot, geometry: area.geometry, sources: metadata.sources,
          regions: metadata.namedAreas.filter(area => selectedRegions.has(area.id))
            .map(({ id, name, geometry, aliases, sourceIds }) => ({ id, name, geometry, aliases, sourceIds })),
          builtAt: metadata.sources.map(source => source.retrievedAt).sort().at(-1)!,
          compilerVersion: BUILD_VERSION, metricAlgorithmVersion: METRIC_VERSION,
          limitations, checkpoint: check, publish: false,
          area: {id:area.id, inputFingerprint, startGeometry:area.startGeometry, maximumRouteMiles:area.maximumRouteMiles, bufferMiles:area.bufferMiles},
        };
        // The action cache keys local inputs; immutable blobs key their resulting bytes.
        const receiptPath = path.join(receipts, `${preparedReleaseId(options)}.json`);
        let cached: {
          release: DataRelease;
          compressedHash: string;
        } | undefined;
        try {
          cached = JSON.parse(await readFile(receiptPath, "utf8"));
          if(!cached || typeof cached!=="object")throw new Error(`Malformed area checkpoint: ${area.id}`);
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        }
        if (cached) {
          dataReleaseSchema.parse(cached.release);
          if (cached.release.id !== preparedReleaseId(options) || cached.release.sections.length !== 1 || cached.release.sections[0]?.id !== area.id || cached.release.artifacts.length !== 1)
            throw new Error(`Area checkpoint identity failed verification: ${area.id}`);
          const artifact = cached.release.artifacts[0]!, file = path.join(outputRoot, artifact.path);
          if (artifact.graphId !== preparedReleaseId(options) || contentId({startGeometry:cached.release.sections[0]!.geometry,geometry:cached.release.geometry,sources:cached.release.sources,regions:cached.release.regions,limitations:cached.release.limitations,summary:cached.release.sections[0]!.area}) !== contentId({startGeometry:area.startGeometry,geometry:options.geometry,sources:options.sources,regions:options.regions,limitations:options.limitations,summary:{maximumRouteMiles:area.maximumRouteMiles,bufferMiles:area.bufferMiles}}))
            throw new Error(`Area checkpoint metadata failed verification: ${area.id}`);
          if ((await stat(file)).size !== artifact.compressedBytes || await sha256File(file) !== cached.compressedHash)
            throw new Error(`Area checkpoint failed verification: ${area.id}`);
          results.push(cached.release);
          unit.status = "prepared";
          await report(`Reused ${area.id}`);
        } else {
          sampled ??= await elevationFor(unit, cacheRoot, root, recipe.offline, dem);
          if (sampled.productFingerprint !== elevation.productFingerprint)
            throw new Error("Elevation inputs changed during area preparation");
          await prepareMetrics(store, path.join(root, "metrics.sqlite"), sampled, check);
          const member = store.database.prepare("SELECT 1 FROM eligible_segments WHERE id=?"), audits = [];
          for (const raw of raws)
            audits.push(await reconcileInventory(raw, store, area.geometry, check, id => Boolean(member.get(id)), restrictions));
          await store.derivePortals(area.geometry, check);
          const db = new DatabaseSync(databasePath);
          try {
            db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=DELETE;PRAGMA cache_size=-16384;PRAGMA temp_store=FILE");
            createPreparedSchema(db);
            await selectProgressiveEdges(store, area.geometry, check);
            await insertGraph(store, db, topologySha256(area.geometry), new Set(metadata.sources.map(source => source.id)), check, true);
            await writeProgressiveTopology(db, check);
            db.prepare("INSERT INTO metadata VALUES ('schemaVersion','7')").run();
            db.prepare("INSERT INTO metadata VALUES ('releaseId',?)").run(preparedReleaseId(options));
            const add = db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)");
            for (const source of metadata.sources)
              add.run(source.id, source.authority, source.dataset, source.version, source.retrievedAt, source.url, source.license, source.contentHash);
          }
          finally {
            db.close();
          }
          const built = await exportPreparedRelease(options);
          await writeJsonAtomically(receiptPath, { release: built, compressedHash: await sha256File(path.join(outputRoot, built.artifacts[0]!.path)), inventory: audits });
          results.push(built);
          unit.status = "prepared";
          await report(`Prepared ${area.id}`);
        }
      }
      finally {
        store.close();
        for (const file of [databasePath, stagePath, `${stagePath}-wal`, `${stagePath}-shm`])
          await rm(file, { force: true });
      }
    }
    if (previous) {
      const sections = previous.sections.filter(section => section.id !== area.id);
      const ids = new Set(sections.flatMap(section => section.artifactIds));
      if (sections.length) results.unshift({...previous, sections, artifacts:previous.artifacts.filter(artifact => ids.has(artifact.id)), geometry:unionCoverage(previous.artifacts.filter(artifact => ids.has(artifact.id)).map(artifact => artifact.geometry))});
    }
    const geometry = unionCoverage(results.map(result => result.geometry)), referenceAudits = [];
    for (const raw of raws) {
      const applicable = references.filter(reference => reference.osmId === raw.source.id);
      if (!applicable.length)
        referenceAudits.push(await auditOfficialTrailReferences({ checkpoint: check, osm: raw, coverage: area.geometry, installedCoverage: area.geometry }));
      for (const reference of applicable)
        referenceAudits.push(await auditOfficialTrailReferences({ checkpoint: check, osm: raw, coverage: area.geometry, installedCoverage: area.geometry, officialSnapshot: reference.snapshot, sourceEnvelope: reference.envelope }));
    }
    const sources = new Map<string, DataRelease["sources"][number]>();
    for (const result of results)
      for (const source of result.sources) {
        const prior = sources.get(source.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(source))
          throw new Error(`Conflicting source metadata ${source.id}`);
        sources.set(source.id, source);
      }
    for (const reference of references) {
      const source=durable(reference.snapshot), prior=sources.get(source.id);
      if(prior && JSON.stringify(prior)!==JSON.stringify(source)) throw new Error(`Conflicting source metadata ${source.id}`);
      sources.set(source.id,source);
    }
    const release: DataRelease = { ...results[0]!, id: "pending", partitioning: "local-areas", geometry, builtAt: [...sources.values()].map(source => source.retrievedAt).sort().at(-1)!, sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), regions: [...new Map(results.flatMap(result => result.regions).map(region => [region.id, region])).values()], sections: results.flatMap(result => result.sections), artifacts: results.flatMap(result => result.artifacts), limitations: [...new Set([...results.flatMap(result => result.limitations), ...referenceAudits.map(audit => audit.limitation),"Independent reference comparisons use local preparation coverage and source proximity; they do not establish installed official-feature membership.",...(referenceAudits.some(audit=>audit.status!=="audited")?["Independent reference data does not cover the entire prepared area extent."]:[])])] };
    release.sections.sort((a, b) => a.id.localeCompare(b.id));
    release.artifacts.sort((a, b) => a.id.localeCompare(b.id));
    release.regions.sort((a, b) => a.id.localeCompare(b.id));
    release.limitations.sort();
    release.id = `release-${contentId({ ...release, id: undefined }).slice(0, 32)}`;
    dataReleaseSchema.parse(release);
    await check();
    await writeJsonAtomically(path.join(outputRoot, "references.json"), referenceAudits);
    await publishPreparedCatalog(release, outputRoot, check);
    units.forEach(unit => unit.status = "installed");
    await report("Coherent release exported");
    return { status: "completed", units, completedUnits: units.length, snapshot: { schemaVersion: 1, id: COVERAGE_PACK_ID, dataVersion: release.id, geometry, unitIds: units.map(unit => unit.id), createdAt: release.builtAt, sourceFingerprint: contentId(release.sources), auditStatus: "passed", limitations: release.limitations } };
  }
  finally {
    await session.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
async function prepareMetrics(store: ReturnType<typeof openProgressiveGraphStore>, cachePath: string, elevation: Awaited<ReturnType<typeof elevationFor>>, check: () => Promise<void>) {
  const cache = new DatabaseSync(cachePath);
  cache.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; CREATE TABLE IF NOT EXISTS metrics(id TEXT NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(id,fingerprint)) STRICT");
  type Part = {id:string;segment:number;way:NormalizedWay};
  let pending: Part[] = [];
  const eligible = store.database.prepare("SELECT 1 FROM eligible_segments WHERE id=?");
  const get = cache.prepare("SELECT value FROM metrics WHERE id=? AND fingerprint=?"), put = cache.prepare("INSERT OR REPLACE INTO metrics VALUES(?,?,?)");
  const flush = async () => {
    const values: EdgeMetrics[] = [], missing: number[] = [], fingerprints: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      const part = pending[i]!;
      const fingerprint = contentId({ geometry: part.way.coordinates.slice(part.segment, part.segment + 2), algorithm: METRIC_VERSION, sampler: elevation.sampler.algorithmVersion, elevation: elevation.fingerprintForGeometry(part.way.coordinates.slice(part.segment, part.segment + 2)) });
      fingerprints[i] = fingerprint;
      const cached = get.get(part.id, fingerprint);
      if (cached) values[i] = JSON.parse(String(cached.value)); else missing.push(i);
    }
    if (missing.length) {
      const measured = await calculateEdgeMetricsBatch(missing.map(i => { const part = pending[i]!; return part.way.coordinates.slice(part.segment, part.segment + 2); }), elevation.sampler);
      cache.exec("BEGIN");
      try {
        missing.forEach((i, j) => { values[i] = measured[j]!; put.run(pending[i]!.id, fingerprints[i]!, JSON.stringify(values[i])); });
        cache.exec("COMMIT");
      } catch (error) { cache.exec("ROLLBACK"); throw error; }
    }
    store.transaction(() => {
      for (const [i, part] of pending.entries()) {
        const metric = values[i]!;
        if (!metric.elevationProfile) throw new Error(`Missing elevation on ${part.id}`);
        store.setNodeElevation(part.way.nodeIds[part.segment]!, metric.elevationProfile[0]!.elevationMeters);
        store.setNodeElevation(part.way.nodeIds[part.segment + 1]!, metric.elevationProfile.at(-1)!.elevationMeters);
        for (const edge of compiledEdgesForSegment(part.way, part.segment, part.way.coordinates.slice(part.segment, part.segment + 2), metric)) store.putEdge(edge);
      }
    });
    pending = [];
    await check();
  };
  try {
    let work = 0;
    for (const row of store.database.prepare("SELECT record FROM ways WHERE edge_class='trail' AND access_state IN ('public','unknown') ORDER BY id").iterate()) {
      const way = JSON.parse(String(row.record)) as NormalizedWay;
      for (let segment=0; segment<way.nodeIds.length-1; segment++) {
        if (++work%1000===0) await check();
        if (!eligible.get(`${way.id}:${segment}`)) continue;
        pending.push({id:`${way.id}:${segment}`,way,segment});
        if (pending.length >= 500) await flush();
      }
    }
    if (pending.length) await flush();
  } finally {cache.close();}
}
