# Henry Coe pack charter

## Identity and purpose

- Pack ID: `henry-coe`
- Display name: Henry Coe
- Intended users: South Bay and Central Coast hikers generating closed day-hike
  routes from the principal public entrances of Henry W. Coe State Park and
  the neighboring South Diablo trail systems, from short front-country loops
  to long, steep backcountry loops.
- Planned coverage contract: `boundary.geojson` version
  `henry-coe-boundary-v1` will be the exact hard route-geometry boundary.
  Filter geometry will select eligible access points and will never clip route
  geometry. A padded source-download extent cannot enlarge runtime coverage.

This is a route-generator pack, not a catalog of established hikes. Unknown
access remains included by default and can be disabled explicitly. Exact
matches and clearly labeled close matches stay separate.

This charter records the onboarding decisions reviewed on 2026-08-08 and the
measured implementation evidence accepted on 2026-08-09. The catalog link is
added only after the build and route evidence recorded below passes.

## Included trail systems

The boundary preflight should begin with two public hiking systems in the
southern Diablo Range that share a managed-land boundary:

1. **Henry W. Coe State Park** — keep the park's loop-capable public hiking
   network whole, including the Coe Ranch, Hunting Hollow, Dowdy Ranch, and
   interior backcountry networks. Coe Ranch and Hunting Hollow are regular
   public entrances. Dowdy Ranch is a real but seasonal and condition-dependent
   entrance, not an always-available equivalent.
2. **Coyote Lake–Harvey Bear Ranch County Park** — include its Coyote Lake,
   Harvey Bear, and Mendoza Ranch sections. The County describes the 6,695-acre
   park as having more than 33 miles of trails, with trailheads in all three
   sections; its official guide map places Henry W. Coe directly beside the
   park.

These systems form the coherent v1 scope because the authority guide map and
the pinned OSM named-area geometries both show a shared boundary. The boundary
must follow their reviewed public geometry; it must not grow into neighboring
private ranches merely because the pack label refers to the South Diablo.

## Explicit exclusions

- Exclude Joseph D. Grant County Park, Ed R. Levin County Park, Sierra Vista
  Open Space Preserve, Mission Peak, Sunol, Ohlone Wilderness, Del Valle, and
  every other system already in or naturally assigned to a later South Diablo
  expansion or the Southern East Bay pack. Henry W. Coe is the northern limit
  of this v1 pack.
- Exclude Mount Diablo State Park and the northern/central Diablo Range.
- Exclude Anderson Lake County Park, Coyote Creek Parkway, and the urban Santa
  Clara Valley trail network. Roads leading to a park entrance are portal-build
  context, not hiking coverage.
- Exclude Cañada de los Osos Ecological Reserve. CDFW describes the reserve at
  Coe's southern edge and lists no facilities; its management plan identifies
  youth outdoor education as the primary public use. The pack must not infer a
  general hiking network from OSM lines there.
- Exclude Palassou Open Space and any other land marked no-public-access on the
  current Coyote Lake–Harvey Bear Ranch guide map.
- Exclude Pacheco State Park, San Luis Reservoir State Recreation Area,
  Hollister Hills State Vehicular Recreation Area, private ranches around
  Pacheco Pass and San Antonio Valley, Stanislaus National Forest, Pinnacles,
  and the broader Gabilan Range. Pacheco is a valid hiking system but is
  disconnected from the Coe–Coyote public network and is deferred from v1.

An extraction spike may show a trail touching one of these limits. That is a
review trigger, not permission to expand the pack. Extend coverage only when a
current authority source and a connectivity audit show that an included
loop-capable public hiking network would otherwise be cut.

## Managing authorities and access responsibilities

- **California Department of Parks and Recreation, Diablo Range District**
  manages Henry W. Coe State Park. The official park page identifies three
  visitor entrances and says Coe Ranch and Hunting Hollow are open year-round,
  while Dowdy Ranch is seasonal and can close for rain, heat, staffing, or road
  conditions. Current park notices and Diablo Range District superintendent
  orders must be reviewed before each release.
