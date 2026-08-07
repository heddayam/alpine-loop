# Southern East Bay optional entrance-name source

The regional pack derives every route start from OSM trail/street topology. It
does not ingest an authority point as a start and does not spatially match a
live authority line layer to OSM ways.

The only live official source retained here is
`ebrpd-park-entrances.json`. Its pinned EBRPD Park Entrances response is an
optional cosmetic overlay: a record within the portal evidence tolerance can
name and raise confidence on an existing portal. It cannot create a portal,
change a portal's access state, or create a connector edge. A missing entrance
snapshot therefore degrades labels, not the route-start set.

The query covers Mission Peak, Ohlone, Pleasanton Ridge, Vargas Plateau, Sunol,
and Del Valle. At inspection it returned 25 features with 25 distinct, non-null
`GlobalID` values: 12 Del Valle, 3 Mission Peak, 4 Pleasanton Ridge, 5 Sunol,
and 1 Vargas Plateau. It returned no direct Ohlone entrance.

The adapter still validates the documented `CLOSED`, `WALKING`, `ENTRANCE`, and
`PARKING` domains so schema drift fails visibly, but the portal overlay consumes
only stable identity, coordinates, name, and confidence. Parking or entrance
presence never establishes hiking permission.

The EBRPD item publishes an accuracy/warranty disclaimer and no affirmative
reuse grant. Local evaluation is permitted; normalized derivative-pack
redistribution requires review or written permission. The exact item, layer,
and inspected-response hashes are pinned in `ebrpd-park-entrances.json`, and a
build receipt records the bytes actually used. Runtime never calls the service.

## Reviewed access removals

`../access-restrictions.json` is the sole non-OSM access override. It contains
45 exact OSM-way removals: 42 cases where the old schema-5 EBRPD line match
changed a public/unknown OSM way to prohibited, plus the 3 reviewed Shady Glen
closures. Eighteen old EBRPD restrictive matches were omitted because OSM was
already private/prohibited, so they had no algorithmic effect.

The list was reconstructed by comparing the installed schema-5 pack's recorded
joins with the pinned version-7 raw topology. It is committed, validated as
restrictive-only, and applied before portal derivation. The former
`ebrpd-roads-and-trails.json` live source and `current-closures.json` adapter
input are intentionally retired; the current closure facts are folded into the
same exact-removal file.
