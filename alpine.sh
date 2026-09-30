#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

usage() {
  cat <<'EOF'
Usage: ./alpine.sh [COMMAND]

  (no command)                     Choose hiking areas to preview or build.
  app                              Start the app.
  regions                          List configured hiking areas.
  plan REGION [REGION...]           Preview areas without processing source data.
  build REGION [REGION...] [--rebuild]
                                   Prepare and publish selected areas, one at a time.
  status [report.json] [--watch]     Show the current or last area build.
  help                             Show this help without starting Docker.

Area commands update the Docker data-tooling image before running.
Set ALPINE_SOURCE_CACHE to a container path to reuse a different source cache.
EOF
}

action="${1:-menu}"
if (( $# > 0 )); then shift; fi
case "$action" in
  menu)
    if [[ ! -t 0 || ! -t 1 ]]; then usage; exit 0; fi
    ;;
  help|--help|-h)
    usage
    exit 0
    ;;
  app|regions)
    if (( $# > 0 )); then usage >&2; exit 1; fi
    ;;
  plan|build)
    has_region=false
    for argument in "$@"; do
      if [[ "$argument" != --* ]]; then has_region=true; fi
    done
    if [[ "$has_region" != true ]]; then usage >&2; exit 1; fi
    ;;
  status) ;;
  *) usage >&2; exit 1 ;;
esac

command -v docker >/dev/null || { echo 'Install Docker with Docker Compose first.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker, then run ./alpine.sh again.' >&2; exit 1; }
[[ -f .env ]] || cp .env.example .env

if [[ "$action" == app ]]; then
  mkdir -p .local-data/releases
  docker compose up --build -d app
  printf '\nAlpine Loop is running. Open Coverage in the app to download map sections.\n'
else
  mkdir -p .cache .local-data/releases
  data_command=(docker compose run --rm --build)
  if [[ -n "${ALPINE_SOURCE_CACHE:-}" ]]; then
    data_command+=(-e "ALPINE_SOURCE_CACHE=$ALPINE_SOURCE_CACHE")
  fi
  if [[ "$action" == menu ]]; then
    printf '\nLoading configured hiking areas...\n'
    region_listing=$("${data_command[@]}" data scripts/data.ts regions)
    region_ids=()
    region_names=()
    while IFS=$'\t' read -r id name; do
      if [[ -n "$id" && -n "$name" ]]; then
        region_ids+=("$id")
        region_names+=("$name")
      fi
    done <<< "$region_listing"
    if (( ${#region_ids[@]} == 0 )); then
      echo 'No configured hiking areas were returned.' >&2
      exit 1
    fi
    printf '\nChoose hiking areas. Use ./alpine.sh app to start the app.\n\n'
    for index in "${!region_ids[@]}"; do
      printf '%2d) %s\n' "$((index + 1))" "${region_names[index]}"
    done
    read -r -p $'\nArea numbers (spaces or commas), all, or Enter to quit: ' selection || exit 0
    read -r -a choices <<< "${selection//,/ }"
    if (( ${#choices[@]} == 0 )) || [[ "${choices[0]}" == q ]]; then exit 0; fi
    selected_ids=()
    selected_names=()
    if (( ${#choices[@]} == 1 )) && [[ "${choices[0]}" == all ]]; then
      selected_ids=("${region_ids[@]}")
      selected_names=("${region_names[@]}")
    else
      seen=' '
      for choice in "${choices[@]}"; do
        if ! [[ "$choice" =~ ^[1-9][0-9]*$ ]] || (( ${#choice} > 6 || choice > ${#region_ids[@]} )); then
          echo "Invalid area number: $choice" >&2
          exit 1
        fi
        if [[ "$seen" == *" $choice "* ]]; then
          echo "Choose each area only once: $choice" >&2
          exit 1
        fi
        seen+="$choice "
        selected_ids+=("${region_ids[choice - 1]}")
        selected_names+=("${region_names[choice - 1]}")
      done
    fi
    printf '\nSelected areas:\n'
    printf '  %s\n' "${selected_names[@]}"
    read -r -p $'\n[p]review (default), [b]uild, or [q]uit: ' operation || exit 0
    case "$operation" in
      ''|p|plan) action=plan ;;
      b|build) action=build ;;
      q) exit 0 ;;
      *) echo "Unknown action: $operation" >&2; exit 1 ;;
    esac
    set -- "${selected_ids[@]}"
  fi
  exec "${data_command[@]}" data scripts/data.ts "$action" "$@"
fi
