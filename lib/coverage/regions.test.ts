import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import regroupingBaseline from "@/data/fixtures/coverage/wta-regrouping-baseline.json";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import { listCoverageRegions, readCoverageRegion } from "./regions";
import { planCoverageRegion } from "./plan";
import { contentId, intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";

vi.mock("node:fs/promises", async original => {
  const actual=await original<typeof import("node:fs/promises")>();
  return {...actual,readFile:vi.fn(actual.readFile)};
});
type Region=Awaited<ReturnType<typeof readCoverageRegion>>;
type Approach={id:string;name:string;coordinates:[number,number];radiusMeters?:number;basis:string;url:string|null};
type UnavailableApproach={id:string;sourceId:string;sourceHash:string;reviewedAt:string;reason:string};
type Catalog={schemaVersion:number;startLimitPath:string;regions:Array<{id:string;rangeIds:string[];recipePath:string;startLimitPath?:string;approachRadiusMeters:number;approaches:Approach[];unavailableApproaches?:UnavailableApproach[]}>};
type Ranges={properties:{source:{id:string};archiveSha256:string;derivation:{missingBroadLeafIds:string[]}};features:Array<{properties:{id:string;name:string;ancestry:string[]};geometry:AreaGeometry}>};
const washingtonIds=[
  "central-cascades","central-washington","eastern-washington","issaquah-alps","mount-rainier-area",
  "north-cascades","olympic-peninsula","puget-sound-and-islands","snoqualmie-region","south-cascades","southwest-washington",
];
const californiaIds=regroupingBaseline.california.map(region=>region.id);
const catalogDirectory=path.resolve("data/coverage/regions");
const fileHash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const washingtonEntries=()=>catalog.regions.filter(region=>!californiaIds.includes(region.id));
const southCascadesEntry=(input:Catalog)=>input.regions.find(region=>region.id==="south-cascades")!;
const unavailableApproachIds=["historical-june-lake-loowit","historical-upper-cispus-blue-lake"];
const washingtonSourcePin="sha256:3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e";
let catalog:Catalog,ranges:Ranges,regions:Map<string,Region>;
beforeAll(async()=>{
  catalog=JSON.parse(await readFile(path.resolve("data/coverage/regions/catalog.json"),"utf8"));
  ranges=JSON.parse(await readFile(path.resolve("data/coverage/mountain-ranges.geojson"),"utf8"));
  regions=new Map(await Promise.all(catalog.regions.map(async({id})=>[id,await readCoverageRegion(id)] as const)));
});

it("pins named Standard leaves, ancestry and portable source attribution",()=>{
  expect(ranges.properties.source.id).toBe("gmba-standard-v2");
  expect(ranges.properties.archiveSha256).toBe("91b7a37e4331cea01fb8938d535d0fbfcec8aae4173e4b073e46e2896b74f198");
  expect(ranges.features).toHaveLength(127);
  expect(ranges.properties.derivation.missingBroadLeafIds).toEqual(["16221","17034","17156"]);
  const stuart=ranges.features.find(feature=>feature.properties.id==="17043")!;
  expect(stuart.properties.name).toBe("Stuart Range");
  expect(stuart.properties.ancestry).toContain("17039"); // Wenatchee Mountains is included, not excluded.
  expect(catalog.regions.find(region=>region.id==="central-cascades")!.rangeIds).toContain("17043");
  for(const region of regions.values()) {
    expect(region.sources![0]).toMatchObject({
      id:"gmba-standard-v2",version:"2.0",license:"CC-BY-4.0",contentHash:`sha256:${contentId(ranges)}`,
    });
    for(const credit of ["Snethlage et al. (2022)","10.48601/earthenv-t9k2-1407","10.1038/s41597-022-01256-y","coordinate-quantized by Alpine Loop"])
      expect(region.sources![0]!.dataset).toContain(credit);
  }
});

it("conserves every selected Washington mountain and reviewed approach through regrouping",async()=>{
  const washington=washingtonEntries();
  expect(washington.map(region=>region.id).sort()).toEqual([...washingtonIds].sort());
  // Equal sorted multisets catch both omitted leaves and duplicate ownership.
  // The baseline comes from the previous catalog, independently of this mapping.
  const selected=washington.flatMap(region=>region.rangeIds).sort();
  expect(selected).toHaveLength(123);
  expect(selected).toEqual(regroupingBaseline.washingtonRangeIds);
  expect(new Set(selected).size).toBe(selected.length);
  const approaches=washington.flatMap(region=>region.approaches.map(point=>({
    id:point.id,sha256:contentId(point),radiusMeters:point.radiusMeters??region.approachRadiusMeters,
  }))).sort((a,b)=>a.id.localeCompare(b.id));
  expect(approaches).toHaveLength(64);
  expect(approaches).toEqual(regroupingBaseline.washingtonReviewedApproaches);
  expect(new Set(approaches.map(point=>point.id)).size).toBe(approaches.length);
  expect(fileHash(await readFile(path.resolve("data/coverage/mountain-ranges.geojson"))))
    .toBe(regroupingBaseline.mountainRangeFileSha256);
  expect(catalog.startLimitPath).toBe(regroupingBaseline.washingtonStartLimit.path);
  expect(fileHash(await readFile(path.resolve(catalogDirectory,catalog.startLimitPath))))
    .toBe(regroupingBaseline.washingtonStartLimit.sha256);
  for(const entry of washington) {
    expect(entry.startLimitPath,entry.id).toBeUndefined();
    expect(entry.recipePath,entry.id).toBe(regroupingBaseline.washingtonRecipe.path);
    expect(regions.get(entry.id)!.replaces,`${entry.id}: regrouping must not promise historical route retention`).toBeUndefined();
  }
  expect(fileHash(await readFile(path.resolve(catalogDirectory,regroupingBaseline.washingtonRecipe.path))))
    .toBe(regroupingBaseline.washingtonRecipe.sha256);
});

it("declares exactly the two reviewed South Cascades source gaps without changing the original anchors",()=>{
  expect(catalog.regions).toHaveLength(15);
  expect(catalog.regions.filter(entry=>entry.unavailableApproaches!==undefined).map(entry=>entry.id)).toEqual(["south-cascades"]);
  const entry=southCascadesEntry(catalog),region=regions.get(entry.id)!;
  expect(entry.unavailableApproaches!.map(review=>review.id)).toEqual(unavailableApproachIds);
  const mapped=region.reviewedApproaches!.filter(point=>point.unavailableStart!==undefined);
  expect(mapped.map(point=>point.id)).toEqual(unavailableApproachIds);
  for(const {id,...review} of entry.unavailableApproaches!) {
    expect(review).toMatchObject({sourceId:"geofabrik-washington-osm",sourceHash:washingtonSourcePin,reviewedAt:"2026-09-29T00:00:00-07:00"});
    expect(review.reason).toContain("unavailable as a route start in this data version");
    expect(region.recipe.sources.some(source=>source.config.id===review.sourceId&&source.sha256===review.sourceHash)).toBe(true);
    const anchor=entry.approaches.find(point=>point.id===id)!;
    expect(anchor).not.toHaveProperty("unavailableStart");
    expect(region.reviewedApproaches!.find(point=>point.id===id)).toEqual({
      id,name:anchor.name,coordinates:anchor.coordinates,radiusMeters:anchor.radiusMeters??entry.approachRadiusMeters,unavailableStart:review,
    });
    expect(contentId(anchor),id).toBe(regroupingBaseline.washingtonReviewedApproaches.find(point=>point.id===id)!.sha256);
  }
  for(const [id,input] of regions) if(id!==entry.id)
    expect(input.reviewedApproaches?.some(point=>point.unavailableStart!==undefined),id).toBe(false);
});

it("keeps all fifteen original cores, boundaries, nomination limits and recipe policies when gap records are omitted",async()=>{
  const withoutDeclarations=structuredClone(catalog);
  delete southCascadesEntry(withoutDeclarations).unavailableApproaches;
  for(const [id,reviewed] of regions) {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(withoutDeclarations));
    const original=await readCoverageRegion(id);
    if(id!=="south-cascades") {
      expect(reviewed,id).toEqual(original);
      continue;
    }
    expect(reviewed.geometry).toEqual(original.geometry);
    expect(reviewed.startLimitGeometry).toEqual(original.startLimitGeometry);
    expect(reviewed.recipe).toEqual(original.recipe);
    expect(reviewed.sources!.slice(0,2)).toEqual(original.sources!.slice(0,2));
    expect(reviewed.reviewedApproaches!.map(({id,name,coordinates,radiusMeters})=>({id,name,coordinates,radiusMeters}))).toEqual(original.reviewedApproaches);
    expect(reviewed.sources![2]!.contentHash).not.toBe(original.sources![2]!.contentHash);
    expect(original.sources![2]!.contentHash).toBe(`sha256:${contentId({approaches:southCascadesEntry(catalog).approaches,radiusMeters:southCascadesEntry(catalog).approachRadiusMeters})}`);
  }
});

