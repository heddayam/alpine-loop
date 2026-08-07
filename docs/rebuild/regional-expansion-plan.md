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
      "displayOrder": 2
    },
    {
      "id": "monterey-carmel",
      "label": "Monterey–Carmel",
      "displayOrder": 3
    },
    {
      "id": "henry-coe",
      "label": "Henry Coe",
      "displayOrder": 4
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
- Start official access research with [EBRPD maps and GIS](https://www.ebparks.org/maps)
  and the [Ohlone Wilderness](https://www.ebparks.org/parks/ohlone) source
  material, then record every authority and license decision in the region
  charter.
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
- Preserve signed-trail-only and permit-dependent entrances as explicit access
  evidence. Begin authority research with [Fort Ord](https://www.blm.gov/programs/national-conservation-lands/california/fort-ord-national-monument),
  [Garland Ranch](https://www.mprpd.org/garland-ranch-regional-park), and [Palo
  Corona](https://www.mprpd.org/palo-corona-regional-park).
- Review the whole pack plus Fort Ord, Palo Corona, Garland Ranch, Point Lobos,
  and Garrapata as candidate pack-provided search regions.

### 4. Later catalog regions

Keep Henry Coe and adjacent South Diablo trail systems, Marin and Mount Tam,
and Tahoe–Eldorado visible as disabled roadmap pills. Do not create detailed
pack-build gates for them until the first two new packs establish the protocol.
Stanislaus and deep Big Sur/Ventana remain outside the catalog and current
roadmap.

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

- Pin topology, elevation, population, and official-access sources with
  retrieval and upstream dates, URLs, hashes, license terms, redistribution
  decisions, and adapter versions.
- Prefer managing-authority evidence for permission and restrictions. Retain
  OSM as the topology baseline and unknown-access fallback.
- Fail closed on schema drift, empty authority responses, undocumented fields,
  unresolved conflicts, or unresolved licensing. Network refresh remains
  explicit; offline rebuilds and automated tests use pinned caches and committed
  fixtures.

### 4. Pack implementation

- Keep region-specific boundary, source configuration, reviewed search regions,
  access expectations, and scenarios under `data/regions/<pack-id>/`.
- Add an authority adapter only when the existing generic ArcGIS or file
  adapters cannot represent the source.
- Keep the pack compiler, route algorithms, request schemas, UI copy, and
  database tables region-independent.

### 5. Build and QA

- Build twice offline from identical cached inputs. Require identical data
  version, manifest, database hash, and audit results.
- Require zero audit errors, unattributed records, missing elevation, profile,
  or population values, integrity failures, and unintended out-of-coverage
  persisted edges.
- Review source conflicts, access-state distribution, disconnected components,
  viable cycle-bearing access points, and reviewed-region ordering.
- Run representative Quick and Batch searches across every major included
  trail cluster. Include exact routes and deliberately impossible requests that
  remain honestly labeled near misses.

### 6. Activation

- Add the catalog entry's `packId` only after the pack passes its build, audit,
  solver, browser, and licensing review. Merely producing local pack files does
  not activate it.
- Verify pack switching, map recentering, reviewed-region discovery, access
  previews, Quick search, Batch search, saved Jobs, stale-version behavior,
  keyboard use, and narrow-screen pill scrolling.
- Run `npm run verify` and two consecutive `npm run test:browser` passes. Record
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
