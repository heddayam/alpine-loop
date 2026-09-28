import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDataCommand } from "./data";
import { discoverNetworks, buildNetworks } from "@/lib/coverage/runtime";
import { readSourceRecipe } from "@/lib/coverage/recipe";
import { readNetworkCatalog } from "@/lib/coverage/discovery-catalog";
import { writeNetworkPreview } from "./network-preview";
import { inspectPreparedRelease } from "@/lib/data/prepared-release";
import { showBuildStatus } from "./data-status";

vi.mock("@/lib/coverage/runtime", () => ({discoverNetworks:vi.fn(),buildNetworks:vi.fn()}));
vi.mock("@/lib/coverage/recipe", () => ({readSourceRecipe:vi.fn()}));
vi.mock("@/lib/coverage/discovery-catalog", () => ({readNetworkCatalog:vi.fn()}));
vi.mock("@/lib/data/prepared-release", () => ({inspectPreparedRelease:vi.fn()}));
vi.mock("./network-preview", () => ({writeNetworkPreview:vi.fn()}));
vi.mock("./data-status", () => ({showBuildStatus:vi.fn()}));
let root: string;
const id = `network-${"a".repeat(32)}`, other = `network-${"b".repeat(32)}`;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "network-cli-"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", root);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); await rm(root, {recursive:true,force:true}); });

it.each([
  ["build", "old-recipe.json"],
  ["build", "catalog.json", "--network"],
  ["build", "catalog.json", "--network", "pilchuck"],
  ["build", "catalog.json", "--network", id, "--network", id],
  ["build", "catalog.json", "--area", "cascades"],
  ["discover", "source.json", "--network", id],
  ["export", "old-options.json"],
  ["status", "--unexpected"],
])("rejects ambiguous or replaced command %j before running work", async (...args) => {
  await expect(runDataCommand(args)).rejects.toThrow();
  expect(buildNetworks).not.toHaveBeenCalled();
  expect(discoverNetworks).not.toHaveBeenCalled();
  expect(readSourceRecipe).not.toHaveBeenCalled();
});

it("passes only explicit IDs to preparation and removes signal listeners", async () => {
  const listeners = process.listenerCount("SIGINT");
  vi.mocked(buildNetworks).mockImplementation(async (_file, ids, context) => {
    expect(ids).toEqual([id, other]);
    await context.report({stage:"Preparing networks",completedUnits:1});
    return {status:"completed",snapshot:null,completedUnits:2,units:[]};
  });
  await runDataCommand(["build", "catalog.json", "--network", id, "--network", other]);
  expect(buildNetworks).toHaveBeenCalledWith("catalog.json", [id, other], expect.any(Object));
  expect(process.listenerCount("SIGINT")).toBe(listeners);
  expect(JSON.parse(await readFile(path.join(root, "status.json"), "utf8"))).toMatchObject({status:"completed",completedUnits:1});
});

it("persists a failed preparation status and leaves no signal listener", async () => {
  const listeners = process.listenerCount("SIGTERM");
  vi.mocked(buildNetworks).mockRejectedValue(new Error("Unknown network ID"));
  await expect(runDataCommand(["build", "catalog.json", "--network", id])).rejects.toThrow("Unknown network ID");
  expect(JSON.parse(await readFile(path.join(root, "status.json"), "utf8"))).toMatchObject({status:"failed",error:"Unknown network ID"});
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});

it("discovers source networks and produces the inspection report without preparing them", async () => {
  const recipe = {sources:[]} as unknown as Awaited<ReturnType<typeof readSourceRecipe>>;
  const catalog = {networks:[{id,cycleRank:1},{id:other,cycleRank:0}]} as Awaited<ReturnType<typeof readNetworkCatalog>>;
  vi.mocked(readSourceRecipe).mockResolvedValue(recipe);
  vi.mocked(discoverNetworks).mockResolvedValue({catalog,catalogPath:path.join(root,"catalog.json")});
  vi.mocked(writeNetworkPreview).mockResolvedValue(path.join(root,"networks.html"));
  await runDataCommand(["discover","source.json"]);
  expect(discoverNetworks).toHaveBeenCalledWith(recipe, expect.any(Object));
  expect(writeNetworkPreview).toHaveBeenCalledWith(catalog,path.join(root,"catalog.json"));
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("2 connected networks; 1 contain undirected cycles"));
  expect(buildNetworks).not.toHaveBeenCalled();
});

it("opens saved network metadata without rediscovery or preparation", async () => {
  const catalog = {networks:[]} as unknown as Awaited<ReturnType<typeof readNetworkCatalog>>;
  vi.mocked(readNetworkCatalog).mockResolvedValue(catalog);
  vi.mocked(writeNetworkPreview).mockResolvedValue(path.join(root,"networks.html"));
  await runDataCommand(["networks", "catalog.json"]);
  expect(readNetworkCatalog).toHaveBeenCalledWith("catalog.json");
  expect(discoverNetworks).not.toHaveBeenCalled();
  expect(buildNetworks).not.toHaveBeenCalled();
});

it("retains published-file audits and status monitoring", async () => {
  await runDataCommand(["inspect","release.json"]);
  await runDataCommand(["status","--watch"]);
  expect(inspectPreparedRelease).toHaveBeenCalledWith("release.json");
  expect(showBuildStatus).toHaveBeenCalledWith(path.join(root,"status.json"),true);
});
