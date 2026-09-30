import { describe, expect, it } from "vitest";
import type { AreaGeometry } from "../area-geometry";
import { compiledEdgesForSegment } from "../compiled-edges";
import { distanceMeters } from "../metrics";
import { normalizeOsmOpl } from "../osm/opl";
import type { NormalizedAccessPoint, NormalizedTopology } from "../types";
import { openProgressiveGraphStore } from "./store";
import { prepareSparsePortalCandidates } from "./portals";

// Reduced local representations from the pinned WA 260801 source: entrance IDs,
// coordinates and tags are retained; long trails/roads omit intermediate nodes.
const top = `n4270728646 x-121.0788053 y47.8780535
n3761092325 Thighway=turning_circle x-121.0770096 y47.8812989
n3761092329 Thighway=trailhead,name=Top%20%Lake%20%Trailhead x-121.0771895 y47.881442
n3761092328 x-121.1532731 y47.8800167
w428036699 Thighway=track,ref=FR%20%6701-520,surface=gravel Nn4270728646,n3761092325
w1356527414 Thighway=path,foot=designated,name=Top%20%Lake%20%Trail Nn3761092325,n3761092329,n3761092328`;
const heather = `n47010713 x-121.0331753 y47.8759179
n3835171612 x-121.0752954 y47.8663592
n3835171557 x-121.0756526 y47.8662242
n3835171701 x-121.1252335 y47.8587991
n3835171595 x-121.0752717 y47.8663322
w5847190 Thighway=track,name=Heather%20%Lake%20%Trailhead%20%Road Nn47010713,n3835171612
w380176708 Thighway=path,foot=designated,name=Heather%20%Lake%20%Trail Nn3835171557,n3835171701
w380176709 Tamenity=parking,name=Heather%20%Lake%20%Trailhead Nn3835171612,n3835171557,n3835171595,n3835171612`;
const coverage: AreaGeometry = { type: "Polygon", coordinates: [[[-123,47],[-120,47],[-120,49],[-123,49],[-123,47]]] };

function staged(opl:string,adjust?:(topology:NormalizedTopology)=>void,omitPhysicalId?:string) {
  const topology=normalizeOsmOpl(opl,"fixture");
  adjust?.(topology);
  const store=openProgressiveGraphStore({stagingPath:":memory:",buildIdentity:"track-approaches"});
  store.database.exec("CREATE TEMP TABLE eligible_segments(id TEXT PRIMARY KEY,from_node TEXT NOT NULL,to_node TEXT NOT NULL,length_m REAL NOT NULL) STRICT");
  const insert=store.database.prepare("INSERT INTO eligible_segments VALUES (?,?,?,?)");
  store.transaction(()=>{
    topology.nodes.forEach(node=>store.putNode(node));
    for(const way of topology.ways) {
      store.putWay(way);
      if(way.edgeClass!=="trail"||!["public","unknown"].includes(way.accessState))continue;
      for(let index=0;index<way.nodeIds.length-1;index++) {
        const id=`${way.id}:${index}`;
        if(id!==omitPhysicalId)insert.run(id,way.nodeIds[index]!,way.nodeIds[index+1]!,distanceMeters(way.coordinates[index]!,way.coordinates[index+1]!));
      }
    }
    topology.portalEvidence?.forEach(evidence=>store.putPortalEvidence(evidence));
  });
  const measure=(keep:(physicalId:string)=>boolean=()=>true)=>store.transaction(()=>{
    for(const way of topology.ways) for(let index=0;index<way.nodeIds.length-1;index++) {
      const id=`${way.id}:${index}`;
      if(id===omitPhysicalId||!keep(id))continue;
      const geometry=way.coordinates.slice(index,index+2),lengthM=distanceMeters(geometry[0]!,geometry[1]!);
      compiledEdgesForSegment(way,index,geometry,{lengthM,gainM:0,lossM:0,maxElevationM:0,maxSustainedGradePct:0,
        elevationProfile:[{distanceMeters:0,elevationMeters:0},{distanceMeters:lengthM,elevationMeters:0}]},
        {nodeFlags:[way.nodeIds[index]!,way.nodeIds[index+1]!].map(id=>topology.nodes.find(node=>node.id===id)!.flags)}).forEach(edge=>store.putEdge(edge));
    }
  });
  return {store,topology,measure};
}
async function deriveAtStage(opl:string,adjust?: (topology:NormalizedTopology)=>void,omitPhysicalId?:string,early=false) {
  const {store,topology,measure}=staged(opl,adjust,omitPhysicalId);
  try {
    if(early) {
      await prepareSparsePortalCandidates(store,coverage);
      expect(store.database.prepare("SELECT count(*) AS n FROM edges").get()!.n).toBe(0);
      expect([...store.iterateNodes()].every(node=>node.elevationM===null)).toBe(true);
    }
    measure();
    const originalEdges=store.database.prepare("SELECT id,record FROM edges ORDER BY id").all();
    await store.derivePortals(coverage);
    const points=store.database.prepare("SELECT record FROM derived_portals ORDER BY id").all()
      .map(row=>JSON.parse(String(row.record)) as NormalizedAccessPoint);
    return {points,topology,originalEdges,edges:store.database.prepare("SELECT id,record FROM edges ORDER BY id").all()};
  } finally {store.close();}
}

