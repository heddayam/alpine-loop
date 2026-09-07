# Regional pack consolidation

Completed 2026-09-06 on `codex/system-design`, relative to `dff1b43`.
Implementation commits: `42d8d88` through `44aff4e`.

All five installed regions now use one preparation and audited publication
process. Region modules describe their pinned inputs, optional official trail
sources, entrance acquisition, and regional acceptance checks. The shared
builder owns ordering, graph preparation, build identity, reports, and
publication. See [region onboarding](region-onboarding-checklist.md) for the
extension procedure.

## Behavior and tradeoffs

- Regional restrictions, Monterey's reviewed entrance validation, East Bay's
  three required corridors, source attribution, compiler versions, and pack
  identities are preserved. Restrictions still precede entrance labels;
  official entrance evidence cannot reopen closed access.
- Existing schema-6 packs and saved results remain usable. Santa Cruz retains
  its older fingerprint format so consolidation does not rename its artifacts.
- Future builds share `portal-audit.json` report schema `2`. Consumers of the
  old region-specific build reports must adopt that shape. The application
  does not consume those reports; the runtime pack schema is unchanged.
- The entrance report distinguishes evidence assigned to a portal from portals
  actually changed. Already represented evidence now counts as matched.
- Every region must produce portals inside coverage. This adds an explicit
  empty-portal rejection for Santa Cruz before publication.
- A shared-builder regression can affect every region. Frozen comparisons
  cover all five definitions in both pinned and refresh modes, while common
  publication behavior is tested through the real compiler and SQLite writer.
- New regions with the same sources need configuration and reviewed data.
  A different source format still needs an adapter. The interface deliberately
  has two limited callbacks (entrance acquisition and regional acceptance),
  rather than a configurable sequence that could reorder safety checks.

## Size and optimization evidence

Tracked physical application lines decreased from 20,245 to 19,464; test/helper
lines decreased from 9,669 to 9,338: **1,112 fewer code lines** combined.
These counts cover `.ts`, `.tsx`, `.mjs`, `.css`, and `.py` under `app`,
`components`, `lib`, `scripts`, `tests`, and `tools`. The new frozen JSON fixture
adds 166 data lines outside that code count. This consolidation does not claim
a 50% reduction across the repository.

Entrance assignments are reported during the actual overlay, eliminating an
extra overlay for every entrance. The comparison used the previous overlay,
three warmups, and nine alternating measurements per fixture; resulting
topologies were deeply equal.

| Nodes | Portals | Entrances | Previous median | Shared report median |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1,000 | 10 | 9.88 ms | 1.04 ms |
| 100,000 | 2,000 | 10 | 120.74 ms | 12.49 ms |
| 100,000 | 2,000 | 100 | 975.48 ms | 9.69 ms |

The largest case replaces 101 overlay calls with one, about 100× faster for
that stage. These are local synthetic benchmarks, not whole-build speedups.
The builder also reads search-region input once and counts trail classes in one
pass. No dependency was added.

## Verification

- Two successful `npm run verify` runs: 403 offline tests across 77 files,
  lint, type checking, and production build. Local logs:
  `/private/tmp/alpine-pack-consolidation-verify2.log` and `verify3.log`.
- Two successful `npm run test:browser` runs: all six flows each time. Local
  logs: `/private/tmp/alpine-pack-consolidation-browser2.log` and `browser3.log`.
- Ten frozen pre-change comparisons verify exact prepared graph/seed hashes,
  build identities, compiler inputs, and access records. External acquisition
  is substituted with fixtures; committed regional evidence is used.
- The shared builder's production-storage test compiles, audits, publishes,
  reuses pinned identity, and preserves the previous artifact on rejection.
- Read-only persisted audits of all five installed packs returned zero errors:
  `scm-e6f8b8c410c74f30`, `seb-29a37bc9d90b7ed4`, `mc-de372db242288cff`,
  `hc-fb46538de42e5919`, and `cc-f1cb28a4ceb6e896`. Existing warnings concern
  disconnected components and rejected source edges. Full local results are
  in `/private/tmp/alpine-pack-consolidation-installed-audits.log`.
- Live in-app browser checks at desktop and 390 × 844 verified saved results,
  route-start alignment after zoom/pan, and internal mobile results scrolling
  (297 px while document scroll remained zero). No browser errors were logged.
- Installed packs were audited, not rebuilt from remote sources. Compatibility
  evidence combines frozen preparation inputs with real fixture publication;
  it does not assert a byte comparison of newly rebuilt regional databases.
- Temporary implementation worktrees and branches were removed.

## Design references

Two upstream examples informed the separation of configuration from ordered
execution: [GraphHopper's import and routing configuration](https://github.com/graphhopper/graphhopper/blob/master/config-example.yml)
and [Valhalla's staged tile builder](https://github.com/valhalla/valhalla/blob/master/src/mjolnir/valhalla_build_tiles.cc).
These are design references; no source code or dependencies were imported.
