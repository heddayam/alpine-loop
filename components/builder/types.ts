import type {
  AccessPointRemoteness,
  AccessFilterV2,
  Origin,
  SearchRegionSummary,
} from "@/lib/contracts";
import type { RemotenessClass } from "@/lib/data/remoteness";

export type Bounds = Extract<AccessFilterV2, { mode: "drawn-area" }>["bbox"];
export type FilterMode = "explore" | "batch";

export type AccessPointOption = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  kind: "trailhead" | "parking" | "transit";
  accessState: "public" | "unknown";
  confidence: "high" | "medium" | "low";
  /**
   * Measured remoteness. Currently only drives map colouring so the
   * classification can be eyeballed before it becomes a real filter.
   */
  remoteness?: RemotenessClass;
  populationWithinRadius?: number | null;
  localReliefM?: number | null;
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
  distanceMiles: RangeField;
  elevationGainFeet: RangeField;
  maximumElevationFeet: RangeField;
  steepestSustainedGradePct: RangeField;
  includeUncertainAccess: boolean;
  accessPointRemoteness: AccessPointRemoteness[];
  limit: string;
};

export type DrawnAreaDraft = { bounds: Bounds | null };

export type DriveTimeDraft = {
  originText: string;
  originSuggestions: Array<{ id: string; label: string; magicKey: string }>;
  origin?: Origin;
  durationMinutes: number;
  state: "idle" | "suggesting" | "resolving" | "error";
  error?: string;
  searchRegionId: string;
  searchRegions: SearchRegionSummary[];
  regionsState: "idle" | "loading" | "ready" | "error";
};

export const DEFAULT_BUILDER_VALUES: BuilderValues = {
  maximumRepeatedTrailPct: "35",
  maximumSharedStemEnabled: false,
  maximumSharedStemMiles: "2",
  allowMultiCycle: true,
  distanceMiles: { enabled: true, min: "1", max: "4" },
  elevationGainFeet: { enabled: false, min: "0", max: "2500" },
  maximumElevationFeet: { enabled: false, min: "0", max: "4000" },
  steepestSustainedGradePct: { enabled: false, min: "0", max: "20" },
  includeUncertainAccess: true,
  accessPointRemoteness: ["remote", "rural", "populated", "unknown"],
  limit: "10",
};
