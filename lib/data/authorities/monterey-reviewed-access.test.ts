import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import {
  MONTEREY_REVIEWED_ACCESS_CONTENT_HASH,
  MontereyReviewedAccessAdapter,
  montereyReviewedAccessSnapshot,
} from "./monterey-reviewed-access";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

type MutableReview = { sourcePages: Array<Record<string, unknown>>; records: Array<Record<string, unknown>> };

async function changedSource(change: (input: MutableReview) => void): Promise<SourceSnapshot> {
  const source = montereyReviewedAccessSnapshot();
  const input = JSON.parse(await readFile(source.localPath, "utf8")) as MutableReview;
  change(input);
  const directory = await mkdtemp(path.join(os.tmpdir(), "monterey-reviewed-access-"));
  temporaryDirectories.push(directory);
  const localPath = path.join(directory, "review.json");
  await writeFile(localPath, JSON.stringify(input));
  return { ...source, localPath, contentHash: await sha256File(localPath) };
}

describe("Monterey reviewed official-access adapter", () => {
  it("pins the committed review and separates named entrances from exact way closures", async () => {
    const source = montereyReviewedAccessSnapshot();
    expect(source.contentHash).toBe(MONTEREY_REVIEWED_ACCESS_CONTENT_HASH);
    expect(await sha256File(source.localPath)).toBe(source.contentHash);
    const evidence = await new MontereyReviewedAccessAdapter().normalize(source);
    expect(evidence.filter(({ externalId }) => externalId.startsWith("entrance/"))).toHaveLength(10);
    expect(evidence.filter(({ externalId }) => externalId.startsWith("way/"))).toEqual([
      expect.objectContaining({ externalId: "way/55856070", accessState: "closed", confidence: "high" }),
      expect.objectContaining({ externalId: "way/55856129", accessState: "closed", confidence: "high" }),
    ]);
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "entrance/kahn-ranch-hitchcock-canyon", name: expect.stringMatching(/permit required/), accessState: "public" }),
      expect.objectContaining({ externalId: "entrance/fort-ord-creekside-terrace", name: expect.stringMatching(/signed trails only/) }),
    ]));
  });

  it("fails closed on identity, URL, empty records, provenance drift, and invalid record/source links", async () => {
    const adapter = new MontereyReviewedAccessAdapter();
    const source = montereyReviewedAccessSnapshot();
    await expect(adapter.validate({ ...source, authority: "Another authority" })).rejects.toThrow(/identity/);
    await expect(adapter.validate({ ...source, url: `${source.url}?changed=1` })).rejects.toThrow(/URL/);
    await expect(adapter.validate(await changedSource((input) => { input.records = []; }))).rejects.toThrow();
    await expect(adapter.validate(await changedSource((input) => {
      input.sourcePages[0].byteLength = Number(input.sourcePages[0].byteLength) + 1;
    }))).rejects.toThrow(/provenance drifted/);
    await expect(adapter.validate(await changedSource((input) => { input.records[0].sourcePageIndex = 4; }))).rejects.toThrow(/source-page reference/);
    await expect(adapter.validate(await changedSource((input) => { input.records[10].targetExternalIds = ["node/1"]; }))).rejects.toThrow();
  });
});
