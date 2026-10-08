#!/bin/bash
# Run locally from the checkout: deploy/release.sh user@VM_IP /path/to/ssh-key
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:?Pass the SSH destination}
key=${2:?Pass the SSH key path}
revision=$(git rev-parse --short=12 HEAD)
ssh_options=(-i "$key" -o StrictHostKeyChecking=yes)
if [[ -n ${ALPINE_KNOWN_HOSTS:-} ]]; then ssh_options+=(-o "UserKnownHostsFile=$ALPINE_KNOWN_HOSTS"); fi
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
git archive HEAD > "$archive"
scp "${ssh_options[@]}" "$archive" "$target:/tmp/alpine-$revision.tar"
ssh "${ssh_options[@]}" "$target" bash -s -- "$revision" <<'REMOTE'
set -euo pipefail
revision=$1
release=/srv/alpine-loop/releases/$revision
sudo mkdir -p "$release"
sudo tar -xf "/tmp/alpine-$revision.tar" -C "$release"
rm "/tmp/alpine-$revision.tar"
cd "$release"
sudo env ALPINE_VERSION="$revision" docker compose --env-file /etc/alpine-loop/app.env -f compose.hosted.yaml build
# Build succeeds before replacing the running app. Existing jobs stay on the data disk.
sudo env ALPINE_VERSION="$revision" docker compose --env-file /etc/alpine-loop/app.env -f compose.hosted.yaml up -d --wait --wait-timeout 900
sudo ln -sfn "$release" /srv/alpine-loop/current
sudo env ALPINE_VERSION="$revision" docker compose --env-file /etc/alpine-loop/app.env -f compose.hosted.yaml ps
REMOTE
