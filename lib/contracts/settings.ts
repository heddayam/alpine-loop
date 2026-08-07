import { z } from "zod";
import { accessPointRemotenessSelectionSchema, gradeExperienceConstraintsSchema } from "./routes";

export const gradePresetIdSchema = z.enum(["gentle", "moderate", "steep"]);

export const gradePresetsSchema = z.object({
  gentle: gradeExperienceConstraintsSchema,
  moderate: gradeExperienceConstraintsSchema,
  steep: gradeExperienceConstraintsSchema,
}).strict();

export const appSettingsV1Schema = z.object({
  schemaVersion: z.literal(1),
  includeUncertainAccess: z.boolean(),
  accessPointRemoteness: accessPointRemotenessSelectionSchema,
  quickSearchRouteCount: z.number().int().min(1).max(20),
  gradeConstraintEnabled: z.boolean(),
  selectedGradePreset: gradePresetIdSchema,
  gradePresets: gradePresetsSchema,
}).strict();

export type GradePresetId = z.infer<typeof gradePresetIdSchema>;
export type GradePresets = z.infer<typeof gradePresetsSchema>;
export type AppSettingsV1 = z.infer<typeof appSettingsV1Schema>;
