# Access points: one entry model for the whole application

Review and recommendation, 2026-09-30. Baseline: `9fff8d7`.
This covers extraction, preparation, publication, installation, map presentation,
geographic filtering, Full enumeration, and route feasibility across all regions.
It recommends a replacement design; it does not change application behavior or
claim measured precision/recall improvements.

## Recommendation

Use **one source topology with mode-specific passage rules**, prepare real
entrances from that topology once, and use **one start selector** everywhere.
An entrance is a source-supported place where someone can enter the hiking
network from an arrival/approach location. Its usable movement matters more than
its tag, name, nearby buildings, or position inside an outline.

Keep four questions explicit:

1. Is this a connected pedestrian entrance, and what passage is permitted?
2. What do we actually know about vehicle arrival and parking?
3. Does the entrance belong to the offered/selected hiking region?
4. Can this installed graph support a route under this request?

Those questions can use one prepared record and one selector. They should not
collapse into a confidence score or a single public/unknown/private value whose
meaning changes between preparation, map, and search.

The recommended product change is to remove the building-count veto from access
validity. Keep mountains as destination geography and connected regional
membership. Retain buildings as descriptive surroundings if useful. A genuine
mountain entrance beside a village or visitor facility should survive; a retail
parking lot with no hiking entry should fail through topology. This deliberately
revises the current wilderness-start requirement, rather than quietly changing
its numeric cutoff. It remains a proposal until implemented and evaluated.
This also admits dense, mountain-associated starts whose generated loops head
away from the core. Those are acceptable under this recommendation: a mountain
association selects a destination's starts, while users' actual route constraints
decide route suitability. Do not compensate by clipping routes to mountain
polygons or silently adding a must-visit-core constraint.

## What the application currently does

The detailed independent reviews are [topology and permission](access-review/topology-audit.md),
[geography and map](access-review/geography-audit.md), and
[source semantics and evaluation](access-review/source-audit.md).

| Stage | Current decision | Main weakness |
| --- | --- | --- |
| Extraction | Local highway/access/building context; selected evidence types; reference completion | Some barrier/access nodes and parking relations have no usable semantics; spatial extraction is not a completeness certificate. |
| Normalization | Exclusive trail/street/service/sidewalk class; one pedestrian access state | A foot-allowed road can lose its road identity; vehicle permissions and node crossing restrictions are not represented independently. |
| Nomination | Street contact; evidence at service contact; trailhead within 250 m of track; one parking contact | Different source mapping forms receive different admission rules despite equivalent entry topology. |
| Candidate permission | Worst access state of every incident trail way | A private branch can veto a public departure, while a foot-private gate can be ignored. |
| Product relevance | Fewer than ten mapped buildings within 500 m; hiking connection within 25 miles to a GMBA core | Surroundings and destination suitability are treated as entrance validity; source omissions and thresholds lose legitimate entrances. |
| Preparation/publication | Freeze starts, add outside-start neighborhoods and support, prune, measure, compact | Freezing is sound; encoding membership mainly through polygons makes later inference ambiguous. |
| Installed overlap | Stable owner selected by geometry plus graph-node existence | Node existence does not prove that owner admitted the entrance. |
| Named filtering | Expanded start polygon plus another 500 m runtime tolerance | Nearby starts from another installed region can satisfy the selected region without membership. |
| Map | Viewport starts, building check, inclusive cycle check, client unknown toggle | Active drawn/named/driving predicates are not applied to generic dots. |
| Full/jobs | Installed departure, area/access/building checks and inclusive cycle hint; pinned job enumeration | Search and map mean different things by eligible; the inclusive hint can retain starts with no known-only cycle. |

These are code-supported mechanisms, not measured frequencies. Some intentional
exclusions are product choices, some are implementation defects, and some are
missing source facts. Counting all three as one error obscures what to change.

## One topology, one entrance proof

Normalize source facts into independent properties: physical way function,
pedestrian passage, motor passage, direction per mode, node crossing restrictions,
and actual mapped trip-start/place observations. A forest track can support both
hiking and driving. `foot=yes` grants foot passage; it does not change a street
into a trail. Ordinary roads remain unable to establish mountain association.

