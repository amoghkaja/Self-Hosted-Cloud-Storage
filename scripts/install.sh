#!/usr/bin/env bash
# Family Cloud installer: prepares storage folders, writes deploy/.env with fresh secrets and
# starts the stack with Docker Compose. Safe to re-run: existing settings are kept.
#
#   ./scripts/install.sh                   interactive
#   ./scripts/install.sh --install-docker  also install Docker Engine (Ubuntu/Debian, uses sudo)
#
# Non-interactive: PUBLIC_URL=https://cloud.example.com CLOUDFLARE_API_TOKEN=... ./scripts/install.sh -y
#   (CLOUDFLARE_TUNNEL_TOKEN=... for a tunnel you made yourself, or DOMAIN=cloud.example.com for
#   Caddy; AUTO_UPDATE=yes adds the weekly update job; APP_PORT=3081 if 3080 is taken)
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
ARGS=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=true; ARGS+=("$arg") ;;
    --install-docker) INSTALL_DOCKER=true ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
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
    # The new group only reaches new log-ins; sg gives it to the rest of this install now.
    info "Docker is installed. Carrying on (log out and back in later to use docker yourself)."
    exec sg docker -c "$(printf '%q ' "$ROOT/scripts/install.sh" "${ARGS[@]}")"
  fi
  die "Docker is not installed. Re-run with --install-docker, or see https://docs.docker.com/engine/install/"
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required (docker compose version)."
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Is your user in the docker group? (sudo usermod -aG docker \$USER, then log in again)"

# Keep existing values on re-runs (read safely: the file is never executed).
MANAGED_KEYS='PUBLIC_URL|APP_NAME|SECRET_KEY|POSTGRES_PASSWORD|STORAGE_ROOT|PUID|PGID|CLOUDFLARE_TUNNEL_TOKEN|DOMAIN|APP_PORT|IMAGE|LOG_LEVEL|COMPOSE_PROFILES|UPDATE_CHANNEL|CLAMAV_HOST'
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
      ask PUBLIC_URL "Address family members will use" "${OLD_URL:-https://cloud.example.com}"
      info "The installer sets up the tunnel and its DNS record for you, with a Cloudflare API token:"
      info "dash.cloudflare.com/profile/api-tokens → Create Token → Create Custom Token, with"
      info "  Account · Cloudflare Tunnel · Edit,  Zone · DNS · Edit,  Zone · Zone · Read"
      info "It's used once and not stored. (A tunnel token you made yourself works too.)"
      ask_secret CF_TOKEN "Cloudflare API token, hidden as you paste (Enter to add later)"
      # Tunnel tokens are base64 JSON ({"a":…} → eyJ…); API tokens are short and plain.
      if [[ "${CF_TOKEN:-}" == eyJ* ]]; then
        CLOUDFLARE_TUNNEL_TOKEN=$CF_TOKEN
      elif [[ -n "${CF_TOKEN:-}" ]]; then
        CLOUDFLARE_API_TOKEN=$CF_TOKEN
      fi
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

# ── Checks before changing anything ─────────────────────────────────────────
APP_RUNNING=$(cd "$ROOT/deploy" && docker compose ps -q app 2>/dev/null || true)
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [[ -z "$APP_RUNNING" ]] && port_busy "$APP_PORT"; then
  die "Port $APP_PORT is already used by another program here. Pick a free one: APP_PORT=3081 ./scripts/install.sh"
fi
if [[ -n "${DOMAIN:-}" ]] && [[ -z "$(cd "$ROOT/deploy" && docker compose ps -q caddy 2>/dev/null || true)" ]]; then
  for p in 80 443; do
    port_busy "$p" && die "Port $p is already used by another program (a web server?). Caddy needs ports 80 and 443."
  done
fi
# Where the files will live: the disk with the folder (or its nearest existing parent).
DISK_AT=$STORAGE_ROOT
while [[ ! -d "$DISK_AT" ]]; do DISK_AT=$(dirname "$DISK_AT"); done
read -r DISK_DEV DISK_FREE_KB DISK_MOUNT < <(df -Pk "$DISK_AT" | awk 'NR == 2 { print $1, $4, $6 }')
gb() { awk -v k="$1" 'BEGIN { printf "%.0f GB", k / 1048576 }'; }
info "Files will be kept on $DISK_DEV (mounted at $DISK_MOUNT): $(gb "$DISK_FREE_KB") free."
# A bigger disk that isn't the system disk is usually where family files belong.
BIGGEST=$(df -Pk -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null \
  | awk -v m="$DISK_MOUNT" 'NR > 1 && $6 != m && $6 != "/boot" && $6 !~ "^/boot/" { print $4, $6 }' \
  | sort -rn | head -1)
