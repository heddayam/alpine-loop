import { z } from "zod";
import { accessStateSchema, confidenceSchema } from "@/lib/contracts";
import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "./adapters";
import { readValidatedSnapshot } from "./file-source";

const officialAccessSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({
    id: z.string().min(1),
    externalId: z.string().min(1),
    lon: z.number().finite().min(-180).max(180),
    lat: z.number().finite().min(-90).max(90),
    name: z.string().min(1),
    accessState: accessStateSchema,
    confidence: confidenceSchema,
  }).strict()).min(1),
}).strict();

export class FixtureOfficialAccessAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "fixture-official-access-v1";

  async validate(snapshot: SourceSnapshot): Promise<void> {
    const input = officialAccessSchema.parse(await readValidatedSnapshot(snapshot));
    if (new Set(input.records.map(({ id }) => id)).size !== input.records.length) {
      throw new Error("Official access source contains duplicate record IDs");
    }
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    const input = officialAccessSchema.parse(await readValidatedSnapshot(snapshot));
    return input.records.map((record) => ({
      sourceId: snapshot.id,
      externalId: record.externalId,
      lon: record.lon,
      lat: record.lat,
      name: record.name,
      accessState: record.accessState,
      confidence: record.confidence,
    }));
  }
}