Use a versioned, source-semantic role table, rather than hiding existing name
heuristics inside the word hiking:

| Source function | Role in the entry proof |
| --- | --- |
| Ordinary general-purpose road | Local arrival root; its walking and motor permissions stay independent. Limited-access road nodes are not automatic roadside transfer places. |
| Service/access road or parking aisle | Approach link when connected to an arrival root/place; class alone is not an arrival root. |
| Explicit sidewalk/crossing/access link | Pedestrian approach context, never a hiking seed or generated hike by itself. |
| Path, bridleway, steps, track, non-sidewalk footway/pedestrian way | Hiking/walking role, subject to passage rules; ambiguous walking links still cannot seed mountain association. |
| Track with supported motor passage | Both hiking and motor approach roles. Public/unknown permissions and their evidence remain distinct. |
| Other way with explicit hiking-use source evidence | Its hiking role needs semantic evidence such as supported hiking-route membership, not its name or foot permission alone. |
| Connected explicit trailhead | A source assertion of a trip-start place, subject to usable departure and passage validation. |
| Parking polygon, sign, or interior gate | Observation/place extent or crossing rule; it supplies no imaginary interior path and is not an automatic trip-start root. |

Represent pedestrian areas as areas/observations until supported walking
connections exist. Never compile their perimeter into a hiking cycle merely
because the source is a closed highway way. Preserve supported place/route
relations at normalization when they carry these roles; malformed or unsupported
geometry remains a disclosed source limitation.

The finite witness rule is:

1. Begin at a mapped ordinary arrival-road contact or an explicit connected
   trip-start/arrival place. This establishes a local source assertion, not
   global vehicle connectivity. Never begin at an artificial extraction cut.
2. Reach the proposed entry through actual approach-role links under the
   witness's ingress mode, observing direction and node restrictions. Walking
   through hiking-only links cannot spread arrival status into the interior.
   Mixed-use tracks remain traversable in their motor-approach role, so an
   unmarked path farther along a genuinely accessible forest road can qualify.
3. Emit only a source trip-start assertion, an approach-to-hiking role change,
   or a supported motor-to-foot transition. Merely visiting a node or a junction
   of two continuing mixed-use tracks emits nothing. A mode transition needs
   an arrival-side witness and an actual restriction/role difference, not just
   a generic gate symbol.
4. Require at least one allowed/explicitly unknown hiking departure, including
   the real node crossing and its first segment. Keep ingress mode and every
   unresolved passage fact with the decision. A motor-permitted, foot-forbidden
   access road can support car arrival followed by a permitted foot departure;
   its foot prohibition does not erase its motor role.

Known/inclusive eligibility evaluates passage on the entire chosen witness,
not just its departure edge. An unrelated uncertain parking facility or unused
vehicle approach does not make an otherwise known pedestrian witness uncertain.
Keep arrival uncertainty separate from the hiking route's passage uncertainty.

This is one graph reachability/transition calculation per profile, not a walk
from every evidence point with separate gate/trailhead/parking radii. The ordinary
road root is a stated local-access assumption; isolated or stale roads remain
source errors to score, not proof of globally verified arrival. A disputed
motor capability remains disputed instead of promoting an internal track to
verified arrival. Explicit source assertions also need independent review.

The compiler evaluates a usable **ingress/departure pair** or a mapped approach
path at a real source node. Restrictions apply to the movements used by that
witness. All restricted alternatives remain restricted, but an unused private
spur does not invalidate a public entrance. A restrictive passage gate affects
every witness that crosses it. Information-board access describes the board and
does not automatically restrict its neighboring path.

Candidate locations come from actual interfaces between access/approach ways
and hiking ways, together with explicitly mapped trip-start places. Evaluate
all through the same connected-entry proof:

- Use ordinary road contacts, service approaches, parking aisles, and local
  pedestrian access links as source facts. A service approach needs the same
  pedestrian-entry proof as a street approach; it does not need a same-node sign.
