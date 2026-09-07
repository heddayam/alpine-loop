# Region-pack onboarding checklist (schema 6)

Use this runbook for every new regional pack. It turns the approval gates in
the [regional expansion roadmap](regional-expansion-plan.md) into the current,
repeatable build procedure. The governing product rules remain in the
[implementation plan](implementation-plan.md), source rules in
[data-sources.md](data-sources.md), and the rationale for topology-derived
starts in the [access-point derivation plan](access-point-derivation-plan.md).

This checklist describes the code as it exists now: schema 6, OSM-derived
trail/street portals, cycle reachability, and nearby OSM building counts. Do not
copy schema-5 population, parking-snap, or authority-line work from an older
charter or status entry.

## Completion rule

A region is complete only when all of the following are true:

- its coherent hiking-network boundary, sources, licenses, restrictions,
  reviewed search regions, and scenarios have been reviewed and committed;
- one explicit network refresh has populated immutable source caches;
- two independent **offline** builds from those same caches have identical data
  versions and byte-identical output files;
- schema-6 portal, building, cycle, audit, and representative route evidence is
  acceptable;
- the installed pack passes application and browser checks; and
- only then, a focused activation change adds `packId` to
  `data/regions/registry.json` and records evidence in
  [status.md](status.md).

An installed directory does not activate a region. Conversely, adding
`packId` before the pack passes approval exposes a missing or invalid local
installation as unavailable and violates the onboarding order.

### Optimized phase map

| Phase | Network | Main output | Repeat rule |
| --- | --- | --- | --- |
| Plan/gate | Off | Detailed roadmap entry, unchecked status gate, charter/boundary decisions | Iterate cheaply before source acquisition. |
| Inputs/builder | Off | Committed config, regional definition, tests, scenarios, checkpoint | Focused tests as needed. |
| Refresh | **On** | Immutable source receipts/pointers plus an isolated refresh build | Once after metadata review; repeat only for explicit source correction/update. |
| Determinism A | Off | Installed but catalog-unlinked schema-6 candidate | Fresh preparation; `reusedExisting: false`. |
| Determinism B | Off | Isolated schema-6 candidate | Fresh preparation; `reusedExisting: false`; hashes equal A. |
| Data/route QA | Off | Audit, SQL, portal/building/cycle, and scenario evidence | Fix committed inputs, then rerun affected offline phases. |
| Activation | Off except live basemap/provider checks | Catalog link, full suites, manual app evidence, checked status gate | One region per focused change. |

## 1. Name the run and start the evidence ledger

Choose the catalog ID already present in `data/regions/registry.json`; it must
be a lowercase hyphenated slug. Record the pack ID, display name, owner,
working commit, start time, and intended activation gate in the ledger at the
end of this document.

Use the same ID consistently in the directory name, manifest seed, builder
registry, scenario file, checkpoint, installed-pack path, and final catalog
`packId`. Pick a short data-version prefix for the region builder (for example,
`seb` or `mc`; the shared builder adds the hyphen).

Before editing, read these current references completely:

- [regional-expansion-plan.md](regional-expansion-plan.md), especially the
  charter, boundary, source, build, QA, and activation gates;
- [data-sources.md](data-sources.md), especially portals, buildings, cache
  lifecycle, and licensing;
- [access-point-derivation-plan.md](access-point-derivation-plan.md), treating
  its measurements as historical observations rather than thresholds;
- `data/regions/southern-east-bay/` and `data/regions/monterey-carmel/` for two
  worked examples; and
- `lib/data/regional-builder.ts`, `lib/data/southern-east-bay-pack.ts`,
  `lib/data/monterey-carmel-pack.ts`, their tests, and their gate checkpoint
  scripts for the current implementation pattern.

## 2. Commit the region definition

For a later catalog region that previously had only a placeholder, first add
its specific included/excluded systems, boundary intent, source authorities,
and candidate reviewed regions to
[regional-expansion-plan.md](regional-expansion-plan.md). Add a new unchecked
gate with concrete acceptance criteria to [status.md](status.md); check it and
replace acceptance-only text with evidence only after the work passes. Neither
change should redefine shared product behavior.