- **Santa Clara County Parks and Recreation Department** manages Coyote
  Lake–Harvey Bear Ranch. The County publishes the entrance locations and
  directs visitors to its closure page and trail hotline for current
  conditions. Parking, an entrance point, or a County GIS line is not by itself
  a permission record for an adjoining property.
- **California Department of Fish and Wildlife** manages Cañada de los Osos,
  and the **Santa Clara Valley Open Space Authority** manages adjacent open
  space including Palassou. Their land must remain excluded unless an
  affirmative, current public hiking connection is separately documented.
- Caltrans, County road departments, reservoir operators, utilities, and
  private landowners control practical approaches and adjacent lands. Road
  contact is evidence for portal derivation, never permission to route on the
  road or beyond the included public system.

Current closure or prohibition evidence outranks permission, which outranks a
clear OSM access tag; unresolved evidence remains unknown. Safety-critical
authority removals must be committed as restrictive exact OSM-way targets and
applied before portals are derived.

## Trailhead identification contract

This pack must use the shared schema-6 portal pipeline without regional tuning
or an authority-specific trailhead adapter:

- classify OSM ways and retain road context only for build-time portal
  derivation;
- derive candidates where a non-restrictive street touches a trail, or where a
  street-connected parking feature lies near a trail;
- use the shared 150 m portal clustering, 250 m evidence radius, and 25 m
  parking-to-road contact constants from `lib/data/portals.ts`;
- rank and persist portals using trail-only reachable distance, component ID,
  road class, and parking distance, then strip roads, sidewalks, and evidence-
  only objects from the published graph;
- remove starts that cannot reach a cycle and starts with 50 or more OSM
  building centroids within 500 m, using the shared wilderness rules; and
- allow an optional official entrance overlay to rename or increase confidence
  on a nearby derived portal only. It cannot create a start, change access,
  reopen a restricted trail, or add a connector.

This means that official point data is not an onboarding dependency. The first
build should run with OSM portal evidence alone; add an entrance-name overlay
only if the generic portal labels are materially poor and the source's license
decision is complete.

## Candidate reviewed search regions

The 2026-08-02 OSM inspection snapshot contains stable-looking named polygons
for both candidate systems. IDs are discovery aids and must be revalidated
against the final pinned snapshot. Publication still requires an in-coverage
derived portal that can reach cycle-bearing topology.

| Candidate | Snapshot OSM object | Snapshot object bbox `[west, south, east, north]` | Charter decision |
| --- | --- | --- | --- |
| Whole pack | pack coverage geometry | n/a | Required candidate; retain if the pack passes preflight |
| Henry W. Coe State Park | `relation/11341366` | `[-121.5629889, 37.0324441, -121.3058921, 37.3111329]` | Review for retention; expected primary selector |
| Coyote Lake–Harvey Bear Ranch County Park | `relation/16859470` | `[-121.5962810, 37.0533803, -121.5119265, 37.1596038]` | Review for retention |

Do not invent selectors for Coe Ranch, Hunting Hollow, Dowdy Ranch, or the
Orestimba backcountry merely because hikers recognize those names. They may be
scenario clusters, but they become selectors only if the pinned named-area
inventory provides appropriate polygons and the same portal/cycle checks pass.

## Representative entrances and scenario coverage

These authority-published entrances are review anchors, not independently
created access points. Every scenario coordinate must resolve to a derived OSM
portal before it is committed.

| Cluster | Review anchor | Authority location | Condition to preserve |
| --- | --- | --- | --- |
| Henry W. Coe / west | Coe Ranch Visitor Center | `37.1878465, -121.5458297` | Regular entrance; paid parking/self-registration conditions |
| Henry W. Coe / southwest | Hunting Hollow Entrance | `37.076211, -121.467091` | Regular unstaffed entrance; self-registration |
| Henry W. Coe / southeast | Dowdy Ranch Entrance | `37.112289, -121.356932` | Seasonal; verify same-day rain, heat, staffing, gate, and road conditions |
| Coyote Lake–Harvey Bear / north | Harvey Bear entrance | `37.096626, -121.577518` | Free parking |
| Coyote Lake–Harvey Bear / south | Mendoza Ranch entrance | `37.069972, -121.520235` | Free parking |
| Coyote Lake–Harvey Bear / east | Coyote Lake main entrance | `37.075092, -121.515376` | Reviewed but deferred as a route start: nearest eligible derived portal is 830 m away |