if [[ -n "$BIGGEST" && ! -f "$ENV_FILE" ]] && (( ${BIGGEST%% *} > 2 * DISK_FREE_KB )); then
  info "Tip: ${BIGGEST#* } has $(gb "${BIGGEST%% *}") free. To keep files there, run again with"
  info "     STORAGE_ROOT=${BIGGEST#* }/familycloud ./scripts/install.sh"
fi
if (( DISK_FREE_KB < 10 * 1048576 )) && [[ ! -f "$ENV_FILE" ]]; then
  info "That's not much room for a family's photos and videos."
  if ! $YES; then
    read -r -p "  Continue anyway? [y/N] " ans || true
    [[ "$ans" =~ ^[Yy] ]] || exit 1
  fi
fi
MEM_GB=$(awk '/^MemTotal:/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo)

# Asked on a first install only; scripts/virus-scan.sh changes it later. Off by default: the
# scanner needs more memory than a small machine such as a Raspberry Pi can spare.
if [[ ! -f "$ENV_FILE" ]]; then
  ask VIRUS_SCAN "Check uploads for viruses? Needs about 1.5 GB of memory; this computer has $MEM_GB GB (yes/no)" "no"
  [[ "${VIRUS_SCAN,,}" == y* ]] && CLAMAV_HOST=clamav
  if [[ -n "${CLAMAV_HOST:-}" ]] && awk -v m="$MEM_GB" 'BEGIN { exit !(m < 3) }'; then
    info "With $MEM_GB GB that may leave too little for everything else; turn it off later with"
    info "./scripts/virus-scan.sh off if the computer gets slow."
  fi
fi
CLAMAV_HOST=${CLAMAV_HOST:-}

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
# Only the bundled scanner is a service here; another host name is someone's own clamd.
[[ "$CLAMAV_HOST" == clamav ]] && PROFILES+=(clamav)
COMPOSE_PROFILES=$(IFS=,; echo "${PROFILES[*]}")
export COMPOSE_PROFILES

bold "Preparing $STORAGE_ROOT"
sudo -n true 2>/dev/null || info "Creating the folders needs your computer password (sudo)." 
for d in volumes/disk1 cache db backups clamav; do
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
  env_line CLAMAV_HOST "$CLAMAV_HOST"
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
# The tunnel from an API token, with the tool in the image just pulled (no extra programs here).
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -z "$CLOUDFLARE_TUNNEL_TOKEN" ]]; then
  bold "Setting up the Cloudflare Tunnel"
  export CLOUDFLARE_API_TOKEN
  CLOUDFLARE_TUNNEL_TOKEN=$(docker run --rm -e CLOUDFLARE_API_TOKEN "$IMAGE" \
    node dist/cli.js cloudflare-tunnel --hostname "${PUBLIC_URL#*://}" | tail -1) \
    || die "The tunnel wasn't set up (see above). Fix that, then re-run ./scripts/install.sh (your settings are kept)."
  [[ "$CLOUDFLARE_TUNNEL_TOKEN" == eyJ* ]] || die "Cloudflare didn't return a tunnel token. Re-run ./scripts/install.sh to try again."
  set_env "$ENV_FILE" CLOUDFLARE_TUNNEL_TOKEN "$CLOUDFLARE_TUNNEL_TOKEN"
  PROFILES+=(tunnel)
  COMPOSE_PROFILES=$(IFS=,; echo "${PROFILES[*]}")
  set_env "$ENV_FILE" COMPOSE_PROFILES "$COMPOSE_PROFILES"
  info "Tunnel ready: ${PUBLIC_URL} reaches this computer (DNS can take a minute or two)."
fi
docker compose up -d --remove-orphans
wait_healthy || die "Fix the problem shown above, then re-run ./scripts/install.sh (your settings are kept)."

# Weekly automatic updates: update.sh backs up the database first and follows releases only.
UPDATE_JOB="$(printf '%q' "$ROOT/scripts/update.sh") -y >> $(printf '%q' "$STORAGE_ROOT/backups/update.log") 2>&1"
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
info "Update later with ./scripts/update.sh (what's new: CHANGELOG.md)."

# Backups last: the setup token above is what's needed first, and backup setup is its own guide.
if ! crontab -l 2>/dev/null | grep -qF "$ROOT/scripts/backup.sh"; then
  echo
  bold "Backups"
  info "One disk will fail eventually. Set up nightly backups before the family relies on it."
  if ! $YES && [[ -t 0 ]]; then
    read -r -p "  Set them up now? [Y/n] " ans || true
    if [[ ! "${ans:-y}" =~ ^[Nn] ]]; then exec "$ROOT/scripts/backup-setup.sh"; fi
  fi
  info "Whenever you're ready: ./scripts/backup-setup.sh (docs/backup-restore.md)."
fi