Create `data/regions/<pack-id>/`. The following table separates mandatory
inputs from conditional material.

| Path | Requirement | Exact content or decision |
| --- | --- | --- |
| `charter.md` | Always | ID/name; intended users; included and excluded systems; managing authorities; neighboring-pack overlap; boundary rationale; candidate/retained/deferred search regions; representative starts; source/license/redistribution decisions; reviewed restrictions; preflight measurements; activation blockers. Date every external review. |
| `boundary.geojson` | Always | A GeoJSON `Feature` whose `properties.id` equals the pack ID and whose versioned `properties.boundaryVersion` is asserted by the region builder. The shared OSM preparation path accepts `Polygon` and `MultiPolygon`; every ring must be closed and valid. This is exact runtime coverage, not merely a download box. |
| `osm-source.json` | Always | The strict fields listed below. Use the broad pinned provider extract needed to cover the region; exact coverage is still the boundary polygon. |
| `elevation-source.json` | Always | The strict fields listed below, with a region-unique `cacheNamespace`, reviewed query bbox, and exact expected 3DEP product IDs. |
| `search-regions.json` | Always | Version 1 ordered list. Entry zero should normally be `pack:<pack-id>`. Add only stable named areas actually present in the pinned OSM named-area export and useful for eligible loop starts. |
| `scenarios.json` | Always | Version 1, correct `packId`, and at least one representative scenario per major included trail cluster. Each has an exact expectation and a deliberately impossible, close-match-only expectation. |
| `access-restrictions.json` | When review finds a restriction | Exact OSM-way removals only. The current parser requires at least one restriction, so omit this input when review finds none; never invent a placeholder restriction. If present, pin the committed file's SHA-256 in the region definition's `restrictions.contentHash`. |
| `official-sources/README.md` and source config or reviewed overlay | Optional | Use only for provenance or cosmetic names/confidence on existing portals. State whether it is refreshable, committed, blocked documentation, or excluded. It must not create a start, connector, or permission. |

### Required source fields and hashes

`osm-source.json` is strict and contains exactly:

- `schemaVersion: 1`, `id`, `authority`, `dataset`, `version`;
- ISO `upstreamTimestamp`, source `url`, positive `expectedByteLength`;
- non-empty `license` and `attribution`.

The config does not contain the PBF SHA-256. The refresh writes the actual hash,
byte length, resolved URL, retrieval time, and optional ETag/Last-Modified to an
ignored `receipt.json`, then writes `.cache/sources/<source-id>/pinned.json`.
Record that SHA-256 and retrieval time in the charter and evidence ledger. A
later refresh of the same configured version requires the cached hash to match;
an empty first cache is protected only by `expectedByteLength` until its receipt
exists.

`elevation-source.json` is strict and contains:

- `schemaVersion: 1`, `id: "usgs-3dep-13-arc-second"`, and a region-unique
  lowercase-hyphenated `cacheNamespace`;
- `authority: "U.S. Geological Survey"`, `dataset`, `catalogId`, `version`, and
  National Map `endpoint`;
- query `bbox`, `productExtent`, and a non-empty exact
  `expectedProductIds` list;
- `resolution: "1/3 arc-second (nominal 10 m)"`,
  `horizontalDatum: "NAD83"`, `verticalDatum: "NAVD88"`, and `license`.

The refresh stores each product's URL, retrieval time, byte length, SHA-256,
ETag/Last-Modified, and the selected product metadata in the ignored collection
and receipts. Record every product ID and hash in the charter/ledger. The
collection JSON itself becomes the elevation source snapshot and its SHA-256 is
written to the pack manifest.

`access-restrictions.json`, when used, is strict:

- `schemaVersion: 1`;
- `source`: `id`, `authority`, `dataset`, `version`, ISO `retrievedAt`, `url`,
  and `license`;
- `restrictions`: unique canonical `way/<positive-integer>` targets with only
  `private`, `closed`, or `prohibited`; each includes a non-empty `reason` and
  `review.reviewedAt`/`review.reviewer`.

