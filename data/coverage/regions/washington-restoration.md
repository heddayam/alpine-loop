# Washington restoration inputs

These entries restore named **start footprints** through the current independent
regional builder. They do not restore the old pack compiler or turn old hard
route boundaries into new route limits. Source pins, cached measurements and
reviewed access restrictions remain reusable. Builds, installation and real
route acceptance are separate from this configuration work.

| Named area | Retained footprint | Representative checkpoints |
| --- | --- | --- |
| North Cascades | `data/regions/north-cascades/boundary.geojson` v3 | 8: Baker Lake; Artist Point; Diablo/Ross; Rainy Pass; Stehekin approach; Methow/Twisp; west/east Pasayten |
| Central Cascades | `central-cascades.geojson`: historical v2 plus complete Glacier Peak/Henry M. Jackson pilot footprints | 28 distinct historical/USFS approach checkpoints, retaining all pilot neighborhoods |
| Rainier–Goat Rocks | `data/regions/rainier-goat-rocks/boundary.geojson` v1 | 10: Longmire; Mowich; Sunrise; Ohanapecosh; Naches; Greenwater; White Pass; Pear Butte; Snowgrass; Walupt |
| Southwest Cascades | `data/regions/southwest-cascades/boundary.geojson` v1 | 9: Ape Canyon; June Lake; Norway Pass; Stagman; Killen; Blue Lake; Lemei; Big Hollow; Rock Creek |
| Olympic Peninsula | `data/regions/olympic-peninsula/boundary.geojson` v1 | 9: Ozette; Sol Duc; Hoh; Staircase; Quinault; Hurricane Hill; Elwha; Mount Townsend; Kestner |

Coordinates are retained exactly from each group's committed `scenarios.json`.
A 500 m registration neighborhood selects existing eligible access points;
it does not create a portal or establish permission. These historical checkpoints
are representative, not an exhaustive approach inventory. Previous scenario
results predate the loop/lollipop pipeline and must be rechecked on the final
artifacts. Named aliases describe included systems, not whole national forests.
The Glacier Peak and Henry M. Jackson build/download entries are retired into
Central Cascades. Their full boundaries and reviewed approach neighborhoods are
preserved, including the Lost Creek entry and Heather Lake’s 600 m neighborhood.
Nearby historical and USFS checkpoint records remain distinct; only the identical
shared Little Wenatchee Ford record is deduplicated.

The historical boundaries were reviewed against the pinned August 1, 2026
Washington OSM extract and retain their holes and detached pieces. Their
provenance is described as an Alpine Loop/OpenStreetMap footprint decision,
not as a USFS legal wilderness boundary. Olympic's four parts include its
mountain/forest core and reviewed northern, southern and Kalaloch coastal
sections. No beach crossing, tide passability or closed loop is invented.

## Border and provider coverage

The [reviewed IBC mask](../washington-ibc-border.md) now follows the maritime
border as well as the mainland. It excludes Canadian land reached by the
Olympic buffer while preserving the prior mainland checks. The current
Washington source polygon fully covers the masked envelopes for North,
Central, Rainier–Goat Rocks and Olympic. The source polygon itself is unchanged.

Southwest's conservative buffer has an actual Oregon-land gap, with bounds
approximately `[-123.0453,45.3141,-120.8994,46.1472]` before adding an adjacent
provider. The user authorized the separately pinned Oregon source to preserve
that buffer; this area must not be made buildable by silently clipping it to
the Washington source or state boundary. An offline check with the pinned Oregon provider confirms the union
covers all five planned buffers, with all 45 representative coordinates
inside their start footprints. The Oregon point `[-122,45.5]` is retained in
Southwest routing coverage and is outside its eligible start footprint.

## Preserve the prior access-related exclusions

The Olympic charter deliberately withheld unreviewed tribal approaches. Moving
its boundary from a hard route limit to a start selector would otherwise bring
those corridors into the new buffer. The Washington recipe therefore retains
the existing Yakama exclusion and adds explicitly scoped Makah, Quileute, Hoh
and Quinault polygons. Each new exclusion is the reservation geometry **minus
the previously reviewed Olympic footprint**, preserving previously included
park/coast geometry. This is a conservative product decision, not a declaration
that tribal lands are closed or permits cannot authorize recreation.

