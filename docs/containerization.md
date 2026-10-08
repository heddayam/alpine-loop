# Local containers and prepared data

Install and open [OrbStack](https://docs.orbstack.dev/install) (recommended for Mac)
or [Docker Desktop](https://docs.docker.com/get-started/get-docker/) (Mac, Windows or Linux).
Both include Docker and Compose.
From the repository folder:

```sh
docker compose up --build
```

Open http://127.0.0.1:3000. The app obtains its pinned catalog automatically;
**Download and search** downloads complete selected regions. All nine regions
use 138,934,836 compressed trail bytes, plus a roughly 2.4 MB catalog. Preparation
is a maintainer release step; normal startup requires no geospatial tools,
accounts, keys or catalog configuration.

## Run and retain data

```sh
docker compose up --build -d --wait
docker compose logs -f app
docker compose down
```

`--wait` waits for HTTP readiness. Saved jobs, complete regions and verified
staged download files live in the `alpine-data` named volume. Ordinary shutdown
and container/image recreation retain it. `docker compose down --volumes`
explicitly deletes this storage, including saved jobs. Jobs can grow well beyond
the trail download size; delete unwanted jobs through the app to reclaim space.

To run alongside a native app already on port 3000:

```sh
ALPINE_PORT=3001 docker compose up --build -d --wait
```

Open http://127.0.0.1:3001. Native `.local-data` and Docker storage are separate;
this does not import existing native history. One app process owns each job store.
Use the same project directory/name to reuse the same Compose volume. HTTP is
published only on the host's loopback interface.

A single two-stage Node 24 image builds the frontend and server once, retains
only production dependencies and runs as a non-root user. SQLite and workers run
in that process; no database, queue or proxy service is needed. `.dockerignore`
allows only image inputs, so local jobs, datasets, source caches and secrets do
not enter the build context. The pinned official base supports Linux ARM64 and
amd64. Application hosting is still deferred.

React and MapLibre are build dependencies; the runtime retains only server
packages and the bundled frontend. Builds generate Brotli/gzip versions of text
assets, and fingerprinted assets use a one-year immutable browser cache while
HTML and API metadata stay fresh. Healthchecks run every 60 seconds after
startup, with five-second checks during the startup grace period. Native
`npm ci` records its installation so the next `npm start` reuses it; startup
checks build-output metadata rather than reading every output file.

## Network failures, restarts and updates

The catalog URL and SHA-256 are pinned in `scripts/data-release.json`. A verified
cached catalog is reused without contacting GitHub. Catalog failures retain the
previous catalog and allow the server to open saved jobs; check the logs and
restart to retry. A fresh offline launch has no searchable regions until its
catalog succeeds. The map's external basemap still needs network access.

Section downloads validate compressed size, SHA-256, gzip integrity and decoded
size before installing a complete section. Cancellation/failure exposes no
partial region; retry reuses whole verified files. A stop during catalog download
aborts and removes its temporary file. Docker's init forwards signals and the
server closes workers and databases on shutdown. Restart interrupts a running
job and continues queued jobs. Completed URLs and GPX depend on saved geometry,
so they remain usable if trail sources are unavailable or replaced.

After pulling app updates, run `docker compose up --build -d --wait`. Each app
version retains its particular data release; new releases never replace old
assets. Matching section files are reused. Avoid changing an active catalog or
opening a live container's database through the host filesystem.

## Publish prepared data (maintainers)

Prepare and compose complete regions using the [preparation guide](../tools/prepare/README.md).
Keep preparation output separate from live runtime storage. Then create a new
package with a new immutable tag and a destination that does not exist:

```sh
node scripts/package-data.mjs .local-data/mountains .local-data/release-next OWNER/REPO NEW_DATA_TAG
```

The packager uses the existing composition verifier to check every declared
file's compressed/decoded size, SHA-256 and gzip integrity. It preserves section
IDs, local paths and bytes; explicit per-file URLs map them to flat GitHub asset
names. It includes attribution, limitations, a checksum manifest and separate
optional source/provenance/audit evidence. Personal jobs, undeclared files and
raw source caches are excluded. Failed verification removes only the new output;
existing destinations and inputs are never overwritten.

For metadata-only updates, retain existing per-file URLs and checksums. The
packager verifies the local files but reuses those published assets without
uploading another copy. Keep every referenced release available.

Create a **draft** GitHub release with these files and `DATA.md` as its notes,
marking it as a data release rather than the latest app release. Compare every
uploaded asset's size and SHA-256 with the local package before publishing.
After publication, verify unauthenticated catalog and section downloads. Only
then copy the generated `data-release.json` into `scripts/data-release.json` and
commit the small descriptor with the application. Generated release files stay
outside Git. Test a source-only checkout and empty Docker volume before merging.

The current catalog is
[data-v2-2026-10-07-state-first](https://github.com/heddayam/alpine-loop/releases/tag/data-v2-2026-10-07-state-first).
It adds explicit state, mountain-range and section labels and reuses all 27 trail
assets from the first release,
[data-v2-2026-10-07-01a60e85](https://github.com/heddayam/alpine-loop/releases/tag/data-v2-2026-10-07-01a60e85).
GitHub permits up to 1,000 assets per release, each under 2 GiB; the first package uses
32 assets and the metadata update uses five, with the optional evidence archive around 69 MB and every runtime
trail asset under 20 MB. See [GitHub release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Verification on 2026-10-07

- Built the final image for Linux ARM64 (94,418,341 bytes) and amd64
  (94,547,170 bytes); runtime UID is 1000. No dependencies were added.
- Launched Compose from source-only files with an empty volume. Automatic
  anonymous catalog acquisition succeeded; all nine regions initially showed
  missing, then all 27 trail assets downloaded and passed app verification.
- A real Pantoll search explored its selected start and completed with 161 hike
  groups. Saved route JSON and GPX SHA-256 stayed unchanged after container
  recreation. A running Olympic search became interrupted; its queued successor
  completed. All downloaded regions remained ready.
- With Docker networking disabled, cached catalog/regions and saved route/GPX
  remained available. A simulated unavailable catalog update retained the prior
  catalog and saved results and left no partial catalog file.
- Native `npm start` installed, built and fetched the real catalog from the same
  clean source copy. The temporary native server, test containers and scratch
  Docker volume were removed; the existing native app was left running.
- Build, typecheck and the offline suite passed. Focused checks protect flat
  asset URLs, immutable packaging, corrupt input/output cleanup and cancellation
  of catalog downloads. Maintained source is 9,424 lines in 50 files, up 88 lines
  and two files from main, including the release packager and shared bootstrap.
