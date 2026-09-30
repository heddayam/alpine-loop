#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v docker >/dev/null || { echo 'Install Docker with Docker Compose first.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker, then run ./alpine.sh again.' >&2; exit 1; }
[[ -f .env ]] || cp .env.example .env
mkdir -p .local-data/releases
# Coverage installation is managed in the app; this launcher needs no source compiler.
docker compose up --build -d app
printf '\nAlpine Loop is running. Open Coverage in the app to download map sections.\n'
