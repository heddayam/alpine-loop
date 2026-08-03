# Hiking trail source coverage spike

Generated: 2026-08-03T22:19:42.541Z

This is a representative-source audit, not a full regional trail count. It samples five areas that exercise the data conditions Alpine Search will encounter from the Bay Area through the central Sierra.

## What the spike measures

- Named trail coverage and source-provided length/status/surface attributes
- Explicit hiking and public-access evidence (unknown is intentionally not treated as allowed)
- Geometry detail, Z coordinates, and endpoint snapping as indicators of routing readiness
- Native trailhead records and overlapping normalized names between sources
- Availability of a public USGS elevation lookup at a representative point

## Findings and ingestion decision

- Use USGS as the broad named-geometry baseline, but not as the sole authority for surface or access.
- In National Forest land, enrich or replace USGS attributes with the Forest Service layer; it consistently provides names, source length, surface, and strong hiking-use evidence.
- In Yosemite and other NPS units, use NPS for hiking use, status, and surface while retaining USGS/OSM names where NPS segments are unnamed.
- Use State Parks and EBRPD as named local geometry overlays, then validate hiking/public access from land-manager context because those simplified layers do not encode it explicitly.
- Preserve OSM node identity for the future routing graph and use its trailheads and surface tags, but clip it to relevant public recreation land and exclude explicitly restricted ways. Raw path/footway counts are far too broad to ship directly.
- Derive canonical distance from normalized geometry and elevation gain/loss from a common 3DEP elevation product. Do not mix source-specific length or elevation calculations.
- Treat trailhead/access-point construction as its own ingestion stage. OSM supplies some explicit trailheads, but none of the audited line layers supplies enough access points by itself.

## Bay Area — Midpen sample

Sample bounds: `-122.25, 37.15, -121.95, 37.45`

| Source | Features | Named | Hiking explicit | Public access explicit | Surface | Source length | Geometry | Topology | Shared endpoints | Trailheads |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USGS National Digital Trails | 298 | 100.0% | 95.0% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 76.0% | 0 |
| US Forest Service NFS Trails | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| National Park Service Public Trails | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| California State Parks Recreational Routes | 314 | 100.0% | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 81.5% | 0 |
| OpenStreetMap hiking network | 41419 | 2.9% | 3.6% | 0.7% | 35.4% | 0.0% | 0.0% | 99.9% | 54.5% | 4 |

Normalized-name overlaps:

- usgs ↔ state-parks: 46 shared names
- usgs ↔ osm: 22 shared names
- state-parks ↔ osm: 12 shared names

Elevation probe: 2867.3956879968164 feet at `37.1608, -121.9041`.

## Bay Area — East Bay sample

Sample bounds: `-122.1, 37.45, -121.75, 37.85`

| Source | Features | Named | Hiking explicit | Public access explicit | Surface | Source length | Geometry | Topology | Shared endpoints | Trailheads |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USGS National Digital Trails | 72 | 98.6% | 73.6% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 63.2% | 0 |
| US Forest Service NFS Trails | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| National Park Service Public Trails | 1 | 100.0% | 100.0% | 0.0% | 100.0% | 0.0% | 100.0% | 100.0% | 0.0% | 0 |
| California State Parks Recreational Routes | 57 | 100.0% | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 61.4% | 0 |
| East Bay Regional Park District Trails | 584 | 100.0% | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 60.2% | 0 |
| OpenStreetMap hiking network | 26203 | 2.5% | 2.5% | 0.2% | 25.4% | 0.0% | 0.0% | 99.9% | 56.5% | 2 |

Normalized-name overlaps:

- ebrpd ↔ osm: 117 shared names
- usgs ↔ state-parks: 11 shared names
- usgs ↔ osm: 6 shared names
- state-parks ↔ ebrpd: 3 shared names
- usgs ↔ nps: 1 shared names

Elevation probe: 2510.0208194578026 feet at `37.5124, -121.8807`.

## Sierra National Forest sample

Sample bounds: `-119.35, 36.95, -118.85, 37.45`

