# Access proposal: validation preflight

Reviewed 2026-09-30. This challenges [the proposal](../access-point-review.md),
not its public API or implementation. No app changes, test reruns, packs,
downloads or live databases were used. Existing fixtures/tests were inspected.

## First release: isolate detector behavior from product policy

Keep the accepted **fewer than ten buildings within 500 m** and **25-mile hiking
connection** rules for the first release. Density removal is a separate future
product choice, not an approved detector fix. The [implementation plan](../implementation-plan.md)
and [threshold tests](../../../lib/data/wilderness.test.ts) establish today's
scope. A dense legitimate entrance can be physically valid yet intentionally
outside it; it is not a detector false negative merely because it is excluded.

Compare old and proposed detectors with identical topology, policy, access
profiles and labels. That isolates behavior changed by the detector. A later
counterfactual density comparison should use the same detector and report its
intentional scope additions separately; if interactions matter, show all four
detector/policy combinations rather than crediting their pooled change to the
detector. This is an inference about experimental control, consistent with
[NIST's distinction between comparative and multifactor objectives](https://www.itl.nist.gov/div898/handbook/pri/section3/pri33.htm).
It also keeps changed admissions, preparation receipts and regressions attributable.

The coherent entry model is promising, but neither fewer rules nor a semantic
counterexample proves simultaneous lower false positives and false negatives.
Known-only ingress may shrink when ordinary-road permission lacks explicit tags;
that is a profile-definition change to examine, not automatically a completeness
failure. Generalization to fifteen areas remains unmeasured.

## Four different things to prove

| Claim | Required evidence | What cannot establish it |
| --- | --- | --- |
| Detector accuracy | Independent physical-entry and passage labels; paired output review | More starts, a pleasing map, OSM tags repeated as truth |
| Mapping completeness | Independently enumerated entrances, compared to source-supported movements | A node-complete extract, provider extent or a source hash |
| Product fit | Explicit density/mountain policy and separate exclusions | Physical validity alone; changing the label definition after seeing outputs |
| Invariance | Controlled transformations preserving the relevant movement/input meaning | Aggregate precision/recall or changing real access while expecting stability |

The [source audit](source-audit.md) already identifies mode, node and relation
limits. Keep known restrictions distinct from absent tags. Unresolved conditional
permission is not proved legal and is not necessarily permanently forbidden;
without a journey context, do not claim date-specific access. Supporting parking
or hiking relations must include extraction, member semantics and negative
fixtures, not just a normalization flag. Unhandled relation geometry remains a
source-representation gap. A correct isolated road can expose a root-assumption
error; isolation alone does not prove OSM is wrong.

## What current evidence can and cannot prove

[Portal tests](../../../lib/data/progressive/portals.test.ts) reduce Top Lake and
Heather Lake from pinned WA OSM data and mutate them for synthetic regressions.
They establish current source interpretations and invariants, not independent
legal/physical truth. Heather has road/track and hiking contacts on different
parking vertices with no mapped interior path. The proposed no-inferred-connector
rule needs an explicit expected outcome: retain only an independently supported
trip-start witness, or disclose the missing approach. Do not silently call a lost
real entrance an accuracy gain. Source-way splitting tests already help, but are
bounded by the old 250 m/evidence-specific algorithm.

[The five-way WA fixture](../../../data/fixtures/source/osm/coverage-regressions.md)
proves import/coverage regressions, not complete entrance recall. The tiny
[official-access fixture](../../../data/fixtures/source/official-access.json)
is synthetic. Catalog conservation fixtures preserve earlier boundaries/anchors,
not independently labeled movements. [Reviewed-approach tests](../../../lib/coverage/runtime.test.ts)
accept proximity, policy exclusions or a pinned missing-topology declaration;
these outcomes cannot certify the nearby start's identity or permission.

[Native extraction tests](../../../lib/coverage/source-filter.test.ts) skip when
Osmium is unavailable. Future verification must report executed/skipped tests,
not imply full extraction coverage from a passing command. Passing old suites
also cannot validate changed semantics such as passage gates, mixed-use roles,
all parking exits, conditional access or explicit membership.

## Label identity before counting duplicates

Ground truth must name the physical ingress/departure movement **and** any
independently usable trip-start place, with evidence date and allowed location
aliases. Define this before generating/evaluating outputs. A polygon's center,
a broad official radius or matching name is insufficient identity evidence.

Distinct real source-node starts along the same arrival approach are not
necessarily duplicate false positives: a tagged trip-start place and the actual
transition can both be usable; separate parking exits can have different access
and onward routes. An entrance family groups onward choices without deleting
starts. Conversely, two OSM markers may represent one physical place. Review
those identities independently rather than letting proximity or source IDs decide.

Use one-to-one matching for independently defined entry/place units, but report
movement correctness, start-location fidelity, availability of each true entry
and redundant representations separately. Several allowed location aliases for
one entry do not create several recall successes; redundancy alone is not proof
of an invalid start. Exact repeated output for one source node remains a technical
duplicate. Fix these rules before comparison so matcher choice cannot manufacture
an improvement or penalize legitimate alternate starts.

## Minimum evidence for the first wave

- Freeze a short decision table for local pedestrian entry, mode hierarchy,
  node role and unresolved values; retain current product policy. General roads
  are local source roots, not verified car/parking claims. Do not add global car
  routing, live authority checks, snapping or new regional root lists.
- Add independent expected semantic cases for a passage-private gate versus a
  private information object, unused private branch, car-private/foot-public and
  car-public/foot-no arrival, unknown along a used/unused witness, generic road
  oneway, area perimeter, unmarked service entry and Heather-style parking gaps.
- Verify restrictions survive extraction, publication, compaction and final
  traversal, including an interior barrier. Admission-only correctness is
  insufficient. Preserve freezing, unknown-toggle behavior and deterministic
  cancellation/reuse. Report every changed baseline expectation with its reason.
- Prove invariance under way splitting/order/renaming and irrelevant evidence;
  bound support-expansion invariance to identical complete entry context. Added
  approach evidence can legitimately reveal a previously absent entry. Moving
  a passage gate, changing permission or moving the actual start is not invariant.
- Keep membership/owner migration, shared selection and map styling as later
  focused waves unless required to preserve the movement restriction end to end.
  Run the [runbook](../agent-runbook.md) gate when implementing; synthetic proof
  alone does not replace required rebuilt-data audit when the prepared contract changes.

## Independent evaluation and stop conditions

Choose small complete study windows independently of generated candidates in WA
and CA, including rural forest roads, service/parking approaches and urban-edge
mountain access. Seek independent official/signage/field evidence and a second
reviewer; imagery supports geometry, not legal access. Trace whether an agency
layer and OSM share source geometry before calling them independent. If evidence
cannot enumerate a window sufficiently, report recall as unassessable there.
Do not use famous entrances alone or invent labels for unresolved negatives.

Freeze labels, identity/matching rules and policy before reserving whole-region
holdouts in both states. Avoid tuning on those outcomes; this applies the same
principle as [held-out evaluation guidance](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage)
to rule selection, without proposing a learned model. State which mapping forms
and regions are represented; two states or one holdout per state do not certify
all regions. Publish per-region paired counts and denominators for both profiles,
uncertainty and independently adjudicated regressions, not only a pooled score.

Stop promotion on a new known restrictive passage inclusion, an invented
connector/root, an unexplained loss of a resolved in-policy entrance, incorrect
node-role propagation, an invariance failure or a lifecycle regression. Do not
claim regional accuracy while independent labels/denominators are unavailable;
semantic implementation may proceed with that limitation explicit. Attribute
remaining errors to source omission/staleness, extraction/representation,
normalization/passage/root assumption, candidate emission, policy exclusion,
selection/ownership or matching/label uncertainty. A documented tradeoff must
identify affected cases; it cannot be a blanket exception for worse holdouts.
