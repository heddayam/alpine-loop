import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("MapLibre browser worker assets", () => {
  it.each(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"])(
    "ships %s byte-for-byte from the installed MapLibre package",
    async (filename) => {
      const [local, installed] = await Promise.all([
        readFile(path.join(process.cwd(), "public", "maplibre", filename)),
        readFile(require.resolve(`maplibre-gl/dist/${filename}`)),
      ]);

      expect(local.equals(installed), `${filename} drifted; run npm run maplibre:sync`).toBe(true);
    },
  );

  it("ships the worker and its exact relative shared-module dependency", async () => {
    const assetDirectory = path.join(process.cwd(), "public", "maplibre");
    const [worker, shared] = await Promise.all([
      readFile(path.join(assetDirectory, "maplibre-gl-worker.mjs"), "utf8"),
      readFile(path.join(assetDirectory, "maplibre-gl-shared.mjs"), "utf8"),
    ]);

    expect(worker).toContain('from"./maplibre-gl-shared.mjs"');
    expect(worker).toContain("MapLibre GL JS");
    expect(shared).toContain("MapLibre GL JS");
  });
});
