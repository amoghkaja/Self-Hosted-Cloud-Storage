# Disks and storage

Family Cloud has three independent storage controls, all changeable at any time from the admin screen:

| Control | Where | What it does |
| --- | --- | --- |
| **Per-person quota** | Admin → People → Edit | How much one person may store. "Unlimited" is allowed. |
| **Family limit** | Admin → Settings | A cap on everyone combined, e.g. to keep space free for the computer itself. |
| **Disks (volumes)** | Admin → Storage | Where the bytes physically live. Add disks to grow; drain them to retire. |

Files people upload into a folder that is **shared with them** count against the **owner's** quota, not the uploader's. Items in the trash still count until they're deleted for good.

## How files are stored

Each disk is a folder under `/srv/familycloud/volumes/` (for example `disk1`, `disk2`). Inside, files are stored under random IDs (`blobs/ab/cd/<id>`), not their names. The folder structure, names and sharing live in the database. This is what makes renames instant and lets a file move between disks without anything else changing.

Each disk folder contains a small `.familycloud-volume` marker file. If a disk isn't mounted, its folder is empty (no marker), so Family Cloud marks it **offline** instead of accidentally filling up the main disk. Nothing is written to an offline disk.

> Because files aren't stored under their names, don't edit the `volumes/` folders by hand. To get a normal folder tree out (for example to recover files without the app), export it into a folder your user can write to, such as a backup disk mounted at `/mnt/recovery`:
>
> ```bash
> cd deploy && docker compose run --rm -v /mnt/recovery:/export app node dist/cli.js export --out /export
> ```
>
> Each person's files land in `/mnt/recovery/<their email>/`. Add `--email them@example.com` to export one person.

## Adding a disk

1. **Connect the disk** (USB, SATA or NVMe).
2. **Mount it** with the helper, which shows your disks and walks you through it:

   ```bash
   ./scripts/add-disk.sh
   ```

   It refuses the system disk and anything mounted, and never formats unless you type the device path again to confirm. It mounts the disk at `/srv/familycloud/volumes/<name>` and adds it to `/etc/fstab` (with `nofail`, so the machine still boots if the disk is unplugged).

3. **Register it:** Admin → Storage → **Add disk** → choose it → **Add disk**. No restart is needed; the running app sees newly mounted disks immediately.

From then on, each new upload goes to the disk with the most usable free space. Existing files stay where they are.

If the admin screen says a disk is "on the same disk as disk1", the folder isn't actually a separate disk. You probably created the folder without mounting the drive, so it adds no space.

### Per-disk limits

Admin → Storage → **Limits** on a disk:

- **Maximum family files on this disk:** useful when the disk is shared with other things.
- **Always keep free:** a reserve left untouched (default: 5% of the disk, at most 10 GB).
- **Pause new files:** read-only mode. Files stay readable; new uploads go elsewhere.

## Moving everything to another disk, or retiring one

To replace a disk (it's old, too small, or making noises):

1. Add the new disk as above.
2. On the old disk, click **Move files off & retire**.

A background job then, for every file:

- copies it to another disk,
- checks the copy against a SHA-256 checksum,
- switches the file over,
- deletes the original.

Everything stays available the whole time. Downloads that are already running keep going, and new downloads use the new location. Progress shows on the Storage page. When it finishes, the disk is marked **retired** and you can unmount it (`sudo umount /srv/familycloud/volumes/<name>`, then remove its line from `/etc/fstab`).

The move is refused up front if the other disks don't have room. If it's interrupted (restart, power cut), it resumes automatically. Files that couldn't be read are skipped and listed in the worker log; the disk isn't retired until they're resolved.

## The database and thumbnails

- The database lives in `/srv/familycloud/db`. It's small (megabytes to a few GB) but **precious**: without it the file blobs have no names or folders. Back it up; see [backup-restore.md](backup-restore.md).
- Thumbnails live in `/srv/familycloud/cache`. They're rebuilt automatically if lost, so they're safe to exclude from backups.

## Adding disks is not a backup

More disks mean more space, not more safety: each file is stored once. Protect against disk failure with [backups](backup-restore.md), or put the volumes on a mirrored array (e.g. two disks in RAID 1 with `mdadm`, or a ZFS mirror) and add *that* as a volume.
