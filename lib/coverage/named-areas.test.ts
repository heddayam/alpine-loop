import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PackManifest, SearchIntent } from "@/lib/contracts";
import type { NormalizedNamedArea, NormalizedSearchRegion } from "@/lib/data/types";
import type { InstalledPack } from "@/lib/packs/installed-pack";
import { areaBounds } from "@/lib/graph/geometry";
import { validateAndSortNamedAreas } from "@/lib/data/named-areas";
import { resolveSearchPlan } from "@/lib/server/search-area";
import { coverageNamedAreas, coverageRegionAlias } from "./named-areas";
import { rectangle } from "./geometry";

const source: PackManifest["sources"][number] = { id: "osm", authority: "fixture", dataset: "fixture", version: "1", retrievedAt: "2026-09-24T00:00:00Z", url: "https://example.invalid/source", license: "fixture", contentHash: `sha256:${"1".repeat(64)}` };
const extent = rectangle([0,0,2,2]);
const forest: NormalizedNamedArea = { id: "osm:relation/1", name: "Forest", kind: "protected-area", geometry: rectangle([0,0,1,1]), bbox: [0,0,1,1], aliases: ["Old Forest"], sourceIds: [source.id] };
const directories: string[] = [];
function installation(id: string, areas: NormalizedNamedArea[], regions = areas.map((area, displayOrder) => ({ namedAreaId: area.id, displayOrder })), sources = [source]): InstalledPack {
  const directory = mkdtempSync(path.join(tmpdir(), "coverage-metadata-")); directories.push(directory);
  const databasePath = path.join(directory, "pack.sqlite"), db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE named_areas(id TEXT PRIMARY KEY,name TEXT,kind TEXT,context TEXT,min_lon REAL,min_lat REAL,max_lon REAL,max_lat REAL,geometry TEXT,source_refs TEXT); CREATE TABLE named_area_aliases(area_id TEXT,alias TEXT,normalized_alias TEXT); CREATE TABLE search_regions(named_area_id TEXT,display_order INTEGER)");
  for (const area of areas) {
    db.prepare("INSERT INTO named_areas VALUES(?,?,?,?,?,?,?,?,?,?)").run(area.id,area.name,area.kind,area.context??null,...area.bbox,JSON.stringify(area.geometry),JSON.stringify(area.sourceIds));
    for (const alias of area.aliases) db.prepare("INSERT INTO named_area_aliases VALUES(?,?,?)").run(area.id,alias,alias.toLowerCase());
  }
  for (const region of regions) db.prepare("INSERT INTO search_regions VALUES(?,?)").run(region.namedAreaId,region.displayOrder);
  db.close();
  return { directory, databasePath, root: directory, manifestPath: path.join(directory,"manifest.json"), manifest: { id, sources, dataVersion: "fixture", builtAt: "2026-09-24T00:00:00Z", coverage: { boundary: extent, bbox: [...areaBounds(extent)] } } as PackManifest };
}
afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory,{recursive:true,force:true})); });

