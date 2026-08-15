# Regional expansion roadmap and pack-onboarding protocol

This document is the authoritative plan for expanding Alpine Loop beyond the
Santa Cruz Mountains. It defines the planned region catalog, the order and
boundaries of upcoming packs, the user-facing pack selector, and the approval
protocol for activating a region. The product and route-generation invariants
remain defined in [the implementation plan](implementation-plan.md), and source
handling remains governed by [the data policy](data-sources.md).

## Region catalog and pack selector

Commit the product roadmap as `data/regions/registry.json`. The catalog is the
single source of truth for every region pill shown in the header; installed
files alone never make a region selectable. The initial catalog is:

```json
{
  "version": 1,
  "regions": [
    {
      "id": "santa-cruz-mountains",
      "label": "Santa Cruz Mountains",
      "displayOrder": 1,
      "packId": "santa-cruz-mountains"
    },
    {
      "id": "southern-east-bay",
      "label": "Southern East Bay",
      "displayOrder": 2,
      "packId": "southern-east-bay"
    },
    {
      "id": "monterey-carmel",
      "label": "Monterey–Carmel",
      "displayOrder": 3,
      "packId": "monterey-carmel"
    },
    {
      "id": "henry-coe",
      "label": "Henry Coe",
      "displayOrder": 4,
      "packId": "henry-coe"
    },
    {
      "id": "marin-mount-tam",
      "label": "Marin & Mount Tam",
      "displayOrder": 5
    },
    {
      "id": "tahoe-eldorado",
      "label": "Tahoe–Eldorado",
      "displayOrder": 6
    },
    {
      "id": "central-cascades",
      "label": "Central Cascades",
      "displayOrder": 7
    }
  ]
}
```

`packId` is an explicit publication link, not a discovery hint. Add it only
after that region passes the activation gate below.

| Catalog and local-pack state | Header presentation | Behavior |
| --- | --- | --- |
| No `packId` | Disabled neutral pill with no green dot | Planned and not selectable |
| Linked pack missing or invalid locally | Disabled pill with no green dot and visually hidden `pack unavailable` status | Cannot select |
| Linked, valid installed pack | Green status dot | Selectable |
| Currently selected pack | Green dot plus selected styling | Active workspace |

Render all entries horizontally in `displayOrder`. Planned and unavailable
pills are native-disabled and expose their status to assistive technology. On
narrow screens the pill strip scrolls horizontally without wrapping or pushing
the Jobs and Settings controls out of the header.

Selecting an available pill updates `?pack=<pack-id>`, recenters the map on the
pack display defaults, and clears pack-specific filters and results while
preserving Settings and saved Jobs. Opening a saved Job from another installed
pack switches to that pack before restoring its contour and results.

Validate the catalog as a versioned `RegionRegistryV1` contract. `GET
/api/packs` returns every catalog entry in configured order with a `planned`,
`available`, or `unavailable` state, and includes pack metadata only for a valid
linked pack. Pack loading must validate catalog links and safe local paths. The
existing pack-manifest and route-request/response schemas do not change.

## Expansion sequence

### 1. Multi-pack foundation

- Generalize Santa Cruz-specific pack loading, source-cache namespaces,
  bootstrap dispatch, and regional audits without adding region branches to
  the solver or public route contracts.
- Discover and validate only the installed packs explicitly linked by the
  catalog.
- Add the catalog-driven header pills, URL selection, state reset, map
  recentering, and cross-pack saved-Job restoration described above.

### 2. Southern East Bay

Use pack ID `southern-east-bay`.

- Include Pleasanton Ridge, Mission Peak, Vargas Plateau, Sunol Regional
  Wilderness, Ohlone Wilderness, Del Valle, and adjacent connected southern
  Alameda trail systems.
- Keep the Mission Peak–Sunol–Ohlone–Del Valle corridor whole across park and
  watershed boundaries. Park or agency boundaries must not cut a connected,
  loop-capable hiking network.
