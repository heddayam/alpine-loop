# Access topology and permission audit

Reviewed at `9fff8d739cc908c569c5baf10ed2054946f48a70`, 2026-09-30. This is a
source/code review, not a measured precision/recall result. No source acquisition,
regional build, publication, installation or local-pack/database inspection was
performed. Application behavior and contracts are unchanged.

## Active admission predicate

The production named-area path is `lib/coverage/runtime.ts`, not the fixture
compiler in `lib/data/testing/compiler.ts`.

1. **Normalize ways and evidence.** Paths, bridleways, steps, walking tracks,
   footways and pedestrian ways become `trail`. Explicit sidewalk/crossing
   subtags become `sidewalk`. A service/residential/unclassified/living-street
   way can also become `trail` because it has affirmative foot access or a
   trail/path/walk name (`lib/data/osm/normalize.ts:37–55`). Foot access resolves
   from `foot ?? access`; vehicle-specific tags do not enter this access state
   (`lib/data/osm/normalize.ts:68–73`). Production normalization uses these same
   functions (`lib/coverage/source-store.ts:33–40`).
2. **Build eligible local links.** Retain public/unknown `trail` segments wholly
   inside the initial routing envelope. The mountain-approach flag separately
   requires path/track/bridleway/steps/footway/pedestrian source highway tags;
   ambiguous `possible-walking-link` segments cannot seed the mountain core
   (`lib/coverage/runtime.ts:44`, `174–182`). Roads remain nomination context.
3. **Nominate a mapped node inside discovery scope** through one of four paths
   (`lib/data/progressive/portals.ts:173–227`):

   | Nomination | Exact current requirement |
   | --- | --- |
   | Unmarked street contact | A nonrestricted `street` way and a selected trail segment share the node. The selected segment need not be a non-track hiking link (`177–178`, `199–203`). |
   | Service-road contact | Same-node selected trail contact plus allowed node trailhead/gate evidence; information alone does not suffice (`189–203`). |
   | Marked track approach | Allowed node trailhead evidence lies on selected non-track hiking topology within 250 m of an allowed track contact. Undirected bounded Dijkstra may traverse branches and source-way splits (`88–122`, `196–197`). Gates do not use this path. |
   | Parking contact | An allowed parking feature has its own shared road/track vertex and its own selected non-track hiking vertex. Nominate one hiking vertex by shortest straight-line distance to any road/track vertex, then node ID (`205–226`). No walking connector across the lot is generated. |

   Evidence must belong to the same mapped node and external node ID; unrelated
   nearby signs/names/confidence do not transfer (`189–195`). Discovery scope is
   the initial routing envelope intersected with the product start limit, where
   one exists (`lib/coverage/runtime.ts:195–197`). It is broader than the core.
4. **Reject restricted/dense candidates.** Candidate access is the most
   restrictive state across *all incident trail ways*, including ways not
   selected for routing: closed, prohibited, private, unknown, public in that
   order. Evidence access is not included in this aggregation
   (`lib/data/progressive/portals.ts:229–241`). Freeze only public/unknown starts
   with fewer than ten building centroids within 500 m (`63–73`, `293–301`;
   `lib/data/wilderness.ts:20–32`).
5. **Qualify mountain connection.** Retain starts at undirected graph distance
   at most 25 miles from an unambiguous hiking segment touching the selected
   GMBA core. Only approach links participate; direction is ignored here, but
   it is enforced in real route search (`lib/coverage/runtime.ts:203`;
   `lib/coverage/prune.ts:19`, `67–83`, `93–109`). A track can seed this pass,
   although parking/marked-approach nomination requires non-track hiking contact.
6. **Freeze and publish.** Outside-core admitted nodes add 500 m registration
   neighborhoods and routing envelopes; this extension never nominates more
   starts (`lib/coverage/runtime.ts:205–223`; `lib/coverage/plan.ts:51–88`).
   Frozen records survive to final ranking, provided their node remains in the
   selected graph (`lib/data/progressive/portals.ts:349–367`). Published graphs
   contain selected `trail` edges, not context-only roads/evidence
   (`lib/data/progressive/publish.ts:14–29`, `120–135`).
7. **Apply runtime eligibility.** Area predicates, requested public/unknown
   access, the same building threshold, and inclusive closed-cycle reachability
   gate map/search starts (`lib/solver/eligible-access-points.ts:114–122`).
   Restrictive access states are never allowed (`lib/graph/policy.ts:3–8`).
   Named predicates alone permit a 500 m approach band; drawn/driving filters
   remain exact (`lib/solver/eligible-access-points.ts:20–26`, `43–54`). These
   start filters do not clip route geometry.

