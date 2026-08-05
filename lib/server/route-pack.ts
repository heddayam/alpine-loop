import type { NamedArea, NamedAreaSummary } from "@/lib/contracts";
import type { AreaGeometry, GraphRepository } from "@/lib/graph";

export type RoutePack = {
  id: string;
  schemaVersion: string;
  dataVersion: string;
  builtAt: string;
  coverageBbox: readonly [west: number, south: number, east: number, north: number];
  coverage: AreaGeometry;
  maximumAreaSquareKilometers: number;
  databasePath?: string;
  searchNamedAreas?: (text: string, limit?: number) => NamedAreaSummary[] | Promise<NamedAreaSummary[]>;
  getNamedArea?: (id: string) => NamedArea | null | Promise<NamedArea | null>;
  loadRepository: (signal: AbortSignal) => Promise<GraphRepository>;
};
