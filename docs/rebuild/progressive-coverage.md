# Progressive coverage

This implements the accepted separation between collections, installation units,
processing batches, and routing snapshots. The acceptance gates below remain
the release criteria; a passing small fixture is not a large-region result.

## Keep the implementation small

The app and CLI use one persistent coverage service. The builder reuses OSM
classification, access overrides, edge metric calculation, directed-edge
construction, and the schema-6 SQLite definition. Exact polygon union uses
`polygon-clipping`; it does not introduce a second routing engine. The existing
solver and its budgets remain in use. Global derived topology is recomputed
at publication instead of maintaining another incremental topology algorithm.

Coverage metadata has its own version-1 contract. Routing databases remain
schema 6, so existing graph readers and saved route geometry stay compatible.
Legacy databases supply selection metadata and aliases, never graph edges.

Legacy packs are a migration bridge. Rebuild their coverage from pinned source
inputs, validate the replacement, and only then hide fully superseded packs.
Keep generations referenced by running or saved jobs. Once migration is proven,
retire the old pack-specific build commands and redundant compatibility code;
retain the shared source adapters, metrics, SQLite reader, and hike solver.

## Boundaries and evidence

- Collections are independent review envelopes. Quarter-degree units are
  intersected with requested geometry, configured source extent, and reviewed
  exclusions. They select work, not separate routing graphs.
- Source inventory is recorded before installation clipping. Every covered
  source trail segment must be accounted for before publication.
  Intended uninstalled trails and explicit policy exclusions are classified
  once per source import; publication reconciles only the installed subset.
- Runtime coverage is the exact installed union. Shared OSM identities connect
  adjacent areas; coordinate proximity never creates a graph connection.
- The independent USGS comparison is a diagnostic reference inventory.
  Proximity there is evidence for review, not proof of identity or connectivity.
  Missing reference coverage is reported separately from compiler loss.
- Beach paths are eligible where mapped. Tide timing is not modeled.
- Provider polygons, the preserved Yakama exclusion, and the West Cady,
  Pilchuck, and Forest Road 63 regression inputs carry source provenance.

Publication writes an immutable directory and changes `current.json` only
after audit. Job control serializes the activation with cancellation. Searches
pin a generation, saved jobs retain their version references, and cleanup
shares a lock with activation and pin registration. Missing or corrupt
reference history prevents cleanup.

## Local use

Open **Coverage** next to **Settings** in the builder. Coverage uses the main map
and a temporary side panel; returning to planning preserves the search draft
and results. Installation drawing is separate from the search-area drawing.
The same persistent service is available through:

```sh
npm run coverage -- catalog
npm run coverage -- plan /absolute/path/request.json
npm run coverage -- build PLAN_ID
npm run coverage -- status JOB_ID
npm run coverage -- pause JOB_ID
npm run coverage -- publish JOB_ID
npm run coverage -- resume JOB_ID
npm run coverage -- cancel JOB_ID
```

A request can select collections or supply GeoJSON geometry:

```json
{"collectionIds":["washington-cascades"],"memoryLimitMiB":4096,"offline":true}
```

`ALPINE_SOURCE_CACHE` points to pinned source downloads. `ALPINE_COVERAGE_ROOT`
and `ALPINE_PACK_ROOT` control preparation and installation paths. App and CLI
must use the same jobs database for shared installation roots. Configured
`osmium`, `uv`, and the existing DEM environment are local prerequisites.

The Docker app includes those build tools. Its coverage job store and staging
live in the persistent runtime volume; downloads use the shared source cache.
Run `docker compose exec app npm run coverage -- ...` to use that app's jobs and
writer lease. A native CLI installation uses its own configured job store.

Unknown download and temporary-disk estimates are displayed as unknown.
A small area can require a whole upstream OSM extract. Resource monitoring is
cooperative outside a container; the memory setting is not an OS hard limit.
Preview reads source receipt metadata and file sizes, including existing source
staging, without hashing large downloads. Cached bytes are availability evidence;
the worker verifies their contents and checkpoints before reuse. Configured OSM
downloads are quantified separately because required elevation/reference inputs
and peak working disk cannot yet be estimated reliably from this metadata.

## Acceptance and measurements

Baseline: the four existing Cascades SQLite artifacts total approximately
1.19 GiB including overlap, before filling omissions. This is disk usage, not
RAM. Runtime graph loading and Quick/Thorough budgets remain bounded by the
existing solver. See [coverage investigation](cascades-coverage-audit.md) and
[solver measurements](solver-acceleration-audit.md).

The isolated measurement harness is:

```sh
node --import tsx scripts/research/coverage-feasibility.ts \
  --request /absolute/path/request.json --work-root /absolute/path/work \
  --source-cache /absolute/path/sources --output /absolute/path/result.json
```

