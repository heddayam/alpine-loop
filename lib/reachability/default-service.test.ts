import { describe, expect, it } from "vitest";
import { arcGisKeys } from "./default-service";

describe("ArcGIS server credential selection", () => {
  it("prefers scoped keys and falls back independently to ARCGIS_API_KEY", () => {
    expect(arcGisKeys({
      ARCGIS_API_KEY: "fallback",
      ARCGIS_GEOCODING_API_KEY: "geocoding",
      ARCGIS_ROUTING_API_KEY: "routing",
    })).toEqual({ geocodingApiKey: "geocoding", routingApiKey: "routing" });
    expect(arcGisKeys({ ARCGIS_API_KEY: "fallback" })).toEqual({
      geocodingApiKey: "fallback",
      routingApiKey: "fallback",
    });
    expect(arcGisKeys({ ARCGIS_API_KEY: "fallback", ARCGIS_GEOCODING_API_KEY: "geocoding" }))
      .toEqual({ geocodingApiKey: "geocoding", routingApiKey: "fallback" });
  });
});
