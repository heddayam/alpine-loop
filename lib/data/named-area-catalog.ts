import { DatabaseSync } from "node:sqlite";
import {
  namedAreaSchema,
  namedAreaSummarySchema,
  searchRegionSummarySchema,
  type NamedArea,
  type NamedAreaSummary,
  type SearchRegionSummary,
} from "@/lib/contracts";
import { namedAreaSearchKey } from "./named-areas";

type NamedAreaRow = Record<string, unknown>;

function rowSummary(row: NamedAreaRow): NamedAreaSummary {
  return namedAreaSummarySchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    ...(row.context === null ? {} : { context: row.context }),
    bbox: [row.min_lon, row.min_lat, row.max_lon, row.max_lat],
    sourceIds: JSON.parse(String(row.source_refs)),
  });
}

export function listSearchRegions(databasePath: string): SearchRegionSummary[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT a.id, a.name, a.kind, a.context, a.min_lon, a.min_lat, a.max_lon, a.max_lat,
        a.source_refs, r.display_order
      FROM search_regions r
      JOIN named_areas a ON a.id = r.named_area_id
      ORDER BY r.display_order, a.id
    `).all() as NamedAreaRow[];
    return rows.map((row) => searchRegionSummarySchema.parse({
      ...rowSummary(row),
      displayOrder: row.display_order,
    }));
  } finally {
    database.close();
  }
}

function likePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function searchNamedAreas(databasePath: string, text: string, limit = 10): NamedAreaSummary[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Named-area search limit must be from 1 through 50");
  const query = namedAreaSearchKey(text);
  if (query.length < 2) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const pattern = `%${likePattern(query)}%`;
    const prefix = `${likePattern(query)}%`;
    const rows = database.prepare(`
      SELECT a.id, a.name, a.kind, a.context, a.min_lon, a.min_lat, a.max_lon, a.max_lat, a.source_refs,
        MIN(CASE
          WHEN aliases.normalized_alias = ? THEN 0
          WHEN aliases.normalized_alias LIKE ? ESCAPE '\\' THEN 1
          ELSE 2
        END) AS match_rank,
        MIN(length(aliases.normalized_alias)) AS alias_length
      FROM named_area_aliases aliases
      JOIN named_areas a ON a.id = aliases.area_id
      WHERE aliases.normalized_alias LIKE ? ESCAPE '\\'
      GROUP BY a.id
      ORDER BY match_rank, alias_length, a.name COLLATE NOCASE, a.id
      LIMIT ?
    `).all(query, prefix, pattern, limit) as NamedAreaRow[];
    return rows.map(rowSummary);
  } finally {
    database.close();
  }
}

export function getNamedArea(databasePath: string, id: string): NamedArea | null {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT id, name, kind, context, min_lon, min_lat, max_lon, max_lat, geometry, source_refs
      FROM named_areas WHERE id = ?
    `).get(id) as NamedAreaRow | undefined;
    if (!row) return null;
    return namedAreaSchema.parse({ ...rowSummary(row), geometry: JSON.parse(String(row.geometry)) });
  } finally {
    database.close();
  }
}
