#!/usr/bin/env bash
# Family Cloud updater: gets the newest version, backs up the database, restarts and checks
# that it came back (going back to the old version if the new one crashes). Your files, settings
# and accounts are kept; database changes apply on start.
#
#   ./scripts/update.sh            show what's new, ask, then update
#   ./scripts/update.sh --check    only show whether an update is available
#   ./scripts/update.sh -y         update without asking
#   ./scripts/update.sh --updates auto|notify|manual
#                                  how updates happen (UPDATES in deploy/.env): by themselves at
#                                  night, from Admin → Overview when you choose, or only by running
#                                  this. auto and notify add the update helper to your crontab
#                                  (a line with a comment saying what it is); manual removes it
#   ./scripts/update.sh --cron     the update helper, as that crontab line runs it
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

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

YES=false
CHECK=false
CRON=false
SET_UPDATES=""
while (($#)); do
  case "$1" in
    -y|--yes) YES=true ;;
    --check) CHECK=true ;;
    --cron) CRON=true ;;
    --updates)
      [[ "${2:-}" =~ ^(auto|notify|manual)$ ]] || die "Choose auto, notify or manual, e.g. ./scripts/update.sh --updates notify"
      SET_UPDATES=$2
      shift
      ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ ! -f "$ENV_FILE" ]]; then
  $CRON && exit 0
  die "No deploy/.env yet. Install first: ./scripts/install.sh"
fi
git rev-parse --git-dir >/dev/null 2>&1 || die "Updating needs the git checkout you installed from."
load_env "$ENV_FILE"
STORAGE_ROOT=${STORAGE_ROOT:-/srv/familycloud}
CHANNEL=${UPDATE_CHANNEL:-stable}
[[ "$CHANNEL" == stable || "$CHANNEL" == main ]] || die "UPDATE_CHANNEL must be stable or main."
UPDATES=${UPDATES:-}
# The helper only runs for auto and notify: left behind otherwise, it does nothing.
if $CRON && [[ "$UPDATES" != auto && "$UPDATES" != notify ]]; then exit 0; fi
[[ "$UPDATES" =~ ^(auto|notify|manual|)$ ]] || die "UPDATES in deploy/.env must be auto, notify or manual."
# Who started it: the helper says (browser, or auto at night); -y without a terminal, as from a
# crontab line of one's own, is automatic too; anything else is by hand.
if [[ -n "${FC_UPDATE_TRIGGER:-}" ]]; then
  TRIGGER=$FC_UPDATE_TRIGGER
elif $YES && [[ ! -t 0 ]]; then
  TRIGGER=auto
else
  TRIGGER=manual
fi

