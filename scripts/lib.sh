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
