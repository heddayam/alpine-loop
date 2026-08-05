import { z } from "zod";
import { areaGeometrySchema, namedAreaKindSchema } from "@/lib/contracts";
import type { NamedAreaSourceAdapter, SourceSnapshot } from "./adapters";
import { areaGeometryBounds } from "./area-geometry";
import { readValidatedSnapshot } from "./file-source";
import type { NormalizedNamedArea } from "./types";

const fixtureNamedAreasSchema = z.object({
  version: z.literal(1),
  areas: z.array(z.object({
    externalId: z.string().min(1),
    name: z.string().min(1),
    kind: namedAreaKindSchema,
    context: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)),
    geometry: areaGeometrySchema,
  }).strict()).min(1),
}).strict();

export class FixtureNamedAreaAdapter implements NamedAreaSourceAdapter {
  readonly adapterVersion = "fixture-named-areas-v1";

  async validate(snapshot: SourceSnapshot): Promise<void> {
    fixtureNamedAreasSchema.parse(await readValidatedSnapshot(snapshot));
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedNamedArea[]> {
    const input = fixtureNamedAreasSchema.parse(await readValidatedSnapshot(snapshot));
    return input.areas.map((area) => ({
      id: `osm:${area.externalId}`,
      name: area.name,
      kind: area.kind,
      context: area.context,
      aliases: area.aliases,
      bbox: areaGeometryBounds(area.geometry),
      geometry: area.geometry,
      sourceIds: [snapshot.id],
    }));
  }
}
