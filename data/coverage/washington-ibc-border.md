# Washington mainland, maritime border and offshore scope

Reviewed 2026-09-29. The [International Boundary Commission (IBC) digital boundary
v1.3](https://www.internationalboundarycommission.org/en/maps-coordinates/coordinates.php)
is the pinned north limit for Washington preparation. Its 258,764-byte
[archive](https://www.internationalboundarycommission.org/uploads/shapefile/us-canada-boundary-v1-3.zip)
has SHA-256 `eb327459528b87cbc27e55ccc6bfd6982562c75559823a00b6dc50c04abcaab1`;
its `.shp` has SHA-256
`77db98da135852843be4cdc4e3d23319a7113f8d77e1b1b963b2da63be2ef022`
and archive CRC-32 `111867b5`.
IBC describes the NAD83 monument/turning-point geometry as mapping evidence,
not a legal definition or access permission.

## Supported-area mask

`washington-us-limit.geojson` concatenates the original coordinates of one-based
shapefile record **21, vertices 186–277**, followed by complete records
**10, 2, 6, 14**, in that order. Adjacent records share exact endpoints; only
duplicate joining vertices are removed. The mask has **953 vertices**, including
its closing point: 951 after extending the mainland boundary through the Idaho
routing buffer, then two additional vertices for the offshore scope limit below.
All 855 boundary vertices from the original records 10, 2, 6 and 14 are unchanged.

- The partial record 21 begins at
  `[-115.49187366799998, 49.00046677700004]`, east of the Washington routing
  buffer in Idaho. It joins record 10 exactly at
  `[-116.49923103599997, 48.99988115300005]`.
- Record 10 joins records 2 and 6 along the mainland.
- Record 14 joins record 6 at
  `[-123.09069954599994, 49.00205821900005]`. Its 248 vertices follow the
  maritime border through the Georgia, Haro and Juan de Fuca straits to
  `[-124.72724702899995, 48.493444612000076]`. IBC's
  [section F description](https://www.internationalboundarycommission.org/en/maps-coordinates/maps/section-f.php)
  identifies this continuation from the 49th parallel to the Pacific.
- West of that Pacific terminus, the mask conservatively excludes points north
  of the terminal latitude. This is an explicit offshore product limit,
  **not an asserted continuation of the international boundary**.
- North of latitude **46.4**, the mask additionally excludes points west of
  longitude **−125.25**. The southern portion, including Oregon support, is
  unchanged. This second offshore product limit does not define a coastline,
  a legal border or additional source coverage.

The expanded Olympic county territory's conservative rectangular 25-mile
routing envelope reaches an unsupported open-Pacific triangle with bounds
`[-125.31815019538573, 46.42500878196058, -125.2845938180056, 46.473567170607716]`.
The offshore limit removes that corner before source validation. This is a
fixed, reviewed scope decision; the planner does not automatically clip missing
source geometry or overlook small gaps.

The [statewide start-coverage baseline](../fixtures/coverage/washington-start-coverage.geojson)
preserves the former county inventory and historical footprints. Its westernmost vertex is
`[-124.76306800030036, 48.17628299983627]`, well east of the offshore cap.
The cap therefore removes no part of that declared start coverage. The original
county data is generalized at 1:500,000 scale and does not define an exact
coastline or prove a complete real-world trail inventory. Its raw-response hash
is `sha256:de4849583453e0e5de34c2577a51b216ffb1c5d24bfd11859bbd7b5d2dbaa52b`.

Point Roberts and Friday Harbor remain on the included side; Victoria and
Port Renfrew remain excluded. Neither the offshore closing edges nor the
mainland eastern extension makes this a general-purpose US boundary.

## Provider geometry and mainland regressions

`washington-source.geojson` remains unchanged. The Geofabrik Washington polygon
supplies its coast, east and south edges. Its mainland north edge was previously
replaced with IBC records 6, 2 and 10 between the mainland western point above
and `[-117.025231978, 48.999225501]` at the provider's eastern edge. Its western
connection starts at `[-123.090699546, 49.006865535]` on the provider edge.
The supported-area mask separately constrains the provider's maritime portion.
Provider extent is distinct from the US-side product boundary; support for
trail topology and DEM is still checked independently.

The Washington provider polygon was retrieved 2026-09-24 after the historical
PBF; its GeoJSON records this version mismatch. Idaho and Oregon use separately
pinned provider polygons and PBFs with the same upstream timestamp,
`2026-08-01T20:21:21Z`. Idaho's current polygon ends at latitude 49.00819 while
the historical PBF header extends to 49.13466; the advertised support follows
the exact polygon, never that larger header box. Complete-way source extraction
outside a provider polygon does not expand advertised coverage.

The IBC line near longitude −121.774 has latitude 48.997541994. Pinned OSM
way/1186146299 (`BR717`) lies north of it, including node/11017326772 at
`[-121.7736891, 48.99766]`, and remains excluded. Pinned Chilliwack River Trail
node/677621543 at `[-121.4077738, 48.9998624]` and the Depot Creek sample at
`[-121.3346143, 49.0007618]` remain included. US land may lie slightly north of
geometric latitude 49; do not replace this boundary with a latitude cutoff.

Offline source fixtures preserve the entire original IBC chain and check
US/Canada points, the offshore cap and the westernmost county vertex. A
synthetic missing provider patch on mainland Washington still fails the full
25-mile coverage check. No exclusion order or planner validation changed.
