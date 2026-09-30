import { expect, test } from "vitest";
import { PreparedEdgeCache } from "./prepared-edge-cache";
import type { SqliteRow } from "./sqlite-records";

const row: SqliteRow = {
  id: "edge", edge_key: 1, physical_edge_key: 1, from_node: "a", to_node: "b",
  geometry: "[[0,0],[1,1]]", length_m: 100, gain_m: 0, loss_m: 0, max_elevation_m: 0,
  max_sustained_grade_pct: 0, elevation_profile: null, access_state: "public", edge_class: "trail",
  flags: "[]", source_refs: "[]",
};

test("byte accounting evicts least recently used decoded edges", () => {
  const cache = new PreparedEdgeCache(2_200);
  const first = cache.read("a", row);
  const secondRow = { ...row, id: "second" };
  const second = cache.read("a", secondRow);
  expect(cache.read("a", row)).toBe(first);
  cache.read("a", { ...row, id: "third" });
  expect(cache.read("a", row)).toBe(first);
  expect(cache.read("a", secondRow)).not.toBe(second);
});

test("oversized geometry is not retained and does not evict useful rows", () => {
  const cache = new PreparedEdgeCache(2_200);
  const ordinary = cache.read("a", row);
  const long = { ...row, id: "long", geometry: JSON.stringify(Array.from({ length: 100 }, (_, i) => [i, i])) };
  expect(cache.read("a", long)).not.toBe(cache.read("a", long));
  expect(cache.read("a", row)).toBe(ordinary);
});

test("artifact identities isolate matching edge IDs; eviction and close release entries", () => {
  const cache = new PreparedEdgeCache();
  const first = cache.read("first", row);
  const second = cache.read("second", { ...row, length_m: 200 });
  expect(second.lengthMeters).toBe(200);
  expect(first.lengthMeters).toBe(100);
  cache.forget("first");
  expect(cache.read("second", row)).toBe(second);
  expect(cache.read("first", row)).not.toBe(first);
  cache.clear();
  expect(cache.read("second", row)).not.toBe(second);
});

test("a large byte allowance still bounds the number of entries", () => {
  const cache = new PreparedEdgeCache(Number.MAX_SAFE_INTEGER);
  const first = cache.read("a", row);
  for (let index = 0; index < 16_384; index++) cache.read("a", { ...row, id: `edge-${index}` });
  expect(cache.read("a", row)).not.toBe(first);
});

test("corrupt records fail before entering the cache", () => {
  const cache = new PreparedEdgeCache();
  expect(() => cache.read("a", { ...row, geometry: "invalid" })).toThrow("geometry");
  expect(cache.read("a", row).coordinates).toEqual([[0, 0], [1, 1]]);
});

test("untyped metadata cannot invalidate byte accounting", () => {
  const cache = new PreparedEdgeCache();
  const malformed = { ...row, source_refs: '[{"nested":"metadata"}]' };
  expect(cache.read("a", malformed)).not.toBe(cache.read("a", malformed));
});
