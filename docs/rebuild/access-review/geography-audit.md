# Geography and map access-point audit

Reviewed commit: `9fff8d739cc908c569c5baf10ed2054946f48a70` (2026-09-30).
This is review input, not a change to the accepted product policy, API or pack
contract. No real pack, installation, source download or live database was used.

The strongest simplification is to make the prepared entrance set authoritative
for access identity and named-area membership. Mountain association and sparse
surroundings remain explicit product relevance rules. Geometry should select
those entrances and bound route support, rather than repeatedly infer membership
from proximity. The current compiler already freezes entrances correctly; most
remaining geographic complexity comes from encoding that set as a core plus
circles and then adding a second runtime proximity allowance.

## What determines a start today

| Stage | Active rule and exact evidence | Meaning |
| --- | --- | --- |
| Core | Selected GMBA Standard Basic leaves intersect the product cap and recipe support: `lib/coverage/regions.ts:66-87`. | A mountain destination proxy, not entrance or legal-access evidence. |
| Nomination scope | Washington uses the shared scope. California's per-region caps are unioned with historical reviewed-anchor neighborhoods; both intersect recipe support: `lib/coverage/regions.ts:72-84`; `data/coverage/regions/README.md:44-67`. | Which real source entrances may be considered; an anchor does not create one. |
| Initial support | The core receives a conservative 25-mile rectangular routing envelope: `lib/coverage/plan.ts:17-29,91-108`. | Supplies graph/context for discovery. It is not the final start polygon. |
| Candidate relevance | Original entrance nominations are filtered by access and fewer than ten mapped buildings within 500 m: `lib/data/progressive/portals.ts:252-305`; `lib/data/wilderness.ts:20-32`. | Sparse surroundings are a product preference, not proof that an entrance is valid. |
| Mountain association | A retained public/unknown hiking link touching the core seeds an undirected hiking/possible-footway distance pass. Ordinary road links cannot establish the association: `lib/coverage/runtime.ts:174-182,201-208`; `lib/coverage/prune.ts:19,67-83,93-109`. | A connection to the chosen mountain destination, not a requirement that every generated route visit it. |
| Registration | Only already admitted outside entrances receive 500 m, 32-vertex spherical neighborhoods: `lib/coverage/plan.ts:51-88`. The final named region is this enlarged start geometry: `lib/coverage/runtime.ts:87-88,210`. | A visible start-coverage footprint derived from a discrete entrance set. |
| Final support | Add a route envelope around each outside entrance neighborhood, import only additional support, then prune before elevation: `lib/coverage/runtime.ts:210-235`. | Supporting trails cannot nominate new starts. |
| Runtime | Read only a local owner, require an installed traversable departure, filter actual coordinates by request geometry/access/buildings, and exclude inclusive no-cycle starts: `lib/graph/prepared-repository.ts:127-142,145-196`; `lib/solver/eligible-access-points.ts:93-122`. | Separates compiled membership from each request's eligibility, with the named-region exception below. |

The 25-mile admission radius is currently coupled to the route-support budget:
`PREPARATION_BUFFER_MILES = 40 * 1.25 / 2` at
`lib/contracts/routes.ts:4-6`; the compiler passes twice that distance at
`lib/coverage/runtime.ts:203`, and Dijkstra divides by two at
`lib/coverage/prune.ts:77`. This produces the documented 25 miles, with numerical
tolerance. It also means changing the route exploration bound would silently
change the mountain-association policy unless those meanings are separated.

Core-touching segments seed both endpoints at zero distance
(`lib/coverage/prune.ts:67-75`). Therefore the bound measures distance to a
mapped hiking **link** touching the core, not exact distance to the portion of
that link inside the core. This matches the current written link-based rule. A
long source segment can make its outside endpoint qualify even when the core
itself is farther away; that is a relevance limitation, not fabricated topology.

## Frozen starts are a useful invariant

Discovery runs once against the intersection of initial support and product
nomination scope (`lib/coverage/runtime.ts:194-197`). `sparse_portal_candidates`
retains complete original nominations. Mountain rejection removes candidates
from both membership tables (`lib/coverage/prune.ts:99-108`). Final ranking reads
the frozen records instead of rediscovering entrances
(`lib/data/progressive/portals.ts:349-367`). Final publication removes any start
outside the final start geometry (`lib/coverage/runtime.ts:268-272`).

This avoids recursive growth: a newly loaded support-area trailhead cannot enlarge
the area again. The existing fixture at `lib/coverage/runtime.test.ts:193-209`
explicitly retains a route heading away from the core while excluding a newly
loaded support-area entrance. Keep this behavior. An interior boundary should
never produce a synthetic trailhead where a hiking line crosses it.

## The named-region proximity policy is duplicated

