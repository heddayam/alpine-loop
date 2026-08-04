import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "./adapters";

export class PreparedOfficialAccessAdapter implements OfficialAccessAdapter {
  readonly adapterVersion: string;

  constructor(
    private readonly sourceAdapter: OfficialAccessAdapter,
    private readonly evidence: NormalizedAccessEvidence[],
  ) {
    this.adapterVersion = `${sourceAdapter.adapterVersion}+spatial-join-v1`;
  }

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await this.sourceAdapter.validate(snapshot);
    if (this.evidence.some(({ sourceId }) => sourceId !== snapshot.id)) {
      throw new Error(`Prepared official evidence does not belong to source ${snapshot.id}`);
    }
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    await this.validate(snapshot);
    return this.evidence.map((item) => ({ ...item }));
  }
}
