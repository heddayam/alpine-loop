import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { readCuratedAccessFile } from "@/lib/data/curated-access";
import { readPinnedOsmSnapshot, refreshPinnedOsmSnapshot } from "@/lib/data/osm/source";
import { sha256File } from "@/lib/data/file-source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { contentId, subtractCoverage, unionCoverage } from "./geometry";
import { NETWORK_DISCOVERY_VERSION, networkCatalogId, readNetworkCatalog, type NetworkCatalog } from "./discovery-catalog";
import { sourceRecipeSchema, type SourceRecipe } from "./recipe";
import { CoverageSourceStore, NORMALIZATION_VERSION, sourceStoreFileName } from "./source-store";
import { CoverageResourceGuard } from "./resources";
import { NetworkInventory } from "./networks";
import type { CoverageRunnerContext, CoverageUnit } from "./types";

function preparationPaths() {
  return {
    root: path.resolve(process.env.ALPINE_COVERAGE_ROOT ?? ".cache/build"),
    outputRoot: path.resolve(process.env.ALPINE_RELEASE_ROOT ?? ".local-data/releases/prepared"),
    cacheRoot: path.resolve(process.env.ALPINE_SOURCE_CACHE ?? ".cache/sources"),
  };
}
export async function preparationSession(recipe: SourceRecipe, context: CoverageRunnerContext, building = false) {
  const paths = preparationPaths();
  await mkdir(paths.root, {recursive:true});
  const resources = new CoverageResourceGuard({memoryLimitBytes:recipe.memoryLimitMiB * 1024 ** 2, diskPaths:building ? [paths.root,paths.outputRoot] : [paths.root]});
  const raws: CoverageSourceStore[] = [], units: CoverageUnit[] = [];
  resources.start();
  return {
    ...paths, raws, units,
    check: async () => {
      await setImmediate();
      await resources.checkpoint();
      if (context.signal.aborted || await context.checkpoint() !== "continue") throw new Error("Coverage build interrupted at a checkpoint");
    },
    report: (stage: string) => context.report({stage, units, completedUnits:units.filter(unit => unit.status === "prepared" || unit.status === "installed").length}),
    close: async () => { raws.forEach(raw => raw.close()); await resources.stop(); },
  };
}
type Session = Awaited<ReturnType<typeof preparationSession>>;

/** Verify pinned source bytes and current restrictions before trusting durable discovery. */
export async function discoveryInputs(recipe: SourceRecipe, session: Session, allowDownload: boolean) {
  let supported = unionCoverage(recipe.sources.map(source => source.geometry)) as ReturnType<typeof subtractCoverage>;
  for (const exclusion of recipe.exclusions) if (supported) supported = subtractCoverage(supported, exclusion.geometry);
  if (!supported) throw new Error("No supported source coverage remains");
  const restrictions: Awaited<ReturnType<typeof readCuratedAccessFile>>[] = [];
  for (const region of [...recipe.reviewedRegionIds].sort()) {
    try { restrictions.push(await readCuratedAccessFile(path.resolve(`data/regions/${region}/access-restrictions.json`))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const snapshots = [];
  for (const source of recipe.sources) {
    await session.check();
    await session.report(`Verifying ${source.config.dataset}`);
    const snapshot = await readPinnedOsmSnapshot(session.cacheRoot, source.config).catch(async (error: unknown) => {
      if (!allowDownload || recipe.offline || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return (await refreshPinnedOsmSnapshot(session.cacheRoot, source.config)).snapshot;
    });
    if (snapshot.contentHash !== source.sha256) throw new Error(`Pinned source hash differs for ${source.config.id}`);
    snapshots.push(snapshot);
  }
  const inputFingerprint = contentId({
    discovery: NETWORK_DISCOVERY_VERSION, normalization: NORMALIZATION_VERSION,
    recipe,
    restrictions: restrictions.map(({snapshot:{localPath, ...snapshot}, restrictions}) => { void localPath; return {snapshot, restrictions}; }),
  });
  return {supported, restrictions, snapshots, inputFingerprint};
}
export async function importDiscoverySources(session: Session, inputs: Awaited<ReturnType<typeof discoveryInputs>>) {
  for (const snapshot of inputs.snapshots) {
    const raw = new CoverageSourceStore(path.join(session.root, sourceStoreFileName(snapshot)), snapshot);
    session.raws.push(raw);
    await session.report(`Importing ${snapshot.dataset}`);
    await raw.import(session.check, {onStage: async stage => session.report(`${stage}: ${snapshot.dataset}`)});
  }
}
export async function verifyDiscoveryInventory(catalogPath: string, catalog: NetworkCatalog) {
  const file = path.join(path.dirname(catalogPath), catalog.inventory.file);
  if (await sha256File(file) !== catalog.inventory.sha256) throw new Error("Discovery inventory failed verification");
  return file;
}

/** Inventory every configured source once; publish only fully closed, verified discovery files. */
export async function discoverNetworks(input: SourceRecipe, context: CoverageRunnerContext): Promise<{catalogPath:string;catalog:NetworkCatalog}> {
  const recipe = sourceRecipeSchema.parse(input), session = await preparationSession(recipe, context);
  let scratch: string | undefined, inventory: NetworkInventory | undefined;
  try {
    const inputs = await discoveryInputs(recipe, session, true);
    const directory = path.join(session.root, "discovery", inputs.inputFingerprint), catalogPath = path.join(directory, "catalog.json");
    let previous: NetworkCatalog | undefined;
    try { previous = await readNetworkCatalog(catalogPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous) {
      const catalog = previous;
      if (catalog.inputFingerprint !== inputs.inputFingerprint) throw new Error("Discovery inputs failed verification");
      await verifyDiscoveryInventory(catalogPath, catalog);
      await session.check();
      await session.report(`Reused discovery of ${catalog.networks.length} networks`);
      return {catalogPath,catalog};
    }
    await importDiscoverySources(session, inputs);
    await mkdir(path.dirname(directory), {recursive:true});
    scratch = await mkdtemp(path.join(path.dirname(directory), ".discovery-"));
    const file = path.join(scratch, "inventory.sqlite");
    inventory = new NetworkInventory(file);
    await session.report("Discovering all connected trail networks");
    const networks = await inventory.discover(session.raws, inputs.supported, inputs.restrictions, session.check);
    inventory.close(); inventory = undefined;
    const contents: Omit<NetworkCatalog,"id"> = {
      schemaVersion:1, discoveryVersion:NETWORK_DISCOVERY_VERSION, inputFingerprint:inputs.inputFingerprint,
      recipe, inventory:{file:"inventory.sqlite",sha256:await sha256File(file)}, networks,
    };
    const catalog = {...contents,id:networkCatalogId(contents)};
    await writeJsonAtomically(path.join(scratch, "catalog.json"), catalog);
    await readNetworkCatalog(path.join(scratch, "catalog.json"));
    await session.check();
    await rename(scratch, directory); scratch = undefined;
    await session.report(`Discovered ${networks.length} networks; inspect the catalog before building`);
    return {catalogPath,catalog};
  } finally {
    inventory?.close();
    await session.close();
    if (scratch) await rm(scratch, {recursive:true,force:true});
  }
}