The exact committed bytes are hashed with SHA-256 and that expected hash is
hard-coded beside the region builder. A missing target, duplicate target, or
conflict with another restrictive state fails the build. Apply restrictions
before portal derivation. Compute the digest after the final reviewed edit with
`shasum -a 256 data/regions/<pack-id>/access-restrictions.json` and store it in
code with the `sha256:` prefix.

`search-regions.json` is strict: `{ "version": 1, "regions": [...] }`, with
ordered entries containing only `namedAreaId` and exact `expectedName`. The
compiler rejects duplicates, missing IDs, name drift, unsupported area kinds,
closed-area variants, empty lists, and non-contiguous output order. A search
region filters eligible starts; it never clips a route.

`scenarios.json` is QA input, not a pack source. Each scenario needs a stable
`id`, cluster, reference name/coordinates (and optional `synthetic` flag),
`searchRegionId`, optional candidate named-area ID, an ordered distance range,
an ordered elevation-gain range, and the expected exact or close-match-only
outcome. Scenarios do not participate in the pack data-version hash.

For a refreshable optional official point source, follow
`lib/data/authorities/source.ts`: its config requires identity/version,
`retrievedAt`, `downloadUrl`, license, terms decision, redistribution decision,
and `metadataContentHash`; pin `inspectedSnapshotContentHash` whenever exact
response bytes have been reviewed. The adapter must reject empty responses,
schema/domain drift, transfer-limit responses, duplicate stable IDs, and
unexpected scope. If this source is wired into a builder, it is operationally
required for that builder's refresh/offline read even though its product effect
is cosmetic. Omit the integration entirely when the region does not need it.

For a committed human-reviewed overlay, define and test a strict schema,
source-page URL/upstream/retrieval dates, page byte length and SHA-256, license
and redistribution decision, reviewed facts, stable record IDs, coordinates,
conditions, and source-page references. Pin the overlay file's own SHA-256 in
code. Files documenting blocked or empty cross-checks must not enter the build's
source set.

## 3. Configure the schema-6 builder

Create these implementation and verification files:

| File | Required outcome |
| --- | --- |
| `lib/data/<pack-id>-pack.ts` | Export a `RegionalPackDefinition` and `createRegionalPackBuilder(config)` from `lib/data/regional-builder.ts`. Supply ID/name, data-version prefix, compiler version, boundary version, region root, and display center/zoom. Use the same builder for restrictions, entrance evidence, and official trail supplements. |
| `lib/data/<pack-id>-pack.test.ts` | Assert regional facts: exact boundary, source namespaces/versions, reviewed search regions, restrictions, entrance-source validation, and regional acceptance checks. Generic preparation, fingerprints, progress, and publication are tested once in `regional-builder.test.ts`; do not duplicate those suites per region. |
| `lib/data/regional-pack.ts` | Import and register the builder. This is necessary before `pack:bootstrap` recognizes the catalog ID. |
| `lib/data/regional-pack.test.ts` | Add the ID to stable sorted builder expectations and remove its planned-without-builder expectation. |
| `scripts/research/regional-pack-checkpoint.ts` | Shared schema-6 real-pack checkpoint using the region's `scenarios.json`; run exact and impossible expectations and emit per-scenario timing, selected start, portal distance, counts, violations, diagnostics, and validation rejections. The runner rejects a reference anchor whose nearest eligible portal is more than 500 m away. |

Every region uses one fixed build process. It reads and validates the regional
inputs, resolves pinned sources, prepares OSM topology, adds any reviewed trail
supplement, applies restrictions, derives trailheads, applies entrance names,
strips build context, prepares buildings/elevation/named areas, then compiles,
audits, and publishes. Regions cannot reorder these operations.

A minimal definition looks like this (use the actual approved catalog ID and
reviewed values):

```ts
export const REGION_CONFIG: RegionalPackDefinition = {
  id: "example-region",
  name: "Example Region",
  dataVersionPrefix: "example",
  compilerVersion: "regional-pack-compiler-v1",
  boundaryVersion: "example-boundary-v1",
  regionRoot: path.resolve("data/regions/example-region"),
  display: { center: [-122, 37], zoom: 10 },
};
export const buildExampleRegion = createRegionalPackBuilder(REGION_CONFIG);
```