it("shares component counts across starts while preserving access profiles and directed degrees", async () => {
  const opl=`n1 x-122 y48
n2 x-121.999 y48
n3 x-121.998 y48
n4 x-121.997 y48
n5 x-121.99 y48
n6 x-121.989 y48
w1 Thighway=path,foot=yes,oneway:foot=yes Nn1,n2
w2 Thighway=path Nn2,n3
w3 Thighway=path,foot=private Nn3,n4
w4 Thighway=path,foot=yes Nn5,n6
w10 Thighway=residential Nn1,n2,n3,n4,n5,n6`;
  const {points}=await deriveAtStage(opl);
  expect(points.map(point=>[point.nodeId,point.knownConnectivity,point.inclusiveConnectivity,
    point.knownOutDegree,point.inclusiveOutDegree,point.trailComponentId])).toEqual([
    ["osm-node-1",2,3,1,1,"trail-component:osm-node-1"],
    ["osm-node-2",2,3,0,1,"trail-component:osm-node-1"],
    ["osm-node-3",0,3,0,1,"trail-component:osm-node-1"],
    ["osm-node-5",2,2,1,1,"trail-component:osm-node-5"],
    ["osm-node-6",2,2,1,1,"trail-component:osm-node-5"],
  ]);
});

function detachTrack(topology: NormalizedTopology) {
  const way = topology.ways.find(way => way.flags.includes("osm-highway:track"))!;
  const old = topology.nodes.find(node => node.id === way.nodeIds.at(-1))!;
  const node = { ...old, id: "unrelated", externalId: "node/unrelated", lon: old.lon + 0.00001 };
  topology.nodes.push(node);
  way.nodeIds[way.nodeIds.length - 1] = node.id;
  way.coordinates[way.coordinates.length - 1] = [node.lon, node.lat];
}

