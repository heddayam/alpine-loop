import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidAreaGeometry } from "@/lib/data/area-geometry";
import { areaBounds, coordinateIsInsideArea } from "@/lib/graph/geometry";
import { rectangle, subtractCoverage } from "./geometry";
import { planLocalCoverage } from "./plan";
import { readSourceRecipe } from "./recipe";

const recipePath = "data/coverage/recipes/washington.json";

describe("Washington adjacent source support", () => {
  it("pins Idaho to the same upstream timestamp as Washington and Oregon", async () => {
    const recipe = await readSourceRecipe(recipePath);
    expect(recipe.sources.map(source => source.config.upstreamTimestamp)).toEqual([
      "2026-08-01T20:21:21.000Z", "2026-08-01T20:21:21.000Z", "2026-08-01T20:21:21.000Z",
    ]);
    const idaho = recipe.sources.find(source => source.config.id === "geofabrik-idaho-osm")!;
    expect(idaho.config).toMatchObject({version:"idaho-260801",expectedByteLength:127365914});
    expect(idaho.sha256).toBe("sha256:6cb0ef33774b5580d618749b0b0a54d4f7a0b1bc0674e1df2bfa73024ea0f7b8");
    expect(areaBounds(assertValidAreaGeometry(idaho.geometry, "Idaho provider"))).toEqual([-117.246,41.98306,-111.0431,49.00819]);
    // The provider polygon is not inflated to the PBF's larger header bbox.
    expect(coordinateIsInsideArea([-116.5,49.1],idaho.geometry)).toBe(false);
  });

  it.each([
    {name:"northeast border",bounds:[-117.2,48.7,-117.05,48.95]},
    {name:"Spokane",bounds:[-117.2,47.6,-117.03,47.8]},
    {name:"southeast border",bounds:[-117.55,46,-117.02,46.3]},
  ])("covers the complete 25-mile $name routing buffer with adjacent inputs", async ({bounds}) => {
    const recipe = await readSourceRecipe(recipePath);
    const start = rectangle(bounds);
    const plan = planLocalCoverage(recipe,start);
    expect(plan.bufferMiles).toBe(25);
    expect(areaBounds(plan.geometry)[2]).toBeGreaterThan(-116.6);
    expect(() => planLocalCoverage({...recipe,sources:recipe.sources.filter(source=>source.config.id!=="geofabrik-idaho-osm")},start)).toThrow("complete 25-mile route buffer");
  });

  it("limits only the reviewed offshore corner while still rejecting a missing land source", async () => {
    const recipe = await readSourceRecipe(recipePath);
    const supported = recipe.supportedArea!.geometry;
    expect(coordinateIsInsideArea([-125.3,46.45],supported)).toBe(false);
    expect(coordinateIsInsideArea([-125.3,46.3],supported)).toBe(true); // No new southern/Oregon cap.
    // Westernmost vertex among all 39 pinned Census Washington county territories.
    expect(coordinateIsInsideArea([-124.76306800030036,48.17628299983627],supported)).toBe(true);
    const start = rectangle([-122.1,47.9,-121.9,48.1]);
    expect(planLocalCoverage(recipe,start).bufferMiles).toBe(25);
    const landGap = rectangle([-122.01,47.99,-121.99,48.01]);
    const incomplete = {...recipe,sources:recipe.sources.map(source=>({
      ...source,geometry:subtractCoverage(source.geometry,landGap)!,
    }))};
    expect(() => planLocalCoverage(incomplete,start)).toThrow("complete 25-mile route buffer");
  });

  it("extends the exact IBC border through the Idaho buffer without changing the original chain", async () => {
    const feature = JSON.parse(await readFile("data/coverage/washington-us-limit.geojson","utf8"));
    const geometry = assertValidAreaGeometry(feature.geometry,"US supported area");
    const ring = feature.geometry.coordinates[0] as number[][];
    const originalStart = ring.findIndex(([lon,lat])=>lon===-116.49923103599997&&lat===48.99988115300005);
    expect(originalStart).toBeGreaterThan(3);
    // Independent digest of every original vertex from records 10, 2, 6 and 14.
    const originalEnd = ring.findIndex(([lon,lat])=>lon===-124.72724702899995&&lat===48.493444612000076);
    expect(originalEnd).toBeGreaterThan(originalStart);
    const originalChain = ring.slice(originalStart,originalEnd+1);
    expect(originalChain).toHaveLength(855);
    expect(createHash("sha256").update(JSON.stringify(originalChain)).digest("hex")).toBe("00e9de66744d5652f6d540bdee20bdd8880f40112fda83e111532c7a33e8eeb2");
    expect(ring[3]![0]).toBeGreaterThan(-115.5);
    expect(coordinateIsInsideArea([-116.33743944699995,49.00050],geometry)).toBe(true);
    expect(coordinateIsInsideArea([-116.33743944699995,49.00070],geometry)).toBe(false);
    expect(coordinateIsInsideArea([-121.3346143,49.0007618],geometry)).toBe(true); // Depot Creek
    expect(coordinateIsInsideArea([-121.7736891,48.99766],geometry)).toBe(false); // Canada, BR717
    expect(coordinateIsInsideArea([-123.36,48.43],geometry)).toBe(false); // Victoria
    expect(coordinateIsInsideArea([-123.02,48.535],geometry)).toBe(true); // Friday Harbor
    expect(feature.properties).toMatchObject({
      sourceSha256:"eb327459528b87cbc27e55ccc6bfd6982562c75559823a00b6dc50c04abcaab1",
      sourceShapefileSha256:"77db98da135852843be4cdc4e3d23319a7113f8d77e1b1b963b2da63be2ef022",
      records:[21,10,2,6,14],
    });
  });
});
