#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

command -v docker >/dev/null || { echo 'Install Docker with Docker Compose first.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker, then run ./alpine.sh again.' >&2; exit 1; }
docker compose version >/dev/null
[[ -f .env ]] || cp .env.example .env
mkdir -p .cache .local-data/packs .local-data/runtime
export ALPINE_UID="$(id -u)" ALPINE_GID="$(id -g)"
docker compose build packs
pack() { docker compose run --rm -T --interactive=false packs "$@"; }
catalog=$(pack scripts/manage-packs.ts list)

ids=() names=() installed=() selected=() sizes=()
while IFS=$'\t' read -r id name present size; do
  [[ -n "$id" ]] || continue
  ids+=("$id"); names+=("$name"); installed+=("$present"); selected+=("$present"); sizes+=("$size")
done <<< "$catalog"
green='' gray='' reset=''
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  green=$'\033[32m'; gray=$'\033[90m'; reset=$'\033[0m'
fi
cursor=0
while :; do
  if [[ -t 1 && ${TERM:-dumb} != dumb ]]; then printf '\033[H\033[2J'; fi
  printf '\nAlpine Loop · Regional packs\n\n'
  for i in "${!ids[@]}"; do
    color=$gray; mark='○'; change=''
    if [[ ${selected[i]} == 1 ]]; then color=$green; mark='✓'; fi
    if [[ ${selected[i]} != "${installed[i]}" ]]; then
      if [[ ${selected[i]} == 1 ]]; then change=' — install'; else change=' — remove'; fi
    fi
    pointer=' '; [[ $cursor != "$i" ]] || pointer='›'
    printf ' %s %s%s %s (%s)%s%s\n' "$pointer" "$color" "$mark" "${names[i]}" "${sizes[i]}" "$change" "$reset"
  done
  pointer=' '; [[ $cursor != "${#ids[@]}" ]] || pointer='›'
  printf '\n %s Apply changes\n' "$pointer"
  printf '\nFinished sizes exclude source caches. Estimates use ~; installed sizes are measured.\n'
  printf 'Installing builds from source; shared downloads are cached.\n'
  printf '↑/↓ move · Enter toggle/apply · q quit\n'
  read -rsn1 choice || exit 0
  case "$choice" in
    q|Q) exit 0 ;;
    $'\033')
      # Bash 3.2 (macOS) supports whole-second read timeouts.
      read -rsn2 -t 1 choice || continue
      case "$choice" in
        '[A'|'OA') cursor=$(((cursor+${#ids[@]}) % (${#ids[@]}+1))) ;;
        '[B'|'OB') cursor=$(((cursor+1) % (${#ids[@]}+1))) ;;
      esac
      ;;
    ''|' ')
      [[ $cursor != "${#ids[@]}" ]] || break
      selected[cursor]=$((1-selected[cursor]))
      ;;
  esac
done

remove=()
for i in "${!ids[@]}"; do
  if [[ ${installed[i]} == 1 && ${selected[i]} == 0 ]]; then remove+=("${ids[i]}"); fi
done
if [[ ${#remove[@]} -gt 0 ]]; then
  if [[ -n $(docker compose ps --status running -q app) ]]; then
    echo 'Stop the app with docker compose down before removing packs.' >&2; exit 1
  fi
  printf '\nRemove: %s\n' "${remove[*]}"
  read -r -p 'Stop any native development server first. Confirm removal [y/N]: ' answer || exit 0
  [[ "$answer" == y || "$answer" == Y ]] || exit 0
  pack scripts/manage-packs.ts remove "${remove[@]}"
fi
for i in "${!ids[@]}"; do
  if [[ ${installed[i]} == 0 && ${selected[i]} == 1 ]]; then
    printf '\nBuilding %s…\n' "${names[i]}"
    pack scripts/pack-bootstrap.ts "--pack=${ids[i]}" --progress
  fi
done
printf '\nPacks updated. Start the app with: docker compose up --build\n'
