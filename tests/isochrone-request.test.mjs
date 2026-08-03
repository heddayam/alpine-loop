import assert from "node:assert/strict";
import test from "node:test";
import { parseIsochroneRequest } from "../app/api/isochrones/request.ts";

const validRequest = {
  location: { latitude: 39.6403, longitude: -106.3742 },
  travelDuration: "1800s",
  travelMode: "DRIVE",
  travelDirection: "FROM",
  routingPreference: "TRAFFIC_UNAWARE",
  enableSmoothing: true,
  polygonFidelity: "MEDIUM",
};

test("accepts and sanitizes a valid Google Isochrones request", () => {
  assert.deepEqual(parseIsochroneRequest({ ...validRequest, ignored: "field" }), {
    ok: true,
    body: validRequest,
  });
});

test("rejects invalid origins before they consume quota", () => {
  assert.deepEqual(
    parseIsochroneRequest({
      ...validRequest,
      location: { latitude: 91, longitude: -106.3742 },
    }),
    {
      ok: false,
      error: "location must contain valid latitude and longitude values.",
    },
  );

  const withTwoOrigins = parseIsochroneRequest({
    ...validRequest,
    place: "places/example",
  });
  assert.equal(withTwoOrigins.ok, false);
});

test("enforces Google's duration limits before they consume quota", () => {
  const drive = parseIsochroneRequest({ ...validRequest, travelDuration: "3601s" });
  const walk = parseIsochroneRequest({
    ...validRequest,
    travelMode: "WALK",
    travelDuration: "7201s",
  });

  assert.equal(drive.ok, false);
  assert.equal(walk.ok, false);
});
