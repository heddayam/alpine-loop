import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { packManifestSchema } from "@/lib/contracts";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { SQLiteClosedRouteFeasibilityRepository } from "@/lib/graph/sqlite-closed-route-feasibility-repository";
import { buildClosedRouteTopology } from "../topology-compiler";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "../types";
import { openProgressiveGraphStore } from "./store";
import { publishProgressiveGraph } from "./publish";

const builtAt="2026-01-01T00:00:00.000Z";
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
  it("resumes a source union and recomputes cross-unit cycle access for expanded coverage",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-pack-"));
    try {
      const {nodes,edges,points}=fixture();
      let store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"source-and-algorithms-v1"});
      for(const node of nodes) store.putNode(node);
      for(const edge of edges) store.putEdge(edge);
      for(const point of points) store.putAccessPoint(point);
      store.putReceipt({stage:"metric",fingerprint:"v1",rowCount:edges.length,contentHash:"fixture"});
      store.close();
      store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"source-and-algorithms-v1"});
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
  it("derives a globally clustered road-contact portal with building evidence",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-portals-"));
    try {
      const {nodes,edges}=fixture();
      const store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"fixture-v1"});
      for(const node of nodes)store.putNode(node);
      store.putNode({id:"road",externalId:"road",lon:0,lat:-0.001,elevationM:null,flags:[],sourceRefs:["fixture"]});
      for(const edge of edges)store.putEdge(edge);
      store.putWay({id:"street",externalId:"way/street",nodeIds:["road","a"],coordinates:[[0,-0.001],[0,0]],name:"Access Road",accessState:"public",bidirectional:true,edgeClass:"street",sourceRefs:["fixture"],flags:[]});
      store.putBuilding([0.0001,0]);
      const version=manifest("portal-v1",0.002);
      expect(store.derivePortals(version.coverage.boundary)).toBe(1);
      const result=await publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:version,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]});
      const db=new DatabaseSync(result.databasePath,{readOnly:true});
      try {
        const point=db.prepare("SELECT id,nearby_building_count,portal_road_class,known_connectivity FROM access_points").get() as {id:string;nearby_building_count:number;portal_road_class:string;known_connectivity:number};
        expect(point).toMatchObject({id:"portal:a",nearby_building_count:1,portal_road_class:"street",known_connectivity:3});
      } finally {db.close();store.close();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it("publishes a valid empty installation unit",async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"progressive-empty-"));
    try {
      const store=openProgressiveGraphStore({stagingPath:path.join(directory,"stage.sqlite"),buildIdentity:"fixture-v1"});
      const version=manifest("empty-v1",0.002);
      expect(store.derivePortals(version.coverage.boundary)).toBe(0);
      const result=await publishProgressiveGraph(store,{outputRoot:path.join(directory,"packs"),manifest:version,namedAreas:[],searchRegions:[{namedAreaId:"pack:progressive-fixture",displayOrder:0}]});
      expect(result.audit).toMatchObject({nodeCount:0,directedEdgeCount:0,accessPointCount:0});
      const reader=new SQLiteClosedRouteFeasibilityRepository({databasePath:result.databasePath,manifest:version});
      await expect(reader.getAccessTopology("known",[])).resolves.toEqual([]);
      await reader.close();store.close();
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

});
