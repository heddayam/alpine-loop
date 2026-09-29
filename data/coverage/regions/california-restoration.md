# California coverage restoration

Reviewed 2026-09-28 Pacific (source availability checked 2026-09-29 UTC).
These four named areas restore the geographic scope of the previously built
California regions through the current independent buffered-graph compiler.
They are buildable definitions, not a claim that the new artifacts have been
built or that every trail/entrance has passed completeness review.

## Retained footprints and representative approaches

The catalog references each existing `data/regions/<id>/boundary.geojson` using
`../../regions/<id>/boundary.geojson`; it does not copy or redraw the geometry.
The historical build footprint now selects eligible starts. The surrounding
25-mile support envelope permits routes to leave that footprint. It does not
make neighboring territory a selectable start area or override trail access.

| Area | Prior geographic scope | Initial approach inventory |
| --- | --- | --- |
| `santa-cruz-mountains` | Santa Cruz Mountains / Midpen hiking systems in the retained boundary | Three official State Parks direction destinations: Castle Rock, Henry Cowell, Big Basin |
| `southern-east-bay` | Pleasanton Ridge, Mission Peak, Vargas Plateau, Sunol, Ohlone corridor, Del Valle | Five official entrance anchors retained in regional scenarios; the explicitly synthetic Ohlone QA point is excluded |
| `monterey-carmel` | Fort Ord, Palo Corona, Garland/Kahn, Point Lobos, Garrapata | Ten source-linked entrance records retained in `official-sources/reviewed-access.json` |
| `henry-coe` | Henry W. Coe State Park and Coyote Lake–Harvey Bear Ranch | Coe Ranch, Hunting Hollow, Dowdy Ranch, Mendoza Ranch and Harvey Bear |

The broad retained footprints continue to include eligible mapped starts beyond
these lists. The anchors neither create graph starts nor assert that current
conditions allow entry. They are sparse review evidence, not exhaustive
inventories. Coyote Lake main remains deferred: the historical audit's nearest
eligible portal was 830 m away. The Santa Cruz list especially does not inventory
all Midpen preserves or Nisene Marks. The new build must report missing reviewed
approaches instead of silently claiming full coverage.

Santa Cruz coordinates were read verbatim from the `Get directions` link on each
official park page, rather than inferred from the park's center:

| Official page | Published destination `[longitude, latitude]` |
| --- | --- |
| [Castle Rock](https://www.parks.ca.gov/?page_id=538) | `[-122.0980668375132, 37.232555191977696]` |
| [Henry Cowell](https://www.parks.ca.gov/?page_id=546) | `[-122.064, 37.0401]` |
| [Big Basin](https://www.parks.ca.gov/?page_id=540) | `[-122.22203, 37.17159]` |

For the other areas, the original coordinate, review date, authority and source
page remain in the committed charter/scenarios or reviewed overlay. Each catalog
anchor identifies that evidence. The source review preserves location facts; it
does not update the 2026-08-07/08 restriction or entrance-condition review.
Boundary provenance credits the retained repository-reviewed footprint and OSM
where applicable, rather than labeling California footprints as USFS data.

## One shared pinned source recipe

`../recipes/california.json` uses the unchanged Geofabrik Northern California
config from `data/regions/santa-cruz-mountains/osm-source.json`. All four legacy
OSM configs describe the same extract:

- URL: `https://download.geofabrik.de/north-america/us/california/norcal-260801.osm.pbf`
- Length: 648,017,783 bytes (about 618 MiB).
- SHA-256: `215f18449e6cd190200a7dc1188a63dba2bec1f20fb3d1637c4f11c1f9134342`.
- License: ODbL 1.0, with OpenStreetMap contributor and Geofabrik attribution.

The hash is retained in the existing `.cache/sources` receipt and is verified by
the builder before preparation. A HEAD-only availability check returned HTTP 200
and the expected length on 2026-09-29; no PBF was downloaded for this restoration.
Use the default `.cache/sources` here to reuse that existing California receipt;
the older Washington-specific source-cache override points elsewhere.

All four retained footprints **including their full conservative 25-mile routing
envelopes** fit the committed `../norcal-source.geojson`. This was checked by
polygon difference, not just by intersecting bounding boxes. No source-edge or
coastal clipping is introduced. The provider polygon's recorded limitation still
applies: its review-date extent is not proof of historical extract completeness.

The recipe loads all four `reviewedRegionIds` on every California build so that
buffer overlap preserves the same restrictive facts: 31 Santa Cruz, 45 Southern
East Bay and two Monterey exact-way removals. Henry Coe has no curated restriction
file. The compiler applies these before graph membership and validates them in
its inventory reconciliation. No public-access promotion or invented connector
is introduced. Retained EBRPD/MPRPD/State Parks derivative terms include local-
evaluation-only review decisions; a public distribution needs those resolved.

## Elevation and acceptance

The existing sample-owner DEM selection remains authoritative: historical
per-region elevation bboxes/products seed reusable cached inputs but do not
constrain the new 25-mile support graph. Needed sample-owner tiles beyond the old
footprint are resolved by the shared 3DEP path. The canonical inventory contains
both California and Washington products; an area's metric identity includes only
its relevant products, and its sampler opens only those required tiles.

No legacy population input, separate regional builder, official-access promotion,
or old installer is restored. The current 4 GiB recipe limit is a guard, not a
measured assurance that all four new builds fit comfortably. Before calling an
area restored, build and inspect its artifact, explain missing reviewed approaches,
run representative loop/lollipop searches from the retained scenario clusters,
and verify restricted ways remain excluded. Those real-data gates have not been
run as part of this catalog change.