describe.each([false,true])("explicit hiking starts reached by walking tracks (before elevation=%s)", early => {
  const derive=(opl:string,adjust?:(topology:NormalizedTopology)=>void,omitPhysicalId?:string)=>deriveAtStage(opl,adjust,omitPhysicalId,early);
  it("keeps the mapped Top Lake trailhead 20.8m along its path from the track junction", async () => {
    const { points, topology, originalEdges, edges } = await derive(top);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({nodeId:"osm-node-3761092325",entryWitness:{kind:"interface",known:true}});
    expect(points[1]).toMatchObject({ nodeId: "osm-node-3761092329", name: "Top Lake Trailhead", accessState: "public", confidence: "high", portalRoadClass: "service-road" });
    expect(topology.ways.find(way => way.id === "osm-way-428036699")?.edgeClass).toBe("trail");
    expect(edges).toEqual(originalEdges);
  });

  it("retains support for a tagged trailhead directly on the track/path junction", async () => {
    const { points } = await derive(top, topology => {
      const evidence = topology.portalEvidence![0]!;
      const junction = topology.nodes.find(node => node.id === "osm-node-3761092325")!;
      Object.assign(evidence, { nodeIds: [junction.id], externalId: junction.externalId, coordinates: [[junction.lon, junction.lat]] });
    });
    expect(points.map(point => point.nodeId)).toEqual(["osm-node-3761092325"]);
  });

  it("uses the hiking vertex of Heather Lake parking, without creating a connector across the lot", async () => {
    const { points, originalEdges, edges } = await derive(heather);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ nodeId: "osm-node-3835171557", accessState: "public", parkingEvidence: "portal-evidence:way/380176709", parkingDistanceM: 0, portalRoadClass: "service-road" });
    expect(edges).toEqual(originalEdges);
  });

  it.each([
    {flags:[],accessState:"public",known:true},
    {flags:["motor-access:unknown"],accessState:"public",known:true},
    {flags:["foot-access:public"],accessState:"public",known:true},
    {flags:["foot-access:unknown","conditional:foot:yes @ (sunrise-sunset)"],accessState:"unknown",known:false},
  ])("distinguishes missing parking foot metadata from an explicit $flags assertion",async({flags,accessState,known})=>{
    const {points}=await derive(heather,topology=>{
      Object.assign(topology.portalEvidence!.find(item=>item.kind==="parking")!,{flags});
    });
    expect(points).toMatchObject([{nodeId:"osm-node-3835171557",accessState,entryWitness:{kind:"parking",known}}]);
    expect(points.filter(point=>point.accessState==="public")).toHaveLength(known?1:0);
  });

  it("rejects an explicit restricted parking foot assertion even if its broad state is unknown",async()=>{
    const {points}=await derive(heather,topology=>{
      Object.assign(topology.portalEvidence!.find(item=>item.kind==="parking")!,{accessState:"unknown",flags:["foot-access:private"]});
    });
    expect(points).toEqual([]);
  });

  it.each(["track", "path", "evidence"] as const)("does not add a mapped trailhead through restricted %s", async kind => {
    const { points } = await derive(top, topology => {
      if (kind === "evidence") topology.portalEvidence![0]!.accessState = "private";
      else topology.ways.find(way => way.flags.includes(`osm-highway:${kind}`))!.accessState = "prohibited";
    });
    expect(points.map(point=>point.nodeId)).toEqual(kind==="evidence"?["osm-node-3761092325"]:[]);
  });

  it.each(["track", "path", "evidence"] as const)("does not add a parking start through restricted %s", async kind => {
    const { points } = await derive(heather, topology => {
      if (kind === "evidence") topology.portalEvidence![0]!.accessState = "private";
      else topology.ways.find(way => way.flags.includes(`osm-highway:${kind}`))!.accessState = "prohibited";
    });
    expect(points).toEqual([]);
  });

  it.each([top, heather])("requires a source connection, not a nearby unrelated track", async opl => {
    expect((await derive(opl, detachTrack)).points).toEqual([]);
  });

  it("does not snap track-side parking to an unrelated nearby hiking path", async () => {
    const { points } = await derive(heather, topology => {
      const evidence = topology.portalEvidence![0]!;
      const index = evidence.nodeIds.indexOf("osm-node-3835171557");
      const original = topology.nodes.find(node => node.id === evidence.nodeIds[index])!;
      const node = { ...original, id: "parking-vertex", externalId: "node/parking-vertex", lon: original.lon + 0.00001 };
      topology.nodes.push(node);
      evidence.nodeIds[index] = node.id;
      evidence.coordinates[index] = [node.lon, node.lat];
    });
    expect(points).toEqual([]);
  });

  it("follows a connected approach when a mapper splits its path into separate ways", async () => {
    const { points } = await derive(top, topology => {
      const way = topology.ways.find(way => way.id === "osm-way-1356527414")!;
      const middle = { ...topology.nodes[0]!, id: "split", externalId: "node/split", lon: -121.07710, lat: 47.88137 };
      topology.nodes.push(middle);
      topology.ways.push({ ...way, id: "osm-way-split", externalId: "way/split", nodeIds: [way.nodeIds[0]!, middle.id], coordinates: [way.coordinates[0]!, [middle.lon, middle.lat]] });
      way.nodeIds[0] = middle.id;
      way.coordinates[0] = [middle.lon, middle.lat];
    });
    expect(points.map(point => point.nodeId)).toEqual(["osm-node-3761092325","osm-node-3761092329"]);
  });

  it("finds the connected approach through a branch regardless of way grouping or discovery order", async () => {
    const { points } = await derive(top, topology => {
      const way = topology.ways.find(way => way.id === "osm-way-1356527414")!;
      const junction = topology.nodes.find(node => node.id === "osm-node-3761092325")!;
      const sign = topology.nodes.find(node => node.id === "osm-node-3761092329")!;
      const branch = { ...sign, id: "branch", externalId: "node/branch", lon: -121.07714, lat: 47.88148 };
      const detour = { ...sign, id: "detour", externalId: "node/detour", lon: -121.079, lat: 47.8822 };
      const deadEnd = { ...sign, id: "dead-end", externalId: "node/dead-end", lon: -121.0772, lat: 47.8819 };
      topology.nodes.push(branch, detour, deadEnd);
      // Long and short source branches reach the same track contact.
      // Distance and grouping do not change source connectivity.
      way.nodeIds = [sign.id, detour.id, junction.id];
      way.coordinates = [[sign.lon, sign.lat], [detour.lon, detour.lat], [junction.lon, junction.lat]];
      for (const [id, nodes] of [["branch", [sign, branch]], ["approach", [branch, junction]], ["dead-end", [branch, deadEnd]]] as const) {
        topology.ways.push({ ...way, id: `osm-way-${id}`, externalId: `way/${id}`, nodeIds: nodes.map(node => node.id), coordinates: nodes.map(node => [node.lon, node.lat]) });
      }
    });
    expect(points.map(point => point.nodeId)).toEqual(["osm-node-3761092325","osm-node-3761092329"]);
  });

  it("retains an unmarked track/path interface", async () => {
    expect((await derive(top, topology => { topology.portalEvidence = []; })).points.map(point=>point.nodeId)).toEqual(["osm-node-3761092325"]);
  });

  it("does not traverse a pruned segment to find a track approach", async () => {
    expect((await derive(top, undefined, "osm-way-1356527414:0")).points).toEqual([]);
  });

  it("keeps a connected mapped approach without a distance exception", async () => {
    const { points } = await derive(top, topology => {
      const way = topology.ways.find(way => way.id === "osm-way-1356527414")!;
      const node = { ...topology.nodes[0]!, id: "detour", externalId: "node/detour", lon: -121.09, lat: 47.885 };
      topology.nodes.push(node);
      way.nodeIds.splice(1, 0, node.id);
      way.coordinates.splice(1, 0, [node.lon, node.lat]);
    });
    expect(points.map(point=>point.nodeId)).toEqual(["osm-node-3761092325","osm-node-3761092329"]);
  });
});

