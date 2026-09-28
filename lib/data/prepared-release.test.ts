import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { DataRelease } from "@/lib/contracts/releases";
import { rectangle } from "@/lib/coverage/geometry";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { createPreparedSchema } from "./sqlite-writer";
import { exportPreparedRelease, inspectPreparedRelease, preparedReleaseId, publishPreparedCatalog, type PreparedReleaseOptions } from "./prepared-release";

let root:string;
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),"network-export-test-"));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const source={id:"fixture",authority:"Alpine Loop",dataset:"Synthetic trails",version:"1",retrievedAt:"2026-09-28T00:00:00Z",url:"https://example.invalid/source",license:"CC0",contentHash:`sha256:${"1".repeat(64)}`};
function fixture(name="a",offset=0):PreparedReleaseOptions {
  const options:PreparedReleaseOptions={databasePath:path.join(root,`${name}.sqlite`),outputRoot:root,geometry:rectangle([-2,-2,2,2]),sources:[source],regions:[],builtAt:source.retrievedAt,compilerVersion:"fixture",metricAlgorithmVersion:"fixture",network:{id:name,inputFingerprint:`input-${name}`,summary:{nodeCount:2,physicalEdgeCount:1,sourceBoundaryLimited:true}},publish:false};
  const db=new DatabaseSync(options.databasePath);
  try {
    createPreparedSchema(db);
    for(const [key,value] of Object.entries({schemaVersion:"7",releaseId:preparedReleaseId(options)})) db.prepare("INSERT INTO metadata VALUES (?,?)").run(key,value);
    db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)").run(source.id,source.authority,source.dataset,source.version,source.retrievedAt,source.url,source.license,source.contentHash);
    db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?)").run(`${name}-start`,1+offset,0,0,100,"[]");
    db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?)").run(`${name}-end`,2+offset,1,0,100,"[]");
    db.prepare("INSERT INTO node_spatial VALUES (?,?,?,?,?)").run(1+offset,0,0,0,0);
    db.prepare("INSERT INTO node_spatial VALUES (?,?,?,?,?)").run(2+offset,1,1,0,0);
    const geometry=[[0,0],[1,0]],forward=canonicalTopologyJson(geometry),reverse=canonicalTopologyJson([...geometry].reverse());
    db.prepare("INSERT INTO physical_edges VALUES (?,?,?,?,?)").run(1+offset,`${name}-physical`,1+offset,2+offset,topologySha256(forward<reverse?forward:reverse));
    db.prepare("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`${name}-edge`,1+offset,1+offset,`${name}-start`,`${name}-end`,JSON.stringify(geometry),100,0,0,100,0,"[[0,100],[100,100]]","public","trail",'["fixture"]',"[]");
    db.prepare("INSERT INTO edge_spatial VALUES (?,?,?,?,?)").run(1+offset,0,1,0,0);
    db.prepare("INSERT INTO access_points VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`${name}-access`,`${name}-start`,"Start","trailhead","public","high",null,'["fixture"]',1,1,1,1,0,0.1,name,"street",null,0,0);
  } finally {db.close();}
  return options;
}
const combined=(a:DataRelease,b:DataRelease):DataRelease=>({...a,id:"catalog-ab",sections:[...a.sections,...b.sections],artifacts:[...a.artifacts,...b.artifacts]});
const manifest=()=>readFile(path.join(root,"release.json"),"utf8");
async function mutateArtifact(release:DataRelease,sql:string) {
  const artifact=release.artifacts[0]!,file=path.join(root,"mutate.sqlite");
  await writeFile(file,gunzipSync(await readFile(path.join(root,artifact.path))));
  const db=new DatabaseSync(file);try{db.exec("BEGIN; PRAGMA defer_foreign_keys=ON");db.exec(sql);db.exec("COMMIT");}finally{db.close();}
  const bytes=await readFile(file),compressed=gzipSync(bytes),id=createHash("sha256").update(bytes).digest("hex");
  release.sections[0]!.artifactIds=[id];
  release.artifacts=[{...artifact,id,path:`objects/${id}.sqlite.gz`,bytes:bytes.length,compressedBytes:compressed.length}];
  await writeFile(path.join(root,release.artifacts[0]!.path),compressed);
}
it("exports the complete graph directly, with no geographic partitioning or renumbering",async()=>{
  const options=fixture(),release=await exportPreparedRelease({...options,publish:true});
  expect(release.sections).toHaveLength(1);expect(release.artifacts).toHaveLength(1);
  expect(release.partitioning).toBe("connected-networks");
  expect(release.artifacts[0]!.graphId).toBe(preparedReleaseId(options));
  expect(gunzipSync(await readFile(path.join(root,release.artifacts[0]!.path)))).toEqual(await readFile(options.databasePath));
  expect(await inspectPreparedRelease(path.join(root,"release.json"))).toMatchObject({verified:true,sections:1,artifacts:[{nodes:2,directedEdges:1}]});
  expect((await readdir(root)).some(name=>name.startsWith(".export-"))).toBe(false);
});
it("includes network membership and input fingerprint in immutable graph identity",()=>{
  const options=fixture();
  expect(preparedReleaseId({...options,network:{...options.network,id:"another-network"}})).not.toBe(preparedReleaseId(options));
  expect(preparedReleaseId({...options,network:{...options.network,inputFingerprint:"changed-input"}})).not.toBe(preparedReleaseId(options));
});
it("publishes an expanded catalog using unchanged artifact bytes and independent graph identities",async()=>{
  const a=await exportPreparedRelease({...fixture(),publish:true}),before=await readFile(path.join(root,a.artifacts[0]!.path));
  const b=await exportPreparedRelease(fixture("b",10));
  const release=combined(a,b);release.sources.push({...source,id:"unused-catalog-source"});
  await publishPreparedCatalog(release,root);
  expect(await readFile(path.join(root,a.artifacts[0]!.path))).toEqual(before);
  expect(await inspectPreparedRelease(path.join(root,"release.json"))).toMatchObject({verified:true,sections:2});
});
it("rejects reused artifact corruption before activating the new catalog",async()=>{
  const a=await exportPreparedRelease({...fixture(),publish:true}),prior=await manifest(),b=await exportPreparedRelease(fixture("b",10));
  await writeFile(path.join(root,a.artifacts[0]!.path),"corrupt");
  await expect(publishPreparedCatalog(combined(a,b),root)).rejects.toThrow("size differs");
  expect(await manifest()).toBe(prior);
});
it("rejects a content hash mismatch even when the compressed byte count matches",async()=>{
  const release=await exportPreparedRelease(fixture()),artifact=release.artifacts[0]!,bytes=gunzipSync(await readFile(path.join(root,artifact.path)));
  bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
  const compressed=gzipSync(bytes);await writeFile(path.join(root,artifact.path),compressed);artifact.compressedBytes=compressed.length;
  await expect(publishPreparedCatalog(release,root)).rejects.toThrow("checksum/size");
});
it("cancellation preserves the prior catalog and a later retry succeeds",async()=>{
  const a=await exportPreparedRelease({...fixture(),publish:true}),prior=await manifest(),b=await exportPreparedRelease(fixture("b",10)),candidate=combined(a,b);
  let checks=0;
  await expect(publishPreparedCatalog(candidate,root,async()=>{if(++checks===4) throw new Error("cancelled");})).rejects.toThrow("cancelled");
  expect(await manifest()).toBe(prior);
  await publishPreparedCatalog(candidate,root);
  expect(JSON.parse(await manifest()).id).toBe(candidate.id);
});
it("rejects cross-network numeric key collisions",async()=>{
  const a=await exportPreparedRelease(fixture()),b=await exportPreparedRelease(fixture("b"));
  await expect(publishPreparedCatalog(combined(a,b),root)).rejects.toThrow("Conflicting graph identity");
});
it("rejects one source identity with two numeric keys",async()=>{
  const a=await exportPreparedRelease(fixture()),b=await exportPreparedRelease(fixture("b",10));
  await mutateArtifact(b,"UPDATE nodes SET id='a-start' WHERE id='b-start'; UPDATE edges SET from_node='a-start' WHERE from_node='b-start'; UPDATE access_points SET node_id='a-start' WHERE node_id='b-start'");
  await expect(publishPreparedCatalog(combined(a,b),root)).rejects.toThrow("Conflicting graph identity");
});
it("rejects duplicate source membership across networks, while inspecting consistent geographic seams",async()=>{
  const a=await exportPreparedRelease(fixture()),b=structuredClone(a);
  b.sections[0]!.id="b";
  await mutateArtifact(b,"INSERT INTO metadata VALUES ('unused','different artifact')");
  const release=combined(a,b);
  await expect(publishPreparedCatalog(release,root)).rejects.toThrow("multiple networks");
  release.partitioning="geographic";
  await publishPreparedCatalog(release,root);
  expect(await inspectPreparedRelease(path.join(root,"release.json"))).toMatchObject({verified:true,sections:2});
});
it("supports legacy graph identity fallback",async()=>{
  const release=await exportPreparedRelease(fixture());release.partitioning="geographic";delete release.artifacts[0]!.graphId;
  await publishPreparedCatalog(release,root);
  expect(await inspectPreparedRelease(path.join(root,"release.json"))).toMatchObject({verified:true});
});
it.each([
  ["UPDATE nodes SET elevation_m=NULL", "elevation"],
  ["UPDATE edges SET length_m=101", "metrics/elevation"],
  ["UPDATE edge_spatial SET min_lon=0,max_lon=0", "spatial inventory"],
  ["UPDATE metadata SET value='wrong' WHERE key='releaseId'", "release identity"],
  ["UPDATE sources SET content_hash='bad'", "source differs"],
  ["UPDATE access_points SET inclusive_minimum_stem_m=1e999", "compact feasibility"],
  ["UPDATE access_points SET known_minimum_stem_m=0,inclusive_minimum_stem_m=1", "compact feasibility"],
  ["UPDATE nodes SET lon=0.5 WHERE lon=0; UPDATE node_spatial SET min_lon=0.5,max_lon=0.5 WHERE min_lon=0", "geometry/endpoints"],
  ["PRAGMA foreign_keys=OFF; DELETE FROM nodes WHERE node_key=1", "integrity audit"],
])("retains graph integrity rejection: %s",async(sql,message)=>{
  const options=fixture();const db=new DatabaseSync(options.databasePath);try{db.exec(sql);}finally{db.close();}
  await expect(exportPreparedRelease({...options,publish:true})).rejects.toThrow(message);
  await expect(manifest()).rejects.toThrow();
});
it("audits artifact geometry, rather than accepting edges elsewhere in the catalog",async()=>{
  const release=await exportPreparedRelease(fixture());release.artifacts[0]!.geometry=rectangle([-2,-2,-1,-1]);
  await expect(publishPreparedCatalog(release,root)).rejects.toThrow("geometry/endpoints");
});

it("rejects inconsistent physical metrics between legal travel directions",async()=>{
  const options=fixture(),db=new DatabaseSync(options.databasePath);
  try {
    db.exec(`INSERT INTO edges SELECT 'reverse',2,physical_edge_key,to_node,from_node,'[[1,0],[0,0]]',length_m,1,loss_m,max_elevation_m,max_sustained_grade_pct,elevation_profile,access_state,edge_class,source_refs,flags FROM edges;
      INSERT INTO edge_spatial VALUES (2,0,1,0,0)`);
  } finally {db.close();}
  await expect(exportPreparedRelease(options)).rejects.toThrow("metrics/directions");
});
it("rejects changed preparation metadata without a matching graph rebuild",async()=>{
  const options=fixture();
  await expect(exportPreparedRelease({...options,compilerVersion:"changed"})).rejects.toThrow("release identity");
});

it("requires edge and access provenance to exist within each artifact",async()=>{
  const release=await exportPreparedRelease(fixture());
  release.sources.push({...source,id:"other-network-source"});
  await mutateArtifact(release,`UPDATE edges SET source_refs='["other-network-source"]'`);
  await expect(publishPreparedCatalog(release,root)).rejects.toThrow("Unknown edge source");
});
