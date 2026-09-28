import { expect,it } from "vitest";
import { sourceRecipeSchema, readSourceRecipe } from "./recipe";
it("keeps the Washington source recipe explicitly pinned",async()=>{
  const recipe=await readSourceRecipe("data/coverage/recipes/washington.json");
  expect(recipe.sources[0]!.sha256).toBe("sha256:3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e");
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
