import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { dataReleaseSchema, type DataRelease } from "@/lib/contracts/releases";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { createPreparedSchema } from "@/lib/data/sqlite-writer";
import { exportPreparedRelease, preparedReleaseId, publishPreparedCatalog } from "@/lib/data/prepared-release";
import { writeProgressiveTopology } from "@/lib/data/progressive/topology";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { insertGraph, selectProgressiveEdges } from "@/lib/data/progressive/publish";
import { readOsmSourceConfig, readPinnedOsmSnapshot, refreshPinnedOsmSnapshot } from "@/lib/data/osm/source";
import { readOfficialTrailSourceConfig, readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot } from "@/lib/data/official-trails/source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { sha256File } from "@/lib/data/file-source";
import { calculateEdgeMetricsBatch, type EdgeMetrics } from "@/lib/data/metrics";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import { applyRestriction, readCuratedAccessFile } from "@/lib/data/curated-access";
import { PROGRESSIVE_DEM_METRIC_ALGORITHM_VERSION as METRIC_VERSION } from "@/lib/data/elevation/uv-rasterio-sampler";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { coverageExclusions, coverageSources, legacyRegionIds, connectedCoverageSources } from "./collections";
import { contentId, subtractCoverage, unionCoverage } from "./geometry";
import { CoverageSourceStore, sourceStoreFileName } from "./source-store";
import { elevationCache, elevationFor, describeCanonicalElevation } from "./elevation";
import { classifyIntendedInventory, reconcileInventory } from "./inventory";
import { preparedNamedAreas } from "./named-areas";
import { CoverageResourceGuard } from "./resources";
import { auditOfficialTrailReferences, officialSourceEnvelope } from "./references";
import { NetworkInventory, type TrailNetwork } from "./networks";
import { COVERAGE_PACK_ID, COVERAGE_BUILD_VERSION as BUILD_VERSION } from "./planning";
import type { BuildRecipe } from "./recipe";
import type { CoveragePlan, CoverageRunnerContext, CoverageRunResult, CoverageUnit } from "./types";
export { COVERAGE_PACK_ID, plan } from "./planning";
/** Source discovery precedes expensive preparation. Only the final catalog write activates data. */
export async function run(plan: CoveragePlan, context: CoverageRunnerContext, recipe?: BuildRecipe): Promise<CoverageRunResult> {
  const root = path.resolve(process.env.ALPINE_COVERAGE_ROOT ?? ".local-data/coverage"), outputRoot = path.resolve(process.env.ALPINE_RELEASE_ROOT ?? ".local-data/releases/prepared"), cacheRoot = path.resolve(process.env.ALPINE_SOURCE_CACHE ?? ".cache/sources");
  await mkdir(root, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(root, ".networks-")), raws: CoverageSourceStore[] = [], units: CoverageUnit[] = [];
  const inventory = new NetworkInventory(path.join(scratch, "inventory.sqlite"));
  const resources = new CoverageResourceGuard({ memoryLimitBytes: plan.request.memoryLimitMiB * 1024 ** 2, diskPaths: [root, outputRoot] });
  resources.start();
  const check = async () => {
    await setImmediate();
    await resources.checkpoint();
    if (context.signal.aborted || await context.checkpoint() !== "continue") {
      throw new Error("Coverage build interrupted at a checkpoint");
    }
  };
  const report = (stage: string) => context.report({ stage, units, completedUnits: units.filter(unit => unit.status === "prepared" || unit.status === "installed").length });
  const durable = (source: SourceSnapshot) => { const { localPath, ...value } = source; void localPath; return value; };
  const references: {
    snapshot: SourceSnapshot;
    osmId: string;
    envelope: readonly [number, number, number, number];
  }[] = [];
  try {
    const candidates = recipe?.sources ?? await coverageSources();
    const configured = connectedCoverageSources<(typeof candidates)[number]>(plan.geometry, candidates).sort((a,b)=>a.config.id.localeCompare(b.config.id));
    const exclusions = recipe?.exclusions ?? await coverageExclusions();
    if (!configured.length) {
      await report("No eligible networks intersect the selection; previous release is unchanged");
      return {status:"completed",units,completedUnits:0,snapshot:null};
    }
    let supported: CoveragePlan["geometry"] | null = unionCoverage(configured.map(source => source.geometry));
    for (const exclusion of exclusions)
      if (supported)
        supported = subtractCoverage(supported, exclusion.geometry);
    if (!supported)
      throw new Error("No supported source coverage remains");
    const restrictions: Awaited<ReturnType<typeof readCuratedAccessFile>>[] = [];
    for (const region of recipe?.reviewedRegionIds ?? legacyRegionIds) {
      try {
        restrictions.push(await readCuratedAccessFile(path.resolve(`data/regions/${region}/access-restrictions.json`)));
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
      try {
        const config = await readOfficialTrailSourceConfig(path.resolve(`data/regions/${region}/official-trail-source.json`));
        const snapshot = await readPinnedOfficialTrailSnapshot(cacheRoot, config).catch(async (error: unknown) => {
          if (plan.request.offline && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          if (plan.request.offline) throw error;
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
    for (const source of configured) {
      const prior = raws.find(raw => raw.source.id === source.config.id);
      if (prior) {
        if ("sha256" in source && source.sha256 !== prior.source.contentHash)
          throw new Error(`Conflicting duplicate source ${source.config.id}`);
        continue;
      }
      await report(`Verifying ${source.config.dataset}`);
      const snapshot = await readPinnedOsmSnapshot(cacheRoot, source.config).catch(async (error: unknown) => {
        if (plan.request.offline) throw error;
        return (await refreshPinnedOsmSnapshot(cacheRoot, source.config)).snapshot;
      });
      if ("sha256" in source && source.sha256 !== snapshot.contentHash)
        throw new Error(`Pinned source hash differs for ${source.config.id}`);
      const raw = new CoverageSourceStore(path.join(root, sourceStoreFileName(snapshot)), snapshot);
      raws.push(raw);
      await raw.import(check, { onStage: async (stage) => report(`${stage}: ${source.config.dataset}`) });
      await classifyIntendedInventory(raw, supported, exclusions, check);
    }
    for (const file of restrictions) {
      for (const restriction of file.restrictions) {
        const id = restriction.externalId.replace(/^way\//, "");
        if (!raws.some(raw => raw.db.prepare("SELECT 1 FROM ways WHERE id=?").get(id))) {
          throw new Error(`Curated access target ${restriction.externalId} is missing from topology`);
        }
      }
    }
    await report("Discovering connected trail networks");
    const networks = await inventory.discover(raws, supported, plan.geometry, restrictions, check);
    if (!networks.length) {
      await report("No eligible networks intersect the selection; previous release is unchanged");
      return { status: "completed", units, completedUnits: 0, snapshot: null };
    }
    units.push(...networks.map(network => ({ id: network.id, geometry: network.geometry, status: "pending" as const })));
    const dem = elevationCache(), results: DataRelease[] = [], receipts = path.join(root, "networks");
    await mkdir(receipts, { recursive: true });
    for (const network of networks) {
      const unit = units.find(unit => unit.id === network.id)!;
      unit.status = "processing";
      await report(`Preparing ${network.id}`);
      const stagePath = path.join(scratch, "stage.sqlite"), databasePath = path.join(scratch, "network.sqlite");
      const store = openProgressiveGraphStore({ stagingPath: stagePath, buildIdentity: network.id });
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
        for (const way of inventory.ways(network)) {
          for (const id of way.nodeIds) {
            const node = inventory.node(id);
            if (enqueue(() => store.putNode(node))) await check();
            node.sourceRefs.forEach(id => memberSources.add(id));
          }
          if (enqueue(() => store.putWay(way))) await check();
          way.sourceRefs.forEach(id => memberSources.add(id));
        }
        for (const raw of raws) {
          for (const { way, nodes } of raw.ways(network.geometry)) {
            if (way.edgeClass === "trail")
              continue;
            for (const node of nodes) {
              if (enqueue(() => store.putNode(node))) await check();
            }
            let current = way;
            for (const file of restrictions) {
              const rule = file.restrictions.find(rule => rule.externalId === current.externalId);
              if (rule)
                current = applyRestriction(current, rule, file.snapshot.id);
            }
            if (enqueue(() => store.putWay(current))) await check();
            current.sourceRefs.forEach(id => memberSources.add(id));
            memberSources.add(raw.source.id);
          }
          for (const building of raw.buildings(network.geometry)) {
            if (enqueue(() => store.putBuilding(building))) await check();
            memberSources.add(raw.source.id);
          }
          for (const evidence of raw.evidence(network.geometry)) {
            if (enqueue(() => store.putPortalEvidence(evidence))) await check();
            evidence.sourceRefs.forEach(id => memberSources.add(id));
            memberSources.add(raw.source.id);
          }
        }
        flush();
        await check();
        let sampled: Awaited<ReturnType<typeof elevationFor>> | undefined;
        const elevation = await describeCanonicalElevation(network.geometry, cacheRoot, root, dem) ?? (sampled = await elevationFor(unit, cacheRoot, root, plan.request.offline, dem));
        const sources = [...raws.map(raw => raw.source), ...restrictions.map(file => file.snapshot)].filter(source => memberSources.has(source.id));
        sources.push(elevation.source);
        sources.sort((a,b)=>a.id.localeCompare(b.id));
        sources.forEach(source => store.putSource(source));
        const metadata = await preparedNamedAreas({ geometry: network.geometry, sources: sources.map(durable), snapshots: raws.filter(raw => memberSources.has(raw.source.id)).map(raw => raw.source), preparationRoot: root, regionIds: recipe?.reviewedRegionIds });
        for (const source of metadata.sources)
          store.putSource({ ...source, contentHash: source.contentHash as `sha256:${string}`, localPath: "" });
        const hash = createHash("sha256");
        for (const table of ["nodes", "ways", "evidence", "buildings"] as const) {
          const query = table === "buildings" ? "SELECT lon,lat FROM buildings ORDER BY lon,lat" : `SELECT id,record FROM ${table} ORDER BY id`;
          for (const row of store.database.prepare(query).iterate()) {
            hash.update(JSON.stringify([table, row]));
            if (++work % 1000 === 0) await check();
          }
        }
        const selectedRegions = new Set(metadata.searchRegions.map(region => region.namedAreaId));
        const unsupportedBuildings = raws.filter(raw => memberSources.has(raw.source.id)).reduce((count, raw) =>
          count + Number(raw.db.prepare("SELECT count(*) AS n FROM inventory WHERE disposition='unsupported'").get()!.n), 0);
        const limitations = [...(recipe?.limitations ?? []),
          ...(unsupportedBuildings ? [`The source inventory contains ${unsupportedBuildings} unsupported building relations. Building-based trailhead filtering may be incomplete; individual reasons are recorded in the inventory.`] : []), "Networks are complete only within the configured source snapshot and supported coverage. Missing source connections may still exist.", ...(network.sourceBoundaryLimited ? ["This network reaches a source boundary or exclusion and may connect to trails beyond it."] : [])];
        const inputFingerprint = contentId({ network: network.id, context: hash.digest("hex"), sources: metadata.sources, topology: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION, metric: METRIC_VERSION, compiler: BUILD_VERSION, elevation: elevation.productFingerprint });
        const options = {
          databasePath, outputRoot, geometry: network.geometry, sources: metadata.sources,
          regions: metadata.namedAreas.filter(area => selectedRegions.has(area.id))
            .map(({ id, name, geometry, aliases, sourceIds }) => ({ id, name, geometry, aliases, sourceIds })),
          builtAt: metadata.sources.map(source => source.retrievedAt).sort().at(-1)!,
          compilerVersion: BUILD_VERSION, metricAlgorithmVersion: METRIC_VERSION,
          limitations, checkpoint: check, publish: false,
          network: {
            id: network.id, inputFingerprint,
            summary: { nodeCount: network.nodeCount, physicalEdgeCount: network.physicalEdgeCount, sourceBoundaryLimited: network.sourceBoundaryLimited },
          },
        };
        // The action cache keys local inputs; immutable blobs key their resulting bytes.
        const receiptPath = path.join(receipts, `${preparedReleaseId(options)}.json`);
        let cached: {
          release: DataRelease;
          compressedHash: string;
        } | undefined;
        try {
          cached = JSON.parse(await readFile(receiptPath, "utf8"));
          if(!cached || typeof cached!=="object")throw new Error(`Malformed network checkpoint: ${network.id}`);
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        }
        if (cached) {
          dataReleaseSchema.parse(cached.release);
          if (cached.release.id !== preparedReleaseId(options) || cached.release.sections.length !== 1 || cached.release.sections[0]?.id !== network.id || cached.release.artifacts.length !== 1)
            throw new Error(`Network checkpoint identity failed verification: ${network.id}`);
          const artifact = cached.release.artifacts[0]!, file = path.join(outputRoot, artifact.path);
          if (artifact.graphId !== preparedReleaseId(options) || contentId({geometry:cached.release.geometry,sources:cached.release.sources,regions:cached.release.regions,limitations:cached.release.limitations,summary:cached.release.sections[0]!.network}) !== contentId({geometry:options.geometry,sources:options.sources,regions:options.regions,limitations:options.limitations,summary:options.network.summary}))
            throw new Error(`Network checkpoint metadata failed verification: ${network.id}`);
          if ((await stat(file)).size !== artifact.compressedBytes || await sha256File(file) !== cached.compressedHash)
            throw new Error(`Network checkpoint failed verification: ${network.id}`);
          results.push(cached.release);
          unit.status = "prepared";
          await report(`Reused ${network.id}`);
          continue;
        }
        sampled ??= await elevationFor(unit, cacheRoot, root, plan.request.offline, dem);
        if (sampled.productFingerprint !== elevation.productFingerprint)
          throw new Error("Elevation inputs changed during network preparation");
        await prepareMetrics(network, inventory, store, raws, sampled, check);
        const member = inventory.db.prepare("SELECT 1 FROM segments WHERE id=? AND root=?"), audits = [];
        for (const raw of raws)
          audits.push(await reconcileInventory(raw, store, network.geometry, check, id => Boolean(member.get(id, network.root)), restrictions));
        await store.derivePortals(network.geometry, check);
        const db = new DatabaseSync(databasePath);
        try {
          db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=DELETE;PRAGMA cache_size=-16384;PRAGMA temp_store=FILE");
          createPreparedSchema(db);
          await selectProgressiveEdges(store, network.geometry, check);
          await insertGraph(store, db, topologySha256(network.geometry), new Set(metadata.sources.map(source => source.id)), check, true);
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
        await report(`Prepared ${network.id}`);
      }
      finally {
        store.close();
        for (const file of [databasePath, stagePath, `${stagePath}-wal`, `${stagePath}-shm`])
          await rm(file, { force: true });
      }
    }
    const geometry = unionCoverage(results.map(result => result.geometry)), referenceAudits = [];
    for (const raw of raws) {
      const applicable = references.filter(reference => reference.osmId === raw.source.id);
      if (!applicable.length)
        referenceAudits.push(await auditOfficialTrailReferences({ checkpoint: check, osm: raw, coverage: geometry, installedCoverage: null }));
      for (const reference of applicable)
        referenceAudits.push(await auditOfficialTrailReferences({ checkpoint: check, osm: raw, coverage: geometry, installedCoverage: null, officialSnapshot: reference.snapshot, sourceEnvelope: reference.envelope }));
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
    const release: DataRelease = { ...results[0]!, id: "pending", partitioning: "connected-networks", geometry, builtAt: [...sources.values()].map(source => source.retrievedAt).sort().at(-1)!, sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), regions: [...new Map(results.flatMap(result => result.regions).map(region => [region.id, region])).values()], sections: results.flatMap(result => result.sections), artifacts: results.flatMap(result => result.artifacts), limitations: [...new Set([...results.flatMap(result => result.limitations), ...referenceAudits.map(audit => audit.limitation),"Independent reference comparisons use network envelopes and source proximity; they do not establish installed official-feature membership.",...(referenceAudits.some(audit=>audit.status!=="audited")?["Independent reference data does not cover the entire selected network extent."]:[])])] };
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
    inventory.close();
    raws.forEach(raw => raw.close());
    await resources.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}
async function prepareMetrics(network: TrailNetwork, inventory: NetworkInventory, store: ReturnType<typeof openProgressiveGraphStore>, raws: CoverageSourceStore[], elevation: Awaited<ReturnType<typeof elevationFor>>, check: () => Promise<void>) {
  let pending: Array<ReturnType<NetworkInventory["segments"]> extends Generator<infer T> ? T : never> = [];
  const flush = async () => {
    const values: EdgeMetrics[] = [], missing: number[] = [], fingerprints: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      const part = pending[i]!, raw = raws.find(raw => part.way.sourceRefs.includes(raw.source.id))!;
      const fingerprint = contentId({ geometry: part.way.coordinates.slice(part.segment, part.segment + 2), algorithm: METRIC_VERSION, elevation: elevation.productFingerprint });
      fingerprints[i] = fingerprint;
      const cached = raw.db.prepare("SELECT value FROM metrics WHERE id=? AND fingerprint=?").get(part.id, fingerprint);
      if (cached)
        values[i] = JSON.parse(String(cached.value));
      else
        missing.push(i);
    }
    if (missing.length) {
      const measured = await calculateEdgeMetricsBatch(missing.map(i => { const part = pending[i]!; return part.way.coordinates.slice(part.segment, part.segment + 2); }), elevation.sampler);
      missing.forEach((i, j) => {
        const part = pending[i]!, raw = raws.find(raw => part.way.sourceRefs.includes(raw.source.id))!;
        values[i] = measured[j]!;
        raw.db.prepare("INSERT OR REPLACE INTO metrics VALUES(?,?,?)").run(part.id, fingerprints[i]!, JSON.stringify(values[i]));
      });
    }
    store.transaction(() => {
      for (const [i, part] of pending.entries()) {
        const metric = values[i]!;
        if (!metric.elevationProfile) throw new Error(`Missing elevation on ${part.id}`);
        store.setNodeElevation(part.way.nodeIds[part.segment]!, metric.elevationProfile[0]!.elevationMeters);
        store.setNodeElevation(part.way.nodeIds[part.segment + 1]!, metric.elevationProfile.at(-1)!.elevationMeters);
        for (const edge of compiledEdgesForSegment(part.way, part.segment, part.way.coordinates.slice(part.segment, part.segment + 2), metric)) {
          store.putEdge(edge);
        }
      }
    });
    pending = [];
    await check();
  };
  for (const part of inventory.segments(network)) {
    pending.push(part);
    if (pending.length >= 500)
      await flush();
  }
  if (pending.length)
    await flush();
}
