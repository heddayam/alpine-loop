# Olympic Peninsula pack proposal

Reviewed 2026-09-22. This is a **planning proposal** for catalog ID
`olympic-peninsula`, not a committed boundary, pinned source inventory, built
pack, or activation decision. Use the [region-onboarding
checklist](region-onboarding-checklist.md) for those later gates. The pack would
generate closed hiking routes from eligible trail portals; a named area selects
starts and never clips a route. Exact installed coverage would remain the hard
geometry boundary. Unknown access would remain included by default, and exact
and labeled close matches would stay separate.

## Scope decision

Propose **one Olympic Peninsula pack** for the terrestrial hiking network of
Olympic National Park, the adjoining Olympic National Forest approaches, and
only adjoining public DNR or state-park trail components that survive access
and topology review. The park and forest interlock around the mountains; an
agency-boundary split would cut cross-boundary approaches. Keep a concave,
possibly multipart exact boundary, with intentional holes and narrow approach
corridors where necessary. It is not a rectangle around Highway 101 or a claim
that all land inside a park/forest administrative outline is walkable. NPS
describes the park's mountain, rain-forest, and coastal systems; USFS identifies
five Olympic National Forest wilderness areas. [NPS park
overview](https://www.nps.gov/olym/planyourvisit/park-overview-three-parks-in-one.htm),
[USFS forest plan](https://www.fs.usda.gov/sites/nfs/files/r06/olympic/publication/Olympic%20NF%20Land%20and%20Resource%20Managment%20Plan.pdf).

Proposed inland coverage for boundary review:

- **North and northeast:** Hurricane Ridge/Deer Park, Elwha, Lake Crescent,
  Sol Duc, and the Dungeness–Gray Wolf/Buckhorn approaches, including public
  forest trail connections across the park seam.
- **East and southeast:** Big Quilcene, Dosewallips, Duckabush, Hamma Hamma,
  Staircase/Lake Cushman, and the Buckhorn, The Brothers, Mount Skokomish, and
  Wonder Mountain wilderness approach networks.
- **West and south:** Bogachiel, Hoh, Queets, Quinault/Graves Creek, and the
  Colonel Bob Wilderness approaches. Keep the connected public trail corridor
  whole where it crosses NPS/USFS ownership.
- **Adjacent public land:** review DNR's Little River approach to the park and
  State Parks' Dosewallips forest loops as candidate attached components, not
  automatic inclusions. DNR's Reade Hill and Sadie Creek systems and detached
  state-park or lowland trails require a separate measured reason to include;
  OESF working-forest status does not establish a permanent hiking right.
  [DNR Olympic Peninsula Forests](https://dnr.wa.gov/forest-and-trust-lands/olympic-peninsula-forests),
  [DNR recreation descriptions](https://www.dnr.wa.gov/OlympicPeninsula),
  [Dosewallips State Park](https://parks.wa.gov/find-parks/state-parks/dosewallips-state-park).

Exclude the Kitsap Peninsula, Puget Sound and Grays Harbor lowlands, detached
beach parks, road-only connectors, private timberland, and tribal lands absent
specific permission and a reviewed public trail. Do not treat an OSM line or
an administrative boundary as an access grant. Deliberate overlap with a future
neighboring pack is acceptable if a loop-capable public network crosses a seam;
no Cascades pack should need to overlap this Peninsula pack merely to fill the
water gap.

## Coast decision: defer tide-dependent routes

Do **not** publish beach walking, intertidal shortcuts, river-mouth fords, or
headland bypasses that depend on tide, surf, or an unmaintained rope as ordinary
static graph edges. NPS says coastal headlands can be impassable at some tides
and some cannot be rounded even at the lowest tide; the South Coast route has
an Oil City segment with no overland alternative. A geometric cycle alone
would falsely imply a reliably traversable hiking loop. [NPS wilderness coast
guidance](https://www.nps.gov/olym/planyourvisit/wilderness-coast.htm), [NPS
tide guidance](https://home.nps.gov/olym/planyourvisit/tides-and-your-safety.htm),
[NPS South Coast route](https://www.nps.gov/olym/planyourvisit/south-coast-route.htm).

The two inland Ozette boardwalk trails may be inspected as fixed terrestrial
tread, but the **Ozette triangle is deferred**: its closing side is a beach
walk for which NPS directs hikers to check tides. The boardwalk arms alone do
not form an independent closed route. Similarly, a mapped headland trail is
not a safe loop just because it rejoins a beach edge. Include a fixed inland
coastal-forest loop only if OSM topology, authority access, a derived portal,
and the ordinary cycle checks support it without a beach segment. Otherwise
omit that component from v1 rather than claim coastal loop coverage. Keep the
North/South Coast, Shi Shi, Rialto–Hole-in-the-Wall, and tide-dependent Ozette
beach traverse visible as **deferred coastal scope**, not as verified pack
coverage. [NPS Ozette area](https://www.nps.gov/olym/planyourvisit/lake-ozette-area-brochure.htm),
[NPS Ozette loop](https://home.nps.gov/olym/planyourvisit/ozette-loop.htm).

The coast also crosses sovereign tribal jurisdictions. NPS identifies First
Beach as Quileute Reservation land, while Second and Third Beaches are in the
park; its Second Beach page reports a tribal-land parking fee. The Makah Tribe
requires a recreational-use permit for its reservation trails to Shi Shi and
Cape Flattery. These are review triggers, not facts to encode as generic
public access. Exclude reservation portions and their starts until the relevant
tribe's current terms and exact jurisdictional geometry are reviewed; do not
infer public access from an NPS destination page. [NPS Mora/Rialto](https://www.nps.gov/olym/planyourvisit/visiting-mora-and-rialto.htm),
[NPS Second Beach](https://home.nps.gov/olym/planyourvisit/second-beach-trail.htm),
[Makah visitor notice](https://makah.com/wp-content/uploads/2022/03/Public-Notice-for-Visitors-Reservation-Re-opening_Final-2.pdf).

## Authority and source decisions to verify

| Input | Proposed role and decision gate |
| --- | --- |
| Geofabrik Washington OSM | Use one dated `.osm.pbf` for topology, access tags, portal evidence, buildings, and named areas; reuse a verified immutable Washington snapshot if suitable for the Cascades family. Confirm its current URL, upstream time, bytes, SHA-256 receipt, and ODbL attribution before build. The [Geofabrik Washington index](https://download.geofabrik.de/north-america/us/washington.html) establishes availability, not a pin. |
| USGS 3DEP | Query 1/3-arc-second DEM products against the **final exact boundary**, then pin every product ID, datum, URL, byte count, and hash. Public-domain terms are documented by [USGS 3DEP](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services); no Olympic product list is asserted here. |
| USGS National Transportation Dataset Trails | Optional public-domain, terrestrial, explicitly hiking-enabled gap supplement through the existing connected-gap conflation pipeline only. Check shoreline lines and source access carefully; no beach workaround or new portal. [USGS trails access](https://www.usgs.gov/national-digital-trails/how-access-or-view-usgs-trails-dataset). |
| NPS/USFS | Review park, wilderness, trail, jurisdiction, and durable restriction evidence. NPS permit rules concern **overnight wilderness stays**, not blanket exclusion of day hiking. Current condition pages are trip-planning checks, not a live build dependency or timeless restriction. [NPS wilderness regulations](https://home.nps.gov/olym/planyourvisit/wilderness-regulations.htm), [NPS trip planner](https://www.nps.gov/olym/planyourvisit/wilderness-trip-planner.htm), [NPS conditions](https://www.nps.gov/olym/planyourvisit/conditions.htm). |
| Washington DNR/State Parks | Review ownership, map, trail purpose, and access/parking terms for candidate adjoining components. DNR working forests may have operations; State Parks may require a Discover Pass. Treat their maps as review evidence until each dataset's reuse terms are recorded. [DNR Olympic Peninsula Forests](https://dnr.wa.gov/forest-and-trust-lands/olympic-peninsula-forests), [State Parks hiking](https://parks.wa.gov/find-activity/activity-search/hiking). |

Retain OSM attribution and make the ODbL derived-database/redistribution
decision before any publication. Do not import agency geometry merely because
it is viewable. Official entrance points, if licensed and pinned, may only
rename or raise confidence on existing OSM-derived portals. A durable
authority restriction requires a reviewed exact OSM-way target, source URL,
review date, hash, and restrictive state; no temporary fire, storm, road, or
same-day trail alert becomes a static way removal without that review. The
existing [source policy](data-sources.md) governs these decisions.

## Candidate selectors and route QA anchors

All selectors below are **candidates**, not published named regions. Retain
only stable polygons present in the selected OSM snapshot with useful
default-eligible, cycle-bearing portals, including review of the shared 500 m
named-area approach band. Start with whole pack, Olympic National Park,
Olympic National Forest, Daniel J. Evans Wilderness, and the five named USFS
wilderness areas. Large park/forest selectors may be too broad to be useful;
defer them if portal distributions or geometry do not support the intended
choice. Consider narrower Hurricane Ridge, Lake Crescent/Sol Duc, Hoh,
Quinault, Staircase, or Buckhorn/Dungeness polygons only if a stable named-area
object and measured eligible starts exist. Do not invent selector shapes from
these place names.

Use the [NPS day-hike inventory](https://www.nps.gov/olym/planyourvisit/day-hiking-at-olympic.htm)
and [USFS forest plan](https://www.fs.usda.gov/sites/nfs/files/r06/olympic/publication/Olympic%20NF%20Land%20and%20Resource%20Managment%20Plan.pdf)
as review anchors. Proposed checkpoint clusters are Hurricane Ridge/Deer Park;
Elwha/Whiskey Bend; Lake Crescent; Sol Duc; Dungeness/Big Quilcene; Hoh;
Bogachiel; Queets; Quinault/Graves Creek and Colonel Bob; Dosewallips/Duckabush;
and Staircase/Lake Cushman. Add a small forest loop such as Hoh Hall of Mosses,
Sol Duc Lovers Lane, Elwha Geyser Valley, or Staircase Rapids where the pinned
topology supports a real cycle. These named hikes are **validation locations**,
not preloaded routes or guaranteed solver results. Each scenario needs an
OSM-derived eligible portal within 500 m, a plausible exact request, and an
impossible request that returns an explicitly violated close match. A trail
cluster with no viable closed cycle remains visible in the audit but cannot be
claimed as a passing route scenario.

## Boundary preflight and activation blockers

1. Draft the versioned concave Polygon/MultiPolygon from reviewed NPS/USFS
   scope and OSM named-area evidence. Use a separate padded download box.
   Inspect every inlet, tribal/private inholding, shoreline contact, and
   park/forest seam; record why each coastal or lowland component is present.
2. Spike a reference-complete OSM extraction. Count boundary-crossing and
   rejected trail edges, connected components, reachable trail kilometres,
   build size, derived portals, nearby buildings, and known/inclusive
   cycle-bearing portals by cluster. Revise the exact boundary where it cuts
   a public loop, and explain intentional disconnected or omitted systems.
3. Inspect coastal OSM/USGS way classes before compilation so beaches, tide
   crossings, and implied headland connectors cannot become static routes.
   Review access conflicts at NPS/USFS/DNR/state/tribal seams and record
   license decisions. Only then pin source bytes and any durable exact-way
   restrictions; an unreviewed source or missing license blocks the build.
4. Implement only region inputs and the shared schema-6 builder pattern. Run
   focused deterministic tests without network access. Refresh sources once,
   then build twice **offline** from identical pinned caches with fresh
   preparation roots. Require matching data version and byte-identical
   manifest, SQLite, and audit files; zero audit/integrity, provenance,
   elevation-profile, and outside-coverage errors; no published road context;
   and reviewed portal/building/cycle distributions.
5. Pass a representative Thorough checkpoint and spot-check Quick and Full
   searches across every retained major cluster. Verify one exact and one
   labeled close outcome per accepted scenario, with zero directed-validation
   rejections. Only after licensing, real-pack UI/browser checks, and the
   prescribed repeated verification passes may a separate focused change add
   the catalog `packId` and record acceptance evidence in `status.md`.

There is presently **no exact boundary, Olympic source receipt or hash,
reviewed OSM named-area ID, DEM product ID, preflight measurement, scenario
result, or activation evidence** in this proposal. Those are explicit
blockers, not implied by the geographic scope.
