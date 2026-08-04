# Yosemite–Stanislaus Gate C review

Review date: 2026-08-03 (the production artifacts were generated on
2026-08-04 UTC)

Recommendation: **PASS WITH DOCUMENTED EXCEPTIONS**

The full regional corpus is suitable as the immutable input to T8 regional
expansion and T9 search-layer implementation. The review found no geometry,
topology, elevation-calculation, merge, or serialization defect that justifies
changing the T7.2 payloads. The remaining exceptions are explicit product and
source-quality constraints: climbing approaches need separate treatment, raw
per-edge grades in cliff terrain are not product-safe, and one 26-meter
unreviewed OSM/TIGER road fragment must not be exposed as a user-facing trail.

## Final corpus

| Metric | Result |
| --- | ---: |
| Segments | 107,297 |
| Nodes | 82,869 |
| Access points | 230 |
| Searchable named-trail components | 282 |
| Named / unnamed segments | 42,563 / 64,734 |
| Hiking allowed / unknown / blocked | 84,065 / 23,232 / 0 |
| Access public / unknown / private | 33,609 / 73,688 / 0 |
| Connected components / isolated segments | 1,458 / 1,272 |

The named-trail count is a count of connected catalog components, not unique
display names. A source corridor can therefore appear more than once when its
source topology is disconnected. Every catalog component has a connected
access point; isolated source geometry is not automatically searchable.

## Sources and provenance

| Source | Cached source records | Normalized input | Output carrying source |
| --- | ---: | ---: | ---: |
| USGS trails | 1,492 | 1,439 segments | 39,186 segments; 137 named components; 49 access points |
| USFS trails | 292 | 271 segments | 313 segments; 2 named components; 1 access point |
| NPS trails | 1,049 | 1,027 segments | 38,410 segments; 105 named components; 50 access points |
| OSM | 1,422 hiking ways, 80,341 hiking nodes, 35 route relations | 80,362 segments, 80,341 nodes, 57 access candidates | 80,362 segments; 229 named components; all 230 access points carry OSM evidence |
| USGS 3DEP | 30 one-arc-second tiles; 5,844,426 cells; 994 no-data cells | Tiled float32 cache | Elevation metrics on all 107,297 segments |

Output source counts overlap after reconciliation and merge. All 107,297
segments have field-level provenance; no shipped segment ID is missing from
the compact provenance shards. Snapshot paths, retrieval timestamps, source
URLs, bounds, byte sizes, and SHA-256 hashes are recorded in `manifest.json`
and `qa.json`. The OSM preparation used three bounded streaming passes and did
not retain a statewide road working set.

## Merge, reconciliation, and snapping

- 1,070 agency lines were reconciled into 77,619 OSM-aligned edges.
- 22,645 field conflicts were retained in provenance and resolved by the
  documented source precedence; none is unexplained.
- 276 agency/OSM matches had duplicate nearby intervals. The deterministic
  conservative resolution retained the unsplit official line instead of
  choosing an arbitrary OSM interval.
- Two ambiguous access connections were omitted instead of choosing a node,
  and two disconnected access candidates were omitted. No searchable trail
  depends on those candidates.
- Regional filtering omitted 103 source segments and one post-merge
  zero-length segment under the fully-contained rule. Endpoint topology and
  geometry coordinates validate for every output segment.

These are reviewed conservative outcomes, not unresolved topology errors.

## Elevation review

Coverage is complete for all output and searchable segments. The QA checked
102,458 sub-50-meter edges individually and evaluated 1,694,227 shortest-path
windows from 50 to 200 meters. Of 102,458 short edges, 102,109 participate in
an aggregate window; the remaining 349 are terminal or otherwise lack enough
connected path length for a compensating window.

The machine QA intentionally remains `manual-review-required`: 321 edges
(0.30% of the corpus) have implausible per-edge metrics, including 125 segment
memberships across 32 searchable components with 27 unique names. There are
also 186 aggregate-window records. Those 186 records collapse to only 13
connected geographic clusters, which is more informative than treating them
as 186 independent defects.

### Classification

