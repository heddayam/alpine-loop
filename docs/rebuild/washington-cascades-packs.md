# Remaining Washington Cascades pack setup

Planning review: **2026-09-22**. This is the charter and boundary-preflight brief
for the three remaining packs in the [accepted four-pack Cascades
family](regional-expansion-plan.md#washington-cascades-family). Central Cascades is
already installed and [has an exact, versioned hard
boundary](../../data/regions/central-cascades/charter.md). The three IDs below
are proposed directory/build IDs; their catalog entries, exact polygons,
sources, and activation remain separate onboarding decisions. Each pack serves
route generation from a local trail graph, not a catalog of named hikes.

## Scope and seam decisions to make before drawing polygons

| Proposed pack | Include as one coherent hiking-network review unit | Exclude or defer | Seam to inspect |
| --- | --- | --- | --- |
| `north-cascades` | Mount Baker and Baker Lake approaches; Highway 20/Skagit and Cascade River approaches; all three units of the North Cascades National Park Service Complex (park, Ross Lake NRA, Lake Chelan NRA); adjoining Pasayten, Methow, and accessible Lake Chelan–Sawtooth trail networks where their connections matter. [NPS trail guide](https://www.nps.gov/noca/planyourvisit/trailguide.htm), [NPS access guide](https://www.nps.gov/noca/planyourvisit/directions.htm), [USFS Baker district](https://www.fs.usda.gov/r06/mbs/recreation/mt-baker-ranger-district?page=1). | British Columbia; isolated Puget lowland and Okanogan basin systems; Central Cascades' Glacier Peak, Napeequa/Chiwawa, and Alpine Lakes core. A Canadian or boat leg is not a pedestrian graph connector. | Review the Stehekin/Agnes Creek–PCT and Baker River/Glacier Peak approaches with Central. Keep a trail circuit whole by deliberate overlap if necessary; do not assume the NPS/USFS boundary is a routable seam. NPS describes foot access to Stehekin from Cascade Pass, Rainy Pass, and Twisp River trailheads. [NPS directions](https://www.nps.gov/noca/planyourvisit/directions.htm). |
| `rainier-goat-rocks` | Mount Rainier National Park's complete maintained hiking network, especially the Wonderland circuit and public approach trails; adjacent Norse Peak, Naches/Chinook Pass, William O. Douglas, White Pass, and the complete Goat Rocks network with its public west/east approaches. [NPS Wonderland](https://www.nps.gov/mora/planyourvisit/the-wonderland-trail.htm), [USFS PCT Washington map](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd609082.pdf), [USFS Goat Rocks](https://www.fs.usda.gov/air/technical/class_1/wilds.php?recordID=29). | Central Cascades' Alpine Lakes and Teanaway core; Mount St. Helens, Mount Adams, and the southern Gifford Pinchot core; disconnected Tacoma/Yakima lowlands. | Inspect Snoqualmie/Greenwater–Norse Peak with Central, and White Pass/Goat Rocks–upper Cispus with Southwest. Overlap a continuous loop-capable trail component when a clean seam would sever it. The USFS PCT map shows the Chinook Pass–White Pass–Goat Rocks sequence. |
| `southwest-cascades` | Mount St. Helens National Volcanic Monument and its approach/Boundary/Loowit networks; Mount Adams Wilderness and public approaches; southern Gifford Pinchot hiking systems including Indian Heaven and Trapper Creek. Test Silver Star and its connected public trails as an explicit inclusion decision. [USFS Loowit](https://www.fs.usda.gov/r06/giffordpinchot/recreation/loowit-trail-216), [USFS Boundary Trail](https://www.fs.usda.gov/r06/giffordpinchot/recreation/trails/trail-1-boundary-norway-pass-elk-pass), [USFS forest trail plan](https://www.fs.usda.gov/sites/nfs/files/r06/giffordpinchot/publication/GP_Sustainable_Trails_Plan_Final%28508c%29.pdf). | Goat Rocks core (Rainier–Goat Rocks); Oregon and the Columbia River Gorge across the state line; disconnected urban/lowland trail islands. The Washington side of the Gorge needs its own explicit scope decision rather than being inferred from the forest name. | Inspect upper Cispus/Goat Rocks approaches with Rainier–Goat Rocks. Review Adams' north-side Killen Creek/PCT connections, St. Helens' eastern Boundary Trail, and any included Silver Star/Tarbell connection before placing concavities. [USFS Gifford Pinchot hiking sites](https://www.fs.usda.gov/r06/giffordpinchot/recreation/opportunities/hiking?page=%2C30). |

These are geographic review units, not park or forest polygons. Draw each
versioned `Polygon`/`MultiPolygon` around public, connected hiking systems and
their approaches. Exact installed-pack coverage is the hard boundary for every
generated route. Drawn, named, and driving areas only filter eligible starts.
The same trail may be present in neighboring packs; a seam overlap does not
authorize crossing from one pack into another during one search. Preserve
unknown access as the default-included state and keep exact and labeled close
matches separate. [Implementation plan](implementation-plan.md),
[onboarding checklist](region-onboarding-checklist.md).

Agency review leads are NPS, Mount Baker–Snoqualmie and
Okanogan–Wenatchee National Forests, and the Colville National Forest at the
Pasayten east edge for North; NPS and the adjacent national forests for
Rainier–Goat Rocks; and Gifford Pinchot National Forest plus the **Yakama
Nation** at Mount Adams for Southwest. The Yakama Reservation covers Mount
Adams' eastern half, and USGS says only designated recreation areas there are
publicly open. Treat that edge as an explicit access and boundary decision;
do not infer public access from an OSM trail or a generic forest outline.
[USGS Mount Adams](https://www.usgs.gov/volcanoes/mount-adams/science/geology-and-history-mount-adams),
[Yakama Nation reservation map](https://yakama.com/about/).

## Candidate search areas and checkpoint anchors

These are review candidates, **not published selectors or guaranteed derived
portals**. Retain a named area only if the pinned OSM named-area inventory has a
stable polygon and the compiled graph yields useful eligible, cycle-bearing
portals inside it or within the shared 500 m named-region approach band.
Anchors must resolve to a derived OSM portal within 500 m; an agency trailhead
or parking feature never creates a start. For each retained major cluster, test
a plausible exact request and an impossible request yielding an explicitly
violated close match. [Onboarding checklist](region-onboarding-checklist.md).

| Pack | Candidate reviewed areas | Route-checkpoint clusters and special review |
| --- | --- | --- |
| North | Whole pack; Mount Baker Wilderness; Stephen Mather Wilderness/NPS complex only if the pinned named-area geometry and portal distribution make a useful selector; Pasayten Wilderness; Lake Chelan–Sawtooth Wilderness; a narrower Methow or Highway 20 area only if supported by a stable polygon. | Baker Lake/Baker River, Hannegan or Artist Point, Cascade Pass, Diablo/Ross Lake, Rainy/Maple Pass, Stehekin approaches, Methow/Twisp, Pasayten west/east approaches. NPS lists park trails and documents roadless Stehekin; do not model a water taxi or shuttle as a trail edge. [NPS guide](https://www.nps.gov/noca/planyourvisit/trailguide.htm), [NPS directions](https://www.nps.gov/noca/planyourvisit/directions.htm). |
| Rainier–Goat Rocks | Whole pack; Mount Rainier National Park; Norse Peak Wilderness; William O. Douglas Wilderness; Goat Rocks Wilderness; perhaps a Naches/White Pass polygon if its named geometry and portals pass review. | Longmire/Paradise, Mowich/Carbon, Sunrise/White River, Ohanapecosh, Chinook/Greenwater, Naches, White Pass, Snowgrass/Goat Lake and a Goat Rocks east-side approach. The Wonderland circuit must not be cut by a park edge; inspect park permits as trip-planning context, not as an inferred trail closure. [NPS Wonderland](https://www.nps.gov/mora/planyourvisit/the-wonderland-trail.htm), [USFS hiking sites](https://www.fs.usda.gov/r06/giffordpinchot/recreation/opportunities/hiking?page=%2C30). |
| Southwest | Whole pack; Mount St. Helens National Volcanic Monument; Mount Adams Wilderness; Indian Heaven Wilderness; Trapper Creek Wilderness; Silver Star only if retained in the hard boundary and supported by reviewed geometry. | Ape Canyon/June Lake, Loowit feeder and Boundary Trail/Mount Margaret, Adams south and north approaches, Indian Heaven, Trapper Creek, and Silver Star if included. The Loowit circuit uses feeder trails rather than a road crossing; review whether OSM has a complete pedestrian loop and whether restricted off-trail segments are tagged correctly. [USFS Loowit](https://www.fs.usda.gov/r06/giffordpinchot/recreation/loowit-trail-216), [USFS Silver Star](https://www.fs.usda.gov/r06/giffordpinchot/recreation/trails/trail-180-silver-star). |

## Source and licensing setup

1. Reuse the **same immutable, dated Geofabrik Washington OSM snapshot** already
   pinned for Central as the candidate input for all three packs; verify its
   cached receipt, upstream date, content hash, license, and current
   fresh-install availability before configuring a builder. The Washington PBF
   supplies trail topology, access tags, named areas, portal evidence, and
   building centroids. It is under ODbL; retain contributor attribution and
   resolve derived-database distribution obligations before external release.
   [Geofabrik Washington](https://download.geofabrik.de/north-america/us/washington.html),
   [OSM copyright](https://www.openstreetmap.org/copyright/en-US),
   [Central source decision](../../data/regions/central-cascades/charter.md#osm-topology-and-runtime-evidence).
2. Query [USGS 3DEP 1/3 arc-second
   DEM](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)
   for **each exact candidate boundary**. Review all intersecting products,
   resolution and datums; then pin their IDs, source metadata, bytes, and
   SHA-256 in the region's build evidence. Use a unique elevation collection
   namespace per pack, while sharing immutable raw products where identical.
   USGS marks the product public domain. No product IDs are selected in this
   plan.
3. Use [USFS Geodata](https://data.fs.usda.gov/geodata/) wilderness,
   administrative, trail, and recreation layers; NPS park maps/trail guides;
   and [Washington DNR maps](https://www.dnr.wa.gov/maps) as **review evidence**
   for scope, seams, omissions, and possible cosmetic names. They do not create
   starts, grant legal access, replace the OSM baseline, or become live
   dependencies. Verify each optional dataset's exact license and
   redistribution terms before importing it. An official trail supplement is
   conditional on a licensed, pinned snapshot and the existing generic
   conflation rules; it may add only attached, hiking-enabled, nonduplicate
   trail geometry with `unknown` access and provenance.
4. Review durable agency restrictions against exact OSM way IDs. Commit only
   restrictive `private`, `closed`, or `prohibited` overrides with dated source
   evidence and a content hash. Do not ingest changing alerts, snow or road
   status, camping/permit rules, or an agency trail line as an access decision.
   In particular, NPS backcountry permits and the USFS Loowit/Boundary Trail
   camping and off-trail rules require product-level interpretation before any
   trail-access override. [NPS Wonderland](https://www.nps.gov/mora/planyourvisit/the-wonderland-trail.htm),
   [USFS Loowit](https://www.fs.usda.gov/r06/giffordpinchot/recreation/loowit-trail-216),
   [USFS Boundary Trail](https://www.fs.usda.gov/r06/giffordpinchot/recreation/trails/trail-1-boundary-norway-pass-elk-pass).

## Boundary preflight questions and release gates

For **each** pack, overlay candidate named-area outlines, reviewed public
approaches, the Central boundary (where relevant), and the adjacent planned
pack seam. Inspect the OSM extract before freezing the polygon:

- Which trail edges cross the proposed boundary, and do any complete a cycle
  or connect a reviewed trailhead to an included system? Which are deliberate
  exclusions, and which require overlap or a concave extension?
- Are all intended portal clusters on the hiking side of the exact polygon?
  How many derived portals are public/unknown, built-up, no-cycle, and default
  eligible? Are isolated components genuine or evidence of missing topology?
- Do NPS/USFS unit edges, lakes, glaciers, river crossings, reservations or
  state lines create false connectors or artificial cutoffs? For North, check
  Stehekin/Ross Lake boat-only access and the Canadian border. For Rainier,
  check Wonderland and the PCT/Norse Peak–White Pass–Goat Rocks chain. For
  Southwest, check the Loowit circuit, Mount Adams north approaches, the
  Yakama Reservation edge and any specifically authorized recreation area,
  the Cispus seam, and the southern Washington limit.
- Does a source supplement need to fill a *measured attached* hiking gap, and
  can its terms/provenance pass the generic conflation gate? If not, keep the
  missing link visible and defer the affected checkpoint; never fabricate a
  connector.

Then follow the [schema-6 onboarding checklist](region-onboarding-checklist.md)
**one pack at a time**: commit boundary, source configs, reviewed selectors,
and scenarios; perform one deliberate network refresh into ignored immutable
caches; build twice independently offline from the same pins; compare data
version and byte hashes; require zero audit, integrity, missing trail-elevation,
source/provenance, and out-of-coverage errors; review component, portal,
building, and cycle distributions; run every representative exact/close
checkpoint plus Quick and Batch spot checks. Run the required application and
browser verification twice and inspect the local app. Only after license,
data, routing, and UI evidence passes should a focused catalog activation
change add that pack's `packId` and record results in status. Keep generated
packs, downloads, caches, receipts, databases, and audits out of Git.