- A road/road intersection is not a hiking entry merely because walking is
  permitted on both roads. Hiking function and passage capability are separate.
- A gate is a passage point. It becomes a start when it actually defines the
  entry/arrival transition, such as a motor barrier on a walkable track. An
  interior gate or sign does not create another entrance by itself.
- An unmarked road-to-trail transition remains a valid candidate. A separately
  mapped trailhead can remain the actual start when its approach is connected
  and source-supported. Keep its approach and coordinates; do not transplant
  its name or permission onto a nearby junction.
- Retain every independently usable parking exit. Require actual mapped access
  links, shared contacts or mapped pedestrian paths; a polygon's boundary is not
  a hiking loop and its two contacts do not justify an invented walking connector
  across it.
- Trace actual topology across source-way splits. Do not use nearest-neighbor
  snapping, entrance clustering, per-evidence distance exceptions, or a road
  name regular expression to establish an entry.

Arrival facts need a precise claim. The smallest useful contract establishes
**local pedestrian entry from a mapped arrival/approach location**. It does not
promise a legal parking space or globally verified passenger-car reachability.
Keep known vehicle restrictions and parking evidence separate. A car-restricted,
foot-permitted approach can be a walk-in entrance; its marker must not imply
that a car can reach the hiking node.

Where local source context proves a motor connection, reuse the same topology
for that fact. Do not flood from an extract edge or largest component to label
all internal roads car-accessible. Artificial boundary cuts are not arrival
roots. A full car-routing stack, extra authority adapters, and per-region road
root lists are unnecessary for the pedestrian-entry contract. If the product
later requires verified car arrival, that is a stronger, separately testable
claim requiring complete approach evidence.

Missing passage tags remain access-unknown, included by default and explicitly
disableable. Missing geometry is a source gap, not access-unknown: there is no
permission setting that can supply a nonexistent connector. Preserve unsupported
conditional restrictions as unresolved conditions; a known restriction must not
disappear into generic unknown. Do not claim date-specific permission without
evaluating its condition. Interpret pedestrian direction according to the source
class and explicit foot tags; ordinary vehicle oneway must not restrict walking.

## Region membership and boundaries

Keep the GMBA cores as named destination geography. Build **explicit entrance
membership** from the frozen, connected starts admitted to each region. The
current bounded hiking connection can remain the regional association rule;
its 25-mile value is a named product policy and must be independent of the
route-support budget. It is not a statement that an entrance outside the bound
is physically invalid or that every resulting route enters the core.

Named selection is membership in the prepared entrance set, including actual
approaches outside the core. Drawn selection is exact entrance-coordinate
containment. Driving selection is the requested outer contour minus its inner
contour, optionally intersected with named membership. Drawing continues to
override the other choices. Contours select starts; they do not prove individual
car access or clip hiking geometry.

This removes both named-region proximity inference and registration circles as
admission mechanisms. Circles can remain compatibility/display geometry while
membership migrates, then be replaced with clear core outlines and real entrance
markers. Neither a park border nor a hiking line crossing a download boundary
creates an entrance. Broadening a region cannot repair missing source topology.

Choose an overlapping graph owner only among artifacts that actually admitted
the entrance under the installation's policy. Order those candidates by stable
region ID and graph identity, then pin the owner before checking route feasibility.
Selected region IDs filter membership but do not reorder owners. Never choose an
owner according to whether a solver happens to find a route. Apply regional
membership independently of owner choice. Retain deterministic one-graph ownership for the whole solve;
never join overlapping graphs or combine their topology hints to invent a route.

## Preparation, runtime, and map share one meaning

The module's external interface needs two operations: prepare entrance decisions
from pinned topology/policy, and select starts from those decisions plus a pinned
request. Its implementation owns movement proofs, provenance, region membership,
profile hints, ownership, and decision reasons. Callers should not reconstruct
those facts from coordinates, names, or confidence levels.

Conceptually:

```text
pinned source topology + passage policy
                  |
        prepared entrance decisions
          /                   \
 region memberships      one owning graph + route support
          \                   /
         shared request start selector
              /              \
   eligible map layer      Full enumeration -> saved job
```

