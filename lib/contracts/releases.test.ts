import { expect, it } from "vitest";
import { dataReleaseSchema } from "./releases";
import { rectangle } from "@/lib/coverage/geometry";
const digest = "a".repeat(64);
const core = rectangle([-121.5,47.8,-121.4,47.9]);
const geometry = rectangle([-122.1,47.4,-120.8,48.3]);
const release = {
  schemaVersion:1,graphSchemaVersion:"7",partitioning:"local-areas",id:"catalog",builtAt:"2026-09-28T00:00:00Z",
  compilerVersion:"local",metricAlgorithmVersion:"1",geometry,
  sources:[{id:"fixture",authority:"Test",dataset:"Trails",version:"1",retrievedAt:"2026-09-28T00:00:00Z",url:"https://example.invalid",license:"CC0",contentHash:`sha256:${digest}`}],
  sections:[{id:"area-a",geometry:core,artifactIds:[digest],area:{maximumRouteMiles:40,bufferMiles:25}}],
  artifacts:[{id:digest,path:`objects/${digest}.sqlite.gz`,compressedBytes:1,bytes:2,geometry,startGeometry:core,graphId:"graph-a"}],
  regions:[],limitations:[],
};
it("separates eligible starts from the independently prepared routing extent",()=>{
  const parsed=dataReleaseSchema.parse(release);
  expect(parsed.sections[0]!.geometry).toEqual(core);
  expect(parsed.artifacts[0]!.geometry).toEqual(geometry);
});
it("rejects missing or mismatched local graph ownership and inadequate buffer metadata",()=>{
  for(const mutate of [
    (value:typeof release)=>{value.artifacts[0]!.startGeometry=geometry;},
    (value:typeof release)=>{delete (value.artifacts[0] as Record<string,unknown>).startGeometry;},
    (value:typeof release)=>{delete (value.artifacts[0] as Record<string,unknown>).graphId;},
    (value:typeof release)=>{value.sections[0]!.area.bufferMiles=20;},
    (value:typeof release)=>{value.sections.push({...value.sections[0]!,id:"area-b"});},
  ]) {
    const changed=structuredClone(release);mutate(changed);
    expect(dataReleaseSchema.safeParse(changed).success).toBe(false);
  }
});
it("allows only unambiguous retirement of inactive local area IDs",()=>{
  const withReplacements=(replaces:string[])=>({...release,sections:[{...release.sections[0]!,replaces}]});
  expect(dataReleaseSchema.parse(withReplacements(["pilot-a","pilot-b"])).sections[0]!.replaces).toEqual(["pilot-a","pilot-b"]);
  for(const ids of [["area-a"],["pilot-a","pilot-a"],[]]) expect(dataReleaseSchema.safeParse(withReplacements(ids)).success).toBe(false);
  expect(dataReleaseSchema.safeParse({...withReplacements(["pilot"]),partitioning:"geographic"}).success).toBe(false);
});
