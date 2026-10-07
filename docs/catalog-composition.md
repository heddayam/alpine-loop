# Combining local prepared catalogs

Independently build each GMBA region with the preparation workflow, then combine
its complete local output with the existing catalog:

```sh
node scripts/compose-catalog.mjs \
  --output .local-data/mountains-combined \
  --name 'Washington and Bay Area mountains' \
  .local-data/mountains \
  .local-data/olympics \
  .local-data/bay-area
```

The output's parent directory must already exist. The output itself must be new
and outside every input directory. This command creates local data only; it does
not publish a catalog or replace the active app data.

All declared sections must be locally complete. The command copies their three
files unchanged and streams them through SHA-256, compressed-size, decoded-size
and gzip-integrity checks. It preserves the section IDs, file declarations,
names and exact boundaries. Duplicate section IDs are rejected, including
identical duplicates. Missing files, unsafe symbolic links, malformed section
paths and inconsistent catalog metadata fail closed. A failed composition removes
its newly created output; it never removes an existing output or changes inputs.
The combined `catalog.json` is written only after verification succeeds.

The combined catalog sums start counts, unions catalog bounds, and retains
distinct attribution and limitations. Its `sourceDate` is the earliest input
date; when dates differ, a limitation records the date range. Existing unavailable
areas remain disclosed with their original reasons. Compose independent region
catalogs with accurate coverage disclosures; the command does not infer whether
one input's unavailable area was prepared by another input.

`provenance.json` maps every source's section IDs and region IDs to its source date
and original catalog hash. `sources/<catalog-sha256>/` contains the original
`catalog.json`, available build `provenance.json`, and any earlier composition's
source archive, copied unchanged. Available section audit artifacts remain at
`audit/<section-id>/`. Provenance records copied artifact hashes and the verified
section-file totals. Missing build evidence is represented by the absence of
that artifact; composition does not create source or compiler evidence.

Check the composition boundary independently with offline fixtures:

```sh
node --test tests/data/compose-catalog.test.mjs
```
