import { expect,it } from "vitest";
import { buildRecipeSchema, readBuildRecipe } from "./recipe";
it.each(["cascades","olympic"])("keeps the %s developer recipe explicitly pinned",async name=>{
  const recipe=await readBuildRecipe(`data/coverage/recipes/${name}.json`);
  expect(recipe.sources[0]!.sha256).toBe("sha256:3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e");
  expect(recipe.memoryLimitMiB).toBe(4096);expect(recipe.reviewedRegionIds.length).toBeGreaterThan(0);
});


it("accepts explicit sources outside the request and merges identical duplicate pins", async () => {
  const recipe = await readBuildRecipe("data/coverage/recipes/cascades.json");
  const first = recipe.sources[0]!;
  const geometry = { type: "Polygon" as const, coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
  const parsed = buildRecipeSchema.parse({ ...recipe, sources: [first, { ...first, geometry }] });
  expect(parsed.sources).toHaveLength(1);
  expect(parsed.sources[0]!.geometry.type).toBe("MultiPolygon");
  expect(buildRecipeSchema.parse({ ...recipe, sources: [{ ...first, geometry }] }).sources).toHaveLength(1);
  expect(() => buildRecipeSchema.parse({ ...recipe, sources: [first, { ...first, sha256: `sha256:${"0".repeat(64)}` }] })).toThrow("Conflicting source pins");
  expect(() => buildRecipeSchema.parse({ ...recipe, sources: [first, { ...first, config: { ...first.config, expectedByteLength: first.config.expectedByteLength + 1 } }] })).toThrow("Conflicting source pins");
});
