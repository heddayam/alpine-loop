export type TrailArtifactRange = {
  offset: number;
  length: number;
};

export type TrailArtifactReadOptions = {
  range?: TrailArtifactRange;
  expectedSha256?: string;
};

export type TrailArtifactObject = {
  key: string;
  body: ReadableStream<Uint8Array>;
  size: number;
  headers: Headers;
};

export interface TrailArtifactStore {
  get(key: string, options?: TrailArtifactReadOptions): Promise<TrailArtifactObject>;
}

export type PrivateR2Object = {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag?: string;
  httpEtag?: string;
  range?: { offset: number; length: number };
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
};

export type PrivateR2Binding = {
  get(
    key: string,
    options?: { range?: TrailArtifactRange },
  ): Promise<PrivateR2Object | null>;
};

export class TrailArtifactNotFoundError extends Error {
  readonly code = "TRAIL_ARTIFACT_NOT_FOUND";
  readonly key: string;

  constructor(key: string) {
    super(`Trail artifact ${key} was not found.`);
    this.name = "TrailArtifactNotFoundError";
    this.key = key;
  }
}

export class TrailArtifactTransientError extends Error {
  readonly code = "TRAIL_ARTIFACT_TRANSIENT";
  readonly key: string;

  constructor(key: string) {
    super(`Trail artifact ${key} is temporarily unavailable.`);
    this.name = "TrailArtifactTransientError";
    this.key = key;
  }
}

export class TrailArtifactIntegrityError extends Error {
  readonly code = "TRAIL_ARTIFACT_INTEGRITY";
  readonly key: string;

  constructor(key: string, message: string) {
    super(`Trail artifact ${key} failed integrity validation: ${message}`);
    this.name = "TrailArtifactIntegrityError";
    this.key = key;
  }
}

function validateKey(key: string) {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0") ||
      key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("Trail artifact keys must be normalized relative paths.");
  }
}

function validateRange(range: TrailArtifactRange | undefined) {
  if (!range) return;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 ||
      !Number.isSafeInteger(range.length) || range.length < 1) {
    throw new TypeError("Trail artifact ranges require a non-negative offset and positive length.");
  }
}

function normalizeSha256(value: string | undefined) {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function validateSha256(
  key: string,
  expected: string | undefined,
  actual: string | undefined,
) {
  if (!expected) return;
  const expectedHash = normalizeSha256(expected);
  if (!expectedHash) throw new TypeError("expectedSha256 must be a 64-character hexadecimal digest.");
  const actualHash = normalizeSha256(actual);
  if (!actualHash) {
    throw new TrailArtifactIntegrityError(key, "the object has no valid SHA-256 metadata");
  }
  if (actualHash !== expectedHash) {
    throw new TrailArtifactIntegrityError(key, "the object SHA-256 does not match the manifest");
  }
}

function quotedEtag(httpEtag: string | undefined, etag: string | undefined) {
  if (httpEtag) return httpEtag;
  if (!etag) return null;
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

function inferredContentType(key: string) {
  if (key.endsWith(".json") || key.endsWith(".geojson")) return "application/json; charset=utf-8";
  if (key.endsWith(".ndjson")) return "application/x-ndjson; charset=utf-8";
  return "application/octet-stream";
}

function objectHeaders(
  key: string,
  size: number,
  range: TrailArtifactRange | undefined,
  metadata: PrivateR2Object["httpMetadata"],
  etag: string | null,
) {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": metadata?.cacheControl ?? "private, no-store",
    "Content-Length": String(range?.length ?? size),
    "Content-Type": metadata?.contentType ?? inferredContentType(key),
  });
  if (metadata?.contentEncoding) headers.set("Content-Encoding", metadata.contentEncoding);
  if (etag) headers.set("ETag", etag);
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
    );
  }
  return headers;
}

export class R2TrailArtifactStore implements TrailArtifactStore {
  private readonly bucket: PrivateR2Binding;

  constructor(bucket: PrivateR2Binding) {
    this.bucket = bucket;
  }