Only add capabilities supported by real regional evidence:

- `restrictions: { contentHash }` reads the fixed `access-restrictions.json`
  path and verifies its exact bytes before applying any changes.
- `entrances(options)` validates and normalizes an entrance source, returning
  `{ snapshot, adapterVersion, evidence }`. It owns source-specific acquisition
  and respects `options.refresh`; it cannot modify the graph or publication.
  See East Bay for a refreshable source and Monterey for a committed review.
  Once configured, source failure aborts the build rather than silently omitting
  that evidence. Entrance loaders run after prerequisite checks and before the
  large common source downloads, so invalid local evidence fails early.
- `officialTrails: { sourceConfigPath, conflationPolicyPath }` uses the shared
  connected-gap conflation process. See Central Cascades.
- `checkPortals(topology, boundary)` can reject an otherwise valid preparation
  and return regional measurements to retain in the audit. See East Bay's
  required corridor coverage. It must inspect the supplied topology without
  changing it; preparation and publication stay in the shared builder.

All builders return `{ pack, portalAudit, regionalAudit }` and write
`portal-audit.json` (report schema `"2"`) plus `regional-audit.json`. Optional
trail supplements also produce `official-trail-conflation-audit.json`. The
portal report includes common counts, build-context removal, and any configured
restriction, entrance, or regional-check evidence. Entrance reports distinguish
actual matches from changed labels; evidence already represented still counts
as a match. Historical artifacts may retain their earlier report names/shapes.
No runtime consumer depends on those build reports.

The shared seed supplies graph schema `"6"`, topology settings and capabilities.
`officialAccess` is true when an entrance source is configured; restrictions
alone do not imply this capability. Existing compiler versions and the older
Santa Cruz `fingerprintFormat: "joined-v1"` remain to preserve installed build
identities. New definitions use the default tagged fingerprint format and must
include a boundary version. Pure orchestration refactors that preserve frozen
build inputs need not invalidate existing packs.

Increment the region compiler version when orchestration or deterministic
inputs change. The data-version hash must cover:

- exact boundary bytes and exact search-region bytes;
- region compiler version;
- sorted topology, named-area, portal, and optional official adapter versions;
- sorted elevation and building metric/algorithm versions; and
- every source snapshot's ID, version, content SHA-256, and license/terms
  string.

The manifest also records each deduplicated source's authority, dataset,
version, retrieval time, URL, license/terms, and content hash. `builtAt` is the
newest source retrieval time. Because retrieval time affects the manifest even
though it is not part of the data-version digest, determinism comparison must
use the same pinned cache pointers.

Do not change solver logic, route/API contracts, UI labels, database tables, or
portal/building thresholds for a region. Those are shared contracts owned by
the integrator.

Run focused offline tests while implementing:

```sh
npm test -- lib/data/<pack-id>-pack.test.ts lib/data/regional-pack.test.ts \
  lib/data/regional-builder.test.ts lib/data/portals.test.ts lib/data/osm/buildings.test.ts \
  lib/data/wilderness.test.ts lib/data/audit/sqlite-pack-audit.test.ts
```

## 4. Understand the current trailhead pipeline

This sequence is owned by the shared builder. A configured official-trail
supplement is conflated after OSM normalization and before restrictions:

1. `osmium extract` uses the exact Polygon with `complete_ways`. The topology
   filter includes trail classes, road context, parking, trailhead/information/
   gate evidence, and hiking/foot relations.
2. Normalization classifies each way as `trail`, `street`, `service-road`, or
   `sidewalk`. Roads and sidewalks are build context and never traversable.
3. Reviewed exact-way restrictions, if any, are applied before starts are
   derived.
4. A portal candidate is a trail contact with a non-restrictive street; a
   service-road contact needs nearby evidence. Parking may nominate a nearby
   trail node only when the parking touches a non-restrictive road. Candidates
   cluster within 150 m. Evidence/name matching uses 250 m; parking-to-road
   contact uses 25 m. Portal access state comes from incident trails, not the
   road, parking, or official entrance.
5. Optional official entrances may rename or raise confidence on the nearest
   existing portal within 250 m. They cannot add/reopen/remove a portal or add
   an edge.
