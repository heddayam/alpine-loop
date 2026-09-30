# Access-entry source audit fixtures

These are bounded, original source records, not independently exhaustive entrance labels.
OSM data © OpenStreetMap contributors, licensed under [ODbL](https://www.openstreetmap.org/copyright).
No coordinates, tags, source node references, or way references were edited.

Pinned input snapshots: Geofabrik Washington and Northern California, `260801`.

| Source | SHA-256 | Bytes |
| --- | --- | ---: |
| Washington | `3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e` | 359826867 |
| Northern California | `215f18449e6cd190200a7dc1188a63dba2bec1f20fb3d1637c4f11c1f9134342` | 648017783 |

Each OPL file was extracted with Osmium 1.19.1, including every referenced node:

```sh
osmium getid INPUT.osm.pbf WAY_IDS --add-referenced --output-format=opl --output=OUTPUT.opl
```

| Fixture | Source / `WAY_IDS` | Observation |
| --- | --- | --- |
| `norcal-track-area.opl` | NorCal / `w356872374` | Closed `area=yes,highway=track` footprint; cannot create a walking perimeter circuit. Outside currently offered California footprints. |
| `sunol-interior-track.opl` | NorCal / `w95489692 w1375487753` | Indian Joe Creek Trail track/path contact at `n1107300663`; a track tag alone does not establish trip-start identity. |
| `sunol-interior-rooted-approach.opl` | NorCal / `w6388803 w6389308 w122293236 w122293238 w95489689 w95489692 w1375487753 w127025904` | The complete ordinary-road/unknown-track approach to that interior contact, including known-foot path contacts. Prevents mistaking a reduced fixture's missing root for a policy fix. |
| `alum-rock-stepping-stones.opl` | NorCal / `w121247885 w121247883` | Track with `ford=stepping_stones,foot=yes,motor_vehicle=no` at `n1357853410`; source physical function is a pedestrian creek crossing. |
| `alum-golf-turning-circle.opl` | NorCal / `w1044401800 w1044401801` | Turning-circle nodes on golf cart paths, with no arrival-road contact; turning-circle metadata alone cannot manufacture an entry. |
| `discovery-restricted-turning-circle.opl` | Washington / `w268402204 w268402206` | Turning circle at public-foot hiking path joined only to private-foot, motor-prohibited service; place metadata does not erase the mapped approach restriction. |
| `tiger-generic-mtb-oneway.opl` | Washington / `w970528918 w970528919` | Generic one-way paths with mountain-bike context and no explicit foot direction; pedestrian reverse permission remains unknown. |
| `tiger-private-road-trail-contact.opl` | Washington / `w6448402 w446699559` | Public-foot trail connects to a private residential road at `n4439373012`; original trail note identifies a no-trespassing sign on that approach. Neither known motor nor foot restrictions may be erased by the trail's public departure. |
| `denny-foot-service-frontier.opl` | Washington / `w340010580 w6324285 w607609231 w607609232 w61990373 w232089623 w367185057` | Actual road/service/path approach and permitted walking across a vehicle-closed bridge at `n1969228635`. |
| `top-lake-connected-approach.opl` | Washington / `w428036699 w372544732 w5846768 w428034416 w427905142 w1356527414` | Full mapped track approach from an ordinary unclassified road to actual trailhead `n3761092329`; the road-end `n3761092325` has only `highway=turning_circle`. All four approach tracks have unknown foot/motor permission. |

`study-windows.json` fixes six windows selected before examining detector output, across
urban forest park, forest foothill, mountain valley, and California foothill contexts.
The CLI extracts these complete source ways with 0.008° context padding and checks reuse
against the entire pinned PBF hash and exact extraction geometry. This exceeds the 500 m
building-count radius in these windows. It does not guarantee complete arrival-spine context.
The Top Lake fixture is a separate known-anchor diagnosis, not a held-out accuracy case.
The six windows were subsequently used to diagnose and correct implementation assumptions;
their final rerun is regression evidence, not an untouched regional accuracy holdout.
