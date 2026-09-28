# Backups, restoring, and moving to new hardware

Family Cloud keeps two things that belong together:

| Part | Where | Size | If lost |
| --- | --- | --- | --- |
| **Database** (accounts, folders, names, sharing) | `/srv/familycloud/db` | small | Files become nameless blobs; recoverable only by hand |
| **File data** | `/srv/familycloud/volumes/*` | large | Files are gone |

Back up **both**. Thumbnails (`cache/`) are regenerated automatically and don't need backing up.

## Nightly backups with `scripts/backup.sh`

The script:

1. dumps the database consistently (`pg_dump`) to `/srv/familycloud/backups/`, keeping the last 14;
2. if a [restic](https://restic.net) repository is configured, uploads an encrypted, deduplicated snapshot of the file volumes plus those dumps. After the first run only changes are sent. It keeps 7 daily, 5 weekly and 12 monthly snapshots.

### Choose where backups go

At least one copy should be **off this machine**, ideally off-site (fire, theft, a power surge that kills every disk at once).

| Destination | `RESTIC_REPOSITORY` example |
| --- | --- |
| USB disk (rotate two, keep one elsewhere) | `/mnt/backup-disk/familycloud` |
| Another computer over SSH | `sftp:user@backup-host:/srv/restic/familycloud` |
| Backblaze B2 | `b2:my-bucket:familycloud` |
| Any S3-compatible storage | `s3:https://s3.example.com/my-bucket/familycloud` |

Create `deploy/backup.env` (keep it private, `chmod 600`):

```bash
RESTIC_REPOSITORY=b2:my-bucket:familycloud
RESTIC_PASSWORD=<a long random password: store a copy in your password manager!>
B2_ACCOUNT_ID=...
B2_ACCOUNT_KEY=...
```

Install restic (`sudo apt install restic`) and run the first backup by hand:

```bash
./scripts/backup.sh
```

Schedule it nightly (`crontab -e`):

```
15 2 * * * /home/you/familycloud/scripts/backup.sh >> /home/you/familycloud-backup.log 2>&1
```

> **Keep the restic password somewhere other than this computer.** Without it the backups can't be read, by anyone, including you.

Test a restore once a year. A backup you've never restored is a hope, not a backup.

## Restoring

On a fresh install (or the same machine after a disk failure):

```bash
./scripts/install.sh           # same PUBLIC_URL; then stop the app and worker:
cd deploy && docker compose stop app worker

# restic needs the settings from your deploy/backup.env in this shell:
export RESTIC_REPOSITORY=... RESTIC_PASSWORD=...   # plus the provider keys, e.g. B2_ACCOUNT_ID/B2_ACCOUNT_KEY

# 1. Files
restic restore latest --target / --include /srv/familycloud/volumes

# 2. Database (use the newest dump from the backup)
restic restore latest --target /tmp/restore --include /srv/familycloud/backups
DUMP=$(ls -t /tmp/restore/srv/familycloud/backups/db-*.dump | head -1)
docker compose exec -T db dropdb -U familycloud familycloud
docker compose exec -T db createdb -U familycloud familycloud
docker compose exec -T db pg_restore -U familycloud -d familycloud < "$DUMP"

docker compose up -d
```

**Also restore the old `SECRET_KEY`** from your previous `deploy/.env` (keep a copy of that file in your password manager). With a different key, two-factor codes stop working (an admin has to turn two-factor off for each person with `docker compose exec app node dist/cli.js reset-totp --email …`, and they set it up again), and the addresses of existing share links can't be shown again. Files, accounts and sign-ins are unaffected.

## Moving to new hardware

For example, moving from a desktop to a low-power mini PC:

1. **On the old machine:** `./scripts/backup.sh`, then `cd deploy && docker compose down`.
2. **Copy** `deploy/.env` and the whole `/srv/familycloud` folder to the new machine:

   ```bash
   sudo rsync -aHAX --info=progress2 /srv/familycloud/ newhost:/srv/familycloud/
   ```

   Or move the disks themselves: plug them into the new machine and mount them at the same paths (`scripts/add-disk.sh` can add the fstab entries).
3. **On the new machine:** clone the repository, put `deploy/.env` back, fix `PUID`/`PGID` if your user ID differs (`id -u`), and run `cd deploy && docker compose up -d`.

The Cloudflare Tunnel token moves with `.env`, so the address stays the same. The image is built for both Intel/AMD (`amd64`) and ARM (`arm64`), so moving to a Raspberry Pi works the same way.
