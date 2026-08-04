import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import { CaliforniaStateParksAccessAdapter, CALIFORNIA_STATE_PARKS_QUERY_URL } from "./california-state-parks";
import { attachOfficialEvidence } from "./join";
import { MidpenOfficialAccessAdapter, MIDPEN_QUERY_URL } from "./midpen";
import { resolveAccessEvidence } from "./reconcile";
import { SanMateoCountyParksAccessAdapter, SAN_MATEO_COUNTY_GEOJSON_URL } from "./san-mateo-county";
import { SantaClaraCountyParksAccessAdapter, SANTA_CLARA_COUNTY_QUERY_URL } from "./santa-clara-county";

const fixture = (name: string) => path.resolve("data/fixtures/source/authorities", name);

async function snapshot(
  localPath: string,
  identity: Pick<SourceSnapshot, "authority" | "dataset" | "url">,
): Promise<SourceSnapshot> {
  return {
    id: "official-fixture",
    ...identity,
    version: "fixture-1",
    retrievedAt: "2026-08-04T00:00:00Z",
    license: "Fixture-only data",
    contentHash: await sha256File(localPath),
    localPath,
  };
}

describe("official authority adapters", () => {
  it("normalizes documented Midpen access, closure, prohibition, and private states", async () => {
    const adapter = new MidpenOfficialAccessAdapter();
    const source = await snapshot(fixture("midpen-query.json"), {
      authority: "Midpeninsula Regional Open Space District", dataset: "Trail", url: MIDPEN_QUERY_URL,
    });
    await expect(adapter.validate(source)).resolves.toBeUndefined();
    const evidence = await adapter.normalize(source);
    expect(evidence.map(({ externalId, accessState }) => [externalId, accessState])).toEqual([
      ["midpen-public", "public"],
      ["midpen-seasonal", "closed"],
      ["midpen-no-hike", "prohibited"],
      ["midpen-private", "private"],
    ]);
    expect(evidence[0]).toMatchObject({ sourceId: "official-fixture", lon: -122.19, lat: 37.21, confidence: "high" });

    const [feature] = await adapter.normalizeForJoin(source);
    expect(feature).toMatchObject({
      sourceId: "official-fixture",
      authorityFeatureId: "midpen-public",
      geometry: { type: "LineString", coordinates: [[-122.2, 37.2], [-122.19, 37.21]] },
      evidence: { externalId: "midpen-public" },
    });
    const joined = attachOfficialEvidence(feature, "osm-way-42", { matchMethod: "spatial-intersection", distanceM: 0 });
    expect(joined).toMatchObject({
      authorityFeatureId: "midpen-public",
      targetExternalId: "osm-way-42",
      evidence: { externalId: "osm-way-42", sourceId: "official-fixture" },
    });
  });

  it("normalizes Santa Clara status and pedestrian-use fields conservatively", async () => {
    const adapter = new SantaClaraCountyParksAccessAdapter();
    const source = await snapshot(fixture("santa-clara-query.json"), {
      authority: "Santa Clara County Parks and Recreation", dataset: "Santa Clara County Parks Trails", url: SANTA_CLARA_COUNTY_QUERY_URL,
    });
    const evidence = await adapter.normalize(source);
    expect(evidence.map(({ accessState }) => accessState)).toEqual(["public", "closed", "prohibited", "unknown"]);
  });

  it("keeps State Parks routes unknown because the documented layer has no hiking or closure field", async () => {
    const adapter = new CaliforniaStateParksAccessAdapter();
    const source = await snapshot(fixture("state-parks-query.json"), {
      authority: "California State Parks", dataset: "Recreational Routes", url: CALIFORNIA_STATE_PARKS_QUERY_URL,
    });
    await expect(adapter.normalize(source)).resolves.toMatchObject([{ externalId: "csp-1", accessState: "unknown" }]);
  });

  it("fails on schema drift, undocumented domains, unexpected CRS, empty data, URL drift, and hash changes", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "authority-adapter-"));
    type TestArcGis = {
      fields: Array<{ name: string; type: string }>;
      spatialReference: { wkid: number };
      features: Array<{ attributes: Record<string, unknown> }>;
    };
    const baseline = JSON.parse(await readFile(fixture("midpen-query.json"), "utf8")) as TestArcGis;
    const identity = { authority: "Midpeninsula Regional Open Space District", dataset: "Trail", url: MIDPEN_QUERY_URL };
    const cases: Array<[string, (input: TestArcGis) => void, RegExp]> = [
      ["missing-field", (input) => { input.fields = input.fields.filter((field) => field.name !== "HIKING"); }, /missing documented field HIKING/],
      ["changed-type", (input) => { input.fields.find((field) => field.name === "HIKING")!.type = "esriFieldTypeInteger"; }, /field HIKING changed/],
      ["crs", (input) => { input.spatialReference = { wkid: 3857 }; }, /Unexpected ArcGIS CRS/],
      ["empty", (input) => { input.features = []; }, /snapshot is empty/],
      ["domain", (input) => { input.features[0].attributes.HIKING = "Sometimes"; }, /Undocumented HIKING value/],
    ];
    const adapter = new MidpenOfficialAccessAdapter();
    for (const [name, mutate, message] of cases) {
      const input = structuredClone(baseline);
      mutate(input);
      const localPath = path.join(temporary, `${name}.json`);
      await writeFile(localPath, JSON.stringify(input));
      const source = await snapshot(localPath, identity);
      await expect(name === "domain" ? adapter.normalize(source) : adapter.validate(source)).rejects.toThrow(message);
    }
    const valid = await snapshot(fixture("midpen-query.json"), identity);
    await expect(adapter.validate({ ...valid, url: `${valid.url}&changed=true` })).rejects.toThrow(/pinned endpoint/);
    await expect(adapter.validate({ ...valid, contentHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow(/Content hash mismatch/);
  });

  it("fails loudly while the San Mateo public-domain view remains empty", async () => {
    const adapter = new SanMateoCountyParksAccessAdapter();
    const source = await snapshot(fixture("san-mateo-empty.geojson"), {
      authority: "San Mateo County", dataset: "San Mateo County trails", url: SAN_MATEO_COUNTY_GEOJSON_URL,
    });
    await expect(adapter.validate(source)).rejects.toThrow(/source is empty/);
  });
});

