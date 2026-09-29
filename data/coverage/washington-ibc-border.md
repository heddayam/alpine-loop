# Washington mainland and maritime north edge

Reviewed 2026-09-28. The [International Boundary Commission (IBC) digital boundary
v1.3](https://www.internationalboundarycommission.org/en/maps-coordinates/coordinates.php)
is the pinned north limit for Washington preparation. Its 258,764-byte
[archive](https://www.internationalboundarycommission.org/uploads/shapefile/us-canada-boundary-v1-3.zip)
has SHA-256 `eb327459528b87cbc27e55ccc6bfd6982562c75559823a00b6dc50c04abcaab1`;
its `.shp` has SHA-256
`77db98da135852843be4cdc4e3d23319a7113f8d77e1b1b963b2da63be2ef022`.
IBC describes the NAD83 monument/turning-point geometry as mapping evidence,
not a legal definition or access permission.

## Supported-area mask

`washington-us-limit.geojson` now concatenates the original coordinates of
one-based shapefile records **10, 2, 6, 14**, in that order. Adjacent records
share exact endpoints; only the duplicate joining vertices are removed.
The resulting polygon has 860 vertices including its closing point.

- Record 10 starts at `[-116.49923103599997, 48.99988115300005]`, east of the
  Washington provider extent, and joins records 2 and 6 along the mainland.
- Record 14 joins record 6 at
  `[-123.09069954599994, 49.00205821900005]`. Its 248 vertices follow the
  maritime border through the Georgia, Haro and Juan de Fuca straits to
  `[-124.72724702899995, 48.493444612000076]`. IBC's
  [section F description](https://www.internationalboundarycommission.org/en/maps-coordinates/maps/section-f.php)
  identifies this continuation from the 49th parallel to the Pacific.
- West of that Pacific terminus, the mask conservatively excludes all points
  north of the terminal latitude. This is an explicit offshore product-scope
  cut, **not an asserted continuation of the international boundary**. It
  excludes no part of the retained Olympic start footprint. The eastern
  extension starts beyond Washington's provider footprint. Neither extension
  makes this a general-purpose US boundary.

This replaces the mainland-only mask whose westward closing edge could admit
Canadian land in an Olympic routing buffer. The loader no longer needs a
hardcoded mainland longitude check when using this reviewed Washington input.
Point Roberts and Friday Harbor remain on the included side; Victoria and
Port Renfrew are excluded. Olympic's full conservative 25-mile envelope,
after applying the mask, is covered by the unchanged Washington provider
polygon. No source extent was expanded or ocean gap silently filled.

## Provider geometry and mainland regressions

`washington-source.geojson` remains unchanged. The Geofabrik Washington polygon
supplies its coast, east and south edges. Its mainland north edge was previously
replaced with IBC records 6, 2 and 10 between the mainland western point above
and `[-117.025231978, 48.999225501]` at the provider's eastern edge. Its western
connection starts at `[-123.090699546, 49.006865535]` on the provider edge.
The supported-area mask now also constrains the provider's maritime portion.
Provider extent is distinct from the US-side product boundary; support for
trail topology and DEM is still checked independently.

The provider polygon was retrieved 2026-09-24 after the historical PBF;
its GeoJSON records this version mismatch. Complete-way source extraction
outside it does not expand advertised coverage.

The IBC line near longitude -121.774 has latitude 48.997541994. Pinned OSM
way/1186146299 (`BR717`) lies north of it, including node/11017326772 at
`[-121.7736891, 48.99766]`, and remains excluded. Pinned Chilliwack River Trail
node/677621543 at `[-121.4077738, 48.9998624]` remains south of the line and
included. US land may lie slightly north of geometric latitude 49; do not
replace this boundary with a latitude cutoff.

North Cascades, Central Cascades, Rainier–Goat Rocks and Olympic pass an offline
provider-buffer geometry check. Southwest Cascades requires the separately
reviewed Oregon source: its buffer crosses actual Oregon land. This mask does
not clip US hiking routes to the Washington state line.