6. `stripPortalBuildContext` removes all streets, service roads, sidewalks, and
   POI evidence. Only trail ways, required nodes, and derived trailhead rows are
   published.
7. `prepareOsmBuildings` reuses the same pinned regional OSM extract, filters
   `wa/building`, converts geometries to centroids rounded to five decimals,
   stores only `buildings.json`, and deletes the large filtered/export
   intermediates. Zero buildings is fatal.
8. Compilation counts buildings within 500 m of each portal's snapped node and
   persists `nearby_building_count`. A start is considered wild only when the
   count is below 50.
9. Closed-route topology persists `can_reach_cycle` for both known and
   inclusive access profiles. Runtime uses the inclusive value as the superset:
   `false` means the start is hidden and never automatically searched.
10. Runtime eligibility then applies exact filter geometry. Reviewed named
    regions admit trail portals in a 500 m approach band because usable
    trailheads commonly sit just outside legal park, preserve, and wilderness
    boundaries; drawn areas and drive-time contours remain exact. Access policy,
    building threshold, and cycle reachability still apply. Unknown access
    remains included by default. Straight-line proximity does not prove that a
    portal's trail enters the named area, so every published search region still
    requires portal review until a topology-aware association is available.

Building and no-cycle rules do **not** delete rows from `access_points` during
compilation. Therefore the pack's raw `accessPointCount` is not the visible or
searchable trailhead count. Record total portals, built-up portals, no-cycle
portals, and default-eligible portals separately.

## 5. Refresh once, then stay offline

Prerequisites are Node 22+, `osmium-tool`, and `uv`. The build validates both
tools before downloading and runs Rasterio through the locked uv project in
offline/frozen mode. A quick preflight is:

```sh
osmium --version
uv --version
uv run --offline --frozen --project tools/dem \
  python tools/dem/sample_dem.py --version
```

Run exactly one network-enabled refresh after all committed source metadata and
expected IDs are reviewed. Keep the refresh build isolated: source refresh is
the purpose of this pass, and it must not prune an installed pack version:

```sh
npm run pack:bootstrap -- \
  --pack=<pack-id> \
  --cache=.cache/sources \
  --build-cache=.cache/build/<pack-id>/refresh/sources \
  --output=.cache/build/<pack-id>/refresh/packs
```

This command refreshes every source wired into the builder and also performs a
complete build. Save its JSON output and wall time in the evidence ledger.
Inspect every new receipt/pointer and copy its hash, byte length, and retrieval
time into the ledger and charter. If the returned source or schema differs from
the reviewed expectation, update/re-review the committed metadata and repeat
the refresh deliberately; do not allow a build to discover a new source
silently.

After this point, every build and automated test is offline. Do not refresh once
per determinism build.

## 6. Build twice independently offline

A second invocation with the same output root may return
`reusedExisting: true`; that is not an independent determinism build. Use
separate empty preparation/output roots so both OSM preparation and pack
publication execute twice from the same pinned source cache. Build A becomes
the installed but still catalog-unlinked candidate; verify its data-version
directory does not already exist before starting:

```sh
npm run pack:bootstrap -- \
  --pack=<pack-id> --offline \
  --cache=.cache/sources \
  --build-cache=.cache/build/<pack-id>/determinism-a/sources \
  --output=.local-data/packs

npm run pack:bootstrap -- \
  --pack=<pack-id> --offline \
  --cache=.cache/sources \
  --build-cache=.cache/build/<pack-id>/determinism-b/sources \
  --output=.cache/build/<pack-id>/determinism-b/packs
```

Both results must say `reusedExisting: false` and report the same schema-6 data
version. Hash all published files from both output roots. At minimum compare
`manifest.json`, `pack.sqlite`, `audit.json`, `regional-audit.json`, and the
region's portal audit (`portal-audit.json`, `portal-access-audit.json`, or
`portal-derivation-audit.json`):

```sh
( cd .local-data/packs/<pack-id>/<data-version> && \
  shasum -a 256 audit.json manifest.json pack.sqlite regional-audit.json <portal-audit-file> )
( cd .cache/build/<pack-id>/determinism-b/packs/<pack-id>/<data-version> && \
  shasum -a 256 audit.json manifest.json pack.sqlite regional-audit.json <portal-audit-file> )
```

