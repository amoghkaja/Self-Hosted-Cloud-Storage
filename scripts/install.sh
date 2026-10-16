#!/usr/bin/env bash
# Family Cloud installer: prepares storage folders, writes deploy/.env with fresh secrets and
# starts the stack with Docker Compose. Safe to re-run: existing settings are kept.
#
#   ./scripts/install.sh                   interactive (offers to install Docker if it's missing)
#   ./scripts/install.sh --install-docker  also install Docker Engine (Ubuntu/Debian, uses sudo)
#
# Non-interactive: PUBLIC_URL=https://cloud.example.com CLOUDFLARE_API_TOKEN=... ./scripts/install.sh -y
#   (CLOUDFLARE_TUNNEL_TOKEN=... for a tunnel you made yourself, or DOMAIN=cloud.example.com for
#   Caddy; UPDATES=auto|notify|manual for how updates happen, notify by default; APP_PORT=3082 if
#   3080 is taken; OFFICE_EDITING=yes to add the document editor, OFFICE_PUBLIC_URL=… for its
#   own address)
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
  if ! $INSTALL_DOCKER && ! $YES; then
    info "Docker isn't installed. The installer can install it with Docker's own script, from"
    info "https://get.docker.com (Ubuntu/Debian; it asks for your password, for sudo)."
    read -r -p "  Install Docker now? [Y/n] " ans || true
    [[ "${ans:-y}" =~ ^[Yy] ]] && INSTALL_DOCKER=true
  fi
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
MANAGED_KEYS='PUBLIC_URL|APP_NAME|SECRET_KEY|POSTGRES_PASSWORD|STORAGE_ROOT|PUID|PGID|CLOUDFLARE_TUNNEL_TOKEN|DOMAIN|APP_PORT|IMAGE|LOG_LEVEL|COMPOSE_PROFILES|UPDATE_CHANNEL|UPDATES|CLAMAV_HOST|OFFICE_PUBLIC_URL|OFFICE_TLS|OFFICE_DOMAIN|OFFICE_PORT'
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
  die "Port $APP_PORT is already used by another program here. Pick a free one: APP_PORT=3082 ./scripts/install.sh"
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

# Also asked on a first install only; scripts/office.sh adds or removes it later, and Admin →
# Settings turns it off completely. Suggested where there's memory to spare (it needs 1-2 GB),
# never added by an unattended install unless asked for (OFFICE_EDITING=yes).
if [[ ! -f "$ENV_FILE" ]]; then
  OFFICE_DEFAULT=no
  if ! $YES && awk -v m="$MEM_GB" 'BEGIN { exit !(m >= 4) }'; then OFFICE_DEFAULT=yes; fi
  ask OFFICE_EDITING "Edit Word, Excel and PowerPoint files in the browser? Needs about 1-2 GB of memory; this computer has $MEM_GB GB, and Admin → Settings turns it off completely (yes/no)" "$OFFICE_DEFAULT"
  if [[ "${OFFICE_EDITING,,}" == y* ]]; then
    info "The editor opens at an address of its own, next to $PUBLIC_URL."
    ask OFFICE_PUBLIC_URL "The editor's address" "$(office_url_for "$PUBLIC_URL" "${OFFICE_PORT:-}")"
    OFFICE_PUBLIC_URL=${OFFICE_PUBLIC_URL%/}
    office_url_ok "$OFFICE_PUBLIC_URL" "$PUBLIC_URL" \
      || die "The editor needs an address of its own, like https://office.example.com (not $PUBLIC_URL)."
  fi
