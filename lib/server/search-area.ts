import type { SearchArea, SearchAreaSnapshot, SearchCatalog, SearchIntent } from "@/lib/contracts";
import { loadInstallation, withInstallationPins } from "@/lib/coverage-install";
import { areaBounds } from "@/lib/graph";
import { PORTAL_NAMED_REGION_TOLERANCE_M } from "@/lib/solver";
import { namespacedId } from "@/lib/search/identity";
import { ServerApiError } from "./api-error";
import type { SearchPlan } from "./search-plan";

type AreaGeometry = NonNullable<SearchAreaSnapshot["filterGeometry"]>;
type Bounds = readonly [number, number, number, number];
export type SearchInstallation = NonNullable<Awaited<ReturnType<typeof loadInstallation>>>;

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function eligibleAreaBounds(geometry: AreaGeometry, namedRegion: boolean): Bounds {
  const bounds = areaBounds(geometry);
  if (!namedRegion) return bounds;
  const latitude = PORTAL_NAMED_REGION_TOLERANCE_M / 110_000;
  const longitude = latitude / Math.max(0.01, Math.cos(Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])) * Math.PI / 180));
  return [bounds[0] - longitude, bounds[1] - latitude, bounds[2] + longitude, bounds[3] + latitude];
}
export function combineAreas(areas: AreaGeometry[]): AreaGeometry {
  if (areas.length === 1) return areas[0]!;
  return { type: "MultiPolygon", coordinates: areas.flatMap(area => area.type === "Polygon" ? [area.coordinates] : area.coordinates) };
}
export function drawnArea([west, south, east, north]: Bounds): AreaGeometry {
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

/** The pin spans every catalog/map read, including lazy SQLite handle opens. */
export async function withPinnedSearchInstallation<T>(read: (installed: SearchInstallation | null) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const installed = await loadInstallation();
    if (!installed) return read(null);
    try { return await withInstallationPins([installed.installation.id], () => read(installed)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt) throw error;
    }
  }
  throw new Error("Installed coverage changed during discovery.");
}
export async function searchCatalog(): Promise<SearchCatalog> {
  return withPinnedSearchInstallation(async installed => {
    if (!installed) return { regions: [], coverages: [], display: { center: [-122, 38], zoom: 7 } };
    const { installation, release } = installed;
    const bounds = areaBounds(installation.geometry);
    return {
      regions: release.regions.filter(region => boundsOverlap(bounds, eligibleAreaBounds(region.geometry, true)))
        .map(({ id, name }) => ({ id: namespacedId(release.id, id), name })),
      coverages: [installation.geometry],
      display: { center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], zoom: 7 },
    };
  });
}
function namedArea(regionIds: string[], installed: SearchInstallation) {
  const regions = [...new Set(regionIds)].map(id => {
    const region = installed.release.regions.find(region => region.id === id
      || namespacedId(installed.release.id, region.id) === id || region.aliases.includes(id));
    if (!region) throw new ServerApiError("REGION_NOT_FOUND", "The selected region is unavailable.", 404);
    return region;
  });
  return regions.length ? {
    geometry: combineAreas(regions.map(({ geometry }) => geometry)), label: regions.map(({ name }) => name).join(", "),
  } : undefined;
}

export async function resolveSearchPlan(request: SearchIntent, signal: AbortSignal): Promise<SearchPlan> {
  signal.throwIfAborted();
  return withPinnedSearchInstallation(async installed => {
    signal.throwIfAborted();
    if (!installed) throw new ServerApiError("DATA_UNAVAILABLE", "Install prepared coverage sections before searching.", 503);
    const area = request.area;
    const named = area.mode !== "drawn-area" ? namedArea(area.regionIds, installed) : undefined;
    const geometry = area.mode === "drawn-area" ? drawnArea(area.bbox) : named?.geometry;
    if (geometry && !boundsOverlap(areaBounds(installed.installation.geometry), eligibleAreaBounds(geometry, area.mode !== "drawn-area"))) {
      throw new ServerApiError("AREA_UNAVAILABLE", "No installed data covers the selected area.", 422);
    }
    return {
      installationId: installed.installation.id,
      area: area.mode === "drive-time"
        ? { label: `${area.minDurationMinutes ?? 0}–${area.durationMinutes} min from ${area.origin.label}${named ? ` · ${named.label}` : ""}`, ...(named ? { refinementGeometry: named.geometry } : {}) }
        : { label: area.mode === "drawn-area" ? "Drawn area" : named!.label, filterGeometry: geometry! },
    };
  });
}

export function executableInstallationId(plan: SearchPlan): string {
  if (!plan.installationId) throw new ServerApiError("DATA_UNAVAILABLE",
    "This saved search uses legacy data. Install prepared coverage and start a new search; saved results remain available.", 409);
  return plan.installationId;
}

/** Recover missing area metadata only from the immutable pinned release. */
export async function restorePlanArea(area: SearchArea, plan: SearchPlan): Promise<SearchPlan> {
  const id = executableInstallationId(plan);
  if (area.mode === "drawn-area") return { ...plan, area: { ...plan.area, filterGeometry: drawnArea(area.bbox) } };
  if (!area.regionIds.length || (area.mode === "named-regions" ? plan.area.filterGeometry : plan.area.refinementGeometry)) return plan;
  const installed = await loadInstallation(undefined, id);
  if (!installed) throw new ServerApiError("DATA_UNAVAILABLE", "The saved installation is unavailable. Start a new search.", 503);
  const named = namedArea(area.regionIds, installed)!;
  return { ...plan, area: { ...plan.area, ...(area.mode === "named-regions" ? { filterGeometry: named.geometry } : { refinementGeometry: named.geometry }) } };
}