it.each([
  {field:"reason",value:"The pinned parking polygon has no mapped trail contact; this route start is unavailable."},
  {field:"reviewedAt",value:"2026-09-29T12:00:00-07:00"},
])("pins unavailable-start $field only in approach provenance",async({field,value})=>{
  const changed=structuredClone(catalog),entry=southCascadesEntry(changed);
  Object.assign(entry.unavailableApproaches![0]!,{[field]:value});
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  const input=await readCoverageRegion(entry.id),original=regions.get(entry.id)!;
  expect(input.geometry).toEqual(original.geometry);
  expect(input.startLimitGeometry).toEqual(original.startLimitGeometry);
  expect(input.recipe).toEqual(original.recipe);
  expect(input.sources!.slice(0,2)).toEqual(original.sources!.slice(0,2));
  expect(input.sources![2]!.contentHash).not.toBe(original.sources![2]!.contentHash);
  expect(input.sources![2]!.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(input.reviewedApproaches!.find(point=>point.id===entry.unavailableApproaches![0]!.id)!.unavailableStart).toHaveProperty(field,value);
});

it.each([
  {name:"an unknown reviewed anchor",patch:{id:"not-a-reviewed-anchor"}},
  {name:"a missing source ID",patch:{sourceId:""}},
  {name:"a malformed review date",patch:{reviewedAt:"September 29, 2026"}},
  {name:"a missing timezone",patch:{reviewedAt:"2026-09-29T00:00:00"}},
  {name:"an unprefixed source hash",patch:{sourceHash:washingtonSourcePin.slice(7)}},
  {name:"a short source hash",patch:{sourceHash:"sha256:1234"}},
  {name:"a blank review reason",patch:{reason:"   "}},
  {name:"an unknown review field",patch:{allowConnector:true}},
])("rejects unavailable-start declarations with $name",async({patch})=>{
  const changed=structuredClone(catalog);
  Object.assign(southCascadesEntry(changed).unavailableApproaches![0]!,patch);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(listCoverageRegions()).rejects.toThrow();
});

it("rejects duplicate unavailable-start declarations for the same reviewed anchor",async()=>{
  const changed=structuredClone(catalog),entry=southCascadesEntry(changed);
  entry.unavailableApproaches!.push({...entry.unavailableApproaches![0]!});
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(listCoverageRegions()).rejects.toThrow("Unavailable approach must identify one reviewed anchor");
});

it.each([
  {name:"a stale recipe source hash",patch:{sourceHash:`sha256:${"a".repeat(64)}`}},
  {name:"a source ID absent from the recipe",patch:{sourceId:"geofabrik-unconfigured-osm"}},
  {name:"another configured source with the Washington hash",patch:{sourceId:"geofabrik-oregon-osm"}},
])("rejects unavailable-start declarations against $name",async({patch})=>{
  const changed=structuredClone(catalog);
  Object.assign(southCascadesEntry(changed).unavailableApproaches![0]!,patch);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(readCoverageRegion("south-cascades")).rejects.toThrow(`Unavailable approach source pin differs: ${unavailableApproachIds[0]}`);
});

it("preserves exact California catalog entries, nomination caps and source recipes",async()=>{
  for(const baseline of regroupingBaseline.california) {
    const entry=catalog.regions.find(region=>region.id===baseline.id)!;
    expect(contentId(entry),baseline.id).toBe(baseline.catalogSha256);
    expect(fileHash(await readFile(path.resolve(catalogDirectory,entry.startLimitPath!))),baseline.id)
      .toBe(baseline.startLimitFileSha256);
    expect(fileHash(await readFile(path.resolve(catalogDirectory,entry.recipePath))),baseline.id)
      .toBe(baseline.recipeFileSha256);
  }
});

it("reuses a full named leaf for a different territory without changing the source dataset",async()=>{
  const oregon:[number,number]=[-118.30649444676988,45.61998033];
  const blue=ranges.features.find(feature=>feature.properties.id==="16211")!;
  expect(coordinateIsInsideArea(oregon,blue.geometry)).toBe(true);
  expect(coordinateIsInsideArea(oregon,regions.get("eastern-washington")!.geometry)).toBe(false);
  const cap={type:"Feature",geometry:rectangle([-118.4,45.5,-118.2,45.7])};
  const changed=structuredClone(catalog);
  changed.regions.push({...changed.regions.find(region=>region.id==="eastern-washington")!,
    id:"oregon-blue-mountains",rangeIds:["16211"],startLimitPath:"oregon-product-cap.geojson",approaches:[]});
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed))
    .mockResolvedValueOnce(JSON.stringify(ranges)).mockResolvedValueOnce(JSON.stringify(cap));
  const added=await readCoverageRegion("oregon-blue-mountains");
  expect(coordinateIsInsideArea(oregon,added.geometry)).toBe(true);
  expect(subtractCoverage(added.geometry,cap.geometry)).toBeNull();
  expect(added.sources![0]).toEqual(regions.get("eastern-washington")!.sources![0]);
});

