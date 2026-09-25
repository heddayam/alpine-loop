import { z } from "zod";
import { areaGeometrySchema } from "@/lib/contracts";
import { osmSourceConfigSchema } from "@/lib/data/osm/source";
import { contentId, intersectCoverage } from "./geometry";
import { planCoverageGeometry } from "./collections";
import { run } from "./runtime";
import type { CoverageRunnerContext } from "./types";

/** Developer-owned input, independent of the app's selectable download sections. */
export const buildRecipeSchema=z.object({
  schemaVersion:z.literal(1),
  geometry:areaGeometrySchema,
  sources:z.array(z.object({config:osmSourceConfigSchema,geometry:areaGeometrySchema,sha256:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict()).min(1),
  exclusions:z.array(z.object({id:z.string().min(1),geometry:areaGeometrySchema}).strict()),
  reviewedRegionIds:z.array(z.string().min(1)),
  memoryLimitMiB:z.number().int().min(512).max(65536).default(4096),
  offline:z.boolean().default(false),
  limitations:z.array(z.string()).default([]),
}).strict().superRefine((recipe,context)=>{
  if(new Set(recipe.sources.map(source=>source.config.id)).size!==recipe.sources.length) context.addIssue({code:"custom",message:"Source identities must be unique"});
  if(recipe.sources.some(source=>!intersectCoverage(recipe.geometry,source.geometry))) context.addIssue({code:"custom",message:"Every source must intersect intended coverage"});
});
export type BuildRecipe=z.infer<typeof buildRecipeSchema>;
export async function buildRelease(input:BuildRecipe,context:CoverageRunnerContext) {
  const recipe=buildRecipeSchema.parse(input);
  const partition=planCoverageGeometry(recipe.geometry,recipe.sources,recipe.exclusions);
  if(!partition.supported) throw new Error("No intended coverage is supported by recipe sources");
  return run({id:contentId(recipe),request:{collectionIds:[],geometry:recipe.geometry,memoryLimitMiB:recipe.memoryLimitMiB,offline:recipe.offline},geometry:recipe.geometry,
    units:partition.units,sourceIds:recipe.sources.map(source=>source.config.id),estimates:{downloadBytes:null,temporaryBytes:null,reusableBytes:0},warnings:recipe.limitations},context,recipe);
}

/** Resolve repository-relative source/config geometry references before strict validation. */
export async function readBuildRecipe(file:string):Promise<BuildRecipe> {
  const {readFile}=await import("node:fs/promises");
  const path=await import("node:path");
  const input=JSON.parse(await readFile(file,"utf8"));
  const read=async(reference:string)=>JSON.parse(await readFile(path.resolve(path.dirname(file),reference),"utf8"));
  const geometry=async(value:Record<string,unknown>):Promise<Record<string,unknown>>=>{
    const {geometryPath,...rest}=value;
    if(typeof geometryPath!=="string") return value;
    if(value.geometry!==undefined) throw new Error("Provide geometry or geometryPath, not both");
    const data=await read(geometryPath);return {...rest,geometry:data.type==="Feature"?data.geometry:data};
  };
  const resolved=await geometry(input);
  if(Array.isArray(resolved.sources)) resolved.sources=await Promise.all(resolved.sources.map(async source=>{
    const {configPath,...rest}=source;
    if(configPath!==undefined && rest.config!==undefined) throw new Error("Provide config or configPath, not both");
    return geometry({...rest,...(typeof configPath==="string"?{config:await read(configPath)}:{})});
  }));
  if(Array.isArray(resolved.exclusions)) resolved.exclusions=await Promise.all(resolved.exclusions.map(geometry));
  return buildRecipeSchema.parse(resolved);
}
