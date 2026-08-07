import type {
  AccessPointRemoteness,
  AccessFilterV2,
  GradePresetId,
  GradePresets,
  Origin,
  SearchRegionSummary,
} from "@/lib/contracts";
import type { RemotenessClass } from "@/lib/data/remoteness";

export type Bounds = Extract<AccessFilterV2, { mode: "drawn-area" }>["bbox"];
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
  gradeConstraintEnabled: boolean;
  selectedGradePreset: GradePresetId;
  gradePresets: GradePresets;
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
  gradeConstraintEnabled: false,
  selectedGradePreset: "moderate",
  gradePresets: {
    gentle: { maximumClimbP90Pct: 8, maximumSteepClimbingSharePct: 5, maximumSteepRunMiles: 0.1, maximumDescentP90Pct: 10 },
    moderate: { maximumClimbP90Pct: 12, maximumSteepClimbingSharePct: 20, maximumSteepRunMiles: 0.5, maximumDescentP90Pct: 15 },
    steep: { maximumClimbP90Pct: 18, maximumSteepClimbingSharePct: 50, maximumSteepRunMiles: 1.5, maximumDescentP90Pct: 22 },
  },
  includeUncertainAccess: true,
  accessPointRemoteness: ["remote", "unknown"],
  limit: "10",
};
