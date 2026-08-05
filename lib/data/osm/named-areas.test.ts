import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import type { CommandRunner } from "./command";
import { normalizeOsmNamedAreaGeoJson, prepareOsmNamedAreas } from "./named-areas";

describe("OSM named-area normalization", () => {
  it("uses stable OSM IDs and only unambiguous supported polygon tags", () => {
    const result = normalizeOsmNamedAreaGeoJson(JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            "@id": "r42",
            name: "Castle Preserve",
            alt_name: "Castle Open Space;Castle Lands",
            leisure: "nature_reserve",
            is_in: "Santa Cruz County, California",
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]],
              [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
            ],
          },
        },
        {
          type: "Feature",
          properties: { "@id": "r43", name: "Twin City", boundary: "administrative", admin_level: "8" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
              [[[12, 12], [13, 12], [13, 13], [12, 13], [12, 12]]],
            ],
          },
        },
        {
          type: "Feature",
          properties: { "@id": "r44", name: "Ambiguous Agency Boundary", boundary: "administrative", admin_level: "7" },
          geometry: { type: "Polygon", coordinates: [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]] },
        },
      ],
    }), "osm-source");

    expect(result.map(({ id, kind }) => [id, kind])).toEqual([
      ["osm:relation/42", "preserve"],
      ["osm:relation/43", "city"],
    ]);
    expect(result[0]).toMatchObject({
      aliases: ["Castle Lands", "Castle Open Space", "Castle Preserve"],
      context: "Santa Cruz County, California",
      sourceIds: ["osm-source"],
    });
    expect(result[0]?.geometry.type).toBe("Polygon");
    expect(result[1]?.geometry.type).toBe("MultiPolygon");
  });
});

describe("OSM named-area preparation", () => {
  it("extracts named polygons from the already-extracted regional PBF", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-osm-named-areas-"));
    try {
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
      const exported = JSON.stringify({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: { "@id": "r99", name: "Offline Park", leisure: "park" },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        }],
      });
      const runner: CommandRunner = vi.fn(async (command, arguments_) => {
        if (arguments_[0] === "--version") return { stdout: "osmium version fixture\n", stderr: "" };
        expect(command).toBe("osmium");
        const output = arguments_[arguments_.indexOf("--output") + 1]!;
        if (arguments_[0] === "cat") await copyFile(fixtureOpl, output);
        else if (arguments_[0] === "export") await writeFile(output, exported);
        else await writeFile(output, `fixture ${arguments_[0]}`);
        return { stdout: "", stderr: "" };
      });
      const result = await prepareOsmNamedAreas(snapshot, {
        boundaryPath: path.resolve("data/regions/santa-cruz-mountains/boundary.geojson"),
        preparationRoot: path.join(directory, "topology"),
        namedAreaPreparationRoot: path.join(directory, "named"),
        runner,
      });
      expect(result.map(({ id }) => id)).toEqual(["osm:relation/99"]);
      const namedFilter = vi.mocked(runner).mock.calls.find(([, arguments_]) =>
        arguments_[0] === "tags-filter" && arguments_.some((argument) => argument.includes("named-areas.osm.pbf")));
      expect(namedFilter?.[1][1]).toMatch(/region\.osm\.pbf$/);
      expect(namedFilter?.[1][1]).not.toBe(pbf);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
