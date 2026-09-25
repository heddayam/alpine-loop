import { expect,it } from "vitest";
import { readBuildRecipe } from "./recipe";
it.each(["cascades","olympic"])("keeps the %s developer recipe explicitly pinned",async name=>{
  const recipe=await readBuildRecipe(`data/coverage/recipes/${name}.json`);
  expect(recipe.sources[0]!.sha256).toBe("sha256:3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e");
  expect(recipe.memoryLimitMiB).toBe(4096);expect(recipe.reviewedRegionIds.length).toBeGreaterThan(0);
});
