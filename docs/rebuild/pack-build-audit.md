# Pack-build efficiency and architecture audit

2026-09-22. Reviewed application revision `1e70404e0fbcb6f35d4612820b1faa685442af1a`.
This is an audit and proposed implementation sequence; no builder changes have
been implemented by this work.

## Recommendation

Improve the existing builder first. There are substantial avoidable allocations,
repeated preparation, and three reproducible cache/identity defects. Most early
fixes can replace or remove code. The shared regional builder, immutable source
cache, offline compiler, and audit-before-activation design are useful and should
remain. A general workflow engine, another storage backend, or a rewrite would
add complexity before addressing the demonstrated problems.

Prebuilt packs remain useful for application developers who do not change data
preparation. They complement an efficient builder; they do not resolve its cache
correctness or reproducibility problems.

## Scope and evidence limits

- Traced acquisition, OSM normalization, official-trail conflation, portals,
  elevation, compilation, persisted audits, activation, and Docker/native setup.
- Ran offline synthetic reproductions of boundary-cache reuse, cache relocation,
  and DEM fingerprint drift. Temporary reproduction directories were removed.
- Measured selected production operations against existing local Cascades data.
  No network acquisition or full regional rebuild was performed.
- Existing inputs use Washington **August 6**, whereas current configuration pins
  **August 1**. Measurements establish realistic scale, not exact performance of
  the new pin. Tommy's failure stage, Docker allowance, and error remain unknown.
- Native measurements used Node 24.11.0 and osmium 1.19.1 on this Mac. Earlier
  hardware inspection found 16 GiB physical RAM and about 7.8 GiB available to
  Docker. These measurements do not establish a supported minimum RAM size.
- Baseline `npm test -- lib/data scripts/alpine.test.ts`: **168 tests passed in
  34 files**. A read-only audit of installed Cascades `cc-f1cb28a4ceb6e896`
  completed with **zero errors**. No app changes required a production/browser
  integration gate.

## Measurements

RSS means resident memory used by a process. These are **separate process
measurements**; do not add their peaks together or present them as whole-build
peak memory. No optimized full builder was measured.

| Operation | Observed result | Interpretation |
| --- | --- | --- |
| Current whole-file SHA-256 helper, 360,317,339-byte PBF | 435–438 MiB peak Node RSS across two runs | Allocates a source-sized buffer. |
| Temporary streaming SHA-256 comparison, same PBF | 120–121 MiB peak Node RSS across two runs; identical digest | Roughly 315 MiB less process peak for this operation; shared cache code already uses this technique. |
| One existing topology JSON read/parse | 444 MiB peak Node RSS | The 81,878,202-byte JSON contains 363,074 nodes and 10,378 ways. |
| Actual `osmium extract --strategy complete_ways` | 2.66 s; 1.93 GiB child-process peak RSS | External extraction itself has a material memory floor on this input. Changing Node settings alone cannot eliminate it. |
| Standalone persisted Cascades audit | 35.56 s; 2.05 GiB peak Node RSS | Auditing a finished artifact is itself a large allocation stage. |
| Exact-coverage portion of that audit | 30.29 s, approximately 85% of audit time | Strong measured CPU optimization target; not 85% of the entire build. |

The audited pack contains 271,413 nodes and 540,007 directed edges. Its boundary
contains 2,026 coordinate positions. Forward edges contain 620,074 stored
elevation samples. Current metric batching therefore implies about 55 Python
calls for its 271,711 forward segments, plus the node-elevation call; this call
count is inferred from code/data, not an end-to-end subprocess trace.

## Findings and smallest coherent changes

### 1. Prepare OSM once; fix dependent cache identities at the same seam

**High priority: measured allocation waste and reproduced correctness defect.**

`lib/data/osm/pipeline.ts:54` calls `prepareOsmTopology()` just to return the
regional PBF filename. That reloads topology and rehashes the raw source. A build
that actually compiles a new artifact invokes topology preparation four times:

1. Main preparation, `lib/data/regional-builder.ts:317`.
2. Building preparation, `lib/data/osm/buildings.ts:82`.
3. Named-area validation, `lib/data/osm/named-areas.ts:136`.
4. Named-area normalization, `lib/data/osm/named-areas.ts:140`.

