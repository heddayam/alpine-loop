# Cloudflare + Azure hosting

One Azure Ubuntu 24.04 VM runs the existing Docker app and a Cloudflare Tunnel.
Cloudflare handles DNS and public HTTPS on its free plan. There are no public
HTTP ports on the VM; SSH is restricted to the deployment computer's public IP.

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

Check `/health`, installed catalog coverage, search completion, GPX download,
browser reconnect, two-browser privacy, and restart persistence before publishing.
Observe VM memory and CPU credits as well as app memory. Container health checks
report failures; Docker restart policy restarts exited containers, not containers
that are merely unhealthy. Logs are capped at 30 MB per container.

For rollback, run Compose from the previous release directory with the same env
file and data mount. Do not restore old data just to roll back source code.

## Backups and recovery

Persistent storage is not a backup. Enable Azure VM Backup with a daily policy
and short retention, or manage independent snapshots of the data disk before
relying on the service for irreplaceable history. Backups add charges. Protect
the session secret and tunnel token separately; application-only backups do not
include `/etc/alpine-loop` on the OS disk. Confirm the first backup succeeds and
test a restore before describing backups as verified.

Restore disks to a separate VM, mount them before Docker starts, restore the
same session secret, and attach the existing tunnel. Do not inspect a live
container's SQLite WAL through the host filesystem. Restarts interrupt active
jobs and resume queued jobs rather than publishing partial results.

References: [Azure VM pricing](https://azure.microsoft.com/pricing/details/virtual-machines/linux/),
[Azure credits](https://learn.microsoft.com/azure/cost-management-billing/manage/mca-check-azure-credits-balance),
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/).
