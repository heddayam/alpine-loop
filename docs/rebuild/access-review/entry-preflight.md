# Entry-witness preimplementation review

Reviewed 2026-09-30 at `8185478a7df8ba683b8bdb6f1436d717fa3a595b`.
Scope: the finite witness in [access-point-review](../access-point-review.md),
active source/portal code and committed fixtures. No application changes,
downloads, real packs, publication or live databases were used.

## Verdict

The proposal gives a coherent place to enforce source passage rules. The reviewed
draft needs three corrections before implementation: physical approach roles must
not depend on car certainty; explicit trailhead tags must not bypass missing or
restricted mapped approaches; and gate identity must be distinguished from the
actual road/trail frontier. These affect candidate identities and both access
profiles, not merely UI labels. The pedestrian-first resolutions below are the
smallest defensible scope; they are recommendations, not changed app behavior.

The proof establishes a movement under pinned source facts and assumptions.
It cannot establish missing geometry, global car access, legal parking, current
conditional permission or independently verified physical truth. Calling a
candidate unknown cannot manufacture the missing part of its witness.

## Proven current defects versus deliberate policy

- **Node barrier restriction is lost.** `foot=private` gate evidence is ignored
  on an otherwise unmarked street entry; the fixture expects an eligible start
  (`lib/data/progressive/portals.test.ts:276–279`). Production graph nodes have
  empty flags (`lib/coverage/source-store.ts:36`), and node retention recognizes
  buildings or the small evidence taxonomy (`184`; `lib/data/osm/normalize.ts:59–65`).
  [OSM barrier semantics](https://wiki.openstreetmap.org/wiki/Key:barrier#How_to_map_barrier_nodes)
  make this a passage issue. A private information board is not equivalent.
- **Direction interpretation can invent or remove movement.** Generic vehicle
  `oneway=yes` is inherited for residential walking, while both
  `foot:forward=no` and `foot:backward=no` still produce `forward`
  (`lib/data/osm/normalize.ts:76–81`). Direct offline probes reproduced both.
  The latter admits an explicitly forbidden direction, regardless of entry policy.
- **Way function is conflated with permission.** Service/residential ways become
  `trail` for affirmative foot access or a name (`lib/data/osm/normalize.ts:37–55`;
  fixture `lib/coverage/source-store.test.ts:52–60`). Preserve source function
  separately; do not silently delete currently supported road-walking geometry
  merely while correcting its arrival role. Route inclusion and mountain seeding
  are separate decisions.
- **Private incident way veto is a deliberate conservative rule.** Candidate
  state aggregates every incident trail way (`lib/data/progressive/portals.ts:230–237`;
  fixture `lib/data/progressive/portals.test.ts:432–440`). It can reject a usable
  public movement, but the positive correction is to prove that movement, never
  to route through the private alternative.
- **Same-node service evidence, one parking nomination, building density and
  the 25-mile mountain bound are current policy.** Their removal is not an
  established correctness fix merely because candidate count grows. Preserve
  density in the first release; evaluate its proposed removal independently.

## Witness decisions still requiring precise acceptance

1. **Unknown car access must not become the hiking-access toggle.** The proposal
   checks the entire ingress witness (`../access-point-review.md:113–116`) and
   propagates mixed tracks only in motor approach mode (`97–101`). A public-foot
   trail reached through a car-unknown track can therefore disappear when unknown
   hiking access is disabled. Recording car uncertainty after nomination does
   not repair a motor-certainty veto performed during nomination. Recommend the
   pedestrian method: derive a track's dual hiking/land-access role from physical
   source function, evaluate the used foot passage, and retain motor facts as
   separate observations. Car uncertainty/restriction alone cannot veto a proven
   pedestrian entry. Hiking-only paths cannot spread generic arrival status to
   every internal trail junction.
2. **Explicit root assertions are weaker than connected ingress proof.** Top Lake
   has an actual trailhead 20.8 m along its path. Current fixtures reject it when
   its track approach is prohibited or detached (`lib/data/progressive/portals.test.ts:110–151`).
   Making that trailhead a root based only on hiking departure accepts those same
   cases without proving arrival. Require an actual connected mapped approach
   for an explicit trailhead, with foot passage checked through its real node.
   Its tag preserves the asserted trip-start identity; it does not override a
   restriction on the sole supported approach or imply an alternative connector.
   Distinguish absent approach evidence from explicitly forbidden approach.
3. **Parking strictness has an existing counterexample.** Heather Lake's fixture
   has a track contact and a different hiking contact on one parking polygon,
   but no connecting walking line (`lib/data/progressive/portals.test.ts:19–26`).
   Current policy accepts its hiking vertex without adding an edge (`127–132`).
   Requiring an interior walking line rejects or leaves it unresolved. A narrower
   alternative preserves the parking area's explicit local-place assertion at
   its actual hiking contact; it creates no graph edge across the lot. Label that
   assumption, apply the place's foot restrictions and avoid car/parking claims.
   Neither representation proves independent physical truth; adjudicate both.
4. **Entrance identity and gate identity are not interchangeable.** A gate along
   an already hiking-only path is not a new mode frontier. The generic service
   approach proof can emit the road/path junction instead. The pending Stanford/
   Vargas gate-retention criterion names the actual gate as start
   (`../status.md:44–60`), whereas the proposal may legitimately choose another
   source node. Recommend emitting the actual service/path frontier and keeping
   an already hiking-only gate as a crossing restriction, not a generic trip start.
   Neither copy gate metadata to that node nor call the identity unchanged.
   Junction+explicit-trailhead still needs exact source-event identity; proximity
   clustering cannot decide whether there are one or two entrances.
5. **Node movement restrictions need a faithful routing interpretation.** A
   private way branch can remain blocked independently. A restrictive barrier
   mapped on a shared junction does not identify a favored unrestricted turn
   merely through geometric bearings. Preserve the actual source crossing and
   disclose unsupported ambiguity. Starting at a barrier must not bypass its
   restriction. Current compaction preserves nonempty node flags, but current
   normalized nodes lose those facts (`lib/data/compact-prepared-graph.ts:40–42`).
6. **Local root existence is an assumption, not complete arrival proof.** An
   ordinary road segment can be isolated, stale or extracted without its approach.
   Root it only by the declared source role, never by an artificial boundary cut.
   Do not describe any resulting motor fact as verified global car reachability.

## Smallest defensible first scope

First implement an offline, auditable reference witness evaluator on committed
raw-source fixtures behind an integrator-owned seam. It must retain source roles,
per-mode direction/access and node passage facts, emit the used movement and exact
source identity, and explain every baseline difference. Fix the six decisions
above before changed admission reaches a published pack. Do not run old and new
admission rules as permissive fallbacks in one new artifact.

The first behavior release should keep density, mountain membership, geographic
filters and one-graph ownership policy unchanged. Replace nomination and passage
handling together. Passage restrictions must survive publication, compaction,
topology hints and solver validation before this is a safety correction; an
admission-only barrier fix still leaves forbidden interior crossings routable.
No public API redesign is required by this review. Membership/map unification
and the density product revision remain subsequent explicit work.

Required acceptance cases:

| Case | Required decision/evidence |
| --- | --- |
| Public ingress/departure plus private spur | Keep the start; reject every route using the spur. |
| Foot-private gate, including a start on its node | No prohibited crossing in admission, hints or final routes. |
| Foot-public/car-unknown and foot-public/car-private | Preserve a proven pedestrian entry; no car/parking guarantee. Explain any missing approach witness separately. |
| Motor-public/foot-private access road into public trail | No pedestrian ingress proof on that road; a motor-transfer claim is a separate later scope. |
| Mixed track approach, interior path exit, track–track junction | Preserve supported exits; no automatic start from merely visiting an internal junction. |
| Split/reversed ways; foot-direction overrides; both foot directions forbidden | Identical physical permissions after equivalent splits; forbidden movement stays absent. |
| Top Lake restricted/detached approach and Heather Lake separate lot contacts | Explicitly adjudicated source-assertion/passage policy; no invented connector or silent loss. |
| Gate off junction; explicit trailhead off junction; two parking exits | Exact start identities and count justified by source events, not nearby-name matching. |
| Boundary cuts, isolated road, unsupported relation/condition | No boundary-created root, invented geometry or silently erased known restriction. |

Verification: four existing offline suites passed, **101/101** tests
(`osm/normalize`, `progressive/portals`, `coverage/source-store`,
`compact-prepared-graph`). A temporary root-dependency symlink was removed.
Direct normalization probes confirmed the direction outputs above.
`git diff --check` passed. These reproduce baseline behavior; they do not
measure the proposal's regional accuracy or establish its adoption.
