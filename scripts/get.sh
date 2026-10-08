#!/usr/bin/env bash
# Family Cloud in one command, on the Linux computer that will run it:
#
#   curl -fsSL https://github.com/amoghkaja/Self-Hosted-Cloud-Storage/releases/latest/download/get.sh | bash
#
# Downloads Family Cloud into ~/familycloud (FC_DIR=/another/folder to choose; FC_REPO for a fork)
# and runs its installer, which asks a few questions, installs Docker if needed and starts
# everything. Run again, it runs the installer of the copy it made: your settings are kept.
# Options go to the installer: curl -fsSL … | bash -s -- --help
set -euo pipefail

# All in a function that runs once the whole script has arrived: a download cut off halfway
# runs nothing.
main() {
  local repo=${FC_REPO:-https://github.com/amoghkaja/Self-Hosted-Cloud-Storage.git}
  local dir=${FC_DIR:-$HOME/familycloud}
  local need=()
  die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

  [[ "$(uname -s)" == Linux ]] || die "Family Cloud runs on Linux."
  # Root would own the checkout and run the cloud as root; the installer asks for sudo itself.
  (( EUID != 0 )) || die "Run this as your everyday user, not as root (no sudo): the installer asks for your password when it needs it."

  command -v git >/dev/null || need+=(git)
  command -v openssl >/dev/null || need+=(openssl)
  if (( ${#need[@]} )); then
    command -v apt-get >/dev/null || die "Install ${need[*]} first, then run this again."
    echo "Installing ${need[*]} (sudo asks for your password)…"
    sudo apt-get update -qq
    sudo apt-get install -y -qq "${need[@]}"
  fi

  if [[ -e "$dir" ]]; then
    [[ -x "$dir/scripts/install.sh" ]] \
      || die "$dir already exists and isn't Family Cloud. Choose another folder: FC_DIR=/path/to/folder"
    echo "Family Cloud is already in $dir: running its installer again (your settings are kept)."
  else
    echo "Downloading Family Cloud into $dir…"
    git clone --quiet "$repo" "$dir"
  fi

  # The installer's questions need the keyboard, but with `curl … | bash` standard input is this
  # script. Without a terminal (`-y` runs), it carries on with what it has.
  if [[ ! -t 0 ]] && { : </dev/tty; } 2>/dev/null; then
    exec "$dir/scripts/install.sh" "$@" </dev/tty
  fi
  exec "$dir/scripts/install.sh" "$@"
}

main "$@"
