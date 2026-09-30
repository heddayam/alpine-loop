import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rectangle, unionCoverage } from "./geometry";
import { filteredSourceLines } from "./source-filter";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";

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
    const lines = await collect(filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {}));
    expect(ids(lines)).toEqual(expect.arrayContaining([...Array.from({ length: 13 }, (_, i) => `n${i + 1}`), ...Array.from({ length: 12 }, (_, i) => `w${i + 1}`)]));
    expect(ids(lines)).not.toContain("w32");
    expect(ids(lines)).toEqual(expect.arrayContaining(["n60", "n61", "n62", "w41"]));
    expect(lines.find(line => line.startsWith("w41 "))).toContain("Nn60,n61,n62");
    expect(lines.find((line) => line.startsWith("w1 "))).toContain("oneway:foot=-1,foot=private");
    expect(lines[0]).toContain("highway=trailhead,name=Start");
    const commands = vi.mocked(spawn).mock.calls.map(([, args]) => args as string[]);
    expect(commands.map(args => args[0])).toEqual(["extract", "cat", "getparents", "tags-filter", "cat", "getid", "merge"]);
    expect(commands[0]).toEqual(expect.arrayContaining(["extract", fixture, "--strategy", "simple"]));
    expect(commands[2]).toEqual(expect.arrayContaining(["getparents", fixture, "--id-osm-file", "--add-self"]));
    expect(commands[3]).toEqual(expect.arrayContaining(["tags-filter", "--omit-referenced"]));
    expect(commands[4]).toEqual(expect.arrayContaining(["cat", "--object-type", "way"]));
    expect(commands[4]).not.toContain("relation");
    expect(commands[5]).toEqual(expect.arrayContaining(["getid", fixture, "--id-osm-file", "--add-referenced"]));
    expect(new Set(ids(lines)).size).toBe(lines.length);
    expect(await readdir(directory)).toEqual([]);
  });

  it("loads nearby evidence without completing unrelated building members", async () => {
    const directory = await root();
    let checkedSeeds = false;
    const lines = await collect(filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {}, async stage => {
      if (stage !== "Completing selected trail and context references") return;
      const entries = await readdir(directory);
      expect(entries).toHaveLength(1);
      const files = await readdir(path.join(directory, entries[0]!));
      expect(files).toEqual(expect.arrayContaining(["seeds.osm.pbf", "reference-seeds.osm.opl"]));
      for (const consumed of ["partial.osm.pbf", "parents.osm.pbf", "context.osm.pbf"]) expect(files).not.toContain(consumed);
      checkedSeeds = true;
    }));
    expect(checkedSeeds).toBe(true);
    expect(ids(lines)).toEqual(expect.arrayContaining(["n20", "n21", "n23", "w12"]));
    for (const absent of ["n22", "n32", "n33", "n40", "n41", "w20", "w21", "w22", "w23", "w24", "w30", "w31", "r1", "r2"]) expect(ids(lines)).not.toContain(absent);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps disconnected component envelopes separate instead of filling their geographic gap", async () => {
    const lines = await collect(filteredSourceLines(fixture, await root(), unionCoverage([
      rectangle([-.005, -.005, .005, .005]), rectangle([3, 3, 3.01, 3.01]),
    ]), async () => {}));
    expect(ids(lines)).toContain("w41");
    expect(ids(lines)).not.toContain("w31");
  });

  it("makes the native node-selection limit explicit for context-only crossing roads", async () => {
    const lines = await collect(filteredSourceLines(fixture, await root(), rectangle([0, 0, .005, .005]), async () => {}));
    expect(ids(lines)).not.toContain("w40");
  });

  it("returns no objects without invoking getid when the local selection is empty", async () => {
    const directory = await root();
    expect(await collect(filteredSourceLines(fixture, directory, rectangle([5, 5, 5.005, 5.005]), async () => {}))).toEqual([]);
    expect(vi.mocked(spawn).mock.calls.map(([, args]) => args?.[0])).toEqual(["extract", "cat"]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("returns no objects when the geographic selection has no eligible tags", async () => {
    const directory = await root(), source = path.join(directory, "unrelated.osm.opl"), staging = path.join(directory, "staging");
    await writeFile(source, "n1 Tnatural=tree x0.001 y0.001\n");
    expect(await collect(filteredSourceLines(source, staging, rectangle([0, 0, .005, .005]), async () => {}))).toEqual([]);
    expect(vi.mocked(spawn).mock.calls.map(([, args]) => args?.[0])).not.toContain("getid");
    expect(await readdir(staging)).toEqual([]);
  });

  it("preserves standalone evidence nodes when no way or relation needs completion", async () => {
    const directory = await root(), source = path.join(directory, "nodes.osm.opl"), staging = path.join(directory, "staging");
    await writeFile(source, "n1 Thighway=trailhead,name=Start x0.001 y0.001\nn2 Tamenity=parking x0.002 y0.002\n");
    const lines = await collect(filteredSourceLines(source, staging, rectangle([0, 0, .005, .005]), async () => {}));
    expect(ids(lines)).toEqual(["n1", "n2"]);
    expect(vi.mocked(spawn).mock.calls.map(([, args]) => args?.[0])).not.toContain("getid");
    expect(await readdir(staging)).toEqual([]);
  });

  it("ignores building-only objects and retains independently tagged places and walking geometry unchanged", async () => {
    const directory=await root(),source=path.join(directory,"buildings.osm.opl"),staging=path.join(directory,"staging");
    await writeFile(source,[
      "n1 Tbuilding=hut x0.001 y0.001", "n2 Tbuilding=yes,amenity=parking x0.002 y0.002",
      "n3 Tbuilding=yes,barrier=gate,foot=no x0.003 y0.003", "n4 T x0.1 y0.1",
      "w1 Tbuilding=yes Nn1,n4,n1", "w2 Tbuilding=yes,highway=path,foot=yes Nn2,n4",
      "w3 Tbuilding=roof,amenity=parking Nn2,n3", "r1 Ttype=multipolygon,building=yes Mw1@outer",
    ].join("\n"));
    const output=await collect(filteredSourceLines(source,staging,rectangle([0,0,.005,.005]),async()=>{}));
    expect(ids(output)).toEqual(["n2","n3","n4","w2","w3"]);
    expect(output.find(line=>line.startsWith("n2 "))).toContain("building=yes,amenity=parking");
    expect(output.find(line=>line.startsWith("n3 "))).toContain("building=yes,barrier=gate,foot=no");
    expect(output.find(line=>line.startsWith("w2 "))).toContain("building=yes,highway=path,foot=yes Nn2,n4");
    expect(output.find(line=>line.startsWith("w3 "))).toContain("building=roof,amenity=parking Nn2,n3");
    expect(await readdir(staging)).toEqual([]);
  });

  it("retains standalone barriers and access facts as well as attached passage tags", async () => {
    const directory = await root(), source = path.join(directory, "passages.osm.opl"), staging = path.join(directory, "staging");
    await writeFile(source, [
      "n1 Tbarrier=bollard,foot=no x0.001 y0.001", "n2 Taccess=private x0.002 y0.002",
      "n3 Tmotorcar=no x0.003 y0.003", "n4 Tfoot:conditional=no%20%@%20%(winter) x0.004 y0.004",
      "n5 Tbarrier=stile,foot=yes x0.004 y0.004", "n6 T x0.1 y0.1",
      "w1 Thighway=path,foot=yes Nn5,n6",
    ].join("\n"));
    const output = await collect(filteredSourceLines(source, staging, rectangle([0, 0, .005, .005]), async () => {}));
    expect(ids(output)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "w1"]);
    expect(output.find(line => line.startsWith("n5 "))).toContain("barrier=stile,foot=yes");
    expect(await readdir(staging)).toEqual([]);
  });

  it("fails closed and removes staging when a selected way references a missing source node", async () => {
    const directory = await root(), source = path.join(directory, "missing-node.osm.opl"), staging = path.join(directory, "staging");
    await writeFile(source, "n1 T x0.001 y0.001\nw1 Thighway=path Nn1,n2\n");
    await expect(collect(filteredSourceLines(source, staging, rectangle([0, 0, .005, .005]), async () => {}))).rejects.toThrow("osmium getid failed");
    expect(await readdir(staging)).toEqual([]);
  });

  it("cleans extraction staging on a native command failure", async () => {
    const directory = await root();
    await expect(collect(filteredSourceLines("/missing-source.osm.pbf", directory, rectangle([0, 0, .005, .005]), async () => {}))).rejects.toThrow("osmium extract failed");
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
async function finishChild(child: ReturnType<typeof pendingChild>, code = 0) {
  await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
  const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
  if (code === 0 && args[0] === "cat" && args.includes("--output")) await writeFile(args[args.indexOf("--output") + 1]!, "w1 Thighway=path Nn1,n2\n");
  if (code === 0 && args[0] === "cat" && args[1]!.endsWith("partial.osm.pbf")) child.stdout.write("n1 T x0 y0\n");
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, null);
}
const stages = ["extract", "cat", "getparents", "tags-filter", "cat", "getid", "merge"].map((command, index) => ({ command, index }));
describe("filter process lifetime", () => {
  it("selects every barrier and node permission family before reference completion", async () => {
    const directory = await root();
    const children = stages.slice(0, 4).map(() => pendingChild());
    const result = collect(filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {}));
    const rejected = expect(result).rejects.toThrow("osmium tags-filter failed");
    for (const child of children.slice(0, 3)) await finishChild(child);
    await vi.waitFor(() => expect(children[3]!.listenerCount("close")).toBe(1));
    const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      "n/barrier", "n/foot", "n/access", "n/motorcar", "n/motor_vehicle", "n/vehicle",
      "n/foot:forward", "n/foot:backward", "n/foot:conditional", "n/access:conditional",
      "n/motorcar:conditional", "n/motor_vehicle:conditional", "n/vehicle:conditional",
    ]));
    expect(args.some(arg=>arg.includes("building"))).toBe(false);
    await finishChild(children[3]!, 1);
    await rejected;
  });
  it("pads an L-shaped addition without filling the old core's bounding rectangle",async()=>{
    const directory=await root(),child=pendingChild();
    const result=collect(filteredSourceLines(fixture,directory,unionCoverage([
      rectangle([0,0,1,.1]),rectangle([0,0,.1,1]),
    ]),async()=>{}));
    const rejected=expect(result).rejects.toThrow("osmium extract failed");
    await vi.waitFor(()=>expect(child.listenerCount("close")).toBe(1));
    const args=vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
    const {geometry}=JSON.parse(await readFile(args[args.indexOf("--polygon")+1]!,"utf8"));
    expect(coordinateIsInsideArea([.8,.8],geometry)).toBe(false);
    expect(coordinateIsInsideArea([.8,.105],geometry)).toBe(true);
    expect(coordinateIsInsideArea([.105,.8],geometry)).toBe(true);
    await finishChild(child,1);await rejected;
    expect(await readdir(directory)).toEqual([]);
  });
  it("stops the nonempty probe after one object and awaits its exit before scanning parents", async () => {
    const directory = await root(), extraction = pendingChild(), probe = pendingChild(), parents = pendingChild();
    probe.kill.mockImplementation(() => true);
    const result = collect(filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {}));
    const rejected = expect(result).rejects.toThrow("osmium getparents failed");
    await finishChild(extraction);
    await vi.waitFor(() => expect(probe.listenerCount("close")).toBe(1));
    probe.stdout.write("n1 T x0 y0\n");
    await vi.waitFor(() => expect(probe.kill).toHaveBeenCalledWith("SIGKILL"));
    expect(spawn).toHaveBeenCalledTimes(2);
    probe.stdout.end();
    probe.stderr.end();
    probe.emit("close", null, "SIGKILL");
    await finishChild(parents, 1);
    await rejected;
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(stages)("kills and awaits stage $index ($command) when its periodic checkpoint cancels, then removes staging", async ({ index }) => {
    const directory = await root();
    const children = stages.slice(0, index + 1).map(() => pendingChild());
    const result = collect(filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {
      if (vi.mocked(spawn).mock.calls.length === index + 1) throw new Error("cancelled scan");
    }));
    const rejected = expect(result).rejects.toThrow("cancelled scan");
    for (const child of children.slice(0, index)) await finishChild(child);
    await rejected;
    expect(children[index]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(index + 1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("kills the reference reader and cleans up when the importer breaks early", async () => {
    const directory = await root();
    const preparation = stages.slice(0, -1).map(() => pendingChild()), child = pendingChild();
    const lines = filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {});
    const first = lines.next();
    for (const prior of preparation) await finishChild(prior);
    await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
    child.stdout.write("n1 T x0 y0\n");
    expect((await first).value).toBe("n1 T x0 y0");
    await lines.return(undefined);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    for (const prior of preparation) expect(prior.kill).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(stages)("bounds stage $index ($command) error output, skips later stages, and cleans up", async ({ command, index }) => {
    const directory = await root();
    const children = stages.slice(0, index + 1).map(() => pendingChild());
    const result = collect(filteredSourceLines(fixture, directory, rectangle([0, 0, .005, .005]), async () => {}));
    const errorResult = result.catch((value: Error) => value);
    for (const child of children.slice(0, index)) await finishChild(child);
    const child = children[index]!;
    await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
    child.stderr.write("x".repeat(20_000));
    await finishChild(child, 1);
    const error = await errorResult;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`osmium ${command} failed`);
    expect((error as Error).message.length).toBeLessThan(8300);
    expect(spawn).toHaveBeenCalledTimes(index + 1);
    expect(await readdir(directory)).toEqual([]);
  });
});
