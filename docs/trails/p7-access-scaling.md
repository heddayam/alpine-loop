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

## Deferred P6 integration

P6's runtime adapter must hydrate the same `RegionalTrailCatalog` fields (`namedTrails`,
`accessPoints`, and search summaries) before invoking search, and must retain full access features
for the lazy selected-detail response. It must not replace `accessPointIds` with representative IDs
or drop `connectedNodeIds` from the private/runtime artifact. No bucket listing or eager diagnostic
asset is required by this implementation.
