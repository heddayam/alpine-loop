import { readFile } from "node:fs/promises";
import { z } from "zod";
import { areaGeometrySchema } from "@/lib/contracts";
import { contentId } from "./geometry";
import { sourceRecipeSchema } from "./recipe";

export const NETWORK_DISCOVERY_VERSION = "connected-networks-v2";
export const trailNetworkSchema = z.object({
  id: z.string().regex(/^network-[a-f0-9]{32}$/),
  root: z.string().min(1),
  geometry: areaGeometrySchema,
  nodeCount: z.number().int().positive(),
  physicalEdgeCount: z.number().int().positive(),
  lengthMeters: z.number().nonnegative().finite(),
  cycleRank: z.number().int().nonnegative(),
  sourceBoundaryLimited: z.boolean(),
}).strict();
export const networkCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  discoveryVersion: z.literal(NETWORK_DISCOVERY_VERSION),
  id: z.string().regex(/^discovery-[a-f0-9]{32}$/),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  recipe: sourceRecipeSchema,
  inventory: z.object({file: z.literal("inventory.sqlite"), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict(),
  networks: z.array(trailNetworkSchema),
}).strict().superRefine((catalog, context) => {
  if (new Set(catalog.networks.map(network => network.id)).size !== catalog.networks.length)
    context.addIssue({code: "custom", message: "Duplicate network IDs in discovery catalog"});
  const {id, ...contents} = catalog;
  if (id !== networkCatalogId(contents))
    context.addIssue({code: "custom", message: "Discovery catalog identity failed verification"});
});
export type TrailNetwork = z.infer<typeof trailNetworkSchema>;
export type NetworkCatalog = z.infer<typeof networkCatalogSchema>;
export function networkCatalogId(contents: Omit<NetworkCatalog, "id">): string {
  return `discovery-${contentId(contents).slice(0, 32)}`;
}
/** Metadata-only inspection. Builds additionally verify the inventory and current inputs. */
export async function readNetworkCatalog(file: string): Promise<NetworkCatalog> {
  return networkCatalogSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