it("plans all fifteen cores offline with supported route buffers and explicit provenance",async()=>{
  expect((await listCoverageRegions()).map(entry=>entry.id).sort()).toEqual([...washingtonIds,...californiaIds].sort());
  for(const [id,region] of regions) {
    const plan=planCoverageRegion(region);
    expect(subtractCoverage(plan.geometry,unionCoverage(region.recipe.sources.map(source=>source.geometry))),id).toBeNull();
    for(const exclusion of region.recipe.exclusions) expect(intersectCoverage(plan.geometry,exclusion.geometry),`${id}: ${exclusion.id}`).toBeNull();
    expect(region.sources?.map(source=>source.id)).toEqual(["gmba-standard-v2",`region-boundary-${id}`,`region-approaches-${id}`]);
    for(const source of region.sources??[]) expect(source.contentHash,id).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
},15000);

it.each([
  {name:"Lost Creek / Mountain Loop",point:[-121.3366962,48.0937555],owner:"north-cascades"},
  {name:"Heather Lake / Stevens Pass",point:[-121.0756526,47.8662242],owner:"central-cascades"},
  {name:"Stuart Lake / Leavenworth",point:[-120.8207727,47.5277884],owner:"central-cascades"},
  {name:"Snoqualmie Alpine Lakes",point:[-121.4235243,47.4455622],owner:"snoqualmie-region"},
  {name:"West Fork Teanaway",point:[-120.960625,47.2982778],owner:"snoqualmie-region"},
  {name:"Tiger Mountain",point:[-121.972,47.488],owner:"issaquah-alps"},
  {name:"Manastash Ridge",point:[-120.771,46.993],owner:"central-washington"},
  {name:"Longmire / Paradise",point:[-121.81253,46.7501122],owner:"mount-rainier-area"},
  {name:"Goat Rocks Snowgrass",point:[-121.518893,46.4639429],owner:"south-cascades"},
  {name:"Ape Canyon / St. Helens",point:[-122.092329,46.165278],owner:"south-cascades"},
])("assigns $name to its hiking district without losing or duplicating the core",({point,owner})=>{
  expect(washingtonIds.filter(id=>coordinateIsInsideArea(point as [number,number],regions.get(id)!.geometry))).toEqual([owner]);
});

it("excludes lowland cities from the Cascades mountain cores",()=>{
  const central=regions.get("central-cascades")!;
  for(const point of [[-122.1252,48.1987],[-122.334,48.4212],[-122.33,47.61]] as [number,number][])
    expect(coordinateIsInsideArea(point,central.geometry),String(point)).toBe(false); // Arlington, Mount Vernon, Seattle
});

it("retains reviewed approaches as audit anchors without adding their neighborhoods to the core",async()=>{
  const approaches=washingtonIds.flatMap(id=>regions.get(id)!.reviewedApproaches!);
  expect(approaches.find(point=>point.id==="6304.005511")?.radiusMeters).toBe(600);
  expect(approaches.filter(point=>point.id==="5278010416")).toHaveLength(1);
  expect(approaches.some(point=>point.id==="6300.005511")).toBe(false);
  const baseline=JSON.parse(await readFile(path.resolve("data/fixtures/coverage/central-cascades-baseline.json"),"utf8"));
  for(const previous of baseline.regions) for(const expected of previous.approaches)
    expect(approaches).toContainEqual({id:expected.id,name:expected.name,coordinates:expected.coordinates,radiusMeters:expected.radiusMeters});
  const olympic=regions.get("olympic-peninsula")!,ozette:[number,number]=[-124.66889,48.15519];
  expect(coordinateIsInsideArea(ozette,olympic.geometry)).toBe(false);
  expect(coordinateIsInsideArea(ozette,olympic.startLimitGeometry!)).toBe(true);
  const changed=structuredClone(catalog);
  changed.regions.find(region=>region.id==="olympic-peninsula")!.approaches=[];
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  const withoutAnchors=await readCoverageRegion("olympic-peninsula");
  expect(withoutAnchors.geometry).toEqual(olympic.geometry);
  expect(withoutAnchors.startLimitGeometry!).toEqual(olympic.startLimitGeometry!);
  expect(withoutAnchors.sources![2]!.contentHash).not.toBe(olympic.sources![2]!.contentHash);
});

it("limits Washington starts to Washington while route support can extend into Oregon",()=>{
  const southwest=regions.get("southwest-washington")!,oregon:[number,number]=[-122,45.5];
  expect(coordinateIsInsideArea(oregon,southwest.geometry)).toBe(false);
  expect(coordinateIsInsideArea(oregon,southwest.startLimitGeometry!)).toBe(false);
  expect(coordinateIsInsideArea(oregon,planCoverageRegion(southwest).geometry)).toBe(true);
  expect(coordinateIsInsideArea([-116.7,47.7],regions.get("eastern-washington")!.startLimitGeometry!)).toBe(false); // Idaho
  const north=planCoverageRegion(regions.get("north-cascades")!);
  expect(coordinateIsInsideArea([-121.4077738,48.9998624],north.geometry)).toBe(true); // US Chilliwack routing support
  expect(coordinateIsInsideArea([-121.7736891,48.99766],north.geometry)).toBe(false); // Canada
  expect(coordinateIsInsideArea([-123.36,48.43],regions.get("olympic-peninsula")!.startLimitGeometry!)).toBe(false); // Victoria
});

it("keeps exact California product caps while using only Standard core inside them",()=>{
  const fingerprints={
    "santa-cruz-mountains":"7bfef8e191bc4b2800054e24dd583778db141e04fe2f7f4926d485f362e49d69",
    "southern-east-bay":"327daa394bce0cf8526d13bf45ca2da056db97bb493767cca296cb0589a0edb8",
    "monterey-carmel":"a18f24c1c6edf7bd4c4a4b383103c90768b3dbda7b3c36d286e099805837b834",
    "henry-coe":"d5396aa3309b3637b13b7731bb28b99f7181854a8ff296b62bb3e6ae7a8d4a98",
  };
  for(const [id,hash] of Object.entries(fingerprints)) {
    const region=regions.get(id)!;
    expect(contentId(region.startLimitGeometry!),id).toBe(hash);
    expect(subtractCoverage(region.geometry,region.startLimitGeometry!),id).toBeNull();
    expect(coordinateIsInsideArea([-122.7,38],region.geometry),id).toBe(false); // no North Bay expansion
    expect(coordinateIsInsideArea([-122.7,38],region.startLimitGeometry!),id).toBe(false);
  }
  const coe=regions.get("henry-coe")!;
  expect(coordinateIsInsideArea([-121.5458297,37.1878465],coe.geometry)).toBe(true);
  expect(coordinateIsInsideArea([-121.577518,37.096626],coe.geometry)).toBe(false); // Harvey Bear approach stays outside core
  expect(coordinateIsInsideArea([-121.577518,37.096626],coe.startLimitGeometry!)).toBe(true);
});

it("keeps California core and its boundary pin independent of reviewed approach neighborhoods",async()=>{
  const coe=regions.get("henry-coe")!,outside:[number,number]=[-121.5,37.4];
  const diablo=ranges.features.find(feature=>feature.properties.id==="17046")!;
  expect(coordinateIsInsideArea(outside,diablo.geometry)).toBe(true);
  expect(coordinateIsInsideArea(outside,coe.startLimitGeometry!)).toBe(false);
  const changed=structuredClone(catalog),entry=changed.regions.find(region=>region.id==="henry-coe")!;
  entry.approaches.push({...entry.approaches[0]!,id:"outside-audit-anchor",coordinates:outside});
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  const withAnchor=await readCoverageRegion("henry-coe");
  expect(coordinateIsInsideArea(outside,withAnchor.startLimitGeometry!)).toBe(true);
  expect(withAnchor.geometry).toEqual(coe.geometry);
  expect(withAnchor.sources![1]).toEqual(coe.sources![1]);
  expect(withAnchor.sources![2]!.contentHash).not.toBe(coe.sources![2]!.contentHash);
});

it.each([
  {patch:{rangeIds:[]},reason:"empty selection"},
  {patch:{rangeIds:["17043","17043"]},reason:"duplicate leaf"},
  {patch:{rangeIds:["../17043"]},reason:"invalid leaf ID"},
  {patch:{boundaryPath:"central-cascades-boundary.geojson"},reason:"obsolete boundaryPath field"},
  {patch:{startLimitPath:""},reason:"empty territory cap path"},
  {patch:{replaces:["glacier-peak"]},reason:"obsolete replacement promise"},
])("rejects $reason",async({patch})=>{
  const changed=structuredClone(catalog);
  Object.assign(changed.regions.find(region=>region.id==="central-cascades")!,patch);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(listCoverageRegions()).rejects.toThrow();
});

it("rejects missing ranges instead of falling back to a broad outline",async()=>{
  const changed=structuredClone(catalog);
  changed.regions.find(region=>region.id==="central-cascades")!.rangeIds=["999999"];
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(readCoverageRegion("central-cascades")).rejects.toThrow("Unknown Standard mountain range 999999");
});