The committed `scenarios.json` covers Coe Ranch, Hunting Hollow, Dowdy, Harvey
Bear, and Mendoza Ranch. Each entrance cluster has a broad, plausible exact
request and a deliberately impossible request that remains an honestly labeled
close match. Coyote Lake main remains a reviewed anchor but is not a scenario:
the portal pipeline found no eligible derived start within the shared 500 m QA
limit, and onboarding must not invent or silently snap a trailhead. Dowdy's
availability is an access condition, not a reason to omit its topology or
pretend that it is always open.

## Neighboring-pack overlap

No overlap with Santa Cruz Mountains or Monterey–Carmel is expected. The Santa
Clara Valley and the excluded southern systems separate this pack from those
coverage areas.

Start with no overlap with Southern East Bay. During preflight, still run an
exact polygon intersection and trail-component comparison against
`southern-east-bay/boundary.geojson`. Do not include Joseph D. Grant, Ed Levin,
Sierra Vista, Mission Peak, or private San Antonio Valley land merely to bridge
the packs.

## Tentative boundary and download extent

The recommended first boundary draft is the dissolved union of reviewed
public-use geometry for Henry W. Coe and Coyote Lake–Harvey Bear where their
boundaries meet. A Polygon or MultiPolygon is acceptable as the source geometry
requires, but it must not bridge excluded private land or add disconnected
South Diablo parks.

The union bbox of the two OSM candidate areas in the inspection
snapshot is:

```text
[-121.5962810, 37.0324441, -121.3058921, 37.3111329]
```

That bbox is a review envelope, not a rectangular coverage proposal. The first
committed boundary must be checked against current California State Parks and
Santa Clara County park boundaries, every representative entrance, and all
boundary-crossing hiking segments.

Use this initially padded acquisition bbox for the `complete_ways` OSM
extraction spike:

```text
[-121.65, 36.98, -121.25, 37.36]
```

The roughly 0.05-degree padding supplies reference-complete road, parking,
building, named-area, and relation context around the exact lobes without
changing runtime coverage. It remains wholly within the `w122` one-degree
longitude band. The final elevation query uses the exact boundary bbox rather
than this padded extraction bbox, so only `n38w122` is required.

## Source and licensing decisions

### OSM topology, portal evidence, named areas, and buildings

