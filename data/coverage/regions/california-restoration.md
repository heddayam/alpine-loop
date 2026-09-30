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
footprint are resolved by the shared 3DEP path. The canonical inventory can retain
both California and Washington products; an area's metric identity includes only
its relevant products, and its sampler opens only those required tiles.

No legacy population input, separate regional builder, official-access promotion,
or old installer is restored. The current 4 GiB recipe limit is a guard, not a
measured assurance that all four new builds fit comfortably. Before calling an
area restored, build and inspect its artifact, explain missing reviewed approaches,
run representative loop/lollipop searches from the retained scenario clusters,
and verify restricted ways remain excluded. Those real-data gates have not been
run as part of this catalog change.

## Preserve exclusions when adding the route buffer

Two derived product exclusions preserve explicitly reviewed Henry Coe policy
outside the prior reviewed start footprint. The shared recipe references
`../canada-de-los-osos-exclusion.geojson` and `../palassou-ridge-exclusion.geojson`.

Both source shapes were exported from the existing pinned Norcal PBF (SHA-256
215f18449e6cd190200a7dc1188a63dba2bec1f20fb3d1637c4f11c1f9134342), using
`osmium getid --add-referenced --remove-tags` for way/79436065 and
relation/20575981, then `osmium export --geometry-types=polygon --stop-on-error`.
The raw polygons had 108 and 214 vertices. No PBF download or database was used.

The raw reserve boundary overlaps the old Coe footprint by approximately
0.944 km². CDFW's linked management plan records a transfer of about 200 acres
for a State Parks entrance. The raw Palassou polygon overlaps by approximately
3,402 m² of boundary slivers. Consequently these are conservative product exclusions, not whole-property bans.
Each final exclusion is the exact mapped polygon MINUS the retained reviewed
Henry Coe footprint. This keeps the prior reviewed entrance/park geometry and
restricts only previously excluded land introduced by the routing-buffer expansion.
The final files record both the original geometry hash and exact retained boundary
file hash, derivation, original OSM tags, policy sources and limitations.

Policy evidence reviewed:

- Henry Coe charter's explicit exclusions and authority responsibilities:
  `data/regions/henry-coe/charter.md`, lines 56–61 and 86–89.
- CDFW management plan, PDF page 6, states informal public access is not allowed;
  page 5 records the State Parks transfer:
  https://nrm.dfg.ca.gov/FileHandler.ashx?DocumentID=84909&inline=
- Current county-hosted Coyote Lake map labels Palassou Open Space "No Public
  Access": https://files.santaclaracounty.gov/exjcpb1516/2025-04/easy-trails-coyote-lake-harvey-bear-ranch.pdf
- Pinned Palassou OSM relation tags access=no and hiking=no.

Do not infer fresh legal access within the retained Coe footprint. Normal OSM
access classification and the existing exact-way restrictions still apply.
The CDFW property webpage includes an unrelated Gray Lodge content block; that
block was not used as evidence. Its linked property-specific management plan
was used. Official CDFW GIS metadata was found, but no current exact property
boundary was downloaded or substituted in this bounded pass.

Other explicit access-policy concerns found in the retained CA charters:

- Southern East Bay permits only the signed Ohlone corridor across SFPUC
  watershed; it does not authorize off-corridor travel. Do not blanket-exclude
  the whole watershed, because that would remove the intended public corridor.
- Monterey's Fort Ord review limits travel to signed/map-listed trails and
  excludes Army-closed land. This needs a targeted signed-trail/closed-land
  review before broader completeness is claimed; do not exclude all Fort Ord
  or promote unknown OSM ways to public access.
- Broad omissions such as Mount Diablo, Pacheco, Ventana and unrelated lowland
  systems were product-scope choices, not evidence of a hiking prohibition.

The existing 78 exact-way restrictions remain in force. No other guessed
polygon or blanket rule for unknown access was added. The extraction scratch files were deleted.
