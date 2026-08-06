import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { NormalizedNamedArea, NormalizedSearchRegion } from "./types";

const searchRegionEntrySchema = z.object({
  namedAreaId: z.string().min(1),
  expectedName: z.string().trim().min(1),
}).strict();

export const searchRegionInputSchema = z.object({
  version: z.literal(1),
  regions: z.array(searchRegionEntrySchema).min(1),
}).strict();

export type SearchRegionInput = z.infer<typeof searchRegionInputSchema>;

const ALLOWED_KINDS = new Set(["pack", "park", "preserve", "protected-area"]);
const CLOSED_AREA_NAME = /\bclosed areas?\b/i;

export async function readSearchRegionInput(filePath: string): Promise<SearchRegionInput> {
  return searchRegionInputSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export function validateSearchRegions(
  input: SearchRegionInput,
  namedAreas: readonly NormalizedNamedArea[],
): NormalizedSearchRegion[] {
  const parsed = searchRegionInputSchema.parse(input);
  const areaById = new Map(namedAreas.map((area) => [area.id, area]));
  const seen = new Set<string>();
  return parsed.regions.map((entry, displayOrder) => {
    if (seen.has(entry.namedAreaId)) throw new Error(`Duplicate search region ${entry.namedAreaId}`);
    seen.add(entry.namedAreaId);
    const area = areaById.get(entry.namedAreaId);
    if (!area) throw new Error(`Search region ${entry.namedAreaId} references an unknown named area`);
    if (area.name !== entry.expectedName) {
      throw new Error(`Search region ${entry.namedAreaId} expected name '${entry.expectedName}' but found '${area.name}'`);
    }
    if (!ALLOWED_KINDS.has(area.kind)) {
      throw new Error(`Search region ${entry.namedAreaId} has unsupported kind ${area.kind}`);
    }
    if (CLOSED_AREA_NAME.test(area.name)) {
      throw new Error(`Search region ${entry.namedAreaId} refers to a closed-area variant`);
    }
    return { namedAreaId: entry.namedAreaId, displayOrder };
  });
}
