# Shared helpers for Family Cloud's shell scripts.  Usage:  . "$(dirname "$0")/lib.sh"
# shellcheck shell=bash

# Loads KEY=VALUE lines from a dotenv file into exported variables *without executing it*
# (sourcing an env file would run any shell syntax inside it, and breaks on values such as
# "Family Cloud"). Reads the same subset Docker Compose does: unquoted, 'single-quoted' and
# "double-quoted" values, comments and blank lines. Variables already set in the environment
# win, so `PUBLIC_URL=... ./scripts/install.sh` overrides the file.
load_env() {
  local file=$1 line key val
  [[ -f "$file" ]] || return 0
  local assign='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
  local squoted="^'(.*)'[[:space:]]*$" dquoted='^"(.*)"[[:space:]]*$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ $assign ]] || continue
    key=${BASH_REMATCH[2]}
    val=${BASH_REMATCH[3]}
    [[ -n "${!key+set}" ]] && continue
    if [[ "$val" =~ $squoted || "$val" =~ $dquoted ]]; then
      val=${BASH_REMATCH[1]}
    else
      val=${val%%[[:space:]]#*}                   # strip an inline " # comment"
      val=${val%"${val##*[![:space:]]}"}          # strip trailing whitespace
    fi
    printf -v "$key" '%s' "$val"
    export "${key?}"
  done < "$file"
}

# Prints KEY=VALUE quoted so that both Docker Compose and load_env read VALUE back unchanged.
env_line() {
  local key=$1 val=$2
  local plain='^[A-Za-z0-9_./:@+,=-]*$' needs_escape='["$`\\]'
  if [[ "$val" == *$'\n'* ]]; then
    echo "Value for $key must be a single line" >&2
    return 1
  elif [[ "$val" =~ $plain ]]; then
    printf '%s=%s\n' "$key" "$val"
  elif [[ "$val" != *"'"* ]]; then
    printf "%s='%s'\n" "$key" "$val"
  elif ! [[ "$val" =~ $needs_escape ]]; then
    printf '%s="%s"\n' "$key" "$val"
  else
    echo "Value for $key can't contain both ' and one of: \" \$ \` \\" >&2
    return 1
  fi
}

# cache/updates under STORAGE_ROOT is shared with the app: update.sh leaves the update status there
# for it, and it leaves requests from Admin → Overview. The app (and the worker) run as this same
# user and can swap any name in it at any moment, so the two helpers below never follow a link
# there and only ever write new files, renamed into place.

# Enters that folder ($1 is STORAGE_ROOT), making it if needed, but only the real one: cache/ is
# the app's mount point and can't be swapped, while cache/updates can become a link at any time.
# Not as root, which would make the folder the app can't write to.
enter_shared() {
  local cache
  cd -P "$1/cache" 2>/dev/null || return 1
  cache=$PWD
  [[ -e updates || -L updates ]] || (( EUID == 0 )) || mkdir updates 2>/dev/null || true
  cd -P updates 2>/dev/null && [[ "$PWD" == "$cache/updates" ]]
}

# Writes stdin to file $1 in the current folder as a new file (noclobber creates it with O_EXCL,
# never through a link) renamed over the old one (mv -T: never into a folder put in its place).
publish() {
  local tmp
  tmp=$(mktemp -u .publish.XXXXXXXX) || return 1
  if (umask 022; set -C; cat >"$tmp") 2>/dev/null && mv -fT -- "$tmp" "$1"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}

# How updates happen is the admin's choice, UPDATES in deploy/.env: auto (by themselves at night),
# notify (shown in Admin → Overview, installed when the admin chooses) or manual (only by running
# update.sh). Asks it, setting UPDATES; $1 is the default answer, 1-3.
# shellcheck disable=SC2034  # UPDATES is for the script that asks
choose_updates() {
  local ans
  echo "  How should Family Cloud update?"
  echo "    1) By itself at night (around 4:30), with a database backup first"
  echo "    2) Show new versions in Admin → Overview; you choose when to install them"
  echo "    3) Only when you run ./scripts/update.sh"
  echo "  1 and 2 add the update helper to your crontab. It runs every minute and does nothing most"
  echo "  minutes: every 6 hours it asks GitHub whether there's a new version, and it answers the"
  echo "  Update now button in Admin → Overview."
  while true; do
    read -r -p "  Choose 1-3 [$1]: " ans || ans=$1
    case "${ans:-$1}" in
      1) UPDATES=auto; return ;;
      2) UPDATES=notify; return ;;
      3) UPDATES=manual; return ;;
    esac
  done
}