The last three topology results are discarded. Reusing an already-compiled pack
still performs the first two calls before the compiler's reuse check. Meanwhile, the building and
named-area cache keys include the source and their adapter version but omit the
boundary hash. The topology cache correctly includes it. An offline test with
two boundaries produced two regional extracts but reused the first boundary's
buildings and named areas. This can change nearby-building counts and omit or
retain inappropriate named areas during boundary development.

**Change:** one OSM preparation module should return the topology, prepared
regional PBF path, and its preparation identity. Buildings and named areas
consume that artifact and derive their keys from its identity plus their own
adapter version. Normalize and validate named areas in one operation. Replace
the recursive preparation interface; do not add a second cache layer.

**Verify:** same-input reuse, boundary-change invalidation, source/version-change
invalidation, one topology load, existing regional compatibility fixtures, and
equivalent persisted data/audits. Bump affected cache versions to invalidate old
incompletely keyed artifacts.

### 2. Stream hashes and avoid cloning unchanged topology

**High priority: low-complexity changes with clear memory benefit.**

- `lib/data/file-source.ts:5` hashes a whole `readFile()` buffer. The source-cache
  module already contains a streaming hash loop. Consolidate that implementation
  and preserve byte-for-byte checksum validation.
- `lib/data/official-trails/conflate.ts:346` clones every original node and way,
  including flags, source arrays, and way coordinate arrays. Existing nodes are
  not mutated; modified ways are already replaced later. Cached Cascades
  inspection found all 363,074 original nodes copied, but only 57 of 10,378
  original ways changed in value. Shallow-copy the containers and retain
  unchanged records, copying only changed records.
- `lib/data/topology-compiler.ts:7` defines a dense edge by extending the full
  compiled edge, then spreads each record when it needs only a small subset for
  topology traversal. Give this internal representation only the fields it uses.

**Verify:** equal hashes on empty/small/large fixtures; frozen-input conflation
tests and identical output; topology hash and directed-access regressions. No
pack-schema or metric-algorithm change should be necessary for equivalent output.

### 3. Stop materializing entire SQL result sets and attribution copies

**High priority: the audit alone reached 2.05 GiB.**

`lib/data/audit/sqlite-pack-audit.ts:155` loads all edge rows before mapping them
to another representation. Profile validation at `:250` separately loads all
profile rows even though it consumes them one at a time.
`lib/data/audit/audit.ts:57` then clones every node, edge, and access point solely
to attach a type label for two attribution checks.

**Change:** iterate SQL rows; retain only the parsed data actually needed for
connectivity; validate profiles as rows arrive; walk the three existing record
collections directly for attribution. Keep the persisted-artifact audit
independent of compiler assumptions. These changes do not require a new audit
framework. After removing these duplicates, measure whether further reduction
of the retained connectivity graph is worthwhile.

The audit runs inside the compilation call before activation. The combined
compiler-plus-audit peak was not measured; the standalone number is not a claim
about how much compiler state remains live at that point.

**Verify:** identical audit reports on valid and deliberately corrupted fixture
databases, including attribution, missing nodes, malformed profiles, directed
access, and coverage. Repeat the standalone and whole-build memory measurements.

### 4. Batch temporary compilation work, not just sampler input

**High priority for fresh builds; full-stage memory saving remains unmeasured.**

`lib/data/compiler.ts:96` samples all trail-node elevations in one call.
The sampler serializes the complete coordinate list, buffers stdout, and parses
another full list (`lib/data/elevation/uv-rasterio-sampler.ts:47`). Python also
materializes points, result values, tile indexes, and per-tile coordinate lists
(`tools/dem/sample_dem.py:47`).

`lib/data/metrics.ts:244` does batch 5,000 segments, but returns the accumulated
metrics for the entire region. The compiler first constructs all segment plans,
then all metric results, then all directed edges. Metrics retain raw `samples`
alongside the published profile even though the compiler does not consume them.
Batching segments also does not bound the number of densified coordinates.

