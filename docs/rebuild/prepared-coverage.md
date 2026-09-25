# Developer builds and downloadable coverage

## Product boundary

Developers build one coherent, audited release. Users select quarter-degree map
sections and download prepared data. Sections are generated from published
coverage, not a curated catalog of region names. Named hiking regions continue
to filter starting points. The exact installed union is the route boundary.

One bounded reader opens immutable SQLite artifacts directly. It holds at most
eight connections, with bounded SQLite caches. No local merge or graph rebuild
occurs during installation. Complete source segments and endpoint records may
appear in adjacent files; stable release-wide identities deduplicate them.
Coordinates never imply a connection.

## Release contract

`lib/contracts/releases.ts` defines releases, installation references, download
plans, and persistent download jobs. Release metadata includes sections,
section-to-file mappings, exact geometry, raw SHA-256 identities, compressed
and installed sizes, source dates, attribution, limitations, and named search
regions with aliases. Artifacts are `objects/<sha256>.sqlite.gz`.

Schema 7 stores two nullable minimum approach distances per starting candidate,
for known access and for known plus unknown access. Null proves no physical
cycle in the complete release. A finite value is a conservative lower bound for
any installed subset with unchanged edge identities, directions, and lengths;
it does not prove a cycle is installed. Missing or corrupt hints are errors.
Distance, repeated-trail, and shared-approach pruning remain in the solver.
Candidates are preserved before global representative suppression.

## Developer workflow

`npm run data -- build recipe.json` inventories pinned sources before clipping,
uses disk-backed staging and verified metric caches, derives combined topology,
and audits the complete release before export. There is no periodic section
publication. Re-running a build verifies receipts and reuses completed work;
changed inputs invalidate dependent stages.

`npm run data -- inspect release.json` verifies compressed files, raw checksums,
SQLite integrity, graph records, and per-artifact counts. Example recipes are
`data/coverage/recipes/cascades.json` and `olympic.json`; relative config and
geometry references resolve from the recipe file.
`npm run data -- export export-options.json` partitions a completed graph into
compressed artifacts and emits its static catalog. There is no hosted-service
dependency. The catalog can be served from static HTTPS storage.

Build environment:

- `ALPINE_SOURCE_CACHE`: pinned downloads and metric inputs.
- `ALPINE_COVERAGE_ROOT`: developer staging (use a separate directory from app installations).
- `ALPINE_RELEASE_ROOT`: exported release, default `.local-data/releases/prepared`.

The Docker `data` service sets a 4 GiB memory limit and equal memory-plus-swap
limit, disabling swap. Native resource checks are a monitored target. Large
collection acceptance requires an actual successful constrained build.

## User workflow

Coverage sits beside Settings on the shared map. Click sections to select them;
the panel shows selection size and starts installation with one Download action.
Disk-space checks run before creating the job. Pause, resume, cancel, update,
and remove use the same installation service.

`ALPINE_COVERAGE_CATALOG` is a static HTTPS release.json URL or local release
directory. `ALPINE_COVERAGE_ROOT` defaults to `.local-data/coverage` for the app.
Docker persists installations in its runtime volume and reads developer
releases from a separate read-only mount. No public catalog URL is provisioned
by this implementation.

Workers run outside HTTP lifetimes. Downloads verify declared sizes, checksum,
and schema before atomic activation. The previous installation remains usable
until the entire request is ready. Updates use one release for all selected
sections. Removal changes references; it does not rewrite SQLite graphs.
Verified work survives pause, cancellation, and process interruption.

## Migration and retention

Existing packs require a one-time reinstall from broader source inventories.
The app has one prepared-data runtime. Legacy saved route geometry, metadata,
and exports remain readable through the stored-result compatibility parser.
Unfinished legacy jobs require cancellation/restart before prepared activation.
Existing pack files remain on disk until replacement coverage is verified.

Running searches pin an immutable installation. Saved job references retain
its files during cleanup. Missing or corrupt reference history prevents
cleanup. Release changes do not silently retarget a running search.

## Acceptance

[Status](status.md) tracks the gates. Offline fixtures cover cross-file graph
and route equivalence, boundary and corner contacts, partial coverage, corrupt
metadata, download recovery, atomic activation, retention, and solver rules.

Real-data acceptance separately measures developer build memory/disk/time,
resume cost, installation and expansion time/storage, and Full search
behavior. West Cady, Pilchuck, and the cut approach remain explicit geographic
regressions. A fixture pass does not establish Cascades-sized feasibility.

### Recorded real-data checks (2026-09-24)

These measurements use a 26-section, corrected-source partial Cascades graph;
they do not establish acceptance of the complete Cascades collection.

| Measurement | Result |
| --- | --- |
| Compressed download | 112,356,021 bytes |
| Installed SQLite artifacts | 406,327,296 bytes |
| Equivalent monolithic SQLite | 400,793,600 bytes |
| Artifact storage overhead | 1.38% |
| Export | 33.27 seconds |
| Native first small section | 37 ms; 285,743 download bytes |
| Native expansion to 26 sections | 3.69 seconds |
| Native verified-cache reinstall | 4.35 seconds; zero downloaded bytes |
| Native installer peak RSS | 239,714,304 bytes |
| App HTTP download/activation in a 512 MiB swap-disabled container | 18.01 seconds; zero OOM events |

The app smoke test used the detached production download worker. Its image
contains no Python, GDAL, osmium, source caches,
or compiler runtime. Installation timings above use local delivery and include
verification; HTTPS time additionally depends on network throughput.

A copy of the real saved-job database retained all 17 jobs and 894 results,
with identical SHA-256 of the ordered result payloads after opening with the
new store. The original database and legacy pack files were not modified.

A Full-only comparison matched all nine route/graph outputs. A three-start
session, including one-time preparation, took a median 2,096 ms for the legacy
reader and 2,308 ms for prepared files. Preparation was 22 ms versus 65 ms and
is reused across starts. The reader remained within eight connections. Full
collection builds, second geography, final source comparison, and production
reinstall remain pending.

The production app image is 232,272,093 bytes with developer dependencies and
Next build caches excluded. Cleanup retired duplicate validation outputs and
superseded staging, retained reports, and shared 21 byte-identical immutable
source files through hard links. Host free space increased from about 9 GiB to
31 GiB; installed packs and saved results were retained. Future validation uses
one shared source cache and retires superseded outputs instead of accumulating
per-run copies.

Migration must disclose that official agency inventories currently serve as
reference audits, not additional routing edges. In particular, legacy Central
Cascades contains about 116.85 km of official supplemental edges whose absence
must be reported in the replacement comparison. Proximity-based legacy joins
are not restored to hide this source difference.


## Full-only search revision

Quick search is removed from the app, HTTP endpoints, settings, worker protocol,
and solver policy. Full search uses one prepared session per worker and one
bounded solve per start. The former internal two-mode union is removed as well.
Saved geometry and job results remain readable. Search comparisons for new
acceptance runs measure this single production path and report preparation cost
separately from per-start work.

The final image returned HTTP 404 for the removed endpoint and completed a
real one-start Full job with five exact routes in 2.17 seconds under a 512 MiB,
swap-disabled limit, with no OOM events. Two full verification passes each
passed 597 tests; two browser passes each passed nine desktop/mobile flows.
