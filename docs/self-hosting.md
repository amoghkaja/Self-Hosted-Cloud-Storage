# Self-hosting guide

This guide takes you from a spare computer to a working family cloud on your own domain. It takes about 30 minutes.

## 1. What you need

- **A Linux computer that stays on.** Ubuntu 24.04 or Debian 12 is easiest. Anything from a Raspberry Pi 5 to an old desktop works. See [hardware and uptime](hardware-and-uptime.md).
- **Disk space** for your family's files. Start with free space on the main disk and add disks later.
- **Docker** with the Compose plugin. The installer can install it for you.
- **A domain name** (for example `example.com`) if family members should reach it outside your home. The app runs at a subdomain such as `cloud.example.com`.

## 2. Install

```bash
git clone https://github.com/amoghkaja/Self-Hosted-Cloud-Storage.git familycloud
cd familycloud
./scripts/install.sh --install-docker
```

If Docker isn't there yet, the script installs it and carries on. Log out and back in afterwards to use `docker` commands yourself.

A fresh clone installs the newest release. Before changing anything, it checks that the app's port (3080) is free, shows which disk the files will go on and how much room it has (and suggests a bigger disk if there is one), and tells you when it needs your password for `sudo`. The installer asks:

| Question | Example | Notes |
| --- | --- | --- |
| How will your family reach it? | `1` (Cloudflare Tunnel) | Tunnel, your own domain, Tailscale, or only this computer for now. See step 3. Choosing "later" is fine. |
| Cloudflare API token (tunnel only) | | The installer creates the tunnel and its DNS record with it. See step 3 |
| Address family members will use | `https://cloud.example.com` | Must match what people type in the browser |
| Name shown in the app | `Smith Family Cloud` | |
| Where to keep files and the database | `/srv/familycloud` | Put it on the disk with the most space |
| Install new releases automatically? | `yes` | Sundays at 04:30, with a database backup first. See [Updating](#updating). |

It then:

1. creates `/srv/familycloud/{volumes/disk1,db,cache,backups}` owned by your user,
2. writes `deploy/.env` with freshly generated secrets (readable only by you),
3. pulls the release's image (or builds it) and starts the database, app and worker, plus `cloudflared` or Caddy if you chose them,
4. prints a **setup token**.

The app is now running at `http://127.0.0.1:3080` on that machine.

> Lost the token? Run `docker compose -f deploy/docker-compose.yml exec app node dist/cli.js setup-token`.

## 3. Put it on your domain

Pick one. You can choose when installing, or later by re-running `./scripts/install.sh`: it keeps all your settings and asks again until one is set up.

| Option | Router changes | Works behind carrier NAT | Notes |
| --- | --- | --- | --- |
| **Cloudflare Tunnel** (recommended) | None | Yes | Free; hides your home IP. [Guide](cloudflare-tunnel.md) |
| **Port forwarding + Caddy** | Forward 80 and 443 | No | Automatic HTTPS certificates; your home IP is public |
| **Tailscale only** | None | Yes | Private: every device needs the Tailscale app |

### Cloudflare Tunnel

Your domain must already be on Cloudflare (free plan). Make an API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Create Custom Token**, with these three permissions (and your domain under Zone Resources):

| Type | Permission | Access |
| --- | --- | --- |
| Account | Cloudflare Tunnel | Edit |
| Zone | DNS | Edit |
| Zone | Zone | Read |

Run `./scripts/install.sh`, choose **1**, enter the address and paste the token. The installer creates a tunnel named `familycloud`, points the address at the app, adds the DNS record and turns the tunnel on (it sets `COMPOSE_PROFILES=tunnel` in `deploy/.env`, so later `docker compose` commands include it). The API token is used once and not saved; you can delete it in Cloudflare afterwards. It never replaces an existing DNS record: if the address already has one, it stops and tells you.

Prefer clicking through the dashboard? Follow [cloudflare-tunnel.md](cloudflare-tunnel.md) and paste the tunnel token instead; the installer recognises it.

### Port forwarding + Caddy

1. Point a DNS `A` record for `cloud.example.com` at your home IP (use dynamic DNS if it changes).
2. Forward TCP 80 and 443 (and UDP 443) on your router to this machine.
3. Run `./scripts/install.sh`, choose **2** and enter `cloud.example.com`. It sets the address and adds Caddy (`COMPOSE_PROFILES=caddy`), which fetches the HTTPS certificate automatically.

### Tailscale only

Install Tailscale on the server and each device, then run `./scripts/install.sh` and choose **3**: it suggests the server's `https://<machine>.<tailnet>.ts.net` address. Finish with `sudo tailscale serve --bg 3080` on the server, as the installer reminds you.

## 4. First sign-in

1. Open `https://cloud.example.com/setup`.
2. Paste the setup token, then choose your name, email and a password (at least 10 characters).
3. You're the admin. Go to **Settings** and add a **passkey** (Face ID / Touch ID) and turn on **two-factor sign-in**: admin accounts control everyone's storage.

## 5. Invite your family

**Admin → People → Invite.** Optionally enter their email (then only that address can use the link), choose their allowance, and copy the link. Send it by text or email. It works once and expires after 7 days. Everyone is offered a passkey the first time they sign in.

If your family shares an email domain, list it under **Admin → Settings → Only allow these email domains**: then only those addresses can be invited or sign in, on the web, with passkeys and on the network drive.

Allowances can be changed any time, one by one or all together with **Admin → Overview → Allocate space**. Lowering one below what someone uses keeps their files; they just can't upload until they free up space.

Each person's **My Files** is private. **Family Photos** is for trips: an album has a name, dates and who went, everyone on the trip adds photos, and the whole family can see it.

**Someone forgot their password?** **Admin → People → ⋮ → Password reset link.** Send them the link; it works once, for 3 days, and they choose the new password themselves. It signs them out everywhere and never skips their two-factor sign-in. People who use two-factor also get recovery codes when they turn it on, for when a phone is lost.

**Someone leaving?** Disable their account (**⋮ → Disable account**): they're signed out, can't sign in, and their public links stop working, but their files are kept. To delete everything of theirs for good, choose **⋮ → Delete account** afterwards and type their email to confirm.

## 6. Set up backups

Do this before your family relies on it. A single disk will fail eventually. Follow [backup-restore.md](backup-restore.md): at minimum, run `scripts/backup.sh` nightly with an offsite restic repository. `./scripts/backup-setup.sh` sets both up.

## 7. Optional extras

- **Your family's look:** **Admin → Settings → Branding** takes a logo (also the home-screen icon), the word beside it and a link to your family website.
- **Privacy page:** every install has a **Privacy** page (linked from the sign-in page) that says what the app keeps and who can see what. Under **Branding** you can add who runs the server and how to reach you, and any terms of your own. If you host it for people outside your household, the law where you live may require this.
- **Versions and trash:** **Admin → Settings** sets how long deleted items stay in the trash (30 days) and how long older versions of files are kept when they're saved over (30 days; 0 turns versions off).
- **Virus scanning:** `./scripts/virus-scan.sh on` checks uploads with ClamAV (needs about 1.5 GB of memory). See [virus-scanning.md](virus-scanning.md).
- **Network drive:** each person can connect their Mac or Windows PC under **Settings → Network drive** (iPhones and iPads need a helper app). See [network-drive.md](network-drive.md).
- **More disks:** [storage-and-disks.md](storage-and-disks.md).
- **Protect the admin pages further:** with Cloudflare, add a Cloudflare Access policy for `/admin*` (Zero Trust → Access → Applications) so only listed emails can even load them.

## Updating

```bash
cd familycloud
./scripts/update.sh
```

It shows what's new since your version (from [CHANGELOG.md](../CHANGELOG.md)) and asks before it:

1. moves the code to the newest release and pulls its image (or builds it), plus the newest builds of the database, tunnel, Caddy and virus scanner images (for their security fixes), while the cloud keeps running,
2. stops the app and backs up the database to `/srv/familycloud/backups/pre-update-*.dump` (the last 3 are kept),
3. restarts and waits until the app answers again, then prints the old and new version.

The family can't use the cloud for a minute or two while it restarts. Database changes are applied automatically on start. **Admin → Overview** shows the version you run, at the bottom.

- **Just check:** `./scripts/update.sh --check` says whether there's a new version, without changing anything.
- **Automatic updates:** the installer offers a weekly job (Sundays 04:30). To add it later, run `crontab -e` and add `30 4 * * 0 /path/to/familycloud/scripts/update.sh -y >> /srv/familycloud/backups/update.log 2>&1`.
- **Releases that need you.** A release that needs you to do something lists it under **Before you update** in the changelog, and raises the first number of the version, e.g. `v1.x` → `v2.0` ([how versions are numbered](releasing.md)). Automatic updates skip these, and the log says why: read the notes, then run `./scripts/update.sh` yourself.
- **Follow the latest code instead of releases:** set `UPDATE_CHANNEL=main` in `deploy/.env`. Updates then build `main` on your machine.
- **An update failed?** Your files aren't touched. If the new version couldn't be built or the database backup failed, nothing was changed and the cloud carries on as before. If the new version crashes on start, `update.sh` goes back to the one you had by itself, with the database as it was just before the update, and the next update tries again. If it's only slow to start (a big database change on a small computer), it's left to finish, and `update.sh` prints how to go back by hand: check out the previous version, and restore the `pre-update` database backup ([backup-restore.md](backup-restore.md)).
- **Changed files in the checkout?** Updating stops rather than overwrite them. Keep changes in a fork (see below), or run `git stash`.

## Running a modified version

Family Cloud is licensed under the [AGPL-3.0](../LICENSE). Changing it for your own family needs nothing extra. If other people use your changed version over the network, publish your changes (a public fork is enough) and set `SOURCE_URL=https://github.com/you/your-fork` in `deploy/.env`, so the app's "Source code" link offers your version.

## Everyday commands

Run these from the `deploy/` folder.

| Task | Command |
| --- | --- |
| Update to the newest release | `../scripts/update.sh` |
| See status | `docker compose ps` |
| Follow logs | `docker compose logs -f app worker` |
| Restart | `docker compose restart app worker` |
| Stop everything | `docker compose down` |
| Reset someone's password (easier: **Admin → People → Password reset link**) | `docker compose exec app node dist/cli.js reset-password --email them@example.com` |
| Turn off someone's two-factor | `docker compose exec app node dist/cli.js reset-totp --email them@example.com` |
| Recount storage usage | `docker compose exec app node dist/cli.js reconcile` |

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Browser shows "Cross-site request rejected" | `PUBLIC_URL` doesn't match the address in the browser bar. Fix it in `deploy/.env` and run `docker compose up -d`. |
| Site unreachable from outside, fine at home | Tunnel not running (`docker compose ps`; if `cloudflared` is missing, check `COMPOSE_PROFILES=tunnel` in `deploy/.env`; errors: `docker compose logs cloudflared`) or the public hostname isn't set in Cloudflare. |
| "Storage is offline" when uploading | A disk isn't mounted. Check **Admin → Storage** and `lsblk`; see [storage-and-disks.md](storage-and-disks.md). |
| Uploads over 100 MB fail through the network drive | Cloudflare's per-request limit. Use the web app's Upload button (it sends files in pieces), or connect over your LAN/Tailscale. |
| No thumbnails | Check `docker compose logs worker`. Thumbnails are made in the background a few seconds after upload. |
| `permission denied` in logs under `/data` | `PUID`/`PGID` in `deploy/.env` must own `STORAGE_ROOT`: `sudo chown -R $(id -u):$(id -g) /srv/familycloud/volumes /srv/familycloud/cache` |