Reusing `--work-root` measures resume and expansion. `--stop-after-units N`
provides a controlled interruption. Reports include stage timings, process-tree
RSS where available, cgroup memory, and temporary disk usage. Large-region
acceptance requires successful completion in a 4 GiB, swap-disabled environment,
plus search latency, expansion, resume, and a second geography.

Linux measurements include allocated blocks in unlinked temporary files held
by the process tree, deduplicated by device and inode. Periodic sampling retains
the disk peak between reported stages. External cached downloads are excluded
from the working-disk total; downloads owned by the work root are included.

The first real Washington import processed 54.3 million source records. It
exposed unsupported building relation geometry and a repeated full-inventory
scan during connected-footpath classification. Unsupported context is now
accounted for explicitly; classification uses an indexed disk-backed frontier.
The checkpointed source inventory was reused for continued measurements.
These observations are not a successful large-region acceptance result.

Resume validation exposed per-row temporary-index commits. In an isolated
100,000-row SQLite measurement, bounded batches reduced insertion from
5.95–6.64 seconds to 0.53–0.78 seconds while preserving interruption/replay.
Publication also exposed a quadratic physical-member selection query: 1,000,
3,000, and 6,000 physical groups took 248, 2,184, and 9,009 ms. Indexed membership
joins took 2.7, 6.1, and 11.9 ms with the same rows. These isolate the query costs;
they are not end-to-end build speedup claims.
The subsequent real 18-unit publication wrote its graph in 6.30 seconds with the
indexed join. The complete collection build remains the acceptance target.

Dense-unit profiling then found per-record context commits. Shared bounded
transactions reduced an isolated 3,000-row write from 608 to 159 ms for ways and
469 to 30 ms for buildings. Context commits before metric work and checkpoints;
one source way larger than the 1,000-node batch target remains indivisible.

Real-source regression inspection found a separate decoder defect: valid OPL
`Forest%20%Road%20%63` became `Forest Road c`. The decoder now follows the
[OPL Unicode escape format](https://osmcode.org/opl-file-format/#3-encoding),
consuming both delimiters and rejecting malformed escapes. Normalization v3
versions source-cache paths, receipts, progressive graph identities, and legacy
preparation inputs. The constrained trial restarted its normalized import using
the existing verified downloads; the previously published graph remains active
until its full installed area has been rebuilt and audited. Measurements below
predate this correction and are not final acceptance of the corrected graph.

The two-unit real-source request at `[-121.3,47.9,-121.1,48.0]` subsequently
completed in the 4 GiB/swap-disabled container. Starting from the interrupted
source inventory, it took 17 min 46 s; its first audited publication was at
14 min 42 s. Peak measured process-tree RSS was 1,143,009,280 bytes, and final
working-disk usage was 10,028,093,440 bytes (including source staging, excluding
the externally cached downloads). Cgroup peak, including reclaimable file
cache, reached the 4 GiB allowance without OOM. A one-start Quick search took
670 ms and returned one exact loop plus one close match, while explicitly
reporting solver-budget truncation. This is a small-installation result only;
Cascades-sized and second-geography measurements remain outstanding. A later
real integrity-check pause completed in 0.60 s; the integrity child was stopped
and the published snapshot remained active. File-backed integrity scans now run
in a child process so the build worker can service pause/cancel checkpoints.

After publishing ten units with metric algorithm v5, the same known trailhead
returned one exact loop and one close match in 783 ms while construction
continued in the constrained container. Solver-budget truncation remained
explicit. A different first eligible start returned no routes in 780 ms with
the same truncation disclosure; neither sample establishes broad search recall.

An isolated read-only migration check used the nine actual legacy installations.
Both reviewed selectors intersecting the current partial publication retained
their geometry, and all nine legacy packs correctly remained visible. A
metadata-only union of the actual legacy boundaries preserved all 35 reviewed
selectors and hid eight pure-OSM packs only once fully contained. Central
Cascades remains available: its legacy graph includes 83 supplemental ways
from 72 official source features, totaling 116.85 km of at-risk routing
contributions. The broader OSM inventory may represent some of that geometry,
but reference-source presence alone cannot prove replacement. Legacy proximity
attachments are not imported into the combined graph. A conservative indexed
provenance check prevents geometry-only retirement of supplemental routing.
All 17 saved jobs,
894 saved result payloads, and their pinned legacy versions remained readable.
This establishes metadata and saved-data compatibility, not acceptance of a
fully rebuilt routing graph; production data was unchanged.

The durable gate checklist and exact verification evidence are in
[status](status.md). Generated measurements, caches, and databases stay out of
Git. Automated tests use committed offline fixtures.
