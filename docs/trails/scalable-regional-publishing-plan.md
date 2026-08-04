# Alpine Search scalable regional publishing plan — Phase 2

Status: ready for implementation after Phase 1 integration commit `586eb9b`
Primary integration branch: `codex/trails-data`
Production region: Yosemite–Stanislaus only
Pipeline-only regions: Bay Area — Midpen, Bay Area — East Bay, Sierra National
Forest, and Tahoe–Eldorado

Phase 1 history and contracts remain in:

- [implementation-plan.md](./implementation-plan.md)
- [gate-c-review.md](./gate-c-review.md)
- [t8-regional-expansion.md](./t8-regional-expansion.md)
- [search-api.md](./search-api.md)

## Objective

Make the regional trail corpus reproducible, publishable, and inexpensive to
serve without raising Node's default heap, committing large generated corpora
to Git, or weakening the existing hiking/access/QA rules.

The finished system must:

1. Build the largest configured region twice from identical cached inputs under
   the default Node heap.
2. Produce byte-identical versioned artifacts with bounded runtime shard sizes.
3. Store large immutable artifacts outside Git in versioned object storage.
4. Keep small searchable metadata separate from lazy geometry, routing graph,
   provenance, and QA.
5. Publish or roll back a region atomically through a reviewed manifest.
6. Expose a region through the API and UI only after its individual QA and
   delivery gates pass.

## Baseline

The accepted Phase 1 integration is `586eb9b`. It includes:

- The deterministic Yosemite–Stanislaus corpus and Gate C review.
- Config-driven preparation and first cached builds for all five regions.
- A metadata-first search API with access-point-in-polygon filtering.
- Lazy selected geometry and the reachable-trails map UI.
- Sites packaging restricted to committed Yosemite geometry.

The four T8 first builds produced:

| Region | Segments | Named components | Raw | Gzip | Publication state |
| --- | ---: | ---: | ---: | ---: | --- |
| Bay Area — Midpen | 286,557 | 406 | 446,578,019 B | 85,672,358 B | blocked |
| Bay Area — East Bay | 198,925 | 379 | 318,389,472 B | 62,540,840 B | blocked |
| Sierra National Forest | 28,124 | 41 | 79,380,199 B | 21,052,710 B | blocked |
| Tahoe–Eldorado | 76,434 | 310 | 148,784,565 B | 31,625,365 B | blocked |

Combined T8 output is 590,040 segments, about 993 MB raw and 201 MB gzip.
Elevation coverage is complete, but a repeat Midpen build exceeds Node's
default heap during a later large-array sort. Tahoe's elevation flags and every
region's final manual QA remain unaccepted.

## Non-goals

- Do not refresh public sources merely to work on build scalability.
- Do not publish cached first-build artifacts.
- Do not make a public R2 bucket a requirement; the application API remains the
  product boundary.
- Do not store large geometry, graph, provenance, or QA blobs in D1.
- Do not increase `--max-old-space-size` and call the memory issue resolved.
- Do not change hiking, access, closure, climbing, or Gate C exclusion rules to
  reduce counts.
- Do not implement custom route generation in this phase.
- Do not expose raw per-edge grade outliers as precise product difficulty.

## Target architecture

```text
cached agency / OSM / 3DEP inputs
                 |
                 v
bounded regional build with stage telemetry and disk-backed spill when needed
                 |
                 v
versioned manifest + small search metadata + partitioned runtime/diagnostic blobs
                 |
                 v
private R2 binding behind the existing trail API
                 |
                 v
metadata-first search and cached, lazy selected geometry
```

### Control plane versus data plane

Keep in Git and the application bundle:

- Schemas and validators.
- Region availability metadata.
- Small tests and fixtures.
- The active artifact manifest pointer or equivalent reviewed version ID.
- Search metadata only when its measured bundle size remains practical.

Keep in versioned object storage:

- Detailed geometry shards.
- Routing nodes/edges needed by later route generation.
- Full field provenance.
- Full machine QA and review attachments.
- Regional manifests and immutable build evidence.

D1 remains responsible for reachability jobs and usage accounting. R2 is the
preferred blob store, subject to the fixture-backed proof in P4. Set the logical
Sites binding only in the reviewed storage integration task; no credentials or
physical bucket identifiers belong in source.

