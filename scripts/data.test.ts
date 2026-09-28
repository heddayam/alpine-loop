import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDataCommand } from "./data";
import { buildLocalCoverage } from "@/lib/coverage/runtime";
import { readSourceRecipe } from "@/lib/coverage/recipe";
import { rectangle } from "@/lib/coverage/geometry";
import { inspectPreparedRelease } from "@/lib/data/prepared-release";
import { showBuildStatus } from "./data-status";

vi.mock("@/lib/coverage/runtime", () => ({buildLocalCoverage:vi.fn()}));
vi.mock("@/lib/coverage/recipe", () => ({readSourceRecipe:vi.fn()}));
vi.mock("@/lib/data/prepared-release", () => ({inspectPreparedRelease:vi.fn()}));
vi.mock("./data-status", async importOriginal => ({...await importOriginal<object>(), showBuildStatus:vi.fn()}));
let root: string;
const bbox = "-121.5,47.8,-121.4,47.9";
const recipe = {sources:[{geometry:rectangle([-125,45,-117,50])}],exclusions:[]} as unknown as Awaited<ReturnType<typeof readSourceRecipe>>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "local-data-cli-"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", root);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(readSourceRecipe).mockResolvedValue(recipe);
});
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); await rm(root, {recursive:true,force:true}); });

it.each([
  ["build", "recipe.json"],
  ["build", "catalog.json", "--network", "network-old"],
  ["build", "recipe.json", "--bbox", "1,2,3"],
  ["build", "recipe.json", "--bbox", "1,2,3,NaN"],
  ["build", "recipe.json", "--bbox", "3,2,1,4"],
  ["build", "recipe.json", "--bbox", "-181,2,3,4"],
  ["build", "recipe.json", "--bbox", "1,2,3,"],
  ["discover", "source.json"],
  ["networks", "catalog.json"],
  ["export", "old-options.json"],
  ["status", "--unexpected"],
])("rejects invalid or retired command %j before running work", async (...args) => {
  await expect(runDataCommand(args)).rejects.toThrow();
  expect(buildLocalCoverage).not.toHaveBeenCalled();
  expect(readSourceRecipe).not.toHaveBeenCalled();
});

it("passes the start area to preparation and removes signal listeners", async () => {
  const listeners = process.listenerCount("SIGINT");
  vi.mocked(buildLocalCoverage).mockImplementation(async (_recipe, starts, context) => {
    expect(starts).toEqual(rectangle([-121.5,47.8,-121.4,47.9]));
    await context.report({stage:"Preparing local trails",completedUnits:1});
    return {status:"completed",snapshot:null,completedUnits:1,units:[]};
  });
  await runDataCommand(["build", "recipe.json", "--bbox", bbox]);
  expect(process.listenerCount("SIGINT")).toBe(listeners);
  expect(JSON.parse(await readFile(path.join(root, "status.json"), "utf8"))).toMatchObject({status:"completed",completedUnits:1});
});

it("persists failed preparation status and removes listeners", async () => {
  const listeners = process.listenerCount("SIGTERM");
  vi.mocked(buildLocalCoverage).mockRejectedValue(new Error("Source unavailable"));
  await expect(runDataCommand(["build", "recipe.json", "--bbox", bbox])).rejects.toThrow("Source unavailable");
  expect(JSON.parse(await readFile(path.join(root, "status.json"), "utf8"))).toMatchObject({status:"failed",error:"Source unavailable"});
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});

it("plans the buffered extent without starting preparation or writing progress", async () => {
  await runDataCommand(["plan","source.json","--bbox",bbox]);
  expect(JSON.parse(vi.mocked(process.stdout.write).mock.calls[0]![0] as string)).toMatchObject({maximumRouteMiles:40,bufferMiles:25,downloadBytes:null});
  expect(buildLocalCoverage).not.toHaveBeenCalled();
  await expect(readFile(path.join(root,"status.json"))).rejects.toMatchObject({code:"ENOENT"});
});

it("retains published-file audits and status monitoring", async () => {
  await runDataCommand(["inspect","release.json"]);
  await runDataCommand(["status","--watch"]);
  expect(inspectPreparedRelease).toHaveBeenCalledWith("release.json");
  expect(showBuildStatus).toHaveBeenCalledWith(path.join(root,"status.json"),true);
});