Record both sets. Every corresponding hash must match.

The generated/ignored lifecycle is:

| Location | Contents | Git treatment |
| --- | --- | --- |
| `.cache/sources/<source>/<hash>/` | Immutable downloads and receipts; per-source `pinned.json`; 3DEP collections/products; optional official snapshots. | Ignored; never edit in place or commit. |
| `.cache/build/<pack-id>/<run>/sources/` | Complete-ways regional PBF, filtered PBF/OPL, normalized topology, named areas, and retained building centroids. Temporary building PBF/export files are deleted by the pipeline. | Ignored; use distinct run roots for determinism. |
| `.cache/build/<pack-id>/<run>/packs/` | Refresh and offline-B isolated pack outputs. | Ignored. |
| `.local-data/packs/<pack-id>/<data-version>/` | Runtime `pack.sqlite`, `manifest.json`, `audit.json`, `regional-audit.json`, and portal audit. | Ignored. Successful publication updates `current.json` and prunes older validated versions for that pack. |

Publication pruning can make unfinished jobs pinned to an older pack version
stale. Time the final installed publication/activation so this is understood
and tested.

## 7. Inspect schema-6 acceptance evidence

The build already fails on manifest/schema errors, missing curated targets,
source hash/license failures, missing buildings, incomplete trail elevation
profiles, portal-field errors, build-only published context, malformed search
regions/topology, audit errors, and SQLite integrity failure. Do not treat a
successful command as the whole approval.

Require and record:

- schema `6`, correct pack/data/compiler versions and source inventory;
- zero regional-audit `errors`, conflicts, implausible metrics, isolated nodes,
  unattributed records, unknown source references, and outside-coverage edges;
- zero missing **trail** elevation nodes/edges and complete direction-aware
  elevation profiles (missing elevation is currently an audit warning, so zero
  must be checked explicitly);
- exactly `known` and `inclusive` topology profiles, matching topology hashes,
  and a reviewed distribution of feasible/no-cycle portals;
- no non-trail edge in the published database;
- non-zero, plausible building inventory and reviewed nearby-building
  distribution, especially at face-valid and obvious urban-edge starts;
- reviewed portal counts by access state/confidence/road class, parking
  evidence, official-name match/unmatched counts when applicable, and major
  geographic cluster; and
- `PRAGMA integrity_check = ok` and an empty `PRAGMA foreign_key_check` result.

These read-only queries capture the new start rules without relying on the raw
portal count:

```sh
sqlite3 .local-data/packs/<pack-id>/<data-version>/pack.sqlite \
  "SELECT count(*) AS total_portals,
          sum(nearby_building_count >= 50) AS built_up,
          sum(at.can_reach_cycle = 0) AS no_cycle,
          sum(nearby_building_count < 50 AND at.can_reach_cycle = 1
              AND ap.access_state IN ('public','unknown')) AS default_eligible
   FROM access_points ap
   JOIN access_topology at ON at.access_point_id = ap.id
   WHERE at.profile = 'inclusive';"

sqlite3 .local-data/packs/<pack-id>/<data-version>/pack.sqlite \
  "SELECT access_state, confidence, portal_road_class, count(*)
   FROM access_points
   GROUP BY access_state, confidence, portal_road_class
   ORDER BY access_state, confidence, portal_road_class;"

sqlite3 .local-data/packs/<pack-id>/<data-version>/pack.sqlite \
  "SELECT count(*) AS published_context_edges
   FROM edges WHERE edge_class <> 'trail';
   PRAGMA integrity_check;
   PRAGMA foreign_key_check;"
```

Disconnected components and rejected boundary-crossing edges may be legitimate,
but their counts and largest-component fraction need human review. Likewise,
`builtUpAccessPointCount` is an observation, not an error: inspect the map and
named face-valid examples before accepting it. Do not tune the shared 50/500 m
rule to make a region's counts look better.

## 8. Run representative route QA

Run the new region checkpoint against the installed schema-6 candidate using
Thorough effort, and save its JSON under the ignored build evidence directory:

