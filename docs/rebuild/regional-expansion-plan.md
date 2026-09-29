# Coverage restoration and Washington expansion

The target is **Washington-wide hiking coverage plus the Bay Area and nearby
California coverage previously available**. Central Cascades now incorporates
the Glacier Peak and Henry M. Jackson pilot footprints and all reviewed approaches. This roadmap
replaces the former pack-registry, bootstrap and schema-6 activation instructions.
The current architecture and commands are in [prepared coverage](prepared-coverage.md)
and [README](../../README.md#developer-data-builds).

## Current availability and restoration baseline

`data/coverage/regions/catalog.json` defines sixteen named build selections:
twelve Washington groups and the four historical California areas. The
pilot entries and production polygons are removed. Independent baseline fixtures
retain their coverage obligations; a Central Cascades rebuild retires the old
download entries only after successful preparation. New or consolidated definitions
still require user-run builds, installation and route acceptance.
Their retained boundaries and source records under `data/regions/` are now referenced
by the shared builder; the obsolete pack registry and size table are removed.
See [status](status.md) for actual built/installed evidence.

These nine groups were built and activated before the data cutover. The completion
evidence remains in status Gates 3–4, 8–11 and 13–17, and their regional charters.
Restore their hiking coverage through the current named-area pipeline; the old
number of packs does not prescribe the number of new download areas.

| Historical coverage group | Systems to account for | Current restoration |
| --- | --- | --- |
| Santa Cruz Mountains | Midpen/Santa Cruz systems, including Big Basin, Castle Rock, Henry Cowell, Nisene Marks, Bear Creek Redwoods, Sierra Azul and Rancho San Antonio | Configured; build/install/acceptance pending |
| Southern East Bay | Pleasanton Ridge, Mission Peak, Vargas Plateau, Sunol, Ohlone corridor and Del Valle | Configured; build/install/acceptance pending |
| Monterey–Carmel | Fort Ord, Palo Corona, Garland/Kahn Ranch, Point Lobos and Garrapata | Configured; build/install/acceptance pending |
| Henry Coe | Henry W. Coe State Park and Coyote Lake–Harvey Bear Ranch | Configured; build/install/acceptance pending |
| Central Cascades | Glacier Peak, Napeequa/Chiwawa, Lake Wenatchee, Stevens/Leavenworth/Icicle, Alpine Lakes, Snoqualmie/Cle Elum, Teanaway and Wild Sky/Henry M. Jackson approaches | Full pilot footprints/approaches consolidated; rebuild and acceptance pending |
| North Cascades | Baker, Highway 20, North Cascades complex/Stehekin, Methow, Pasayten and Lake Chelan–Sawtooth approaches | Configured; build/install/acceptance pending |
| Rainier–Goat Rocks | Rainier, Norse Peak/Naches, William O. Douglas/White Pass and Goat Rocks | Configured; build/install/acceptance pending |
| Southwest Cascades | St. Helens, Adams, southern Gifford Pinchot, upper Cispus, Indian Heaven/Trapper Creek and Silver Star–Tarbell | Configured; build/install/acceptance pending |
| Olympic Peninsula | Mountain, rainforest and reviewed coastal systems, including the mapped Ozette beach loop | Configured; build/install/acceptance pending |

The historical Washington polygons were mountain-focused. The current definitions
union them with all 39 pinned Census county polygons, assigned once across twelve
groups. This closes unassigned territorial gaps and retains old approach obligations.
Eligibility is fewer than ten mapped buildings within 500 metres plus the existing
access/topology rules, including quiet lowlands and foothills. Complete county
assignment is not a claim of complete source trails or built/installed coverage.

Marin/Mount Tam and Tahoe–Eldorado were planned, not previously activated.
Keep them distinct from restoration obligations. The August 4 archive tags contain
earlier prototype source samples, not the nine later completed regional builds.

## Current implementation and next gates

- The generic loader reads each area's boundary/approach attribution from data.
  Washington's full mainland and maritime IBC support limit is explicit in its
  recipe; California uses its own verified provider extent. Southwest Cascades
  includes the separately pinned Oregon source; eastern groups use matching Idaho
  inputs. The surveyed US border extends across both providers. Real source gaps
  still fail instead of silently shrinking coverage.
- The restored definitions reuse reviewed geographic footprints, exact-way access
  restrictions and source-linked representative approach checkpoints. Those
  checkpoints are not complete trailhead inventories. Larger historical groups
  are practical restoration selections, with unmeasured first-build costs; the
  ten-minute target remains to be tested. They need not become a permanent
  partition if measured preparation cost justifies smaller natural areas.
- `data plan REGION [REGION...]` preflights explicit selections without source
  processing. `data build REGION [REGION...]` builds them sequentially, stops on
  failure/pause, and publishes each successful area independently. Coverage can
  install several published areas in one download job. No graph stitching or
  separate California/ Washington compiler is introduced.
- Next, the user builds and installs the new definitions. Apply the acceptance
  procedure below: approach checks, representative loop/lollipop and boundary
  routes, restrictions, memory/time/disk and overlap behavior. The source pins
  retain their original review dates; this restoration is not a current-conditions
  audit. Independent full-trail completeness remains open.
- Source-refresh/publication across a coherent generation remains a separate
  maintenance gate. A batch of builds is not an atomic generation refresh.

## Washington territory assignment and acceptance

The [pinned county definitions](../../data/coverage/territories/README.md) document
all assignments and provenance. Catalog validation rejects a missing unit, duplicate
assignment or unknown unit. Existing groups cover their whole assigned counties;
seven new groups cover the remaining islands, lowlands and eastern territory:

- North Puget Islands; South Puget Sound; Willapa Hills and Lower Columbia.
- Northeast Washington; Spokane and Palouse; Columbia Basin.
- Blue Mountains and Walla Walla.

The original five groups also expand to their west/east foothills and lowlands.
Census mapping geometry is generalized; shorelines, small islands and margins still
need source-start acceptance. The precise IBC mask and reviewed exclusions remain
hard routing limits. Preserve explicit permission/source-review exclusions.

Real-data build time, memory, bytes, installation, route generation and independent
source completeness are still acceptance work. The rectangular routing buffers
can make large county groups expensive even after early sparse-start filtering.
Future measured regrouping must preserve every unit and existing coverage obligation.

## Region definition and acceptance

- Choose a stable name, reviewed start footprint, approaches and explicit
  exclusions. Named regions select starting points; their legal boundaries do
  not clip hikes. Initial requests remain capped at 40 miles.
- Verify provider coverage for the complete routing buffer and preserve source
  provenance, licenses and reviewed restrictions. Reuse historical inputs only
  after confirming they fit the current pipeline and are still obtainable.
- Build an independent compact graph using the shared compiler. Overlap is
  allowed; each start is searched through one owning graph. Do not stitch graphs
  or add regional code to the solver.
- Check the final artifact, eligible starts, representative routes and overlap
  behavior. Record build/cache conditions and resource measurements. A successful
  build or a shaded coverage polygon does not establish complete trail coverage.
- Publish and install through the current prepared-release service. Keep running
  and saved search references valid. Record the exact artifact and acceptance
  evidence in status; keep generated data and databases out of Git.

Detailed historical inclusion/exclusion and access decisions remain in the
`data/regions/*/charter.md` files, historical status and Git history. They are
provenance for review, not instructions to restore old runtime mechanisms.
