import assert from "node:assert/strict";
import test from "node:test";
import {
  REACHABILITY_DURATIONS,
  formatDuration,
  parseReachabilityRequest,
  providerForDuration,
  reachabilityRequestKey,
} from "../app/reachability.ts";

test("uses adaptive steps through five hours", () => {
  assert.deepEqual(REACHABILITY_DURATIONS.slice(0, 4), [5, 10, 15, 20]);
  assert.equal(REACHABILITY_DURATIONS.includes(60), true);
  assert.equal(REACHABILITY_DURATIONS.includes(75), true);
  assert.equal(REACHABILITY_DURATIONS.includes(180), true);
  assert.equal(REACHABILITY_DURATIONS.at(-1), 300);
  assert.equal(REACHABILITY_DURATIONS.includes(65), false);
});

test("formats minute and hour durations", () => {
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(60), "1 hr");
  assert.equal(formatDuration(90), "1 hr 30 min");
  assert.equal(formatDuration(300), "5 hr");
});

test("dispatches 60 minutes to Google and long ranges to ArcGIS", () => {
  assert.equal(providerForDuration(60), "google");
  assert.equal(providerForDuration(75), "arcgis");
  assert.deepEqual(
    parseReachabilityRequest({ latitude: 37.7, longitude: -122.4, durationMinutes: 300 }),
    {
      ok: true,
      request: {
        latitude: 37.7,
        longitude: -122.4,
        durationMinutes: 300,
        provider: "arcgis",
      },
    },
  );
});

test("rejects invalid coordinates and unsupported duration gaps", () => {
  for (const candidate of [
    { latitude: 91, longitude: 0, durationMinutes: 75 },
    { latitude: 37, longitude: -181, durationMinutes: 75 },
    { latitude: 37, longitude: -122, durationMinutes: 65 },
    { latitude: 37, longitude: -122, durationMinutes: 301 },
  ]) {
    assert.equal(parseReachabilityRequest(candidate).ok, false);
  }
});

test("normalizes request keys for job reuse", () => {
  assert.equal(
    reachabilityRequestKey({
      latitude: 37.7749001,
      longitude: -122.4194001,
      durationMinutes: 75,
      provider: "arcgis",
    }),
    "37.77490:-122.41940:75",
  );
});
