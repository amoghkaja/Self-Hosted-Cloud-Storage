# Self-hosting guide

This guide takes you from a spare computer to a working family cloud on your own domain. It takes about 30 minutes.

## 1. What you need

- **A Linux computer that stays on.** Ubuntu 24.04 or Debian 12 is easiest. Anything from a Raspberry Pi 5 to an old desktop works. See [hardware and uptime](hardware-and-uptime.md).
- **Disk space** for your family's files. Start with free space on the main disk and add disks later.
- **Docker** with the Compose plugin. The installer can install it for you.
- **A domain name** (for example `example.com`) if family members should reach it outside your home. The app runs at a subdomain such as `cloud.example.com`.

## 2. Install

```bash
git clone https://github.com/amoghkaja/Cloud-Storage.git familycloud
cd familycloud
./scripts/install.sh --install-docker
```

If the script installed Docker, log out and back in (so your user can use Docker) and run `./scripts/install.sh` again.

The installer asks four questions:

| Question | Example | Notes |
| --- | --- | --- |
| Address family members will use | `https://cloud.example.com` | Must match what people type in the browser |
| Name shown in the app | `Smith Family Cloud` | |
| Where to keep files and the database | `/srv/familycloud` | Put it on the disk with the most space |
| Cloudflare Tunnel token | *(empty)* | You can add it later, see step 3 |

It then:

1. creates `/srv/familycloud/{volumes/disk1,db,cache,backups}` owned by your user,
2. writes `deploy/.env` with freshly generated secrets (readable only by you),
3. pulls (or builds) the image and starts the database, app and worker,
4. prints a **setup token**.

The app is now running at `http://127.0.0.1:3080` on that machine.

> Lost the token? Run `docker compose -f deploy/docker-compose.yml exec app node dist/cli.js setup-token`.

## 3. Put it on your domain

Pick one:

| Option | Router changes | Works behind carrier NAT | Notes |
| --- | --- | --- | --- |
| **Cloudflare Tunnel** (recommended) | None | Yes | Free; hides your home IP. [Guide](cloudflare-tunnel.md) |
| **Port forwarding + Caddy** | Forward 80 and 443 | No | Automatic HTTPS certificates; your home IP is public |
| **Tailscale only** | None | Yes | Private: every device needs the Tailscale app |

### Cloudflare Tunnel

Follow [cloudflare-tunnel.md](cloudflare-tunnel.md), put the token in `deploy/.env` as `CLOUDFLARE_TUNNEL_TOKEN`, then:

```bash
cd deploy && docker compose --profile tunnel up -d
```

### Port forwarding + Caddy

1. Point a DNS `A` record for `cloud.example.com` at your home IP (use dynamic DNS if it changes).
2. Forward TCP 80 and 443 (and UDP 443) on your router to this machine.
3. Set `DOMAIN=cloud.example.com` and `PUBLIC_URL=https://cloud.example.com` in `deploy/.env`.
4. `cd deploy && docker compose --profile caddy up -d`. Caddy fetches the certificate automatically.

### Tailscale only

Install Tailscale on the server and each device, then run `sudo tailscale serve --bg 3080` on the server. Set `PUBLIC_URL` to the `https://<machine>.<tailnet>.ts.net` address it prints, and restart with `docker compose up -d`.

## 4. First sign-in

1. Open `https://cloud.example.com/setup`.
2. Paste the setup token, then choose your name, email and a password (at least 10 characters).
3. You're the admin. Go to **Settings → Two-factor sign-in** and turn it on: admin accounts control everyone's storage.

## 5. Invite your family

**Admin → People → Invite.** Optionally enter their email (then only that address can use the link), choose their quota, and copy the link. Send it by text or email. It works once and expires after 7 days.

Quotas can be changed any time. Lowering a quota below what someone uses keeps their files; they just can't upload until they free up space.

## 6. Set up backups

Do this before your family relies on it. A single disk will fail eventually. Follow [backup-restore.md](backup-restore.md): at minimum, run `scripts/backup.sh` nightly with an offsite restic repository.

## 7. Optional extras

- **Network drive:** each person can connect their iPhone, iPad, Mac or Windows PC under **Settings → Network drive**. See [network-drive.md](network-drive.md).
- **More disks:** [storage-and-disks.md](storage-and-disks.md).
- **Protect the admin pages further:** with Cloudflare, add a Cloudflare Access policy for `/admin*` (Zero Trust → Access → Applications) so only listed emails can even load them.

## Updating

```bash
cd familycloud && git pull
cd deploy && docker compose pull && docker compose --profile tunnel up -d
```

Database changes are applied automatically on start. To stay on a specific release, set `IMAGE=ghcr.io/amoghkaja/cloud-storage:v0.1.0` in `deploy/.env`.

## Everyday commands

Run these from the `deploy/` folder.

| Task | Command |
| --- | --- |
| See status | `docker compose ps` |
| Follow logs | `docker compose logs -f app worker` |
| Restart | `docker compose restart app worker` |
| Stop everything | `docker compose --profile tunnel down` |
| Reset someone's password | `docker compose exec app node dist/cli.js reset-password --email them@example.com` |
| Turn off someone's two-factor | `docker compose exec app node dist/cli.js reset-totp --email them@example.com` |
| Recount storage usage | `docker compose exec app node dist/cli.js reconcile` |

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Browser shows "Cross-site request rejected" | `PUBLIC_URL` doesn't match the address in the browser bar. Fix it in `deploy/.env` and run `docker compose up -d`. |
| Site unreachable from outside, fine at home | Tunnel not running (`docker compose --profile tunnel ps`) or the public hostname isn't set in Cloudflare. |
| "Storage is offline" when uploading | A disk isn't mounted. Check **Admin → Storage** and `lsblk`; see [storage-and-disks.md](storage-and-disks.md). |
| Uploads over 100 MB fail through the network drive | Cloudflare's per-request limit. Use the web app's Upload button (it sends files in pieces), or connect over your LAN/Tailscale. |
| No thumbnails | Check `docker compose logs worker`. Thumbnails are made in the background a few seconds after upload. |
| `permission denied` in logs under `/data` | `PUID`/`PGID` in `deploy/.env` must own `STORAGE_ROOT`: `sudo chown -R $(id -u):$(id -g) /srv/familycloud/volumes /srv/familycloud/cache` |