- Exclude Mount Diablo, the Berkeley/Oakland hills, Henry Coe, and Stanislaus.
- Derive starts from OSM portals. Use [EBRPD maps and GIS](https://www.ebparks.org/maps)
  and [Ohlone Wilderness](https://www.ebparks.org/parks/ohlone) material only to
  review exact restrictive exceptions and, when licensing permits, optional
  entrance names; record every decision in the region charter.
- Review the whole pack plus Pleasanton Ridge, Mission Peak, Sunol, Ohlone
  Wilderness, and Del Valle as candidate pack-provided search regions.

### 3. Monterey Peninsula and Carmel Valley

Use pack ID `monterey-carmel`.

- Include Fort Ord National Monument, Palo Corona, Garland Ranch and Kahn
  Ranch, Point Lobos, Garrapata, and only the northern Los Padres connections
  necessary to keep included trail networks whole.
- Exclude deep Big Sur, Ventana backcountry, and the broader Los Padres National
  Forest. This is a multi-agency Monterey–Carmel pack, not a Los Padres-only
  pack.
- Preserve signed-trail-only and permit-dependent entrances as reviewed portal
  metadata, never as independently created route starts. Begin review with [Fort
  Ord](https://www.blm.gov/programs/national-conservation-lands/california/fort-ord-national-monument),
  [Garland Ranch](https://www.mprpd.org/garland-ranch-regional-park), and [Palo
  Corona](https://www.mprpd.org/palo-corona-regional-park).
- Review the whole pack plus Fort Ord, Palo Corona, Garland Ranch, Point Lobos,
  and Garrapata as candidate pack-provided search regions.

### 4. Henry Coe

Use pack ID `henry-coe` and the schema-6 workflow in the dedicated
[region-onboarding checklist](region-onboarding-checklist.md).

- Include the connected public hiking systems in Henry W. Coe State Park and
  Coyote Lake–Harvey Bear Ranch County Park. Use their exact reviewed named-area
  union as hard coverage; do not fill the concavity with surrounding ranches.
- Exclude Grant, Pacheco, Coyote Ridge, Cañada de los Osos, Palassou, the Santa
  Clara Valley network, and other disconnected South Diablo systems. They are
  future charter decisions, not implied by the region label.
- Derive starts entirely through the shared OSM portal pipeline. Authority
  entrances are review anchors only; omit an entrance scenario when no eligible
  derived portal lies within 500 m rather than creating or silently snapping a
  start.
- Review the whole pack, Henry W. Coe State Park, and Coyote Lake–Harvey Bear
  Ranch as search regions. Exercise Coe Ranch, Hunting Hollow, Dowdy, Mendoza,
  and Harvey Bear as route clusters.
- The exact scope, source/license review, deferred entrance, hashes, and
  measured acceptance evidence live in
  `data/regions/henry-coe/charter.md`.

### 5. Later catalog regions

Keep Marin and Mount Tam and Tahoe–Eldorado visible as disabled roadmap pills.
Stanislaus, Grant/Pacheco expansion, and deep Big Sur/Ventana remain outside the
catalog and current detailed roadmap.

### 6. Washington Cascades family

Use four overlapping hiking-network packs rather than one statewide Cascades
pack or packs clipped to agency boundaries:

1. **North Cascades** — Mount Baker, the Highway 20 corridor, the North
   Cascades complex, and Pasayten/Methow.
2. **Central Cascades** — Glacier Peak, Napeequa/Chiwawa, Lake Wenatchee,
   Stevens Pass and Leavenworth/Icicle, Alpine Lakes, Snoqualmie/Cle Elum, and
   Teanaway. Use pack ID `central-cascades`; this is the first Washington pack.
3. **Rainier–Goat Rocks** — Mount Rainier, Naches/White Pass, and Goat Rocks.
4. **Southwest Cascades** — Mount St. Helens, Mount Adams, and the southern
   Gifford Pinchot systems.

Central Cascades must include Napeequa Valley and the complete Glacier
Peak–Alpine Lakes corridor even though that crosses the historic Wenatchee
National Forest boundary. Begin its exact concave boundary with the complete
Glacier Peak and Alpine Lakes wilderness networks, their public cross-crest
approaches, and Teanaway. Exclude North Cascades National Park and Pasayten to
the north, Mount Rainier and Goat Rocks to the south, disconnected Puget
lowland systems, and the Columbia Basin. Deliberate overlap at future pack
seams is preferable to cutting a loop-capable hiking network.

Pin one dated Geofabrik Washington OSM snapshot for topology, named areas,
portal evidence, and buildings, and reuse that immutable snapshot across the
Washington family. Pin the USGS 3DEP 1/3-arc-second products intersecting each
exact pack boundary. USFS and Washington DNR boundaries, trails, ownership,
and recreation sites are review inputs only: they may support the committed
boundary, restriction review, or cosmetic portal names, but must not replace
OSM topology, create starts, or become live runtime dependencies. Do not scrape
live alerts; only durable reviewed restrictions may enter a hash-pinned exact
OSM-way removal file.

Candidate Central Cascades search regions are the whole pack, Glacier Peak
Wilderness, Alpine Lakes Wilderness, Teanaway Community Forest, and stable
useful polygons for Napeequa/Chiwawa, Icicle/Enchantments, or Snoqualmie.
Retain only candidates present in the pinned named-area inventory with useful
eligible cycle-bearing portals. Exercise Napeequa–Little Giant/High Pass,
Chiwawa/Spider Meadow, a west-side Glacier Peak access, Stevens Pass,
Icicle/Enchantments, Snoqualmie/Alpine Lakes, Cle Elum, and Teanaway in the
schema-6 checkpoint.

## Region-onboarding protocol

Every new pack completes these gates in order. Record acceptance evidence in
[the rebuild status](status.md), and activate only one region per focused
change.

### 1. Charter

- Record the pack ID and name, intended users, included and excluded trail
  systems, managing authorities, candidate reviewed search regions,
  representative trailheads, and expected overlap with neighboring packs.
- Organize boundaries around coherent connected hiking networks rather than
  counties or convenient rectangles. Overlap between packs is allowed; do not
  split a park or loop-capable network solely to avoid it.

### 2. Boundary preflight

- Commit a versioned Polygon or MultiPolygon coverage input. Exact pack
  coverage remains the hard route-geometry boundary.
- Use a separate padded download bounding box when source acquisition needs it;
  the larger download area never changes runtime coverage.
- Run an extraction spike and inspect boundary-crossing edges, connected
  components, viable access points, cycle-bearing topology, and expected build
  size. Adjust the polygon until exclusions are intentional and every reviewed
  search region has useful loop-capable coverage.

### 3. Sources and licensing

- Pin topology and elevation sources with retrieval and upstream
  dates, URLs, hashes, license terms, redistribution decisions, and adapter
  versions. Pin every optional entrance overlay the same way.
- Derive access portals from OSM topology. Record reviewed managing-authority
  restrictions as exact OSM-way removals in a committed, hash-pinned regional
  file; do not make a live authority line service an onboarding dependency.
- Fail closed on OSM or optional entrance schema drift, empty expected responses,
  undocumented fields, restriction conflicts, or unresolved licensing. Network
  refresh remains explicit; offline rebuilds and automated tests use pinned
  caches and committed fixtures.

### 4. Pack implementation

- Keep region-specific boundary, source configuration, reviewed search regions,
  access expectations, and scenarios under `data/regions/<pack-id>/`.
- Use the generic portal derivation pipeline. Region-specific access code is
  limited to reviewed exact-way removals and an optional entrance-name reader;
  do not add a line-matching authority adapter.
- Keep the pack compiler, route algorithms, request schemas, UI copy, and
  database tables region-independent.

### 5. Build and QA

- Build twice offline from identical cached inputs. Require identical data
  version, manifest, database hash, and audit results.
- Require zero audit errors, unattributed records, missing elevation, profile,
  values, integrity failures, and unintended out-of-coverage
  persisted edges.
- Review restriction conflicts, portal access-state distribution, reachable
  trail kilometres, disconnected components, viable cycle-bearing portals, and
  reviewed-region ordering. Assert that previously walkable road connectors
  remain in the published trail graph and that build-only road context does not.
- Run representative Quick and Batch searches across every major included
  trail cluster. Include exact routes and deliberately impossible requests that
  remain honestly labeled close matches.

### 6. Activation

- Add the catalog entry's `packId` only after the pack passes its build, audit,
  solver, browser, and licensing review. Merely producing local pack files does
  not activate it.
- Verify pack switching, map recentering, reviewed-region discovery, access
  previews, Quick search, Batch search, saved Jobs, stale-version behavior,
  keyboard use, and narrow-screen pill scrolling.
- Run two consecutive `npm run verify` and two consecutive `npm run
  test:browser` passes. Record
  the exact pack version and evidence in status.
- Keep generated packs, downloads, caches, databases, and audit artifacts
  ignored and out of Git.

## Test expectations for the multi-pack foundation

- Contract tests cover registry versioning, unique IDs and pack links, display
  ordering, planned/available/unavailable states, malformed linked packs, safe
  path validation, and fixture fallback when no valid real pack is available.
- Backend tests exercise generic bootstrap dispatch and source/cache namespaces
  with at least two fixture region definitions.
- UI and browser tests cover disabled semantics, green/selected presentation,
  pack switching, query-string updates, map recentering, pack-specific state
  clearing, cross-pack Job restoration, keyboard navigation, and mobile
  horizontal overflow.