### Versioned object layout

The intended logical layout is:

```text
trails/<region>/<build-id>/manifest.json
trails/<region>/<build-id>/search-index.json
trails/<region>/<build-id>/segments/<partition>.ndjson
trails/<region>/<build-id>/graph/<partition>
trails/<region>/<build-id>/diagnostics/qa.json
trails/<region>/<build-id>/diagnostics/provenance/<partition>.json
trails/<region>/current.json
```

Objects below a build ID are immutable. `current.json` is activated only after
upload, hash verification, and QA acceptance. The previous accepted build ID
must remain usable for rollback.

## Artifact contract v2

The v2 manifest must declare rather than imply:

- Artifact schema version and region ID.
- Build ID derived from stable inputs/artifact hashes.
- Partition prefix length and each shard's record count.
- Raw bytes, compressed bytes, content encoding, and SHA-256.
- Runtime versus diagnostic artifact role.
- Required versus optional application artifacts.
- Source snapshot hashes and retrieval timestamps.
- QA decision and the identity/date of the accepted review.

Use two hexadecimal segment-ID characters for new regional geometry and
provenance partitions unless measured evidence justifies another manifest-
declared width. Existing Yosemite v1 artifacts remain readable during
migration. The API must use the manifest/index and must not assume one-character
partitions.

Runtime geometry target: no ordinary shard above 8 MiB raw or 2 MiB gzip. An
exception requires a measured Worker/API review and an explicit manifest note.

## Work graph

```text
P1 profile --> P2 streaming writer --> Gate E
     |                 |
     +--> P3 bounded staging (only if still needed)
                       |
                       +--> P4 artifact v2
P4 artifact v2 --> P5 R2 proof --> P6 publisher/runtime adapter --> Gate F
P4 artifact v2 --> P7 access payload scaling --------------------> Gate F
Gate E + Gate F --> P8 deterministic regional QA --> Gate G
Gate G --> P9 region activation (one region at a time)
```

At most one task may modify the canonical artifact serializer at a time. P5 may
develop against fixtures in parallel with P1/P2, but it must not freeze a
production object layout before P4 is accepted.

## P1 — Build-stage profiling

Branch: `codex/trails-build-profile`
Dependencies: Phase 1 integration `586eb9b`

Add opt-in, deterministic stage telemetry around:

- Snapshot loading and normalization.
- OSM topology construction.
- Agency/OSM reconciliation and merge.
- Elevation enrichment.
- Node/access/named-trail construction.
- QA.
- Provenance compaction.
- Partitioning, JSON serialization, hashing, and compression measurement.

Record elapsed time, record counts, `heapUsed`, `heapTotal`, `external`, and
RSS. Telemetry must not change artifact bytes. Use cached Midpen inputs for one
diagnostic run only if they are present; otherwise prove instrumentation with
fixtures and report the missing local prerequisite.

Deliverable: a focused commit plus a profile identifying the dominant live-set
and copied-sort/string/buffer peaks. Do not implement speculative storage or
raise the heap.

Acceptance:

- Telemetry is opt-in and tested.
- Normal builds remain byte-identical to the pre-instrumentation builder.
- The next task has evidence naming the peak stage and retained structures.

## P2 — Streaming artifact writer

Branch: `codex/trails-streaming-writer`
Dependencies: accepted P1 profile

Refactor serialization without changing canonical trail semantics:

- Write managed artifacts to a temporary output tree one shard at a time.
- Calculate SHA-256 incrementally.
- Measure compressed bytes through a stream instead of retaining a synchronous
  full-content gzip buffer.
- Avoid one in-memory `payloads` object containing every serialized artifact.
- Avoid simultaneous pretty/stable JSON copies of large objects.
- Publish the completed output directory only after all files and the manifest
  succeed.
- Preserve safe cleanup of obsolete managed files and unrelated-file safety.

Keep the existing in-memory fixture API when useful for unit tests, but the
production file build must use the bounded writer.

Acceptance:

- Existing Yosemite artifacts remain byte-identical or a reviewed schema
  migration explicitly accounts for every difference.
