import { describe, expect, it } from "vitest";
import type { AreaGeometry } from "../area-geometry";
import { compiledEdgesForSegment } from "../compiled-edges";
import { distanceMeters } from "../metrics";
import { normalizeOsmOpl } from "../osm/opl";
import type { NormalizedAccessPoint, NormalizedTopology } from "../types";
import { openProgressiveGraphStore } from "./store";
import { prepareSparsePortalCandidates } from "./portals";
import { MAXIMUM_NEARBY_BUILDINGS } from "../wilderness";

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
        elevationProfile:[{distanceMeters:0,elevationMeters:0},{distanceMeters:lengthM,elevationMeters:0}]}).forEach(edge=>store.putEdge(edge));
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
    ["osm-node-4",0,0,0,0,"trail-component:osm-node-1"],
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
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ nodeId: "osm-node-3761092329", name: "Top Lake Trailhead", accessState: "public", confidence: "high", portalRoadClass: "service-road" });
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

  it.each(["track", "path", "evidence"] as const)("does not add a mapped trailhead through restricted %s", async kind => {
    const { points } = await derive(top, topology => {
      if (kind === "evidence") topology.portalEvidence![0]!.accessState = "private";
      else topology.ways.find(way => way.flags.includes(`osm-highway:${kind}`))!.accessState = "prohibited";
    });
    expect(points).toEqual([]);
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
    expect(points.map(point => point.nodeId)).toEqual(["osm-node-3761092329"]);
  });

  it("finds the bounded approach through a branch regardless of way grouping or discovery order", async () => {
    const { points } = await derive(top, topology => {
      const way = topology.ways.find(way => way.id === "osm-way-1356527414")!;
      const junction = topology.nodes.find(node => node.id === "osm-node-3761092325")!;
      const sign = topology.nodes.find(node => node.id === "osm-node-3761092329")!;
      const branch = { ...sign, id: "branch", externalId: "node/branch", lon: -121.07714, lat: 47.88148 };
      const detour = { ...sign, id: "detour", externalId: "node/detour", lon: -121.079, lat: 47.8822 };
      const deadEnd = { ...sign, id: "dead-end", externalId: "node/dead-end", lon: -121.0772, lat: 47.8819 };
      topology.nodes.push(branch, detour, deadEnd);
      // First source way takes a >250m detour; another branch reaches the same
      // track contact within250m, and a third branch has no track contact.
      way.nodeIds = [sign.id, detour.id, junction.id];
      way.coordinates = [[sign.lon, sign.lat], [detour.lon, detour.lat], [junction.lon, junction.lat]];
      for (const [id, nodes] of [["branch", [sign, branch]], ["approach", [branch, junction]], ["dead-end", [branch, deadEnd]]] as const) {
        topology.ways.push({ ...way, id: `osm-way-${id}`, externalId: `way/${id}`, nodeIds: nodes.map(node => node.id), coordinates: nodes.map(node => [node.lon, node.lat]) });
      }
    });
    expect(points.map(point => point.nodeId)).toEqual(["osm-node-3761092329"]);
  });

  it("does not promote an unmarked track/path junction", async () => {
    expect((await derive(top, topology => { topology.portalEvidence = []; })).points).toEqual([]);
  });

  it("does not traverse a pruned segment to find a track approach", async () => {
    expect((await derive(top, undefined, "osm-way-1356527414:0")).points).toEqual([]);
  });

  it("bounds the approach along the mapped path rather than straight-line distance", async () => {
    const { points } = await derive(top, topology => {
      const way = topology.ways.find(way => way.id === "osm-way-1356527414")!;
      const node = { ...topology.nodes[0]!, id: "detour", externalId: "node/detour", lon: -121.09, lat: 47.885 };
      topology.nodes.push(node);
      way.nodeIds.splice(1, 0, node.id);
      way.coordinates.splice(1, 0, [node.lon, node.lat]);
    });
    expect(points).toEqual([]);
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

  it("does not admit a service junction using a nearby gate or information along the trail",async()=>{
    const opl=direct.replace("highway=residential","highway=service").replace("n2 x","n2 Ttourism=information,name=Trail%20%sign x");
    expect((await derive(`${opl}\nn10 Tbarrier=gate x-122.00001 y48`)).points).toEqual([]);
  });

  it("requires entrance evidence at the service junction itself",async()=>{
    const opl=direct.replace("highway=residential","highway=service");
    expect((await derive(opl.replace("n1 x","n1 Ttourism=information,name=Sign x"))).points).toEqual([]);
    expect((await derive(opl.replace("n1 x","n1 Tbarrier=gate,name=Mapped%20%entrance x"))).points).toMatchObject([
      {nodeId:"osm-node-1",name:"Mapped entrance",confidence:"medium",portalRoadClass:"service-road"},
    ]);
  });

  it.each(["highway=trailhead","tourism=information","barrier=gate"])("ignores restricted %s evidence on an otherwise unmarked street entrance",async tag=>{
    const {points}=await derive(direct.replace("n1 x",`n1 T${tag},name=Restricted,foot=private x`));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({nodeId:"osm-node-1",name:"Trailhead",confidence:"low",parkingEvidence:null});
  });

  it("associates a multi-contact parking lot only with its one nomination",async()=>{
    const opl=`${parking.replace("Nn4,n1,n5,n4","Nn4,n1,n2,n5,n4")}\nn7 x-121.998 y48.001\nw4 Thighway=residential Nn7,n3`;
    const {points,originalEdges,edges}=await derive(opl);
    expect(points.map(point=>point.nodeId)).toEqual(["osm-node-1","osm-node-3"]);
    expect(points[0]).toMatchObject({confidence:"medium",parkingEvidence:"portal-evidence:way/3",parkingDistanceM:0});
    expect(points[1]).toMatchObject({confidence:"low",parkingEvidence:null,parkingDistanceM:null});
    expect(edges).toEqual(originalEdges);
  });
});

