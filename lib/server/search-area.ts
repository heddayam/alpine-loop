import type { SearchArea, SearchAreaSnapshot, SearchCatalog, SearchIntent } from "@/lib/contracts";
import { getSearchRegion, listSearchRegions } from "@/lib/data/named-area-catalog";
import { areaBounds } from "@/lib/graph";
import { loadInstalledPackVersion, type InstalledPack } from "@/lib/packs/installed-pack";
import { discoverCatalogPacks } from "@/lib/packs/pack-catalog";
import { PORTAL_NAMED_REGION_TOLERANCE_M } from "@/lib/solver";
import { namespacedId, splitNamespacedId } from "@/lib/search/identity";
import { ServerApiError } from "./api-error";
import type { SearchPlan } from "./search-plan";

type AreaGeometry = NonNullable<SearchAreaSnapshot["filterGeometry"]>;

type Bounds = readonly [number, number, number, number];

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function eligibleAreaBounds(geometry: AreaGeometry, namedRegion: boolean): Bounds {
  const bounds = areaBounds(geometry);
  if (!namedRegion) return bounds;
  // Data selection must include the same near-boundary portals as the engine.
  const latitude = PORTAL_NAMED_REGION_TOLERANCE_M / 110_000;
  const longitude = latitude / Math.max(0.01, Math.cos(Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])) * Math.PI / 180));
  return [bounds[0] - longitude, bounds[1] - latitude, bounds[2] + longitude, bounds[3] + latitude];
}

export function combineAreas(areas: AreaGeometry[]): AreaGeometry {
  if (areas.length === 1) return areas[0]!;
  return { type: "MultiPolygon", coordinates: areas.flatMap((area) => area.type === "Polygon" ? [area.coordinates] : area.coordinates) };
}

export function drawnArea([west, south, east, north]: Bounds): AreaGeometry {
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

export async function installedSearchPacks(): Promise<ReadonlyMap<string, InstalledPack>> {
  return (await discoverCatalogPacks()).installedPacks;
}

export async function searchCatalog(): Promise<SearchCatalog> {
  const packs = [...(await installedSearchPacks()).values()];
  return {
    regions: packs.flatMap(({ manifest, databasePath }) => listSearchRegions(databasePath).map(({ id, name }) => ({
      id: namespacedId(manifest.id, id), name,
    }))),
    coverages: packs.map(({ manifest }) => manifest.coverage.boundary),
    display: packs[0]?.manifest.display ?? { center: [-122, 38], zoom: 7 },
  };
}

async function namedArea(regionIds: string[], packs: ReadonlyMap<string, InstalledPack>) {
  const regions = [...new Set(regionIds)].map((id) => {
    let identity: [string, string];
    try { identity = splitNamespacedId(id); }
    catch { throw new ServerApiError("REGION_NOT_FOUND", "The selected region is unavailable.", 404); }
    const pack = packs.get(identity[0]);
    const region = pack ? getSearchRegion(pack.databasePath, identity[1]) : null;
    if (!region) throw new ServerApiError("REGION_NOT_FOUND", "The selected region is unavailable.", 404);
    return region;
  });
  return regions.length ? { geometry: combineAreas(regions.map(({ geometry }) => geometry)), label: regions.map(({ name }) => name).join(", ") } : undefined;
}

export async function resolveSearchPlan(
  request: SearchIntent,
  signal: AbortSignal,
  packs = installedSearchPacks(),
): Promise<SearchPlan> {
  if (signal.aborted) throw signal.reason;
  const installed = await packs;
  if (!installed.size) throw new ServerApiError("DATA_UNAVAILABLE", "Install regional data before searching.", 503);
  const area = request.area;
  const named = area.mode !== "drawn-area" ? await namedArea(area.regionIds, installed) : undefined;
  const geometry = area.mode === "drawn-area" ? drawnArea(area.bbox) : named?.geometry;
  const selected = [...installed.values()].filter(({ manifest }) => !geometry || boundsOverlap(manifest.coverage.bbox, eligibleAreaBounds(geometry, area.mode !== "drawn-area")));
  if (!selected.length) throw new ServerApiError("AREA_UNAVAILABLE", "No installed data covers the selected area.", 422);
  return {
    packs: selected.map(({ manifest: { id, dataVersion, builtAt } }) => ({ id, dataVersion, builtAt })),
    area: area.mode === "drive-time"
      ? { label: `${area.durationMinutes} min from ${area.origin.label}${named ? ` · ${named.label}` : ""}`, ...(named ? { refinementGeometry: named.geometry } : {}) }
      : { label: area.mode === "drawn-area" ? "Drawn area" : named!.label, filterGeometry: geometry! },
  };
}

/** Older saved jobs may lack a named-area shape; recover it from their pinned data. */
export async function restorePlanArea(area: SearchArea, plan: SearchPlan): Promise<SearchPlan> {
  if (area.mode === "drawn-area") return { ...plan, area: { ...plan.area, filterGeometry: drawnArea(area.bbox) } };
  if (!area.regionIds.length || (area.mode === "named-regions" ? plan.area.filterGeometry : plan.area.refinementGeometry)) return plan;
  const installed = new Map<string, InstalledPack>();
  for (const pack of plan.packs) {
    const value = await loadInstalledPackVersion(pack.id, pack.dataVersion);
    if (value) installed.set(pack.id, value);
  }
  const named = await namedArea(area.regionIds, installed);
  return { ...plan, area: { ...plan.area, ...(area.mode === "named-regions" ? { filterGeometry: named!.geometry } : { refinementGeometry: named!.geometry }) } };
}
