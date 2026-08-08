# Access-point derivation plan

This document replaces per-authority access-point sourcing with a derivation
computed from the OSM extract the pack already downloads. It defines the
measured problem, the portal-based design, what happens to the existing
authority adapters, and the migration order. Product invariants remain defined
in [the implementation plan](implementation-plan.md), source handling in [the
data policy](data-sources.md), and region onboarding in [the regional expansion
roadmap](regional-expansion-plan.md).

## Decision summary

Derive access points from graph topology — the places where the drivable
network meets the trail network — instead of ingesting third-party point
features and hoping they connect to a trail. Retain official agency data only
as (1) a curated list of access-state *removals* and (2) an optional name
overlay. Neither is required to onboard a region.

Every measurement below was taken from the three installed packs
(`scm-cf499195b533cbbd`, `seb-fbb73433186eb5f5`, `mc-8cd6885ec6e0215a`) and
their cached Geofabrik extracts. Reproduce them against a rebuilt pack before
trusting them again; they are a snapshot, not a contract.

## The measured problem

### Access points are overwhelmingly not trailheads

| | Santa Cruz | S. East Bay | Monterey |
| --- | --- | --- | --- |
| `access_points` rows | 3,203 | 2,131 | 1,650 |
| `kind=parking` | 3,189 (99.6%) | 2,108 | 1,635 |
| `kind=trailhead` | 14 | 23 | 15 |
| generic `"OSM parking"` name | 2,890 | 2,034 | 1,592 |
| **on a node touching a trail edge** | **502 (15.7%)** | **158 (7.4%)** | **157 (9.5%)** |
| on a node whose only edges are `highway=footway` | 2,609 (81%) | 1,950 (91%) | 1,483 (90%) |

"Trail edge" here means `highway` in `path`, `track`, `bridleway`, or `steps`.
Roughly 85–90% of the table is a parking lot snapped to a sidewalk.

### The graph cannot distinguish a trail from a street

`edges` mixes `path`/`track`/`bridleway`/`steps` with `footway`, `service`, and
`residential`. In Santa Cruz, `footway` is the largest class by length —
3,005 km against 1,589 km of `path` — and in the raw extract 21,957 of 29,589
`footway` ways (74%) carry `footway=sidewalk`, `crossing`, `traffic_island`,
`access_aisle`, or `link`. That subtag is discarded in
`lib/data/osm/normalize.ts` and `lib/data/osm/opl.ts` when way flags are built.
A retail lot and a state-park headquarters are therefore topologically
identical objects.

### Connectivity, the only structural signal, does not discriminate

Because everything touches a sidewalk, `inclusive_out_degree > 0` holds for
3,117 of 3,203 Santa Cruz rows (97%). Because most edges are access-`unknown`,
`known_out_degree > 0` holds for only 249 (7.8%).
`rankAccessPointCandidates` in `lib/solver/eligible-access-points.ts` sorts
primarily on `knownConnectivity`, which is zero for 92% of rows. Start ranking
is effectively sorting on noise.

### "Road accessible" is not computable

`HIGHWAY_FILTER` in `lib/data/osm/pipeline.ts` drops motorway, trunk, primary,
secondary, and tertiary outright, and `osmWayIsHikingRelevant` drops `service`,
`unclassified`, `residential`, and `living_street` unless they carry a
pedestrian access tag or a trail-like name. The entire Santa Cruz pack retains
44 km of residential and 44 km of service road. The extract already on disk
contains 37,610 service, 13,818 residential, 2,619 secondary, 2,224 tertiary,
1,846 primary, and 700 unclassified ways, all discarded.

Wholesale `amenity=parking` ingestion is the consequence, not the cause:
parking is the only OSM object that reliably co-locates with trailheads, so it
became the proxy for a trailhead. It is not selective, so all 3,376 Santa Cruz
parking ways arrive with it.

### Strong signals are unused

Santa Cruz contains 13 `highway=trailhead` nodes and 411
`information=guidepost|board|map` / `tourism=information` POIs. The reliable
signal is 30× more common than the one the pipeline looks for. The region also
contains 4,637 `barrier=gate` nodes, currently admitted only when their `name`
matches a regular expression in `lib/data/osm/opl.ts`.

## The portal design

An access point is a **portal**: a place where the drivable network touches the
trail network, clustered, scored, and attributed with evidence. It is derived,
not ingested, and requires no authority adapter.

### 1. Classify every edge

Add an edge class — `trail`, `service-road`, `street`, `sidewalk` — derived at
normalize time from `highway` plus the `footway=` and `service=` subtags. This
is one field and one adapter-version bump, and every later step depends on it.
Nothing else in this plan is worth doing first.

