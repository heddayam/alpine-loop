import { expect, it } from "vitest";
import { parseCoordinates } from "../../src/client/coordinates.js";

it("accepts common formats and returns longitude, latitude for the map", () => {
  for (const text of ["47.5, -121.5", "47.5 -121.5", "(47.5, −121.5)", "47.5; -121.5",
    "47.5 N, 121.5 W", "N47.5 W121.5", "121.5W 47.5N", "47° 30′ N 121° 30′ W",
    '47°30\'0"N, 121°30\'0"W', "47 30, -121 30"])
    expect(parseCoordinates(text), text).toEqual([-121.5, 47.5]);
  expect(parseCoordinates("0, 0")).toEqual([0, 0]);
  expect(parseCoordinates("33°30'S 151°12'E")).toEqual([151.2, -33.5]);
  expect(parseCoordinates("-0 30, 0")).toEqual([0, -0.5]);
});

it("rejects out-of-range, contradictory, incomplete and trailing input", () => {
  for (const text of ["", "47", "91, 0", "0, -181", "NaN, 0", "47.5, -121.5 extra",
    "47N 121N", "-47N 121W", "47N -121.5", "47°60'N 121W", "47°30'60\"N 121W",
    "47.5°30'N 121W", "47N 121W 5", "N47N W121", "47,,121"])
    expect(parseCoordinates(text), text).toBeNull();
});
