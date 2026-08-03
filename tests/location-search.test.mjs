import assert from "node:assert/strict";
import test from "node:test";
import { parseCoordinates } from "../app/location-search.ts";

test("parses comma-separated and space-separated coordinates", () => {
  assert.deepEqual(parseCoordinates("37.7749, -122.4194"), { lat: 37.7749, lng: -122.4194 });
  assert.deepEqual(parseCoordinates("37.7749 -122.4194"), { lat: 37.7749, lng: -122.4194 });
});

test("rejects invalid coordinate text and out-of-range values", () => {
  assert.equal(parseCoordinates("San Francisco"), null);
  assert.equal(parseCoordinates("91, -122"), null);
  assert.equal(parseCoordinates("37, -181"), null);
});
