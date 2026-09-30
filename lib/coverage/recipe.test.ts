import { expect,it } from "vitest";
import { sourceRecipeSchema, readSourceRecipe } from "./recipe";
it("pins Washington and its Oregon/Idaho buffer sources to the same upstream snapshot",async()=>{
  const recipe=await readSourceRecipe("data/coverage/recipes/washington.json");
  expect(Object.fromEntries(recipe.sources.map(source=>[source.config.id,source.sha256]))).toEqual({
    "geofabrik-washington-osm":"sha256:3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e",
    "geofabrik-oregon-osm":"sha256:777d9898e1cf0a80b73b2c503028fe0c15120f6547ae692cc48d6fae26b0847e",
    "geofabrik-idaho-osm":"sha256:6cb0ef33774b5580d618749b0b0a54d4f7a0b1bc0674e1df2bfa73024ea0f7b8",
  });
  expect(new Set(recipe.sources.map(source=>Date.parse(source.config.upstreamTimestamp))).size).toBe(1);
  expect(recipe.memoryLimitMiB).toBe(4096);expect(recipe.reviewedRegionIds.length).toBeGreaterThan(0);
});


it("merges identical source pins and rejects conflicting identities", async () => {
  const recipe = await readSourceRecipe("data/coverage/recipes/washington.json");
  const first = recipe.sources[0]!;
  const geometry = { type: "Polygon" as const, coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
  const parsed = sourceRecipeSchema.parse({ ...recipe, sources: [first, { ...first, geometry }] });
  expect(parsed.sources).toHaveLength(1);
  expect(parsed.sources[0]!.geometry.type).toBe("MultiPolygon");
  expect(sourceRecipeSchema.parse({ ...recipe, sources: [{ ...first, geometry }] }).sources).toHaveLength(1);
  expect(() => sourceRecipeSchema.parse({ ...recipe, sources: [first, { ...first, sha256: `sha256:${"0".repeat(64)}` }] })).toThrow("Conflicting source pins");
  expect(() => sourceRecipeSchema.parse({ ...recipe, sources: [first, { ...first, config: { ...first.config, expectedByteLength: first.config.expectedByteLength + 1 } }] })).toThrow("Conflicting source pins");
});

it("rejects the replaced geographic build selector", async () => {
  const recipe = await readSourceRecipe("data/coverage/recipes/washington.json");
  expect(() => sourceRecipeSchema.parse({...recipe, geometry: recipe.sources[0]!.geometry})).toThrow();
});
