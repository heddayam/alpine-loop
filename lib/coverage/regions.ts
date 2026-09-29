import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { areaGeometryBounds, assertValidAreaGeometry, type AreaGeometry } from "@/lib/data/area-geometry";
import { contentId, unionCoverage } from "./geometry";
import { readSourceRecipe } from "./recipe";
import { routingEnvelope } from "./plan";
import type { CoverageRegion } from "./types";

const catalogPath = path.resolve("data/coverage/regions/catalog.json");
const catalogSchema = z.object({schemaVersion:z.literal(1),regions:z.array(z.object({
  id:z.string().regex(/^[a-z0-9-]+$/), name:z.string().min(1), aliases:z.array(z.string()),
  recipePath:z.string(), boundaryPath:z.string(), reviewedAt:z.iso.datetime(),
  approachSourceUrl:z.url(), approachRadiusMeters:z.number().positive().max(1000),
  approaches:z.array(z.object({id:z.string(),name:z.string(),coordinates:z.tuple([z.number(),z.number()]),radiusMeters:z.number().positive().max(1000).optional(),basis:z.string(),url:z.url().nullable()}).strict()).min(1),
  limitations:z.array(z.string()),
}).strict())}).strict();
async function catalog() { return catalogSchema.parse(JSON.parse(await readFile(catalogPath,"utf8"))); }

export async function listCoverageRegions():Promise<Array<{id:string;name:string}>> {
  return (await catalog()).regions.map(({id,name})=>({id,name}));
}

/** A small registration neighborhood, not an invented trail or access point. */
function neighborhood([lon,lat]:[number,number],meters:number):AreaGeometry {
  const ring:[number,number][]=[];
  const angle=meters/6371008.8,phi=lat*Math.PI/180,lambda=lon*Math.PI/180;
  for(let i=0;i<32;i++) {
    const bearing=2*Math.PI*i/32;
    const y=Math.asin(Math.sin(phi)*Math.cos(angle)+Math.cos(phi)*Math.sin(angle)*Math.cos(bearing));
    const x=lambda+Math.atan2(Math.sin(bearing)*Math.sin(angle)*Math.cos(phi),Math.cos(angle)-Math.sin(phi)*Math.sin(y));
    ring.push([x*180/Math.PI,y*180/Math.PI]);
  }
  ring.push(ring[0]!);
  return {type:"Polygon",coordinates:[ring]};
}

/** Every build input is pinned locally; listing/planning never contacts a provider. */
export async function readCoverageRegion(id:string):Promise<CoverageRegion> {
  const entry=(await catalog()).regions.find(region=>region.id===id);
  if(!entry) throw new Error(`Unknown region: ${id}. Run data regions to list available names.`);
  const directory=path.dirname(catalogPath);
  const feature=JSON.parse(await readFile(path.resolve(directory,entry.boundaryPath),"utf8"));
  const boundary=assertValidAreaGeometry(feature.geometry,entry.name);
  const geometry=unionCoverage([boundary,...entry.approaches.map(point=>neighborhood(point.coordinates,point.radiusMeters??entry.approachRadiusMeters))]);
  const recipe=await readSourceRecipe(path.resolve(directory,entry.recipePath));
  recipe.limitations=[...recipe.limitations,...entry.limitations];
  // The pinned international line is only reviewed for mainland Washington.
  // Fail explicitly instead of treating its polygon-closing extensions as borders.
  const extent=areaGeometryBounds(routingEnvelope(geometry));
  if(extent[0]<-123.09069954599994 || extent[2]>-117.02523197753003) throw new Error("Region extends beyond the reviewed Washington mainland border; review its support boundary first");
  const provenance={authority:"USDA Forest Service",version:entry.reviewedAt,retrievedAt:entry.reviewedAt,license:"US federal government public-domain geographic data; boundary and recreation metadata retained with attribution"};
  return {id:entry.id,name:entry.name,aliases:entry.aliases,geometry,recipe,
    reviewedApproaches:entry.approaches.map(point=>({id:point.id,name:point.name,coordinates:point.coordinates,radiusMeters:point.radiusMeters??entry.approachRadiusMeters})),sources:[
    {...provenance,id:`region-boundary-${id}`,dataset:"USFS Wilderness boundary; generalized trailhead-selection footprint",url:feature.properties.sourceUrl,contentHash:`sha256:${contentId(feature)}`},
    {...provenance,id:`region-approaches-${id}`,dataset:"Reviewed USFS recreation-site approaches",url:entry.approachSourceUrl,contentHash:`sha256:${contentId({approaches:entry.approaches,radiusMeters:entry.approachRadiusMeters})}`},
  ]};
}
