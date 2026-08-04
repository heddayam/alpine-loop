import type { GenerateRoutesRequestV1 } from "@/lib/contracts";

export type Bounds = GenerateRoutesRequestV1["bbox"];

export type AccessPointOption = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  kind: "trailhead" | "parking" | "transit";
  accessState: "public" | "unknown";
  confidence: "high" | "medium" | "low";
};

export type RangeField = {
  enabled: boolean;
  min: string;
  max: string;
};

export type BuilderValues = {
  routeTypes: GenerateRoutesRequestV1["routeTypes"];
  distanceMiles: RangeField;
  elevationGainFeet: RangeField;
  maximumElevationFeet: RangeField;
  steepestSustainedGradePct: RangeField;
  includeUncertainAccess: boolean;
  limit: string;
};

export const DEFAULT_BUILDER_VALUES: BuilderValues = {
  routeTypes: ["loop"],
  distanceMiles: { enabled: true, min: "2", max: "8" },
  elevationGainFeet: { enabled: false, min: "0", max: "2500" },
  maximumElevationFeet: { enabled: false, min: "0", max: "4000" },
  steepestSustainedGradePct: { enabled: false, min: "0", max: "20" },
  includeUncertainAccess: false,
  limit: "10",
};