An actual outside entrance is already registered in the named polygon with a
500 m neighborhood (`lib/coverage/plan.ts:77-80`;
`lib/coverage/runtime.ts:87-88`). Search then accepts any portal with a
`trailComponentId` up to another 500 m from that polygon
(`lib/solver/eligible-access-points.ts:20-54`). The predicate only tests that a
component ID exists; it does not test a connection to this selected region.
The associated SQL bounding boxes are also expanded
(`lib/solver/eligible-access-points.ts:93-103`;
`lib/server/search-area.ts:16-21`).

There are strong guards: `lib/graph/prepared-repository.ts:173` requires the
candidate's local owner, and `:179-188` requires its actual coordinate and a
traversable departure inside exact installed **routing** geometry. The second
band therefore cannot resurrect an unpublished entrance or invent a buffer-only
start. It can still admit a start already published by another installed area.

For example, a real area-B entrance nominally 750 m from an isolated area-A
registered entrance lies outside A's 500 m registration circle but within the
extra runtime allowance. B supplies its own valid start geometry and graph, so
the owner and installed-coverage guards do not establish membership in A. On
the outer side of such a circle the nominal combined reach approaches 1 km
from A's anchor. This is a theoretical geometric bound, not a measured regional
error rate; the registration polygon is inscribed and the runtime distance uses
a local metric approximation. The same proximity allowance can cross a named
hole or reach a disconnected nearby component. Drawn and driving predicates
remain exact because only the named predicate receives the exception
(`lib/server/search.ts:15-22`; regression
`lib/solver/eligible-access-points.test.ts:117-146`).

Even without the second allowance, a geometric registration neighborhood can
contain a B entrance that A never admitted. Explicit compiled region membership
would resolve that ambiguity more directly than shrinking or tuning circles.

## Overlap ownership can obscure entrance membership

Local graphs deliberately remain independent. Runtime orders artifacts by
stable `regionId` before pathname (`lib/graph/prepared-repository.ts:63-67`) and
selects the first whose start geometry contains the coordinate and whose
**nodes** table contains the node (`:127-130`). The same owner supplies candidate
profile hints and route topology (`:173-196,276-280`), which prevents unsafe graph
mixing and is covered by `lib/graph/prepared-repository.test.ts:402-445`.

Selection is independent of the user's selected named regions. A code-derived
edge case remains: if earlier area A has an ordinary graph node within its start
geometry but did not admit that node as an entrance, B's genuine access record
at that node is suppressed because A wins `#startArtifact` and B fails `:173`.
Node presence is weaker than prepared entrance membership. This is conditional,
not an observed regional defect. A similar overlapping case can select A's
no-cycle hint even when B admitted a useful start with different local support.
Any future ownership refinement should choose among artifacts that actually
admitted the entrance, while continuing to use one artifact for the entire solve.
It should not merge trails or hints across artifacts.

## Buildings and cores trade false positives for false negatives

The density check is implemented consistently: SQLite first bounds candidates,
then counts exact centroid distances (`lib/data/progressive/portals.ts:63-73`);
runtime and map reuse the same `< 10` predicate. That is good implementation
consistency, but it does not validate the product assumption.

- A genuine mountain entrance near a ranger campus, cabins, visitor facilities
  or a compact village can have ten mapped buildings and be permanently rejected
  before mountain association. Buildings are not restricted to residences, and
  all have equal weight. The known 9-versus-10 cutoff is covered at
  `lib/coverage/runtime.test.ts:130-147`; it does not measure recall of useful
  entrances.
- One large development can count as few buildings, while numerous small sheds
  count as many. Counting centroids also makes footprint representation near the
  500 m boundary consequential: `lib/data/osm/buildings.ts:22-47` uses a mean of
  vertices, not building footprint distance or residential occupancy.
- Missing mapped buildings or unsupported building relations can undercount
  surroundings. The compiler discloses unsupported relations and node-based
  extraction limits at `lib/coverage/runtime.ts:248-253`; the extractor records
  the enclosing-polygon/no-inside-vertex limitation at
  `lib/coverage/source-filter.ts:66-81`. A locally valid zero remains permitted.
  Do not interpret it as evidence that the ground is empty.
- GMBA's omitted low-relief terrain and absent/disconnected source trail links
  exclude useful starts even with excellent entrance evidence. Conversely a
  sparse lowland entrance connected to a core can generate a nearby route that
  heads away from the mountains; current policy explicitly permits this
  (`lib/coverage/runtime.ts:252`; `lib/coverage/runtime.test.ts:193-209`).

Those are different decision errors: incorrect entrance identity, unsuitable
product relevance, and incorrect selected-area membership. A second population
raster, agency membership test or regional proximity exception would not resolve
their different meanings. Retain the accepted requirements during implementation
unless the integrator deliberately revises the product policy; do not quietly
remove density or core association under the label of a bug fix.

## Installed start coverage differs from the hard route boundary

