#!/usr/bin/env bash
# Family Cloud installer: prepares storage folders, writes deploy/.env with fresh secrets and
# starts the stack with Docker Compose. Safe to re-run: existing settings are kept.
#
#   ./scripts/install.sh                   interactive
#   ./scripts/install.sh --install-docker  also install Docker Engine (Ubuntu/Debian, uses sudo)
#
# Non-interactive: PUBLIC_URL=https://cloud.example.com CLOUDFLARE_TUNNEL_TOKEN=... ./scripts/install.sh -y
#   (or DOMAIN=cloud.example.com for Caddy; AUTO_UPDATE=yes adds the weekly update job)
# WAIT_SECS=600 gives a slow machine longer to start the first time (default 180).
# A fresh clone installs the newest release; set UPDATE_CHANNEL=main to run the main branch.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
ENV_FILE="$ROOT/deploy/.env"
YES=false
INSTALL_DOCKER=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=true ;;
    --install-docker) INSTALL_DOCKER=true ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "Question" "default"
  local var=$1 q=$2 def=${3:-} ans
  if [[ -n "${!var:-}" ]]; then return; fi
  if $YES; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "  $q${def:+ [$def]}: " ans || true
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_secret() { # like ask, without showing what's typed or pasted
  local var=$1 q=$2 ans
  if [[ -n "${!var:-}" ]] || $YES; then return; fi
  read -rs -p "  $q: " ans || true
  echo
  printf -v "$var" '%s' "$ans"
}
rand() { openssl rand -hex 32; }

bold "Family Cloud installer"

# A first install from a fresh clone of main moves to the newest release, then runs that
# release's installer, so the scripts, compose file and image all match.
if [[ ! -f "$ENV_FILE" && "${UPDATE_CHANNEL:-stable}" == stable && -z "${FC_RELEASE_CHECKED:-}" ]] \
  && [[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" == main ]] && git diff --quiet HEAD 2>/dev/null; then
  git fetch --quiet --tags origin 2>/dev/null || true
  RELEASE=$(latest_release)
  if [[ -n "$RELEASE" ]]; then
    info "Installing the newest release, $RELEASE."
    git -c advice.detachedHead=false checkout --quiet "$RELEASE"
    FC_RELEASE_CHECKED=1 exec "$ROOT/scripts/install.sh" "$@"
  fi
fi

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux hosts."
command -v openssl >/dev/null || die "openssl is required (sudo apt install openssl)."
command -v curl >/dev/null || die "curl is required (sudo apt install curl)."

if ! command -v docker >/dev/null; then
  if $INSTALL_DOCKER; then
    bold "Installing Docker Engine (sudo required)…"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    info "Added $USER to the docker group. Log out and back in (or run: newgrp docker), then re-run this script."
    exit 0
  fi
  die "Docker is not installed. Re-run with --install-docker, or see https://docs.docker.com/engine/install/"
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required (docker compose version)."
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Is your user in the docker group? (sudo usermod -aG docker \$USER, then log in again)"

# Keep existing values on re-runs (read safely: the file is never executed).
MANAGED_KEYS='PUBLIC_URL|APP_NAME|SECRET_KEY|POSTGRES_PASSWORD|STORAGE_ROOT|PUID|PGID|CLOUDFLARE_TUNNEL_TOKEN|DOMAIN|APP_PORT|IMAGE|LOG_LEVEL|COMPOSE_PROFILES|UPDATE_CHANNEL'
EXTRA_SETTINGS=""
if [[ -f "$ENV_FILE" ]]; then
  load_env "$ENV_FILE"
  # Settings added by hand (e.g. WORKER_CONCURRENCY) are carried over verbatim.
  EXTRA_SETTINGS=$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
    | grep -vE "^[[:space:]]*(export[[:space:]]+)?($MANAGED_KEYS)=" || true)
  bold "Found existing deploy/.env; keeping its settings."
fi

bold "Settings"
APP_PORT=${APP_PORT:-3080}
# How family members reach it decides the address and the extra services. Asked until one of
# the internet options is set up, so re-running the installer later is how you add one.
if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" && -z "${DOMAIN:-}" ]] && ! $YES; then
  echo "  How will your family reach it?"
  echo "    1) Cloudflare Tunnel: from anywhere, no router changes (recommended; your domain on Cloudflare)"
  echo "    2) My own domain, with ports 80 and 443 forwarded to this computer (automatic HTTPS)"
  echo "    3) Tailscale: private; each phone and laptop needs the Tailscale app"
  echo "    4) Only on this computer for now (choose later by running this installer again)"
  read -r -p "  Choose 1-4 [1]: " ACCESS || true
  # Offer the address from an earlier run as the default instead of skipping the question.
  OLD_URL=${PUBLIC_URL:-}
  unset PUBLIC_URL
  case "${ACCESS:-1}" in
    1)
      info "Create the tunnel first: docs/cloudflare-tunnel.md (about 10 minutes). Its public"
      info "hostname is the address below, and it gives you the token to paste here."
      ask PUBLIC_URL "Address family members will use" "${OLD_URL:-https://cloud.example.com}"
      ask_secret CLOUDFLARE_TUNNEL_TOKEN "Cloudflare Tunnel token, hidden as you paste (Enter to add later)"
      ;;
    2)
      info "Point a DNS A record for the name at your home IP, and forward TCP 80 and 443"
      info "(and UDP 443) on your router to this computer. HTTPS certificates are automatic."
      ask DOMAIN "Address, without https:// (e.g. cloud.example.com)" ""
      DOMAIN=${DOMAIN#https://}
      DOMAIN=${DOMAIN%/}
      [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "That doesn't look like a domain name (e.g. cloud.example.com)."
      PUBLIC_URL="https://$DOMAIN"
      ;;
    3)
      TS_NAME=""
      if command -v tailscale >/dev/null; then
        TS_NAME=$(tailscale status --json 2>/dev/null | grep -m1 -o '"DNSName": *"[^"]*' | sed 's/.*"//; s/\.$//' || true)
      fi
      ask PUBLIC_URL "Address (your machine's Tailscale name)" "${TS_NAME:+https://$TS_NAME}"
      [[ -n "$PUBLIC_URL" ]] || die "Install Tailscale first (https://tailscale.com/download/linux), then re-run."
      SHOW_TAILSCALE=true
      ;;
    4) PUBLIC_URL=${OLD_URL:-http://localhost:$APP_PORT} ;;
    *) die "Choose 1, 2, 3 or 4." ;;
  esac
