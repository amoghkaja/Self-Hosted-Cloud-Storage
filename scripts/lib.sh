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
running_version() {
  docker compose exec -T app node -p 'process.env.APP_VERSION || "unknown"' 2>/dev/null \
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