Use a pinned [Geofabrik Northern California OSM
extract](https://download.geofabrik.de/north-america/us/california/norcal.html)
under ODbL 1.0. OSM is the sole topology baseline and supplies the shared
street/trail portal context, parking and trailhead evidence, named areas, and
building centroids. A derived database distributed outside local development
requires the appropriate ODbL attribution, offer, and license materials.

Charter inspection used the already-pinned `norcal-260801` snapshot, retrieved
`2026-08-06T20:35:30.702Z`, upstream `2026-08-02T01:02:04Z`, 648,017,783 bytes,
SHA-256
`215f18449e6cd190200a7dc1188a63dba2bec1f20fb3d1637c4f11c1f9134342`.
This is the final Henry Coe topology pin. The build reuses its immutable shared
receipt and records the URL, times, size, hash, adapter versions, and license
decision in the pack provenance.

### Elevation

Use [USGS 3DEP 1/3 arc-second
DEM](https://data.usgs.gov/datacatalog/data/USGS%3A3a81321b-c153-416f-98b7-cc8e5f0e17c3),
nominally 10 m, NAD83/NAVD88, a U.S. public-domain source. The exact final
extent is covered by one 2025-08-26 product already present in the shared
immutable cache:

- `n38w122`, product `68afba8fd4be02645f9b293f`, SHA-256
  `d6dd52bd01ef81d8af06a336d881ca73083e15139f22c2e84262e77aa138ffb4`.

Create the region-specific collection namespace `henry-coe-elevation`; sharing
the immutable raw product cache is allowed. Re-run the official National Map
product query after the exact boundary is committed and pin the selected
products, retrieval metadata, hashes, resolution, and vertical datum.

### California State Parks material

Use the [Henry W. Coe](https://parks.ca.gov/?page_id=561), [park-specific
orders](https://parks.ca.gov/?page_id=30207), and official park maps for human
review of entrances, public-use limits, and current restrictions. Any fact
converted to an exact-way removal needs a review date, source URL, content
hash, reason, and matching OSM way IDs in `access-restrictions.json`.

[California State Parks GIS](https://www.parks.ca.gov/?page_id=29682) publishes
park boundaries, routes, parking, and entry points, but its terms prohibit sale
or alteration, require attribution, limit the stated free-distribution purpose
to personal or public-sector use, and require advance approval for commercial
use. For this private local project, use the boundary and point layers only as
boundary/portal-name QA unless a later written license review approves a
redistributed normalized derivative. Do not ingest State Parks route lines as
topology or revive a line-matching authority adapter.

### Santa Clara County Parks material

Use the official [Coyote Lake–Harvey Bear
Ranch](https://parks.santaclaracounty.gov/locations/coyote-lake-harvey-bear-ranch-county-park),
[maps and GIS](https://parks.santaclaracounty.gov/maps-gis), and [closures and
alerts](https://parks.santaclaracounty.gov/closures-and-alerts) pages for human
review. The GIS hub offers downloadable boundaries, trails, and points but the
reviewed materials do not state an affirmative redistribution license. Do not
ship County geometry or add a live County adapter without a source-specific
license decision. If an entrance-name overlay is later justified, pin only the
minimum point response and keep it cosmetic. Convert current restrictive facts
to exact OSM-way removals; never scrape a live closure page during a build.

### Excluded authority data

The [CDFW Cañada de los Osos](https://wildlife.ca.gov/Lands/Places-to-Visit/Canada-de-los-Osos-ER)
page and land-management plan justify exclusion and a no-inferred-access
decision; they are not pack sources. Do not source topology from Pine Ridge
Association maps, Google, commercial trail apps, or user-contributed route
catalogs. Pine Ridge Association material may help a human spot-check names,
but California State Parks remains the authority and OSM remains the build
topology.

## Exact onboarding ledger used for this region

Henry Coe followed these items in order. Future operators should record
measured evidence rather than copying this region's assumptions:

1. **Boundary input** — commit `boundary.geojson` as a valid versioned Polygon
   or MultiPolygon; document the current official Coe and Coyote Lake–Harvey
   Bear boundary versions, include every retained representative portal, and
   prove excluded systems do not appear in the retained named-area inventory.
2. **Boundary preflight** — run `complete_ways` extraction with the padded bbox
   and measure source/build sizes, boundary-crossing segments, trail-only
   components, cycle ranks, portal candidates, clustered portals, portals that
   can reach a cycle, wilderness-building exclusions, and per-candidate region
   coverage. Review every major component touching the polygon edge.
3. **Source pins** — add `osm-source.json` and `elevation-source.json` with
   immutable receipts, URLs, retrieval/upstream times, lengths, hashes,
   licenses, redistribution decisions, and current adapter/portal versions.
   No population source is needed; buildings come from OSM.
4. **Restrictions** — review current Coe notices and superintendent orders plus
   County closures. Commit only restrictive exact OSM-way targets in
   `access-restrictions.json`; hash-pin the review inputs. Seasonal Dowdy
   entrance metadata must not become a blanket closure on otherwise public park
   topology.
5. **Optional names** — inspect generic portal labels at every representative
   entrance. Add a minimal, license-reviewed official point overlay only for
   names that remain materially wrong or ambiguous; prove it creates zero
   portals and changes zero access states.
6. **Reviewed regions and scenarios** — commit `search-regions.json` only after
   the OSM IDs, in-polygon portals, and cycle-bearing components pass; commit
   `scenarios.json` covering every representative entrance with a valid portal
   within 500 m and both plausible exact and impossible close-match requests.
7. **Generic pack wiring** — add the region builder and focused schema-6 tests
   without changing solver, request, UI, or database contracts. Assert the
   order restrictions → portal derivation → optional naming → build-context
   stripping, and audit that no street/sidewalk context survives publication.
8. **Build and QA** — build twice offline from identical caches and require
   identical data version, manifest hash, SQLite hash, and audit reports; zero
   audit/integrity/provenance/elevation/profile/coverage errors; useful portals
   in every retained selector; and exact plus honest close-match results across
   every scenario cluster.
9. **Activation** — only after licensing, audit, solver, and browser approval,
   add `packId: "henry-coe"` to `registry.json`, verify discovery, switching,
   map recentering, Quick, Batch, saved Jobs, keyboard/mobile behavior, run the
   complete verification and two consecutive browser passes, and record the
   exact pack version and evidence in `docs/rebuild/status.md`.

Generated packs, source downloads, caches, databases, and audit outputs remain
ignored and out of Git throughout.

## Completed implementation record

The final hard boundary is the unsimplified `MultiPolygon` union of pinned OSM
relations `11341366` and `16859470`, bbox `[-121.596281, 37.0324441,
-121.3058921, 37.3111329]`. Its committed bytes are 122,046 bytes with SHA-256
`7d410a95a6598585b8cc7e603bd880869be5edb84cd4aa0159f6ba254d6438e4`.
The three-entry reviewed search-region file has SHA-256
`5e88ba35edf7d89729d70e4cebe96d46d54101fc43f02efed8c54c3495745fcb`.

No exact-way restriction file was committed: the current 2026-08-08 authority
review found no restriction that could be represented as a confirmed durable
OSM-way removal. No official entrance overlay was needed. Those are explicit
review outcomes, not missing inputs; the manifest correctly reports
`officialAccess: false`.

Schema-6 pack `hc-fb46538de42e5919` uses the pinned OSM receipt above and the
single 3DEP product above. Two independent offline builds both reported
`reusedExisting: false` and produced byte-identical outputs:

| Output | SHA-256 in both builds |
| --- | --- |
| `manifest.json` | `075c9a5cdd786a83f7c673c09f73352cf21749edaa0f7d5fdeef41408756185a` |
| `pack.sqlite` | `924ec8f8ab47690c1c0717431e3f3c0f9aa0bd3aaea24dbc3010f78c4877cbed` |
| `audit.json` | `bdadb6570e8f2f7e0fa2017e735cdb417f02008fbc58301fead67af8d919bce5` |
| `regional-audit.json` | `576dfb851d80a0d25192fb05d4a386629129d5cc7d077a7b445c3c841cbb8438` |
| `portal-audit.json` | `ee424e7bcf96ce2a00425d7b349ef936ccbd309076417ad1ca6b9195dc1a5dca` |

The installed result contains 28,801 nodes, 57,830 directed trail edges, 44
persisted portals, seven named areas, and three reviewed search regions. It has
zero built-up portals; inclusive cycle reachability keeps 39 and rejects five,
while known-only reachability keeps 30 and rejects 14. The derivation pass found
54 portals before coverage filtering (44 inside and 10 outside), with 17 having
parking evidence. It stripped 99 road/sidewalk/service-road context ways before
publication. The audit has zero errors, conflicts, missing elevation/profile
values, unattributed or unknown-source records, outside-coverage persisted
edges, integrity errors, foreign-key errors, or published non-trail edges.

The shared Thorough checkpoint passes all five committed clusters. Their
selected portal distances are 0 m (Coe Ranch), 144 m (Hunting Hollow), 84 m
(Dowdy), 226 m (Mendoza), and 350 m (Harvey Bear). Plausible requests return 25
exact routes in total; every impossible request returns only clearly labeled
close matches, with zero directed-validation rejections. Dowdy explicitly uses
a 50% repeated-trail ceiling because its valid long-stem loops exceed the
shared 35% default; this scenario relaxation is visible and is not applied to
runtime defaults.