describe("coverage named-area metadata", () => {
  it("deduplicates shared geometry while preserving old namespaces and reviewed filters", async () => {
    const result = await coverageNamedAreas({ geometry: extent, sources: [source], collections: [], installations: [installation("old-one",[forest]), installation("old-two",[{...forest,id:"osm:relation/2"}])] });
    expect(result.namedAreas).toHaveLength(2);
    expect(() => validateAndSortNamedAreas(result.namedAreas,new Set([source.id]))).not.toThrow();
    const local = installation("local-coverage",result.namedAreas,result.searchRegions,result.sources);
    expect(coverageRegionAlias(local.databasePath,"old-one::osm:relation/1")?.name).toBe("Forest");
    expect(coverageRegionAlias(local.databasePath,"old-two::osm:relation/2")?.geometry).toEqual(forest.geometry);
    expect(coverageRegionAlias(local.databasePath,"Old Forest")).toBeNull();
    const request: SearchIntent = { area: {mode:"named-regions",regionIds:["old-two::osm:relation/2"]},criteria:{closedRoute:{maximumRepeatedTrailPct:35,allowMultiCycle:true},distanceMiles:{min:1,max:10},includeUncertainAccess:true} };
    const plan = await resolveSearchPlan(request,new AbortController().signal,Promise.resolve(new Map([["local-coverage",local]])));
    expect(plan.area.filterGeometry).toEqual(forest.geometry);
    expect(plan.packs[0]?.id).toBe("local-coverage");
  });

  it("retains a former whole-region alias when installed coverage later expands", async () => {
    const original = await coverageNamedAreas({geometry:forest.geometry,sources:[source],collections:[],installations:[installation("old-one",[forest])]});
    expect(original.namedAreas).toHaveLength(1);
    const localBefore = installation("local-coverage",original.namedAreas,original.searchRegions);
    const expanded = await coverageNamedAreas({geometry:extent,sources:[source],collections:[],installations:[localBefore]});
    const localAfter = installation("local-coverage",expanded.namedAreas,expanded.searchRegions);
    expect(coverageRegionAlias(localAfter.databasePath,"old-one::osm:relation/1")?.geometry).toEqual(forest.geometry);
    expect(() => validateAndSortNamedAreas(expanded.namedAreas,new Set([source.id]))).not.toThrow();
  });

  it("adds configured collection filters without clipping them to installed geometry", async () => {
    const collection = {id:"cascades",name:"Cascades",geometry:extent,sourceIds:[source.id],limitations:[]};
    const result = await coverageNamedAreas({geometry:forest.geometry,sources:[source],collections:[collection],installations:[]});
    expect(result.namedAreas.find((area)=>area.id==="collection:cascades")?.geometry).toEqual(extent);
    expect(result.searchRegions).toEqual([{namedAreaId:"pack:local-coverage",displayOrder:0},{namedAreaId:"collection:cascades",displayOrder:1}]);
  });

  it("retains historical selector provenance separately from the new routing source", async () => {
    const oldSource = {...source,contentHash:`sha256:${"2".repeat(64)}`};
    const result = await coverageNamedAreas({geometry:extent,sources:[source],collections:[],installations:[installation("old-one",[forest],undefined,[oldSource])]});
    const migrated = result.namedAreas.find(area=>area.name==="Forest")!;
    expect(migrated.sourceIds).toEqual([`metadata:osm:${"2".repeat(64)}`]);
    expect(result.sources.find(item=>item.id===migrated.sourceIds[0])?.contentHash).toBe(oldSource.contentHash);
    expect(result.sources.find(item=>item.id==="osm")?.contentHash).toBe(source.contentHash);
  });

  it("regenerates configured collections when source versions change", async () => {
    const collection = {id:"example",name:"Example",geometry:extent,sourceIds:[source.id],limitations:[]};
    const old = {...forest,id:"collection:example",geometry:extent,bbox:[0,0,2,2] as [number,number,number,number]};
    const updated = {...source,contentHash:`sha256:${"2".repeat(64)}`};
    const result = await coverageNamedAreas({geometry:forest.geometry,sources:[updated],collections:[collection],installations:[installation("local-coverage",[old])]});
    expect(result.sources).toEqual([updated]);
    expect(result.namedAreas.find(area=>area.id==="collection:example")?.name).toBe("Example");
  });

  it("copies only sources referenced by intersecting metadata and keeps unreviewed names unselectable", async () => {
    const other = {...source,id:"authority"};
    const unreviewed = {...forest,sourceIds:[other.id]};
    const regions: NormalizedSearchRegion[] = [];
    const result = await coverageNamedAreas({geometry:extent,sources:[source],collections:[],installations:[installation("old-one",[unreviewed],regions,[other,{...source,id:"unused"}])]});
    expect(result.sources.map((item)=>item.id)).toEqual(["authority","osm"]);
    expect(result.searchRegions).toHaveLength(1);
    const local = installation("local-coverage",result.namedAreas,result.searchRegions,result.sources);
    expect(coverageRegionAlias(local.databasePath,"old-one::osm:relation/1")).toBeNull();
  });
});