| Source | Features | Named | Hiking explicit | Public access explicit | Surface | Source length | Geometry | Topology | Shared endpoints | Trailheads |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USGS National Digital Trails | 747 | 100.0% | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 84.3% | 0 |
| US Forest Service NFS Trails | 373 | 100.0% | 88.7% | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 29.7% | 0 |
| National Park Service Public Trails | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| California State Parks Recreational Routes | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| OpenStreetMap hiking network | 608 | 43.6% | 21.4% | 0.0% | 16.1% | 0.2% | 0.0% | 88.8% | 31.9% | 25 |

Normalized-name overlaps:

- usgs ↔ usfs: 280 shared names
- usgs ↔ osm: 99 shared names
- usfs ↔ osm: 99 shared names

Elevation probe: 9098.278747306329 feet at `37.2946, -119.1038`.

## Yosemite–Stanislaus sample

Sample bounds: `-120.1, 37.55, -119.35, 38.15`

| Source | Features | Named | Hiking explicit | Public access explicit | Surface | Source length | Geometry | Topology | Shared endpoints | Trailheads |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USGS National Digital Trails | 1492 | 48.3% | 74.2% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 76.2% | 0 |
| US Forest Service NFS Trails | 292 | 100.0% | 99.0% | 0.0% | 99.7% | 100.0% | 100.0% | 100.0% | 6.3% | 0 |
| National Park Service Public Trails | 1049 | 46.7% | 98.8% | 0.0% | 100.0% | 0.0% | 100.0% | 100.0% | 87.3% | 0 |
| California State Parks Recreational Routes | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| OpenStreetMap hiking network | 1509 | 30.4% | 18.9% | 0.0% | 38.8% | 0.1% | 0.0% | 97.5% | 50.5% | 55 |

Normalized-name overlaps:

- usgs ↔ usfs: 93 shared names
- usgs ↔ nps: 91 shared names
- usgs ↔ osm: 78 shared names
- nps ↔ osm: 50 shared names
- usfs ↔ osm: 36 shared names

Elevation probe: 3966.368153856192 feet at `37.7459, -119.5936`.

## Tahoe–Eldorado sample

Sample bounds: `-120.4, 38.6, -119.85, 39.15`

| Source | Features | Named | Hiking explicit | Public access explicit | Surface | Source length | Geometry | Topology | Shared endpoints | Trailheads |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USGS National Digital Trails | 2397 | 97.2% | 11.6% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 89.1% | 0 |
| US Forest Service NFS Trails | 534 | 100.0% | 85.2% | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 41.0% | 0 |
| National Park Service Public Trails | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| California State Parks Recreational Routes | 218 | 100.0% | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 100.0% | 76.8% | 0 |
| OpenStreetMap hiking network | 2710 | 23.0% | 25.9% | 1.3% | 60.4% | 0.0% | 0.0% | 99.7% | 36.9% | 22 |

Normalized-name overlaps:

- usgs ↔ usfs: 290 shared names
- usgs ↔ osm: 107 shared names
- usfs ↔ osm: 106 shared names
- usgs ↔ state-parks: 26 shared names

Elevation probe: 6254.607473359375 feet at `38.9341, -120.0418`.

## Interpretation rules

- A low explicit-hiking percentage does not mean hiking is forbidden; it means that source does not reliably encode permission and must be combined with an official/public-land source.
- Shared endpoints are only a rough topology signal. The production graph must retain OSM node identity where available and snap official geometries under controlled tolerances.
- Source length is audited but will not be trusted as the canonical value. Alpine Search should calculate geodesic length from normalized geometry.
- Z coordinates are not expected to be complete or consistent. Elevation gain should be derived from a common DEM with smoothing and documented sampling resolution.
- A trail line intersecting a drive-time polygon is not sufficient. Search eligibility will require a credible trailhead, entrance, or derived public access point inside the polygon.

## Source endpoints

- USGS National Digital Trails: https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37
- US Forest Service NFS Trails: https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0
- National Park Service Public Trails: https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0
- California State Parks Recreational Routes: https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/RecreationalRoutes/FeatureServer/0
- East Bay Regional Park District Trails: https://services2.arcgis.com/jeEP9c9zZoQQwtck/ArcGIS/rest/services/DistrictTrails_ByTrailName/FeatureServer/0
- OpenStreetMap hiking network: https://overpass-api.de/api/interpreter
