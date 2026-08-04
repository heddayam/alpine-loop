import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSelectedSegmentNdjson } from "../app/trails/segment-reader.ts";
import { locateTrailArtifact } from "../app/trails/artifact-locator.ts";
import {
  createRuntimeTrailArtifactStore,
  FetchTrailArtifactStore,
  R2TrailArtifactStore,
  TrailArtifactIntegrityError,
  TrailArtifactNotFoundError,
  TrailArtifactTransientError,
} from "../app/trails/storage.ts";

const fixturePath = new URL("./fixtures/trails/storage/segments-aa.ndjson", import.meta.url);
const fixtureBytes = await readFile(fixturePath);
const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
const fixtureArtifactPath = "segments/aa.ndjson";
const fixtureManifest = {
  schemaVersion: 2,
  buildId: "build_0123456789abcdef0123456789abcdef",
  region: { id: "fixture-region" },
  artifacts: { [fixtureArtifactPath]: { sha256: fixtureHash } },
};
const fixtureArtifact = locateTrailArtifact(fixtureManifest, fixtureArtifactPath);
const objectKey = fixtureArtifact.key;

function byteStream(bytes, chunkSize = bytes.length) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
      offset += chunkSize;
    },
  });
}

function fixtureR2({ missing = false, unavailable = false, sha256 = fixtureHash } = {}) {
  const calls = [];
  return {
    calls,
    binding: {
      async get(key, options) {
        calls.push({ key, options });
        if (unavailable) throw new Error("fixture R2 timeout");
        if (missing) return null;
        const range = options?.range;
        const bytes = range
          ? fixtureBytes.subarray(range.offset, range.offset + range.length)
          : fixtureBytes;
        return {
          body: byteStream(bytes, 17),
          size: fixtureBytes.length,
          etag: "fixture-etag",
          ...(range ? { range } : {}),
          httpMetadata: {
            contentType: "application/x-ndjson; charset=utf-8",
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: { sha256 },
        };
      },
    },
  };
}

test("private R2 adapter streams a complete object with metadata and manifest hash validation", async () => {
  const r2 = fixtureR2();
  const store = new R2TrailArtifactStore(r2.binding);
  const object = await store.get(objectKey, {
    expectedSha256: fixtureArtifact.expectedSha256,
  });

  assert.equal(await new Response(object.body).text(), fixtureBytes.toString());
  assert.deepEqual(r2.calls, [{ key: objectKey, options: undefined }]);
  assert.equal(object.size, fixtureBytes.length);
  assert.equal(object.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(object.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(object.headers.get("etag"), '"fixture-etag"');
  assert.equal(object.headers.get("accept-ranges"), "bytes");
  assert.equal(object.headers.get("content-length"), String(fixtureBytes.length));
});

test("v2 immutable object keys and integrity expectations come from the accepted manifest", () => {
  assert.deepEqual(fixtureArtifact, {
    key: "trails/fixture-region/build_0123456789abcdef0123456789abcdef/segments/aa.ndjson",
    backend: "private-r2",
    expectedSha256: fixtureHash,
  });
  assert.throws(
    () => locateTrailArtifact(fixtureManifest, "segments/ab.ndjson"),
    /no valid SHA-256/,
  );
});

test("private R2 adapter performs bounded range reads", async () => {
  const r2 = fixtureR2();
  const store = new R2TrailArtifactStore(r2.binding);
  const range = { offset: 12, length: 29 };
  const object = await store.get(objectKey, {
    range,
    expectedSha256: fixtureArtifact.expectedSha256,
  });

  assert.deepEqual(r2.calls, [{ key: objectKey, options: { range } }]);
  assert.deepEqual(
    Buffer.from(await new Response(object.body).arrayBuffer()),
    fixtureBytes.subarray(range.offset, range.offset + range.length),
  );
  assert.equal(object.headers.get("content-range"), `bytes 12-40/${fixtureBytes.length}`);
  assert.equal(object.headers.get("content-length"), "29");
});

test("streamed fixture objects feed the selected geometry NDJSON parser", async () => {
  const store = new R2TrailArtifactStore(fixtureR2().binding);
  const object = await store.get(objectKey);
  const segments = await parseSelectedSegmentNdjson(
    object.body,
    new Set(["segment_aa02"]),
  );

  assert.deepEqual(segments.map(({ id }) => id), ["segment_aa02"]);
  assert.deepEqual(segments[0].geometry.coordinates[1], [-119.4, 37.9]);
});

test("private R2 adapter fails closed on absent or mismatched hash metadata", async () => {
  const missingHash = new R2TrailArtifactStore(fixtureR2({ sha256: "" }).binding);
  await assert.rejects(
    missingHash.get(objectKey, { expectedSha256: fixtureHash }),
    TrailArtifactIntegrityError,
  );

  const wrongHash = new R2TrailArtifactStore(fixtureR2({ sha256: "0".repeat(64) }).binding);
  await assert.rejects(
    wrongHash.get(objectKey, { expectedSha256: fixtureHash }),
    /does not match the manifest/,
  );
});

test("private R2 adapter distinguishes object 404 from transient binding failure", async () => {
  const missing = new R2TrailArtifactStore(fixtureR2({ missing: true }).binding);
  await assert.rejects(missing.get(objectKey), TrailArtifactNotFoundError);

  const unavailable = new R2TrailArtifactStore(fixtureR2({ unavailable: true }).binding);
  await assert.rejects(unavailable.get(objectKey), TrailArtifactTransientError);
});

test("local asset fallback needs no R2 credentials and preserves range semantics", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const requests = [];
  const assets = {
    async fetch(request) {
      requests.push(request);
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      const offset = Number(match?.[1] ?? 0);
      const end = Number(match?.[2] ?? fixtureBytes.length - 1);
      const bytes = fixtureBytes.subarray(offset, end + 1);
      return new Response(bytes, {
        status: match ? 206 : 200,
        headers: {
          "Content-Length": String(bytes.length),
          "Content-Range": `bytes ${offset}-${end}/${fixtureBytes.length}`,
          "Content-Type": "application/x-ndjson; charset=utf-8",
          ETag: '"local-fixture"',
          "x-content-sha256": fixtureHash,
        },
      });
    },
  };
  try {
    const store = createRuntimeTrailArtifactStore(
      { ASSETS: assets },
      "http://local.test/request",
      fixtureArtifact.backend,
    );
    assert.ok(store instanceof FetchTrailArtifactStore);

    const object = await store.get(objectKey, {
      range: { offset: 4, length: 11 },
      expectedSha256: fixtureHash,
    });
    assert.equal(requests[0].url, `http://local.test/${objectKey}`);
    assert.equal(requests[0].headers.get("range"), "bytes=4-14");
    assert.equal(object.size, fixtureBytes.length);
    assert.deepEqual(
      Buffer.from(await new Response(object.body).arrayBuffer()),
      fixtureBytes.subarray(4, 15),
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("coexisting bindings read v1 from ASSETS and v2 from private R2", async () => {
  const r2 = fixtureR2();
  const assetRequests = [];
  const bindings = {
    TRAIL_ARTIFACTS: r2.binding,
    ASSETS: {
      async fetch(request) {
        assetRequests.push(request);
        return new Response(fixtureBytes, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      },
    },
  };
  const v1Artifact = locateTrailArtifact({
    schemaVersion: 1,
    region: { id: "yosemite-stanislaus" },
  }, "segments/a.ndjson");

  const v1Store = createRuntimeTrailArtifactStore(
    bindings,
    "http://local.test/request",
    v1Artifact.backend,
  );
  assert.ok(v1Store instanceof FetchTrailArtifactStore);
  const v1Object = await v1Store.get(v1Artifact.key);
  assert.equal(await new Response(v1Object.body).text(), fixtureBytes.toString());
  assert.equal(assetRequests.length, 1);
  assert.equal(r2.calls.length, 0);

  const v2Store = createRuntimeTrailArtifactStore(
    bindings,
    "http://local.test/request",
    fixtureArtifact.backend,
  );
  assert.ok(v2Store instanceof R2TrailArtifactStore);
  const v2Object = await v2Store.get(fixtureArtifact.key, {
    expectedSha256: fixtureArtifact.expectedSha256,
  });
  assert.equal(await new Response(v2Object.body).text(), fixtureBytes.toString());
  assert.equal(assetRequests.length, 1);
  assert.equal(r2.calls.length, 1);
});

test("v2 does not silently use packaged ASSETS when private R2 is missing in production", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let assetCalls = 0;
  try {
    assert.throws(
      () => createRuntimeTrailArtifactStore({
        ASSETS: { fetch: async () => { assetCalls += 1; return new Response(fixtureBytes); } },
      }, "http://local.test/request", fixtureArtifact.backend),
      TrailArtifactTransientError,
    );
    assert.equal(assetCalls, 0);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("the legacy Yosemite manifest keeps its packaged ASSETS key without hash metadata", () => {
  assert.deepEqual(locateTrailArtifact({
    schemaVersion: 1,
    region: { id: "yosemite-stanislaus" },
    artifacts: { "segments/a.ndjson": { sha256: "f".repeat(64) } },
  }, "segments/a.ndjson"), {
    key: "trails/yosemite-stanislaus/segments/a.ndjson",
    backend: "packaged-assets",
  });
});

test("the credential-free packaged Yosemite v1 fallback remains readable", async () => {
  const artifact = locateTrailArtifact({
    schemaVersion: 1,
    region: { id: "yosemite-stanislaus" },
  }, "segments/a.ndjson");
  const requests = [];
  const store = createRuntimeTrailArtifactStore({
    ASSETS: {
      async fetch(request) {
        requests.push(request);
        return new Response(fixtureBytes, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      },
    },
  }, "http://local.test/api/trails", artifact.backend);

  const object = await store.get(artifact.key, {
    ...(artifact.expectedSha256 ? { expectedSha256: artifact.expectedSha256 } : {}),
  });
  assert.equal(requests[0].url, "http://local.test/trails/yosemite-stanislaus/segments/a.ndjson");
  assert.equal(await new Response(object.body).text(), fixtureBytes.toString());
});

test("v2 development fallback still works without either production binding", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const requests = [];
  try {
    const store = createRuntimeTrailArtifactStore(
      {},
      "http://local.test/api/trails",
      fixtureArtifact.backend,
      async (request) => {
        requests.push(request);
        return new Response(fixtureBytes, {
          headers: { "x-content-sha256": fixtureHash },
        });
      },
    );
    const object = await store.get(fixtureArtifact.key, {
      expectedSha256: fixtureArtifact.expectedSha256,
    });
    assert.equal(await new Response(object.body).text(), fixtureBytes.toString());
    assert.equal(requests[0].url, `http://local.test/${fixtureArtifact.key}`);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("local fallback maps HTTP absence and service errors without exposing a bucket", async () => {
  const missing = new FetchTrailArtifactStore(
    "http://local.test",
    async () => new Response(null, { status: 404 }),
  );
  await assert.rejects(missing.get(objectKey), TrailArtifactNotFoundError);

  const unavailable = new FetchTrailArtifactStore(
    "http://local.test",
    async () => new Response(null, { status: 503 }),
  );
  await assert.rejects(unavailable.get(objectKey), TrailArtifactTransientError);
});