fi
ask PUBLIC_URL "Address family members will use" "https://cloud.example.com"
ask APP_NAME "Name shown in the app" "Family Cloud"
ask STORAGE_ROOT "Where to keep files and the database" "/srv/familycloud"
PUBLIC_URL=${PUBLIC_URL%/}
# No path: the app serves from the site root and refuses to start with one.
[[ "$PUBLIC_URL" =~ ^https?://[^/[:space:]]+$ ]] || die "PUBLIC_URL must look like https://cloud.example.com, without a path (http:// only for LAN testing)."
(( ${#APP_NAME} >= 1 && ${#APP_NAME} <= 60 )) || die "The app name must be 1-60 characters."
STORAGE_ROOT=${STORAGE_ROOT%/}
[[ "$STORAGE_ROOT" =~ ^(/[A-Za-z0-9._-]+){2,}$ && "$STORAGE_ROOT/" != */./* && "$STORAGE_ROOT/" != */../* ]] \
  || die "The storage location must be a dedicated folder at least two levels deep, e.g. /srv/familycloud (letters, digits, . _ - only)."

SECRET_KEY=${SECRET_KEY:-$(rand)}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-$(rand)}
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}
UPDATE_CHANNEL=${UPDATE_CHANNEL:-stable}
[[ "$UPDATE_CHANNEL" == stable || "$UPDATE_CHANNEL" == main ]] || die "UPDATE_CHANNEL must be stable or main."
# The image matching this checkout: the release's own image on a release, else a local build.
if [[ -z "${IMAGE:-}" ]]; then
  if TAG=$(git describe --tags --exact-match --match 'v[0-9]*' 2>/dev/null); then
    IMAGE="$RELEASE_IMAGE_REPO:$TAG"
  else
    IMAGE=$LOCAL_IMAGE
  fi
fi
PUID=${PUID:-$(id -u)}
PGID=${PGID:-$(id -g)}
# Optional services follow the settings; docker compose reads COMPOSE_PROFILES from deploy/.env,
# so plain `docker compose up -d` starts the right ones later too.
PROFILES=()
[[ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]] && PROFILES+=(tunnel)
[[ -n "${DOMAIN:-}" ]] && PROFILES+=(caddy)
COMPOSE_PROFILES=$(IFS=,; echo "${PROFILES[*]}")
export COMPOSE_PROFILES

bold "Preparing $STORAGE_ROOT"
for d in volumes/disk1 cache db backups; do
  if [[ ! -d "$STORAGE_ROOT/$d" ]]; then
    sudo mkdir -p "$STORAGE_ROOT/$d"
  fi
done
sudo chown "$PUID:$PGID" "$STORAGE_ROOT" "$STORAGE_ROOT/volumes" "$STORAGE_ROOT/volumes/disk1" "$STORAGE_ROOT/cache" "$STORAGE_ROOT/backups"
sudo chmod 750 "$STORAGE_ROOT"
info "volumes/disk1  file data (first disk)"
info "db             database"
info "cache          thumbnails"

# Write to a private temp file, then move it into place: the result is mode 600 even if an
# older deploy/.env had looser permissions, and a failed write never leaves a half file.
TMP_ENV=$(mktemp "$ROOT/deploy/.env.XXXXXX")
trap 'rm -f "$TMP_ENV"' EXIT
chmod 600 "$TMP_ENV"
{
  echo "# Generated by scripts/install.sh on $(date -u +%Y-%m-%d). Keep this file private."
  env_line PUBLIC_URL "$PUBLIC_URL"
  env_line APP_NAME "$APP_NAME"
  env_line SECRET_KEY "$SECRET_KEY"
  env_line POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
  env_line STORAGE_ROOT "$STORAGE_ROOT"
  env_line PUID "$PUID"
  env_line PGID "$PGID"
  env_line CLOUDFLARE_TUNNEL_TOKEN "$CLOUDFLARE_TUNNEL_TOKEN"
  env_line DOMAIN "${DOMAIN:-}"
  env_line APP_PORT "$APP_PORT"
  env_line IMAGE "$IMAGE"
  env_line UPDATE_CHANNEL "$UPDATE_CHANNEL"
  env_line LOG_LEVEL "${LOG_LEVEL:-info}"
  env_line COMPOSE_PROFILES "$COMPOSE_PROFILES"
  if [[ -n "$EXTRA_SETTINGS" ]]; then printf '%s\n' "$EXTRA_SETTINGS"; fi
} > "$TMP_ENV" || die "Could not write deploy/.env (see the message above)."
mv "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
trap - EXIT
info "Wrote deploy/.env (secrets generated, permissions 600)."

cd "$ROOT/deploy"

bold "Starting Family Cloud $(checkout_version)"
export APP_VERSION
APP_VERSION=$(checkout_version)
if [[ "$IMAGE" == "$LOCAL_IMAGE" ]] || ! docker compose pull --quiet app 2>/dev/null; then
  info "Building the image on this machine (takes a few minutes, longer on a Raspberry Pi)…"
  docker compose build app
fi
docker compose up -d --remove-orphans
wait_healthy || die "Fix the problem shown above, then re-run ./scripts/install.sh (your settings are kept)."

# Weekly automatic updates: update.sh backs up the database first and follows releases only.
UPDATE_JOB="$ROOT/scripts/update.sh -y >> $STORAGE_ROOT/backups/update.log 2>&1"
if command -v crontab >/dev/null && ! crontab -l 2>/dev/null | grep -qF "$ROOT/scripts/update.sh"; then
  if $YES; then AUTO_UPDATE=${AUTO_UPDATE:-no}; fi
  # Suggested only for releases: the main branch can change daily.
  [[ "$IMAGE" == "$RELEASE_IMAGE_REPO":* ]] && AUTO_DEFAULT=yes || AUTO_DEFAULT=no
  ask AUTO_UPDATE "Install new releases automatically, Sundays at 04:30? (yes/no)" "$AUTO_DEFAULT"
  if [[ "$AUTO_UPDATE" =~ ^[Yy] ]]; then
    { crontab -l 2>/dev/null || true; echo "30 4 * * 0 $UPDATE_JOB"; } | crontab -
    info "Automatic updates on (crontab -e to change). Log: $STORAGE_ROOT/backups/update.log"
  fi
fi

if ! TOKEN=$(docker compose exec -T app node dist/cli.js setup-token 2>&1 | tail -1); then
  TOKEN=""
  info "Couldn't read the setup token automatically. Get it with:"
  info "  cd deploy && docker compose exec app node dist/cli.js setup-token"
fi
echo
bold "Done!"
if [[ "$TOKEN" != Setup* && -n "$TOKEN" ]]; then
  info "Open $PUBLIC_URL/setup and create the admin account."
  info "Setup token: $TOKEN"
else
  info "Open $PUBLIC_URL and sign in."
fi
LOCAL_URL="http://127.0.0.1:$APP_PORT"
if [[ -n "${SHOW_TAILSCALE:-}" ]]; then
  info "Put it on your tailnet (once): sudo tailscale serve --bg $APP_PORT"
elif [[ "$COMPOSE_PROFILES" != *tunnel* && "$COMPOSE_PROFILES" != *caddy* && "$PUBLIC_URL" != "$LOCAL_URL" ]]; then
  info "It's only reachable on this computer ($LOCAL_URL) until a tunnel or domain is set up:"
  info "re-run ./scripts/install.sh and choose how your family reaches it."
fi
echo
info "Next: set up backups before the family relies on it (docs/backup-restore.md)."
info "Update later with ./scripts/update.sh (what's new: CHANGELOG.md)."
