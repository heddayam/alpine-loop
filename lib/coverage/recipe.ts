import { z } from "zod";
import { areaGeometrySchema } from "@/lib/contracts";
import { osmSourceConfigSchema } from "@/lib/data/osm/source";
import { contentId, unionCoverage } from "./geometry";

/** Developer-owned input, independent of the app's selectable download sections. */
export const sourceRecipeSchema=z.object({
  schemaVersion:z.literal(1),
  sources:z.array(z.object({config:osmSourceConfigSchema,geometry:areaGeometrySchema,sha256:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict()).min(1),
  exclusions:z.array(z.object({id:z.string().min(1),geometry:areaGeometrySchema}).strict()),
  /** Explicit product boundary (for example the US border), never an inferred source gap. */
  supportedArea:z.object({name:z.string().min(1),geometry:areaGeometrySchema}).strict().optional(),
  reviewedRegionIds:z.array(z.string().min(1)),
  memoryLimitMiB:z.number().int().min(512).max(65536).default(4096),
  offline:z.boolean().default(false),
  limitations:z.array(z.string()).default([]),
}).strict().transform((recipe, context) => {
  const sources = new Map<string, typeof recipe.sources[number]>();
  for (const source of recipe.sources) {
    const previous = sources.get(source.config.id);
    if (previous && (previous.sha256 !== source.sha256 || contentId(previous.config) !== contentId(source.config))) {
      context.addIssue({ code: "custom", message: `Conflicting source pins: ${source.config.id}` });
      return z.NEVER;
    }
    sources.set(source.config.id, previous ? { ...previous, geometry: unionCoverage([previous.geometry, source.geometry]) } : source);
  }
  return { ...recipe, sources: [...sources.values()].sort((a, b) => a.config.id.localeCompare(b.config.id)) };
});
export type SourceRecipe=z.infer<typeof sourceRecipeSchema>;
/** Resolve repository-relative source/config geometry references before strict validation. */
export async function readSourceRecipe(file:string):Promise<SourceRecipe> {
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
  const resolved:Record<string,unknown>={...input};
  if(Array.isArray(resolved.sources)) resolved.sources=await Promise.all(resolved.sources.map(async source=>{
    const {configPath,...rest}=source;
    if(configPath!==undefined && rest.config!==undefined) throw new Error("Provide config or configPath, not both");
    return geometry({...rest,...(typeof configPath==="string"?{config:await read(configPath)}:{})});
  }));
  if(Array.isArray(resolved.exclusions)) resolved.exclusions=await Promise.all(resolved.exclusions.map(geometry));
  if(resolved.supportedArea) resolved.supportedArea=await geometry(resolved.supportedArea as Record<string,unknown>);
  return sourceRecipeSchema.parse(resolved);
}
