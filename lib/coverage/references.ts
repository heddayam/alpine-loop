import type { StatementSync } from "node:sqlite";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { areaGeometryBounds, type AreaGeometry } from "@/lib/data/area-geometry";
import { distanceMeters } from "@/lib/data/metrics";
import { readUsgsNationalDigitalTrails } from "@/lib/data/official-trails/usgs";
import type { OfficialTrailSourceConfig } from "@/lib/data/official-trails/source";
import type { Coordinate } from "@/lib/data/types";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import type { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";

export type ReferenceGap = {
  externalId: string;
  name: string | null;
  reason: "no-nearby-osm-trail" | "outside-official-source-envelope" | "mixed";
  coveredLengthM: number;
  unrepresentedLengthM: number;
  unsupportedLengthM: number;
};
export type OfficialReferenceAudit = {
  schemaVersion: 1;
  method: "sampled-proximity-v1";
  status: "audited" | "partial-source" | "source-unsupported";
  sourceId: string | null;
  sourceHash: string | null;
  unsupportedReason: string | null;
  sourceFeatureCount: number;
  eligibleFeatureCount: number;
  coveredFeatureCount: number;
  representedFeatureCount: number;
  /** Fully installed features and features with any pending sampled length partition coveredFeatureCount. */
  installedFeatureCount: number;
  pendingFeatureCount: number;
  installedLengthM: number;
  pendingLengthM: number;
  ineligibleReasons: Record<string, number>;
  unresolved: ReferenceGap[];
  limitation: string;
};
export type OfficialReferenceOptions = {
  osm: CoverageSourceStore;
  /** Intended collection/request extent, independent of installation progress. */
  coverage: AreaGeometry;
  /** Current installed union; null means nothing installed. Omission retains the previous whole-coverage behavior. */
  installedCoverage?: AreaGeometry | null;
  officialSnapshot?: SourceSnapshot;
  /** The spatial query envelope baked into the pinned official source request. */
  sourceEnvelope?: readonly [minLon:number,minLat:number,maxLon:number,maxLat:number];
  representedDistanceM?: number;
  sampleStepM?: number;
  checkpoint?: () => Promise<void>;
};

/** The pinned USGS query is an envelope; outside it the source offers no omission evidence. */
export function officialSourceEnvelope(config:OfficialTrailSourceConfig):readonly [number,number,number,number] {
  const url=new URL(config.url),geometry=url.searchParams.get("geometry")?.split(",").map(Number);
  if(url.searchParams.get("geometryType")!=="esriGeometryEnvelope"||url.searchParams.get("inSR")!=="4326"||!geometry||geometry.length!==4||geometry.some((value)=>!Number.isFinite(value))||
    geometry[0]!>=geometry[2]!||geometry[1]!>=geometry[3]!)throw new Error(`Official source ${config.id} lacks a valid query envelope`);
  return geometry as [number,number,number,number];
}

const LIMITATION="Sampled spatial proximity is reference evidence only; it does not prove source identity, legal access, or a connected hiking route.";
function box(lon:number,lat:number,radius:number):[number,number,number,number] {
  const dy=radius/111_000,dx=radius/(111_000*Math.max(0.05,Math.cos(lat*Math.PI/180)));
  return [lon-dx,lon+dx,lat-dy,lat+dy];
}
function distanceToSegment(point:Coordinate,a:Coordinate,b:Coordinate):number {
  const x=111_320*Math.cos(point[1]*Math.PI/180),y=110_540;
  const ax=(a[0]-point[0])*x,ay=(a[1]-point[1])*y,bx=(b[0]-point[0])*x,by=(b[1]-point[1])*y;
  const dx=bx-ax,dy=by-ay,denominator=dx*dx+dy*dy;
  const t=denominator===0?0:Math.max(0,Math.min(1,-(ax*dx+ay*dy)/denominator));
  return Math.hypot(ax+t*dx,ay+t*dy);
}
async function represented(query:StatementSync,point:Coordinate,radius:number,tick:()=>boolean,checkpoint:()=>Promise<void>):Promise<boolean> {
  const [minLon,maxLon,minLat,maxLat]=box(point[0],point[1],radius);
  for(const row of query.iterate(minLon,maxLon,minLat,maxLat) as Iterable<{ax:number;ay:number;bx:number;by:number}>){
    if(tick())await checkpoint();
    if(distanceToSegment(point,[row.ax,row.ay],[row.bx,row.by])<=radius)return true;
  }
  return false;
}
async function buildOsmIndex(osm:CoverageSourceStore,coverage:AreaGeometry,tick:()=>boolean,checkpoint:()=>Promise<void>):Promise<void> {
  const db=osm.db;
  db.exec(`DROP TABLE IF EXISTS temp.reference_spatial; DROP TABLE IF EXISTS temp.reference_segments;
    CREATE TEMP TABLE reference_segments(id INTEGER PRIMARY KEY,ax REAL NOT NULL,ay REAL NOT NULL,bx REAL NOT NULL,by REAL NOT NULL) STRICT;
    CREATE VIRTUAL TABLE temp.reference_spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);`);
  const insert=db.prepare("INSERT INTO reference_segments(ax,ay,bx,by) VALUES (?,?,?,?)");
  const spatial=db.prepare("INSERT INTO reference_spatial VALUES (?,?,?,?,?)");
  for(const {way} of osm.ways(coverage,0.01)) {
    if(tick())await checkpoint();
    if(way.edgeClass!=="trail")continue;
    for(let index=1;index<way.coordinates.length;index++){
      if(tick())await checkpoint();
      const a=way.coordinates[index-1]!,b=way.coordinates[index]!;
      const id=Number(insert.run(a[0],a[1],b[0],b[1]).lastInsertRowid);
      spatial.run(id,Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));
    }
  }
}

