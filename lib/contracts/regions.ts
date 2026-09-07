import { z } from "zod";

const regionIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const regionRegistryEntryV1Schema = z.object({
  id: regionIdSchema,
  label: z.string().trim().min(1),
  displayOrder: z.number().int().positive(),
  packId: regionIdSchema.optional(),
}).strict();

export const regionRegistryV1Schema = z.object({
  version: z.literal(1),
  regions: z.array(regionRegistryEntryV1Schema).min(1),
}).strict().superRefine(({ regions }, context) => {
  const ids = new Set<string>();
  const displayOrders = new Set<number>();
  for (const [index, region] of regions.entries()) {
    if (ids.has(region.id)) {
      context.addIssue({ code: "custom", message: `Duplicate region id '${region.id}'`, path: ["regions", index, "id"] });
    }
    if (displayOrders.has(region.displayOrder)) {
      context.addIssue({ code: "custom", message: `Duplicate region display order ${region.displayOrder}`, path: ["regions", index, "displayOrder"] });
    }
    ids.add(region.id);
    displayOrders.add(region.displayOrder);
  }
});

export type RegionRegistryEntryV1 = z.infer<typeof regionRegistryEntryV1Schema>;
export type RegionRegistryV1 = z.infer<typeof regionRegistryV1Schema>;