Preserve early freezing, complete per-start support before elevation, immutable
artifacts, and metric reuse. Evaluate fixed product relevance once during
preparation. Runtime selects against the recorded policy and request, rather than
reapplying a potentially different current density threshold to an old pack.
Changing policy invalidates affected preparation receipts; unchanged physical
measurements remain reusable. Older artifacts and saved results retain their
recorded meanings through an explicit migration.

Node/movement restrictions also survive graph publication, corridor compaction,
known/inclusive topology hints, map edge exposure, and final solver validation.
Admission-only enforcement would still allow a route through a restrictive
interior gate. Preserve crossing nodes or an equivalent exact movement encoding;
do not turn one blocked branch movement into a blanket veto on its junction.

Migration rule: new searches under the new selector require every contributing
artifact to declare the compatible entrance/membership policy. Do not combine
old geometric membership and new explicit membership in one new job. Areas
needing rebuild are explicitly unavailable for those searches until rebuilt;
existing artifacts and saved geometry are retained. Existing jobs keep their
pinned selector version and owner mapping, and resume with their original
semantics while the corresponding implementation and data remain supported.
Preserve partial/saved results if resumption is unavailable; never re-enumerate
them under the new policy. Legacy compatibility is a bounded migration concern,
not an alternative admission system for new data.

Use one selector for eligible map highlighting, counts, Full enumeration, and
explicit-start validation. The viewport only limits rendering/data fetching;
panning cannot change the eligible set. Contextual entrances outside the active
filter may be shown with different styling and clear meaning. While driving
geometry is unresolved or failed, do not display a broadened eligible set.

Cycle feasibility uses the requested known/inclusive profile. A public entrance
whose only loop crosses unknown links is not a known-only viable start. Keep
legacy missing hints conservative. A feasibility hint is a safe exclusion bound,
not proof of a simple loop/lollipop satisfying requested distance, elevation,
grade, direction and repetition; the solver owns that proof. No-route outcomes
and computation limits remain visible. Return exact and close matches separately.

Show destination/core geography, the active start filter, actual entrance markers,
and downloaded routing support with distinct labels. Start coverage and the
hard route boundary are different geometries. Every route remains inside its
own graph and exact installed routing coverage, even when it leaves a drawn,
named or driving area. Alternate-entrance grouping remains presentation only;
it never drops starts or changes their coordinates, movement or criteria.

Jobs pin entrance decisions, installation, profile, criteria and resolved area.
Opening saved work uses that snapshot. Form edits and current map state do not
redefine an existing job's eligible count or results. Full continues to attempt
every selected start and retain up to ten exact routes, or one labeled close
match where no exact route was found.

## Why this method is simpler

The current design repeatedly infers entry from a feature type and membership
from geometry. The replacement prepares the entry fact once and selects it.
OSM's mode/barrier semantics remain real implementation complexity, but they
concentrate in one module used by all callers.

| Alternative | Reason to reject as the general method |
| --- | --- |
| Curated/agency trailhead catalog | Misses unmarked entrances, depends on regional availability/licensing, and still needs topology validation. Useful independent review evidence. |
| More gate/parking/region exceptions | Makes eligibility depend on evidence kind or region and hides which actual movement was established. |
| Distance snapping or spatial entrance clustering | Can cross fences, rivers, parallel roads and disconnected trails; can remove valid starts. |
| More terrain/population/land-owner layers | Adds sources without establishing pedestrian entry or permission. Core geography already serves destination scope. |
| A learned validity score | Adds labels, tuning and regional drift; a score cannot create missing topology or resolve known restrictions. |
| A pure car-network frontier | Useful for verified motor arrivals, but loses mixed-use track starts and walk-in entrances unless place and movement semantics are retained; local clips cannot establish global car reachability. |

No optimality or accuracy theorem is claimed. This is the smallest coherent
design supported by the identified failure mechanisms; its error tradeoffs need
independent comparative measurement.

## Acceptance across regions

