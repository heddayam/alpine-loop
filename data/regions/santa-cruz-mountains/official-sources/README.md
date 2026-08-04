# Santa Cruz Mountains official access sources

These records pin public, machine-readable authority endpoints inspected on
2026-08-04. Refresh code must download the query response explicitly, hash its
bytes, and pass the immutable local snapshot to the adapter. Runtime never calls
these services.

Only documented pedestrian/access fields are interpreted. A layer's presence
does not itself imply hiking permission. `metadataContentHash` hashes the public
item-metadata response at inspection time; pack manifests must instead record
the SHA-256 of the actual downloaded snapshot.

Licensing decisions are intentionally conservative:

- Midpen publishes a custom warranty disclaimer, not an affirmative reuse
  license. Local evaluation is allowed; redistribution needs review.
- California State Parks terms require attribution, restrict commercial use,
  and say materials may not be altered. Normalized derivative ingestion is
  blocked pending written permission.
- Santa Clara County Parks publishes no dataset-specific license on the item.
  Local evaluation is allowed; redistribution needs review.
- San Mateo County labels its dataset Public Domain, but the API currently
  advertises zero columns and returns empty geometries. Its adapter fails until
  the source is repaired.

USGS National Digital Trails is not used as access authority in the first pack:
it is an aggregator rather than the controlling land agency and adds no needed
evidence beyond the prioritized sources.
