#!/usr/bin/env bash
# Family Cloud backup. Two layers:
#   1. Always: a consistent PostgreSQL dump in $STORAGE_ROOT/backups (keeps the last 14).
#   2. If RESTIC_REPOSITORY is set: an encrypted, deduplicated restic snapshot of the file
#      volumes + the dumps to another disk or cloud bucket (the part that survives a dead disk).
#
# The database and the files belong together: back up both, restore both.
# Run nightly, e.g. with cron:  15 2 * * *  /path/to/scripts/backup.sh >> /var/log/familycloud-backup.log 2>&1
#
# restic env (see docs/backup-restore.md): RESTIC_REPOSITORY, RESTIC_PASSWORD (or RESTIC_PASSWORD_FILE)
# plus provider credentials, e.g. B2_ACCOUNT_ID/B2_ACCOUNT_KEY or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.
set -euo pipefail
umask 077   # dumps hold password hashes and encrypted secrets

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
ROOT="$(pwd)"
load_env deploy/.env
load_env deploy/backup.env
STORAGE_ROOT=${STORAGE_ROOT:-/srv/familycloud}
BACKUP_DIR=${BACKUP_DIR:-$STORAGE_ROOT/backups}
KEEP_DUMPS=${KEEP_DUMPS:-14}
STAMP=$(date +%Y%m%d-%H%M%S)

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

mkdir -p "$BACKUP_DIR"
# A first off-site upload can take longer than a day; don't start a second run on top of it.
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { log "Another backup is still running; skipping this one."; exit 0; }

DUMP="$BACKUP_DIR/db-$STAMP.dump"
log "Dumping database → $DUMP"
trap 'rm -f "$DUMP.partial"' EXIT
(cd "$ROOT/deploy" && docker compose exec -T db pg_dump -U familycloud -d familycloud -Fc) > "$DUMP.partial"
mv "$DUMP.partial" "$DUMP"
log "Database dump: $(du -h "$DUMP" | cut -f1)"

# Rotate old dumps.
ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | tail -n +$((KEEP_DUMPS + 1)) | xargs -r rm --

if [[ -n "${RESTIC_REPOSITORY:-}" ]]; then
  command -v restic >/dev/null || { log "restic not installed (sudo apt install restic)"; exit 1; }
  # A backup disk that isn't plugged in leaves an empty folder (or none) on the system disk
  # where the repository was. A new repository there would quietly fill the system disk with a
  # copy of every file, so a folder repository is only ever created on the disk it was on.
  REPO_DIR=${RESTIC_REPOSITORY#local:}
  REPO_MOUNT_FILE=$(restic_mount_file "$BACKUP_DIR")
  if ! restic cat config >/dev/null 2>&1; then
    if [[ "$REPO_DIR" == /* && -f "$REPO_MOUNT_FILE" \
      && "$(mount_of "$REPO_DIR")" != "$(<"$REPO_MOUNT_FILE")" ]]; then
      log "Backup repository $RESTIC_REPOSITORY not found. Is the backup disk connected and"
      log "mounted at $(<"$REPO_MOUNT_FILE")? Nothing was backed up off this machine."
      exit 1
    fi
    log "Initializing restic repository"
    restic init
  fi
  remember_repo_mount "$BACKUP_DIR" "$RESTIC_REPOSITORY"
  log "restic backup of volumes + database dumps"
  # Thumbnails (cache/) are derived data and are deliberately skipped. So is each disk's
  # lost+found: only root can read it, and an unreadable folder fails the run before pruning.
  restic backup --tag familycloud --exclude '*/tmp/*' --exclude "$STORAGE_ROOT/volumes/*/lost+found" \
    "$STORAGE_ROOT/volumes" "$BACKUP_DIR"
  restic forget --tag familycloud --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
  log "restic done"
else
  log "RESTIC_REPOSITORY not set: only the local database dump was made."
  log "Files are NOT backed up off this machine. See docs/backup-restore.md."
fi
