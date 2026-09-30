#!/usr/bin/env bash
# Sets up off-site backups: asks where they go, writes deploy/backup.env with a fresh restic
# password (keys are typed hidden and never echoed), runs the first backup and schedules
# scripts/backup.sh nightly with cron. Safe to re-run: an existing deploy/backup.env is kept.
#
#   ./scripts/backup-setup.sh
set -euo pipefail
umask 077   # backup.env holds the restic password and the storage provider's keys

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"
BACKUP_ENV="$ROOT/deploy/backup.env"
trap 'rm -f "$BACKUP_ENV.partial"' EXIT

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "Question" "default"
  local var=$1 q=$2 def=${3:-} ans
  read -r -p "  $q${def:+ [$def]}: " ans || true
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_secret() { # ask_secret VAR "Question": not echoed, not in shell history
  local var=$1 q=$2 ans
  read -r -s -p "  $q (hidden): " ans || true
  echo
  [[ -n "$ans" ]] || die "$q is required."
  printf -v "$var" '%s' "$ans"
}
yes_no() { # yes_no "Question" [default y|n]
  local def=${2:-y} ans
  read -r -p "  $1 $([[ $def == y ]] && echo '[Y/n]' || echo '[y/N]'): " ans || true
  [[ "${ans:-$def}" =~ ^[Yy] ]]
}
# Physical disks holding a path (or, if it doesn't exist yet, its nearest existing parent).
disks_of() {
  local p=$1 src
  while [[ ! -e "$p" ]]; do p=$(dirname "$p"); done
  src=$(findmnt -nvo SOURCE -T "$p" 2>/dev/null) || return 0
  if [[ -b "$src" ]]; then disks_under "$src"; fi
}

[[ -t 0 ]] || die "Run this in a terminal: it asks questions and keys are typed hidden."
load_env deploy/.env
STORAGE_ROOT=${STORAGE_ROOT:-/srv/familycloud}

bold "Family Cloud backup setup"

if [[ -f "$BACKUP_ENV" ]]; then
  bold "Found deploy/backup.env; keeping it."
  info "To switch destinations, move it aside first. Keep its RESTIC_PASSWORD: the"
  info "backups already made with it can't be read without it."
  load_env "$BACKUP_ENV"