**Change:** process a bounded batch of segment plans through sampling and edge
creation before releasing its temporary metrics; chunk node sampling as well.
Use a coordinate budget where densification can expand input. Remove unused raw
sample results after checking other callers. Keep the existing sampling algorithm,
point order, precision, missing-data behavior, and direction handling.

The final graph still scales with region size. The aim is bounded **temporary**
work, not a claim of constant total memory. Avoid a persistent Python worker
initially: smaller batches increase subprocess/open costs, so measure that
tradeoff before adding process lifetime, framing, and cancellation machinery.

**Verify:** equal metrics and pack contents across several batch sizes; node and
edge sample cardinality failures; missing elevations; reverse-edge profiles.
Measure parent and child memory together.

### 5. Reuse finished artifacts before expensive regional preparation

**Medium priority: the current warm-build interface checks too late.**

`lib/data/compiler.ts:408` checks for an existing build, but the regional caller
has already loaded topology, conflated official trails, derived portals, and
prepared buildings. Its version is computable from configuration, versioned
algorithms, and pinned source identities before those operations.

**Change:** resolve inputs and compute identity first, then take one reuse path
before topology preparation. Preserve integrity checking and the publication
policy. A warm build must not need to reconstruct the graph just to regenerate
reports for an unchanged artifact. Reuse accepted stored reports or run the
chosen persisted audit; do not silently skip required acceptance checks.

`scripts/pack-bootstrap.ts:27` also makes ordinary retries a refresh. That
contacts the live DEM catalog and rechecks cached tiles even with local pins.
Normal builds should ensure the configured inputs are available; rediscovery
should be explicit. Validate source integrity once per invocation, rather than
removing checks or introducing a process-global trusted-path cache.

**Verify:** warmed unchanged fixture build performs no preparation/sampling;
changed input invalidates reuse; invalid artifact fails or rebuilds without
replacing the previous current pack; cached build works with network unavailable.

### 6. Make source caches portable and build identity content-based

**Medium priority: two reproduced development/reproducibility defects.**

**Absolute paths:** OSM pointers persist `cached.filePath`
(`lib/data/osm/source.ts:43`), and DEM pointers persist `collectionPath`
(`lib/data/elevation/source.ts:44`). Other source pointers follow this pattern.
Docker writes `/app/...`; native runs have different roots. A temporary cache
relocation reproduced an `ENOENT` against the old location.

Persist paths relative to the cache root, resolving them on read. Provide a small
compatibility path for old pointers. Test relocated caches and Docker/native
reuse with networking disabled.

**Identity drift:** DEM `contentHash` hashes the entire collection JSON
(`lib/data/elevation/source.ts:56`), including retrieval timestamps and receipt
metadata. Two fresh fixture caches with identical product bytes produced the
same collection-directory identity but different source hashes when only
retrieval time changed. That hash enters the regional data version.

Build identity should use sorted product IDs, tile hashes, and output-relevant
configuration. Keep retrieval metadata as provenance. Preserve the distinction
between a raw file checksum and a semantic build fingerprint; do not silently
redefine checksum validation. Existing collection identity logic provides a
starting point. This changes generated identities and needs explicit versioning,
but not a runtime graph-schema redesign.

**Verify:** equal build identity across roots/retrieval dates for equal content;
changed tile or relevant configuration changes identity; provenance remains intact.

### 7. Optimize exact-coverage checks after the allocation fixes

**Medium priority: strongest measured CPU target.**

`lib/data/audit/sqlite-pack-audit.ts:522` checks every directed edge.
`lib/graph/geometry.ts:130` repeatedly scans all boundary segments, constructs
intersection arrays, and performs point-in-polygon checks. Forward and reverse
geometry ordinarily repeat the same physical segment.

First consider a prepared coverage predicate that reuses polygon information and
rejects irrelevant boundary segments cheaply. Reuse a result for reverse edges
only after verifying their geometry is actually identical/reversed; a persisted
audit must still detect a corrupted reverse edge. Choose between those approaches
with a small benchmark instead of stacking both optimizations automatically.

