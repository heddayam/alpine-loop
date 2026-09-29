# Coverage restoration and Washington expansion

The target is **Washington-wide hiking coverage plus the Bay Area and nearby
California coverage previously available**. Glacier Peak and Henry M. Jackson
are the first two prepared areas, not the final product scope. This roadmap
replaces the former pack-registry, bootstrap and schema-6 activation instructions.
The current architecture and commands are in [prepared coverage](prepared-coverage.md)
and [README](../../README.md#developer-data-builds).

## Current availability and restoration baseline

`data/coverage/regions/catalog.json` currently defines two buildable named areas.
The user has built and installed both. Their coverage acceptance remains partial;
see [status](status.md). Historical region definitions under `data/regions/` are
review inputs, not active catalog entries or evidence of current availability.

These nine groups were built and activated before the data cutover. The completion
evidence remains in status Gates 3–4, 8–11 and 13–17, and their regional charters.
Restore their hiking coverage through the current named-area pipeline; the old
number of packs does not prescribe the number of new download areas.

| Historical coverage group | Systems to account for | Current restoration |
| --- | --- | --- |
| Santa Cruz Mountains | Midpen/Santa Cruz systems, including Big Basin, Castle Rock, Henry Cowell, Nisene Marks, Bear Creek Redwoods, Sierra Azul and Rancho San Antonio | Not restored |
| Southern East Bay | Pleasanton Ridge, Mission Peak, Vargas Plateau, Sunol, Ohlone corridor and Del Valle | Not restored |
| Monterey–Carmel | Fort Ord, Palo Corona, Garland/Kahn Ranch, Point Lobos and Garrapata | Not restored |
| Henry Coe | Henry W. Coe State Park and Coyote Lake–Harvey Bear Ranch | Not restored |
| Central Cascades | Glacier Peak, Napeequa/Chiwawa, Lake Wenatchee, Stevens/Leavenworth/Icicle, Alpine Lakes, Snoqualmie/Cle Elum, Teanaway and Wild Sky/Henry M. Jackson approaches | Glacier Peak and Henry M. Jackson only; quality gaps open |
| North Cascades | Baker, Highway 20, North Cascades complex/Stehekin, Methow, Pasayten and Lake Chelan–Sawtooth approaches | Not restored |
| Rainier–Goat Rocks | Rainier, Norse Peak/Naches, William O. Douglas/White Pass and Goat Rocks | Not restored |
| Southwest Cascades | St. Helens, Adams, southern Gifford Pinchot, upper Cispus, Indian Heaven/Trapper Creek and Silver Star–Tarbell | Not restored |
| Olympic Peninsula | Mountain, rainforest and reviewed coastal systems, including the mapped Ozette beach loop | Not restored |

The five historical Washington groups were mountain-focused. They do not establish
statewide coverage: their charters excluded other Washington hiking systems.
Maintain an explicit inventory of remaining statewide areas and gaps, including
lowland and eastern-Washington systems, before claiming Washington complete.
The existing wilderness-start eligibility and access rules continue to apply.

Marin/Mount Tam and Tahoe–Eldorado were planned, not previously activated.
Keep them distinct from restoration obligations. The August 4 archive tags contain
earlier prototype source samples, not the nine later completed regional builds.

## Execution order

1. **Coverage correctness first.** Resolve the diagnosed Top Lake, Heather Lake
   and Lost Creek Ridge start omissions. Establish reusable approach checks,
   representative loop/lollipop and boundary-route scenarios, and an independent
   comparison against the final installed graph. Source proximity alone does not
   establish trail completeness. Explain each omission as source absence,
   restriction, intentional distance pruning, or a compiler/footprint defect.
2. **Remove pilot-only assumptions.** The current region loader hardcodes a
   Washington mainland longitude range and USFS wilderness provenance. Put
   reviewed source/border scope and boundary provenance in the appropriate data
   inputs so Olympic and California areas can use the same builder. Retain the
   US-only border limit; fail explicitly for unsupported source coverage.
3. **Restore coverage in Washington and California.** Review the existing
   charters, source pins, restrictions and scenarios; turn the systems in the
   table into intuitive named areas with complete approach inventories. Prepare
   and accept each through the same pipeline. Reuse cached sources and metrics.
   Track configured, built, installed and accepted separately. Do not revive
   obsolete builders or require the user to select geographic coordinates.
4. **Complete the Washington inventory.** Reconcile the restored catalog against
   the statewide hiking-area inventory, recording intentional exclusions and
   unresolved gaps. Forest aliases must not imply an entire forest is available.
5. **Accept the expanded product and maintenance cycle.** Exercise whole-area
   Full searches, saved work and GPX export; measure build memory/time/disk and
   adjoining-area costs. Provide a coherent shared-source refresh/publication
   workflow and a maintained prepared catalog for fresh installations.

The next region must use the same small acceptance procedure as the pilot.
Quality work should produce a repeatable procedure rather than indefinite manual
polishing of two areas. The user runs regional/Docker builds; agent investigations
use bounded fixture tests and finalized artifact copies unless directed otherwise.

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
