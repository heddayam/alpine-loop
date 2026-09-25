import { DatabaseSync } from "node:sqlite";
import { namedAreaSchema, type CoverageCollection, type PackManifest } from "@/lib/contracts";
import { areaBounds } from "@/lib/graph/geometry";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { NormalizedNamedArea, NormalizedSearchRegion } from "@/lib/data/types";
import { getSearchRegion } from "@/lib/data/named-area-catalog";
import { loadInstalledPack, localPackRoot, type InstalledPack } from "@/lib/packs/installed-pack";
import { namespacedId } from "@/lib/search/identity";
import { legacyRegionIds } from "./collections";
import { contentId, intersectCoverage } from "./geometry";

const LOCAL = "local-coverage";
const ALIAS = "region-id:";
type Sources = PackManifest["sources"];
type MetadataPack = Pick<InstalledPack, "databasePath" | "manifest">;

/** Metadata only: old graph edges never enter the new coverage graph. */
export async function coverageNamedAreas(input: {
  geometry: AreaGeometry; sources: Sources; collections: readonly CoverageCollection[];
  packRoot?: string; installations?: readonly MetadataPack[];
}): Promise<{ namedAreas: NormalizedNamedArea[]; searchRegions: NormalizedSearchRegion[]; sources: Sources }> {
  const installations = input.installations ?? (await Promise.all([LOCAL, ...legacyRegionIds].map((id) => loadInstalledPack(id, input.packRoot ?? localPackRoot())))).filter((pack): pack is InstalledPack => pack !== null);
  if (!input.sources.length) throw new Error("Named coverage requires a source");
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  const namedAreas: NormalizedNamedArea[] = [];
  const byGeometry = new Map<string, NormalizedNamedArea>();
  const selected = new Set<string>();
  const add = (area: NormalizedNamedArea, selectable: boolean, availableSources: Sources) => {
    if (!intersectCoverage(input.geometry, area.geometry)) return;
    area = {...area,sourceIds:area.sourceIds.map(id => {
      const source = availableSources.find((candidate) => candidate.id === id);
      if (!source) throw new Error(`Named area ${area.id} is missing source ${id}`);
      const prior = sources.get(id);
      // Historical selector geometry keeps its original provenance even after
      // routing sources advance. It never contributes old graph records.
      const metadataId = prior && prior.contentHash !== source.contentHash ? `metadata:${id}:${source.contentHash.slice(7)}` : id;
      sources.set(metadataId, metadataId === id ? prior ?? source : {...source,id:metadataId});
      return metadataId;
    })};
    const key = JSON.stringify(area.geometry), prior = byGeometry.get(key);
    if (prior) {
      prior.aliases = [...new Set([...prior.aliases, area.name, ...area.aliases])];
      prior.sourceIds = [...new Set([...prior.sourceIds, ...area.sourceIds])];
      if (selectable) selected.add(prior.id);
    } else {
      if (namedAreas.some((item) => item.id === area.id)) throw new Error(`Named area ${area.id} has conflicting geometries`);
      namedAreas.push(area); byGeometry.set(key, area);
      if (selectable) selected.add(area.id);
    }
  };
  add({ id: `pack:${LOCAL}`, name: "Installed coverage", kind: "pack", geometry: input.geometry, bbox: [...areaBounds(input.geometry)], aliases: [], sourceIds: [input.sources[0]!.id] }, true, input.sources);
  for (const pack of installations) {
    const database = new DatabaseSync(pack.databasePath, { readOnly: true });
    try {
      const reviewed = new Set(database.prepare("SELECT named_area_id FROM search_regions ORDER BY display_order").all().map((row) => String(row.named_area_id)));
      for (const row of database.prepare("SELECT * FROM named_areas ORDER BY id").iterate()) {
        if (pack.manifest.id === LOCAL && String(row.id).startsWith("collection:")) continue;
        const original = namedAreaSchema.parse({ id: row.id, name: row.name, kind: row.kind, ...(row.context == null ? {} : { context: row.context }), bbox: [row.min_lon,row.min_lat,row.max_lon,row.max_lat], geometry: JSON.parse(String(row.geometry)), sourceIds: JSON.parse(String(row.source_refs)) });
        const aliases = database.prepare("SELECT alias FROM named_area_aliases WHERE area_id=? ORDER BY alias").all(original.id).map((alias) => String(alias.alias));
        let id = pack.manifest.id === LOCAL ? original.id : namespacedId(pack.manifest.id, original.id);
        if (pack.manifest.id === LOCAL && original.id === `pack:${LOCAL}`) {
          // A former whole-coverage geometry matters only if it carries older regional identities.
          if (!aliases.some((alias) => alias.startsWith(ALIAS) && !alias.startsWith(`${ALIAS}${LOCAL}::`))) continue;
          id = `historical-region:${contentId(original.geometry).slice(0, 16)}`;
          original.name = aliases.find((alias) => !alias.startsWith(ALIAS) && alias !== original.name) ?? "Previously installed region";
        }
        add({ ...original, id, aliases: [...aliases, ...(reviewed.has(original.id) && pack.manifest.id !== LOCAL ? [`${ALIAS}${namespacedId(pack.manifest.id, original.id)}`] : [])] }, reviewed.has(original.id), pack.manifest.sources);
      }
    } finally { database.close(); }
  }
  for (const collection of input.collections) add({ id: `collection:${collection.id}`, name: collection.name, kind: "pack", geometry: collection.geometry, bbox: [...areaBounds(collection.geometry)], sourceIds: collection.sourceIds, aliases: [`${ALIAS}${namespacedId(LOCAL, `collection:${collection.id}`)}`] }, true, input.sources);
  return { namedAreas, searchRegions: [...selected].map((namedAreaId, displayOrder) => ({ namedAreaId, displayOrder })), sources: [...sources.values()].sort((a,b) => a.id.localeCompare(b.id)) };
}

