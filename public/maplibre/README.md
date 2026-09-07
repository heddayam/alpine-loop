# MapLibre worker assets

These two files are the browser worker pair from the installed `maplibre-gl`
dependency:

- `maplibre-gl-worker.mjs`
- `maplibre-gl-shared.mjs`

They are served locally because Next.js rewrites the package module URL during
bundling, so MapLibre cannot reliably infer the sibling worker URL. The files
retain MapLibre's BSD-3-Clause license header.

This directory is still required at runtime: the map explicitly loads
`/maplibre/maplibre-gl-worker.mjs`, which imports the shared module beside
it. The sync and check commands maintain these local files; they do not replace
them. This README is documentation only.

After upgrading the dependency, run `npm run maplibre:sync` to copy **both** files
together from the installed package's `dist/` directory. Commit the pair with
the dependency and lockfile changes.

`npm run maplibre:check` checks both files against the installed package without
writing anything and rejects missing or changed assets. The `predev` and
`prebuild` hooks run this check before starting the app or building it, and
`npm run verify` starts with the same check. If it fails after an upgrade, run
`npm run maplibre:sync` and review the updated pair.
