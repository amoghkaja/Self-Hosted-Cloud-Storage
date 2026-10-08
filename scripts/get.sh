#!/usr/bin/env bash
# Family Cloud in one command, on the Linux computer that will run it:
#
#   curl -fsSL https://github.com/amoghkaja/Self-Hosted-Cloud-Storage/releases/latest/download/get.sh | bash
#
# Says what it will do and asks first. Then it downloads Family Cloud into ~/familycloud
# (FC_DIR=/another/folder to choose; FC_REPO for a fork) and runs its installer, which asks a few
# questions, installs Docker if needed (asking first) and starts everything. Run again, it runs the
# installer of the copy it made: your settings are kept. Options go to the installer:
# curl -fsSL … | bash -s -- --help. To read it before running it: download it, open it, then
# `bash get.sh`; get.sh.sha256 next to it on the release page checks the download.
set -euo pipefail

# All in a function that runs once the whole script has arrived: a download cut off halfway
# runs nothing.
main() {
  local repo=${FC_REPO:-https://github.com/amoghkaja/Self-Hosted-Cloud-Storage.git}
  local dir=${FC_DIR:-$HOME/familycloud}
  local need=() yes=false arg ans
  die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
  for arg in "$@"; do [[ "$arg" != -y && "$arg" != --yes ]] || yes=true; done

  [[ "$(uname -s)" == Linux ]] || die "Family Cloud runs on Linux."
  # Root would own the checkout and run the cloud as root; the installer asks for sudo itself.
  (( EUID != 0 )) || die "Run this as your everyday user, not as root (no sudo): the installer asks for your password when it needs it."
  if [[ -e "$dir" && ! -x "$dir/scripts/install.sh" ]]; then
    die "$dir already exists and isn't Family Cloud. Choose another folder: FC_DIR=/path/to/folder"
  fi
  command -v git >/dev/null || need+=(git)
  command -v openssl >/dev/null || need+=(openssl)
  if (( ${#need[@]} )) && ! command -v apt-get >/dev/null; then
    die "Install ${need[*]} first, then run this again."
  fi

  # Like any installer: say what's about to happen, and change nothing before the answer.
  echo "Family Cloud installer. This will:"
  if (( ${#need[@]} )); then echo "  - install ${need[*]} with apt (asks for your password, for sudo)"; fi
  if [[ -e "$dir" ]]; then
    echo "  - run the installer of the Family Cloud in $dir again (your settings are kept)"
  else
    echo "  - download Family Cloud from $repo into $dir"
    echo "  - run its installer (scripts/install.sh), which asks a few questions before it sets"
    echo "    anything up, and says what it did at the end"
  fi
  # The questions need the keyboard: with `curl … | bash`, standard input is this script. With
  # no terminal at all (or -y), it carries on without asking.
  if ! $yes && { : </dev/tty; } 2>/dev/null; then
    read -r -p "Continue? [Y/n] " ans </dev/tty || ans=n
    [[ "${ans:-y}" =~ ^[Yy] ]] || { echo "Nothing was changed."; exit 0; }
  fi

  if (( ${#need[@]} )); then
    sudo apt-get update -qq
    sudo apt-get install -y -qq "${need[@]}"
  fi
  if [[ ! -e "$dir" ]]; then
    echo "Downloading Family Cloud into $dir…"
    git clone --quiet "$repo" "$dir"
  fi
  if [[ ! -t 0 ]] && { : </dev/tty; } 2>/dev/null; then
    exec "$dir/scripts/install.sh" "$@" </dev/tty
  fi
  exec "$dir/scripts/install.sh" "$@"
}

main "$@"
