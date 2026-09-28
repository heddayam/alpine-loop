import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDataCommand } from "./data";
import { buildCoverageRegion } from "@/lib/coverage/runtime";
import { listCoverageRegions, readCoverageRegion } from "@/lib/coverage/regions";
import { rectangle } from "@/lib/coverage/geometry";
import { inspectPreparedRelease } from "@/lib/data/prepared-release";
import { showBuildStatus } from "./data-status";

vi.mock("@/lib/coverage/runtime", () => ({buildCoverageRegion:vi.fn()}));
vi.mock("@/lib/coverage/regions", () => ({readCoverageRegion:vi.fn(),listCoverageRegions:vi.fn()}));
vi.mock("@/lib/data/prepared-release", () => ({inspectPreparedRelease:vi.fn()}));
vi.mock("./data-status", async importOriginal => ({...await importOriginal<object>(), showBuildStatus:vi.fn()}));
let root: string;
const region = {id:"glacier-peak",name:"Glacier Peak area",geometry:rectangle([-121.5,47.8,-121.4,47.9]), recipe:{sources:[{geometry:rectangle([-125,45,-117,50])}],exclusions:[],limitations:[]}} as unknown as Awaited<ReturnType<typeof readCoverageRegion>>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "local-data-cli-"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", root);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(readCoverageRegion).mockResolvedValue(region);
  vi.mocked(listCoverageRegions).mockResolvedValue([{id:region.id,name:region.name}]);
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
  expect(buildCoverageRegion).not.toHaveBeenCalled();
  expect(readCoverageRegion).not.toHaveBeenCalled();
});

it("passes the start area to preparation and removes signal listeners", async () => {
  const listeners = process.listenerCount("SIGINT");
  vi.mocked(buildCoverageRegion).mockImplementation(async (selected, context) => {
    expect(selected).toEqual(region);
    await context.report({stage:"Preparing local trails",completedUnits:1,counts:{sourceEdges:100,retainedEdges:20},peakMeasuredMemoryBytes:1048576,peakCgroupMemoryBytes:2097152,peakDiskBytes:3145728});
    await context.report({counts:{metricCacheHits:12},peakMeasuredMemoryBytes:1,peakDiskBytes:null});
    return {status:"completed",snapshot:null,completedUnits:1,units:[]};
  });
  await runDataCommand(["build", "glacier-peak"]);
  expect(process.listenerCount("SIGINT")).toBe(listeners);
  expect(JSON.parse(await readFile(path.join(root, "status.json"), "utf8"))).toMatchObject({status:"completed",completedUnits:1, counts:{sourceEdges:100,retainedEdges:20,metricCacheHits:12},peakMeasuredMemoryBytes:1048576,peakCgroupMemoryBytes:2097152,peakDiskBytes:3145728});
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Completed Glacier Peak area in"));
});

it("persists failed preparation status and removes listeners", async () => {
  const listeners = process.listenerCount("SIGTERM");
  vi.mocked(buildCoverageRegion).mockRejectedValue(new Error("Source unavailable"));
  await expect(runDataCommand(["build", "glacier-peak"])).rejects.toThrow("Source unavailable");
  expect(JSON.parse(await readFile(path.join(root, "status.json"), "utf8"))).toMatchObject({status:"failed",error:"Source unavailable"});
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});

it("plans the buffered extent without starting preparation or writing progress", async () => {
  await runDataCommand(["plan","glacier-peak"]);
  expect(JSON.parse(vi.mocked(process.stdout.write).mock.calls[0]![0] as string)).toMatchObject({id:region.id,name:region.name,maximumRouteMiles:40,bufferMiles:25,downloadBytes:null});
  expect(buildCoverageRegion).not.toHaveBeenCalled();
  await expect(readFile(path.join(root,"status.json"))).rejects.toMatchObject({code:"ENOENT"});
});

it("retains published-file audits and status monitoring", async () => {
  await runDataCommand(["inspect","release.json"]);
  await runDataCommand(["status","--watch"]);
  expect(inspectPreparedRelease).toHaveBeenCalledWith("release.json");
  expect(showBuildStatus).toHaveBeenCalledWith(path.join(root,"status.json"),true);
});

it("lists region names without source preparation", async () => {
  await runDataCommand(["regions"]);
  expect(process.stdout.write).toHaveBeenCalledWith("glacier-peak\tGlacier Peak area\n");
  expect(readCoverageRegion).not.toHaveBeenCalled();
  expect(buildCoverageRegion).not.toHaveBeenCalled();
});
it("does not report a paused build as completed", async () => {
  vi.mocked(buildCoverageRegion).mockResolvedValue({status:"paused",snapshot:null,completedUnits:0,units:[]});
  await runDataCommand(["build","glacier-peak"]);
  expect(JSON.parse(await readFile(path.join(root,"status.json"),"utf8")).status).toBe("paused");
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Paused Glacier Peak area"));
});