First label complete small study windows independently of generated candidates
in both Washington and California. Record physical entry, foot permission,
arrival/parking facts, and regional relevance separately, with exact movement,
evidence date and unresolved facts. Include every emitted candidate and all
independently identified entrances in each window, so recall has a denominator.
Famous/reviewed trailheads alone are insufficient. Reserve whole-region holdouts
and freeze the policy before evaluating them.

Mandatory cases span the whole lifecycle: unmarked road entries, mixed-use tracks,
service approaches, pedestrian-private barriers, car-private/foot-public gates,
unrelated private spurs, interior signs, multiple parking exits, disconnected
parking, crossings without shared nodes, pedestrian plazas, dense legitimate
entrances, sparse urban/farm contacts, GMBA foothills, unsupported relations and
conditions, boundary starts/holes, neighboring-region starts, overlapping owners,
unknown-only cycles, and saved-job restoration after policy/data changes.

Run baseline and proposal on identical pinned inputs. Report physical-entry
precision/recall, restricted inclusions, membership errors, arrival-claim errors,
product exclusions, duplicate outputs, unresolved truth, and source gaps
separately, for both access profiles and each region. Use one-to-one entrance
matching; proximity to a famous point is not identity. Do not optimize total
start count or a pooled score that hides a region's regression.

Require fewer resolved false positives and false negatives across holdouts, or
an explicitly documented tradeoff. Semantic metamorphic tests must also show
that splitting a source way, renaming a road, changing evidence placement while
preserving its actual approach, expanding support, or panning the map does not
arbitrarily change entry validity/membership. Adding an equivalent overlapping
artifact must not suppress a real entrance merely because it contains its node.
New installations can legitimately change owner/route feasibility when support,
source or policy changes; existing jobs retain their pinned installation/owner.
Moving a gate or changing its access genuinely can change the movement and must
not be asserted invariant. Keep automated inputs committed and network-free.

Implementation should replace nomination/permission first behind an integrator-owned
compatibility seam, then explicit membership/ownership and the shared selector,
then map presentation. Every wave deletes superseded rules. Run the runbook's
full verification before implementation acceptance and audit rebuilt real data
when the prepared contract changes. No regional build is started by this review.

Review evidence: the independent audits reran current offline suites totaling
79 topology/normalization/filter cases and 62 geography/reader/search cases
(including overlapping coverage of the eligibility suite). These establish
baseline behavior, not improved accuracy. The source review verified primary
documentation and maintained implementations. Documentation diff/link checks
complete this review; a labeled cross-region comparison remains future work.

## Primary sources and assumptions

- [OSM access hierarchy](https://wiki.openstreetmap.org/wiki/Key:access): passage
  permissions differ by mode and purpose. Their presence does not certify source
  completeness or current legal conditions.
- [OSM barrier mapping](https://wiki.openstreetmap.org/wiki/Key:barrier#How_to_map_barrier_nodes)
  and [gate semantics](https://wiki.openstreetmap.org/wiki/Tag:barrier=gate): a
  passage restriction belongs to its actual crossing; gates commonly sit beside
  a road/path junction. Gate existence is not permission.
- [OSM trailhead](https://wiki.openstreetmap.org/wiki/Tag:highway=trailhead),
  [track](https://wiki.openstreetmap.org/wiki/Tag:highway=track), and
  [parking](https://wiki.openstreetmap.org/wiki/Tag:amenity=parking): trip-start
  places, mixed-use land-access roads and parking facilities describe different
  source facts; none supplies an arbitrary missing walking connector.
- [OSM pedestrian direction](https://wiki.openstreetmap.org/wiki/Key:oneway#Interpretation_for_routing):
  generic oneway interpretation varies by way function; explicit foot direction
  is unambiguous. Preserve unresolved source ambiguity.
- [GraphHopper foot access](https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/routing/util/parsers/FootAccessParser.java),
  [barrier access](https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/routing/util/parsers/AbstractAccessParser.java),
  and [OSRM foot profile](https://github.com/Project-OSRM/osrm-backend/blob/master/profiles/foot.lua)
  demonstrate established mode/node semantics. Reuse those principles, not their
  generic-walking defaults or a second routing system.