# The crontab lines Family Cloud looks after for the checkout in $1 (storage in $2): the update
# helper's, under a comment that says what it is, and the weekly automatic update that installers
# before it added. Lines of anyone's own, even ones that run update.sh, are never touched. The
# crontab is always read in full before it's written, and read without pipes into grep -q (which
# would end the reader early and, with pipefail, look like a failure).
helper_job() { echo "$(printf '%q' "$1/scripts/update.sh") --cron"; }
weekly_job() {
  echo "30 4 * * 0 $(printf '%q' "$1/scripts/update.sh") -y >> $(printf '%q' "$2/backups/update.log") 2>&1"
}
crontab_without_ours() {
  local current
  current=$(crontab -l 2>/dev/null) && [[ -n "$current" ]] || return 0
  FC_JOB=$(helper_job "$1") FC_WEEKLY=$(weekly_job "$1" "$2") awk '
    /^# Family Cloud update helper/ { next }
    !/^[[:space:]]*#/ && index($0, ENVIRON["FC_JOB"]) { next }
    $0 == ENVIRON["FC_WEEKLY"] { next }
    { print }' <<<"$current"
}

# Whether the crontab has the weekly automatic update earlier installers added.
weekly_update_job() {
  local current
  current=$(crontab -l 2>/dev/null) || return 1
  grep -qxF -- "$(weekly_job "$1" "$2")" <<<"$current"
}

update_helper_installed() {
  local current
  current=$(crontab -l 2>/dev/null) || return 1
  FC_JOB=$(helper_job "$1") awk '
    !/^[[:space:]]*#/ && index($0, ENVIRON["FC_JOB"]) { found = 1 }
    END { exit !found }' <<<"$current"
}

# Adds the update helper (in place of the weekly automatic update, if there is one). Fails
# without cron.
install_update_helper() {
  local rest
  command -v crontab >/dev/null || return 1
  rest=$(crontab_without_ours "$1" "$2")
  {
    if [[ -n "$rest" ]]; then printf '%s\n' "$rest"; fi
    echo "# Family Cloud update helper: looks for new versions every 6 hours and answers Admin > Overview; most minutes it does nothing. To turn it off: $(printf '%q' "$1/scripts/update.sh") --updates manual"
    echo "* * * * * $(helper_job "$1") >> $(printf '%q' "$2/backups/update.log") 2>&1"
  } | crontab -
}

remove_update_helper() {
  local rest
  command -v crontab >/dev/null || return 0
  rest=$(crontab_without_ours "$1" "$2")
  if [[ -n "$rest" ]]; then
    printf '%s\n' "$rest" | crontab -
  else
    crontab -r 2>/dev/null || true
  fi
}

# All physical disks underneath a block device, following partitions, LVM, LUKS and md-raid.
disks_under() {
  lsblk -nslo NAME,TYPE "$1" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u
}