- Failure leaves no apparently complete output.
- Fixture and Yosemite tests cover hashes, sizes, cleanup, and determinism.
- Profile evidence shows serialization peak memory materially reduced.

## P3 — Bounded staging and algorithms

Branch: `codex/trails-bounded-staging`
Dependencies: P1 and P2; start only if Gate E still fails

This is conditional. Use the P1/P2 profile to fix the remaining demonstrated
peak rather than rewriting the pipeline wholesale.

Candidate techniques:

- Replace repeatedly sorted pending arrays with a deterministic binary heap.
- Remove copied global sorts where ownership permits an in-place sort.
- Spill normalized candidates/provenance to an on-disk temporary store.
- Use a disk-backed spatial/order index for merge candidates if merge remains
  the dominant live set.
- Process connected components incrementally while preserving cross-boundary
  topology.

Do not partition the canonical graph spatially without a reviewed boundary
reconciliation design. Temporary build state must remain local, ignored, and
recoverable after interruption.

Acceptance: Gate E passes without `NODE_OPTIONS` or a larger heap.

## Gate E — Bounded deterministic build

Midpen must build twice from the same cached inputs with:

- Node's default heap and no heap-related `NODE_OPTIONS`.
- Byte-identical manifests and artifact hashes.
- No network access.
- Stage telemetry showing at least 25% heap headroom at the observed peak.
- No partial output presented as complete after an injected writer failure.
- Targeted tests, all trail tests, lint, and the application build passing.

Do not repeat the other large regions merely to pass Gate E.

## P4 — Artifact contract v2 and bounded partitions

Branch: `codex/trails-artifact-v2`
Dependencies: accepted P2; may proceed before conditional P3 only when the
serializer boundary is stable

Implement the manifest-driven v2 contract and two-character partitions. Keep
v1 Yosemite readable so the product can migrate independently.

Acceptance:

- Partition lookup uses the index/manifest, not a hardcoded prefix width.
- Search index generation supports v1 and v2 fixtures.
- Every manifest hash/size is verified by an offline validator.
- Runtime and diagnostic roles are explicit.
- Shard-size targets are enforced or explicitly reported.

## P5 — R2 fixture proof and storage decision

Branch: `codex/trails-r2-proof`
Dependencies: Phase 1 integration; final production layout waits for P4

Use the Sites storage workflow and a small fixture/Yosemite subset to prove:

- A logical private R2 binding behind application code.
- Local development fallback without production credentials.
- Range/stream/object reads needed by the geometry endpoint.
- Correct content type, cache headers, ETag/hash validation, 404, and transient
  failure behavior.
- No public bucket or `r2.dev` dependency.

Do not upload the T8 cached corpora and do not activate a production region.

Acceptance: an architecture decision records whether R2 satisfies the runtime,
operational, and cost constraints. If it does not, stop before introducing a
second storage system.

## P6 — Versioned publisher and runtime adapter

Branch: `codex/trails-versioned-publisher`
Dependencies: accepted P4 and P5

Implement an explicit, non-request-path publication tool:

1. Validate a complete local artifact directory.
2. Upload immutable build-ID objects.
3. Verify remote sizes and hashes.
4. Refuse activation when QA is not accepted.
5. Activate `current.json` last.
6. Support rollback to the prior accepted build ID.

Update the trail API to load approved manifests/geometry from the private
binding while preserving metadata-first responses and lazy selected geometry.
Do not make ordinary search requests list bucket contents.

Acceptance:

- Fixture publish, failed publish, retry, activation, and rollback are tested.
- Re-uploading the same build is idempotent.
- A missing or corrupt object fails closed with a useful service response.
- No credentials or physical bucket IDs are committed.

## P7 — Access-point and response scaling

Branch: `codex/trails-access-scaling`
Dependencies: stable v2 search metadata contract

T8 produced 24,029 access points, predominantly derived public-road evidence.
Prevent a large drive polygon from returning or rendering thousands of markers:

- Deduplicate geographically equivalent access points deterministically.
- Rank official, mapped, and derived evidence without promotion.
- Return representative access points and a total count in list metadata.
- Load full access detail only for a selected trail when necessary.
- Add marker clustering or a reviewed display cap at low zoom.

