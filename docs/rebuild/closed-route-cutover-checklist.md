# Gate 5 schema migration and cutover checklist

This checklist makes the coordinated V3/schema-3 activation in
`closed-route-topology-plan.md` explicit. Gate 4 remains the active product
until every pre-cutover item is checked with committed evidence.

## Build and migration order

- [ ] Keep V1/V2 contracts and schema-1/schema-2 readers operational while the
  schema-3 compiler and repository are developed.
- [ ] Build physical-edge identities and deterministic integer node, directed
  edge, and physical-edge keys from stable sorted source IDs.
- [ ] Build the `known` and `inclusive` topology profiles independently from
  their legal directed graphs.
- [ ] Write schema-3 core graph rows, topology rows, reconstruction mappings,
  profile hashes, and migration record into staging SQLite.
- [ ] Validate every original directed edge mapping, topology count, content
  hash, access attachment, coverage boundary, and source attribution.
- [ ] Reopen the staged pack through `ClosedRouteTopologyRepository`, run the
  committed fixture suite, deterministic rebuild comparison, corruption tests,
  five-start benchmark, and 60-second oracle comparison.
- [ ] Publish the validated schema-3 data version without moving the installed
  pack pointer; retain the schema-2 current pointer for rollback.

## Coordinated feature cutover

- [ ] V3 API composition uses only the shared V3 request/response schemas,
  server-owned Quick/Thorough budgets, topology repository, and primitive
  catalog.
- [ ] Builder sends `version: 3`, `routeFamily: "closed"`, repetition/stem,
  multi-cycle, effort, access-filter, metric, access-policy, and count fields.
- [ ] Results and map consume V3 routes without V2 shape, finish, or
  start/end-filter fields and render derived topology facts.
- [ ] QA, scenario, and Playwright callers use V3 and cover Draw, Named region,
  and Drive time filters.
- [ ] Endpoint rejects V1 and V2 only after every active caller is V3.
- [ ] Move `current.json` to the audited schema-3 pack atomically; verify cache
  invalidation by data version and retain the prior pack for manual rollback.
- [ ] Remove dormant V2-only UI/server composition after the V3 browser path
  passes; preserve history rather than hidden runtime branches.

## Release evidence

- [ ] Wave 1 falsification checkpoint passes or the documented unified-lane
  fallback is selected before UI/API cutover.
- [ ] All quantitative thresholds in the Gate 5 plan are recorded, including
  pack size/build cost, cold/warm topology load, exact-hit rate, first-exact
  time, validity, group coverage, and directed rejection rate.
- [ ] `npm run verify` and `npm run test:browser` pass twice, followed by the
  clean-clone and generated-data/secret/branch/worktree audits.
- [ ] `docs/rebuild/status.md` records commit IDs, schema-3 data version, audit
  counts, benchmark tables, remaining gaps, and rollback information.
