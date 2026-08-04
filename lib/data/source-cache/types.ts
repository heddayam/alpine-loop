export type SourceReceipt = {
  schemaVersion: 1;
  sourceId: string;
  originalUrl: string;
  resolvedUrl: string;
  retrievedAt: string;
  byteLength: number;
  sha256: `sha256:${string}`;
  fileName: string;
  etag?: string;
  lastModified?: string;
};
export type CachedSource = {
  directory: string;
  filePath: string;
  receiptPath: string;
  receipt: SourceReceipt;
  reused: boolean;
};