describe("official access precedence", () => {
  it("uses official restriction, then permission, then clear OSM evidence", () => {
    expect(resolveAccessEvidence("public", ["closed"])).toEqual({ state: "closed", conflict: false, winningTier: "official-restriction" });
    expect(resolveAccessEvidence("prohibited", ["public"])).toEqual({ state: "public", conflict: false, winningTier: "official-permission" });
    expect(resolveAccessEvidence("public", [])).toEqual({ state: "public", conflict: false, winningTier: "osm" });
    expect(resolveAccessEvidence("unknown", [])).toEqual({ state: "unknown", conflict: false, winningTier: "unknown" });
  });

  it("never resolves conflicting official evidence permissively", () => {
    expect(resolveAccessEvidence("public", ["public", "closed"])).toEqual({ state: "unknown", conflict: true, winningTier: "unknown" });
    expect(resolveAccessEvidence("public", ["private", "prohibited"])).toEqual({ state: "unknown", conflict: true, winningTier: "unknown" });
  });
});

describe("pinned source decisions", () => {
  it("records complete provenance, licensing, and concrete metadata hashes for every prioritized authority", async () => {
    const root = path.resolve("data/regions/santa-cruz-mountains/official-sources");
    const files = ["midpen.json", "california-state-parks.json", "santa-clara-county-parks.json", "san-mateo-county-parks.json"];
    const sources = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(root, file), "utf8")) as Record<string, unknown>));
    expect(sources.map(({ authority }) => authority)).toEqual([
      "Midpeninsula Regional Open Space District",
      "California State Parks",
      "Santa Clara County Parks and Recreation",
      "San Mateo County",
    ]);
    for (const source of sources) {
      for (const field of ["id", "authority", "dataset", "version", "retrievedAt", "itemUrl", "downloadUrl", "license", "termsDecision", "redistribution"]) {
        expect(source[field], `${String(source.id)}.${field}`).toBeTruthy();
      }
      expect(source.metadataContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(() => new URL(String(source.itemUrl))).not.toThrow();
      expect(() => new URL(String(source.downloadUrl))).not.toThrow();
    }
    expect(sources[0].downloadUrl).toBe(MIDPEN_QUERY_URL);
    expect(sources[1].downloadUrl).toBe(CALIFORNIA_STATE_PARKS_QUERY_URL);
    expect(sources[2].downloadUrl).toBe(SANTA_CLARA_COUNTY_QUERY_URL);
    expect(sources[3].downloadUrl).toBe(SAN_MATEO_COUNTY_GEOJSON_URL);
  });
});
