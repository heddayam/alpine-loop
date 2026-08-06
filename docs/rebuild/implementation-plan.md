# Alpine Search implementation plan

## Product outcome

Alpine Search generates closed hiking routes from a local, bounded trail graph.
It is not a catalog of known hikes. The first installed pack covers the Santa
Cruz Mountains; regional behavior comes from versioned packs rather than UI or
solver branches.

The active route builder has two modes:

1. **Explore** — draw a boundary and automatically run a short foreground search
   after the boundary or criteria settle. The boundary filters eligible access
   points; it never clips route geometry.
2. **Batch search** — choose an origin, typical drive time, and one reviewed
   pack-provided search region. Launch a persistent background job that attempts
   every eligible trailhead under the snapshotted route/access criteria.

Generated routes start and finish at one trailhead and contain a physical-trail
cycle. Simple loop, lollipop, figure-eight, chained-loops, and complex-closed are
result labels. Exact matches and explicitly labeled near misses remain separate.

## User experience

- The top bar shows the installed pack, Settings, panel controls, and a Jobs
  button with active-job state.
- The left panel switches between Explore and Batch search and owns closed-route
  constraints and physical ranges.
- Settings controls access-point remoteness, uncertain access, and the number of
  Quick Explore results. Mode determines effort; there is no effort selector.
- The map shows pack coverage, active filter geometry, eligible access points,
  and only the currently loaded result page.
- The results panel compares exact routes first, then near misses, with topology,
  metrics, warnings, source confidence, and elevation profiles.
- The Jobs modal lists queued, resolving, running, completed, cancelled, failed,
  and deleting jobs. Users can cancel, retain/view partial results, and delete
  records. Opening a completed/cancelled job restores its contour and paginated
  routes to the map workspace.

Explore debounces valid changes by 600 ms, aborts stale requests, and always uses
the Quick server budget. Batch mode has no explicit-start control. It retains up
to ten diverse exact routes per trailhead, or the single best labeled near miss
when that trailhead has no exact result.

## Active contracts and storage

`POST /api/routes/generate` accepts the V3 closed-route request described in
`closed-route-topology-plan.md`. Schema-3 and schema-4 packs may serve foreground
generation.

Schema 4 adds a reviewed `search_regions` catalog referencing named-area
geometry. The Santa Cruz pack initially exposes the whole pack plus Big Basin,
Castle Rock, Henry Cowell, Forest of Nisene Marks, Bear Creek Redwoods, Sierra
Azul, and Rancho San Antonio. Raw cities, counties, small parks, and closed-area
variants are not batch choices.

Batch jobs use the versioned `CreateBatchRouteJobV1` contract and these APIs:

- `POST/GET /api/route-jobs` — enqueue and list jobs;
- `GET/DELETE /api/route-jobs/:id` — inspect or delete;
- `POST /api/route-jobs/:id/cancel` — cooperative cancellation;
- `GET /api/route-jobs/:id/results` — stable exact-first cursor pagination;
- `GET /api/packs/:packId/search-regions` — reviewed region discovery.

Jobs persist in ignored `.local-data/runtime/route-jobs.sqlite`. The database
stores the immutable request/origin snapshot, resolved contour, pinned pack data
version, per-trailhead checkpoints, results, and diagnostics until deletion.
One FIFO worker runs at a time. Interrupted jobs resume at the first unfinished
trailhead and reopen their pinned pack version. Pack upgrades mark old jobs stale
without invalidating stored result geometry.

Batch completeness means every eligible trailhead was attempted. It does not
claim enumeration of every possible closed walk. Per-trailhead truncation and
failures remain visible in job diagnostics.

## Technical boundaries and invariants

- Next.js App Router, React, TypeScript, MapLibre, Zod, and local SQLite.
- Pack/runtime code remains region-independent; reviewed region lists are pack
  inputs and participate in data-version hashing.
- Runtime never calls public OSM/Overpass or a remote elevation service.
- Drive-time service areas use ArcGIS typical/static time, not live traffic.
- Exact pack coverage is the only hard route-geometry boundary.
- Unknown access is included by default and can be explicitly disabled.
- Remote/rural/populated/unknown settings control map visibility, previews,
  explicit Explore starts, and automatic solver starts.
- Automated tests use committed fixtures and never require network access.
- Generated packs, runtime databases, source downloads, caches, and secrets stay
  out of Git.

## Acceptance

- Explore auto-search is debounced, cancellable, deterministic, accessible, and
  suppresses stale responses.
- Batch launch validates origin, drive time, reviewed region, and all snapshotted
  criteria before enqueueing.
- Persistent jobs recover across server restarts; cancellation retains partial
  results; deletion cascades through checkpoints and routes.
- Every eligible batch trailhead is attempted once, with at most ten exact routes
  or one otherwise-empty near miss retained.
- Pagination, stale pack labeling, map restoration, responsive layout, keyboard
  focus, and screen-reader progress announcements pass browser coverage.
- A real schema-4 Santa Cruz pack rebuild/audit and the complete verify/browser
  suites pass before the gate is recorded complete.