Do not remove graph entry nodes needed by later custom routing. Product
summarization and canonical graph retention are separate decisions.

Acceptance: response byte and marker-count tests cover the largest cached
regional metadata, or a synthetic fixture matching its measured shape.

## Gate F — Storage and runtime delivery

- Artifact v2 validator passes.
- Private object reads work through the API.
- Publish and rollback are atomic from the application's perspective.
- Runtime shard-size targets pass.
- Search remains metadata-first.
- QA and full provenance are not ordinary public/eager assets.
- A large access-point corpus stays within reviewed response/marker budgets.
- Existing Yosemite search and reachability behavior remain compatible.

## P8 — Regional deterministic builds and manual QA

Branch pattern: `codex/trails-qa-<region>`
Dependencies: Gate E and Gate F

Process regions separately in this order:

1. Bay Area — Midpen
2. Bay Area — East Bay
3. Sierra National Forest
4. Tahoe–Eldorado

For each region:

- Build twice from identical cached inputs.
- Verify byte-identical artifacts.
- Review source counts, merge conflicts, ambiguous snaps, isolated components,
  access credibility, elevation coverage/outliers, and artifact sizes.
- Review representative named trails and access points manually.
- Produce a compact human-readable Gate G report.
- Do not activate the region.

Tahoe must explicitly resolve or document its 35 edge flags and one aggregate
elevation flag. A region's QA agent may not accept another region.

## Gate G — Per-region publication acceptance

A region may be proposed for activation only when:

- Two default-heap builds are byte-identical.
- Its source manifest and full artifact set validate.
- Every searchable result has credible connected access under current policy.
- Elevation flags are resolved or accepted with documented product treatment.
- Runtime sizes and access-response budgets pass.
- A human-readable QA review says `PASS` or `PASS WITH DOCUMENTED EXCEPTIONS`.
- The integrator independently reviews the report and manifest.

## P9 — Product activation

Branch pattern: `codex/trails-publish-<region>`
Dependencies: that region's Gate G acceptance

Activate one region per focused change. Update the available-region control
plane, search metadata, API tests, UI region behavior, and active manifest
pointer. Do not combine first publication of multiple regions.

Activation order follows P8 unless the user explicitly changes product
priority. Rollback must be verified before the next region begins.

## Agent coordination

1. Every worker uses a separate worktree and focused branch.
2. Workers start from the current `codex/trails-data` integration commit unless
   a task names a later dependency commit.
3. The integrator owns this plan, `.openai/hosting.json`, shared package scripts,
   active-region metadata, and final merge resolution.
4. No worker refreshes sources or runs a large regional build unless its task
   explicitly authorizes that exact region and run count.
5. Do not rerun a six-minute-plus build merely to reconfirm unchanged evidence.
6. Workers never commit `.cache/trails/`, credentials, physical bucket IDs, raw
   PBF/DEM/agency snapshots, or unaccepted regional artifacts.
7. Each worker delivers one focused commit, exact commands, measurements, test
   results, and remaining decisions.
8. A task that changes artifact bytes must state why and update deterministic
   fixtures/contracts.
9. Browser QA and deployment occur only when explicitly requested.
10. No worker marks a gate passed; the integrator reviews gate evidence.

## Recommended execution waves

Wave 1:

- Launch P1 only. Its evidence determines whether P3 is required.
- P5 may explore the binding with fixtures in parallel only if it avoids final
  production schema decisions and shared files.

Wave 2:

- P2 from the accepted P1 profile.
- Conditional P3 only if the measured build still cannot pass Gate E.

Wave 3:

- P4 artifact v2.
- Finish P5 against the accepted v2 layout.
- P7 may design/tests against v2 metadata without publishing regions.

Wave 4:

- P6 versioned publisher/runtime adapter.
- Gate F integration review.

Wave 5:

- P8 and P9 sequentially per region.

## Phase 2 completion

Phase 2 is complete when all four T8 regions have individually passed Gate G,
can be activated or rolled back through immutable versioned manifests, and the
application serves their searchable metadata and lazy geometry without Git-
bundled corpora or unbounded builds.
