# Complete Washington start territories

`washington-counties.geojson` pins all 39 Washington counties from the U.S.
Census Bureau's [Generalized ACS 2025 Counties 500K layer](https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer/11?f=pjson).
The official layer describes a January 1, 2025 vintage and generalized county
geometry. This is a complete inventory of the declared county units, not a
survey, trail inventory, access grant or measured build result.

The response was retrieved on 2026-09-29 at 06:07:50 UTC using the exact query
recorded in the GeoJSON's `provenance.sourceUrl`. It contained 39 features and
848,519 bytes, SHA-256
`de4849583453e0e5de34c2577a51b216ffb1c5d24bfd11859bbd7b5d2dbaa52b`.
The committed form sets `Feature.id` to the source's five-digit `GEOID`, sorts
features by that ID, and retains every source coordinate and the four requested
fields unchanged: `STATE`, `COUNTY`, `GEOID`, and `NAME`. Federal Census data are
public domain; attribution and the mapping limitations remain with the file.
The raw response is not retained separately.

## Grouping contract

The catalog assigns every county exactly once. Membership groups candidate
starts for downloading; the shared access, topology and building-density rules
still determine eligibility. County lines do not clip generated hikes.

| Download group | Assigned counties |
| --- | --- |
| North Cascades | Whatcom, Skagit, Okanogan |
| Central Cascades | Snohomish, King, Chelan, Kittitas |
| Rainier–Goat Rocks | Pierce, Lewis, Yakima |
| Southwest Cascades | Skamania, Klickitat, Clark, Cowlitz |
| Olympic Peninsula | Clallam, Jefferson, Mason, Grays Harbor |
| North Puget Islands | San Juan, Island |
| South Puget Sound | Kitsap, Thurston |
| Willapa Hills and Lower Columbia | Pacific, Wahkiakum |
| Northeast Washington | Ferry, Stevens, Pend Oreille |
| Spokane and Palouse | Spokane, Lincoln, Whitman |
| Columbia Basin | Douglas, Grant, Adams, Benton, Franklin |
| Blue Mountains and Walla Walla | Asotin, Garfield, Columbia, Walla Walla |

The five existing Washington entries retain their `boundaryPath`, reviewed
approaches and replacement metadata. Their effective start footprints union
those retained inputs with the assigned counties. Overlap from those preserved
footprints is intentional and must not be removed to force a disjoint map.
The four California catalog entries and their precise existing footprints are
unchanged; they are not a declaration of statewide California or entire Bay
Area coverage. New Washington groups have no invented reviewed approach
anchors.

## Limits and cost

County margins and shorelines are generalized at 1:500,000 scale. Assigning all
39 units proves inventory coverage within the committed geometry; it does not
prove that every real-world trail or start is represented at generalized outer
margins. Source completeness, route acceptance and current access conditions
remain separate reviews. The Washington recipe's US-only boundary and explicit
exclusions continue to apply, including on buffered routes.

Larger territories require fresh preparation and new artifact measurements.
The current preparation envelope pads the start geometry's bounding rectangle;
county groups with long east–west extents or distant islands can increase source
processing substantially. Sparse eligible starts do not by themselves make
that preparation cheap. No regional graph, elevation data or performance build
was run to produce these definitions. Future cost-driven regrouping must keep
all county assignments and all existing coverage obligations accounted for.
