import { z } from "zod";
import { isoDateSchema } from "./common";
import { areaGeometrySchema, bboxSchema } from "./routes";

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

export const availableRegionPackSchema = z.object({
  id: regionIdSchema,
  name: z.string().min(1),
  dataVersion: z.string().min(1),
  builtAt: isoDateSchema,
  coverageBbox: bboxSchema,
  coverage: areaGeometrySchema,
  display: z.object({
    center: z.tuple([z.number().finite(), z.number().finite()]),
    zoom: z.number().finite(),
  }).strict(),
}).strict();

const catalogRegionBase = {
  id: regionIdSchema,
  label: z.string().min(1),
  displayOrder: z.number().int().positive(),
};

export const packCatalogRegionV1Schema = z.discriminatedUnion("state", [
  z.object({ ...catalogRegionBase, state: z.literal("planned") }).strict(),
  z.object({ ...catalogRegionBase, state: z.literal("unavailable"), packId: regionIdSchema }).strict(),
  z.object({
    ...catalogRegionBase,
    state: z.literal("available"),
    packId: regionIdSchema,
    pack: availableRegionPackSchema,
  }).strict(),
]);

export const packCatalogResponseV1Schema = z.object({
  version: z.literal(1),
  regions: z.array(packCatalogRegionV1Schema).min(1),
}).strict();

export type RegionRegistryEntryV1 = z.infer<typeof regionRegistryEntryV1Schema>;
export type RegionRegistryV1 = z.infer<typeof regionRegistryV1Schema>;
export type AvailableRegionPack = z.infer<typeof availableRegionPackSchema>;
export type PackCatalogRegionV1 = z.infer<typeof packCatalogRegionV1Schema>;
export type PackCatalogResponseV1 = z.infer<typeof packCatalogResponseV1Schema>;
