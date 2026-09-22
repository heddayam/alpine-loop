import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import type { CommandRunner } from "./command";
import { prepareOsmBuildings } from "./buildings";
import { OsmPbfNamedAreaAdapter } from "./named-areas";
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

    expect(first.topology.ways).toHaveLength(3);
    expect(second).toEqual(first);
    expect(vi.mocked(runner).mock.calls).toHaveLength(callsAfterFirstBuild + 1);
    const extract = vi.mocked(runner).mock.calls.find(([, arguments_]) => arguments_[0] === "extract")?.[1];
    expect(extract).toEqual(expect.arrayContaining(["--strategy", "complete_ways", "--polygon"]));
    const tagsFilter = vi.mocked(runner).mock.calls.find(([, arguments_]) => arguments_[0] === "tags-filter")?.[1];
    expect(tagsFilter).toEqual(expect.arrayContaining([
      "w/highway=path,footway,track,pedestrian,steps,bridleway,service,unclassified,residential,living_street,road,tertiary,secondary,primary",
      "nw/highway=trailhead",
      "nw/amenity=parking",
      "nw/information=trailhead,guidepost,board,map",
      "nw/tourism=information",
      "nw/barrier=gate",
    ]));
    const [preparedDirectory] = await readdir(options.preparationRoot);
    const preparedFiles = await readFile(path.join(options.preparationRoot, preparedDirectory, "topology.json"), "utf8");
    expect(preparedFiles).toContain("osm-way-101");
    expect(await readdir(path.join(options.preparationRoot, preparedDirectory)))
      .toEqual(["region.osm.pbf", "topology.json"]);
    expect(first.regionPath).toBe(path.join(options.preparationRoot, preparedDirectory, "region.osm.pbf"));
    expect(first.identity).toBe(preparedDirectory);
  });

  it("keys all preparation by boundary, source content and version without reloading topology for consumers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-osmium-identities-"));
    temporaryDirectories.push(directory);
    const pbf = path.join(directory, "source.osm.pbf");
    const boundaryPath = path.join(directory, "boundary.geojson");
    const boundary = (extent: number) => JSON.stringify({
      type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [extent, 0], [extent, 1], [0, 1], [0, 0]]] },
    });
    await writeFile(pbf, "source 1");
    await writeFile(boundaryPath, boundary(1));
    const snapshot: SourceSnapshot = {
      id: "osm-fixture", authority: "fixture", dataset: "fixture", version: "1",
      retrievedAt: "2026-08-04T00:00:00.000Z", url: "https://fixtures.invalid/source.osm.pbf",
      license: "ODbL fixture", contentHash: await sha256File(pbf), localPath: pbf,
    };
    let extraction = 0;
    const runner: CommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "--version") return { stdout: "osmium fixture", stderr: "" };
      const output = args[args.indexOf("--output") + 1]!;
      if (args[0] === "extract") extraction += 1;
      if (args[0] === "cat") await copyFile(path.resolve("data/fixtures/source/osm/hiking.opl"), output);
      else if (args[0] === "export" && output.endsWith("buildings.geojsonseq")) {
        await writeFile(output, `\u001e${JSON.stringify({ geometry: { type: "Point", coordinates: [extraction, 0] } })}\n`);
      } else if (args[0] === "export") {
        await writeFile(output, JSON.stringify({ type: "FeatureCollection", features: [{
          type: "Feature", properties: { "@id": `r${extraction}`, name: `Park ${extraction}`, leisure: "park" },
          geometry: JSON.parse(boundary(1)).geometry,
        }] }));
      } else await writeFile(output, "fixture");
      return { stdout: "", stderr: "" };
    });
    const options = { boundaryPath, preparationRoot: path.join(directory, "prepared"), runner };
    const identities = new Set<string>();
    for (let revision = 1; revision <= 4; revision += 1) {
      if (revision === 2) await writeFile(boundaryPath, boundary(2));
      if (revision === 3) {
        await writeFile(pbf, "source 2");
        snapshot.contentHash = await sha256File(pbf);
      }
      if (revision === 4) snapshot.version = "2";
      const prepared = await prepareOsmTopology(snapshot, options);
      identities.add(prepared.identity);
      const namedAreas = new OsmPbfNamedAreaAdapter(prepared, options);
      expect(await prepareOsmBuildings(prepared, options)).toEqual([[revision, 0]]);
      expect((await namedAreas.normalize(snapshot)).map(({ id }) => id)).toEqual([`osm:relation/${revision}`]);
      const calls = vi.mocked(runner).mock.calls.length;
      expect(await prepareOsmBuildings(prepared, options)).toEqual([[revision, 0]]);
      expect((await namedAreas.normalize(snapshot)).map(({ id }) => id)).toEqual([`osm:relation/${revision}`]);
      expect(vi.mocked(runner).mock.calls).toHaveLength(calls);
      for (const kind of ["buildings", "named-areas"]) {
        const childRoot = path.join(options.preparationRoot, kind);
        for (const childDirectory of await readdir(childRoot)) {
          expect(await readdir(path.join(childRoot, childDirectory))).toEqual([`${kind}.json`]);
        }
      }
    }
    expect(identities.size).toBe(4);
    expect(extraction).toBe(4);
    expect(vi.mocked(runner).mock.calls.filter(([, args]) => args[0] === "cat")).toHaveLength(4);
    await writeFile(pbf, "unexpected changed bytes");
    await expect(prepareOsmTopology(snapshot, options)).rejects.toThrow("Content hash mismatch");
  });

});
