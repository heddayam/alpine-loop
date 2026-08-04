# Wave 3 scenario fixtures

These files are small synthetic, CC0-1.0 fixtures. They model Santa Cruz
Mountains coordinates and source provenance without embedding downloaded OSM,
agency, or elevation data.

The suite exercises small and large hard rectangles, all four route shapes,
known-only and explicit uncertain access, impossible constraints with labeled
near misses, limits 1 through 20, budget exhaustion, stale freshness, keyboard
semantics, and the 3,000 ms typical-search budget. Access-point selectors are
resolved from the repository so the same scenario format can run against an
installed pack without hard-coded database IDs.

Run the committed offline fixture and print JSON to stdout:

```sh
npx tsx lib/qa/run-scenarios.ts \
  --suite data/fixtures/scenarios/santa-cruz-wave3.json \
  --fixture data/fixtures/scenarios/santa-cruz-wave3-graph.json
```

Run a compatible suite against a locally installed read-only pack:

```sh
npx tsx lib/qa/run-scenarios.ts \
  --suite data/fixtures/scenarios/santa-cruz-wave3.json \
  --database .local-data/packs/santa-cruz-mountains/<version>/pack.sqlite \
  --manifest .local-data/packs/santa-cruz-mountains/<version>/manifest.json
```

The command performs no network calls and does not write reports, databases,
caches, or generated packs.