fi

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
# "At night" goes by this computer's clock, which servers often keep on UTC: on a first install,
# offer the family's time zone (the nightly backups follow it too).
if [[ ! -f "$ENV_FILE" ]] && ! $YES \
  && [[ "$(timedatectl show -p Timezone --value 2>/dev/null)" =~ ^(Etc/)?UTC$ ]]; then
  read -r -p "  This computer's clock is on UTC. Your time zone, e.g. Asia/Kolkata (Enter keeps UTC): " ZONE || true
  if [[ -n "${ZONE:-}" ]]; then
    if timedatectl list-timezones 2>/dev/null | grep -qxF -- "$ZONE"; then
      # cron reads the time zone when it starts.
      info "Running: sudo timedatectl set-timezone $ZONE && sudo systemctl try-restart cron"
      sudo timedatectl set-timezone "$ZONE"
      sudo systemctl try-restart cron 2>/dev/null || true
    else
      info "That's not a time zone this computer knows; keeping UTC (sudo timedatectl set-timezone …)."
    fi
  fi
fi
# How updates happen (UPDATES), asked once. An install from before the question had the weekly
# automatic update, which is auto; so is AUTO_UPDATE=yes, how earlier installers were told.
if [[ -z "${UPDATES:-}" ]]; then
  if weekly_update_job "$ROOT" "$STORAGE_ROOT" || [[ "${AUTO_UPDATE:-}" =~ ^[Yy] ]]; then
    UPDATES=auto
  elif ! command -v crontab >/dev/null; then
    UPDATES=manual
    info "This computer has no cron, which the update helper needs: updates will be by hand."
  elif $YES; then
    UPDATES=notify
  else
    # Suggested only for releases: the main branch can change daily.
    if [[ "$IMAGE" == "$RELEASE_IMAGE_REPO":* ]]; then choose_updates 1; else choose_updates 2; fi
  fi