describe("sparse starts before elevation",()=>{
  it.each([direct,service,parking,top,heather])("preserves the full final portal identity and ranking for every admission path",async opl=>{
    const early=await deriveAtStage(opl,undefined,undefined,true);
    const legacy=await deriveAtStage(opl);
    expect(early.points).toHaveLength(1);
    expect(early.points).toEqual(legacy.points);
  });

  it.each([0,9,10,12])("applies the shared 500 m threshold to %s nearby buildings before metrics",async count=>{
    const {store}=staged(direct);
    try {
      addBuildings(store,count);
      // A building outside the radius must never change threshold admission.
      store.putBuilding([-122,48.01]);
      expect(MAXIMUM_NEARBY_BUILDINGS).toBe(10);
      const eligible=count<10?1:0;
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

  it("seeds the sparse component without measuring disconnected dense trails",async()=>{
    const other=direct.replaceAll(/n([1-4])/g,(_match,id)=>`n${Number(id)+10}`).replaceAll(/w([1-2])/g,(_match,id)=>`w${Number(id)+10}`)
      .replaceAll(/y48(?=\s|$)/gm,"y48.02").replaceAll("y48.001","y48.021");
    const {store,measure}=staged(`${direct}\n${other}`);
    try {
      addBuildings(store,10,-122,48.02);
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:2,eligibleAccessPoints:1});
      expect(seedIds(store)).toEqual(["osm-node-1"]);
      expect(store.database.prepare("SELECT count(*) AS n FROM edges").get()!.n).toBe(0);
      // Mimic distance pruning: only the sparse start's component is measured.
      measure(id=>!id.startsWith("osm-way-11:"));
      await store.derivePortals(coverage);
      expect(store.database.prepare("SELECT node_id FROM derived_portals").all()).toEqual([{node_id:"osm-node-1"}]);
    } finally {store.close();}
  });

  it("freezes a parking nomination before graph removal rather than selecting another contact",async()=>{
    const extra=`n11 x-121.9999 y48.0001
n12 x-121.9989 y48.0001
w11 Thighway=path Nn11,n12`;
    const {store,measure}=staged(`${parking}\n${extra}`,topology=>{
      const parking=topology.portalEvidence!.find(item=>item.kind==="parking")!,contact=topology.nodes.find(node=>node.id==="osm-node-11")!;
      parking.nodeIds.push(contact.id);parking.coordinates.push([contact.lon,contact.lat]);
    });
    try {
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:1});
      expect(seedIds(store)).toEqual(["osm-node-1"]);
      measure(id=>!id.startsWith("osm-way-1:"));
      expect(await store.derivePortals(coverage)).toBe(0);
      expect(store.database.prepare("SELECT * FROM derived_portals").all()).toEqual([]);
      // Rediscovery can nominate its other actual feature contact, but never a nearby path.
      store.database.exec("DROP TABLE sparse_portal_candidates; DROP TABLE sparse_start_nodes");
      expect(await store.derivePortals(coverage)).toBe(1);
      expect(store.database.prepare("SELECT node_id FROM derived_portals").get()!.node_id).toBe("osm-node-11");
    } finally {store.close();}
  });

  it("includes unknown access but rejects a restricted incident trail",async()=>{
    for(const restricted of [false,true]) {
      const {store}=staged(direct,topology=>{
        if(restricted)topology.ways.push({...topology.ways[0]!,id:"restricted",externalId:"way/restricted",accessState:"private"});
      });
      try {
        expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:1,eligibleAccessPoints:restricted?0:1});
        expect(seedIds(store)).toEqual(restricted?[]:["osm-node-1"]);
        expect(store.database.prepare("SELECT access_state,nearby_building_count FROM portal_candidate_audit").get()).toEqual({access_state:restricted?"private":"unknown",nearby_building_count:0});
      } finally {store.close();}
    }
  });

  it("does not mistake the pruning distance lower bound for a short track approach",async()=>{
    const {store}=staged(top,topology=>{
      const sign=topology.nodes.find(node=>node.id==="osm-node-3761092329")!;
      sign.lat+=.003;
      const way=topology.ways.find(way=>way.id==="osm-way-1356527414")!;
      way.coordinates[1]=[sign.lon,sign.lat];
    });
    try {
      store.database.exec("UPDATE eligible_segments SET length_m=1");
      expect(await prepareSparsePortalCandidates(store,coverage)).toEqual({candidateAccessPoints:0,eligibleAccessPoints:0});
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
