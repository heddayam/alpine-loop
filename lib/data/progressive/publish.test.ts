import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { packManifestSchema } from "@/lib/contracts";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { SQLiteClosedRouteFeasibilityRepository } from "@/lib/graph/sqlite-closed-route-feasibility-repository";
import { buildClosedRouteTopology } from "../topology-compiler";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "../types";
import { openProgressiveGraphStore, type ProgressiveGraphStore } from "./store";
import { publishProgressiveGraph } from "./publish";

const builtAt="2026-01-01T00:00:00.000Z";
function stageSource(store:ProgressiveGraphStore){store.putSource({...source,contentHash:source.contentHash as `sha256:${string}`,localPath:"fixture"});}
const source={id:"fixture",authority:"Fixture",dataset:"Graph",version:"1",retrievedAt:builtAt,url:"https://example.invalid/fixture",license:"CC0-1.0",contentHash:`sha256:${"0".repeat(64)}`};
function manifest(dataVersion:string,maxLon:number) {return packManifestSchema.parse({schemaVersion:"6",id:"progressive-fixture",name:"Progressive fixture",dataVersion,builtAt,compilerVersion:"test",metricAlgorithmVersion:"test",
  coverage:{bbox:[-1,-1,maxLon,1],boundary:{type:"Polygon",coordinates:[[[-1,-1],[maxLon,-1],[maxLon,1],[-1,1],[-1,-1]]]}},display:{center:[0,0],zoom:10},
  capabilities:{elevation:true,officialAccess:true,namedAreas:true,closedRouteTopology:true,batchSearchRegions:true,elevationProfiles:true,portalAccessPoints:true},
  fieldConfidence:{topology:"high"},sources:[source],closedRouteTopology:{runtimeMode:"reachable-graph-fallback",algorithmVersion:CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION,policyVersion:"closed-route-decision-graph-v1",profiles:["known","inclusive"]}});}
function fixture() {
  const positions:Record<string,[number,number]>={a:[0,0],b:[0.001,0],c:[0.001,0.001],stem:[-0.001,0],island:[0.005,0]};
  const nodes:NormalizedNode[]=Object.entries(positions).map(([id,[lon,lat]])=>({id,externalId:id,lon,lat,elevationM:100,flags:[],sourceRefs:["fixture"]}));
  const edges:CompiledEdge[]=[];
  const add=(id:string,from:string,to:string,accessState:"public"|"unknown"="public")=>{
    const geometry:[number,number][]=[positions[from]!,positions[to]!];
    for(const [tail,head,coords,suffix] of [[from,to,geometry,"f"],[to,from,[...geometry].reverse(),"r"]] as const) edges.push({id:`${id}-${suffix}`,stablePhysicalId:id,fromNode:tail,toNode:head,geometry:coords,lengthM:100,gainM:0,lossM:0,maxElevationM:100,maxSustainedGradePct:0,
      elevationProfile:[{distanceMeters:0,elevationMeters:100},{distanceMeters:100,elevationMeters:100}],accessState,edgeClass:"trail",sourceRefs:["fixture"],flags:[]});
  };
  add("ab","a","b");add("bc","b","c");add("ca","c","a");add("stem","stem","a","unknown");add("island","c","island");
  const points:NormalizedAccessPoint[]=["a","stem"].map((id)=>({id:`portal:${id}`,externalId:id,nodeId:id,name:id,kind:"trailhead",accessState:"public",confidence:"high",parkingEvidence:null,sourceRefs:["fixture"],
    knownConnectivity:3,inclusiveConnectivity:4,knownOutDegree:1,inclusiveOutDegree:1,nearbyBuildingCount:0,reachableTrailKm:1,trailComponentId:"fixture",portalRoadClass:"street",parkingDistanceM:null}));
  return {nodes,edges,points};
}

