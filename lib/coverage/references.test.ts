import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";
import { auditOfficialTrailReferences, officialSourceEnvelope } from "./references";
import { readOfficialTrailSourceConfig } from "@/lib/data/official-trails/source";

const fixture=path.resolve("data/fixtures/source/osm/coverage-regressions.opl");
const source:SourceSnapshot={id:"washington-2026-08-01",authority:"OpenStreetMap contributors",dataset:"Washington extract",version:"2026-08-01",retrievedAt:"2026-08-10T00:00:00Z",url:"https://download.geofabrik.de/north-america/us/washington.html",license:"ODbL-1.0",contentHash:`sha256:${"3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e"}`,localPath:fixture};
const stores:CoverageSourceStore[]=[];
afterEach(()=>stores.splice(0).forEach((store)=>store.close()));

it("inventories real West Cady, Pilchuck, and road-approach ways before coverage clipping",async()=>{
  const store=new CoverageSourceStore(":memory:",source);stores.push(store);
  const lines=createInterface({input:createReadStream(fixture),crlfDelay:Infinity});
  await store.import(async()=>{}, {lines});
  const ids=[...store.db.prepare("SELECT id FROM inventory WHERE disposition='candidate' ORDER BY id").iterate()].map((row)=>String(row.id));
  expect(ids).toEqual(["way/218617733","way/372537133","way/37583693","way/951045864","way/951045865"]);
  const cady=[...store.ways(rectangle([-121.29,47.90,-121.17,47.94]),0)].map(({way})=>way.externalId);
  expect(cady).toContain("way/372537133");
  expect(cady).toContain("way/218617733");
  const pilchuck=[...store.ways(rectangle([-121.83,48.05,-121.79,48.08]),0)].map(({way})=>way.externalId);
  expect(pilchuck).toContain("way/37583693");
});


it("reports independent represented, missing, and unsupported official references without changing OSM",async()=>{
  const store=new CoverageSourceStore(":memory:",source);stores.push(store);
  const lines=createInterface({input:createReadStream(fixture),crlfDelay:Infinity});
  await store.import(async()=>{}, {lines});
  const coverage=rectangle([-121.83,47.90,-121.17,48.09]);
  const cady=[...store.ways(rectangle([-121.29,47.90,-121.17,47.94]),0)].find(({way})=>way.externalId==="way/372537133")!.way;
  const directory=mkdtempSync(path.join(tmpdir(),"official-reference-"));
  try {
    const features=[
      {id:"represented",name:"West Cady",coordinates:cady.coordinates.slice(0,20),trailtype:"Terra Trail",hikerpedestrian:"Y"},
      {id:"missing",name:"Absent connector",coordinates:[[-121.6,47.95],[-121.599,47.95]],trailtype:"Terra Trail",hikerpedestrian:"Y"},
      {id:"unsupported",name:"Outside official envelope",coordinates:[[-121.81,48.06],[-121.809,48.06]],trailtype:"Terra Trail",hikerpedestrian:"Y"},
      {id:"ineligible",name:"Water route",coordinates:cady.coordinates.slice(0,3),trailtype:"Water Trail",hikerpedestrian:"N"},
    ];
    const officialPath=path.join(directory,"reference.geojson");
    writeFileSync(officialPath,JSON.stringify({type:"FeatureCollection",features:features.map((item)=>({type:"Feature",properties:{permanentidentifier:item.id,name:item.name,trailtype:item.trailtype,hikerpedestrian:item.hikerpedestrian},geometry:{type:"LineString",coordinates:item.coordinates}}))}));
    const official:SourceSnapshot={...source,id:"official",contentHash:`sha256:${"2".repeat(64)}`,localPath:officialPath};
    expect(await auditOfficialTrailReferences({osm:store,coverage})).toMatchObject({status:"source-unsupported",unsupportedReason:"no-pinned-official-trail-source"});
    const before=store.db.prepare("SELECT count(*) AS n FROM ways").get()?.n;
    const audit=await auditOfficialTrailReferences({osm:store,coverage,officialSnapshot:official,sourceEnvelope:[-121.733,47.19,-120.527,48.475],representedDistanceM:100});
    expect(audit).toMatchObject({status:"partial-source",unsupportedReason:"coverage-outside-official-source-envelope",sourceId:"official",sourceFeatureCount:4,eligibleFeatureCount:3,coveredFeatureCount:3,representedFeatureCount:1,
      unresolved:[{externalId:"missing#1",reason:"no-nearby-osm-trail"},{externalId:"unsupported#1",reason:"outside-official-source-envelope"}]});
    expect(audit.ineligibleReasons).toMatchObject({"not-terrestrial":1});
    expect(store.db.prepare("SELECT count(*) AS n FROM ways").get()?.n).toBe(before);
    expect(store.db.prepare("SELECT name FROM sqlite_temp_master WHERE name='reference_segments'").get()).toBeUndefined();
  } finally {rmSync(directory,{recursive:true,force:true});}
});


