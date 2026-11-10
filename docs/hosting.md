# Cloudflare + Azure hosting

One Azure Ubuntu 24.04 VM runs the existing Docker app and a Cloudflare Tunnel.
Cloudflare handles DNS and public HTTPS on its free plan. There are no public
HTTP ports on the VM; SSH is restricted to the deployment computer's public IP.

## Current release and development workflow

Last verified live code on November 10, 2026 (Pacific time):
`516c48283d297c32d88926ee491a1f98f80d737d` (Automatic search-area outline visibility).
The VM is `alpine-loop-01` in resource group `alpine-loop-prod`, West US 2.
Its release directory is `/srv/alpine-loop/releases/516c48283d29`, selected by
`/srv/alpine-loop/current`. Confirm the symlink and running app image before a
new deployment; this record is not a live probe.

The hosting implementation, retained app features and simplified access-point
preparation are integrated into `main`. Use main as the normal base for new
`codex/` work branches. The former hosting branch is retired; its integrated
source remains in main's history.

The November 6 (Pacific time) data release rebuilt all nine sections with
simple developed-land, parking-contact and supporting-network rules, while
preserving distinct eligible entrances. All 551 mapped trailheads remain. Local
verification is recorded in
[`benchmarks/release-verification-2026-11-07.json`](../benchmarks/release-verification-2026-11-07.json).
The pinned data release is `data-v2-2026-11-07-access`, with catalog SHA-256
`4d2ef9bd95383ff619a43a24d4a5a9ab13da901813c08b78c45e500ffa0821df`.
Source integration alone does not deploy the site.

| Action | What changes |
| --- | --- |
| Build and run locally | The local app; Azure and public visitors are unaffected |
| Commit, push, or merge | Git history and GitHub; the public app is unchanged |
| Deploy a committed revision | The Azure containers serving alpineloop.org |
| Prepare a region locally | Local generated files; hosted coverage is unchanged |
| Publish data, update the pinned catalog, and deploy | The hosted coverage |

Ordinary development starts with `npm start` (Node 24+) or local
`docker compose up --build -d --wait`. Native launch builds changed source
automatically; restart it after changes so server modules also reload. Before
calling an app fix complete, build, typecheck, and check its affected browser flow.
Native `.local-data`, local Docker's named volume, and Azure's data disk are
separate stores. Never point parallel servers at the same jobs directory.

Deploy when the user requests a live update or the active task includes a
production release. There is no automatic GitHub deployment and no separate
hosted staging site today. Hosted-only behavior requires hosted fixtures or an
isolated HTTPS preview; localhost HTTP cannot exercise the HTTPS mutation rules.
After an authorized release, verify its public behavior and record the deployed
commit here. Documentation-only changes do not require a production rebuild.

## Starting size and costs

Start with `Standard_B2ats_v2` in West US 2: two burstable CPUs and 1 GiB RAM,
approximately $6.86/month at 730 hours using Microsoft's October 8, 2026 retail
rate. The older 2 GiB B1ms is restricted for this subscription in the US regions
checked. A 4 GiB B2als v2 costs approximately $27.45/month for compute alone.

Use 32 GiB Standard SSD OS and data disks and a Standard public IP. Plan for
roughly $15–20/month before backups or unusual transfer, then verify actual
charges in Azure Cost Management. Rates, capacity, and credit eligibility can
change. Azure bills running VMs hourly without a reservation. Deallocating stops
compute charges but takes the site offline; disks and reserved public IPs continue
to bill. This deployment does not scale to zero between searches.

Daily VM Backup adds a protected-instance charge and backup storage. Budget
roughly $20–25/month altogether for light use and check the actual invoice.

Check credit eligibility and expiration in the billing profile. Credits are used
before the default payment method for eligible charges; expiration does not
automatically stop the server. Keep account-specific balances out of source control.

The small VM is for initial light traffic. Only one FIFO search executes at a
time. Memory admission is separate from route constraints: the existing worker
memory watchdog fails excessive searches honestly. The VM has 2 GiB swap for
startup spikes; swap is no substitute for measuring memory under real traffic.
Resize the VM if memory pressure, sustained CPU throttling, or long queues
justify it. Changing VM size preserves the attached data disk.

## Storage and access

- The separately attached data disk mounts at `/srv/alpine-loop/data`; prepared
  trails and durable jobs live there. It detaches rather than deletes with the VM.
- Docker requires the data mount before starting, preventing an accidental empty
  history on the OS disk. Never run a second app against the same job directory.
- `/etc/alpine-loop/app.env` holds a persistent `ALPINE_SESSION_SECRET` of at least
  32 bytes. Keep it unchanged across releases and restores. It must be root-owned
  and mode 600. Never commit secrets or `docker compose config` output.
