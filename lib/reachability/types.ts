import type { Origin, ReachabilityRequest } from "@/lib/contracts";

export type Position = [number, number];
export type LinearRing = Position[];
export type AreaGeometry =
  | { type: "Polygon"; coordinates: LinearRing[] }
  | { type: "MultiPolygon"; coordinates: LinearRing[][] };

export const ESRI_ATTRIBUTION = {
  provider: "arcgis" as const,
  label: "Esri",
  url: "https://www.esri.com/",
};

export type GeocodingSuggestion = {
  id: string;
  label: string;
  magicKey: string;
};

export type GeocodingResult = {
  origin: Origin;
  attribution: typeof ESRI_ATTRIBUTION;
};

export type Clock = {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
};

export type IdGenerator = () => string;

export type ArcGisProvider = {
  suggest(text: string, signal?: AbortSignal): Promise<GeocodingSuggestion[]>;
  resolve(text: string, magicKey: string, signal?: AbortSignal): Promise<Origin>;
  submitServiceArea(request: ReachabilityRequest, signal?: AbortSignal): Promise<string>;
  pollServiceArea(
    providerJobId: string,
    signal?: AbortSignal,
  ): Promise<
    | { state: "pending" }
    | { state: "failed"; message: string }
    | { state: "complete"; geometry: AreaGeometry }
  >;
  cancelServiceArea(providerJobId: string, signal?: AbortSignal): Promise<void>;
};