/** Resolve only reviewed selectors, never arbitrary name aliases. */
export function coverageRegionAlias(databasePath: string, originalId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let id: string | undefined;
  try {
    const row = database.prepare(`SELECT a.area_id FROM named_area_aliases a JOIN search_regions r ON r.named_area_id=a.area_id WHERE a.alias=? ORDER BY a.area_id LIMIT 1`).get(`${ALIAS}${originalId}`);
    id = row ? String(row.area_id) : undefined;
  } finally { database.close(); }
  return id ? getSearchRegion(databasePath, id) : null;
}

/** Fresh builds resolve committed search selectors from pinned inputs, never installed packs. */
export async function preparedNamedAreas(input: { geometry: AreaGeometry; sources: Sources; snapshots: readonly import("@/lib/data/adapters").SourceSnapshot[]; preparationRoot: string }) {
  const {readFile,mkdir}=await import("node:fs/promises");
  const path=await import("node:path");
  const {readOsmSourceConfig}=await import("@/lib/data/osm/source");
  const {prepareOsmNamedAreas}=await import("@/lib/data/osm/named-areas");
  const {runCommand}=await import("@/lib/data/osm/command");
  const {readSearchRegionInput,validateSearchRegions}=await import("@/lib/data/search-regions");
  const namedAreas:NormalizedNamedArea[]=[], searchRegions:NormalizedSearchRegion[]=[];
  for(const region of legacyRegionIds) {
    const directory=path.resolve("data/regions",region);
    const boundary=JSON.parse(await readFile(path.join(directory,"boundary.geojson"),"utf8")) as {geometry:AreaGeometry};
    if(!intersectCoverage(input.geometry,boundary.geometry)) continue;
    const config=await readOsmSourceConfig(path.join(directory,"osm-source.json"));
    const snapshot=input.snapshots.find(source=>source.id===config.id);
    if(!snapshot) throw new Error(`Missing pinned named-region source ${config.id}`);
    const review=await readSearchRegionInput(path.join(directory,"search-regions.json"));
    const pack=review.regions.find(item=>item.namedAreaId===`pack:${region}`);
    const areas:NormalizedNamedArea[]=pack?[{id:pack.namedAreaId,name:pack.expectedName,kind:"pack",aliases:[],sourceIds:[snapshot.id],geometry:boundary.geometry,bbox:[...areaBounds(boundary.geometry)]}]:[];
    const ids=review.regions.filter(item=>item.namedAreaId.startsWith("osm:")).map(item=>item.namedAreaId.replace("osm:relation/","r").replace("osm:way/","w"));
    if(ids.length) {
      const identity=contentId({source:snapshot.contentHash,ids});
      const root=path.join(input.preparationRoot,"search-regions",identity); await mkdir(root,{recursive:true});
      const regionPath=path.join(root,"reviewed.osm.pbf");
      await runCommand("osmium",["getid","--add-referenced","--overwrite","--output",regionPath,snapshot.localPath,...ids]);
      areas.push(...await prepareOsmNamedAreas(snapshot,{regionPath,identity},{preparationRoot:root}));
    }
    const selected=validateSearchRegions(review,areas);
    for(const item of selected) {
      const area=areas.find(area=>area.id===item.namedAreaId)!;
      const id=namespacedId(region,area.id);
      namedAreas.push({...area,id,aliases:[...area.aliases,`${ALIAS}${id}`]});
      searchRegions.push({namedAreaId:id,displayOrder:searchRegions.length});
    }
  }
  return {namedAreas,searchRegions,sources:input.sources};
}