describe("progressive schema-6 publisher",()=>{
  it("interrupts bounded portal, export, and traversal work, then replays without changing the active graph",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-interrupt-"));
    const store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"interrupt-v1"});
    try {
      const {nodes,edges,points}=fixture();
      stageSource(store);
      store.transaction(()=>{
        nodes.forEach(node=>store.putNode(node));edges.forEach(edge=>store.putEdge(edge));points.forEach(point=>store.putAccessPoint(point));
        for(let index=0;index<=1100;index++) {
          const id=`chain-${index}`,lon=index/100000;
          store.putNode({...nodes[0]!,id,externalId:id,lon,lat:0.01});
          if(index) for(const reverse of [false,true]) {
            const from=`chain-${index-1}`,geometry:[number,number][]=[[(index-1)/100000,0.01],[lon,0.01]];
            store.putEdge({...edges[0]!,id:`chain-edge-${index}-${reverse}`,stablePhysicalId:`chain-edge-${index}`,
              fromNode:reverse?id:from,toNode:reverse?from:id,geometry:reverse?geometry.reverse():geometry});
          }
        }
      });
      const version=manifest("baseline",0.02),options={outputRoot:path.join(directory,"packs"),namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]};
      await expect(store.derivePortals(version.coverage.boundary,async()=>{
        if(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='trail_links'").get() &&
          Number(store.database.prepare("SELECT count(*) AS n FROM trail_links").get()?.n)>0) throw new Error("pause portals");
      })).rejects.toThrow("pause portals");
      expect(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='portal_components'").get()).toBeUndefined();
      await store.derivePortals(version.coverage.boundary);
      const baseline=await publishProgressiveGraph(store,{...options,manifest:version});
      const pointer=path.join(options.outputRoot,version.id,"current.json"),before=readFileSync(pointer,"utf8");
      for(const target of ["Write covered graph","Derive global cycle feasibility"]) {
        let stage="",checks=0;
        await expect(publishProgressiveGraph(store,{...options,manifest:manifest("replacement",0.02),
          onProgress:async value=>{await Promise.resolve();stage=value;},checkpoint:async()=>{
            if(stage===target && ++checks===(target==="Derive global cycle feasibility"?3:2)) throw new Error(`pause ${target}`);
          }})).rejects.toThrow(`pause ${target}`);
        expect(readFileSync(pointer,"utf8")).toBe(before);
        expect(readdirSync(path.dirname(pointer)).some(name=>name.startsWith(".staging-"))).toBe(false);
      }
      const replay=await publishProgressiveGraph(store,{...options,manifest:manifest("replacement",0.02)});
      expect(replay.audit.topologyContentHash).toBe(baseline.audit.topologyContentHash);
      expect(replay.audit.directedEdgeCount).toBe(baseline.audit.directedEdgeCount);
    } finally {store.close();rmSync(directory,{recursive:true,force:true});}
  },15000);

  it("resumes a source union and recomputes cross-unit cycle access for expanded coverage",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-pack-"));
    try {
      const {nodes,edges,points}=fixture();
      let store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"source-and-algorithms-v1"});
      stageSource(store);
      for(const node of nodes) store.putNode(node);
      for(const edge of edges) store.putEdge(edge);
      for(const point of points) store.putAccessPoint(point);
      store.putReceipt({stage:"metric",fingerprint:"v1",rowCount:edges.length,contentHash:"fixture"});
      store.close();
      store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"source-and-algorithms-v1"});
      stageSource(store);
      expect(store.getReceipt("metric")?.rowCount).toBe(edges.length);
      for(const edge of edges) store.putEdge(edge);
      const outputRoot=path.join(directory,"packs");
      const options={outputRoot,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]};
      const first=await publishProgressiveGraph(store,{...options,manifest:manifest("v1",0.002)});
      const second=await publishProgressiveGraph(store,{...options,manifest:manifest("v2",0.006)});
      const firstDb=new DatabaseSync(first.databasePath,{readOnly:true}),secondDb=new DatabaseSync(second.databasePath,{readOnly:true});
      try {
        expect((firstDb.prepare("SELECT count(*) AS n FROM physical_edges").get() as {n:number}).n).toBe(4);
        expect((secondDb.prepare("SELECT count(*) AS n FROM physical_edges").get() as {n:number}).n).toBe(5);
        expect((firstDb.prepare("SELECT can_reach_cycle AS yes FROM access_topology WHERE profile='known' AND access_point_id='portal:a'").get() as {yes:number}).yes).toBe(1);
        expect((firstDb.prepare("SELECT can_reach_cycle AS yes FROM access_topology WHERE profile='known' AND access_point_id='portal:stem'").get() as {yes:number}).yes).toBe(0);
        expect((secondDb.prepare("SELECT minimum_stem_distance_m AS m FROM access_topology WHERE profile='inclusive' AND access_point_id='portal:stem'").get() as {m:number}).m).toBe(100);
      } finally {firstDb.close();secondDb.close();}
      const reader=new SQLiteClosedRouteFeasibilityRepository({databasePath:second.databasePath,manifest:manifest("v2",0.006)});
      await expect(reader.getAccessTopology("inclusive",["portal:stem"])).resolves.toEqual([expect.objectContaining({canReachCycle:true,minimumStemDistanceMeters:100})]);
      await reader.close();
      const reference=buildClosedRouteTopology(nodes,edges,points,{builtAt,algorithmVersion:CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION,policyVersion:"closed-route-decision-graph-v1"});
      expect(second.audit.topologyContentHash).toBe(reference.contentHash);
      store.close();
    } finally {rmSync(directory,{recursive:true,force:true});}
  });
  it("accepts a complete short trail edge with no sustained-grade window",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-short-edge-"));
    try {
      const {nodes,edges,points}=fixture(),store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"same-source-v1"});
      stageSource(store);
      for(const node of nodes.filter(({id})=>id==="a"||id==="b"))store.putNode(node.id==="b"?{...node,lon:0.0003}:node);
      for(const edge of edges.filter(({stablePhysicalId})=>stablePhysicalId==="ab")) {
        const from=edge.fromNode==="b"?[0.0003,0] as const:[0,0] as const;
        const to=edge.toNode==="b"?[0.0003,0] as const:[0,0] as const;
        store.putEdge({...edge,geometry:[from,to],lengthM:33,maxSustainedGradePct:null,elevationProfile:[{distanceMeters:0,elevationMeters:100},{distanceMeters:33,elevationMeters:100}]});
      }
      store.putAccessPoint(points[0]!);
      const result=await publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:manifest("short",0.001),namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]});
      expect(result.audit.missingElevationEdgeCount).toBe(0);
      store.close();
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("matches directed SCC legality for a one-way cycle and inbound tail",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-directed-"));
    try {
      const {nodes,edges,points}=fixture(),directed=edges.filter(({id})=>id.endsWith("-f"));
      const store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"same-source-v1"});
      stageSource(store);
      nodes.forEach((node)=>store.putNode(node));directed.forEach((edge)=>store.putEdge(edge));points.forEach((point)=>store.putAccessPoint(point));
      const version=manifest("directed",0.006);
      const result=await publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:version,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]});
      const reference=buildClosedRouteTopology(nodes,directed,points,{builtAt,algorithmVersion:CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION,policyVersion:"closed-route-decision-graph-v1"});
      expect(result.audit.topologyContentHash).toBe(reference.contentHash);
      const db=new DatabaseSync(result.databasePath,{readOnly:true});
      try {
        expect(db.prepare("SELECT can_reach_cycle AS yes FROM access_topology WHERE profile='inclusive' AND access_point_id='portal:a'").get()).toMatchObject({yes:1});
        expect(db.prepare("SELECT can_reach_cycle AS yes FROM access_topology WHERE profile='inclusive' AND access_point_id='portal:stem'").get()).toMatchObject({yes:0});
      } finally {db.close();store.close();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("derives a globally clustered road-contact portal with building evidence",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-portals-"));
    try {
      const {nodes,edges}=fixture();
      const store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"fixture-v1"});
      stageSource(store);
      for(const node of nodes)store.putNode(node);
      store.putNode({id:"road",externalId:"road",lon:0,lat:-0.001,elevationM:null,flags:[],sourceRefs:["fixture"]});
      for(const edge of edges)store.putEdge(edge);
      store.putWay({id:"street",externalId:"way/street",nodeIds:["road","a"],coordinates:[[0,-0.001],[0,0]],name:"Access Road",accessState:"public",bidirectional:true,edgeClass:"street",sourceRefs:["fixture"],flags:[]});
      store.putBuilding([0.0001,0]);
      const version=manifest("portal-v1",0.002);
      expect(await store.derivePortals(version.coverage.boundary)).toBe(1);
      const result=await publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:version,
        namedAreas:[{id:"pack:progressive-fixture",name:version.name,kind:"pack",aliases:["Accessible pack"],bbox:version.coverage.bbox,geometry:version.coverage.boundary,sourceIds:["fixture"]}],
        searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]});
      const db=new DatabaseSync(result.databasePath,{readOnly:true});
      try {
        const point=db.prepare("SELECT id,nearby_building_count,portal_road_class,known_connectivity FROM access_points").get() as {id:string;nearby_building_count:number;portal_road_class:string;known_connectivity:number};
        expect(point).toMatchObject({id:"portal:a",nearby_building_count:1,portal_road_class:"street",known_connectivity:3});
        expect(db.prepare("SELECT alias FROM named_area_aliases WHERE alias='Accessible pack'").get()).toMatchObject({alias:"Accessible pack"});
      } finally {db.close();store.close();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("completes a loop only after a second unit and is independent of import order",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-cross-unit-"));
    try {
      const points:{[id:string]:[number,number]}={a:[0,0],b:[0.001,0],c:[0.002,0.0002],road:[0,-0.001]};
      const nodes=Object.entries(points).map(([id,[lon,lat]])=>({id,externalId:id,lon,lat,elevationM:id==="road"?null:100,flags:[],sourceRefs:["fixture"]}));
      const edges:CompiledEdge[]=[];
      for(const [physical,from,to] of [["ab","a","b"],["bc","b","c"],["ca","c","a"]]) {
        for(const [tail,head,suffix] of [[from,to,"f"],[to,from,"r"]]) edges.push({id:`${physical}-${suffix}`,stablePhysicalId:physical,fromNode:tail,toNode:head,
          geometry:[points[tail]!,points[head]!],lengthM:100,gainM:0,lossM:0,maxElevationM:100,maxSustainedGradePct:0,
          elevationProfile:[{distanceMeters:0,elevationMeters:100},{distanceMeters:100,elevationMeters:100}],accessState:"public",edgeClass:"trail",sourceRefs:["fixture"],flags:[]});
      }
      const roadWay={id:"road-way",externalId:"way/road",nodeIds:["road","a","b","c"],coordinates:[points.road!,points.a!,points.b!,points.c!],name:"Road",accessState:"public" as const,bidirectional:true,edgeClass:"street" as const,sourceRefs:["fixture"],flags:[]};
      async function build(order:"normal"|"reverse",root:string){
        const store=openProgressiveGraphStore({stagingPath:path.join(root,"stage.sqlite"),buildIdentity:"same-source-v1"});
      stageSource(store);
        for(const node of order==="normal"?nodes:[...nodes].reverse())store.putNode(node);
        for(const edge of order==="normal"?edges:[...edges].reverse())store.putEdge(edge);
        store.putWay(roadWay);
        const outputRoot=path.join(root,"packs"),options={outputRoot,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]};
        const firstManifest=manifest("partial",0.0015),secondManifest=manifest("complete",0.003);
        expect(await store.derivePortals(firstManifest.coverage.boundary)).toBe(1);
        const first=await publishProgressiveGraph(store,{...options,manifest:firstManifest});
        expect(await store.derivePortals(secondManifest.coverage.boundary)).toBe(1);
        const second=await publishProgressiveGraph(store,{...options,manifest:secondManifest});
        const firstDb=new DatabaseSync(first.databasePath,{readOnly:true}),secondDb=new DatabaseSync(second.databasePath,{readOnly:true});
        try {
          expect((firstDb.prepare("SELECT can_reach_cycle AS yes FROM access_topology WHERE profile='known'").get() as {yes:number}).yes).toBe(0);
          expect((secondDb.prepare("SELECT can_reach_cycle AS yes FROM access_topology WHERE profile='known'").get() as {yes:number}).yes).toBe(1);
          expect((firstDb.prepare("SELECT count(*) AS n FROM physical_edges").get() as {n:number}).n).toBe(1);
          expect((secondDb.prepare("SELECT count(*) AS n FROM physical_edges").get() as {n:number}).n).toBe(3);
          expect((firstDb.prepare("SELECT count(*) AS n FROM access_points").get() as {n:number}).n).toBe(1);
          expect((secondDb.prepare("SELECT count(*) AS n FROM access_points").get() as {n:number}).n).toBe(1);
          const firstPortal=firstDb.prepare("SELECT id,reachable_trail_km AS km FROM access_points").get() as {id:string;km:number};
          const secondPortal=secondDb.prepare("SELECT id,reachable_trail_km AS km FROM access_points").get() as {id:string;km:number};
          expect(firstPortal.id).toBe("portal:a");
          expect(secondPortal.id).toBe("portal:a");
          expect(firstPortal.km).toBe(0.1);
          expect(secondPortal.km).toBe(0.3);
        } finally {firstDb.close();secondDb.close();store.close();}
        return second.audit.topologyContentHash;
      }
      expect(await build("normal",path.join(directory,"forward"))).toBe(await build("reverse",path.join(directory,"reverse")));
      expect(()=>openProgressiveGraphStore({stagingPath:path.join(directory,"forward","stage.sqlite"),buildIdentity:"changed-source-v2"})).toThrow(/identity mismatch/);
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("adds an eligible road-contact start when its trail arrives in an expanded unit",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-expansion-portal-"));
    try {
      const {nodes,edges}=fixture(),store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"same-source-v1"});
      stageSource(store);
      nodes.forEach((node)=>store.putNode(node));edges.forEach((edge)=>store.putEdge(edge));
      store.putNode({id:"island-road",externalId:"island-road",lon:0.005,lat:-0.001,elevationM:null,flags:[],sourceRefs:["fixture"]});
      store.putWay({id:"island-street",externalId:"way/island-street",nodeIds:["island-road","island"],coordinates:[[0.005,-0.001],[0.005,0]],name:"Road",accessState:"public",bidirectional:true,edgeClass:"street",sourceRefs:["fixture"],flags:[]});
      const outputRoot=path.join(directory,"packs"),options={outputRoot,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]};
      const firstManifest=manifest("without-island",0.002),secondManifest=manifest("with-island",0.006);
      expect(await store.derivePortals(firstManifest.coverage.boundary)).toBe(0);
      const first=await publishProgressiveGraph(store,{...options,manifest:firstManifest});
      expect(first.audit.accessPointCount).toBe(0);
      expect(await store.derivePortals(secondManifest.coverage.boundary)).toBe(1);
      const second=await publishProgressiveGraph(store,{...options,manifest:secondManifest});
      const db=new DatabaseSync(second.databasePath,{readOnly:true});
      try {
        expect(db.prepare("SELECT id FROM access_points").get()).toMatchObject({id:"portal:island"});
        expect(db.prepare("SELECT can_reach_cycle AS yes,minimum_stem_distance_m AS stem FROM access_topology WHERE profile='known'").get()).toMatchObject({yes:1,stem:100});
      } finally {db.close();store.close();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("keeps the activated version when a later publication hook fails",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-atomic-"));
    try {
      const {nodes,edges,points}=fixture(),store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"same-source-v1"});
      stageSource(store);
      nodes.forEach((node)=>store.putNode(node));edges.forEach((edge)=>store.putEdge(edge));points.forEach((point)=>store.putAccessPoint(point));
      const outputRoot=path.join(directory,"packs"),options={outputRoot,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]};
      let activationCalls=0;
      await publishProgressiveGraph(store,{...options,manifest:manifest("good",0.006),commitPublication:async(activate)=>{activationCalls++;await activate();}});
      const packRoot=path.join(outputRoot,"progressive-fixture"),pointer=path.join(packRoot,"current.json");
      const before=readFileSync(pointer,"utf8");
      await expect(publishProgressiveGraph(store,{...options,manifest:manifest("failed",0.006),beforePublish:()=>{throw new Error("fixture hook failure");}})).rejects.toThrow("fixture hook failure");
      expect(readFileSync(pointer,"utf8")).toBe(before);
      expect(readdirSync(packRoot).filter((name)=>name.startsWith(".staging-"))).toEqual([]);
      await expect(publishProgressiveGraph(store,{...options,manifest:manifest("deferred",0.006),commitPublication:async()=>{throw new Error("activation cancelled");}})).rejects.toThrow("activation cancelled");
      expect(readFileSync(pointer,"utf8")).toBe(before);
      const reused=await publishProgressiveGraph(store,{...options,manifest:manifest("deferred",0.006),commitPublication:async(activate)=>{activationCalls++;await activate();}});
      expect(reused.reusedExisting).toBe(true);
      expect(activationCalls).toBe(2);
      expect(JSON.parse(readFileSync(pointer,"utf8"))).toMatchObject({dataVersion:"deferred"});
      await expect(publishProgressiveGraph(store,{...options,manifest:manifest("ignored",0.006),commitPublication:async()=>{}})).rejects.toThrow(/without activating/);
      expect(JSON.parse(readFileSync(pointer,"utf8"))).toMatchObject({dataVersion:"deferred"});
      unlinkSync(pointer);
      await publishProgressiveGraph(store,{...options,manifest:manifest("deferred",0.006)});
      expect(JSON.parse(readFileSync(pointer,"utf8"))).toMatchObject({dataVersion:"deferred"});
      store.close();
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("rejects conflicting staged topology, elevation, and source identity on resume",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-conflict-"));
    try {
      const {nodes,edges}=fixture(),stage=path.join(directory,"stage.sqlite");
      let store=openProgressiveGraphStore({stagingPath:stage,buildIdentity:"pinned-source-v1"});
      stageSource(store);
      store.putNode({...nodes[0]!,elevationM:null});store.setNodeElevation(nodes[0]!.id,100);store.putEdge(edges[0]!);store.close();
      store=openProgressiveGraphStore({stagingPath:stage,buildIdentity:"pinned-source-v1"});
      stageSource(store);
      expect(()=>store.putNode({...nodes[0]!,elevationM:null})).not.toThrow();
      expect(()=>store.setNodeElevation(nodes[0]!.id,101)).toThrow(/Conflicting elevation/);
      expect(()=>store.putEdge({...edges[0]!,lengthM:101})).toThrow(/Conflicting progressive edges/);
      store.database.prepare("UPDATE sources SET record=? WHERE id='fixture'").run(JSON.stringify({...source,contentHash:`sha256:${"1".repeat(64)}`}));
      await expect(publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:manifest("tampered",0.002),namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]})).rejects.toThrow(/Staged source/);
      store.close();
      expect(()=>openProgressiveGraphStore({stagingPath:stage,buildIdentity:"different-source-v2"})).toThrow(/identity mismatch/);
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("publishes a valid empty installation unit",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-empty-"));
    try {
      const store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"fixture-v1"});
      stageSource(store);
      const version=manifest("empty-v1",0.002);
      expect(await store.derivePortals(version.coverage.boundary)).toBe(0);
      const result=await publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:version,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]});
      expect(result.audit).toMatchObject({nodeCount:0,directedEdgeCount:0,accessPointCount:0});
      const reader=new SQLiteClosedRouteFeasibilityRepository({databasePath:result.databasePath,manifest:version});
      await expect(reader.getAccessTopology("known",[])).resolves.toEqual([]);
      await reader.close();store.close();
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

});
