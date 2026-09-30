# Coverage restoration and Washington expansion

The target is mountain hiking coverage across Washington and the previously
available Bay Area/nearby California territory. One published GMBA Standard
inventory defines named cores, with graph-connected approach entrances.
Former Broad/EPA lowland assignment and full historical polygon-containment
obligations are superseded. Reviewed approaches remain source audit anchors.
Current architecture and commands are in [prepared coverage](prepared-coverage.md)
and [README](../../README.md#developer-data-builds).

## Current availability and restoration baseline

`data/coverage/regions/catalog.json` defines fifteen named build selections:
eleven Washington regions following the familiar [WTA regional browsing
convention](https://www.wta.org/our-work/about/trailblazer-mobile-app) and the four
historical California areas. Washington's choices are Central Cascades, Central
Washington, Eastern Washington, Issaquah Alps, Mount Rainier Area, North Cascades,
Olympic Peninsula, Puget Sound and Islands, Snoqualmie Region, South Cascades and
Southwest Washington. The pilot entries are removed. Historical fixtures retain
provenance, rather than an
obligation to preserve broad lowland geometry. Revised definitions require user-run
builds, installation and route acceptance. California's existing footprints remain
nomination caps; their core geometry comes from the same Standard inventory.
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
| Central Cascades | Glacier Peak, Napeequa/Chiwawa, Lake Wenatchee, Stevens/Leavenworth/Icicle, Alpine Lakes, Snoqualmie/Cle Elum, Teanaway and Wild Sky/Henry M. Jackson approaches | Regrouped across North/Central Cascades, Snoqualmie, Issaquah Alps and Central Washington; existing installed artifact preserved; new builds/acceptance pending |
| North Cascades | Baker, Highway 20, North Cascades complex/Stehekin, Methow, Pasayten and Lake Chelan–Sawtooth approaches | Regrouped North Cascades; build/install/acceptance pending |
| Rainier–Goat Rocks | Rainier, Norse Peak/Naches, William O. Douglas/White Pass and Goat Rocks | Mount Rainier Area and South Cascades; build/install/acceptance pending |
| Southwest Cascades | St. Helens, Adams, southern Gifford Pinchot, upper Cispus, Indian Heaven/Trapper Creek and Silver Star–Tarbell | South Cascades and Southwest Washington; build/install/acceptance pending |
| Olympic Peninsula | Mountain, rainforest and reviewed coastal systems, including the mapped Ozette beach loop | Configured; build/install/acceptance pending |

Washington uses the same 123 selected published GMBA Standard leaves, regrouped
into the eleven hiking districts. Selected mountain cores and actual connected
approaches establish eligible coverage; the broad region names do not allocate
all lowland, coastal or basin territory. Eligibility remains fewer than ten
mapped buildings within 500 metres plus hiking connectivity to the selected core
and existing access/topology rules. Offline tests preserve the selected leaf and
reviewed-approach inventory; they do not establish complete source trails or
built/installed coverage. Complete leaves can span several access districts, so
Stuart Range and Mount Daniel assignments are documented proxies for regional
browsing rather than exact WTA trailhead classifications.

Marin/Mount Tam and Tahoe–Eldorado were planned, not previously activated.
Keep them distinct from restoration obligations. The August 4 archive tags contain
earlier prototype source samples, not the nine later completed regional builds.

## Current implementation and next gates

- The generic loader reads each area's Standard range selection, nomination cap
  and approach attribution from data.
  Washington's full mainland and maritime IBC support limit is explicit in its
  recipe; California uses its own verified provider extent. Southern regions
  include the separately pinned Oregon source; Eastern Washington uses matching
  Idaho inputs. The surveyed US border extends across both providers. Real source gaps
  still fail instead of silently shrinking coverage.
- Recipe `reviewedRegionIds` retain historical source-directory IDs for restrictive
  access files and independent official-trail references. They are separate from
  the current build/download names and must not be renamed without moving their
  pinned source inputs.
- The definitions reuse historical nomination territory, exact-way access
  restrictions and source-linked representative approach checkpoints. Those
  checkpoints are not complete trailhead inventories. Familiar regional names
  simplify browsing without adding another catalog or hidden download hierarchy.
  Larger groups have unmeasured first-build costs; the ten-minute target remains
  to be tested. Measured preparation cost can justify later physical regrouping.
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

## Washington geography and acceptance

The [range definitions](../../data/coverage/regions/README.md) record named Standard
leaf IDs and source hashes. All fifteen areas use those published cores;
Puget and basin regions represent the named mountain portions rather than
assigning all lowlands. Actual hiking connectivity determines outside approaches. No per-city
boundary rule is needed. Unknown access and reviewed restrictive removals remain.

The surveyed US border and reviewed exclusions are hard routing limits. Core
polygons plus registered entrance neighborhoods select starts; complete routing
buffers do not depend on installing an adjacent graph. Overlapping artifacts
remain independently usable. Tightening the product scope intentionally supersedes
complete statewide-land containment; real trails, approaches and seams require
representative acceptance rather than a land-area completeness claim.

Real-data build time, memory, bytes, installation, route generation and independent
source completeness remain acceptance work. Long ranges can still produce large
rectangular preparation buffers; natural borders alone do not establish speedups.

## Region definition and acceptance

- Choose a stable name, published Standard range IDs, product territory and explicit
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
