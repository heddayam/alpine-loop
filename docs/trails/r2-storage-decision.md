# ADR: private R2 for regional trail artifacts

- Status: **accepted against artifact contract v2; production integration deferred to P6**
- Date: 2026-08-04
- Scope: Phase 2 P5 only

## Decision

Use Cloudflare R2 Standard storage as the regional trail artifact data plane,
accessed only through an application-level Worker binding. Do not enable a
public bucket or depend on `r2.dev`. Keep D1 limited to the existing structured
reachability and accounting responsibilities.

Artifact contract v2 is now accepted. Its immutable object key is
`trails/<manifest.region.id>/<manifest.buildId>/<manifest artifact path>`; the
request-time integrity expectation is the artifact SHA-256 declared by that
same manifest. Request code does not list the bucket, infer partition width, or
derive a build ID independently.

This decision is conditional on P6 retaining the integrity and publication
rules below. The fixture proof does not provision a bucket, publish an object,
activate a region, or declare the Sites binding.

## Evidence

The application adapter in `app/trails/storage.ts` proves these behaviors with a
small checked-in NDJSON fixture:

| Concern | Fixture evidence |
| --- | --- |
| Private application boundary | V2 artifacts explicitly select the logical `TRAIL_ARTIFACTS` binding and expose no bucket URL. V1 artifacts explicitly select packaged `ASSETS`, so enabling R2 cannot shadow Yosemite's historical keys. |
| Local development | When the binding is absent, the existing Sites `ASSETS` fetcher (or development fetch) supplies the same object interface without R2 credentials. |
| Accepted v2 layout | The locator resolves a two-character fixture shard from the accepted manifest's region ID, build ID, and declared artifact path; its expected SHA-256 comes from the manifest artifact record. |
| Object and stream reads | A chunked `ReadableStream` feeds the same selected-segment NDJSON parser used by lazy geometry. |
| Range reads | Offset/length requests become an R2 range and local HTTP `Range` request; returned length and `Content-Range` are checked. |
| HTTP metadata | Content type, cache control, content encoding, content length, range support, and quoted ETag are retained or assigned safe defaults. |
| Integrity | A manifest-supplied SHA-256 must match private object `customMetadata.sha256` (or the local fixture's `x-content-sha256`); missing or mismatched metadata fails closed. |
| Failure behavior | Missing objects and transient storage failures have distinct typed errors. The geometry API continues to fail a known trail with unavailable/corrupt backing data as `503`, rather than returning partial geometry. |
| Existing region | Yosemite–Stanislaus schema v1 keeps its historical `trails/<region>/<artifact path>` packaged Sites asset key. A both-bindings regression proves v1 reads `ASSETS` while v2 reads R2. Because packaged v1 assets do not carry R2 custom metadata, the v1 fallback remains readable without applying the v2 metadata requirement. |
| Partition width | The P4 catalog retains the manifest/index-declared prefix length used to select a shard; storage receives the resulting manifest path and does not assume one- or two-character partitions. |

Cloudflare documents that Workers R2 bindings return object bodies as streams,
support byte ranges, expose HTTP/custom metadata, and recommend `httpEtag` for
response headers. Streaming avoids loading an ordinary geometry shard entirely
into the Worker's memory. See the official [Workers R2 API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [Workers API usage guide](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/).

R2 is operationally suitable because it is strongly consistent and reachable
directly from the Worker binding. Immutable build objects plus a separately
activated pointer can therefore support P6's upload/verify/activate-last and
rollback sequence without a second blob system. See [How R2 works](https://developers.cloudflare.com/r2/how-r2-works/).

R2 Standard is also a reasonable cost fit. As of this decision, Cloudflare
lists 10 GB-month of Standard storage, one million Class A operations, and ten
million Class B operations in the monthly free tier; beyond that, Standard is
$0.015/GB-month, $4.50/million Class A operations, and $0.36/million Class B
operations, with no R2 egress charge. The approximately 993 MB raw T8 baseline
is comfortably below the storage allowance before retained builds and
diagnostics are counted. Actual request volume and retained-version size still
need production measurement; use Standard rather than Infrequent Access for
runtime shards because the latter adds retrieval charges and a 30-day minimum.
See official [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and
[storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/).

## Required production invariants

P6 must:

1. Upload immutable objects with manifest SHA-256 in `customMetadata.sha256`,
   correct `httpMetadata.contentType`, and a reviewed cache policy.
2. Verify remote bytes/sizes/hashes before activation; metadata comparison on
   a request is defense in depth, not a substitute for publisher verification.
3. Resolve immutable keys from the accepted P4 manifest region, build ID, and
   artifact path. Supply that artifact's manifest SHA-256 for request-time
   metadata validation. Request code must neither list the bucket nor infer
   partition width.
4. Treat a missing, corrupt, or transiently unavailable required object as a
   closed service failure with no partial geometry.
5. Keep all bucket identifiers and credentials out of source and expose bytes
   only through reviewed application endpoints.

## Deferred P6 decisions and ownership

P4 now owns and freezes the manifest schema, build-ID derivation, manifest-
declared partition width, artifact paths, content encoding, runtime/diagnostic
roles, required/optional application status, and immutable build layout. This
proof consumes those fields; it does not redefine them.

P6 still owns:

1. The reviewed `current.json` schema, how the runtime obtains and caches the
   active accepted manifest, and cache invalidation after activation/rollback.
2. The non-request-path uploader, remote size/hash verification, idempotent
   retry behavior, QA/review acceptance checks, activation-last sequencing,
   and rollback.
3. Runtime service-error mapping for manifest, index, and required-object
   failures, plus any safe response caching above immutable object reads.
4. Retained-build policy and deployed private-binding smoke evidence. P6 must
   honor P4 content encodings and artifact roles rather than selecting new
   values in request code.

The integrator owns `.openai/hosting.json`, generated binding declarations, and
shared scripts. The exact deferred binding diff for integrator review is:

```diff
-  "r2": null
+  "r2": "TRAIL_ARTIFACTS"
```

That replaces the current `"r2": null` while preserving the existing
`project_id` and `d1` values. Sites must create and wire the physical private
resource. This P5 branch intentionally does not make that change.

Before Gate F, the integrator must also review expected read volume, retained
build count, cache-hit behavior, Worker subrequest/CPU limits, and a small
deployed private-binding smoke test. No production Sites state was changed by
this fixture proof.
