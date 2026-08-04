import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("MapLibre browser worker assets", () => {
  it("ships the worker and its exact relative shared-module dependency", async () => {
    const vendorDirectory = path.join(process.cwd(), "public", "vendor", "maplibre");
    const [worker, shared] = await Promise.all([
      readFile(path.join(vendorDirectory, "maplibre-gl-worker.mjs"), "utf8"),
      readFile(path.join(vendorDirectory, "maplibre-gl-shared.mjs"), "utf8"),
    ]);

    expect(worker).toContain('from"./maplibre-gl-shared.mjs"');
    expect(worker).toContain("MapLibre GL JS");
    expect(shared).toContain("MapLibre GL JS");
  });
});
