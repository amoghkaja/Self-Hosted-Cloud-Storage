#!/usr/bin/env bash
# Adds or removes the document editor, which opens Word, Excel and PowerPoint files in the
# browser and saves them back. It runs Collabora Online in a container of its own that needs
# about 1–2 GB of memory, so it is optional: off removes it completely and gives the memory
# back (files then open as PDFs, as before). Your files are not touched either way.
#
#   ./scripts/office.sh on       add the editor (asks for its address the first time)
#   ./scripts/office.sh off      remove it and give its memory back
#   ./scripts/office.sh status   show whether it is on and running
#
# Once it's been added, the switch in Admin → Settings → Document editor does the same as on and
# off (through the update helper, within a minute).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
ENV_FILE="$ROOT/deploy/.env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,13p' "$0"; exit 1; }

# --from-helper: run by the update helper for the Admin → Settings switch (no questions, and the
# switch is already set).
HELPER=false
[[ "${2:-}" == --from-helper ]] && HELPER=true
[[ $# -eq 1 ]] || $HELPER || usage
[[ -f "$ENV_FILE" ]] || die "No deploy/.env yet. Install first: ./scripts/install.sh"
load_env "$ENV_FILE"
cd "$ROOT/deploy"

# COMPOSE_PROFILES with office added or removed; the other profiles keep their order.
profiles_with() {
  local want=$1 p out=()
  IFS=, read -ra current <<<"${COMPOSE_PROFILES:-}"
  for p in "${current[@]}"; do [[ -n "$p" && "$p" != office ]] && out+=("$p"); done
  [[ "$want" == on ]] && out+=(office)
  (IFS=,; echo "${out[*]}")
}
has_profile() { [[ ",${COMPOSE_PROFILES:-}," == *,"$1",* ]]; }
app_running() { [[ -n "$(docker compose ps -q app 2>/dev/null)" ]]; }
# The Admin → Settings switch, kept in step with what's installed.
set_switch() {
  if app_running; then
    docker compose exec -T app node dist/cli.js office-editing "$1" </dev/null >/dev/null \
      || info "(Couldn't set the switch in Admin → Settings: set it there by hand.)"
  fi
}
editor_health() { docker compose --profile office ps --format '{{.Health}}' collabora 2>/dev/null || true; }

# Points the editor's address at it: what that takes depends on how the family reaches the app.
route_address() {
  local host
  host=$(office_host "$OFFICE_PUBLIC_URL")
  if has_profile tunnel; then
    if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
      bold "Adding $host to your Cloudflare Tunnel"
      export CLOUDFLARE_API_TOKEN
      docker run --rm -e CLOUDFLARE_API_TOKEN "$IMAGE" node dist/cli.js cloudflare-tunnel \
        --hostname "$host" --service http://app:3001 >/dev/null \
        || die "Cloudflare didn't take it (see above). Fix that and run this again."
    else
      info "In the Cloudflare dashboard, add the editor's address to your tunnel (once):"
      info "  Zero Trust → Networks → Tunnels → your tunnel → Public hostname → Add"
      info "  Hostname: $host    Service: HTTP, app:3001"
      info "(Or run this again with CLOUDFLARE_API_TOKEN=... to have it done for you.)"
    fi
  elif has_profile caddy; then
    export OFFICE_DOMAIN=$host
    set_env "$ENV_FILE" OFFICE_DOMAIN "$OFFICE_DOMAIN"
    info "Point $host at this computer in your DNS, as you did for $DOMAIN; Caddy gets its"
    info "certificate by itself."
  else
    export OFFICE_PORT
    OFFICE_PORT=$(office_local_port "$OFFICE_PUBLIC_URL" "${OFFICE_PORT:-}")
    set_env "$ENV_FILE" OFFICE_PORT "$OFFICE_PORT"
    if [[ "$host" == *.ts.net ]]; then
      info "Put it on your tailnet (once): sudo tailscale serve --bg --https=8443 $OFFICE_PORT"
    fi
  fi
}

case "${1:-}" in
  status)
    if ! has_profile office; then
      info "The document editor is off (not installed)${OFFICE_PUBLIC_URL:+; it would be at $OFFICE_PUBLIC_URL}."
    elif [[ -n "$(docker compose --profile office ps -q collabora 2>/dev/null)" ]]; then
      info "The document editor is on, at $OFFICE_PUBLIC_URL. Container: $(docker compose --profile office ps --format '{{.Status}}' collabora)"
      info "Whether people can use it is the switch in Admin → Settings → Document editor."
    else
      info "The document editor is on, but isn't running. Start it: cd deploy && docker compose up -d"
    fi
    ;;
  on)
    if [[ -z "${OFFICE_PUBLIC_URL:-}" ]]; then
      $HELPER && die "OFFICE_PUBLIC_URL isn't set: run ./scripts/office.sh on by hand first."
      bold "Document editor"
      info "It opens at an address of its own, next to $PUBLIC_URL."
      SUGGESTED=$(office_url_for "$PUBLIC_URL" "${OFFICE_PORT:-}")
      read -r -p "  Its address [$SUGGESTED]: " ans || true
      OFFICE_PUBLIC_URL=${ans:-$SUGGESTED}
      OFFICE_PUBLIC_URL=${OFFICE_PUBLIC_URL%/}
      office_url_ok "$OFFICE_PUBLIC_URL" "$PUBLIC_URL" \
        || die "\"$OFFICE_PUBLIC_URL\" isn't an address of its own like https://office.example.com"
    fi
    if ! $HELPER; then
      AVAILABLE_MB=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
      if (( AVAILABLE_MB > 0 && AVAILABLE_MB < 2000 )); then
        info "Only ${AVAILABLE_MB} MB of memory is free; the editor needs about 1000-2000 MB."
        read -r -p "  Turn it on anyway? [y/N] " ans || true
        [[ "$ans" =~ ^[Yy] ]] || { info "Left off."; exit 0; }
      fi
    fi
    # Exported too: what's already in the environment wins over deploy/.env for docker compose.
    export OFFICE_PUBLIC_URL OFFICE_TLS COMPOSE_PROFILES
    OFFICE_TLS=$([[ "$OFFICE_PUBLIC_URL" == https://* ]] && echo true || echo false)
    COMPOSE_PROFILES=$(profiles_with on)
    set_env "$ENV_FILE" OFFICE_PUBLIC_URL "$OFFICE_PUBLIC_URL"
    set_env "$ENV_FILE" OFFICE_TLS "$OFFICE_TLS"
    set_env "$ENV_FILE" COMPOSE_PROFILES "$COMPOSE_PROFILES"
    $HELPER || route_address
    bold "Starting the document editor"
    info "The first start downloads it (about 1.8 GB on disk) and can take a few minutes."
    docker compose up -d --remove-orphans
    wait_healthy
    printf '  Waiting for the editor'
    for _ in $(seq 1 90); do
      [[ "$(editor_health)" == healthy ]] && break
      printf '.'
      sleep 2
    done
    echo
    [[ "$(editor_health)" == healthy ]] \
      || die "The editor didn't start. See: cd deploy && docker compose logs collabora"
    $HELPER || set_switch on
    info "On, at $OFFICE_PUBLIC_URL. Word, Excel and PowerPoint files now show Edit in the app."
    info "To turn it off and give the memory back: Admin → Settings → Document editor, or"
    info "./scripts/office.sh off."
    ;;
  off)
    $HELPER || set_switch off
    bold "Removing the document editor"
    IMAGE_REF=$(docker compose --profile office config --images 2>/dev/null | grep -m1 '^collabora/' || true)
    # Documents still open are saved as it stops (stop_grace_period in docker-compose.yml).
    docker compose --profile office stop collabora >/dev/null 2>&1 || true
    docker compose --profile office rm -f collabora >/dev/null 2>&1 || true
    [[ -z "$IMAGE_REF" ]] || docker image rm "$IMAGE_REF" >/dev/null 2>&1 || true
    export COMPOSE_PROFILES
    COMPOSE_PROFILES=$(profiles_with off)
    set_env "$ENV_FILE" COMPOSE_PROFILES "$COMPOSE_PROFILES"
    info "Off and removed: its memory and disk space are back. Files open as PDFs again."
    info "Turn it on again any time in Admin → Settings → Document editor (or ./scripts/office.sh on)."
    ;;
  *) usage ;;
esac
