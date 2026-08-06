import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractSingleZipEntry, listZipEntries, readZipEntry } from "./zip";

// A real archive produced by Info-ZIP, so this exercises third-party output
// rather than a round-trip through our own writer.
const FIXTURE = path.resolve("data/fixtures/population/tile-fixture.zip");

async function fixture(): Promise<Buffer> {
  return readFile(FIXTURE);
}

describe("listZipEntries", () => {
  it("reads every member of the archive", async () => {
    const entries = listZipEntries(await fixture());
    expect(entries.map(({ fileName }) => fileName).sort()).toEqual(["README.txt", "sample_tile.tif"]);
  });
});

describe("readZipEntry", () => {
  it("decompresses a member to its recorded size", async () => {
    const buffer = await fixture();
    const entry = listZipEntries(buffer).find(({ fileName }) => fileName === "sample_tile.tif")!;
    const contents = readZipEntry(buffer, entry);
    expect(contents.length).toBe(entry.uncompressedSize);
    expect(contents.subarray(0, 20).toString("utf8")).toBe("FAKE-GEOTIFF-CONTENT");
  });
});

describe("extractSingleZipEntry", () => {
  it("pulls out the only GeoTIFF and ignores the documentation", async () => {
    const result = extractSingleZipEntry(await fixture(), (name) => /\.tiff?$/i.test(name), "GeoTIFF");
    expect(result.fileName).toBe("sample_tile.tif");
    expect(result.contents.subarray(0, 4).toString("utf8")).toBe("FAKE");
  });

  it("fails rather than guessing when no member matches", async () => {
    await expect(async () => extractSingleZipEntry(await fixture(), (name) => name.endsWith(".shp"), "shapefile"))
      .rejects.toThrow(/found 0/);
  });

  it("fails rather than guessing when several members match", async () => {
    await expect(async () => extractSingleZipEntry(await fixture(), () => true, "member"))
      .rejects.toThrow(/found 2/);
  });

  it("rejects a buffer that is not a ZIP archive", () => {
    expect(() => listZipEntries(Buffer.alloc(64))).toThrow(/end-of-central-directory/);
  });
});
