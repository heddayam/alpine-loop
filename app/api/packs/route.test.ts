import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packCatalogResponseV1Schema } from "@/lib/contracts/regions";
import { GET } from "./route";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GET /api/packs", () => {
  it("returns the validated complete catalog when linked packs are not installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "alpine-packs-api-"));
    temporaryRoots.push(root);
    vi.stubEnv("ALPINE_PACK_ROOT", root);

    const response = await GET();
    expect(response.status).toBe(200);
    const payload = packCatalogResponseV1Schema.parse(await response.json());
    expect(payload.regions).toHaveLength(6);
    expect(payload.regions[0]).toMatchObject({
      id: "santa-cruz-mountains",
      state: "unavailable",
      packId: "santa-cruz-mountains",
    });
    expect(payload.regions[1]).toMatchObject({
      id: "southern-east-bay",
      state: "unavailable",
      packId: "southern-east-bay",
    });
    expect(payload.regions[2]).toMatchObject({
      id: "monterey-carmel",
      state: "unavailable",
      packId: "monterey-carmel",
    });
    expect(payload.regions[3]).toMatchObject({
      id: "henry-coe",
      state: "unavailable",
      packId: "henry-coe",
    });
    expect(payload.regions.slice(4).every(({ state }) => state === "planned")).toBe(true);
  });
});
