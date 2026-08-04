# MapLibre worker assets

These two files are the browser worker pair from `maplibre-gl` 6.1.0:

- `maplibre-gl-worker.mjs`
- `maplibre-gl-shared.mjs`

They are served locally because Next.js rewrites the package module URL during
bundling, so MapLibre cannot reliably infer the sibling worker URL. When the
dependency is upgraded, replace both files together from
`node_modules/maplibre-gl/dist/`. The files retain MapLibre's BSD-3-Clause
license header.
