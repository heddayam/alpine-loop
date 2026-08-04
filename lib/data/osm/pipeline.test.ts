import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import type { CommandRunner } from "./command";
import { prepareOsmTopology } from "./pipeline";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resume-safe osmium preparation", () => {
  it("uses complete-ways polygon extraction and reuses an atomically prepared topology", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-osmium-pipeline-"));
    temporaryDirectories.push(directory);
    const pbf = path.join(directory, "source.osm.pbf");
    await writeFile(pbf, "offline pbf fixture");
    const snapshot: SourceSnapshot = {
      id: "osm-fixture",
      authority: "fixture",
      dataset: "fixture",
      version: "1",
      retrievedAt: "2026-08-04T00:00:00.000Z",
      url: "https://fixtures.invalid/source.osm.pbf",
      license: "ODbL fixture",
      contentHash: await sha256File(pbf),
      localPath: pbf,
    };
    const fixtureOpl = path.resolve("data/fixtures/source/osm/hiking.opl");
    const runner: CommandRunner = vi.fn(async (command, arguments_) => {
      if (arguments_[0] === "--version") return { stdout: "osmium version 1.18.0\n", stderr: "" };
      expect(command).toBe("osmium");
      const output = arguments_[arguments_.indexOf("--output") + 1];
      if (arguments_[0] === "cat") await copyFile(fixtureOpl, output);
      else await writeFile(output, `fixture ${arguments_[0]}`);
      return { stdout: "", stderr: "" };
    });
    const options = {
      boundaryPath: path.resolve("data/regions/santa-cruz-mountains/boundary.geojson"),
      preparationRoot: path.join(directory, "prepared"),
      runner,
    };
    const first = await prepareOsmTopology(snapshot, options);
    const callsAfterFirstBuild = vi.mocked(runner).mock.calls.length;
    const second = await prepareOsmTopology(snapshot, options);

    expect(first.ways).toHaveLength(2);
    expect(second).toEqual(first);
    expect(vi.mocked(runner).mock.calls).toHaveLength(callsAfterFirstBuild + 1);
    const extract = vi.mocked(runner).mock.calls.find(([, arguments_]) => arguments_[0] === "extract")?.[1];
    expect(extract).toEqual(expect.arrayContaining(["--strategy", "complete_ways", "--polygon"]));
    const [preparedDirectory] = await readdir(options.preparationRoot);
    const preparedFiles = await readFile(path.join(options.preparationRoot, preparedDirectory, "topology.json"), "utf8");
    expect(preparedFiles).toContain("osm-way-101");
  });
});
