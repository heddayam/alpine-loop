# P7 access-point and response scaling

Status: implementation evidence for integrator review

## Product summarization

Canonical access features and `connectedNodeIds` remain unchanged. Search applies a product-only
25 m geographic-equivalence pass to access points inside the requested drive-time polygon. The pass
uses Earth-centered spatial cells, deterministic input ordering, and evidence rank `official >
mapped > derived`. A stronger point can represent a nearby weaker point, but its confidence and
source references are copied from that actual point; weaker evidence is never relabeled or merged
into the stronger point's provenance.

Each trail list item keeps the schema-v1 `accessPoints` field with at most two representatives and
adds `accessPointCount`, the geographically distinct total before representative limiting. The
selected geometry response is the lazy detail boundary and includes every original trail access
record with its confidence, source references, and canonical connected node IDs. This is compatible
with v1 Yosemite and v2 catalogs because summarization consumes the shared catalog model and does
not assume a manifest version or partition width.

## Reviewed budgets

- Search response: at most 448 KiB for the synthetic 24,029-access-point regional shape with 406
  searchable named trails and the API maximum 500-result limit.
- Search representatives: at most two per returned trail.
- Low-zoom map display: at most 200 markers at zoom 10 and below. Selection is retained first, then
  official, mapped, and derived markers, with stable access ID ordering. Zoom 11 and above shows all
  returned representatives.

The synthetic fixture constructs the measured 24,029-point shape in memory. It does not read or
commit cached regional corpora. Tests reverse both trail and access arrays to prove deterministic
response order, preserve selected markers, and assert response-byte and marker budgets.

## Prepared contour evaluation

Search prepares the submitted Polygon or MultiPolygon once, before evaluating regional access
points. Each ring retains its existing boundary-inclusive even/odd semantics while adding expanded
bounds and adaptive latitude bins. An edge is placed in every bin whose latitude range can affect;
very long-span edges are retained once in a separate list to bound index memory. Horizontal edges,
vertices exactly on bin boundaries, repeated vertices, hole boundaries, overlapping multipolygons,
and planar antimeridian-adjacent coordinates are covered by differential tests against the original
full-ring algorithm. A pathological long-span zigzag is also covered: its separate spanning-edge
list bounds index memory, but it does not guarantee a worst-case CPU reduction when most edges cross
most latitude bins. That case remains linear in the ring size and makes no candidate-reduction claim.

The deterministic representative performance fixture uses all 24,029 regional-shape access points
and a dense radial contour matching the local edge shape of typical provider polygons. For this
fixture only, the operation-count threshold is at least a 200x reduction from the naive point-count
times vertex-count candidate bound. Wall time is illustrative and is not a pass/fail assertion. One
full-suite run on the local Node test runtime reported:

| Contour | Naive edge bound | Prepared candidates | Reduction | Prepare | Classify | End-to-end search |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50,001 vertices | 1,201,474,029 | 1,276,990 | 941x | 79.1 ms | 21.4 ms | 193.9 ms |
| 200,000 vertices | 4,805,800,000 | 1,281,423 | 3,750x | 11.2 ms | 12.8 ms | 156.7 ms |

The single-run timings are hardware-, JIT-, GC-, and test-order-dependent; they are not a latency
guarantee or a Gate F threshold. The deterministic candidate counts provide the gating evidence for
the representative contour shape. The tests preserve the 8 MiB request and 200,000-vertex safety
ceilings; provider contours are not simplified.

## Deferred P6 integration

P6's runtime adapter must hydrate the same `RegionalTrailCatalog` fields (`namedTrails`,
`accessPoints`, and search summaries) before invoking search, and must retain full access features
for the lazy selected-detail response. It must not replace `accessPointIds` with representative IDs
or drop `connectedNodeIds` from the private/runtime artifact. No bucket listing or eager diagnostic
asset is required by this implementation.
