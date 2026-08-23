import { z } from "zod";
import {
  areaGeometrySchema,
  driveTimeDurationSchema,
  type AccessFilterV2,
  type GenerateClosedRoutesResponseV3,
  type NamedArea,
  type NamedAreaSummary,
} from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import type { ResolvedAccessFilterContext } from "@/lib/solver";
import { ServerApiError } from "./api-error";

export type ResolvedReachability = {
  geometry: AreaGeometry;
  durationMinutes: number;
  resolvedAt: string;
  originLabel: string;
};

export type ReachabilityResolver = (
  id: string,
  packId: string,
  signal?: AbortSignal,
) => Promise<ResolvedReachability>;

export type NamedAreaCatalog = {
  searchNamedAreas?: (text: string, limit?: number) => NamedAreaSummary[] | Promise<NamedAreaSummary[]>;
  getNamedArea?: (id: string) => NamedArea | null | Promise<NamedArea | null>;
};

export type FilterablePack = NamedAreaCatalog & {
  id: string;
  coverage: AreaGeometry;
};

export type ResolvedServerAccessFilter = ResolvedAccessFilterContext & {
  filterGeometry: AreaGeometry;
  refinementGeometry?: AreaGeometry;
};

const resolvedReachabilitySchema = z.object({
  geometry: areaGeometrySchema,
  durationMinutes: driveTimeDurationSchema,
  resolvedAt: z.string().datetime(),
  originLabel: z.string().trim().min(1).max(240),
}).strict();

function drawnGeometry([west, south, east, north]: Extract<AccessFilterV2, { mode: "drawn-area" }>["bbox"]): AreaGeometry {
  return {
    type: "Polygon",
    coordinates: [[
      [west, south], [east, south], [east, north], [west, north], [west, south],
    ]],
  };
}

export function resolvedDrawnAreaAccessFilter(
  pack: Pick<FilterablePack, "coverage">,
  bbox: Extract<AccessFilterV2, { mode: "drawn-area" }>["bbox"],
): ResolvedServerAccessFilter {
  const geometry = drawnGeometry(bbox);
  return {
    summary: { mode: "drawn-area", label: "Drawn area" },
    predicates: [geometry],
    coverage: pack.coverage,
    filterGeometry: geometry,
  };
}

export function resolvedDriveTimeAccessFilter(
  pack: Pick<FilterablePack, "coverage">,
  reachability: ResolvedReachability,
  region: NamedArea,
): ResolvedServerAccessFilter {
  const parsed = resolvedReachabilitySchema.parse(reachability);
  return {
    summary: {
      mode: "drive-time",
      label: `${parsed.durationMinutes} min from ${parsed.originLabel}`,
      region: { id: region.id, name: region.name },
      driveTime: {
        minutes: parsed.durationMinutes,
        provider: "arcgis",
        resolvedAt: parsed.resolvedAt,
        originLabel: parsed.originLabel,
      },
    },
    predicates: [parsed.geometry, region.geometry],
    coverage: pack.coverage,
    filterGeometry: parsed.geometry,
    refinementGeometry: region.geometry,
  };
}

export function resolvedNamedRegionAccessFilter(
  pack: Pick<FilterablePack, "coverage">,
  region: NamedArea,
): ResolvedServerAccessFilter {
  return {
    summary: { mode: "named-region", label: region.name, region: { id: region.id, name: region.name } },
    predicates: [region.geometry],
    coverage: pack.coverage,
    filterGeometry: region.geometry,
  };
}

async function requireNamedArea(pack: FilterablePack, regionId: string): Promise<NamedArea> {
  if (!pack.getNamedArea) {
    throw new ServerApiError("NAMED_AREAS_UNAVAILABLE", "This installed pack does not provide named regions.", 422);
  }
  const area = await pack.getNamedArea(regionId);
  if (!area) throw new ServerApiError("NAMED_AREA_NOT_FOUND", `Named region '${regionId}' was not found in this pack.`, 404);
  return area;
}

function reachabilityError(error: unknown): ServerApiError {
  if (error instanceof ServerApiError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "REACHABILITY_NOT_FOUND") {
    return new ServerApiError(code, "That drive-time area was not found. Calculate it again.", 404);
  }
  if (code === "REACHABILITY_EXPIRED") {
    return new ServerApiError(code, "That drive-time area expired. Calculate it again.", 410);
  }
  if (code === "REACHABILITY_PENDING") {
    return new ServerApiError(code, "That drive-time area is still being calculated.", 409);
  }
  if (code === "REACHABILITY_PACK_MISMATCH") {
    return new ServerApiError(code, "That drive-time area belongs to a different installed pack.", 422);
  }
  return new ServerApiError("REACHABILITY_UNAVAILABLE", "The drive-time area could not be resolved.", 503);
}

export async function resolveAccessFilter(
  pack: FilterablePack,
  filter: AccessFilterV2,
  resolveReachability: ReachabilityResolver,
  signal?: AbortSignal,
): Promise<ResolvedServerAccessFilter> {
  if (filter.mode === "drawn-area") {
    return resolvedDrawnAreaAccessFilter(pack, filter.bbox);
  }
  if (filter.mode === "named-region") {
    const area = await requireNamedArea(pack, filter.regionId);
    return resolvedNamedRegionAccessFilter(pack, area);
  }

  let rawReachability: ResolvedReachability;
  try {
    rawReachability = await resolveReachability(filter.reachabilityId, pack.id, signal);
  } catch (error) {
    if ((error instanceof DOMException && error.name === "AbortError")
      || (error instanceof Error && error.name === "AbortError")) throw error;
    throw reachabilityError(error);
  }
  const parsed = resolvedReachabilitySchema.safeParse(rawReachability);
  if (!parsed.success) {
    throw new ServerApiError("INVALID_REACHABILITY", "The resolved drive-time area is malformed.", 502);
  }
  const reachability = parsed.data;
  const region = filter.regionId ? await requireNamedArea(pack, filter.regionId) : undefined;
  const summary: GenerateClosedRoutesResponseV3["resolvedAccessFilter"] = {
    mode: "drive-time",
    label: `${reachability.durationMinutes} min from ${reachability.originLabel}`,
    ...(region ? { region: { id: region.id, name: region.name } } : {}),
    driveTime: {
      minutes: reachability.durationMinutes,
      provider: "arcgis",
      resolvedAt: reachability.resolvedAt,
      originLabel: reachability.originLabel,
    },
  };
  return {
    summary,
    predicates: [reachability.geometry, ...(region ? [region.geometry] : [])],
    coverage: pack.coverage,
    filterGeometry: reachability.geometry,
    ...(region ? { refinementGeometry: region.geometry } : {}),
  };
}