const direct=`n1 x-122 y48
n2 x-121.999 y48
n3 x-121.999 y48.001
n4 x-122.001 y48
w1 Thighway=path Nn1,n2,n3,n1
w2 Thighway=residential Nn4,n1`;
const service=direct.replace("n1 x", "n1 Thighway=trailhead x").replace("highway=residential","highway=service");
const parking=`n1 x-122 y48
n2 x-121.999 y48
n3 x-121.999 y48.001
n4 x-122.0001 y48
n5 x-122.0001 y48.00001
n6 x-122.001 y48
w1 Thighway=path Nn1,n2,n3,n1
w2 Thighway=residential Nn6,n4
w3 Tamenity=parking Nn4,n1,n5,n4`;
function addBuildings(store:ReturnType<typeof openProgressiveGraphStore>,count:number,lon=-122,lat=48) {
  for(let index=0;index<count;index++)store.putBuilding([lon+index*.000001,lat+.00001]);
}
function seedIds(store:ReturnType<typeof openProgressiveGraphStore>) {
  return store.database.prepare("SELECT node_id FROM sparse_start_nodes ORDER BY node_id").all().map(row=>String(row.node_id));
}

describe.each([false,true])("mapped entrance evidence (before elevation=%s)",early=>{
  const derive=(opl:string,adjust?:(topology:NormalizedTopology)=>void)=>deriveAtStage(opl,adjust,undefined,early);
  it("keeps an unmarked street entrance without borrowing nearby names, confidence or parking",async()=>{
    const unrelated=`n10 Thighway=trailhead,name=Unrelated%20%trailhead x-122.00001 y48
n11 Ttourism=information,name=Unrelated%20%sign x-122.00002 y48
n12 Tamenity=parking,name=Unrelated%20%parking x-122.00003 y48
n13 Tbarrier=gate,name=Unrelated%20%gate x-122.00004 y48`;
    const {points}=await derive(`${direct}\n${unrelated}`,topology=>{
      topology.portalEvidence!.forEach(item=>{item.sourceRefs=["unrelated-source"];});
    });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({nodeId:"osm-node-1",name:"Trailhead",confidence:"low",parkingEvidence:null,parkingDistanceM:null,portalRoadClass:"street"});
    expect(points[0]!.sourceRefs).not.toContain("unrelated-source");
  });

  it.each(["road","hiking"])("requires an actual %s contact on the parking feature",async contact=>{
    const opl=contact==="road"?parking.replace("Nn6,n4","Nn6,n7"):parking.replace("Nn4,n1,n5,n4","Nn4,n8,n5,n4");
    const {points}=await derive(`${opl}\nn7 x-122.00011 y48\nn8 x-122.00001 y48`);
    expect(points).toEqual([]);
  });

  it("admits the service/path interface without promoting an interior sign or detached gate",async()=>{
    const opl=direct.replace("highway=residential","highway=service").replace("n2 x","n2 Ttourism=information,name=Trail%20%sign x");
    expect((await derive(`${opl}\nn10 Tbarrier=gate x-122.00001 y48`)).points).toMatchObject([{nodeId:"osm-node-1",name:"Trailhead",confidence:"low"}]);
  });

  it("treats same-node signs as metadata at an independently proved interface",async()=>{
    const opl=direct.replace("highway=residential","highway=service");
    expect((await derive(opl.replace("n1 x","n1 Ttourism=information,name=Sign x"))).points).toMatchObject([{nodeId:"osm-node-1",name:"Sign"}]);
    expect((await derive(opl.replace("n1 x","n1 Tbarrier=gate,name=Mapped%20%entrance x"))).points).toMatchObject([
      {nodeId:"osm-node-1",name:"Mapped entrance",confidence:"medium",portalRoadClass:"service-road"},
    ]);
  });

  it.each(["tourism=information"])("ignores restricted %s evidence on an otherwise unmarked street entrance",async tag=>{
    const {points}=await derive(direct.replace("n1 x",`n1 T${tag},name=Restricted,foot=private x`));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({nodeId:"osm-node-1",name:"Trailhead",confidence:"low",parkingEvidence:null});
  });

  it("retains each independently usable parking exit",async()=>{
    const opl=`${parking.replace("Nn4,n1,n5,n4","Nn4,n1,n2,n5,n4")}\nn7 x-121.998 y48.001\nw4 Thighway=residential Nn7,n3`;
    const {points,originalEdges,edges}=await derive(opl);
    expect(points.map(point=>point.nodeId)).toEqual(["osm-node-1","osm-node-2","osm-node-3"]);
    expect(points[0]).toMatchObject({confidence:"medium",parkingEvidence:"portal-evidence:way/3",parkingDistanceM:0});
    expect(points[1]).toMatchObject({confidence:"medium",parkingEvidence:"portal-evidence:way/3",parkingDistanceM:0});
    expect(points[2]).toMatchObject({confidence:"low",parkingEvidence:null,parkingDistanceM:null});
    expect(edges).toEqual(originalEdges);
  });
});

