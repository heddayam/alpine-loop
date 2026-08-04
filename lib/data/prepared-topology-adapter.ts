import type { SourceSnapshot, TopologySourceAdapter } from "./adapters";

export class PreparedTopologyAdapter<T> implements TopologySourceAdapter<T> {
  readonly adapterVersion: string;

  constructor(
    private readonly sourceAdapter: TopologySourceAdapter<T>,
    private readonly topology: T,
  ) {
    this.adapterVersion = `${sourceAdapter.adapterVersion}+prepared-v1`;
  }

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await this.sourceAdapter.validate(snapshot);
  }

  async *normalize(snapshot: SourceSnapshot): AsyncIterable<T> {
    await this.validate(snapshot);
    yield this.topology;
  }
}