# What the updater remembers between runs (UPD_* settings): the last check and what it found, the
# update under way or how the last one went, and a version that failed once it reached the
# database, which automatic updates then skip. Kept with the backups, out of the app's reach, and
# shown to the app as cache/updates/status.json.
STATE=$STORAGE_ROOT/backups/.update-state
load_state() {
  unset "${!UPD_@}"
  load_env "$STATE"
}
save_state() {
  local tmp key
  tmp=$(mktemp "$STATE.XXXXXX") || return 1
  if { for key in "${!UPD_@}"; do env_line "$key" "${!key}"; done; } >"$tmp" && mv -f "$tmp" "$STATE"; then
    status_json | in_shared publish status.json || true
  else
    rm -f "$tmp"
    return 1
  fi
}
# Runs a command in cache/updates (enter_shared, lib.sh), in a subshell of its own.
in_shared() ( enter_shared "$STORAGE_ROOT" && "$@" )
# A JSON string for status.json: the value if it matches REGEX (by default a version, a time or a
# word), else null. Nothing is escaped, so nothing else gets through: some values come from the
# app's container (the running version).
jstr() {
  local re='^[A-Za-z0-9._:+-]{1,64}$'
  [[ -z "${2:-}" ]] || re=$2
  if [[ "$1" =~ $re ]]; then printf '"%s"' "$1"; else printf null; fi
}
jtime() { if [[ "$1" =~ ^[0-9]+$ ]]; then jstr "$(date -u -d "@$1" +%FT%TZ)"; else printf null; fi; }
jbool() { if [[ "$1" == 1 ]]; then printf true; else printf false; fi; }
status_json() {
  local tz next=""
  tz=$(readlink -f /etc/localtime 2>/dev/null) || tz=
  if [[ "$UPDATES" == auto ]]; then next=$(next_auto); fi
  printf '{"format":1,"channel":%s,"checkout":%s,"timezone":%s,"updates":%s,"nextAutoAt":%s,' \
    "$(jstr "$CHANNEL")" "$(jstr "$ROOT" '^/[A-Za-z0-9._/-]{1,200}$')" \
    "$(jstr "${tz#*/zoneinfo/}" '^[A-Za-z0-9_+/-]{1,64}$')" "$(jstr "$UPDATES")" "$(jtime "$next")"
  printf '"triedAt":%s,"checkedAt":%s,"problem":%s,"latest":%s,"ready":%s,"manualSteps":%s,' \
    "$(jtime "${UPD_TRIED_AT:-}")" "$(jtime "${UPD_CHECKED_AT:-}")" "$(jstr "${UPD_PROBLEM:-}")" \
    "$(jstr "${UPD_LATEST:-}")" "$(jbool "${UPD_READY:-1}")" "$(jbool "${UPD_MANUAL:-0}")"
  printf '"failedVersion":%s,"state":%s,"phase":%s,"from":%s,"to":%s,"at":%s,"reason":%s,"trigger":%s}\n' \
    "$(jstr "${UPD_FAILED_VERSION:-}")" "$(jstr "${UPD_STATE:-idle}")" "$(jstr "${UPD_PHASE:-}")" \
    "$(jstr "${UPD_FROM:-}")" "$(jstr "${UPD_TO:-}")" "$(jtime "${UPD_AT:-}")" \
    "$(jstr "${UPD_REASON:-}")" "$(jstr "${UPD_TRIGGER:-}")"
}
# What a check found: LATEST is the version to move to ("" when there's nothing newer), with
# what's new in it (notes.md), and MANUAL and READY say whether it can be installed unattended.
record_check() {
  UPD_TRIED_AT=$(date +%s)
  UPD_CHECKED_AT=$UPD_TRIED_AT UPD_LATEST=$1 UPD_MANUAL=$MANUAL UPD_READY=$READY
  if git diff --quiet HEAD; then UPD_PROBLEM=; else UPD_PROBLEM=local-changes; fi
  if [[ -n "$1" ]]; then printf '%s\n' "$CHANGES"; fi | in_shared publish notes.md || true
  save_state || true
}
# The update under way ends: STATE is done, rolled-back or failed, with REASON build, backup,
# start, rollback or error. A version that failed after it reached the database (it crashed or
# never answered) isn't installed automatically again.
finish() {
  local how="$1/${2:-}"
  if [[ "$how" == rolled-back/ || "$how" == failed/start || "$how" == failed/rollback \
    || ( "$how" == failed/error && "${UPD_PHASE:-}" == restart ) ]]; then
    UPD_FAILED_VERSION=${UPD_TO:-}
  fi
  if [[ "$1" == "done" ]]; then
    [[ "${UPD_FAILED_VERSION:-}" != "${UPD_TO:-}" ]] || UPD_FAILED_VERSION=
    UPD_LATEST=
    in_shared publish notes.md </dev/null || true
  fi
  UPD_STATE=$1 UPD_REASON=${2:-} UPD_PHASE=
  UPD_AT=$(date +%s)
  save_state || true
}
set_phase() { UPD_PHASE=$1; save_state || true; }
# An update cut short: killed, or a step failed that isn't handled where it happens.
cut_short() { if [[ "${UPD_STATE:-}" == updating ]]; then finish failed error; fi; }

# For the update helper (--cron). The requests the app leaves in cache/updates (Admin → Overview)
# are empty files whose name is the whole request: only regular files with these exact names
# count, and none is ever opened.
list_requests() {
  local f
  for f in request-auto-on request-auto-off request-check request-update-*; do
    if [[ ! -L "$f" && -f "$f" \
      && "$f" =~ ^request-(auto-on|auto-off|check|update-[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$ ]]; then
      printf '%s\n' "$f"
    fi
  done
}
# A check every 6 hours, so the app knows about new versions.
check_due() { (( $(date +%s) - ${UPD_TRIED_AT:-0} >= 6 * 3600 )); }
# Automatic updates, once a night from 04:30 to 05:29 by this computer's clock (every 10 minutes
# while the code repository can't be reached). A computer that's off then waits for the next.
auto_due() {
  local now
  now=$(date +%H%M)
  [[ "$UPDATES" == auto && "${UPD_AUTO_DAY:-}" != "$(date +%F)" ]] \
    && (( 10#$now >= 430 && 10#$now < 530 && $(date +%s) - ${UPD_TRIED_AT:-0} >= 600 ))
}
# When they next run (epoch): at 04:30 tonight, or tomorrow once tonight's has.
next_auto() {
  if [[ "${UPD_AUTO_DAY:-}" == "$(date +%F)" ]] || (( 10#$(date +%H%M) >= 530 )); then
    date -d 'tomorrow 04:30' +%s
  else
    date -d '04:30' +%s
  fi
}
# Runs update.sh with ARGS as a child on this run's lock, for WHO (browser, or auto). Its output
# goes to the log for an update or a failure, and an update that fails leaves its end for the app
# (update.log).
run_child() {
  local who=$1 out since rc=0
  shift
  out=$(mktemp "$STORAGE_ROOT/backups/.update-run.XXXXXX")
  since=$(date +%s)
  FC_UPDATE_TRIGGER=$who "$ROOT/scripts/update.sh" "$@" >"$out" 2>&1 </dev/null || rc=$?
  load_state
  if [[ "$1" == -y ]] || ((rc)); then
    printf '\n%s  update.sh %s (%s)\n' "$(date '+%F %T')" "$*" "$who"
    cat "$out"
  fi
  if [[ "${UPD_STATE:-}" == failed || "${UPD_STATE:-}" == rolled-back ]] && (( ${UPD_AT:-0} >= since )); then
    sed 's/\x1b\[[0-9;]*m//g' "$out" | tail -n 80 | in_shared publish update.log || true
  fi
  rm -f "$out"
  return "$rc"
}

# The helper's minute: most of the time there's nothing to do, which it decides from file names
# and the clock alone (no git, no docker, no writes, no output).
if $CRON; then
  load_state
  [[ -n "$(in_shared list_requests)" || "${UPD_STATE:-}" == updating ]] || check_due || auto_due \
    || exit 0
fi

# One update at a time (a cron run and a manual one could otherwise overlap). An update the helper
# starts runs as its child, on the lock it inherited; by hand, wait a moment for the helper.
[[ -n "${FC_UPDATE_TRIGGER:-}" ]] || exec 9>"$STORAGE_ROOT/backups/.update.lock"
if $CRON; then
  flock -n 9 || exit 0
else
  flock -w 30 9 || die "Another update is already running."
fi
load_state
# Holding the lock, an update still under way is one that was cut short (by a power cut, say).
cut_short

if $CRON; then
  REQUESTS=$(in_shared list_requests || true)
  has() { grep -qxF -- "$1" <<<"$REQUESTS"; }
  # Automatic updates switched on or off in Admin → Overview (the newer request wins): UPDATES
  # becomes auto or notify. Turning the helper itself off takes --updates manual on the server.
  if has request-auto-on || has request-auto-off; then
    if has request-auto-on && ! { has request-auto-off && in_shared test request-auto-off -nt request-auto-on; }; then
      UPDATES=auto
    else
      UPDATES=notify
    fi
    set_env "$ENV_FILE" UPDATES "$UPDATES" || true
    echo "$(date '+%F %T')  Admin → Overview set updates to $UPDATES (UPDATES in deploy/.env)."
    save_state || true
    in_shared rm -f -- request-auto-on request-auto-off || true
  fi
  # Versions to install from Admin → Overview. One asked for while nothing was answering is
  # dropped: an update shouldn't start half an hour or more later.
  mapfile -t ASKED < <(grep '^request-update-' <<<"$REQUESTS" || true)
  WANTED=""
  for r in "${ASKED[@]}"; do
    if (( $(date +%s) - $(in_shared stat -c %Y -- "$r" || echo 0) <= 1800 )); then
      WANTED+="${r#request-update-}"$'\n'
    else
      in_shared rm -f -- "$r" || true
    fi
  done
  NIGHT=false
  if auto_due; then NIGHT=true; fi
  if [[ -n "$WANTED" ]] || has request-check || check_due || $NIGHT; then
    if run_child auto --check; then
      if [[ -n "${UPD_LATEST:-}" ]] && grep -qxF -- "$UPD_LATEST" <<<"$WANTED"; then
        run_child browser -y || true
      elif $NIGHT && [[ "${UPD_READY:-1}" == 1 ]]; then
        if [[ -n "${UPD_LATEST:-}" && "$UPD_LATEST" != "${UPD_FAILED_VERSION:-}" ]]; then
          run_child auto -y || true
        fi
        # That's tonight's, unless the image was still being published: then again in 10 minutes.
        UPD_AUTO_DAY=$(date +%F)
        save_state || true
      fi
    fi
    # Answered, however it went: status.json says what happened.
    in_shared rm -f -- request-check "${ASKED[@]}" || true
  fi
  exit 0
fi

# Sets how updates happen: UPDATES in deploy/.env, and the update helper in the crontab for auto
# and notify (not for manual). Says what it changed.
set_updates() {
  if [[ "$1" != manual ]] && ! command -v crontab >/dev/null; then
    die "This computer has no cron (sudo apt install cron), which the update helper needs."
  fi
  UPDATES=$1
  set_env "$ENV_FILE" UPDATES "$UPDATES"
  if [[ "$UPDATES" == manual ]]; then
    if update_helper_installed "$ROOT" || weekly_update_job "$ROOT" "$STORAGE_ROOT"; then
      remove_update_helper "$ROOT" "$STORAGE_ROOT"
      info "Removed the update helper from your crontab."
    fi
  elif ! update_helper_installed "$ROOT"; then
    install_update_helper "$ROOT" "$STORAGE_ROOT"
    info "Added the update helper to your crontab (crontab -l shows it, with a note of what it is)."
  fi
  case "$UPDATES" in
    auto) info "Updates install themselves at night, around 4:30, with a database backup first." ;;
    notify) info "New versions show in Admin → Overview; you choose when to install them." ;;
    manual) info "Updates happen only when you run ./scripts/update.sh." ;;
  esac
  save_state || true
}

if [[ -n "$SET_UPDATES" ]]; then
  set_updates "$SET_UPDATES"
  exit 0
fi

# An install from before UPDATES gets it here, never behind anyone's back: the weekly automatic
# update earlier installers added means auto (the helper takes over its crontab line, at night
# instead of on Sundays); otherwise whoever runs this at a terminal is asked. An unattended run
# changes nothing.
if [[ -z "$UPDATES" ]] && ! $CHECK && [[ -z "${FC_UPDATE_TRIGGER:-}" ]]; then
  if weekly_update_job "$ROOT" "$STORAGE_ROOT"; then
    info "Automatic updates now run every night instead of on Sundays."
    set_updates auto
  elif [[ -t 0 ]] && ! $YES; then
    # Suggested only for releases: the main branch can change daily.
    if [[ "$CHANNEL" == stable ]]; then choose_updates 1; else choose_updates 2; fi
    set_updates "$UPDATES"
  fi
fi

cd "$ROOT/deploy"
FROM=$(running_version)
OLD_REF=$(git rev-parse HEAD)
MANUAL=0
READY=1

# The version to move to: sets TARGET, TARGET_REF, TARGET_COMMIT and CHANGES (what's new since the
# running version). Fails when the code repository can't be reached.
find_update() {
  git fetch --quiet --tags origin || return 1
  if [[ "$CHANNEL" == stable ]]; then
    TARGET=$(latest_release)
    # No releases published yet: follow the main branch.
    [[ -n "$TARGET" ]] || CHANNEL=main
  fi
  if [[ "$CHANNEL" == main ]]; then
    git rev-parse --verify --quiet origin/main >/dev/null || die "No origin/main branch to follow."
    TARGET=$(git describe --tags --always origin/main)
    TARGET_REF=origin/main
  else
    TARGET_REF=$TARGET
  fi
  TARGET_COMMIT=$(git rev-parse "$TARGET_REF^{commit}")
  CHANGES=""
  if git cat-file -e "$TARGET_REF:CHANGELOG.md" 2>/dev/null; then
    # Release versions only: v0.2.0-5-gabc1234 was built after v0.2.0.
    CHANGES=$(git show "$TARGET_REF:CHANGELOG.md" | changes_since "${FROM%%-*}" \
      | { if [[ "$CHANNEL" == stable ]]; then sed '/^## Unreleased$/d'; else cat; fi; })
  fi
}

bold "Checking for updates ($CHANNEL)"
if ! find_update; then
  UPD_TRIED_AT=$(date +%s) UPD_PROBLEM=offline
  save_state || true
  die "Couldn't reach the code repository. Check the internet connection."
fi
[[ "$CHANNEL" == "${UPDATE_CHANNEL:-stable}" ]] || info "No releases published yet, so following the main branch."

info "Running:   $FROM"
info "Available: $TARGET"
if [[ "$FROM" == "$TARGET" && "$OLD_REF" == "$TARGET_COMMIT" ]]; then
  record_check ""
  bold "Already up to date."
  exit 0
fi
# Database changes only go forwards, so never back: a checkout ahead of what the channel offers
# (a test version, or main after the newest release) stays as it is.
if [[ "$OLD_REF" != "$TARGET_COMMIT" ]] && git merge-base --is-ancestor "$TARGET_COMMIT" HEAD; then
  record_check ""
  bold "Already newer than $TARGET."
  exit 0
fi

echo
bold "What's new"
if [[ -n "$CHANGES" ]]; then
  sed 's/^/  /' <<<"$CHANGES" | head -60
else
  git log --oneline "HEAD..$TARGET_REF" | head -20 | sed 's/^/  /'
fi
echo
if grep -q '^### Before you update' <<<"$CHANGES"; then MANUAL=1; fi
# Official images are pinned to the exact release, so the image always matches these scripts.
# A custom IMAGE (e.g. your fork's registry) is left alone.
case "${IMAGE:-$RELEASE_IMAGE_REPO:latest}" in
  "$RELEASE_IMAGE_REPO":*|"$LOCAL_IMAGE") PINNED=true ;;
  *) PINNED=false ;;
esac
# Until the release's image is published, this computer would build it instead: slow, and very
# slow on a Raspberry Pi. Unattended updates wait for it.
if $PINNED && [[ "$CHANNEL" == stable ]] && ! image_published "$TARGET"; then READY=0; fi
record_check "$TARGET"
# Automatic updates never apply a release that needs someone to do something by hand.
if $YES && ((MANUAL)); then
  info "Not updating automatically: $TARGET needs you to do something first (\"Before you update\" above)."
  info "Read it, then run ./scripts/update.sh yourself."
  exit 0
fi
if ((!READY)); then
  if $YES; then
    info "Not updating yet: the $TARGET image is still being published. The next run tries again."
    exit 0
  fi
  info "The $TARGET image isn't published yet, so updating now builds it on this computer (slow)."
  echo
fi
if $CHECK; then exit 0; fi
# Nor one that already failed here after it reached the database: it waits for a newer version,
# or for someone to try it again by hand.
if [[ "$TRIGGER" == auto && "$TARGET" == "${UPD_FAILED_VERSION:-}" ]]; then
  info "Not updating automatically: $TARGET didn't start here last time."
  info "Run ./scripts/update.sh yourself to try it again."
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

# From here on the update is under way, and status.json says how it's going.
UPD_STATE=updating UPD_PHASE=download UPD_FROM=$FROM UPD_TO=$TARGET UPD_REASON='' UPD_TRIGGER=$TRIGGER
UPD_AT=$(date +%s)
save_state || true
in_shared rm -f update.log || true
trap cut_short EXIT

# What to go back to if the new version can't be used: this checkout, the IMAGE setting, and the
# image the app runs now, under a name of its own (a local build's name is about to move on, and
# Docker can then forget the old image).
OLD_BRANCH=$(git symbolic-ref --quiet --short HEAD || true)
OLD_IMAGE=${IMAGE:-}
PREVIOUS_IMAGE=familycloud:before-update
docker image rm "$PREVIOUS_IMAGE" >/dev/null 2>&1 || true
APP_ID=$(docker compose ps -q app 2>/dev/null || true)
if [[ -n "$APP_ID" ]]; then docker tag "$(docker inspect -f '{{.Image}}' "$APP_ID")" "$PREVIOUS_IMAGE" || true; fi
back_to_previous() {
  # The app starts again only with the image it ran, under its old name again. Without that (it
  # wasn't running, or the tag failed) it stays stopped: the old name may now hold the new
  # version, whose database changes would then apply with no backup.
  local restore=0 failed=0
  if docker image inspect "$PREVIOUS_IMAGE" >/dev/null 2>&1; then
    docker tag "$PREVIOUS_IMAGE" "${OLD_IMAGE:-$RELEASE_IMAGE_REPO:latest}" || return 1
    restore=1
  fi
  IMAGE=$OLD_IMAGE
  # Each step is tried even if one before it failed: a full disk (a likely reason the update
  # failed) can stop the checkout or the .env write, and that must not leave the app stopped.
  if [[ -n "$OLD_BRANCH" ]]; then
    git checkout --quiet -B "$OLD_BRANCH" "$OLD_REF"
  else
    git -c advice.detachedHead=false checkout --quiet "$OLD_REF"
  fi || failed=1
  set_env "$ENV_FILE" IMAGE "$IMAGE" || failed=1
  # Back once it answers, not once its container starts: the update ends right after this.
  if ((restore)); then
    docker compose up -d --remove-orphans && wait_healthy || failed=1
  fi
  return "$failed"
}
# After a new version crashed on start: the database as the backup below holds it, then the
# previous version. The database the new version had is kept as familycloud_failed_update until
# this happens again.
db_sql() {
  docker compose exec -T -e PGOPTIONS='--client-min-messages=warning' db \
    psql -U familycloud -d postgres -v ON_ERROR_STOP=1 -qc "$1"
}
roll_back() {
  docker image inspect "$PREVIOUS_IMAGE" >/dev/null 2>&1 || return 1
  bold "Going back to $FROM"
  docker compose stop app worker || return 1
  db_sql 'DROP DATABASE IF EXISTS familycloud_restore' || return 1
  db_sql 'CREATE DATABASE familycloud_restore' || return 1
  docker compose exec -T db pg_restore -U familycloud -d familycloud_restore --exit-on-error <"$DUMP" \
    || return 1
  db_sql 'DROP DATABASE IF EXISTS familycloud_failed_update' || return 1
  db_sql 'ALTER DATABASE familycloud RENAME TO familycloud_failed_update' || return 1
  db_sql 'ALTER DATABASE familycloud_restore RENAME TO familycloud' || return 1
  back_to_previous
}
# Crashed (restarted or stopped), rather than still busy with a big database change on a slow
# computer: that one is left to finish.
app_crashed() {
  local id
  id=$(docker compose ps -aq app) && [[ -n "$id" ]] || return 0
  [[ "$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$id")" != "0 running" ]]
}

bold "Getting $TARGET"
if [[ "$CHANNEL" == stable ]]; then
  git -c advice.detachedHead=false checkout --quiet "$TARGET"
else
  git checkout --quiet main 2>/dev/null || git checkout --quiet -b main origin/main
  git merge --quiet --ff-only origin/main || die "main has commits of its own on this machine; can't fast-forward."
fi
export APP_VERSION
APP_VERSION=$(checkout_version)

if $PINNED; then
  if [[ "$CHANNEL" == stable ]]; then IMAGE="$RELEASE_IMAGE_REPO:$TARGET"; else IMAGE=$LOCAL_IMAGE; fi
  set_env "$ENV_FILE" IMAGE "$IMAGE"
fi
export IMAGE
if [[ "$IMAGE" == "$LOCAL_IMAGE" ]] || ! docker compose pull --quiet app 2>/dev/null; then
  info "Building the image on this machine (takes a few minutes)…"
  if ! docker compose build app; then
    back_to_previous || true
    finish failed build
    die "Building $TARGET failed (see above), so nothing was changed."
  fi
fi
# Docker downloads the database, tunnel, Caddy and virus scanner images (postgres:18-alpine and
# so on) only once. Fetch their newest builds too, or their security fixes never arrive.
docker compose pull --quiet --ignore-buildable \
  || info "Couldn't download newer images for the database and other services; keeping the current ones."

# A database copy from just before the new version starts: database changes on start can't be
# undone otherwise. The app and worker stop first, so the copy holds everything they wrote while
# the new version was downloaded or built. Kept apart from the nightly dumps; the last 3 are kept.
BACKUP_DIR=${BACKUP_DIR:-$STORAGE_ROOT/backups}
DUMP="$BACKUP_DIR/pre-update-$(date +%Y%m%d-%H%M%S).dump"
bold "Backing up the database"
set_phase backup
docker compose stop app worker
if ! ( umask 077; docker compose exec -T db pg_dump -U familycloud -d familycloud -Fc > "$DUMP.partial" ); then
  rm -f "$DUMP.partial"
  back_to_previous || true
  finish failed backup
  die "The database backup failed, so nothing was changed."
fi
mv "$DUMP.partial" "$DUMP"
info "$DUMP ($(du -h "$DUMP" | cut -f1))"
ls -1t "$BACKUP_DIR"/pre-update-*.dump 2>/dev/null | tail -n +4 | xargs -r rm --

bold "Restarting"
set_phase restart
docker compose up -d --remove-orphans
if ! wait_healthy; then
  echo >&2
  if app_crashed; then
    if roll_back; then
      finish rolled-back
      bold "Back on $FROM: $TARGET didn't start (see the logs above)."
      info "The database is as it was just before the update. Automatic updates now skip $TARGET;"
      info "run ./scripts/update.sh yourself to try it again."
      exit 1
    fi
    finish failed rollback
  else
    finish failed start
  fi
  info "Your files are untouched, and the database was backed up to:" >&2
  info "  $DUMP" >&2
  info "To go back to the version you had: git checkout $OLD_REF, set IMAGE=$OLD_IMAGE in" >&2
  info "deploy/.env (the image it ran is kept as $PREVIOUS_IMAGE), and restore that backup" >&2
  info "(docs/backup-restore.md, \"Restore\")." >&2
  exit 1
fi
# The images the previous version ran are no longer needed: each is hundreds of MB, and they'd
# pile up on the system disk with every update. Going back to it means downloading it again.
docker image rm "$PREVIOUS_IMAGE" >/dev/null 2>&1 || true
if [[ "$OLD_IMAGE" == "$RELEASE_IMAGE_REPO":* && "$OLD_IMAGE" != "$IMAGE" ]]; then
  docker image rm "$OLD_IMAGE" >/dev/null 2>&1 || true
fi
docker image prune -f >/dev/null || true
finish "done"
bold "Updated: $FROM → $(running_version)"
