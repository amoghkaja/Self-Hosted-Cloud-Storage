#!/usr/bin/env bash
# Guided "add a disk" for Family Cloud. Mounts a disk (or partition) under
# $STORAGE_ROOT/volumes/<name> so the running app can use it, and adds it to /etc/fstab so it
# comes back after a reboot. Afterwards register it in the web app: Admin → Storage → Add disk.
#
# It never formats anything unless you explicitly confirm by typing the device path, and it
# refuses disks that hold the operating system.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
load_env deploy/.env
STORAGE_ROOT=${STORAGE_ROOT:-/srv/familycloud}
PUID=${PUID:-$(id -u)}
PGID=${PGID:-$(id -g)}

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

bold "Disks on this machine"
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT,MODEL
echo
read -r -p "Device to use (e.g. /dev/sdb1 or /dev/nvme2n1p1): " DEV || die "No device given."
[[ -b "$DEV" ]] || die "$DEV is not a block device."

# Refuse any device that shares a physical disk with the running system. Follow the whole
# device stack (partition → LVM/LUKS/md → disk), because on LVM or encrypted installs "/"
# lives on /dev/mapper/..., several layers above the disk itself.
system_disks() {
  local mnt src sw
  for mnt in / /boot /boot/efi; do
    src=$(findmnt -nvo SOURCE "$mnt" 2>/dev/null) || continue
    if [[ -b "$src" ]]; then disks_under "$src"; fi
  done
  while read -r sw; do
    if [[ -b "$sw" ]]; then disks_under "$sw"; fi   # swap files (e.g. /swap.img) are skipped
  done < <(swapon --show=NAME --noheadings 2>/dev/null || true)
}
SYSTEM_DISKS=$(system_disks | sort -u)
[[ -n "$SYSTEM_DISKS" ]] || die "Could not work out which disk holds the operating system. Refusing to continue."
for d in $(disks_under "$DEV"); do
  if grep -qx "$d" <<<"$SYSTEM_DISKS"; then
    die "$DEV is on /dev/$d, which holds the operating system. Refusing."
  fi
done
[[ -n "$(lsblk -no MOUNTPOINT "$DEV" | tr -d '[:space:]')" ]] && die "$DEV (or a partition on it) is mounted. Unmount it first."
# A whole disk with partitions (e.g. a Windows disk) must never be treated as blank.
if [[ "$(lsblk -dno TYPE "$DEV")" == disk && "$(lsblk -no NAME "$DEV" | wc -l)" -gt 1 ]]; then
  die "$DEV has partitions ($(lsblk -lno NAME,FSTYPE "$DEV" | tail -n +2 | xargs)). Choose a partition, or wipe the disk yourself first if you really mean it."
fi

FSTYPE=$(lsblk -no FSTYPE "$DEV" | head -1)
case "$FSTYPE" in
  ext4|xfs|btrfs) echo "Found an existing $FSTYPE filesystem. It will be used as-is (nothing is erased)." ;;
  ntfs|vfat|exfat)
    die "$DEV has a $FSTYPE filesystem (Windows/USB format). Family Cloud needs a Linux filesystem.
If this disk has nothing you need, re-format it yourself (e.g. sudo mkfs.ext4 $DEV) and run this again." ;;
  "")
    # lsblk reports what udev last saw; probe the device itself before calling it blank.
    SIGNATURES=$(sudo wipefs --no-act --noheadings --output TYPE "$DEV" | xargs) \
      || die "Could not check $DEV for existing data. Nothing was changed."
    [[ -z "$SIGNATURES" ]] || die "$DEV is not blank (found: $SIGNATURES). Nothing was changed.
If it has nothing you need, wipe it yourself first (sudo wipefs -a $DEV) and run this again."
    bold "$DEV has no filesystem."
    echo "Formatting ERASES EVERYTHING on $DEV. Type the device path again to format it as ext4:"
    read -r CONFIRM || true
    [[ "$CONFIRM" == "$DEV" ]] || die "Not confirmed. Nothing was changed."
    sudo mkfs.ext4 -L familycloud "$DEV"
    sudo udevadm settle 2>/dev/null || true
    FSTYPE=ext4 ;;
  *) die "Unsupported filesystem '$FSTYPE' on $DEV." ;;
esac

N=2; while [[ -e "$STORAGE_ROOT/volumes/disk$N" ]]; do N=$((N+1)); done
read -r -p "Name for this disk [disk$N]: " NAME || NAME=""
NAME=${NAME:-disk$N}
[[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "Use letters, numbers, - and _ only."
MOUNT="$STORAGE_ROOT/volumes/$NAME"
[[ "$MOUNT" != *[[:space:]]* ]] || die "The storage path \"$MOUNT\" contains spaces, which /etc/fstab can't hold."
[[ -e "$MOUNT" && -n "$(ls -A "$MOUNT" 2>/dev/null)" ]] && die "$MOUNT already exists and is not empty."

UUID=$(sudo blkid -s UUID -o value "$DEV" || true)   # blkid exits 2 when there is no UUID
[[ -n "$UUID" ]] || die "Could not read the filesystem UUID of $DEV."

# Refuse to add a second, conflicting entry: the disk or the folder may already be in /etc/fstab.
FSTAB_MOUNT=$(awk -v u="UUID=$UUID" '$1 == u { print $2; exit }' /etc/fstab)
FSTAB_DEV=$(awk -v m="$MOUNT" '$1 !~ /^#/ && $2 == m { print $1; exit }' /etc/fstab)
if [[ -n "$FSTAB_MOUNT" && "$FSTAB_MOUNT" != "$MOUNT" ]]; then
  die "/etc/fstab already mounts this disk at $FSTAB_MOUNT. Remove that line (sudo nano /etc/fstab), then run this again."
elif [[ -n "$FSTAB_DEV" && "$FSTAB_DEV" != "UUID=$UUID" ]]; then
  die "/etc/fstab already mounts $FSTAB_DEV at $MOUNT. Choose another name, or remove that line first."
fi

sudo mkdir -p "$MOUNT"
# nofail: the machine still boots if the disk is unplugged; the app then shows it as offline.
LINE="UUID=$UUID $MOUNT $FSTYPE defaults,nofail,noatime 0 2"
if [[ -z "$FSTAB_MOUNT" ]]; then
  # On a line of its own: if the file doesn't end in a newline, the entry would join its last line
  # (and break the mount on that line, e.g. /boot/efi, at the next boot).
  { if [[ -n "$(tail -c1 /etc/fstab)" ]]; then echo; fi; echo "$LINE"; } | sudo tee -a /etc/fstab >/dev/null
  echo "Added to /etc/fstab: $LINE"
  sudo systemctl daemon-reload 2>/dev/null || true   # systemd caches fstab
fi
sudo mount "$MOUNT"
sudo chown "$PUID:$PGID" "$MOUNT"

bold "Mounted $DEV at $MOUNT ($(df -h --output=avail "$MOUNT" | tail -1 | tr -d ' ') free)."
echo "Now open Family Cloud → Admin → Storage → Add disk and choose \"$NAME\"."