| Classification | Evidence | Decision and product impact |
| --- | --- | --- |
| One-arc-second DEM cells crossing cliffs near switchbacks | 310 of 321 flagged edges are under 50 m and 184 are under 10 m; 263 are in Yosemite Valley. The same spatial spikes recur on source-backed NPS/USGS/OSM geometry. Upper Yosemite Fall Trail has 34 searchable memberships, Snow Creek 13, Pohono 12, John Muir 10, Four Mile 9, and Mist Trail 1. Except for the Pohono and Lower Yosemite Fall clusters, these spikes do not persist in 50–200 m windows. | This is expected raster/geometry interaction, not credible 200–400% trail grade. Retain the elevations and QA flags, but do not expose or route-filter on raw flagged edge `maxGradePct` values. A higher-resolution or terrain-aware elevation pass is later quality work, not a Gate C rebuild. |
| Climbing approaches and scrambles | 58 per-edge records have approach/scramble/climber/descent names, 38 carry OSM `path=climbing_access`, and 112 carry an OSM `sac_scale`. The largest aggregate cluster is 69 records on The Gunsight (`alpine_hiking` / `demanding_alpine_hiking`); named Rostrum, Reed's Pinnacle, Main Wall, and Northwest Buttress approaches form additional clusters. | These are source-backed steep routes, but they are not ordinary hiking-search results. T9 must exclude them from the default hiking catalog or place them in an explicit advanced/climbing class before product launch. Their geometry remains useful in the graph. |
| Credible steep terrain | Red Peak Pass, Half Dome/Cables-area paths, and several mountain/alpine-hiking records show locally steep but spatially coherent terrain. Their source tags and elevation ranges support steepness even where the exact peak edge grade is raster-limited. | Preserve the route and its elevation range. Treat the precise flagged maximum grade as uncertain rather than flattening the terrain or raising the QA threshold. |
| Geometry/DEM misalignment | The 19-record Pohono cluster near the valley rim includes corroborating NPS, USGS, and OSM lines but crosses adjacent high-relief cells. Several extreme values repeat on parallel official and OSM representations at the same coordinates. | Source agreement argues against invented geometry or an arithmetic error; the exception is localized horizontal alignment versus a roughly 30 m terrain cell. Keep it reviewable in QA. |
| Topology or calculation defect | No outlier pattern follows IDs, shard boundaries, tile boundaries, source provider, or traversal direction. All segment endpoints validate; reverse/flat/no-data elevation tests pass; persistent aggregate records are geographically clustered. | None demonstrated. No elevation or topology code change and no regional rebuild are warranted. |

The affected flagship named components have plausible corridor-scale vertical
travel relative to their lengths and elevation ranges; the problem is the
precision of a small number of edge maxima, not missing elevation coverage.
The QA thresholds were not increased.

## Isolated searchable named trails

| Trail | Evidence | Decision |
| --- | --- | --- |
| Chilnualna Falls Trail | A 237 m NPS/USGS Class 3, open hiker/pack segment begins at the mapped Chilnualna Falls Horse Trailhead. The regional south boundary truncates the larger corridor. | Keep routable and searchable as a legitimate accessible regional component, but label its length as the in-region component rather than the full Chilnualna Falls route. |
| Deer Camp Road | One 7.63 km NPS/USGS existing hiker line connects to the mapped Deer Camp Trailhead; its 13% peak grade and elevation range are credible. | Keep routable and searchable. The single agency line is a legitimate standalone accessible component, not evidence of a broken calculation. |
| Old Big Oak Flat Road (Gentry Rd) | One 3.09 km NPS/USGS corridor connects to mapped Tamarack Flat Trailhead. NPS identifies it as a seasonal winter ski/snowshoe trail that can also be used as a summer trail; the canonical hiking value remains unknown. | Keep routable and searchable only with unknown-hiking and seasonal context. T9 must not present it as an unqualified open hiking route. |
| Old Yosemite Coulterville Road | OSM ways 239139149 and 239139150 are unreviewed TIGER-derived footways separated into 61 m and 26 m components. The 26 m component has only a derived endpoint access point from the same source. | Preserve both graph fragments, but suppress catalog component `named-trail_8fb704040434b8047e3edd34` from user-facing search until OSM topology/access is independently confirmed. Do not loosen access rules to retain it. |
| Robinson Creek Trail | One 9.40 km open NPS/USGS hiker/pack line connects directly to the mapped Robinson Creek Trailhead; its 39% maximum grade and 628 m elevation range are credible for the corridor. | Keep routable and searchable as a legitimate standalone accessible component. |
| Tuolumne Grove Road | One 1.85 km NPS Class 4 developed asphalt hiker line connects to the mapped Tuolumne Grove Trailhead. | Keep routable and searchable as a legitimate standalone accessible component. |