- Optional `ARCGIS_API_KEY` in the same env file enables driving-time filtering.
  Use an ArcGIS Location Platform key with routing service access. The key stays
  on the server; without it, ordinary searches remain available. Native `npm start`
  also reads the ignored root `.env`, with environment variables taking precedence.
  Local Compose forwards the same optional key.
- Driving areas use ArcGIS direct `solveServiceArea` for 5–60 minutes and
  `GenerateServiceAreas` jobs for 61–240 minutes, one origin and one cutoff per
  request. Both preserve local roads without hierarchy. The app conservatively
  reserves each uncached submission against a
  persistent limit of 4,500 per UTC calendar month. Failed or cancelled submissions
  are not refunded, and deleting jobs does not reset usage. Identical areas are
  reused for 30 minutes in a bounded memory cache. ArcGIS currently includes
  [5,000 returned service areas per month](https://developers.arcgis.com/pricing/)
  on Location Platform; account usage from other apps or installations is outside
  this app's counter. Keep the key dedicated and verify account billing limits
  before enabling the public service.
- `/etc/alpine-loop/tunnel-token` holds the tunnel-only token. Its parent is mode
  700; the file is mode 444 so the unprivileged cloudflared container can read its
  bind-mounted secret. It is never baked into the image.
- Hosted mode installs all published trail sections at startup, verifying the
  pinned catalog and file checksums. Visitors do not administer downloads.
- Anonymous signed cookies isolate job history and management. Clearing cookies
  loses that browser's management rights. Completed result URLs are shareable;
  unfinished searches stay private. There are no accounts or cross-device login.
- Each browser may queue two searches, with twenty pending globally. New searches
  pause below 1 GiB free disk; retained history is never automatically deleted.
- Browsers fetch basemap tiles directly from the existing
  [Maptoolkit Community service](https://www.maptoolkit.org/). It requires no API
  key; its license eligibility, visible attribution, and fair-use conditions apply.

## Deploy and verify

`deploy/azure-cloud-init.yaml` installs Docker and mounts data disk LUN 0. Never
attach a disk with unrelated data: the script initializes only an unformatted
disk and requires ext4 for an existing filesystem.

Create the resource group, VM, disks, and an SSH rule limited to your public IP.
Use a dedicated SSH key outside Git and verify its host key through Azure Run
Command before the first SSH connection. Update the SSH rule when your IP changes.

On the VM, generate the session secret, install the tunnel token, and keep both in
`/etc/alpine-loop`. The Compose file requires these before starting. Configure the
Cloudflare tunnel's public hostnames `alpineloop.org` and `www.alpineloop.org` to
`http://app:3000` and retain its final `http_status:404` catch-all. Preserve the
existing DMARC record. Cloudflare's assigned nameservers are
`tina.ns.cloudflare.com` and `watson.ns.cloudflare.com`.

After committing changes locally:

```sh
deploy/release.sh azureuser@VM_PUBLIC_IP /absolute/path/to/deployment-ssh-key
```

The release script archives committed source only, builds before replacing the
running app, and keeps earlier release directories. Build failure leaves the
current containers running. The user’s uncommitted changes are not published.
Deploying interrupts a running search; queued searches continue after restart.

If the source-IP rule blocks SSH, Azure VM Run Command can run the same build
and Compose commands. Download the public GitHub source archive pinned to a full
commit SHA into a new release directory; keep the secret env file and existing
data mount on the VM. This avoids widening inbound SSH access.

Check `/health`, installed catalog coverage, search completion, GPX download,
browser reconnect, two-browser privacy, and restart persistence before publishing.
Observe VM memory and CPU credits as well as app memory. Container health checks
report failures; Docker restart policy restarts exited containers, not containers
that are merely unhealthy. Logs are capped at 30 MB per container.

For rollback, run Compose from the previous release directory with the same env
file and data mount. Do not restore old data just to roll back source code.

## Backups and recovery

Azure VM Backup is enabled in the `alpine-loop-backup` Recovery Services vault
in the `alpine-loop-prod` resource group. Its `DefaultPolicy` runs daily at
08:00 UTC and keeps daily recovery points for 30 days, with no weekly, monthly,
or yearly retention. The vault uses locally redundant storage. No disks are
excluded: the OS disk includes `/etc/alpine-loop`, and the data disk includes
prepared trails and durable history. Backups add charges.

Check the first backup job and recovery point in the vault. A restore drill has
not yet been performed; a successful backup alone does not verify recovery.
Keep the session secret and tunnel token protected during any export or restore.

Restore disks to a separate VM, mount them before Docker starts, restore the
same session secret, and attach the existing tunnel. Do not inspect a live
container's SQLite WAL through the host filesystem. Restarts interrupt active
jobs and resume queued jobs rather than publishing partial results.

## Deployment verification

The November 10 release `516c48283d29` automatically checks **Show search
area** when areas are selected, drawn, changed, copied or reopened. Manual hiding
survives unrelated route-limit edits. Build, typecheck and 20 focused checks pass.
Local browser checks cover region/driving edits, drawing/clear, saved-result URLs
and copied settings. The public browser verified automatic outlines, manual
hiding, drawing and saved-result reload, with no extra searches or JavaScript
errors. The developer access-point overlay remains disabled.

The release used Azure Run Command without changing the SSH access rule. The
verified release symlink and healthy image identify `516c48283d29`; both
public HTTPS hostnames pass health checks, all nine sections remain installed,
and the prior public GPX is byte-for-byte identical.

The follow-up `9074d9b82eaf` release makes access-point inspection a local
developer tool. `ALPINE_DEV_ACCESS_POINTS=1` enables it locally; hosted mode
always disables its layer, toggle and API, even with the flag set. Build,
typecheck and 30 focused app/hosted checks pass. Local browsers verified both
flag states. The public browser shows no overlay/control, makes zero access-point
requests and has no JavaScript errors; the developer API returns 404. At verification, its
image and release symlink matched that revision, health passed, and the prior public
GPX remains byte-for-byte identical.

The earlier November 6, 2026 release built successfully on Azure and passed public HTTPS
verification on both hostnames. All nine rebuilt sections are installed, with
10,558 eligible starts and all 551 prior mapped trailheads retained. That release used
image and release symlink `df5c4888ef01`. The original data mount
and session secret are preserved.

A public Horse Lake search returned three hikes; GPX, saved-URL reload, secure
cookies, isolated browser histories and rejected foreign/missing-origin mutations
passed in the browser. A real 30-minute Hoh driving search returned 34 hikes from
one eligible start; its saved area contains the start, and another browser cannot
see the precise driving origin. A previously saved public GPX remains byte-for-byte
identical, and its original browser cookie retains management rights. The ten
pre-existing searches remain completed; no search was active or queued at release.
The driving-service key was added through encrypted SSH input while preserving
the existing root-owned, mode-600 environment file and session secret.

Local validation includes build/typecheck, the offline suite, focused checks
after the map-cancellation fix, independent geometry audits of all sections,
55 source-verified real hikes, and an isolated hosted HTTPS browser preview.
All 14 existing local result files remain untouched and an old GPX still opens.
See the release verification report linked above.

### October 8 baseline

The October 8, 2026 deployment passed 27 focused runtime checks, build, and
typecheck. On Azure, all nine published sections were installed; a real bounded
Horse Lake search completed with four hikes, and GPX download, isolated browser
histories, forbidden foreign mutations, and ownership after restart passed.
The same search and privacy checks passed through public Cloudflare HTTPS.
Both `alpineloop.org` and `www.alpineloop.org` served a valid HTTPS health response.
The public browser displayed the completed hikes, map, elevation profile, and GPX link.
A search submitted from the public UI completed with five hikes in 25 seconds;
reloading its stable result URL restored the results and browser-owned history.
HTTP requests redirect to HTTPS at Cloudflare.
The blue header and coordinated accents are committed on `main` and included
in the deployed hosting branch; the live header and primary buttons were checked
as `#245b78` after rebuilding and reloading the public site.

A separate local container completed all 10,187 starts across five Washington
sections and stored 918 routes in about 35 minutes, peaking at 363 MiB of app
container memory. This was a local resource check, not an Azure throughput
measurement. The initial Azure snapshot recovery point is valid; its first vault
transfer was still running when this report was recorded. See
[`benchmarks/hosting-verification-2026-10-08.json`](../benchmarks/hosting-verification-2026-10-08.json).

References: [Azure VM pricing](https://azure.microsoft.com/pricing/details/virtual-machines/linux/),
[Azure Backup pricing](https://azure.microsoft.com/pricing/details/backup/),
[Azure credits](https://learn.microsoft.com/azure/cost-management-billing/manage/mca-check-azure-credits-balance),
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/).

## Branch cleanup, November 10, 2026

Main is the only remaining local and remote branch after review. Eleven local
branches, nine remote branches and three clean detached task worktrees were
removed. No applicable unmerged or ongoing work was found: squashed changes are
already in main, and superseded experiments were not restored. Exact unmerged
branch/worktree heads are preserved under `archive/branch-cleanup-2026-11-10/`;
the retired pack-tools fix retains its existing October 5 archive tag. Existing
archive tags were preserved.
