import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyOsmWay, needsTrailContext } from "@/lib/data/osm/normalize";
import { rectangle, unionCoverage } from "./geometry";
import { filteredSourceLines } from "./source-filter";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const fixture = path.resolve("data/fixtures/osm/filter-first.opl");
const directories: string[] = [];
async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), "source-filter-test-"));
  directories.push(directory);
  return directory;
}
async function collect(lines: AsyncIterable<string>) { const result: string[] = []; for await (const line of lines) result.push(line); return result; }
const ids = (lines: string[]) => lines.map((line) => line.split(" ")[0]);
afterEach(async () => {
  vi.mocked(spawn).mockClear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Native integration is offline and optional where developer Osmium tooling is absent.
describe.skipIf(spawnSync("osmium", ["--version"]).status !== 0)("native source filtering", () => {
  it("preserves all trail classes, ambiguous links, direction/access tags and referenced nodes", async () => {
    const directory = await root();
    const lines = await collect(filteredSourceLines(fixture, directory, { kind: "trails" }, async () => {}));
    expect(ids(lines)).toEqual([...Array.from({ length: 12 }, (_, i) => `n${i + 1}`), ...Array.from({ length: 11 }, (_, i) => `w${i + 1}`)]);
    expect(lines.find((line) => line.startsWith("w1 "))).toContain("oneway:foot=-1,foot=private");
    expect(lines[0]).toContain("highway=trailhead,name=Start");
    const highways = ["path", "bridleway", "steps", "track", "footway", "pedestrian", "service", "unclassified", "residential", "living_street"];
    const command = vi.mocked(spawn).mock.calls[0]![1] as string[];
    for (const highway of highways) {
      const tags = { highway, foot: "yes", surface: "dirt" };
      expect(classifyOsmWay(tags) === "trail" || needsTrailContext(tags)).toBe(true);
      expect(command.find((arg) => arg.startsWith("w/highway="))!.split(/[=,]/).slice(1)).toContain(highway);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("loads nearby evidence and completes building outer fragments outside the context envelope", async () => {
    const directory = await root();
    const lines = await collect(filteredSourceLines(fixture, directory, { kind: "context", geometry: rectangle([0, 0, .005, .005]) }, async () => {}));
    expect(ids(lines)).toEqual(expect.arrayContaining(["n20", "n21", "n22", "n23", "n32", "n33", "w12", "w20", "w21", "r1"]));
    for (const absent of ["n40", "w30", "w31", "r2"]) expect(ids(lines)).not.toContain(absent);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps disconnected component envelopes separate instead of filling their geographic gap", async () => {
    const lines = await collect(filteredSourceLines(fixture, await root(), { kind: "context", geometry: unionCoverage([
      rectangle([-.005, -.005, .005, .005]), rectangle([3, 3, 3.01, 3.01]),
    ]) }, async () => {}));
    expect(ids(lines)).toContain("r1");
    expect(ids(lines)).not.toContain("w31");
  });

  it("makes the native node-selection limit explicit for context-only crossing roads", async () => {
    const lines = await collect(filteredSourceLines(fixture, await root(), { kind: "context", geometry: rectangle([0, 0, .005, .005]) }, async () => {}));
    expect(ids(lines)).not.toContain("w40");
  });

  it("cleans extraction staging on a native command failure", async () => {
    const directory = await root();
    await expect(collect(filteredSourceLines("/missing-source.osm.pbf", directory, { kind: "trails" }, async () => {}))).rejects.toThrow("osmium tags-filter failed");
    expect(await readdir(directory)).toEqual([]);
  });
});

function pendingChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => {
    queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGKILL"); });
    return true;
  });
  vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ChildProcess);
  return child;
}
describe("filter process lifetime", () => {
  it("kills and awaits a scan when its periodic checkpoint cancels, then removes staging", async () => {
    const directory = await root(), child = pendingChild();
    let checks = 0;
    await expect(collect(filteredSourceLines(fixture, directory, { kind: "trails" }, async () => {
      if (++checks === 2) throw new Error("cancelled scan");
    }))).rejects.toThrow("cancelled scan");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await readdir(directory)).toEqual([]);
  });

  it("kills its child and cleans up when the importer breaks early", async () => {
    const directory = await root(), child = pendingChild();
    const lines = filteredSourceLines(fixture, directory, { kind: "trails" }, async () => {});
    const first = lines.next();
    child.stdout.write("n1 T x0 y0\n");
    expect((await first).value).toBe("n1 T x0 y0");
    await lines.return(undefined);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await readdir(directory)).toEqual([]);
  });

  it("bounds native error output", async () => {
    const directory = await root(), child = pendingChild();
    const result = collect(filteredSourceLines(fixture, directory, { kind: "trails" }, async () => {}));
    // Wait until asynchronous directory setup has installed the child listeners.
    await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
    child.stderr.write("x".repeat(20_000));
    child.stdout.end();
    child.emit("close", 1, null);
    const error = await result.catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(8300);
    expect(await readdir(directory)).toEqual([]);
  });
});
