import type { AppSettingsV1 } from "@/lib/contracts";

export const DEFAULT_APP_SETTINGS: AppSettingsV1 = {
  schemaVersion: 1,
  includeUncertainAccess: true,
  accessPointRemoteness: ["remote", "unknown"],
  quickSearchRouteCount: 10,
  gradeConstraintEnabled: false,
  selectedGradePreset: "moderate",
  loopOptions: {
    maximumRepeatedTrailPct: 35,
    sharedApproachEnabled: false,
    maximumSharedApproachMiles: 2,
    allowMultiCycle: true,
  },
  gradePresets: {
    gentle: {
      maximumClimbP90Pct: 8,
      maximumSteepClimbingSharePct: 5,
      maximumSteepRunMiles: 0.1,
      maximumDescentP90Pct: 10,
    },
    moderate: {
      maximumClimbP90Pct: 12,
      maximumSteepClimbingSharePct: 20,
      maximumSteepRunMiles: 0.5,
      maximumDescentP90Pct: 15,
    },
    steep: {
      maximumClimbP90Pct: 18,
      maximumSteepClimbingSharePct: 50,
      maximumSteepRunMiles: 1.5,
      maximumDescentP90Pct: 22,
    },
  },
};

export function defaultAppSettings(): AppSettingsV1 {
  return structuredClone(DEFAULT_APP_SETTINGS);
}
