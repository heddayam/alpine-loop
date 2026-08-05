import type {
  AccessFilterV2,
  SearchEffortV3,
  NamedArea,
  NamedAreaSummary,
  Origin,
} from "@/lib/contracts";

export type Bounds = Extract<AccessFilterV2, { mode: "drawn-area" }>["bbox"];
export type FilterMode = AccessFilterV2["mode"];

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
  maximumRepeatedTrailPct: string;
  maximumSharedStemEnabled: boolean;
  maximumSharedStemMiles: string;
  allowMultiCycle: boolean;
  searchEffort: SearchEffortV3;
  distanceMiles: RangeField;
  elevationGainFeet: RangeField;
  maximumElevationFeet: RangeField;
  steepestSustainedGradePct: RangeField;
  includeUncertainAccess: boolean;
  limit: string;
};

export type DrawnAreaDraft = { bounds: Bounds | null };

export type NamedRegionDraft = {
  query: string;
  suggestions: NamedAreaSummary[];
  selected?: NamedArea;
  state: "idle" | "searching" | "loading" | "ready" | "error";
  error?: string;
};

export type DriveTimeDraft = {
  originText: string;
  originSuggestions: Array<{ id: string; label: string; magicKey: string }>;
  origin?: Origin;
  durationMinutes: number;
  requestId?: string;
  geometry?: NamedArea["geometry"];
  state: "idle" | "suggesting" | "resolving" | "calculating" | "ready" | "error";
  error?: string;
  refinement: NamedRegionDraft;
};

export const EMPTY_NAMED_REGION_DRAFT: NamedRegionDraft = {
  query: "",
  suggestions: [],
  state: "idle",
};

export const DEFAULT_BUILDER_VALUES: BuilderValues = {
  maximumRepeatedTrailPct: "35",
  maximumSharedStemEnabled: false,
  maximumSharedStemMiles: "2",
  allowMultiCycle: true,
  searchEffort: "thorough",
  distanceMiles: { enabled: true, min: "1", max: "4" },
  elevationGainFeet: { enabled: false, min: "0", max: "2500" },
  maximumElevationFeet: { enabled: false, min: "0", max: "4000" },
  steepestSustainedGradePct: { enabled: false, min: "0", max: "20" },
  includeUncertainAccess: true,
  limit: "10",
};