```sh
npm run --silent pack:checkpoint -- \
  --pack=<pack-id> \
  --database=.local-data/packs/<pack-id>/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/<pack-id>/<data-version>/manifest.json \
  --scenarios=data/regions/<pack-id>/scenarios.json \
  --effort=thorough
```

Every major cluster must choose a sensible nearby **eligible** portal within
500 m of its reviewed reference point, return
at least one exact route for the plausible request, return no exact route and at
least one explicitly violated close match for the impossible request, and have
zero directed-validation rejections. Record wall time, eligible-start count,
selected portal/distance, exact/close counts, and rejection diagnostics per
scenario. Then manually spot-check Quick and Batch behavior across major
clusters; Batch completeness means each eligible start was attempted, not that
every possible closed walk was enumerated.

## 9. Activate only after approval

In one focused activation change:

1. Add `"packId": "<pack-id>"` to the existing catalog entry in
   `data/regions/registry.json` without changing its ID/order.
2. Update catalog expectations that enumerate linked/planned states, currently
   `lib/contracts/regions.test.ts`, `app/api/packs/route.test.ts`, and
   `lib/packs/pack-catalog.test.ts`.
3. Confirm the builder remains registered in `lib/data/regional-pack.ts` and
   covered by `lib/data/regional-pack.test.ts`.
4. Update [status.md](status.md) with the exact boundary decision, schema/data
   version, source/license inventory, counts, zero/error evidence, both offline
   hash sets, portal/building/cycle evidence, checkpoint totals, app/browser
   results, and any deferred search regions.

Run the complete gate using the stricter execution runbook requirement:

```sh
npm run verify
npm run verify
npm run test:browser
npm run test:browser
```

Then use the live local app with the installed pack to verify selection and URL
state, map recentering/coverage, all reviewed-region choices, access previews,
Quick search, Batch search and Jobs, cross-pack saved-Job restoration,
stale-version labeling, keyboard use, narrow-screen pill scrolling, and zero
browser console errors. Automated browser tests use committed fixtures and do
not replace this real-pack inspection.

Finally, ensure generated artifacts remain ignored and only intended source,
implementation, test, checkpoint, registry, and status files appear in
`git status --short`.

## 10. Steps that are obsolete or unnecessary

Do not perform any of these during schema-6 onboarding:

- create `population-source.json`, download GHSL/GHS-POP tiles, run
  `sample_population.py`, install a population Rasterio path, classify starts
  as remote/rural/populated, or add a user remoteness setting;
- ingest `amenity=parking` rows or official entrances as route starts, use the
  old 200 m access-point snap/dedup pipeline, or add connector edges for them;
- refresh or spatially match authority trail-line layers, restore ArcGIS line
  adapters, produce access-join reports, or promote `unknown` ways to public;
- scrape a live alerts page during the pack build; record reviewed restrictive
  facts in the committed exact-way file instead;
- require an optional entrance-name source simply to onboard a region;
- change route algorithms, API/request contracts, database schema, UI copy, or
  shared portal/building constants for regional behavior;
- clip generated hikes to drawn, drive-time, or named-region filter geometry;
- run network refresh for each build, count a reused existing output as the
  second build, commit caches/generated packs/audits, or activate merely because
  a local pack directory exists; or
- accept schema-5-only evidence for a new region. Existing checkpoints still
  accept schema 5 for compatibility; the new checkpoint should require 6.

## Evidence ledger and process-friction log

Fill this in during the work rather than reconstructing it at the end. `Active
min` is hands-on review/editing time; `wait min` is downloads/build/tests. Count
every failed run and manual data correction so later onboarding can target the
largest costs.

### Run identity

| Field | Value |
| --- | --- |
| Pack ID / display name |  |
| Gate / owner |  |
| Working commit at start |  |
| Started / completed (ISO) |  |
| Source review cutoff |  |
| Final schema / data version |  |

### Phase timing and friction

