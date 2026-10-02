#!/usr/bin/env bash
# Turns virus scanning of uploads on or off. It runs ClamAV in its own container, which needs
# about 1.5 GB of memory, so it is optional. Your files and settings are not touched.
#
#   ./scripts/virus-scan.sh on       add the scanner and check uploads (and, over time, existing files)
#   ./scripts/virus-scan.sh off      remove the scanner and give its memory back
#   ./scripts/virus-scan.sh status   show whether it is on and running
#
# To pause checking without removing the scanner, use the switch in Admin → Settings instead.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
ENV_FILE="$ROOT/deploy/.env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $# -eq 1 ]] || { sed -n '2,9p' "$0"; exit 1; }
[[ -f "$ENV_FILE" ]] || die "No deploy/.env yet. Install first: ./scripts/install.sh"
load_env "$ENV_FILE"
STORAGE_ROOT=${STORAGE_ROOT:-/srv/familycloud}
cd "$ROOT/deploy"

# COMPOSE_PROFILES with clamav added or removed; the other profiles keep their order.
profiles_with() {
  local want=$1 p out=()
  IFS=, read -ra current <<<"${COMPOSE_PROFILES:-}"
  for p in "${current[@]}"; do [[ -n "$p" && "$p" != clamav ]] && out+=("$p"); done
  [[ "$want" == on ]] && out+=(clamav)
  (IFS=,; echo "${out[*]}")
}

case "$1" in
  status)
    if [[ "${CLAMAV_HOST:-}" != clamav ]]; then
      info "Virus scanning is off${CLAMAV_HOST:+ here (using your own scanner at $CLAMAV_HOST)}."
    elif [[ -n "$(docker compose ps -q clamav 2>/dev/null)" ]]; then
      info "Virus scanning is on. Scanner: $(docker compose ps --format '{{.Status}}' clamav)"
    else
      info "Virus scanning is on, but the scanner isn't running. Start it: docker compose up -d"
    fi
    ;;
  on)
    AVAILABLE_MB=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
    if (( AVAILABLE_MB > 0 && AVAILABLE_MB < 2000 )); then
      info "Only ${AVAILABLE_MB} MB of memory is free; the scanner needs about 1500 MB."
      read -r -p "  Turn it on anyway? [y/N] " ans || true
      [[ "$ans" =~ ^[Yy] ]] || { info "Left off."; exit 0; }
    fi
    [[ -d "$STORAGE_ROOT/clamav" ]] || mkdir -p "$STORAGE_ROOT/clamav" 2>/dev/null \
      || sudo mkdir -p "$STORAGE_ROOT/clamav"
    # Exported too: what's already in the environment wins over deploy/.env for docker compose.
    export CLAMAV_HOST=clamav COMPOSE_PROFILES
    COMPOSE_PROFILES=$(profiles_with on)
    set_env "$ENV_FILE" CLAMAV_HOST "$CLAMAV_HOST"
    set_env "$ENV_FILE" COMPOSE_PROFILES "$COMPOSE_PROFILES"
    bold "Starting the virus scanner"
    info "The first start downloads the virus list (about 300 MB) and takes a few minutes."
    docker compose up -d --remove-orphans
    wait_healthy
    info "On. New uploads are checked, and existing files a couple of thousand an hour."
    info "Admin → Settings shows what it finds."
    ;;
  off)
    docker compose --profile clamav rm -sf clamav >/dev/null 2>&1 || true
    export CLAMAV_HOST="" COMPOSE_PROFILES
    COMPOSE_PROFILES=$(profiles_with off)
    set_env "$ENV_FILE" CLAMAV_HOST ""
    set_env "$ENV_FILE" COMPOSE_PROFILES "$COMPOSE_PROFILES"
    bold "Stopping the virus scanner"
    docker compose up -d --remove-orphans
    wait_healthy
    info "Off. Files already found infected stay blocked."
    ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
