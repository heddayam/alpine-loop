import { z } from "zod";
import { gradeExperienceConstraintsSchema } from "./routes";

export const gradePresetIdSchema = z.enum(["gentle", "moderate", "steep"]);

export const gradePresetsSchema = z.object({
  gentle: gradeExperienceConstraintsSchema,
  moderate: gradeExperienceConstraintsSchema,
  steep: gradeExperienceConstraintsSchema,
}).strict();

export const loopOptionDefaultsSchema = z.object({
  maximumRepeatedTrailPct: z.number().int().min(0).max(100),
  sharedApproachEnabled: z.boolean(),
  maximumSharedApproachMiles: z.number().min(0).max(30),
  allowMultiCycle: z.boolean(),
}).strict();

export const appSettingsV1Schema = z.object({
  schemaVersion: z.literal(1),
  includeUncertainAccess: z.boolean(),
  quickSearchRouteCount: z.number().int().min(1).max(20),
  gradeConstraintEnabled: z.boolean(),
  selectedGradePreset: gradePresetIdSchema,
  gradePresets: gradePresetsSchema,
  loopOptions: loopOptionDefaultsSchema,
}).strict();

export type GradePresetId = z.infer<typeof gradePresetIdSchema>;
export type GradePresets = z.infer<typeof gradePresetsSchema>;
export type AppSettingsV1 = z.infer<typeof appSettingsV1Schema>;
