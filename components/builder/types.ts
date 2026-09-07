import { DEFAULT_APP_SETTINGS } from "@/lib/settings/defaults";
import type {
  SearchArea,
  AppSettingsV1,
  GradePresetId,
  GradePresets,
  Origin,
} from "@/lib/contracts";

export type Bounds = Extract<SearchArea, { mode: "drawn-area" }>["bbox"];
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
  distanceMiles: RangeField;
  elevationGainFeet: RangeField;
  maximumElevationFeet: RangeField;
  gradeConstraintEnabled: boolean;
  selectedGradePreset: GradePresetId;
  gradePresets: GradePresets;
  includeUncertainAccess: boolean;
  limit: string;
};

export type DriveTimeDraft = {
  originText: string;
  originSuggestions: Array<{ id: string; label: string; magicKey: string }>;
  origin?: Origin;
  durationMinutes: number;
  state: "idle" | "suggesting" | "resolving" | "error";
  error?: string;
};

export type BuilderDraft = Pick<BuilderValues, "distanceMiles" | "elevationGainFeet" | "maximumElevationFeet">
  & Partial<Pick<BuilderValues, "maximumRepeatedTrailPct" | "maximumSharedStemMiles">>;

export const DEFAULT_BUILDER_DRAFT: BuilderDraft = {
  distanceMiles: { enabled: true, min: "1", max: "4" },
  elevationGainFeet: { enabled: false, min: "0", max: "2500" },
  maximumElevationFeet: { enabled: false, min: "0", max: "4000" },
};

export function builderValues(settings: AppSettingsV1, draft: BuilderDraft): BuilderValues {
  return {
    ...draft,
    includeUncertainAccess: settings.includeUncertainAccess,
    limit: String(settings.quickSearchRouteCount),
    gradeConstraintEnabled: settings.gradeConstraintEnabled,
    selectedGradePreset: settings.selectedGradePreset,
    gradePresets: settings.gradePresets,
    maximumRepeatedTrailPct: draft.maximumRepeatedTrailPct ?? String(settings.loopOptions.maximumRepeatedTrailPct),
    maximumSharedStemEnabled: settings.loopOptions.sharedApproachEnabled,
    maximumSharedStemMiles: draft.maximumSharedStemMiles ?? String(settings.loopOptions.maximumSharedApproachMiles),
    allowMultiCycle: settings.loopOptions.allowMultiCycle,
  };
}

export const DEFAULT_BUILDER_VALUES = builderValues(DEFAULT_APP_SETTINGS, DEFAULT_BUILDER_DRAFT);