### 2. Ingest the drivable network as non-traversable

Retain the full road network so portals can be computed, marked so
`edgeIsTraversable` in `lib/graph/policy.ts` never admits it and the solver
never routes on pavement. Expect the Santa Cruz node count to grow materially
above its current 425,302; measure before committing to a schema.

### 3. Derive portals

Portal candidates are trail-class nodes shared with a street-class way, plus
trail-class nodes within a tuned distance of a parking area whose own nodes
touch a street. Cluster candidates at roughly 150 m and emit one access point
per cluster. Measured on the Santa Cruz extract:

| candidate rule | raw nodes | clustered at 150 m |
| --- | --- | --- |
| trail × public road | 1,975 | **1,456** |
| trail × public road or service road | 4,387 | 2,372 |
| trail incl. untagged `footway` × public road | 2,806 | 1,797 |

Against today's 502 trail-touching access points (432 of them not private or
prohibited), the strict rule finds roughly **2.9× more real trail entrances
while discarding about 2,700 rows of sidewalk-parking noise**.

### 4. Score portals on the trail-only network

Compute connectivity on the trail-class graph alone. Santa Cruz has 3,158 trail
components totaling 4,088 km, which separates a subdivision path stub from a
ridge system in a way the sidewalk-inclusive `inclusive_connectivity` never
can:

| reachable trail component | portals |
| --- | --- |
| ≥ 0.5 km | 945 |
| ≥ 2 km | 685 |
| ≥ 5 km | 546 |
| ≥ 25 km | 363 |
| ≥ 100 km | 205 |

Of the 546 portals reaching ≥ 5 km, 126 have a mapped parking area within
250 m.

### 5. Attach evidence rather than gate on it

Parking within a tuned radius; `highway=trailhead`, `information=trailhead`,
`guidepost`, `board`, `map`, or `tourism=information` nearby; `barrier=gate` on
the trail at the portal; an official entrance record nearby; a name on the
portal's trail. Evidence raises confidence and supplies labels. It never
decides whether the portal exists.

### 6. Persist the discriminating measurements

Reachable trail-only kilometres, trail component identifier, portal road class,
and parking distance belong in `access_points` so ranking and any future
"trailheads that go somewhere" filter become thresholds rather than hopes.

## Disposition of the authority adapters

### What they cost

`lib/data/authorities/` is 1,510 lines of source and 960 lines of tests, the
centrepiece being `spatial-match.ts` (319 lines) and `arcgis.ts` (160 lines).
Line matching leaves 2,204 authority features unmatched in Santa Cruz and 1,081
in Southern East Bay, with 246 ambiguous OSM ways. Each region needs one to
three adapters as an onboarding gate, and the Monterey State Parks source is
already dead (`california-state-parks-recreational-routes.blocked.json`).

Most sources are also non-redistributable. Midpen records "No affirmative reuse
license is stated"; EBRPD, "no affirmative data-reuse license"; Santa Clara
County, "no license grant"; MPRPD, "no affirmative data-reuse grant"; CA State
Parks, custom terms. Only San Mateo County (public domain) and the USFS and BLM
records (US Government work) are clean. Today these sources pin every pack to
local evaluation only.

### What they buy, split by algorithm versus interface

`accessStateIsAllowed` in `lib/graph/policy.ts` admits `public` and `unknown`
when uncertain access is included, which is the default, and never admits
`private`, `closed`, or `prohibited`. **A `public ↔ unknown` transition
therefore has no effect on the route set a default user receives.** Splitting
the applied joins on that boundary:

| | inert | adds traversable | removes traversable | algorithmic delta |
| --- | --- | --- | --- | --- |
| Santa Cruz (7,312 km) | 59.9 km (54% of output) | +37.4 km | −14.0 km | **51.4 km = 0.70%** |
| S. East Bay (4,156 km) | 79.9 km (73%) | +6.7 km | −22.4 km | **29.1 km = 0.70%** |
| Monterey (1,819 km) | 14.9 km (76%) | 0 km | −4.7 km | **4.7 km = 0.26%** |

The line-match machinery moves 0.7% of the traversable network, and half to
three-quarters of its visible output changes nothing. It produces no names, so
deleting it degrades nothing a user reads.

The entrance points are a different matter. All 22 Southern East Bay and all 9
Monterey official points sit on nodes no other access point covers, so under
the current pipeline they are **31 route starts that would not otherwise
exist** — Stanford Avenue Park Entrance, Sunol main entrance, Point Lobos main
entrance, Garland Ranch main entrance. That is the sharpest available evidence
that the parking-lot pipeline misses real trailheads.

