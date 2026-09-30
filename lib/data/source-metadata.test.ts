import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import type { DataRelease } from "@/lib/contracts/releases";
import { readPreparedSources } from "./prepared-audit";
import { mergeCatalogSources, sameSourceContent } from "./source-metadata";

type Source = DataRelease["sources"][number];
const source: Source = {
  id: "fixture", authority: "Alpine Loop", dataset: "Synthetic trails", version: "1",
  retrievedAt: "2026-09-28T00:00:00Z", url: "https://example.invalid/source",
  license: "CC0", contentHash: `sha256:${"1".repeat(64)}`,
};
const changes = [
  ["authority", "Another authority"], ["dataset", "Another dataset"], ["version", "2"],
  ["url", "https://example.invalid/another"], ["license", "ODbL"],
  ["contentHash", `sha256:${"2".repeat(64)}`],
] as const;

it("compares source content after schema normalization, ignoring only retrieval provenance", () => {
  const reordered = Object.fromEntries(Object.entries({ ...source, retrievedAt: "2026-09-29T12:00:00Z" }).reverse()) as Source;
  expect(sameSourceContent(source, reordered)).toBe(true);
  expect(sameSourceContent(source, { ...source, id: "another-source" })).toBe(false);
});

it.each(changes)("rejects a catalog conflict in %s despite compatible retrieval dates", (field, value) => {
  const changed = { ...source, [field]: value, retrievedAt: "2026-09-29T12:00:00Z" };
  expect(sameSourceContent(source, changed)).toBe(false);
  expect(() => mergeCatalogSources([source, changed])).toThrow("Conflicting source metadata fixture");
});

it("selects the earliest retrieval instant across offsets regardless of input order", () => {
  const earlier = { ...source, retrievedAt: "2026-09-28T03:00:00+03:00" };
  const later = { ...source, retrievedAt: "2026-09-27T23:00:00-02:00" };
  expect(mergeCatalogSources([earlier, later, source])).toEqual([source]);
  expect(mergeCatalogSources([later, earlier])).toEqual([earlier]);
  expect(mergeCatalogSources([earlier, later])).toEqual([earlier]);
});

it("breaks equivalent offset timestamp ties by text deterministically", () => {
  const offset = { ...source, retrievedAt: "2026-09-27T17:00:00-07:00" };
  expect(Date.parse(source.retrievedAt)).toBe(Date.parse(offset.retrievedAt));
  expect(mergeCatalogSources([source, offset])).toEqual([offset]);
  expect(mergeCatalogSources([offset, source])).toEqual([offset]);
});

it("preserves millisecond acquisition ordering", () => {
  const earlier = { ...source, retrievedAt: "2026-09-28T00:00:00.001Z" };
  const later = { ...source, retrievedAt: "2026-09-28T00:00:00.002Z" };
  expect(mergeCatalogSources([later, earlier])).toEqual([earlier]);
});

it("sorts IDs and normalizes field order without mutating or returning input objects", () => {
  const first = Object.freeze({ ...source, id: "b", retrievedAt: "2026-09-29T12:00:00Z" });
  const earlier = Object.freeze(Object.fromEntries(Object.entries(source).reverse()) as Source);
  const inputs = Object.freeze([first, earlier, source, { ...source, id: "a" }]);
  const before = JSON.stringify(inputs), merged = mergeCatalogSources(inputs);
  expect(merged.map(item => item.id)).toEqual(["a", "b", "fixture"]);
  expect(merged[2]).toEqual(source);
  expect(merged[2]).not.toBe(earlier);
  expect(merged[2]).not.toBe(source);
  expect(Object.keys(merged[2]!)).toEqual(Object.keys(source));
  expect(JSON.stringify(inputs)).toBe(before);
});

it.each(["not a date", "2026-02-30T00:00:00Z", "2026-09-28"])("validates omitted retrieval metadata: %s", retrievedAt => {
  const malformed = { ...source, retrievedAt };
  expect(() => sameSourceContent(source, malformed)).toThrow();
  expect(() => mergeCatalogSources([malformed])).toThrow();
});

it("rejects unknown metadata fields rather than silently dropping them", () => {
  const extra = { ...source, unexpected: "unreviewed" };
  expect(() => sameSourceContent(source, extra)).toThrow();
  expect(() => mergeCatalogSources([extra])).toThrow();
});

function storedSource(values: SQLInputValue[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sources(id,authority,dataset,version,retrieved_at,url,license,content_hash)");
  db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)").run(...values);
  return db;
}
const row = [source.id, source.authority, source.dataset, source.version, source.retrievedAt, source.url, source.license, source.contentHash];

it("adapts database fields into validated provenance without altering retrieval dates", () => {
  const db = storedSource(row);
  try { expect(readPreparedSources(db)).toEqual([source]); } finally { db.close(); }
});

it.each([
  [0, null], [1, 123], [2, ""], [3, ""], [4, "not a date"],
  [5, "not a URL"], [6, ""], [7, "not a digest"],
] as const)("rejects malformed stored provenance field %i without coercion", (index, value) => {
  const malformed: SQLInputValue[] = [...row]; malformed[index] = value;
  const db = storedSource(malformed);
  try { expect(() => readPreparedSources(db)).toThrow("Complete graph source differs:"); } finally { db.close(); }
});
