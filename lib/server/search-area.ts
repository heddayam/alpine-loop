import { ACCESS_ENTRY_POLICY_VERSION, type SearchArea, type SearchAreaSnapshot, type SearchCatalog, type SearchIntent } from "@/lib/contracts";
import { loadInstallation, withInstallationPins } from "@/lib/coverage-install";
import { areaBounds } from "@/lib/graph";
import { namespacedId } from "@/lib/search/identity";
import { ServerApiError } from "./api-error";
import type { SearchPlan } from "./search-plan";

type AreaGeometry = NonNullable<SearchAreaSnapshot["filterGeometry"]>;
type Bounds = readonly [number, number, number, number];
export type SearchInstallation = NonNullable<Awaited<ReturnType<typeof loadInstallation>>>;

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function eligibleAreaBounds(geometry: AreaGeometry): Bounds {
  return areaBounds(geometry);
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
function selectableRegions({ installation, release }: SearchInstallation) {
  const compatible = new Set(release.artifacts.filter(artifact => installation.artifactIds.includes(artifact.id)
    && artifact.accessPolicyVersion === ACCESS_ENTRY_POLICY_VERSION).map(artifact => artifact.regionId));
  if (release.partitioning === "local-areas") {
    const installed = new Set(installation.sectionIds);
    return release.regions.filter(region => installed.has(region.id) && compatible.has(region.id));
  }
  return release.regions.filter(region => compatible.has(region.id));
}
export async function searchCatalog(): Promise<SearchCatalog> {
  return withPinnedSearchInstallation(async installed => {
    if (!installed) return { regions: [], coverages: [], display: { center: [-122, 38], zoom: 7 } };
    const { installation } = installed;
    const bounds = areaBounds(installation.geometry);
    return {
      regions: selectableRegions(installed).map(({ id, name }) => ({ id, name })),
      coverages: [installation.geometry],
      requiresRebuild: installed.artifacts.some(artifact => artifact.accessPolicyVersion !== ACCESS_ENTRY_POLICY_VERSION),
      display: { center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], zoom: 7 },
    };
  });
}
function namedArea(regionIds: string[], installed: SearchInstallation, restorePinned = false) {
  const available = restorePinned ? installed.release.regions : selectableRegions(installed);
  const regions = [...new Set(regionIds)].map(id => {
    const region = available.find(region => region.id === id || (restorePinned
      && (namespacedId(installed.release.id, region.id) === id || region.aliases.includes(id))));
    if (!region) throw new ServerApiError("REGION_NOT_FOUND", "A selected region is not downloaded or is no longer available. Update your region selection.", 404);
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
    if (!installed.artifacts.some(artifact => artifact.accessPolicyVersion === ACCESS_ENTRY_POLICY_VERSION))
      throw new ServerApiError("DATA_UPDATE_REQUIRED", "Rebuild downloaded coverage to update starting points. Saved results remain available.", 409);
    const area = request.area;
    const named = area.mode !== "drawn-area" ? namedArea(area.regionIds, installed) : undefined;
    const geometry = area.mode === "drawn-area" ? drawnArea(area.bbox) : named?.geometry;
    if (area.mode === "drawn-area" && geometry && !boundsOverlap(areaBounds(installed.routingGeometry), eligibleAreaBounds(geometry))) {
      throw new ServerApiError("AREA_UNAVAILABLE", "No installed data covers the selected area.", 422);
    }
    return {
      installationId: installed.installation.id,
      accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION,
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
  const named = namedArea(area.regionIds, installed, true)!;
  return { ...plan, area: { ...plan.area, ...(area.mode === "named-regions" ? { filterGeometry: named.geometry } : { refinementGeometry: named.geometry }) } };
}
