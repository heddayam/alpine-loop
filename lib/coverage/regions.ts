import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentId, intersectCoverage, unionCoverage } from "./geometry";
import { entranceNeighborhood } from "./plan";
import { readSourceRecipe } from "./recipe";
import type { CoverageRegion } from "./types";
import { areaGeometrySchema } from "@/lib/contracts/routes";
import { packSourceSchema } from "@/lib/contracts/manifest";

const catalogPath = path.resolve("data/coverage/regions/catalog.json");
const rangesPath = path.resolve("data/coverage/mountain-ranges.geojson");
const provenanceSchema = z.object({
  authority:z.string().min(1), dataset:z.string().min(1), url:z.url(), license:z.string().min(1),
}).strict();
const rangeIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const catalogSchema = z.object({schemaVersion:z.literal(1),startLimitPath:z.string().min(1),regions:z.array(z.object({
  id:z.string().regex(/^[a-z0-9-]+$/), name:z.string().min(1), aliases:z.array(z.string()),
  rangeIds:z.array(rangeIdSchema).min(1).refine(ids=>new Set(ids).size===ids.length,"Range IDs must be unique"),
  recipePath:z.string(), startLimitPath:z.string().min(1).optional(), reviewedAt:z.iso.datetime(),
  boundarySource:provenanceSchema, approachSource:provenanceSchema,
  approachRadiusMeters:z.number().positive().max(1000),
  approaches:z.array(z.object({id:z.string().min(1),name:z.string().min(1),coordinates:z.tuple([z.number().min(-180).max(180),z.number().min(-90).max(90)]),radiusMeters:z.number().positive().max(1000).optional(),basis:z.string().min(1),url:z.url().nullable()}).strict())
    .refine(points=>new Set(points.map(point=>point.id)).size===points.length,"Approach IDs must be unique within an area"),
  limitations:z.array(z.string()),
}).strict())
  .refine(regions=>new Set(regions.map(region=>region.id)).size===regions.length,"Region IDs must be unique")}).strict();
const rangesSchema = z.object({
  type:z.literal("FeatureCollection"), properties:z.object({source:packSourceSchema.omit({contentHash:true})}).passthrough(),
  features:z.array(z.object({type:z.literal("Feature"),properties:z.object({
    id:rangeIdSchema,name:z.string().min(1),ancestry:z.array(rangeIdSchema).min(1),
  }).strict().refine(value=>value.ancestry.at(-1)===value.id,"Ancestry must end at the leaf ID"),geometry:areaGeometrySchema}).strict()).min(1)
    .refine(features=>new Set(features.map(feature=>feature.properties.id)).size===features.length,"Duplicate mountain range"),
}).strict();
async function catalog() { return catalogSchema.parse(JSON.parse(await readFile(catalogPath,"utf8"))); }

export async function listCoverageRegions():Promise<Array<{id:string;name:string}>> {
  return (await catalog()).regions.map(({id,name})=>({id,name}));
}

/** One pinned range dataset supplies every core; approach anchors are audit evidence. */
export async function readCoverageRegion(id:string):Promise<CoverageRegion> {
  const entries=await catalog(),entry=entries.regions.find(region=>region.id===id);
  if(!entry) throw new Error(`Unknown region: ${id}. Run data regions to list available names.`);
  const directory=path.dirname(catalogPath);
  const [rangeInput,capInput,recipe]=await Promise.all([
    readFile(rangesPath,"utf8"),
    readFile(path.resolve(directory,entry.startLimitPath??entries.startLimitPath),"utf8"),
    readSourceRecipe(path.resolve(directory,entry.recipePath)),
  ]);
  // These pinned geometries were checked with GEOS during authoring. Structural
  // parsing avoids repeating a quadratic pairwise ring-intersection check.
  const ranges=rangesSchema.parse(JSON.parse(rangeInput)),byId=new Map(ranges.features.map(feature=>[feature.properties.id,feature]));
  const selected=entry.rangeIds.map(rangeId=>{
    const feature=byId.get(rangeId);
    if(!feature)throw new Error(`Unknown Standard mountain range ${rangeId} in ${id}`);
    return feature.geometry;
  });
  const capFeature=JSON.parse(capInput),cap=areaGeometrySchema.parse(capFeature.geometry);
  const coreLimit=recipe.supportedArea?intersectCoverage(cap,recipe.supportedArea.geometry):cap;
  if(!coreLimit)throw new Error(`No core scope remains for ${id}`);
  // A per-region legacy cap retains its reviewed registration neighborhoods.
  // The shared territory cap already includes the historical product scope.
  let startLimitGeometry=entry.startLimitPath
    ? unionCoverage([cap,...entry.approaches.map(point=>entranceNeighborhood(point.coordinates,point.radiusMeters??entry.approachRadiusMeters))])
    : cap;
  if(recipe.supportedArea) {
    const supported=intersectCoverage(startLimitGeometry,recipe.supportedArea.geometry);
    if(!supported)throw new Error(`No start scope remains for ${id}`);
    startLimitGeometry=supported;
  }
  const core=unionCoverage(selected);
  const geometry=intersectCoverage(core,coreLimit);
  if(!geometry)throw new Error(`No Standard mountain core remains for ${id}`);
  recipe.limitations=[...recipe.limitations,...entry.limitations];
  const provenance={version:entry.reviewedAt,retrievedAt:entry.reviewedAt};
  return {id:entry.id,name:entry.name,aliases:entry.aliases,geometry,startLimitGeometry,recipe,
    reviewedApproaches:entry.approaches.map(point=>({id:point.id,name:point.name,coordinates:point.coordinates,radiusMeters:point.radiusMeters??entry.approachRadiusMeters})),sources:[
    {...ranges.properties.source,contentHash:`sha256:${contentId(ranges)}`},
    {...provenance,...entry.boundarySource,id:`region-boundary-${id}`,contentHash:`sha256:${contentId({rangeIds:entry.rangeIds,cap:capFeature})}`},
    {...provenance,...entry.approachSource,id:`region-approaches-${id}`,contentHash:`sha256:${contentId({approaches:entry.approaches,radiusMeters:entry.approachRadiusMeters})}`},
  ]};
}
