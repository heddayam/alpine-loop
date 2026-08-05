import { namedAreaSchema, type NamedArea } from "@/lib/contracts";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import type { NormalizedNamedArea } from "./types";

type NamedAreaKind = NamedArea["kind"];

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function compareBbox(first: NamedArea["bbox"], second: NamedArea["bbox"]): boolean {
  return first.every((value, index) => Math.abs(value - second[index]!) <= 1e-10);
}

export function validateAndSortNamedAreas(
  input: readonly NormalizedNamedArea[],
  sourceIds: ReadonlySet<string>,
): NormalizedNamedArea[] {
  const ids = new Set<string>();
  const geometries = new Map<string, string>();
  const result = input.map((candidate) => {
    const geometry = assertValidAreaGeometry(candidate.geometry, `Named area ${candidate.id}`);
    const area = namedAreaSchema.parse({
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      context: candidate.context,
      bbox: candidate.bbox,
      sourceIds: candidate.sourceIds,
      geometry,
    });
    if (ids.has(area.id)) throw new Error(`Duplicate named area ID ${area.id}`);
    ids.add(area.id);
    const geometryKey = JSON.stringify(area.geometry);
    const duplicate = geometries.get(geometryKey);
    if (duplicate) throw new Error(`Named areas ${duplicate} and ${area.id} have duplicate geometry`);
    geometries.set(geometryKey, area.id);
    if (!compareBbox(area.bbox, areaGeometryBounds(area.geometry))) {
      throw new Error(`Named area ${area.id} bbox does not match its geometry`);
    }
    for (const sourceId of area.sourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`Named area ${area.id} references unknown source ${sourceId}`);
    }
    const aliasMap = new Map<string, string>();
    for (const alias of [area.name, ...candidate.aliases].map((value) => value.trim()).filter(Boolean)) {
      const key = normalizedSearchText(alias);
      if (!aliasMap.has(key)) aliasMap.set(key, alias);
    }
    const aliases = [...aliasMap.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([, alias]) => alias);
    return { ...area, aliases };
  });
  return result.sort((first, second) => first.id.localeCompare(second.id));
}

export function namedAreaSearchKey(value: string): string {
  return normalizedSearchText(value);
}

export function osmNamedAreaKind(tags: Readonly<Record<string, string>>): NamedAreaKind | null {
  if (tags.boundary === "administrative" && tags.admin_level === "6") return "county";
  if (tags.boundary === "administrative" && ["8", "9", "10"].includes(tags.admin_level ?? "")) return "city";
  if (tags.leisure === "park" || tags.boundary === "national_park") return "park";
  if (tags.leisure === "nature_reserve" || /preserve/i.test(tags.name ?? "")) return "preserve";
  if (tags.boundary === "protected_area" || tags.protect_class || tags.landuse === "conservation") return "protected-area";
  return null;
}

export function aliasesFromOsmTags(tags: Readonly<Record<string, string>>): string[] {
  return ["alt_name", "short_name", "official_name", "old_name", "loc_name"]
    .flatMap((key) => (tags[key] ?? "").split(";").map((value) => value.trim()))
    .filter(Boolean);
}
