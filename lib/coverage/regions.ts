import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertValidAreaGeometry, type AreaGeometry } from "@/lib/data/area-geometry";
import { contentId, unionCoverage } from "./geometry";
import { readSourceRecipe } from "./recipe";
import type { CoverageRegion } from "./types";

const catalogPath = path.resolve("data/coverage/regions/catalog.json");
const provenanceSchema = z.object({
  authority:z.string().min(1), dataset:z.string().min(1), url:z.url(), license:z.string().min(1),
}).strict();
const regionIdSchema=z.string().regex(/^[a-z0-9-]+$/);
const catalogSchema = z.object({schemaVersion:z.literal(1),
  territories:z.array(z.object({id:regionIdSchema,geometryPath:z.string().min(1)}).strict())
    .refine(items=>new Set(items.map(item=>item.id)).size===items.length,"Territory IDs must be unique").default([]),
  regions:z.array(z.object({
  id:regionIdSchema, name:z.string().min(1), aliases:z.array(z.string()),
  replaces:z.array(regionIdSchema).min(1).refine(ids=>new Set(ids).size===ids.length,"Replacement IDs must be unique").optional(),
  recipePath:z.string(), boundaryPath:z.string().optional(), reviewedAt:z.iso.datetime(),
  territory:z.object({id:regionIdSchema,unitIds:z.array(z.string().min(1)).min(1)}).strict().optional(),
  boundarySource:provenanceSchema, approachSource:provenanceSchema,
  approachRadiusMeters:z.number().positive().max(1000),
  approaches:z.array(z.object({id:z.string().min(1),name:z.string().min(1),coordinates:z.tuple([z.number().min(-180).max(180),z.number().min(-90).max(90)]),radiusMeters:z.number().positive().max(1000).optional(),basis:z.string().min(1),url:z.url().nullable()}).strict())
    .refine(points=>new Set(points.map(point=>point.id)).size===points.length,"Approach IDs must be unique within an area"),
  limitations:z.array(z.string()),
}).strict().refine(region=>Boolean(region.boundaryPath||region.territory),"A region needs a boundary or assigned territory")
  .refine(region=>!region.replaces?.includes(region.id),"A region cannot replace itself")).refine(regions=>new Set(regions.map(region=>region.id)).size===regions.length,"Region IDs must be unique")}).strict();
const territorySchema=z.object({type:z.literal("FeatureCollection"),provenance:z.record(z.string(),z.unknown()),
  features:z.array(z.object({type:z.literal("Feature"),id:z.string().min(1),properties:z.record(z.string(),z.unknown()),geometry:z.unknown()}).strict()).min(1),
}).strict();
async function catalog() {
  const value=catalogSchema.parse(JSON.parse(await readFile(catalogPath,"utf8")));
  const territories=new Map<string,{provenance:Record<string,unknown>;units:Map<string,{feature:unknown;geometry:AreaGeometry}>}>();
  for(const entry of value.territories) {
    const source=territorySchema.parse(JSON.parse(await readFile(path.resolve(path.dirname(catalogPath),entry.geometryPath),"utf8")));
    const units=new Map<string,{feature:unknown;geometry:AreaGeometry}>();
    for(const feature of source.features) {
      if(units.has(feature.id)) throw new Error(`Duplicate territory unit: ${entry.id}/${feature.id}`);
      units.set(feature.id,{feature,geometry:assertValidAreaGeometry(feature.geometry,`${entry.id}/${feature.id}`)});
    }
    territories.set(entry.id,{provenance:source.provenance,units});
  }
  const assigned=new Set<string>();
  for(const region of value.regions) {
    if(!region.territory) continue;
    const territory=territories.get(region.territory.id);
    if(!territory) throw new Error(`Unknown territory: ${region.territory.id}`);
    for(const id of region.territory.unitIds) {
      const key=`${region.territory.id}/${id}`;
      if(!territory.units.has(id)) throw new Error(`Unknown territory unit: ${key}`);
      if(assigned.has(key)) throw new Error(`Territory unit assigned more than once: ${key}`);
      assigned.add(key);
    }
  }
  for(const [id,territory] of territories) for(const unitId of territory.units.keys())
    if(!assigned.has(`${id}/${unitId}`)) throw new Error(`Unassigned territory unit: ${id}/${unitId}`);
  return {...value,territories};
}

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
  const {regions,territories}=await catalog(),entry=regions.find(region=>region.id===id);
  if(!entry) throw new Error(`Unknown region: ${id}. Run data regions to list available names.`);
  const directory=path.dirname(catalogPath);
  const feature=entry.boundaryPath?JSON.parse(await readFile(path.resolve(directory,entry.boundaryPath),"utf8")):undefined;
  const territory=entry.territory?territories.get(entry.territory.id)!:undefined;
  const units=entry.territory?.unitIds.slice().sort().map(id=>territory!.units.get(id)!)??[];
  const geometry=unionCoverage([...(feature?[assertValidAreaGeometry(feature.geometry,entry.name)]:[]),...units.map(unit=>unit.geometry),
    ...entry.approaches.map(point=>neighborhood(point.coordinates,point.radiusMeters??entry.approachRadiusMeters))]);
  const recipe=await readSourceRecipe(path.resolve(directory,entry.recipePath));
  recipe.limitations=[...recipe.limitations,...entry.limitations];
  const provenance={version:entry.reviewedAt,retrievedAt:entry.reviewedAt};
  return {id:entry.id,name:entry.name,aliases:entry.aliases,geometry,recipe,...(entry.replaces?{replaces:entry.replaces}:{}),
    reviewedApproaches:entry.approaches.map(point=>({id:point.id,name:point.name,coordinates:point.coordinates,radiusMeters:point.radiusMeters??entry.approachRadiusMeters})),sources:[
    {...provenance,...entry.boundarySource,id:`region-boundary-${id}`,contentHash:`sha256:${contentId(territory?{boundary:feature,territory:{provenance:territory.provenance,features:units.map(unit=>unit.feature)}}:feature)}`},
    {...provenance,...entry.approachSource,id:`region-approaches-${id}`,contentHash:`sha256:${contentId({approaches:entry.approaches,radiusMeters:entry.approachRadiusMeters})}`},
  ]};
}