else
  echo
  info "Where should backups go? Keep at least one copy off this machine."
  info "  1) A USB disk or another disk in this computer"
  info "  2) Another computer, over SSH"
  info "  3) Backblaze B2"
  info "  4) Other S3-compatible storage (Wasabi, Cloudflare R2, MinIO, AWS…)"
  info "  5) Nowhere yet: only keep nightly database dumps on this machine"
  ask CHOICE "Choose 1-5" ""
  KEY_VARS=()   # names of the provider's two key variables, if it has any
  case "$CHOICE" in
    1)
      ask DEST "Folder on that disk (e.g. /mnt/backup-disk/familycloud)" ""
      [[ "$DEST" == /* ]] || die "Give the full path, starting with /."
      shared=$(comm -12 <(disks_of "$DEST" | sort -u) <( (disks_of "$STORAGE_ROOT"; for v in "$STORAGE_ROOT"/volumes/*; do disks_of "$v"; done) | sort -u))
      if [[ -n "$shared" ]]; then
        warn "$DEST is on the same disk as your files ($(echo "$shared" | xargs))."
        warn "If that disk fails, the backup is lost with it."
        yes_no "Use it anyway?" n || die "Nothing was changed."
      fi
      RESTIC_REPOSITORY=$DEST
      ;;
    2)
      ask DEST "user@host:/folder on the other computer" ""
      [[ "$DEST" =~ ^[^[:space:]:]+:/.+ ]] || die "Use the form user@host:/folder."
      info "The nightly job can't type a password: set up an SSH key for it first"
      info "(ssh-copy-id ${DEST%%:*}) and check that ssh ${DEST%%:*} logs in without asking."
      RESTIC_REPOSITORY=sftp:$DEST
      ;;
    3)
      info "On backblaze.com, create a private bucket and an application key limited to it (Read and Write)."
      ask BUCKET "Bucket name" ""
      ask KEY_ID "keyID" ""
      ask_secret KEY "applicationKey"
      [[ -n "$BUCKET" && -n "$KEY_ID" ]] || die "The bucket name and keyID are required."
      RESTIC_REPOSITORY=b2:$BUCKET:familycloud
      KEY_VARS=(B2_ACCOUNT_ID B2_ACCOUNT_KEY)
      ;;
    4)
      ask ENDPOINT "Endpoint URL (e.g. https://s3.eu-central-1.wasabisys.com)" ""
      ask BUCKET "Bucket name" ""
      ask KEY_ID "Access key ID" ""
      ask_secret KEY "Secret access key"
      [[ "$ENDPOINT" =~ ^https?://[^/[:space:]]+/?$ ]] || die "The endpoint must look like https://s3.example.com."
      [[ -n "$BUCKET" && -n "$KEY_ID" ]] || die "The bucket name and access key ID are required."
      RESTIC_REPOSITORY=s3:${ENDPOINT%/}/$BUCKET/familycloud
      KEY_VARS=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)
      ;;
    5) RESTIC_REPOSITORY="" ;;
    *) die "Choose a number from 1 to 5." ;;
  esac

  if [[ -n "$RESTIC_REPOSITORY" ]]; then
    command -v openssl >/dev/null || die "openssl is required (sudo apt install openssl)."
    RESTIC_PASSWORD=$(openssl rand -hex 32)
    {
      echo "# Written by scripts/backup-setup.sh. Keep a copy of RESTIC_PASSWORD off this machine."
      env_line RESTIC_REPOSITORY "$RESTIC_REPOSITORY"
      env_line RESTIC_PASSWORD "$RESTIC_PASSWORD"
      if ((${#KEY_VARS[@]})); then
        env_line "${KEY_VARS[0]}" "$KEY_ID"
        env_line "${KEY_VARS[1]}" "$KEY"
      fi
    } > "$BACKUP_ENV.partial"
    chmod 600 "$BACKUP_ENV.partial"
    mv "$BACKUP_ENV.partial" "$BACKUP_ENV"
    unset KEY
    export RESTIC_REPOSITORY RESTIC_PASSWORD
    bold "Wrote deploy/backup.env"
    echo
    bold "Save this backup password in your password manager NOW:"
    echo
    printf '    %s\n' "$RESTIC_PASSWORD"
    echo
    info "Without it nobody, including you, can read the backups. If this computer dies,"
    info "the copy in deploy/backup.env dies with it."
    read -r -p "  Press Enter once it's saved. " _ || true
    unset RESTIC_PASSWORD
  fi
fi

if [[ -n "${RESTIC_REPOSITORY:-}" ]] && ! command -v restic >/dev/null; then
  warn "restic isn't installed, so only database dumps will be made until it is:"
  warn "  sudo apt install restic"
fi

echo
if yes_no "Run a backup now? The first off-site one can take hours for a large library."; then
  "$ROOT/scripts/backup.sh" || die "The backup failed; see the messages above. Fix it and run ./scripts/backup-setup.sh again."
fi

echo
CRON_LINE="15 2 * * * $(printf '%q' "$ROOT/scripts/backup.sh") >> $(printf '%q' "$HOME/familycloud-backup.log") 2>&1"
if ! command -v crontab >/dev/null; then
  warn "cron isn't installed. Schedule this line nightly some other way:"
  info "$CRON_LINE"
elif crontab -l 2>/dev/null | grep -F "$ROOT/scripts/backup.sh" >/dev/null; then
  bold "Nightly backups are already scheduled (crontab -l to see them)."
elif yes_no "Back up every night at 02:15?"; then
  { crontab -l 2>/dev/null || true; echo "$CRON_LINE"; } | crontab -
  bold "Scheduled. The log is in ~/familycloud-backup.log."
fi

echo
info "Test a restore once in a while: see docs/backup-restore.md."
