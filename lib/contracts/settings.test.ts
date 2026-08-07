import { describe, expect, it } from "vitest";
import { appSettingsV1Schema } from "./settings";

const preset = {
  maximumClimbP90Pct: 12,
  maximumSteepClimbingSharePct: 20,
  maximumSteepRunMiles: 0.5,
  maximumDescentP90Pct: 15,
};

describe("AppSettingsV1", () => {
  it("validates the complete persisted preference snapshot", () => {
    expect(appSettingsV1Schema.safeParse({
      schemaVersion: 1,
      includeUncertainAccess: true,
      accessPointRemoteness: ["remote", "unknown"],
      quickSearchRouteCount: 10,
      gradeConstraintEnabled: false,
      selectedGradePreset: "moderate",
      gradePresets: { gentle: preset, moderate: preset, steep: preset },
    }).success).toBe(true);
  });
});