The catalog exposes `installation.geometry` as coverage
(`lib/server/search-area.ts:55-59`), which is the union of section **start**
geometries (`lib/coverage-install/index.ts:55-67`). For local areas,
`routingGeometry` independently unions installed artifact routing extents
(`lib/coverage-install/index.ts:41-53`). Both the map and solver use that routing
geometry (`lib/server/map.ts:28-31`; `lib/server/search.ts:20-22`).

Thus the map's "Installed coverage" outline is currently start coverage, while
visible trails and valid generated routes can extend beyond it. The behavior is
intentional and tested at `lib/server/search.test.ts:66-86`; the label conflates
two meanings. Every route edge still undergoes full segment containment in
installed routing coverage (`lib/graph/prepared-repository.ts:309-312`;
`lib/graph/geometry.ts:161-183`), including holes rather than endpoint-only checks.
Independent local graphs are never joined. Preserve these hard-boundary checks.

## Map and search share base checks, not active-area eligibility

The map API receives viewport bounds and reads candidate starts with unknown
access included, then filters density and inclusive cycle reachability
(`lib/server/map.ts:19-39`). The UI filters unknown access for its current setting
(`components/map/HikeMap.tsx:967-972`). Search additionally applies all resolved
area predicates (`lib/solver/eligible-access-points.ts:114-119`). Updating the
active map polygons only changes overlay source data
(`components/map/HikeMap.tsx:960-965`); it does not filter native entrance dots.

Consequently a dot outside a drawn box or driving band remains displayed despite
being excluded from that search. This may be useful context, but it must not be
called the current set of eligible starts. Also, inclusive cycle reachability
proves only feasibility with unknown links allowed; both map and enumeration can
retain a public entrance whose only cycle is unknown even when unknown is off
(`lib/solver/eligible-access-points.ts:28-40`;
`lib/graph/prepared-repository.ts:190-191`). The solver can subsequently find no
route. These are UI/feasibility distinctions, not reasons to add geographic
exceptions.

## Coherent simplification to stress-test

1. Preserve real mapped entrance nodes and restrictive access. Keep one frozen
   prepared entrance set, with explicit admission to named regions; a nearby
   point, boundary crossing or review anchor must never create membership.
2. Evaluate accepted sparse-surroundings and mountain-association requirements
   once during preparation and preserve their separate reasons. Treat them as
   product relevance rather than proof of physical or legal validity. Keep the
   numerical 25-mile relevance rule stable independently of support budgeting.
3. Select named areas from the compiled membership set. Select drawn and driving
   areas by exact entrance-coordinate containment, combining driving and named
   selection only as the request specifies. This removes the need for repeated
   named-polygon proximity inference; registration circles can remain display
   geometry during compatibility migration without deciding membership.
4. Give map highlighting/counts and Full enumeration the same eligibility
   predicate and access profile. Keep any other viewport dots visibly contextual.
   Let mountain-core outlines explain destination geography and actual entrance
   markers explain starts; label routing coverage separately from start coverage.
5. Continue preparing complete per-start support before elevation, freeze
   nominations before extensions, pin one deterministic admitted owner per start,
   and constrain routes only by its graph and exact installed routing coverage.

This direction does not require another source system to establish entrance
identity. It does require explicit compatibility decisions for old artifacts
and a representative, independently reviewed set of real entrances before
claiming improved precision or recall. Fixture success cannot establish either.

The next focused regressions should cover an already-published neighbor 750 m
from a registered outside entrance, a portal inside another region's registration
circle but absent from that region's entrance table, a selected B entrance
shadowed by A's ordinary node, a named hole/disconnected component, unknown-only
cycle feasibility with unknown disabled, and identical map/enumeration IDs for
drawn and driving-band filters. Preserve existing regressions for support-only
starts, outside-core routes, exact coverage holes and stable one-graph ownership.

## Verification of this review

- Read the implementation plan, runbook, data-source policy and cited committed
  compiler, geometry, reader, map, search and fixture code at the reviewed base.
- `git diff --check` passes for this documentation-only change.
- Existing committed-fixture tests pass 62/62 across
  `lib/solver/eligible-access-points.test.ts`,
  `lib/graph/prepared-repository.test.ts`, `lib/server/search.test.ts`,
  `lib/coverage/plan.test.ts` and `lib/coverage/prune.test.ts`. Command:
  `npm test -- lib/solver/eligible-access-points.test.ts lib/graph/prepared-repository.test.ts lib/server/search.test.ts lib/coverage/plan.test.ts lib/coverage/prune.test.ts`.
  The first run passed 50 cases but sandboxed macOS process identity blocked the
  server suite before its application assertions; rerunning only
  `npm test -- lib/server/search.test.ts` outside that restriction passed its
  12 cases. No network access or real source/pack processing was involved.
- No implementation or new automated test was added. These existing fixtures
  verify the cited invariants; the proposed adversarial membership/ownership
  cases remain untested conditional mechanisms. The temporary ignored
  `node_modules` symlink used for verification was removed.
