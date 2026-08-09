import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

function request(query = "bbox=-122.183,37.155,-122.14,37.178") {
  return new Request(`http://localhost/api/packs/fixture-pack/access-points?${query}`);
}

describe("pack map-context endpoint", () => {
  beforeEach(() => {
    vi.stubEnv("ALPINE_PACK_ROOT", path.join(tmpdir(), "alpine-loop-route-test-empty-packs"));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns in-bound access points and source-backed trail GeoJSON", async () => {
    const response = await GET(request(), { params: Promise.resolve({ packId: "fixture-pack" }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      accessPoints: Array<{ id: string; lon: number; lat: number }>;
      trailNetwork: { type: string; features: Array<{ geometry: { type: string }; properties: { distanceMeters: number } }> };
    };
    expect(payload.accessPoints.map(({ id }) => id)).toContain("trailhead-a");
    expect(payload.trailNetwork.type).toBe("FeatureCollection");
    expect(payload.trailNetwork.features).toHaveLength(3);
    expect(payload.trailNetwork.features.every(({ geometry }) => geometry.type === "LineString")).toBe(true);
    expect(payload.trailNetwork.features.every(({ properties }) => properties.distanceMeters > 0)).toBe(true);
  });

  it("can return trail geometry without repeating access-point work", async () => {
    const response = await GET(request("bbox=-122.183,37.155,-122.14,37.178&includeAccessPoints=false"), {
      params: Promise.resolve({ packId: "fixture-pack" }),
    });
    const payload = await response.json() as { accessPoints: unknown[]; trailNetwork: { features: unknown[] } };

    expect(response.status).toBe(200);
    expect(payload.accessPoints).toEqual([]);
    expect(payload.trailNetwork.features).toHaveLength(3);
  });

  it("honors the unknown-access policy and rejects invalid packs or bounds", async () => {
    const unknownOff = await GET(request("bbox=-122.183,37.155,-122.14,37.178&includeUncertainAccess=false"), {
      params: Promise.resolve({ packId: "fixture-pack" }),
    });
    const unknownOn = await GET(request("bbox=-122.183,37.155,-122.14,37.178&includeUncertainAccess=true"), {
      params: Promise.resolve({ packId: "fixture-pack" }),
    });
    expect((await unknownOn.json() as { accessPoints: unknown[] }).accessPoints.length)
      .toBeGreaterThanOrEqual((await unknownOff.json() as { accessPoints: unknown[] }).accessPoints.length);

    await expect(GET(request(), { params: Promise.resolve({ packId: "missing-pack" }) }))
      .resolves.toMatchObject({ status: 404 });
    await expect(GET(request("bbox=bad"), { params: Promise.resolve({ packId: "fixture-pack" }) }))
      .resolves.toMatchObject({ status: 400 });
  });
});
