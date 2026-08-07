import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/data/regions/registry.json", () => ({
  default: {
    version: 1,
    regions: [
      { id: "second-region", label: "Second", displayOrder: 2, packId: "second-pack" },
      { id: "first-region", label: "First", displayOrder: 1, packId: "first-pack" },
      { id: "future-region", label: "Future", displayOrder: 3 },
    ],
  },
}));

import { loadRoutePacks } from "./pack-registry";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpine-route-packs-"));
  temporaryRoots.push(root);
  return root;
}

async function install(root: string, id: string): Promise<void> {
  const directory = path.join(root, id, `${id}-v1`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "pack.sqlite"), "fixture");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: "1",
    id,
    name: id,
    dataVersion: `${id}-v1`,
    builtAt: "2026-08-06T00:00:00Z",
    compilerVersion: "test",
    metricAlgorithmVersion: "test",
    coverage: {
      bbox: [-123, 36, -122, 37],
      boundary: { type: "Polygon", coordinates: [[[-123, 36], [-122, 36], [-122, 37], [-123, 37], [-123, 36]]] },
    },
    display: { center: [-122.5, 36.5], zoom: 9 },
    capabilities: { elevation: true, officialAccess: true },
    fieldConfidence: { access: "medium" },
    sources: [{
      id: "source", authority: "Authority", dataset: "Dataset", version: "1",
      retrievedAt: "2026-08-06T00:00:00Z", url: "https://example.com/source", license: "Test",
      contentHash: `sha256:${"a".repeat(64)}`,
    }],
  }));
  await writeFile(path.join(root, id, "current.json"), JSON.stringify({
    dataVersion: `${id}-v1`,
    path: `${id}-v1/manifest.json`,
  }));
}

describe("route pack registry", () => {
  it("uses the fixture only when no valid linked pack is available", async () => {
    const packs = await loadRoutePacks(await emptyRoot());
    expect([...packs.keys()]).toEqual(["fixture-pack"]);
  });

  it("registers every valid linked pack in catalog order and ignores unlinked installations", async () => {
    const root = await emptyRoot();
    await Promise.all([
      install(root, "second-pack"),
      install(root, "first-pack"),
      install(root, "unlinked-pack"),
    ]);
    const packs = await loadRoutePacks(root);
    expect([...packs.keys()]).toEqual(["first-pack", "second-pack"]);
    expect([...packs.values()].every(({ kind }) => kind === "installed")).toBe(true);
  });

  it("keeps valid packs available when another linked installation is malformed", async () => {
    const root = await emptyRoot();
    await install(root, "first-pack");
    await mkdir(path.join(root, "second-pack"), { recursive: true });
    await writeFile(path.join(root, "second-pack", "current.json"), "invalid");
    await expect(loadRoutePacks(root)).resolves.toSatisfy((packs: ReadonlyMap<string, unknown>) =>
      [...packs.keys()].join(",") === "first-pack",
    );
  });
});