it("reads the pinned USGS query envelope rather than assuming statewide official coverage",async()=>{
  const config=await readOfficialTrailSourceConfig(path.resolve("data/regions/central-cascades/official-trail-source.json"));
  expect(officialSourceEnvelope(config)).toEqual([-121.73319523634241,47.19654585917808,-120.5276988,48.4758823]);
});


it("keeps source-represented trails pending beyond the installed subset",async()=>{
  const store=new CoverageSourceStore(":memory:",source);stores.push(store);
  async function* lines(){yield* [
    "n1 T x0 y0", "n2 T x0.001 y0", "n3 T x1 y0", "n4 T x1.001 y0",
    "w1 Thighway=path Nn1,n2", "w2 Thighway=path Nn3,n4",
  ];}
  await store.import(async()=>{}, {lines:lines()});
  const directory=mkdtempSync(path.join(tmpdir(),"reference-progress-"));
  try {
    const officialPath=path.join(directory,"reference.geojson");
    writeFileSync(officialPath,JSON.stringify({type:"FeatureCollection",features:[
      {id:"installed",coordinates:[[0,0],[0.001,0]]},
      {id:"pending",coordinates:[[1,0],[1.001,0]]},
    ].map(({id,coordinates})=>({type:"Feature",properties:{permanentidentifier:id,name:id,trailtype:"Terra Trail",hikerpedestrian:"Y"},geometry:{type:"LineString",coordinates}}))}));
    const options={osm:store,coverage:rectangle([-0.1,-0.1,1.1,0.1]),officialSnapshot:{...source,id:"official",localPath:officialPath},sourceEnvelope:[-0.1,-0.1,1.1,0.1] as const};
    const audit=await auditOfficialTrailReferences({...options,installedCoverage:rectangle([-0.1,-0.1,0.1,0.1])});
    expect(audit).toMatchObject({status:"audited",coveredFeatureCount:2,representedFeatureCount:2,installedFeatureCount:1,pendingFeatureCount:1,unresolved:[]});
    expect(audit.installedLengthM).toBeGreaterThan(100);
    expect(audit.pendingLengthM).toBeCloseTo(audit.installedLengthM,3);
    const initial=await auditOfficialTrailReferences({...options,installedCoverage:null});
    expect(initial).toMatchObject({representedFeatureCount:2,installedFeatureCount:0,pendingFeatureCount:2,installedLengthM:0,unresolved:[]});
    const partial=await auditOfficialTrailReferences({...options,installedCoverage:rectangle([-0.1,-0.1,1.0005,0.1])});
    expect(partial).toMatchObject({representedFeatureCount:2,installedFeatureCount:1,pendingFeatureCount:1,unresolved:[]});
    expect(partial.pendingLengthM).toBeGreaterThan(0);
    expect(partial.pendingLengthM).toBeLessThan(audit.pendingLengthM);
    expect(partial.installedLengthM+partial.pendingLengthM).toBeCloseTo(audit.installedLengthM+audit.pendingLengthM,6);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
