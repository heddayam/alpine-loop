import { readFile } from "node:fs/promises";
import path from "node:path";
import registry from "@/data/regions/registry.json";
import type { CoverageCollection, CoverageUnit } from "./types";
import { installationUnits, intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import { assertValidAreaGeometry, type AreaGeometry } from "@/lib/data/area-geometry";
import { readOsmSourceConfig, type OsmSourceConfig } from "@/lib/data/osm/source";

export type CoverageSource = { config: OsmSourceConfig; regionId: string; geometry: CoverageCollection["geometry"] };
/** Geographic review envelopes intentionally independent of old hand-drawn pack interiors. */
const envelopes = [
  { id: "washington-cascades", name: "Washington Cascades", regionId: "north-cascades", bbox: [-122.51, 45.5, -119.78, 49.01], limitations: ["Broad mountain and foothill review envelope, including Washington-side Gorge. Independent trail-inventory review is pending; source completeness is not guaranteed."] },
  { id: "olympic-peninsula", name: "Olympic Peninsula", regionId: "olympic-peninsula", bbox: [-124.8, 46.9, -122.8, 48.5], limitations: ["Beach paths are included where mapped. Tide timing is not modeled.", "Independent trail-inventory and excluded-land review is pending."] },
  { id: "northern-california", name: "Northern California", regionId: "santa-cruz-mountains", bbox: [-123.5, 35.7, -119.5, 39], limitations: ["Broad geographic review envelope. Independent trail-inventory and excluded-land review is pending."] },
] as const;
const providerRegions = [
  { regionId: "north-cascades", boundary: "washington-source.geojson" },
  { regionId: "santa-cruz-mountains", boundary: "norcal-source.geojson" },
] as const;
async function boundary(file: string): Promise<AreaGeometry> {
  const feature = JSON.parse(await readFile(path.resolve("data/coverage", file), "utf8")) as { geometry: unknown };
  return assertValidAreaGeometry(feature.geometry, file);
}
export type CoverageExclusion = { id: string; geometry: AreaGeometry };
export async function coverageExclusions(): Promise<CoverageExclusion[]> {
  return [{ id: "yakama-reservation", geometry: await boundary("yakama-exclusion.geojson") }];
}
export async function coverageSources(): Promise<CoverageSource[]> {
  return Promise.all(providerRegions.map(async ({ regionId, boundary: file }) => ({
    config: await readOsmSourceConfig(path.resolve(`data/regions/${regionId}/osm-source.json`)),
    regionId, geometry: await boundary(file),
  })));
}
export async function collections(): Promise<CoverageCollection[]> {
  const [sources, exclusions] = await Promise.all([coverageSources(), coverageExclusions()]);
  return envelopes.map((entry) => {
    const desired = rectangle(entry.bbox);
    const geometry = entry.id === "washington-cascades" ? subtractCoverage(desired, exclusions[0]!.geometry)! : desired;
    return { id: entry.id, name: entry.name, geometry,
      sourceIds: sources.filter((source) => intersectCoverage(geometry, source.geometry)).map((source) => source.config.id),
      limitations: [...entry.limitations, ...(entry.id === "washington-cascades" ? ["Yakama Reservation remains explicitly excluded pending separate authority-backed access review."] : [])],
    };
  });
}
/** Split before tiling: a border cell never marks its unsupported part installed. */
export function planCoverageGeometry(requested: AreaGeometry, sources: readonly Pick<CoverageSource, "geometry">[], exclusions: readonly CoverageExclusion[]) {
  let eligible: AreaGeometry | null = requested;
  const unavailableParts: AreaGeometry[] = [];
  const units: CoverageUnit[] = [];
  for (const exclusion of exclusions) {
    if (!eligible) break;
    const part = intersectCoverage(eligible, exclusion.geometry);
    if (!part) continue;
    unavailableParts.push(part);
    units.push(...installationUnits(part).map((unit) => ({ ...unit, status: "unavailable" as const, reason: `intentionally-excluded:${exclusion.id}` })));
    eligible = subtractCoverage(eligible, exclusion.geometry);
  }
  const support = sources.length ? unionCoverage(sources.map((source) => source.geometry)) : null;
  const supported = eligible && support ? intersectCoverage(eligible, support) : null;
  const unsupported = eligible && support ? subtractCoverage(eligible, support) : eligible;
  if (supported) units.push(...installationUnits(supported));
  if (unsupported) {
    unavailableParts.push(unsupported);
    units.push(...installationUnits(unsupported).map((unit) => ({ ...unit, status: "unavailable" as const, reason: "outside-configured-source-coverage" })));
  }
  return { supported, unavailable: unavailableParts.length ? unionCoverage(unavailableParts) : null, units: units.sort((a, b) => a.id.localeCompare(b.id)) };
}
export const legacyRegionIds = registry.regions.filter((region) => "packId" in region).map((region) => region.id);
