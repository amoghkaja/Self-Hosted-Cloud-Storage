#!/usr/bin/env bash
# Family Cloud updater: backs up the database, moves to the newest version, restarts and checks
# that it came back. Your files, settings and accounts are kept; database changes apply on start.
#
#   ./scripts/update.sh           show what's new, ask, then update
#   ./scripts/update.sh --check   only show whether an update is available
#   ./scripts/update.sh -y        update without asking (for cron: automatic updates)
#
# UPDATE_CHANNEL in deploy/.env picks what to follow:
#   stable (default)  the newest release (vX.Y.Z), using its published image
#   main              the latest code on the main branch, built on this machine
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
ENV_FILE="$ROOT/deploy/.env"
YES=false
CHECK=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=true ;;
    --check) CHECK=true ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "No deploy/.env yet. Install first: ./scripts/install.sh"
git rev-parse --git-dir >/dev/null 2>&1 || die "Updating needs the git checkout you installed from."
load_env "$ENV_FILE"
STORAGE_ROOT=${STORAGE_ROOT:-/srv/familycloud}
CHANNEL=${UPDATE_CHANNEL:-stable}
[[ "$CHANNEL" == stable || "$CHANNEL" == main ]] || die "UPDATE_CHANNEL must be stable or main."

# One update at a time (a cron run and a manual one could otherwise overlap).
exec 9>"$STORAGE_ROOT/backups/.update.lock"
flock -n 9 || die "Another update is already running."

cd "$ROOT/deploy"
FROM=$(running_version)
OLD_REF=$(git rev-parse HEAD)

bold "Checking for updates ($CHANNEL)"
git fetch --quiet --tags origin || die "Couldn't reach the code repository. Check the internet connection."
if [[ "$CHANNEL" == stable ]]; then
  TARGET=$(latest_release)
  if [[ -z "$TARGET" ]]; then
    info "No releases published yet, so following the main branch."
    CHANNEL=main
  fi
fi
if [[ "$CHANNEL" == main ]]; then
  git rev-parse --verify --quiet origin/main >/dev/null || die "No origin/main branch to follow."
  TARGET=$(git describe --tags --always origin/main)
  TARGET_REF=origin/main
else
  TARGET_REF=$TARGET
fi

info "Running:   $FROM"
info "Available: $TARGET"
if [[ "$FROM" == "$TARGET" && "$(git rev-parse HEAD)" == "$(git rev-parse "$TARGET_REF^{commit}")" ]]; then
  bold "Already up to date."
  exit 0
fi

echo
bold "What's new"
if git cat-file -e "$TARGET_REF:CHANGELOG.md" 2>/dev/null; then
  # Release versions only: v0.2.0-5-gabc1234 was built after v0.2.0.
  CHANGES=$(git show "$TARGET_REF:CHANGELOG.md" | changes_since "${FROM%%-*}" \
    | { if [[ "$CHANNEL" == stable ]]; then sed '/^## Unreleased$/d'; else cat; fi; })
  sed 's/^/  /' <<<"$CHANGES" | head -60
else
  CHANGES=""
  git log --oneline "HEAD..$TARGET_REF" | head -20 | sed 's/^/  /'
fi
echo
if $CHECK; then exit 0; fi
# Automatic updates never apply a release that needs someone to do something by hand.
if $YES && grep -q '^### Before you update' <<<"$CHANGES"; then
  info "Not updating automatically: $TARGET needs you to do something first (\"Before you update\" above)."
  info "Read it, then run ./scripts/update.sh yourself."
  exit 0
fi

if ! git diff --quiet HEAD; then
  git status --short | sed 's/^/  /' >&2
  die "The files above were changed on this machine. Commit or undo those changes (git stash), then update again."
fi
if ! $YES; then
  read -r -p "  Update to $TARGET now? The family can't use the cloud for a minute or two. [y/N] " ans || true
  [[ "$ans" =~ ^[Yy] ]] || { info "Not updated."; exit 0; }
fi

# A database copy from just before the update: database changes on start can't be undone
# otherwise. Kept separate from the nightly dumps; the last 3 are kept.
BACKUP_DIR=${BACKUP_DIR:-$STORAGE_ROOT/backups}
DUMP="$BACKUP_DIR/pre-update-$(date +%Y%m%d-%H%M%S).dump"
bold "Backing up the database"
( umask 077; docker compose exec -T db pg_dump -U familycloud -d familycloud -Fc > "$DUMP.partial" ) \
  || { rm -f "$DUMP.partial"; die "The database backup failed, so nothing was changed."; }
mv "$DUMP.partial" "$DUMP"
info "$DUMP ($(du -h "$DUMP" | cut -f1))"
ls -1t "$BACKUP_DIR"/pre-update-*.dump 2>/dev/null | tail -n +4 | xargs -r rm --

bold "Getting $TARGET"
if [[ "$CHANNEL" == stable ]]; then
  git -c advice.detachedHead=false checkout --quiet "$TARGET"
else
  git checkout --quiet main 2>/dev/null || git checkout --quiet -b main origin/main
  git merge --quiet --ff-only origin/main || die "main has commits of its own on this machine; can't fast-forward."
fi
export APP_VERSION
APP_VERSION=$(checkout_version)

# Official images are pinned to the exact release, so the image always matches these scripts.
# A custom IMAGE (e.g. your fork's registry) is left alone.
case "${IMAGE:-$RELEASE_IMAGE_REPO:latest}" in
  "$RELEASE_IMAGE_REPO":*|"$LOCAL_IMAGE")
    if [[ "$CHANNEL" == stable ]]; then IMAGE="$RELEASE_IMAGE_REPO:$TARGET"; else IMAGE=$LOCAL_IMAGE; fi
    set_env "$ENV_FILE" IMAGE "$IMAGE"
    ;;
esac
export IMAGE
if [[ "$IMAGE" == "$LOCAL_IMAGE" ]] || ! docker compose pull --quiet app 2>/dev/null; then
  info "Building the image on this machine (takes a few minutes)…"
  docker compose build app
fi
# Docker downloads the database, tunnel, Caddy and virus scanner images (postgres:18-alpine and
# so on) only once. Fetch their newest builds too, or their security fixes never arrive.
docker compose pull --quiet --ignore-buildable \
  || info "Couldn't download newer images for the database and other services; keeping the current ones."

bold "Restarting"
docker compose up -d --remove-orphans
if ! wait_healthy; then
  echo >&2
  info "Your files are untouched, and the database was backed up to:" >&2
  info "  $DUMP" >&2
  info "To go back to the version you had: git checkout $OLD_REF, set IMAGE in deploy/.env back" >&2
  info "to what it was, and restore that backup (docs/backup-restore.md, \"Restore\")." >&2
  exit 1
fi
bold "Updated: $FROM → $(running_version)"
