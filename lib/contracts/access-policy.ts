/** Semantic admission/selection identity; physical metric caches are independent. */
export const ACCESS_ENTRY_POLICY_VERSION = "pedestrian-entry-v1";

export type EntryWitness = {
  kind: "interface" | "trailhead" | "parking";
  rootNodeId: string;
  departurePhysicalId: string;
  known: boolean;
};