| Exclusion input | Pinned OSM relation/version |
| --- | --- |
| `makah-exclusion.geojson` | 3439903 / 39 |
| `quileute-exclusion.geojson` | 6125774 / 11 |
| `hoh-exclusion.geojson` | 6123687 / 13 |
| `quinault-exclusion.geojson` | 7684703 / 8 |

Derivation used `osmium getid --add-referenced --remove-tags`, followed by
`osmium export --geometry-types=polygon --add-unique-id=type_id`, on the existing
359,826,867-byte PBF after verifying SHA-256
`3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`.
The derived GeoJSON stores its source URL/hash, full source-geometry hash,
retained-footprint file hash and policy basis. Polygon subtraction uses the
existing coverage geometry module without coordinate smoothing or rounding.
Temporary extracts were removed; no new OSM or DEM acquisition was performed
for these exclusions. Reintersection finds no overlap with the old footprint
for Makah, Quileute or Hoh; Quinault has only floating-point boundary slivers
totalling `5.01e-18` square degrees (far below a square millimetre). All nine
Olympic representative coordinates remain eligible in the planned footprint.

[NPS Mora/Rialto](https://www.nps.gov/olym/planyourvisit/visiting-mora-and-rialto.htm)
distinguishes tribal First Beach from park Second/Third Beaches. [Makah's
visitor information](https://makah.com/attractions/) identifies its permit
requirement. These support the need for jurisdiction-specific review; neither
source is encoded as a blanket public-access denial. Lower Elwha/Jamestown are
not newly excluded merely because they are tribal jurisdictions. Any future
corridor admission requires exact geometry and relevant authority review.

## Remaining statewide gaps and acceptance

The independent acceptance fixtures under `data/fixtures/coverage/` preserve
the pre-consolidation footprints and approaches, plus 24 complete pinned OSM
ways across North/Central, Central/Rainier and Rainier/Southwest. Tests compare
full polygons and every line segment, including the middle between vertices.
They preserve the explicit Yakama exclusion on PCT way 550208972; it is not
treated as a missing connector or a traversable crossing. The earlier upper
Cispus Blue Lake–Hamilton review remains historical evidence, not a new exhaustive
source-line audit; its charter did not retain every way ID.

This follows standard Boolean difference: required coverage minus the union of
available start areas must be empty, except for explicitly recorded exclusions.
[Coverage validity alone can still allow holes](https://postgis.net/docs/ST_CoverageInvalidEdges.html),
so polygon adjacency is not a completeness test. The existing
[polygon-clipping operations](https://github.com/mfogel/polygon-clipping) provide
union/difference; no new geometry dependency is needed. The shared containment
check tolerates only aggregate floating-point overlay residues up to 1e-14 square
degrees (at most 0.000124 m²), with translated area accumulation. This addresses
the [finite-precision containment issue](https://locationtech.github.io/jts/jts-faq.html#D7),
not real holes. Regression negatives remove an interior hole and a middle section
whose endpoints remain covered; both must fail. Future area changes must retain
these obligations and add independently sourced seam/start evidence for their scope.

Restoring these mountain-focused groups does not establish Washington-wide
coverage. Explicit inventory work remains for Puget Sound/Whatcom lowlands,
San Juan and other islands, Kitsap, southwest coastal/Willapa systems, and
central/eastern Washington including the Columbia Basin, Spokane/Selkirk and
Blue Mountains. These are gap categories, not claims that any particular trail
is missing from an installed graph. Nearby source data alone is not restored
start coverage.

Before accepting each group, confirm final approach starts, independent
trail/connectivity comparisons, representative loop/lollipop results and
cross-boundary routes. Preserve coastal tide limitations, access exclusions,
unknown-access choice and provenance. Record cached versus cold acquisition,
processing duration and resource peaks; the five larger historical footprints
have no measured runtime guarantee in the current pipeline.