| Phase | Started | Ended | Active min | Wait min | Command runs | Failures/retries | Manual edits or decisions | Evidence/artifact |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Charter and boundary |  |  |  |  |  |  |  |  |
| OSM source review |  |  |  |  |  |  |  |  |
| 3DEP source review |  |  |  |  |  |  |  |  |
| Restrictions/license review |  |  |  |  |  |  |  |  |
| Search regions/scenarios |  |  |  |  |  |  |  |  |
| Builder and focused tests |  |  |  |  |  |  |  |  |
| Network refresh (once) |  |  |  |  | 1 |  |  |  |
| Offline build A |  |  |  |  | 1 |  |  |  |
| Offline build B |  |  |  |  | 1 |  |  |  |
| Portal/building/cycle review |  |  |  |  |  |  |  |  |
| Thorough checkpoint |  |  |  |  |  |  |  |  |
| Activation and full suites |  |  |  |  |  |  |  |  |
| Live desktop/mobile QA |  |  |  |  |  |  |  |  |

### Source and hash ledger

| Source/input | Version/upstream date | Retrieved at | Bytes | SHA-256 | License/redistribution decision | Cache/config path |
| --- | --- | --- | ---: | --- | --- | --- |
| OSM PBF |  |  |  |  |  |  |
| 3DEP product 1 |  |  |  |  |  |  |
| 3DEP product 2 (if any) |  |  |  |  |  |  |
| Curated restrictions (if any) |  |  |  |  |  |  |
| Optional entrance overlay (if any) |  |  |  |  |  |  |
| Boundary bytes |  | n/a |  |  | committed |  |
| Search-region bytes |  | n/a |  |  | committed |  |

### Determinism and acceptance ledger

| Evidence | Offline A | Offline B | Accepted value / notes |
| --- | --- | --- | --- |
| `reusedExisting` |  |  | Must both be `false` |
| Data version |  |  | Must match |
| `manifest.json` SHA-256 |  |  | Must match |
| `pack.sqlite` SHA-256 |  |  | Must match |
| `audit.json` SHA-256 |  |  | Must match |
| `regional-audit.json` SHA-256 |  |  | Must match |
| Portal-audit SHA-256 |  |  | Must match |
| Nodes / directed edges |  |  |  |
| Raw portals / built-up / no-cycle / default-eligible |  |  | Review, not merely non-zero |
| Portal access/confidence/road-class distribution |  |  |  |
| Named areas / reviewed search regions |  |  | Exact reviewed order |
| Rejected coverage edges / conflicts |  |  | Conflicts zero; boundary rejects explained |
| Missing trail elevation nodes/edges/profiles |  |  | All zero |
| Unattributed / unknown-source / outside-coverage records |  |  | All zero |
| Published non-trail edges |  |  | Zero |
| Integrity / foreign keys |  |  | `ok` / zero rows |
| Checkpoint scenarios / exact routes / close matches |  |  | All scenarios pass; zero validation rejections |
| `npm run verify` pass 1 / 2 |  |  |  |
| `npm run test:browser` pass 1 / 2 |  |  |  |
| Live desktop/mobile/console |  |  |  |

### Friction backlog

| Observation | Minutes or retries cost | Root cause | Automate, document, or accept | Proposed owner/follow-up |
| --- | ---: | --- | --- | --- |
|  |  |  |  |  |

## Known process gaps to measure before the next region

- The generic `pack:checkpoint` runner removes per-region script duplication,
  but the older Gate 8 and Gate 9 scripts have not yet migrated to it.
- There is no package command that creates two isolated offline builds, hashes
  every output, compares them, and emits the evidence ledger automatically.
- First-time OSM refresh pins expected length in Git but not expected SHA-256;
  the authoritative hash lives in an ignored receipt/pointer and must be copied
  into review evidence manually.
- Missing elevation is a regional-audit warning rather than a fatal error, and
  the regional audit does not run `PRAGMA foreign_key_check`; the onboarding
  gate therefore needs explicit checks above.
- The curated-restriction schema requires at least one entry and has no
  committed “reviewed, none found” representation.
- Older Southern East Bay and Monterey charter/status evidence still mentions
  GHS-POP, population fields, 200 m parking snapping, schema 5, and access-join
  reports. Those passages are historical and are unsafe templates for a new
  pack until separately refreshed.
