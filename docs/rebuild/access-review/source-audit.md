# Access-point source and validation audit

Reviewed 2026-09-30 against repository base `9fff8d7`. This is review evidence,
not an accepted API/data-contract revision or an accuracy measurement. The
implementation plan, runbook and data-source policy were read in full. No pack,
download, cache or live database was inspected or changed.

## What the source actually establishes

The pinned OSM extract supplies geometry, shared node identity, transport tags
and mapped observations. It does not establish that all real entrances, legal
restrictions, buildings or approach connections are mapped. A connected path is
physical/topological evidence, not proof of permission or of somewhere to park.

OSM defines `access` as a blanket transport restriction, with more specific mode
keys overriding it. Pedestrians and vehicles occupy different branches of that
hierarchy. Missing tags may have object-specific routing defaults; Alpine Loop
instead deliberately retains `unknown` as provenance and includes it by default.
Those are distinct decisions. [OSM access documentation](https://wiki.openstreetmap.org/wiki/Key:access)

`highway=trailhead` describes a customary/designated trip start, including
unmarked entrances; a trail dead end alone is insufficient. The node is usually
on a highway, but mappers choose its exact placement and sometimes use an area.
A board or gate need not sit at the actual road-to-trail transition.
[OSM trailhead documentation](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrailhead)

A gate is a barrier object. Its mode access and locked state matter; its existence
is not affirmative permission. A gate way without a shared crossing node may be
missed by routers. [OSM gate documentation](https://wiki.openstreetmap.org/wiki/Tag:barrier%3Dgate)

## Current mapping at the adapter boundary

[`normalize.ts`](../../../lib/data/osm/normalize.ts) serves both the production
coverage source store and the small OPL/fixture path.

| Input | Current interpretation | Consequence to audit |
| --- | --- | --- |
| `foot` present, otherwise `access` | One `accessState` for every way and portal evidence object | Correct mode precedence for basic foot tags, but it is reused for road and parking nomination. |
| `no`, `agricultural`, `forestry` | `prohibited` | Excluded from traversal. |
| `private`, `customers`, `destination` | `private` | All excluded; distinct purpose-limited access is collapsed. |
| `yes`, `designated`, `permissive`, `public` | `public` | General permission and revocable permission share the public state. |
| Absent or other values | `unknown` | `delivery`, `military`, `permit`, `use_sidepath` and unsupported values lose their distinct meaning; inclusive traversal may admit them. |
| `motor_vehicle`, then `vehicle`, then `access` | Consulted only by track classification; several purpose-limited values count as affirmative | No separate car/motor predicate is retained; `motorcar` is unexamined. |
| `path`, `bridleway`, `steps` | `trail` | Permission remains a separate access-state check. |
| `footway`, `pedestrian` | `trail`; `possible-walking-link` unless trail context exists | Explicit sidewalk/crossing subtags are excluded; untagged plazas/urban footways remain possible links. |
| `service`, `unclassified`, `residential`, `living_street` with affirmative `foot`, or Trail/Path/Walk in name | `trail` | Walking permission/name replaces the road class, even though pedestrian use can coexist with vehicle use. |
| `track` | `trail` unless affirmative motor evidence **and** `foot=no` | Drivable tracks usually remain hiking only; access=no without affirmative motor evidence remains a restricted trail. |
| Other supported streets; plain service roads | `street` / `service-road` | Retained as build-time approach context and discarded before runtime publication. |
| `oneway:foot`, otherwise generic `oneway`; foot directional no tags | Walking direction | Generic vehicle oneway can make a foot-accessible road/track one way. |
| Conditions, opening/seasonal rules, `locked`, most node barriers | Not retained as traversal rules | No date/context evaluation; a missing restriction and an unhandled restriction look alike downstream. |

The meaning of `destination` is traffic to that element/area, not residents only;
`customers` refers to visitors/customers of the associated feature. Therefore
collapsing them to private is a conservative product policy rather than exact
source semantics. A park visitor may satisfy a destination restriction; whether
that is permitted must be labeled rather than inferred. `permit` also requires a
condition the current request does not model.
[OSM access values](https://wiki.openstreetmap.org/wiki/Key:access)

`foot=yes` specifies pedestrian permission, not a hiking classification.
[OSM foot=yes documentation](https://wiki.openstreetmap.org/wiki/Tag:foot%3Dyes)
A track is a minor access road type rather than a guarantee of motor permission
or a guarantee of pedestrian-only use. [OSM track documentation](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrack)
Car-specific restrictions belong to the car branch, including `motorcar`.
[OSM motorcar documentation](https://wiki.openstreetmap.org/wiki/Key:motorcar)

Ordinary street `oneway` applies to vehicles. `oneway:foot` and foot directional
tags are unambiguous; generic oneway on path/footway is more ambiguous, while steps
can legitimately use the legacy generic form. A uniform fallback across all
classes is therefore not supported by the source semantics.
[OSM pedestrian direction guidance](https://wiki.openstreetmap.org/wiki/Key:oneway#Interpretation_for_routing)

Conditional restrictions have defined mode/direction/time precedence. Discarding
them can create either a false positive during a closure or a false negative
when a restrictive base value has a permissive exception. No request date is
currently available to resolve every condition. Preserve unsupported conditions
as unresolved evidence rather than claiming they have been evaluated.
[OSM conditional restriction specification](https://wiki.openstreetmap.org/wiki/Conditional_restrictions)

## Concrete failure mechanisms

These are code-supported counterexamples, not counts of real-world failures.

1. **Foot permission reused as arrival permission.** In
   [`portals.ts`](../../../lib/data/progressive/portals.ts), `road_nodes` admits
   nonrestricted street/service-road ways using the normalized foot state.
   A street with `motor_vehicle=private` and missing foot/access has an unknown
   foot state and can nominate a start. A parking object with `foot=yes` and
   `access=private` also normalizes public. These facts cannot establish car
   access or available public parking. Conversely, a drivable road with foot=no
   cannot currently provide arrival evidence even when the pedestrian trail
   begins safely at its end. If a start is only a pedestrian entrance, lacking
   car evidence must be disclosed rather than automatically counted invalid.

2. **Positive evidence drops restrictive node evidence.** Discovery skips
   nonparking evidence unless its access state is public/unknown. The regression
   `ignores restricted ... evidence on an otherwise unmarked street entrance`
   explicitly retains a start with a same-node `barrier=gate,foot=private`.
   Candidate access then folds incident **way** states, not the node restriction.
   Normalized graph nodes carry empty flags. A restriction on an actual passage
   gate can fail to block both admission and a route crossing it. By contrast,
   `foot=private` on an information object describes that object; it must not
   automatically block the neighboring path. Node role determines whether its
   access tags constrain a crossing or only its metadata.
   [`portals.test.ts`](../../../lib/data/progressive/portals.test.ts),
   [`source-store.ts`](../../../lib/coverage/source-store.ts),
   [`opl.ts`](../../../lib/data/osm/opl.ts)

3. **Unrelated restricted branch can remove a usable entrance.** Candidate
   access is the most restrictive state among all incident ways. A private spur
   sharing a public street/trail entrance can veto the entire start, even when
   the usable departure never traverses that spur. This differs from applying
   restrictions to the selected route or entrance movement.
   [`candidateRecord`](../../../lib/data/progressive/portals.ts)

4. **Exclusive classes erase mixed use.** A residential road with foot=yes is
   reclassified trail, removing road-contact evidence and making it available
   as route/trail context. It does **not** establish a mountain approach:
   production `HIKING_HIGHWAYS` excludes ordinary service/residential and other
   street classes, and mountain qualification follows only `approach_link=1`.
   Default tracks remain trail and do not themselves create `road_nodes`.
   Foot-allowed roads and tracks need overlapping mode capability, not a
   semantic change from road to hike based on permission.
   [`classifyOsmWay`](../../../lib/data/osm/normalize.ts),
   [`runtime.ts`](../../../lib/coverage/runtime.ts),
   [`prune.ts`](../../../lib/coverage/prune.ts)

5. **Evidence-specific admission creates mapping-style misses.** Unmarked
   street contacts are admitted, but unmarked service contacts need a gate or
   trailhead at the exact junction. A mapped trailhead along a hiking link needs
   a track contact within 250 m. Parking needs both road/track and selected hiking
   contacts among its own vertices, and nominates only one hiking contact.
   A genuine entrance connected by a parking aisle/short walking approach, or
   whose polygon does not share boundary nodes with interior paths, can be
   absent. A gate at a service junction can promote the same topology where a
   board cannot. None of these mapping forms alone determines physical validity.
   [`discoverPortalCandidates`](../../../lib/data/progressive/portals.ts)

6. **A mapped contact is not a rooted arrival path.** A local public/unknown
   street fragment can nominate a start without demonstrating vehicle
   reachability from the surrounding road network. A drive-time contour is an
   area test, not proof that a car can drive to each trail coordinate within it.
   Conversely, treating an extraction boundary as a road root would introduce
   a new false-positive mechanism: the boundary is an artificial cut.

7. **Graph direction and area geometry can distort validity.** Generic road or
   track oneway can remove a legal pedestrian return path. The adapter also
   treats a `highway=pedestrian,area=yes` closed way as a linear perimeter,
   rather than establishing walking paths through its area; a perimeter can
   resemble a hike loop. This is a representation issue, not entrance evidence.

## Extraction and independent-source limits

The active [`source-filter.ts`](../../../lib/coverage/source-filter.ts) retains
highway/footway ways, node/way parking, trailhead/information/gate evidence and
building objects. It completes direct parents/references but does not select
hiking-route relations or parking relations as access evidence. The source store
processes relations only as supported building multipolygons. The older
[`pipeline.ts`](../../../lib/data/osm/pipeline.ts) selects `route=hiking,foot`
relations, but its OPL parser reads only nodes and ways. Do not infer relation
membership/support from the legacy filter string.

Supported ways preserve shared node identities. Near lines, overpasses and
geometric crossings without a shared routable node are not connected. Parking
nodes/ways are evidence, not synthetic interior connectors. Other barrier node
kinds and standalone access-only nodes are not retained as evidence; general node
access is not made part of the walking topology. Selected/enclosing context
objects without a vertex inside the extraction can be absent, as the source
filter documents. Exact source coverage guarantees an extract's extent, not
mapped completeness.

OSM parking documentation distinguishes the facility from the service roads and
parking aisles forming a routable network, and documents site relations grouping
parking entrances/spaces. Neither a parking symbol nor a polygon boundary alone
proves an entry route. [OSM parking mapping guidance](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dparking)

Reviewed restrictions are intentionally a small restrictive layer keyed to exact
OSM way IDs. [`curated-access.ts`](../../../lib/data/curated-access.ts) accepts
only closed/prohibited/private, checks pinned bytes, and fails missing, duplicate
or conflicting targets. It cannot grant permission. Way-ID splits and closure
freshness remain review obligations; changing a source hash does not prove a
restriction is still current.

Official entrance adapters retain review facts, but production named-area
`reviewedApproaches` are independent radius-based audits. The audit accepts an
eligible start, a density/terrain exclusion, or a hash-pinned reviewed topology
gap; it does not create an entrance. A nearby unrelated start can satisfy the
radius test, so it is neither an entrance-identity label nor a measured recall
score. The old `reconcileAccess` permission/conflict path is used by the testing
compiler, not production coverage admission. Its behavior must not be described
as production access enforcement.
[`runtime.ts`](../../../lib/coverage/runtime.ts),
[`regions.ts`](../../../lib/coverage/regions.ts),
[`testing/compiler.ts`](../../../lib/data/testing/compiler.ts)

## One principle to evaluate

Use one source-normalized topology with independent pedestrian and motor
capabilities, retaining overlapping uses and node crossing restrictions. Define
physical entry from an actual traversable movement between arrival/approach and
hiking network; names, gates, parking symbols and official anchors describe or
audit that movement rather than each creating a separate admission rule. Keep
mountain/product policy and the user's drawn/drive/named area as subsequent start
filters. None of those boundaries grants permission, establishes a connector or
clips a hike.

This principle still needs an explicit arrival definition. Pedestrian entry,
legal vehicle arrival and legal parking are different questions. A bounded
extract cannot establish global car reachability merely by flooding from its
edge or largest component. If verified vehicle arrival becomes required, roots
need trustworthy source provenance and sufficient approach context; otherwise
report that capability as unknown. Do not introduce a complete second routing
stack merely to make a local foot entrance appear verified.

Maintained engines illustrate the semantic seams, not an adoption mandate:
GraphHopper handles explicit foot direction separately from ordinary oneway and
passes node tags to barrier edges; its shared access parser can block a crossing
from node restrictions/locked state. OSRM's foot profile likewise has a
`process_node` access/barrier path and mode-specific access hierarchy. These
profiles target general walking and their default permission/value policies are
not Alpine Loop's accepted product contract.
[GraphHopper FootAccessParser](https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/routing/util/parsers/FootAccessParser.java),
[GraphHopper AbstractAccessParser](https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/routing/util/parsers/AbstractAccessParser.java),
[OSRM foot profile](https://github.com/Project-OSRM/osrm-backend/blob/master/profiles/foot.lua)

## Minimal offline precision/recall validation

1. **Label the question first.** For each real entrance record independent axes:
   physical pedestrian entry, pedestrian permission (allowed/restricted/
   conditional/unresolved), vehicle arrival, parking, and mountain/product
   eligibility. Record the source, review date, exact location/movement and
   uncertainty. Do not make OSM tags or current output the ground truth. Review
   with official entrance/trail maps, restriction/signage records and a second
   independent reviewer; imagery can establish geometry, not legal permission.

2. **Sample geography independently of candidates.** Choose complete small
   road/trail study windows or road corridors before looking at generated starts.
   Enumerate all entrances in those windows from independent evidence, including
   unmarked entrances. Also label every emitted candidate in the windows. This
   provides a recall denominator and precision numerator without using only
   famous trailheads. An official entrance list alone cannot reveal unmarked
   entrances that the list omits.

3. **Include realistic negatives.** Label nearby disconnected parking, private
   driveways/gates, closed trail entrances, signs at internal junctions, forest
   road contacts far beyond permitted arrival, bridge/overpass near crossings,
   urban paths/plazas, isolated streets and service approaches, as well as valid
   visitor/destination access and dense-but-legitimate entrances. Include
   supported/unsupported parking geometry and foot/car conflicts. Keep
   uncertainty unresolved, rather than silently assigning a convenient label.

4. **Commit only small deterministic evidence.** Store compact topology fixtures
   plus separately maintained labels/provenance. Feed all alternatives the same
   extract/context and labels. No network in tests, no pack/database/raw download
   in Git, and no future data acquisition required by the test run. Fixtures
   based on the counterexamples above test semantics, not measured regional
   accuracy.

5. **Hold out whole regions.** Use development windows across Washington and
   California; reserve at least one complete region from each for final
   evaluation. Freeze the policy before reading those outcomes. This catches
   mapping conventions that differ across regions and prevents tuning a new
   rule for each troublesome entrance. Report per-region results as well as the
   pooled result.

6. **Score without hiding unknowns.** Report physical-entry precision/recall
   with one-to-one matching to the labeled entrance movement, then permission
   and product-filter errors separately. Duplicate nearby outputs do not get
   multiple true positives for one entrance. Report both public-only and
   unknown-inclusive policies, unresolved truth count, known restrictive
   inclusions, unmapped positives and source-representation gaps. Do not count
   unresolved entries as either proved legal or definitely wrong. The accepted
   unknown-inclusive default remains an explicit uncertainty tradeoff.

Compare the current baseline with the proposed coherent method on the same
frozen labels. Adoption needs fewer independently labeled false positives and
false negatives across holdouts, or an explicit documented tradeoff—not a better
looking map, a larger start count, proximity to anchors or more passing synthetic
fixtures. No such comparative dataset was evaluated in this review.