## Mechanisms producing errors

These are mechanisms evidenced by code/tests; their prevalence is unmeasured.

| Mechanism | Consequence and evidence |
| --- | --- |
| Same-node service gate | **False negatives from normal mapping.** Gates 7.69–70.30 m along connected hiking paths are deliberately excluded in the recorded Stanford/Vargas cases (`docs/rebuild/status.md:17–33`). OSM's [barrier mapping instructions](https://wiki.openstreetmap.org/wiki/Key:barrier#How_to_map_barrier_nodes) place gates near the path/road junction and discourage placing them on the highway junction itself. The source convention conflicts with the admission requirement. |
| Unequal marked approaches | A trailhead may find a track through a branched 250 m path, but the same geometry with a gate cannot find a service-road approach. This is explicitly exercised by `lib/data/progressive/portals.test.ts:167–215` and `263–273`; changing evidence kind can change eligibility despite identical physical topology. |
| Node passage restrictions treated as optional evidence | **Potential false positives.** The street path admits a node even with `barrier=gate,foot=private`; the test explicitly expects one unmarked start (`lib/data/progressive/portals.test.ts:276–279`). Restrictive evidence is filtered out, and normalized graph nodes carry no passage restriction (`lib/coverage/source-store.ts:36–40`). OSM [gate documentation](https://wiki.openstreetmap.org/wiki/Tag:barrier=gate) and [access documentation](https://wiki.openstreetmap.org/wiki/Key:access) describe foot access on barriers as permission for passage. A private information board is different: its access may describe the board, so the other rows of that parameterized test do not prove the same traversal problem. |
| Arrival permission equals foot permission | **Potential false positives for car-reachable starts.** `motorcar=private/no` and `motor_vehicle=private/no` do not restrict road nominations when `foot/access` remains unknown/public. `access=private,foot=yes` makes a road public in the single foot state, although cars can still be restricted (`lib/data/osm/normalize.ts:32–34`, `68–73`; `lib/data/progressive/portals.ts:177–178`). [OSM access hierarchy](https://wiki.openstreetmap.org/wiki/Key:access) distinguishes transport modes, and [motor_vehicle](https://wiki.openstreetmap.org/wiki/Key:motor_vehicle) applies to both roads and barriers. This does not make the hiking trail private; it means the arrival location may need to be outside the vehicle restriction. |
| Road contact without an arrival path | **Potential false positives.** `road_nodes` accepts any local nonrestricted street/service road, without testing connection to an externally accessible road network or intervening vehicle barriers (`lib/data/progressive/portals.ts:176–178`). A remote internal road segment can supply the same evidence as an arrival road. |
| Road-to-road transition disguised as trail | **Potential false positives and false negatives.** An affirmative `foot=yes` or name promotes an ordinary service/residential road to `trail`; its intersection with another street can nominate a start. Conversely, promoting the access road removes its `street/service-road` identity and can remove nomination evidence. Street-to-track contacts also nominate automatically, even if both roads remain driveable. Mountain qualification can reject some cases, but an attached eligible path can let them survive (`lib/data/osm/normalize.ts:37–55`; `lib/data/progressive/portals.ts:159–160`, `199–203`; `lib/coverage/runtime.ts:174–182`). |
| Restrictive unrelated branch poisons the node | **Potential false negatives.** A public entrance sharing a node with a private branch becomes private even if its selected hiking continuation is public (`lib/data/progressive/portals.ts:230–237`). This is deliberately conservative, but it conflates a node's usable ingress/egress with every incident way's permission. |
| Parking membership lacks mapped contacts | **False negatives / honest source gaps.** A real parking lot can be unconnected in OSM. June Lake and Blue Lake recorded cases have no shared parking membership contacts; Blue Lake also lacks a trail/access-road junction (`docs/rebuild/status.md:41–47`). Shared topology policy cannot recover these facts without another source or an invented connection. Conversely, two contacts on a parking polygon do not prove a traversable pedestrian path between them. Current policy assumes an entrance at the hiking contact, without publishing such a path (`lib/data/progressive/portals.ts:205–226`). |
| One parking nomination | Other genuine parking exits receive no parking-backed start unless nominated independently (`lib/data/progressive/portals.ts:222–226`; test `lib/data/progressive/portals.test.ts:282–288`). Nearest Euclidean contact is a deterministic choice, not proof of the most usable entrance. |
| Sparse/incomplete context | **Both error directions remain possible.** Fewer than ten buildings measures mapped centroids, not access legitimacy; zero is allowed. Building and access features with no extract-interior nodes may be absent, and unsupported building relations are disclosed (`lib/coverage/runtime.ts:248–253`; `docs/rebuild/network-design.md:150–155`). GMBA foothill omissions and disconnected hiking topology can reject real starts; registration buffers cannot repair either source problem. |

## A single frontier principle to evaluate

Review input, not an adopted API/schema redesign: classify passage once for each
mode, then derive entrances where the reachable arrival network meets the hiking
network. Names, signs, trailhead tags and parking labels annotate actual topology;
they do not substitute for arrival/hiking connection. Node barriers participate
in the same permission model as ways. The supported source and explicit review
remain authoritative; proximity and a region outline cannot create passage.

Stress tests for that principle:

- **Tracks overlap both networks.** `track` cannot be an exclusive synonym for
  hiking or driving. A car-permitted forest track may serve arrival and hiking;
  an internal track/track or street/track junction is not automatically a
  change of mode. An actual hike-only branch or a vehicle passage boundary is.
- **Foot and car restrictions differ.** `motorcar=no,foot=yes` terminates car
  reachability while preserving hiking. `foot=no/private` blocks pedestrian
  passage at the affected way/node. A private adjacent branch does not revoke
  an unrelated public continuation. `access=private,foot=yes` is not a public
  car approach, and a locked motor gate does not necessarily prohibit walking.
- **Roots need evidence.** Local roads do not prove public arrival merely by
  existing. Do not root arrival reachability at artificial pack/discovery
  boundary cuts: moving a preparation boundary would then create or remove
  starts. The root/default-access policy needs explicit source-supported
  semantics and retained uncertainty.
- **Unknown stays epistemic.** Including unknown foot access is an accepted
  product default; it does not prove car access or barrier passage. Discarding
  all unknown arrival facts increases false negatives; treating them all as
  verified increases false positives. A single model can retain both outcomes
  and provenance without pretending the data has resolved them.
- **Off-junction gates are normal.** Source-way splits must not change a
  frontier. Physical approach topology can associate an actual entrance with
  its ingress without another gate-distance exception. Arbitrary interior gates,
  branches and multiple road contacts must not become new arrival points merely
  because an evidence node exists.
- **Parking is an arrival place, not a connector license.** Actual shared
  road/hiking contacts and mapped local walking connections can use the same
  reachability model. Unconnected parking cannot be repaired by choosing a
  nearby trail node. Review anchors should continue disclosing the missing fact.
- **Area policy stays downstream.** Mountain connection, density, and user area
  selection qualify/filter starts after topology nomination. They cannot prove
  legal or practical access, and broadening a polygon cannot fix a missing link.

## Active versus historical behavior; verification

`lib/data/progressive/portal-policy.ts:2–4` names
`mapped-gate-approaches-v1` and defines distance/hop constants, but the reviewed
`portals.ts` does not consume them. The name participates in build identity
(`lib/coverage/runtime.ts:43`); it does not establish that gate-approach behavior
is implemented. The first incomplete status gate still requests a policy choice
(`docs/rebuild/status.md:27–37`).

`reconcileAccess` can resolve conflicting official restrictions to unknown and
grant public access, but its callers are in `lib/data/testing/compiler.ts` only;
it is not the active named-area admission path. Production exact-way curated
restrictions remain restrictive-only, source-pinned, and conflict-rejecting
(`lib/data/curated-access.ts:114–167`; `lib/coverage/runtime.ts:171–174`). Historical
radius-clustered portals, permissive authority overlays, and old broad-area
terrain/population systems are not active alternatives.

Offline verification: using the root dependency installation through a temporary
ignored `node_modules` symlink, removed immediately afterward:

```text
node node_modules/vitest/vitest.mjs run lib/data/osm/normalize.test.ts lib/data/progressive/portals.test.ts lib/solver/eligible-access-points.test.ts
3 files passed; 79/79 tests passed.
git diff --check
```

The suites verify current semantics, including the restrictive gate test; passing
them does not certify those semantics as the recommended policy. No quantitative
false-positive/false-negative rate or large-region feasibility claim follows.