  async get(key: string, options: TrailArtifactReadOptions = {}) {
    validateKey(key);
    validateRange(options.range);

    let object: PrivateR2Object | null;
    try {
      object = await this.bucket.get(key, options.range ? { range: options.range } : undefined);
    } catch {
      throw new TrailArtifactTransientError(key);
    }
    if (!object) throw new TrailArtifactNotFoundError(key);

    validateSha256(key, options.expectedSha256, object.customMetadata?.sha256);
    const returnedRange = object.range ?? options.range;
    if (returnedRange && returnedRange.offset + returnedRange.length > object.size) {
      throw new TrailArtifactIntegrityError(key, "the returned byte range exceeds the object size");
    }

    return {
      key,
      body: object.body,
      size: object.size,
      headers: objectHeaders(
        key,
        object.size,
        returnedRange,
        object.httpMetadata,
        quotedEtag(object.httpEtag, object.etag),
      ),
    } satisfies TrailArtifactObject;
  }
}

type ArtifactFetcher = (request: Request) => Promise<Response>;

export class FetchTrailArtifactStore implements TrailArtifactStore {
  private readonly origin: string;
  private readonly fetchArtifact: ArtifactFetcher;

  constructor(
    origin: string,
    fetchArtifact: ArtifactFetcher,
  ) {
    this.origin = origin;
    this.fetchArtifact = fetchArtifact;
  }

  async get(key: string, options: TrailArtifactReadOptions = {}) {
    validateKey(key);
    validateRange(options.range);
    const headers = new Headers();
    if (options.range) {
      headers.set(
        "Range",
        `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`,
      );
    }

    let response: Response;
    try {
      response = await this.fetchArtifact(new Request(new URL(`/${key}`, this.origin), { headers }));
    } catch {
      throw new TrailArtifactTransientError(key);
    }
    if (response.status === 404) throw new TrailArtifactNotFoundError(key);
    if (!response.ok || !response.body) throw new TrailArtifactTransientError(key);
    if (options.range && response.status !== 206) {
      throw new TrailArtifactIntegrityError(key, "the local object server ignored the byte range");
    }

    validateSha256(
      key,
      options.expectedSha256,
      response.headers.get("x-content-sha256") ?? undefined,
    );
    const resultHeaders = new Headers(response.headers);
    resultHeaders.set("Accept-Ranges", "bytes");
    if (!resultHeaders.has("Cache-Control")) resultHeaders.set("Cache-Control", "private, no-store");
    if (!resultHeaders.has("Content-Type")) resultHeaders.set("Content-Type", inferredContentType(key));

    const contentRange = /\/(\d+)$/.exec(resultHeaders.get("Content-Range") ?? "");
    const totalSize = Number(contentRange?.[1]);
    const contentLength = Number(resultHeaders.get("Content-Length"));
    const size = Number.isSafeInteger(totalSize) && totalSize >= 0
      ? totalSize
      : Number.isSafeInteger(contentLength) && contentLength >= 0
        ? contentLength
        : options.range?.length ?? 0;
    return { key, body: response.body, size, headers: resultHeaders } satisfies TrailArtifactObject;
  }
}

export type RuntimeTrailArtifactBindings = {
  TRAIL_ARTIFACTS?: PrivateR2Binding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
};

export function createRuntimeTrailArtifactStore(
  bindings: RuntimeTrailArtifactBindings,
  requestUrl: string,
  localFetch: typeof fetch = fetch,
) {
  if (bindings.TRAIL_ARTIFACTS) return new R2TrailArtifactStore(bindings.TRAIL_ARTIFACTS);
  if (bindings.ASSETS) {
    return new FetchTrailArtifactStore(requestUrl, async (request) => {
      try {
        const response = await bindings.ASSETS!.fetch(request.clone());
        if (response.ok || process.env.NODE_ENV !== "development") return response;
      } catch (error) {
        if (process.env.NODE_ENV !== "development") throw error;
      }
      return localFetch(request.clone());
    });
  }
  if (process.env.NODE_ENV === "development") {
    return new FetchTrailArtifactStore(requestUrl, localFetch);
  }
  throw new TrailArtifactTransientError("runtime-binding");
}
