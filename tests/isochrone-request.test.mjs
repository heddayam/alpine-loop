import assert from "node:assert/strict";
import test from "node:test";
import { parseIsochroneRequest } from "../app/api/isochrones/request.ts";

test("constructs the fixed outbound driving request", () => {
  assert.deepEqual(
    parseIsochroneRequest({
      latitude: 37.7749,
      longitude: -122.4194,
      durationMinutes: 30,
    }),
    {
      ok: true,
      body: {
        location: { latitude: 37.7749, longitude: -122.4194 },
        travelDuration: "1800s",
        travelMode: "DRIVE",
        travelDirection: "FROM",
        routingPreference: "TRAFFIC_UNAWARE",
        enableSmoothing: true,
        polygonFidelity: "MEDIUM",
      },
    },
  );
});

test("accepts the 5 and 60 minute boundaries", () => {
  assert.equal(
    parseIsochroneRequest({ latitude: 37.7, longitude: -122.4, durationMinutes: 5 }).ok,
    true,
  );
  assert.equal(
    parseIsochroneRequest({ latitude: 37.7, longitude: -122.4, durationMinutes: 60 }).ok,
    true,
  );
});

test("rejects invalid coordinates and unsupported increments", () => {
  for (const body of [
    { latitude: 91, longitude: -122.4, durationMinutes: 30 },
    { latitude: 37.7, longitude: -181, durationMinutes: 30 },
    { latitude: 37.7, longitude: -122.4, durationMinutes: 4 },
    { latitude: 37.7, longitude: -122.4, durationMinutes: 61 },
    { latitude: 37.7, longitude: -122.4, durationMinutes: 33 },
  ]) {
    assert.equal(parseIsochroneRequest(body).ok, false);
  }
});