/** Independent source comparison; never inserts official geometry into the route graph. */
export async function auditOfficialTrailReferences(options:OfficialReferenceOptions):Promise<OfficialReferenceAudit> {
  const checkpoint=options.checkpoint??(async()=>{});
  await checkpoint();
  let steps=0;
  const tick=()=>++steps%1000===0;
  const empty:OfficialReferenceAudit={schemaVersion:1,method:"sampled-proximity-v1",status:"source-unsupported",sourceId:null,sourceHash:null,unsupportedReason:"no-pinned-official-trail-source",
    sourceFeatureCount:0,eligibleFeatureCount:0,coveredFeatureCount:0,representedFeatureCount:0,installedFeatureCount:0,pendingFeatureCount:0,installedLengthM:0,pendingLengthM:0,ineligibleReasons:{},unresolved:[],limitation:LIMITATION};
  if(!options.officialSnapshot)return empty;
  const radius=options.representedDistanceM??100,step=options.sampleStepM??20;
  if(!Number.isFinite(radius)||radius<=0||!Number.isFinite(step)||step<=0)throw new Error("Invalid official-reference sampling distances");
  const features=await readUsgsNationalDigitalTrails(options.officialSnapshot);
  const db=options.osm.db;
  try {
    await buildOsmIndex(options.osm,options.sourceEnvelope?rectangle(options.sourceEnvelope):options.coverage,tick,checkpoint);
    const near=db.prepare(`SELECT p.ax,p.ay,p.bx,p.by FROM reference_spatial s JOIN reference_segments p ON p.id=s.id
      WHERE s.max_lon>=? AND s.min_lon<=? AND s.max_lat>=? AND s.min_lat<=?`);
    const unresolved:ReferenceGap[]=[],ineligibleReasons:Record<string,number>={};
    const envelope=options.sourceEnvelope;
    const coverageBounds=areaGeometryBounds(options.coverage);
    const installedCoverage=options.installedCoverage === undefined ? options.coverage : options.installedCoverage;
    let installedFeatureCount=0,pendingFeatureCount=0,installedLengthM=0,pendingLengthM=0;
    let coveredFeatureCount=0,representedFeatureCount=0,eligibleFeatureCount=0,
      hasUnsupported=!envelope||coverageBounds[0]<envelope[0]||coverageBounds[1]<envelope[1]||coverageBounds[2]>envelope[2]||coverageBounds[3]>envelope[3];
    for(const feature of features){
      if(tick())await checkpoint();
      if(!feature.eligible){const reason=feature.eligibilityReason??"ineligible";ineligibleReasons[reason]=(ineligibleReasons[reason]??0)+1;continue;}
      eligibleFeatureCount++;
      let coveredLengthM=0,unrepresentedLengthM=0,unsupportedLengthM=0,featureInstalledLengthM=0,featurePendingLengthM=0;
      for(let segment=1;segment<feature.coordinates.length;segment++){
        if(tick())await checkpoint();
        const a=feature.coordinates[segment-1]!,b=feature.coordinates[segment]!,length=distanceMeters(a,b);
        if(length===0)continue;
        const samples=Math.ceil(length/step),weight=length/samples;
        for(let index=0;index<samples;index++){
          if(tick())await checkpoint();
          const fraction=(index+0.5)/samples,point:[number,number]=[a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction];
          if(!coordinateIsInsideArea(point,options.coverage))continue;
          coveredLengthM+=weight;
          if(installedCoverage&&coordinateIsInsideArea(point,installedCoverage))featureInstalledLengthM+=weight;
          else featurePendingLengthM+=weight;
          if(envelope&&(point[0]<envelope[0]||point[0]>envelope[2]||point[1]<envelope[1]||point[1]>envelope[3])){unsupportedLengthM+=weight;hasUnsupported=true;continue;}
          if(!await represented(near,point,radius,tick,checkpoint))unrepresentedLengthM+=weight;
        }
      }
      if(coveredLengthM===0)continue;
      coveredFeatureCount++;
      installedLengthM+=featureInstalledLengthM;
      pendingLengthM+=featurePendingLengthM;
      if(featurePendingLengthM>0)pendingFeatureCount++;
      else installedFeatureCount++;
      if(unrepresentedLengthM===0&&unsupportedLengthM===0){representedFeatureCount++;continue;}
      unresolved.push({externalId:feature.externalId,name:feature.name,reason:unrepresentedLengthM&&unsupportedLengthM?"mixed":unsupportedLengthM?"outside-official-source-envelope":"no-nearby-osm-trail",
        coveredLengthM,unrepresentedLengthM,unsupportedLengthM});
    }
    return {schemaVersion:1,method:"sampled-proximity-v1",status:hasUnsupported?"partial-source":"audited",sourceId:options.officialSnapshot.id,sourceHash:options.officialSnapshot.contentHash,
      unsupportedReason:hasUnsupported?(envelope?"coverage-outside-official-source-envelope":"official-source-envelope-not-supplied"):null,
      sourceFeatureCount:features.length,eligibleFeatureCount,coveredFeatureCount,representedFeatureCount,installedFeatureCount,pendingFeatureCount,installedLengthM,pendingLengthM,ineligibleReasons,unresolved:unresolved.sort((a,b)=>a.externalId.localeCompare(b.externalId)),limitation:LIMITATION};
  } finally {db.exec("DROP TABLE IF EXISTS temp.reference_spatial; DROP TABLE IF EXISTS temp.reference_segments;");}
}