describe.each([false,true])("connected entry proof (before elevation=%s)",early=>{
  const derive=(opl:string,adjust?:(topology:NormalizedTopology)=>void)=>deriveAtStage(opl,adjust,undefined,early);
  it("requires an outgoing foot segment, including both endpoint crossings",async()=>{
    const oneWay=direct.replace("highway=path","highway=path,foot=yes,oneway:foot=yes").replace("Nn1,n2,n3,n1","Nn2,n1");
    expect((await derive(oneWay)).points).toEqual([]);
    const barrier=direct.replace("highway=path","highway=path,foot=yes");
    for(const restrictedNode of ["osm-node-1","osm-node-2","osm-node-3"]) {
      const {points}=await derive(barrier,topology=>{
        // Restrict both possible first segments when the endpoint is not the start.
        for(const node of topology.nodes) if(node.id===restrictedNode || (restrictedNode!=="osm-node-1"&&["osm-node-2","osm-node-3"].includes(node.id)))
          node.flags.push("foot-access:private","barrier:gate");
      });
      expect(points).toEqual([]);
    }
  });

  it("keeps a bare gate traversable by its way permission and excludes a foot-private gate",async()=>{
    const opl=direct.replace("n1 x","n1 Tbarrier=gate x").replace("highway=path","highway=path,foot=yes");
    expect((await derive(opl)).points).toMatchObject([{nodeId:"osm-node-1",accessState:"public"}]);
    expect((await derive(opl,topology=>topology.nodes.find(node=>node.id==="osm-node-1")!.flags.push("foot-access:private"))).points).toEqual([]);
  });

  it("uses an affirmative motor arrival only without walking the prohibited arrival road",async()=>{
    const opl=direct.replace("highway=path","highway=path,foot=yes");
    const restrict=(topology:NormalizedTopology)=>{topology.ways.find(way=>way.edgeClass==="street")!.accessState="prohibited";};
    expect((await derive(opl,restrict)).points).toEqual([]);
    expect((await derive(opl,topology=>{
      restrict(topology);const road=topology.ways.find(way=>way.edgeClass==="street")!;road.flags=road.flags.filter(flag=>!flag.startsWith("motor-access:"));road.flags.push("motor-access:public");
    })).points).toMatchObject([{nodeId:"osm-node-1",accessState:"public",entryWitness:{known:true}}]);
  });

  it("interprets raw foot=no motorcar=yes as unused local arrival context",async()=>{
    const opl=direct.replace("highway=path","highway=path,foot=yes").replace("highway=residential","highway=service,foot=no,motorcar=yes");
    const {points}=await derive(opl);
    expect(points).toMatchObject([{nodeId:"osm-node-1",accessState:"public",entryWitness:{known:true}}]);
  });

  it("preserves asymmetric foot permissions without granting the restricted direction",async()=>{
    const backward=direct.replace("highway=path","highway=path,foot=yes,foot:forward=private,foot:backward=yes").replace("Nn1,n2,n3,n1","Nn1,n2");
    expect((await derive(backward)).points).toEqual([]);
    const forward=backward.replace("foot:forward=private,foot:backward=yes","foot:forward=yes,foot:backward=private");
    expect((await derive(forward)).points).toMatchObject([{nodeId:"osm-node-1",accessState:"public"}]);
    const unknown=backward.replace("foot:forward=private","foot:forward=unknown");
    expect((await derive(unknown)).points).toMatchObject([{nodeId:"osm-node-1",accessState:"unknown"}]);
    const allowedOverride=forward.replace("foot=yes,foot:forward=yes","foot=no,foot:forward=yes");
    expect((await derive(allowedOverride)).points).toMatchObject([{nodeId:"osm-node-1",accessState:"public"}]);
  });

  it("does not turn a mapped walking area perimeter into a hiking entry",async()=>{
    for(const highway of ["path","footway","pedestrian"]) {
      const opl=direct.replace("highway=path",`highway=${highway},area=yes,foot=yes`);
      expect((await derive(opl)).points).toEqual([]);
    }
  });

  it("excludes a source foot-private trailhead or gate at the proposed start",async()=>{
    for(const object of ["highway=trailhead","barrier=gate"]) {
      expect((await derive(direct.replace("n1 x",`n1 T${object},foot=private x`))).points).toEqual([]);
    }
  });

  it("uses a supported motor restriction frontier while keeping generic track gates as crossings",async()=>{
    const track=direct.replace("highway=path","highway=track,foot=yes").replace("highway=residential","highway=track,foot=yes");
    const generic=track.replace("n1 x","n1 Tbarrier=gate,foot=yes x");
    expect((await derive(generic)).points).toEqual([]);
    const {points}=await derive(generic.replace("barrier=gate,foot=yes","barrier=gate,foot=yes,motorcar=no"));
    expect(points).toMatchObject([{nodeId:"osm-node-1",accessState:"public",entryWitness:{kind:"interface",known:true}}]);
  });

  it("retains physical road roles when foot permission makes them routable",async()=>{
    const roads=direct.replace("highway=path","highway=residential,foot=yes").replace("highway=residential Nn4","highway=service,foot=yes Nn4");
    expect((await derive(roads)).points).toEqual([]);
    const track=direct.replace("highway=path","highway=track,foot=yes");
    expect((await derive(track)).points.map(point=>point.nodeId)).toEqual(["osm-node-1"]);
    expect((await derive(track.replace("highway=residential","highway=track"))).points).toEqual([]);
  });

  it("prefers a known usable departure over an unknown branch and ignores a private spur",async()=>{
    const {points}=await derive(`${direct}\nw11 Thighway=path,foot=yes Nn1,n2\nw12 Thighway=path,foot=private Nn1,n3`);
    expect(points).toMatchObject([{accessState:"public",entryWitness:{known:true,departurePhysicalId:"osm-way-11:0"}}]);
  });

  it("does not nominate every reachable sign or generic interior gate",async()=>{
    const opl=service.replace("n2 x","n2 Tbarrier=gate,name=Interior%20%gate x").replace("n3 x","n3 Ttourism=information,name=Interior%20%sign x");
    const {points}=await derive(opl);
    expect(points.map(point=>point.nodeId)).toEqual(["osm-node-1"]);
    expect(points[0]!.name).not.toBe("Interior gate");
  });

  it("requires a directed connected approach for a mapped trailhead",async()=>{
    const {points}=await derive(top,topology=>{
      const path=topology.ways.find(way=>way.flags.includes("osm-highway:path"))!;
      path.bidirectional=false;path.nodeIds.reverse();path.coordinates.reverse();
    });
    expect(points).toEqual([]);
  });

  it("keeps admission invariant under renaming, order and irrelevant off-network evidence",async()=>{
    const baseline=(await derive(top)).points.map(point=>[point.nodeId,point.accessState,point.entryWitness!.kind]);
    const {points}=await derive(`${top}\nn999 Ttourism=information,name=Irrelevant x-121.0771 y47.8813`,topology=>{
      topology.nodes.reverse();topology.ways.reverse();topology.portalEvidence!.reverse();
      topology.ways.forEach(way=>{way.name="Unrelated name";});
    });
    expect(points.map(point=>[point.nodeId,point.accessState,point.entryWitness!.kind])).toEqual(baseline);
  });
});