Do not replace exact coverage with endpoint-only or bounding-box checks, simplify
the installed boundary, or change reference-complete OSM extraction to save RAM.
The [osmium extraction manual](https://docs.osmcode.org/osmium/latest/osmium-extract.html)
documents that its `simple` strategy can leave incomplete ways.

**Verify:** holes, concave boundaries, boundary-touching edges, multipolygons,
crossings with inside endpoints, and corrupted reverse geometry. Equal audit
reports and unchanged rejection decisions are required.

### 8. Delete the unused parser and unnecessary intermediate files

**Low risk, useful code reduction.**

Production uses OPL. `normalizeOsmFeatures()` and `readOsmGeoJsonSequence()` in
`lib/data/osm/normalize.ts:215` have only test callers. Their dedicated schema and
helpers account for roughly **140–150 production lines**. Port unique behavior
coverage to the production parser, then delete this parallel implementation.
Keep shared access/classification functions.

Once normalization succeeds, `hiking.opl` and `hiking.osm.pbf` have no downstream
consumer. Named-area filtered/export files are similarly retained unnecessarily.
Delete them before completing preparation, following the existing building
preparation pattern. Keep `region.osm.pbf`, which has real downstream consumers.
The cached Cascades OPL alone occupies 32 MiB.

Streaming OPL lines also avoids whole-file text plus split-line arrays
(`lib/data/osm/opl.ts:83,191`). This is worthwhile after the larger redundant
topology loads; preserve the same parser and error line numbering.

## Other observations

- Atomic staging, audit-before-activation, committed offline fixtures, shared
  region definitions, and server-only runtime data are good foundations.
- Downloads already stream and hash on arrival. Improve their reuse lookup to
  check receipt URL/size before hashing unrelated cached objects
  (`lib/data/source-cache/cache.ts:78`).
- A failed download currently discards partial bytes, with no explicit retry or
  deadline. Add a small bounded transient-failure policy if needed. Range-resume
  state is a later addition justified by observed failures, not a new generic
  workflow engine.
- The test named "treats catalog size as advisory" only checks positive metadata;
  collection preparation actually passes it as mandatory `expectedByteLength`.
  Exercise the acquisition interface with mismatched catalog/response sizes and
  agree on one policy. The existing status file records a real Santa Cruz size
  mismatch; this audit did not re-download that source.
- Docker layer caching already avoids rebuilding all dependencies for routine
  source edits. Rasterio's ARM64 source installation is an initial tool-image
  cost, not a demonstrated dominant regional-build bottleneck. Do not replace
  the toolchain based on that suspicion alone.
- More simultaneous heavy stages or pack builds would increase peak memory.
  Shared ownership and bounded temporary work are better first steps.

## Implementation sequence and acceptance

1. **Preparation correctness and cheap allocations:** stream hashing; prepare
   OSM once; fix derived identities; remove repeated named-area preparation;
   copy only changed conflation records; remove obsolete parser after test parity.
2. **Compiler and audit memory:** consume metric batches promptly; bound node
   sampling; iterate SQL results; remove attribution/dense-edge copies. Re-measure
   before considering a more extensive on-disk graph compiler.
3. **Developer reuse:** portable source pointers, content-based build identity,
   explicit acquisition/refresh behavior, and an early finished-artifact path.
4. **Measured CPU work:** optimize exact coverage, then revisit Python startup or
   OPL streaming only if profiles still justify the added code.

Track production and test LOC separately. Wave 1 has a plausible net reduction;
the approximately 140–150 dead parser lines are a concrete deletion candidate,
not a promised net total. Batching and cache compatibility may add code. Accept
that code when it removes a demonstrated resource problem or correctness defect.

For implementation acceptance, compare cold preparation with sources cached,
warm no-op rebuilds, interrupted retries, and native/container cache reuse. Record
wall time, parent/child or container peak memory, and artifact equivalence.
Use a **4 GiB container with swap disabled as an initial test target**, not as an
advertised requirement; measure a real Cascades build before claiming support.
Also check the other regional definitions with committed compatibility fixtures
and relevant real artifacts. Run the runbook's integration checks for implemented
changes and preserve exact coverage, access rules, metric accuracy, source
attribution, and atomic publication throughout.
