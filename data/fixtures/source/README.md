# Compiler source fixtures

These small synthetic JSON snapshots model the source shapes consumed by the
pack compiler tests. They are CC0-1.0 and deliberately contain no downloaded
OSM, agency, or elevation data.

The topology includes bidirectional, one-way, unknown-access, officially
overridden, and rejected ways. The official-access fixture identifies source
features by their external IDs. The elevation fixture is sampled locally with
deterministic nearest-neighbor interpolation.