The five retained isolated components have direct mapped trailhead evidence.
The Old Yosemite Coulterville Road exception is deliberately not repaired by
promoting or widening derived access.

## Access-point credibility

The corpus contains 53 mapped and 177 derived access points; no official
point layer was available in the prepared sources. Of the 282 searchable
components, 191 have at least one mapped trailhead/parking point and the other
91 have derived public-road/network evidence. None lacks access. There are 51
mapped trailheads and two mapped parking points. All access points connect to a
graph node, explicitly private candidates are excluded, and ambiguous or
disconnected candidates are omitted rather than guessed.

Mapped points are strong enough for drive-time filtering. Derived-only points
remain lower-confidence product evidence and should be displayed as such; they
must not be promoted to official.

## Determinism and verification

The two cached T7.2 production builds each contain 39 files and compare
byte-for-byte equal. Both cached manifests and the committed manifest have
SHA-256 `91d7c2c5987101d0c566bfb7280607355ee281b25ff829c380380bf432be40a1`.
The closure change does not alter geometry, topology, elevation, access,
searchable membership, provenance, or serialized payload generation, so the
accepted two-build comparison remains valid and no regional build was run.

Verification after the writer-hardening change:

- `node --test tests/trails-build-region.test.mjs` — 8 passed.
- `node --test tests/trails-*.test.mjs` — 59 passed.
- `npm run lint` — passed.
- `npm test` — production application build passed; 81 tests passed.

The new regression proves that `writeRegionArtifacts()` removes the legacy
managed `segments.ndjson` and an obsolete managed shard while retaining
unrelated root and shard-directory files.

## Artifact delivery

| Payload class | Raw | Gzip | Delivery decision |
| --- | ---: | ---: | --- |
| Eager named trails + access points | 1,492,830 B | 330,939 B | Acceptable initial metadata payload; cache by artifact version. |
| 16 geometry shards + index | 99,247,505 B | 17,377,329 B | Lazy only. Individual data shards are 1.01–1.15 MB gzip. |
| 16 provenance shards + index | 107,315,467 B | 24,194,680 B | Lazy/on-demand diagnostics. Individual data shards are 1.44–1.57 MB gzip. |
| Nodes | 19,416,951 B | 5,799,027 B | Graph/search worker or server load; never eager client metadata. |
| QA | 15,903,790 B | 508,078 B | Build/review artifact; do not serve to ordinary clients. |
| Total artifact content | 243,376,543 B | 48,210,053 B | Acceptable for the first static regional corpus with the stated loading split. |

The runtime request shape is acceptable: approximately 331 KB gzip is eager,
and detailed geometry/provenance is divided into independently cacheable
shards no larger than about 1.6 MB gzip. The 243 MB raw footprint is a
deployment and Git-repository concern, not an initial-client transfer. QA and
review artifacts should be excluded from the public asset set. Repository and
deployment growth must be remeasured during T8; external versioned artifact
storage may be evaluated then, but Gate C does not require R2 or a database.

## Remaining exceptions and gate decision

1. Raw maximum grades on the 321 flagged edges are not product-safe; retain
   the QA flags and use aggregate/corridor context.
2. Climbing approaches, scrambles, and alpine descents need an explicit T9
   exclusion or advanced-route class before default hiking search ships.
3. The 26 m Old Yosemite Coulterville Road component identified above must be
   suppressed from user-facing search pending source repair.
4. Old Big Oak Flat Road needs unknown-hiking and seasonal messaging.
5. The 349 uncompensated short edges remain reviewable terminal-edge
   exceptions; none lacks per-edge checking or elevation metrics.
6. Derived-only access remains lower confidence and must be labeled rather
   than promoted.

With those bounded exceptions, Gate C passes. T8 and T9 may begin; none of the
exceptions requires changing regional geometry or rebuilding the T7.2 corpus.
They are acceptance constraints for the search layer and the later product
gate, not permission to weaken access, elevation, or hiking rules.
