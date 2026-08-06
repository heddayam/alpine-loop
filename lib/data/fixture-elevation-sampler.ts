import { z } from "zod";
import type { ElevationSampler, SourceSnapshot } from "./adapters";
import { readValidatedSnapshot } from "./file-source";

const elevationSchema = z.object({
  version: z.literal(1),
  samples: z.array(z.object({
    lon: z.number().finite().min(-180).max(180),
    lat: z.number().finite().min(-90).max(90),
    elevationM: z.number().finite(),
  }).strict()).min(1),
}).strict();

type ElevationSample = z.infer<typeof elevationSchema>["samples"][number];

export class FixtureElevationSampler implements ElevationSampler {
  readonly algorithmVersion = "nearest-fixture-v1+metrics-v3";

  private constructor(private readonly samples: ElevationSample[]) {}

  static async create(snapshot: SourceSnapshot): Promise<FixtureElevationSampler> {
    const input = elevationSchema.parse(await readValidatedSnapshot(snapshot));
    return new FixtureElevationSampler(input.samples);
  }

  async sample(coordinates: ReadonlyArray<readonly [number, number]>): Promise<Array<number | null>> {
    return coordinates.map(([lon, lat]) => {
      let nearest = this.samples[0];
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const sample of this.samples) {
        const distance = (sample.lon - lon) ** 2 + (sample.lat - lat) ** 2;
        if (distance < nearestDistance) {
          nearest = sample;
          nearestDistance = distance;
        }
      }
      return nearest?.elevationM ?? null;
    });
  }
}
