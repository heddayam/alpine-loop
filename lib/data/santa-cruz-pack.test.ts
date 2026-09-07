import { describe, expect, it } from "vitest";
import { applyCuratedAccessRestrictions, readCuratedAccessFile } from "./curated-access";
import { SANTA_CRUZ_CURATED_ACCESS_PATH, SANTA_CRUZ_PACK_CONFIG } from "./santa-cruz-pack";
import type { NormalizedTopology } from "./types";

const restrictionIds = [
  "way/38903758", "way/38903882", "way/38903893", "way/38904206", "way/39158068",
  "way/39161341", "way/39428990", "way/69844556", "way/111475473", "way/141456929",
  "way/222603845", "way/352892062", "way/352892063", "way/352892064", "way/352892065",
  "way/352892067", "way/352892068", "way/427738829", "way/427738837", "way/808148863",
  "way/808148864", "way/1254704454", "way/1469336136", "way/1475165257", "way/1483129226",
  "way/1539878799", "way/1539878800", "way/1539878801", "way/1539878802", "way/1539878804",
  "way/1539878805",
];


describe("Santa Cruz regional access policy", () => {
  it("pins exactly the 31 public/unknown removals and excludes the already-private inert match", async () => {
    const curated = await readCuratedAccessFile(SANTA_CRUZ_CURATED_ACCESS_PATH);
    expect(curated.restrictions.map(({ externalId }) => externalId)).toEqual(restrictionIds);
    expect(curated.restrictions).toHaveLength(31);
    expect(curated.restrictions).not.toContainEqual(expect.objectContaining({ externalId: "way/427738834" }));
    expect(curated.restrictions.find(({ externalId }) => externalId === "way/39428990"))
      .toMatchObject({ accessState: "prohibited" });
    expect(curated.restrictions.find(({ externalId }) => externalId === "way/1254704454"))
      .toMatchObject({ accessState: "closed" });
  });


  it("applies every pinned removal without requiring an entrance authority", async () => {
    expect(SANTA_CRUZ_PACK_CONFIG.entrances).toBeUndefined();
    const curated = await readCuratedAccessFile(SANTA_CRUZ_CURATED_ACCESS_PATH, SANTA_CRUZ_PACK_CONFIG.restrictions!.contentHash);
    const topology: NormalizedTopology = {
      nodes: [], accessPoints: [], rejectedWayCount: 0,
      ways: restrictionIds.map((externalId) => ({
        id: externalId, externalId, nodeIds: ["a", "b"], coordinates: [[-122.1, 37.1], [-122.099, 37.1]],
        name: "Reviewed trail", accessState: "public", bidirectional: true, edgeClass: "trail",
        sourceRefs: ["osm"], flags: [],
      })),
    };
    const restricted = applyCuratedAccessRestrictions(topology, curated.snapshot.id, curated.restrictions);
    expect(restricted.ways.map(({ externalId, accessState }) => ({ externalId, accessState })))
      .toEqual(curated.restrictions.map(({ externalId, accessState }) => ({ externalId, accessState })));
    expect(restricted.ways.every(({ sourceRefs }) => sourceRefs.includes(curated.snapshot.id))).toBe(true);
  });
});
