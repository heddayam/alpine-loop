import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { runCommand } from "@/lib/data/osm/command";
import { preparedNamedAreas } from "./named-areas";
import { rectangle } from "./geometry";

vi.mock("@/lib/data/osm/command", () => ({ runCommand: vi.fn() }));
vi.mock("@/lib/data/osm/source", () => ({ readOsmSourceConfig: async () => ({ id: "fixture" }) }));
vi.mock("@/lib/data/search-regions", async original => ({
  ...await original<typeof import("@/lib/data/search-regions")>(),
  readSearchRegionInput: async () => ({ version: 1, regions: [{ namedAreaId: "osm:relation/1", expectedName: "Fixture Park" }] }),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const source: SourceSnapshot = { id: "fixture", authority: "Fixture", dataset: "Offline areas", version: "1", retrievedAt: "2026-09-28T00:00:00Z", url: "https://example.invalid", license: "CC0", contentHash: `sha256:${"a".repeat(64)}`, localPath: "unused-fixture.osm.pbf" };
const geometry = rectangle([-123, 36, -121, 38]);
async function input() {
  const preparationRoot = await mkdtemp(path.join(tmpdir(), "network-named-areas-"));
  roots.push(preparationRoot);
  return { preparationRoot, geometry, sources: [source], snapshots: [source], regionIds: ["santa-cruz-mountains"] };
}

it("extracts reviewed areas once across network builds and removes temporary source files", async () => {
  const options = await input();
  vi.mocked(runCommand).mockImplementation(async (_command, args) => {
    const output = args[args.indexOf("--output") + 1]!;
    const data = args[0] === "export" ? JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", id: "r1", properties: { name: "Fixture Park", leisure: "park" }, geometry }] }) : "fixture";
    await writeFile(output, data);
    return { stdout: "", stderr: "" };
  });
  const first = await preparedNamedAreas(options);
  expect(first.namedAreas).toHaveLength(1);
  expect(runCommand).toHaveBeenCalledTimes(3);
  expect(await preparedNamedAreas(options)).toEqual(first);
  expect(runCommand).toHaveBeenCalledTimes(3);
  expect((await readdir(options.preparationRoot, { recursive: true })).some(file => file.endsWith(".osm.pbf"))).toBe(false);
});

it("removes a partial reviewed extract when the source command fails", async () => {
  const options = await input();
  vi.mocked(runCommand).mockImplementation(async (_command, args) => {
    await writeFile(args[args.indexOf("--output") + 1]!, "partial");
    throw new Error("source command failed");
  });
  await expect(preparedNamedAreas(options)).rejects.toThrow("source command failed");
  expect((await readdir(options.preparationRoot, { recursive: true })).some(file => file.endsWith(".osm.pbf"))).toBe(false);
});
