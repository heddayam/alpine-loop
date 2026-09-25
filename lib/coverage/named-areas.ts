import type { PackManifest } from "@/lib/contracts";
import { areaBounds } from "@/lib/graph/geometry";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { NormalizedNamedArea, NormalizedSearchRegion } from "@/lib/data/types";
import { namespacedId } from "@/lib/search/identity";
import { legacyRegionIds } from "./collections";
import { contentId, intersectCoverage } from "./geometry";
const ALIAS="region-id:";
type Sources=PackManifest["sources"];

/** Fresh builds resolve committed search selectors from pinned inputs, never installed packs. */
export async function preparedNamedAreas(input: { geometry: AreaGeometry; sources: Sources; snapshots: readonly import("@/lib/data/adapters").SourceSnapshot[]; preparationRoot: string; regionIds?: readonly string[] }) {
  const {readFile,mkdir}=await import("node:fs/promises");
  const path=await import("node:path");
  const {readOsmSourceConfig}=await import("@/lib/data/osm/source");
  const {prepareOsmNamedAreas}=await import("@/lib/data/osm/named-areas");
  const {runCommand}=await import("@/lib/data/osm/command");
  const {readSearchRegionInput,validateSearchRegions}=await import("@/lib/data/search-regions");
  const namedAreas:NormalizedNamedArea[]=[], searchRegions:NormalizedSearchRegion[]=[];
  for(const region of input.regionIds ?? legacyRegionIds) {
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