fi
[[ "$UPDATES" =~ ^(auto|notify|manual)$ ]] || die "UPDATES must be auto, notify or manual."
PUID=${PUID:-$(id -u)}
PGID=${PGID:-$(id -g)}
# Optional services follow the settings; docker compose reads COMPOSE_PROFILES from deploy/.env,
# so plain `docker compose up -d` starts the right ones later too.
PROFILES=()
[[ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]] && PROFILES+=(tunnel)
[[ -n "${DOMAIN:-}" ]] && PROFILES+=(caddy)
# Only the bundled scanner is a service here; another host name is someone's own clamd.
[[ "$CLAMAV_HOST" == clamav ]] && PROFILES+=(clamav)
# The document editor: chosen just now, or added before by scripts/office.sh. How browsers reach
# it follows how the family reaches the app: through the tunnel or Caddy, else a local port.
OFFICE_ON=false
if [[ "${OFFICE_EDITING:-}" =~ ^[Yy] || ",${COMPOSE_PROFILES:-}," == *,office,* ]] \
  && [[ -n "${OFFICE_PUBLIC_URL:-}" ]]; then
  OFFICE_ON=true
  PROFILES+=(office)
  OFFICE_TLS=$([[ "$OFFICE_PUBLIC_URL" == https://* ]] && echo true || echo false)
  if [[ -n "${DOMAIN:-}" ]]; then
    OFFICE_DOMAIN=$(office_host "$OFFICE_PUBLIC_URL")
  elif [[ -z "$CLOUDFLARE_TUNNEL_TOKEN" && -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    OFFICE_PORT=$(office_local_port "$OFFICE_PUBLIC_URL" "${OFFICE_PORT:-}")
  fi
fi
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
  env_line UPDATES "$UPDATES"
  env_line LOG_LEVEL "${LOG_LEVEL:-info}"
  env_line CLAMAV_HOST "$CLAMAV_HOST"
  env_line OFFICE_PUBLIC_URL "${OFFICE_PUBLIC_URL:-}"
  env_line OFFICE_TLS "${OFFICE_TLS:-}"
  env_line OFFICE_DOMAIN "${OFFICE_DOMAIN:-}"
  env_line OFFICE_PORT "${OFFICE_PORT:-}"
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
# The editor's address goes through the same tunnel, to the app's editor proxy.
OFFICE_ROUTED=false
if $OFFICE_ON && [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  if docker run --rm -e CLOUDFLARE_API_TOKEN "$IMAGE" node dist/cli.js cloudflare-tunnel \
    --hostname "$(office_host "$OFFICE_PUBLIC_URL")" --service http://app:3001 >/dev/null; then
    OFFICE_ROUTED=true
    info "Tunnel ready for the document editor too: $OFFICE_PUBLIC_URL."
  else
    info "The editor's address wasn't added to the tunnel (see above); the rest works without it."
  fi
fi
if $OFFICE_ON && [[ -z "$(docker compose images -q collabora 2>/dev/null)" ]]; then
  info "Downloading the document editor (about 1.8 GB on disk; a few minutes)…"
  docker compose pull --quiet collabora
fi
docker compose up -d --remove-orphans
wait_healthy || die "Fix the problem shown above, then re-run ./scripts/install.sh (your settings are kept)."
# Chosen on this install: on for everyone straight away (the switch in Admin → Settings).
if [[ "${OFFICE_EDITING:-}" =~ ^[Yy] ]] && $OFFICE_ON; then
  docker compose exec -T app node dist/cli.js office-editing on </dev/null >/dev/null \
    || info "Turn on the document editor in Admin → Settings → Document editor."
fi

# The update helper for auto and notify (update.sh --cron, every minute; most minutes it does
# nothing): it looks for new versions, answers Admin → Overview and, for auto, installs them at
# night. Its crontab line comes with a comment saying what it is.
if [[ "$UPDATES" == manual ]]; then
  if update_helper_installed "$ROOT" || weekly_update_job "$ROOT" "$STORAGE_ROOT"; then
    remove_update_helper "$ROOT" "$STORAGE_ROOT"
    info "Removed the update helper from your crontab (updates are by hand)."
  fi
elif ! update_helper_installed "$ROOT"; then
  install_update_helper "$ROOT" "$STORAGE_ROOT"
  info "Added the update helper to your crontab (crontab -l shows it, with a note of what it is)."
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
if $OFFICE_ON; then
  info "Word, Excel and PowerPoint files can be edited in the browser, at $OFFICE_PUBLIC_URL."
  if ! [[ "${OFFICE_EDITING:-}" =~ ^[Yy] ]]; then
    : # set up before, by scripts/office.sh
  elif [[ ",$COMPOSE_PROFILES," == *,tunnel,* ]] && ! $OFFICE_ROUTED; then
    info "Add that address to your tunnel (once): Zero Trust → Networks → Tunnels → your tunnel →"
    info "Public hostname → Add: $(office_host "$OFFICE_PUBLIC_URL"), service HTTP, app:3001."
  elif [[ -n "${DOMAIN:-}" ]]; then
    info "Point $(office_host "$OFFICE_PUBLIC_URL") at this computer in your DNS, as you did for $DOMAIN."
  elif [[ "$(office_host "$OFFICE_PUBLIC_URL")" == *.ts.net ]]; then
    info "Put it on your tailnet (once): sudo tailscale serve --bg --https=8443 $OFFICE_PORT"
  fi
  info "If the computer gets slow, turn it off in Admin → Settings → Document editor: that removes"
  info "it completely and gives its memory back."
else
  info "To edit Word, Excel and PowerPoint files in the browser: ./scripts/office.sh on (needs"
  info "about 1-2 GB of memory; this computer has $MEM_GB GB). It can be turned off again"
  info "completely in Admin → Settings."
fi
case "$UPDATES" in
  auto) info "Updates install themselves at night; Admin → Overview shows them." ;;
  notify) info "New versions show in Admin → Overview, where you install them." ;;
  manual) info "Update with ./scripts/update.sh (what's new: CHANGELOG.md)." ;;
esac
info "Changed on this computer: Docker containers (cd deploy && docker compose ps), $STORAGE_ROOT,"
info "deploy/.env$([[ "$UPDATES" == manual ]] || echo " and your crontab (crontab -l)"). To remove it all: docs/self-hosting.md#uninstalling"

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