# Replaces (or adds) one KEY=VALUE line in a dotenv file, keeping the rest and mode 600.
set_env() {
  local file=$1 key=$2 line tmp
  line=$(env_line "$key" "$3") || return 1
  tmp=$(mktemp "$file.XXXXXX")
  chmod 600 "$tmp"
  awk -v key="$key" -v line="$line" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "=" { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file"
}

# Where official release images are published (tags v0.1.0, v0.1, latest, edge).
# shellcheck disable=SC2034  # these two are used by the scripts that load this file
RELEASE_IMAGE_REPO=ghcr.io/amoghkaja/self-hosted-cloud-storage
# Image name for builds from the main branch; never pulled from a registry.
# shellcheck disable=SC2034
LOCAL_IMAGE=familycloud:local

# Whether the official image for release tag $1 is published yet: the release workflow pushes it
# some minutes after the tag. Fails too when the registry can't be reached.
image_published() {
  timeout 60 docker manifest inspect "$RELEASE_IMAGE_REPO:$1" >/dev/null 2>&1
}

# The newest release tag (vX.Y.Z; pre-releases such as v1.0.0-rc.1 are skipped), or nothing.
latest_release() {
  git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname 2>/dev/null | grep -v -- - | head -1 || true
}

# The version of the checked-out code: v0.2.0 on a release, v0.2.0-5-gabc1234 after it, or dev.
checkout_version() {
  git describe --tags --always --dirty 2>/dev/null || echo dev
}

# Waits for the app on 127.0.0.1:$APP_PORT to answer /healthz; prints recent logs if it doesn't.
# Run from deploy/. WAIT_SECS gives slow machines (e.g. a Pi's first start) longer.
wait_healthy() {
  local secs=${WAIT_SECS:-180}
  printf '  Waiting for the app to start'
  for _ in $(seq 1 $((secs / 2))); do
    if curl -fsS "http://127.0.0.1:${APP_PORT:-3080}/healthz" >/dev/null 2>&1; then
      echo " ready."
      return 0
    fi
    printf '.'
    sleep 2
  done
  echo
  printf '\033[31mThe app did not become healthy within %ss.\033[0m Recent logs:\n' "$secs" >&2
  docker compose ps >&2 || true
  docker compose logs --tail 40 app worker db >&2 || true
  return 1
}

# The version the running app reports ("unknown" for images older than v0.1.0), or "not running".
# Not reading stdin, which holds the answers to the questions asked after it.
running_version() {
  docker compose exec -T app node -p 'process.env.APP_VERSION || "unknown"' 2>/dev/null </dev/null \
    || echo "not running"
}

# CHANGELOG.md sections (from stdin) above the one for version $1: what's new since then.
changes_since() {
  awk -v from="$1" '
    /^## / { if (index($0, "## " from " ") == 1 || $0 == "## " from) exit; show = 1 }
    show { print }
  '
}

# The body of one version's CHANGELOG.md section (from stdin), e.g. changelog_section v0.2.0.
changelog_section() {
  awk -v v="$1" '
    /^## / { if (show) exit; show = (index($0, "## " v " ") == 1 || $0 == "## " v); next }
    show { print }
  '
}

# A path if it exists, otherwise its nearest existing parent (findmnt -T fails on a missing path).
nearest_existing() {
  local p=$1
  while [[ ! -e "$p" ]]; do p=$(dirname "$p"); done
  printf '%s\n' "$p"
}

# The mount point that holds a path (or, if it doesn't exist, its nearest existing parent).
mount_of() { findmnt -nro TARGET -T "$(nearest_existing "$1")"; }

# Where backup.sh remembers which mount point a folder repository's disk is on: an unplugged
# backup disk leaves an empty folder on the system disk, where no new repository may start.
restic_mount_file() { echo "$1/.restic-mount"; }

# Records that mount point for repository $2 (a /folder or local:/folder) in backup folder $1.
# Other repositories (sftp:, b2:, s3:) aren't on a disk of this machine: nothing is recorded.
remember_repo_mount() {
  local dir=${2#local:}
  if [[ "$dir" == /* ]]; then
    mkdir -p "$1"
    mount_of "$dir" > "$(restic_mount_file "$1")"
  fi
}