Portals recover them geometrically without any agency data. Within 250 m of a
computed portal: **20 of 22** in Southern East Bay and **7 of 9** in Monterey.
The misses are Foothill Road Walk-In Entrance (277 m), Kahn Ranch (281 m), and
Palo Corona Highway 1 west gate (525 m), all at the tolerance boundary, plus
Foothill Road Staging Area (1,952 m), a genuine miss where OSM has no mapped
trail connection.

So the entrance data converts from algorithmic to cosmetic once portals exist:
27 of 31 starts survive without it, and what is lost is the name.

| deleted | algorithm degradation | interface degradation |
| --- | --- | --- |
| ArcGIS line-match adapters | ≤ 0.70% of network; over half inert | none |
| USFS Monterey adapter | **zero, measured** | none |
| Entrance points, **before** portals | **31 route starts** — unacceptable | 31 names |
| Entrance points, **after** portals | ~4 starts | **31 names** |
| Curated closure lists | −14 / −22 / −4.7 km of removals | none |

The asymmetry that decides this: the permissive half of the agency data is
nearly worthless algorithmically, while the restrictive half is small but is
the only thing preventing the product's worst failure — routing a user onto a
closed trail.

### Resulting disposition

1. **Delete** every live ArcGIS line-match adapter — Midpen, Santa Clara
   County, California State Parks, EBRPD roads-and-trails, USFS Monterey —
   together with `spatial-match.ts` and `arcgis.ts`.
2. **Keep the removals** as a per-region curated exception list keyed on OSM way
   ID, hand-reviewed, with no live service call. Roughly 30 entries for Santa
   Cruz, 45 for Southern East Bay, 2 for Monterey. This is a text file, not an
   adapter, and it preserves the entire safety-critical half at no interface
   cost. `southern-east-bay/current-closures.json` and
   `monterey-carmel/official-sources/reviewed-access.json` already have the
   shape.
3. **Keep official entrances** as an optional name overlay on portals rather
   than a source of access points. A region shipping without one gets portals
   named from nearby OSM features: degraded labels, identical routes.

## Migration order

Each step is independently verifiable by rebuilding the three installed packs
and diffing the access-point set.

1. Edge classification. Cheap, testable in isolation, and it immediately makes
   the existing connectivity columns meaningful.
2. Drivable-network ingestion as non-traversable edges. Verify the solver's
   route set is unchanged before and after.
3. Portal derivation, clustering, and trail-only scoring. Compare the resulting
   access-point set against the current one on the map before committing.
4. Parking demoted from access point to portal evidence.
5. Adapter deletion and conversion of removals to curated lists.

**Do not reorder 5 before 3.** Today the entrance points are 31 algorithmic
starts; after portals they are about 4 starts and 31 names. The deletion is
expensive now and nearly free later.

## Open questions and risks

- `highway=track` is both trail and drivable forest road. Treating it as
  trail-only mints portals at what are really road-to-road junctions. Resolve
  by inspecting `motor_vehicle` and `access`.
- Untagged `highway=footway` (7,621 ways in Santa Cruz) is genuinely ambiguous
  between park paths and un-subtagged sidewalks. Including it moves the Santa
  Cruz portal count from 1,456 to 1,797, so it is a ~20% effect and should be
  classified by context rather than admitted by default.
- Trails that begin off a road shoulder with no shared node need a proximity
  snap. That reintroduces a tolerance, but one tuned constant rather than one
  adapter per agency. The 250 m tolerance carried the 27-of-31 recovery result
  above; tightening it to 150 m would drop several. It must become a tested
  constant, not a guess.
- `unknown → public` promotions are not perfectly inert. `knownConnectivity` is
  computed on the known-access graph and feeds `rankAccessPointCandidates`, so
  promotions perturb which starts are searched first when route count caps the
  search. Moving ranking onto reachable trail-network size removes the
  coupling; until then, steps 3 and 5 are coupled.
- Resolved: the population-based remoteness taxonomy was replaced by a single
  building-count rule in `lib/data/wilderness.ts`, which needs no per-region
  tuning. See "Buildings" in [data sources](data-sources.md).
- Not all 1,456 Santa Cruz portals are useful. Some are a path crossing a road
  mid-block. Trail-component thresholds and evidence scoring, not the portal
  rule alone, are what make the set usable.

## Effect on region onboarding

After this change a new region needs a boundary polygon, an OSM extract, a DEM,
— all generic and already automated. Buildings come from the same extract. The "Sources and licensing"
and "Pack implementation" gates in the [regional expansion
roadmap](regional-expansion-plan.md) no longer require authority adapter work
to produce access points. Official data becomes an optional per-region quality
pass whose absence appears as generic trailhead names, never as missing or
unsafe routes.
