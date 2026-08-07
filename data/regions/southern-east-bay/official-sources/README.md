# Southern East Bay official access sources

These records pin public, machine-readable authority endpoints inspected on
2026-08-06 local time (2026-08-07 UTC). Refresh code must download each query
response explicitly, hash its bytes, and pass the immutable local snapshot to
the adapter. Runtime never calls these services.

The intended build set has two files:

- `ebrpd-roads-and-trails.json` for segment-level hiking modes; and
- `ebrpd-park-entrances.json` for authority-named entrance points, walking,
  parking, and explicit entrance-closure evidence.

## EBRPD Roads and Trails

The primary source is East Bay Regional Park District ArcGIS item
`581946f2fbfa4ba39f04213369c2aa85`, feature layer 13, **Roads and Trails-by
Access**. The query is limited to Pleasanton Ridge, Mission Peak, Vargas
Plateau, Sunol, Ohlone, and Del Valle. At inspection it returned 1,307 features
with 1,307 distinct, non-null `GlobalID` values and no transfer-limit flag.

Only documented values from the coded `ACCESS` domain may be interpreted:

- documented values containing `Foot` are affirmative hiking evidence for that
  segment;
- documented `Service`, `Horse`, `Bicycle`, and `EVMA` modes prohibit hiking;
  null or empty access remains unknown and undocumented non-empty values fail;
- the layer has no current-closure field, so it must not override a current
  official closure or prohibition from another pinned source;
- a feature's presence, park name, trail name, or road type never implies
  permission by itself.

The adapter must fail on a missing `GlobalID`, schema/domain drift, an empty
response, a feature count other than the pinned expectation, unexpected park
names, invalid geometry, or an unresolved conflict. The layer metadata's native
CRS is California State Plane Zone 3 (`WKID 102643`, latest `2227`); the pinned
query requests EPSG:4326.

Licensing is intentionally conservative. The item publishes EBRPD's map
accuracy/warranty disclaimer but no affirmative data-reuse license. Local
evaluation is allowed; redistribution of a normalized derivative pack requires
review or written permission. `metadataContentHash` hashes the public item
metadata response, `layerMetadataContentHash` hashes the layer-13 metadata
response, and `inspectedSnapshotContentHash` records the exact filtered query
response inspected during onboarding. A build receipt must still record the
SHA-256 of the bytes actually used.

## EBRPD Park Entrances

The point source is EBRPD ArcGIS item
`3795cd719b834488b3d2a208e2a9cef8`, feature layer 1, **EBRPD Park Entrances**.
The query uses the same six-park scope. At inspection it returned 25 features
with 25 distinct, non-null `GlobalID` values and no transfer-limit flag: 12 Del
Valle, 3 Mission Peak, 4 Pleasanton Ridge, 5 Sunol, and 1 Vargas Plateau. It
returned no direct Ohlone entrance, consistent with EBRPD's instruction to
enter Ohlone through Mission Peak, Sunol, or Del Valle.

Entrance interpretation is deliberately narrow:

- `CLOSED=Entrance Closed / No Park Access` is current closure evidence and
  outranks all permission fields;
- `CLOSED=Entrance Open` with `WALKING=Y` is affirmative pedestrian-entrance
  evidence;
- `CLOSED=No Parking In Staging Area / Walk-In Access Only` with `WALKING=Y`
  may establish a pedestrian entrance but never parking;
- null or unexpected closure/walking values remain unknown unless another
  documented field combination is explicitly approved; and
- `PARKING=Y`, `ENTRANCE=Y`, or point presence alone never establishes hiking
  permission.

The adapter must fail on a missing `GlobalID`, schema drift, an empty or
unexpected feature count, unexpected park values, undocumented non-null coded
closure values, invalid point geometry, an entrance beyond the approved snap
tolerance, or an unresolved conflict. Layer metadata is native California State
Plane Zone 3 (`WKID 102643`, latest `2227`); the query requests EPSG:4326.

The entrance item publishes the same EBRPD disclaimer and no affirmative reuse
grant. It is local-evaluation-only and requires review or written permission
before derivative-pack redistribution. Its item, layer, and inspected-response
hashes are recorded in `ebrpd-park-entrances.json`; the actual build receipt
must also hash the bytes used.

The official [EBRPD maps page](https://www.ebparks.org/maps) remains the human
entry point for maps and current alerts. The official [Ohlone Wilderness page](https://www.ebparks.org/parks/ohlone)
documents the Mission Peak–Sunol–Ohlone–Del Valle corridor, including SFPUC
watershed segments where visitors must stay on the signed trail corridor. Those
web pages are supporting review material, not scraped build inputs. The Ohlone
page says the trail permit is not required starting in 2026; this time-sensitive
statement is not converted into segment access without a versioned,
machine-readable authority source.

The entrance layer provides explicit closure values for mapped entrances but is
not a complete trail-closure feed. No separate current-trail-closures API was
approved during this data-definition step. Activation therefore remains
blocked on a human closure review and any additional pinned source needed to
represent current prohibitions. Unknown access remains included by default and
can be explicitly disabled by the user.