describe("sparse starts before elevation",()=>{
  it("proves a long connected asserted approach in one disk-backed traversal",async()=>{
    const count=6000;
    const lines=Array.from({length:count+1},(_,index)=>`n${index} ${index===count?"Thighway=trailhead ":""}x${-122+index*.00001} y48`);
    lines.push("n7000 x-122.001 y48",`w1 Thighway=path,foot=yes N${Array.from({length:count+1},(_,index)=>`n${index}`).join(",")}`,"w2 Thighway=residential Nn7000,n0");
    const {store}=staged(lines.join("\n"));
    try {
      let checks=0;
      expect(await prepareSparsePortalCandidates(store,coverage,async()=>{checks++;})).toEqual({candidateAccessPoints:2,eligibleAccessPoints:2});
      expect(seedIds(store)).toEqual(["osm-node-0","osm-node-6000"]);
      expect(checks).toBeGreaterThan(40);
      expect(store.database.prepare("PRAGMA temp_store").get()!.temp_store).toBe(1);
    } finally {store.close();}
  });

  it("skips inland reach without a trip-start assertion and all reach during frozen final refresh",async()=>{
    const {store,measure}=staged(parking);
    try {
      let sawDiscovery=false,sawInland=false;
      await prepareSparsePortalCandidates(store,coverage,async()=>{
        if(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='entry_approach'").get())sawDiscovery=true;
        if(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='entry_reach'").get())sawInland=true;
      });
      expect(sawDiscovery).toBe(true);expect(sawInland).toBe(false);
      const frozen=JSON.parse(String(store.database.prepare("SELECT record FROM sparse_portal_candidates").get()!.record)) as NormalizedAccessPoint;
      measure();
      let sawRefresh=false,sawReach=false;
      await store.derivePortals(coverage,async()=>{
        if(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='entry_links_from'").get())sawRefresh=true;
        if(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name IN ('entry_approach','entry_reach')").get())sawReach=true;
      });
      expect(sawRefresh).toBe(true);expect(sawReach).toBe(false);
      expect(JSON.parse(String(store.database.prepare("SELECT record FROM derived_portals").get()!.record))).toMatchObject(frozen);
    } finally {store.close();}
  });

  it("cleans a cancelled lazy asserted traversal and retries with identical directed starts",async()=>{
    const count=6000;
    const lines=Array.from({length:count+1},(_,index)=>`n${index} ${index===count?"Thighway=trailhead ":""}x${-122+index*.00001} y48`);
    lines.push("n7000 x-122.001 y48",`w1 Thighway=path,foot=yes N${Array.from({length:count+1},(_,index)=>`n${index}`).join(",")}`,"w2 Thighway=residential Nn7000,n0");
    const {store}=staged(lines.join("\n"));
    try {
      let visited=0;
      await expect(prepareSparsePortalCandidates(store,coverage,async()=>{
        if(!store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='entry_reach'").get())return;
        visited=Number(store.database.prepare("SELECT count(*) AS n FROM entry_reach").get()!.n);
        if(visited>1000)throw new Error("cancel asserted traversal");
      })).rejects.toThrow("cancel asserted traversal");
      expect(visited).toBeGreaterThan(1000);
      expect(store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([{name:"eligible_segments"}]);
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:2,eligibleAccessPoints:2});
      expect(seedIds(store)).toEqual(["osm-node-0","osm-node-6000"]);
    } finally {store.close();}
  });

  it("loads many directed links with quoted source IDs without source-wide JS collections",async()=>{
    const {store}=staged(direct,topology=>{
      const base=topology.ways[0]!;
      topology.ways.push({...base,id:'source:with:"quotes"',externalId:"way/quoted",accessState:"public",
        nodeIds:Array.from({length:3006},(_,index)=>base.nodeIds[1+index%2]!),
        coordinates:Array.from({length:3006},(_,index)=>base.coordinates[1+index%2]!)});
    });
    try {
      let directedCount=0;
      await prepareSparsePortalCandidates(store,coverage,async()=>{
        if(store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='entry_links_from'").get())
          directedCount=Number(store.database.prepare("SELECT count(*) AS n FROM entry_links WHERE physical_id LIKE 'source:%'").get()!.n);
      });
      expect(directedCount).toBe(6010);
      expect(seedIds(store)).toEqual(["osm-node-1"]);
    } finally {store.close();}
  });

  it("fails missing source ways without leaving temporary discovery state",async()=>{
    const {store}=staged(direct);
    try {
      store.database.prepare("INSERT INTO eligible_segments VALUES (?,?,?,?)").run("absent:123","osm-node-1","osm-node-2",1);
      await expect(prepareSparsePortalCandidates(store,coverage)).rejects.toThrow("Unknown source way for candidate segment: absent:123");
      expect(store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([{name:"eligible_segments"}]);
      store.database.exec("DELETE FROM eligible_segments WHERE id='absent:123'");
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:1});
    } finally {store.close();}
  });

  it("cancels during bounded link loading and retries cleanly",async()=>{
    const {store}=staged(direct,topology=>{
      const way=topology.ways[0]!,ids=way.nodeIds,coordinates=way.coordinates;
      way.nodeIds=Array.from({length:2006},(_,index)=>ids[index%3]!);
      way.coordinates=Array.from({length:2006},(_,index)=>coordinates[index%3]!);
    });
    try {
      let copiedRows=0;
      await expect(prepareSparsePortalCandidates(store,coverage,async()=>{
        const exists=store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='entry_links'").get();
        if(!exists)return;
        copiedRows=Number(store.database.prepare("SELECT count(*) AS n FROM entry_links").get()!.n);
        if(copiedRows)throw new Error("cancel link loading");
      })).rejects.toThrow("cancel link loading");
      expect(copiedRows).toBeGreaterThan(0);
      expect(copiedRows).toBeLessThanOrEqual(2000);
      expect(store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([{name:"eligible_segments"}]);
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:1});
    } finally {store.close();}
  });

  it.each([direct,service,parking,top,heather])("preserves the full final portal identity and ranking for every admission path",async opl=>{
    const early=await deriveAtStage(opl,undefined,undefined,true);
    const legacy=await deriveAtStage(opl);
    expect(early.points).toHaveLength(opl===top?2:1);
    expect(early.points).toEqual(legacy.points);
  });

  it.each([0,9,10,12])("records all %s nearby buildings without treating density as entry permission",async count=>{
    const {store}=staged(direct);
    try {
      addBuildings(store,count);
      // The descriptive count still uses its exact 500m radius.
      store.putBuilding([-122,48.01]);
      const eligible=1;
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:eligible});
      expect(seedIds(store)).toEqual(eligible?["osm-node-1"]:[]);
      expect(store.database.prepare("SELECT * FROM portal_candidate_audit").all()).toEqual([{node_id:"osm-node-1",nearby_building_count:count,access_state:"unknown"}]);
      expect(store.database.prepare("SELECT count(*) AS n FROM edges").get()!.n).toBe(0);
      expect([...store.iterateNodes()].every(node=>node.elevationM===null)).toBe(true);
      const tables=store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all().map(row=>row.name);
      expect(tables).toEqual(expect.arrayContaining(["sparse_start_nodes","sparse_portal_candidates","eligible_segments"]));
      expect(tables).not.toContain("portal_components");
      expect(tables).not.toContain("rank_known");
    } finally {store.close();}
  });

  it("freezes both dense and sparse entrances before selected graph measurement",async()=>{
    const other=direct.replaceAll(/n([1-4])/g,(_match,id)=>`n${Number(id)+10}`).replaceAll(/w([1-2])/g,(_match,id)=>`w${Number(id)+10}`)
      .replaceAll(/y48(?=\s|$)/gm,"y48.02").replaceAll("y48.001","y48.021");
    const {store,measure}=staged(`${direct}\n${other}`);
    try {
      addBuildings(store,10,-122,48.02);
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:2,eligibleAccessPoints:2});
      expect(seedIds(store)).toEqual(["osm-node-1","osm-node-11"]);
      expect(store.database.prepare("SELECT count(*) AS n FROM edges").get()!.n).toBe(0);
      // Mimic distance pruning: only the sparse start's component is measured.
      measure(id=>!id.startsWith("osm-way-11:"));
      await store.derivePortals(coverage);
      expect(store.database.prepare("SELECT node_id FROM derived_portals").all()).toEqual([{node_id:"osm-node-1"}]);
    } finally {store.close();}
  });

  it("freezes all parking exits and never discovers a new contact from expanded support",async()=>{
    const extra=`n11 x-121.9999 y48.0001\nn12 x-121.9989 y48.0001\nw11 Thighway=path Nn11,n12`;
    const {store,topology,measure}=staged(`${parking}\n${extra}`);
    try {
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:1});
      const place=topology.portalEvidence!.find(item=>item.kind==="parking")!,contact=topology.nodes.find(node=>node.id==="osm-node-11")!;
      place.nodeIds.push(contact.id);place.coordinates.push([contact.lon,contact.lat]);store.database.prepare("DELETE FROM evidence WHERE id=?").run(place.id);store.putPortalEvidence(place);
      measure();
      expect(await store.derivePortals(coverage)).toBe(1);
      expect(store.database.prepare("SELECT node_id FROM derived_portals").all()).toEqual([{node_id:"osm-node-1"}]);
      store.database.exec("DROP TABLE sparse_portal_candidates; DROP TABLE sparse_start_nodes");
      expect(await store.derivePortals(coverage)).toBe(2);
    } finally {store.close();}
  });

  it("includes unknown access without allowing an unused private spur to veto it",async()=>{
    for(const restricted of [false,true]) {
      const {store}=staged(direct,topology=>{
        if(restricted)topology.ways.push({...topology.ways[0]!,id:"restricted",externalId:"way/restricted",accessState:"private"});
      });
      try {
        expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:1});
        expect(seedIds(store)).toEqual(["osm-node-1"]);
        expect(store.database.prepare("SELECT access_state,nearby_building_count FROM portal_candidate_audit").get()).toEqual({access_state:"unknown",nearby_building_count:0});
      } finally {store.close();}
    }
  });

  it("does not let pruning distance estimates decide source connectivity",async()=>{
    const {store}=staged(top,topology=>{
      const sign=topology.nodes.find(node=>node.id==="osm-node-3761092329")!;
      sign.lat+=.003;
      const way=topology.ways.find(way=>way.id==="osm-way-1356527414")!;
      way.coordinates[1]=[sign.lon,sign.lat];
    });
    try {
      store.database.exec("UPDATE eligible_segments SET length_m=1");
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:2,eligibleAccessPoints:2});
    } finally {store.close();}
  });

  it("preserves the frozen access profile when later support adds a known alternative",async()=>{
    const {store,topology,measure}=staged(direct);
    try {
      await prepareSparsePortalCandidates(store,coverage);
      expect(JSON.parse(String(store.database.prepare("SELECT record FROM sparse_portal_candidates").get()!.record)).accessState).toBe("unknown");
      const known={...topology.ways[0]!,id:"new-known",externalId:"way/new-known",accessState:"public" as const};
      topology.ways.push(known);store.putWay(known);
      measure();
      await store.derivePortals(coverage);
      expect(JSON.parse(String(store.database.prepare("SELECT record FROM derived_portals").get()!.record))).toMatchObject({accessState:"unknown",entryWitness:{known:false,rootNodeId:"osm-node-1"}});
    } finally {store.close();}
  });

  it("refreshes only the departure at a frozen start when one branch is removed",async()=>{
    const {store,measure}=staged(`${direct}\nw11 Thighway=path Nn1,n2`);
    try {
      await prepareSparsePortalCandidates(store,coverage);
      measure(id=>!id.startsWith("osm-way-1:"));
      expect(await store.derivePortals(coverage)).toBe(1);
      expect(JSON.parse(String(store.database.prepare("SELECT record FROM derived_portals").get()!.record))).toMatchObject({nodeId:"osm-node-1",accessState:"unknown",entryWitness:{departurePhysicalId:"osm-way-11:0",rootNodeId:"osm-node-1"}});
    } finally {store.close();}
  });

  it("keeps real starts inside the requested start geometry",async()=>{
    const {store}=staged(direct);
    try {
      const elsewhere:AreaGeometry={type:"Polygon",coordinates:[[[-121.9,48],[-121.8,48],[-121.8,48.1],[-121.9,48.1],[-121.9,48]]]};
      expect(await prepareSparsePortalCandidates(store,elsewhere)).toEqual({candidateAccessPoints:0,eligibleAccessPoints:0});
      expect(seedIds(store)).toEqual([]);
    } finally {store.close();}
  });

  it("cleans partially discovered starts on cancellation and supports retry",async()=>{
    const {store}=staged(direct);
    try {
      let sawSeed=false;
      await expect(prepareSparsePortalCandidates(store,coverage,async()=>{
        const exists=store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='sparse_start_nodes'").get();
        if(exists&&seedIds(store).length){sawSeed=true;throw new Error("cancel sparse preparation");}
      })).rejects.toThrow("cancel sparse preparation");
      expect(sawSeed).toBe(true);
      expect(store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([{name:"eligible_segments"}]);
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:1});
      expect(seedIds(store)).toEqual(["osm-node-1"]);
    } finally {store.close();}
  });
});
