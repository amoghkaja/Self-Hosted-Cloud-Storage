# Security review

**Scope:** the Family Cloud server (API, WebDAV, background worker, CLI), web app, container and Compose setup, and install scripts at the time of writing.
**Method:** code review against the threat model below, plus targeted tests. Every issue found was reproduced before fixing and has a regression test where practical.

## Threat model

**What we protect:** family members' files, file names and folder structure; accounts (passwords, sessions, two-factor secrets); the host machine and its disks.

**Who might attack:**

| Actor | Access | Example goals |
| --- | --- | --- |
| Internet stranger | Can reach the public URL | Take over the admin account, read files, abuse storage, deny service |
| Holder of a share link | One public link | See beyond what was shared, brute-force a link password |
| Holder of a file request | One upload-only link | See what's in the folder, fill the owner's storage, plant files that run code |
| Family member | A normal account | Read another member's private files, escape their quota |
| Malicious file | Something uploaded or downloaded | Run script in the app's origin (stored XSS), crash the thumbnailer |
| Someone on the home network | LAN access | Reach the database or internal services |

## Controls

| Threat | Control | Verified by |
| --- | --- | --- |
| **Stored XSS via uploaded HTML/SVG** | Only an allowlist of media types is ever shown inline. Everything else is forced to download as `application/octet-stream`. All file responses carry `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`. SVGs are never rasterized server-side. The app's own CSP has no inline or remote scripts. | `uploads.test.ts` "never renders uploaded HTML or SVG" |
| **Malware in uploads** | Optional ClamAV scan of every blob in the worker (`jobs/scan.ts`); an infected blob is refused by `sendBlob` and left out of zips, so no route serves it. File requests refuse programs and scripts by extension. Not a guarantee: files over 100 MB are skipped and a file is downloadable until its scan finishes. | `data-virus-scan.test.ts` |
| **Reading someone else's files (IDOR)** | One authorization function (`loadAccess`) used by every route, including WebDAV. Inaccessible items return 404, identical to missing ones. Admins can't read files. | `authz.test.ts`: every endpoint × no share / view / edit; `webdav.test.ts` shares |
| **Path traversal** | File names never touch the filesystem (blobs are stored under UUIDs). Volume paths must `realpath` to a direct child of the volumes root. Zip entry names are validated. | `volumes.test.ts` "refuses paths outside the volumes root" |
| **Session theft / fixation** | 256-bit random tokens in `__Host-` cookies (HttpOnly, Secure, SameSite=Lax), stored as SHA-256, new token per login. Sliding 30-day, absolute 90-day expiry. Password change revokes other sessions. Adding a passkey, turning on two-factor or making a device password asks for the password, so a stolen session can't add a way back in that outlasts it. | `auth.test.ts` cookie flags, password change, two-factor setup; `core-passkeys.test.ts` |
| **CSRF** | SameSite cookies, an `Origin` check on every state-changing API call, and JSON-only bodies (form encodings rejected with 415). WebDAV uses Basic auth and needs CORS-preflighted methods, which aren't allowed cross-origin. | `auth.test.ts` "rejects … other origins", "form-encoded bodies" |
| **Password guessing** | argon2id (19 MiB, t=2). 10 sign-ins/min per IP. Per-account progressive lockout after 5 failures. Dummy hash for unknown emails (no timing oracle). Optional TOTP with replay protection (a code can't be reused). | `auth.test.ts` lockout, rate limit, TOTP replay |
| **Phishing and password reuse** | Passkeys (WebAuthn): bound to the site's domain, need Face ID / Touch ID / device PIN (user verification required), public keys only on the server. Each challenge is signed, expires in 5 minutes and is accepted once. A passkey sign-in counts as two factors. | `core-passkeys.test.ts` (replay, wrong origin, removed key) |
| **First-run takeover** | Creating the first account needs a one-time token that is only visible in server logs / CLI. Compared in constant time; rate-limited; creation serialized by a lock. | `auth.test.ts` setup |
| **Share-link guessing** | 192-bit link tokens stored hashed (plus AES-GCM for owner re-display). Optional argon2 password with a 10/min unlock limit per IP **and** 20 tries per 15 minutes per link from anywhere. Expiry, optional download limit, and revocation. A link only ever reaches its own subtree, and stops when its owner's account is disabled. | `links.test.ts`, `links-requests.test.ts` |
| **File requests (anonymous uploads)** | A request link reaches nothing: every view route refuses its token, and replies to the sender never name the folder, its owner or the new file. Uploads are tied to the request, re-checked when they commit, charged to the owner's quota, capped per request (5 GB by default) and at 20 in flight, and stopped (their space given back) the moment the request is revoked. Names are validated; nothing is ever replaced. No instant uploads (the checksum would reveal what's stored). | `links-requests.test.ts` |
| **Losing files to a bad save** | Saving over a file (network drive, "Replace" on upload, an editor's save-by-rename) keeps the old contents as a version, restorable by anyone who can edit the file; only the owner can delete versions. | `data-versions.test.ts` |
| **Forgotten passwords, lost phones** | One-time reset links from an admin (192-bit, hashed, 3 days, single use, newest only), which sign the person out everywhere and never skip two-factor. Ten single-use recovery codes (≈49 bits each, hashed) when two-factor is turned on; each try counts toward the lockout. | `core-password-reset.test.ts`, `core-recovery.test.ts` |
| **Plain HTTP** | Behind a proxy that reports `X-Forwarded-Proto: http`, every request is redirected (308) to `PUBLIC_URL`, never to the Host header. HSTS on HTTPS. | `core-https.test.ts` |
| **Network-drive credentials** | Device passwords are random (~99 bits), separate from the account password, hashed, revocable per device, and never accepted by the web API. 10 failures/min per IP triggers a throttle. | `webdav.test.ts` |
| **Quota bypass by racing uploads** | Atomic conditional reservation under an advisory lock; nightly reconciliation. | `uploads.test.ts` "never over-commits under concurrent uploads" |
| **Malicious media (decompression bombs, exploits in decoders)** | Decoding happens only in the worker, never the API. Pixel limit 16384². Each external tool has a 60 s timeout and SIGKILL. Arguments are passed as arrays (no shell). Containers run non-root with no capabilities. | Code review |
| **Upload abuse** | Chunk lengths enforced while streaming, 100 open uploads per user, optional max file size, 24 h session expiry that releases reserved space. JSON bodies ≤ 1 MB. | `uploads.test.ts` chunk validation |
| **Spoofed client IPs (to dodge rate limits)** | `CF-Connecting-IP` / `X-Forwarded-For` are honoured only from trusted proxy addresses on the Docker network; Caddy strips client-supplied `CF-Connecting-IP`. Per-IP limits group IPv6 clients by /64, so rotating addresses doesn't help. | Code review; finding 2 below |
| **Secrets in logs** | Cookies and auth headers redacted. Share and invite tokens (API and web invite page) scrubbed from every logged URL. Passwords never logged. | `lib.test.ts` "never writes share or invite tokens to the logs" |
| **Secrets at rest** | TOTP secrets and link tokens encrypted (AES-256-GCM, per-purpose keys derived with HKDF from `SECRET_KEY`). `deploy/.env` created with mode 600 and git-ignored. | `lib.test.ts` Keyring |
| **Infrastructure** | App and worker run read-only, as the host user, with `cap_drop: ALL` and `no-new-privileges`. PostgreSQL and the worker sit on an `internal` network with no internet route. No host ports except `127.0.0.1:3080` (and 80/443 with the optional Caddy profile). The tunnel needs no inbound ports. HSTS on HTTPS. | `deploy/docker-compose.yml` |
| **Clickjacking** | `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. | Headers verified on the production build |
| **Supply chain** | Lockfile with `--frozen-lockfile` builds. Install scripts allowed only for two named packages. `pnpm audit` in CI (no known vulnerabilities at review time). Dependabot for npm, Docker and Actions. Release images carry SBOM and provenance. | CI |
| **Deleting the wrong disk** | `add-disk.sh` refuses the system disk, mounted devices and any whole disk with partitions (e.g. a Windows disk). It formats only a device with no filesystem or partition-table signature (probed with `wipefs`, not just udev), and only after the device path is re-typed. | Checked against a dual-boot machine's real disks |

## Findings from this review (all fixed)

| # | Severity | Finding | Attack scenario | Fix |
| --- | --- | --- | --- | --- |
| 1 | **High** | Share-link and invite tokens were written to the request log in plain text. The per-request log scrubbing ran *after* Fastify's own "incoming request" log line. | Anyone who can read logs (a support bundle, log shipping, a shared screen) could open private share links or claim pending invites. | A pino `req` serializer scrubs tokens from every logged URL before anything is written. Regression test added. |
| 2 | **Medium** | With the optional Caddy setup, a client could send its own `CF-Connecting-IP` header. Caddy forwarded it and the app trusted it, because Caddy is a trusted proxy. | Rotate fake IPs on every request to bypass the per-IP sign-in rate limit and brute-force passwords faster (the per-account lockout still applies). | Caddy strips `CF-Connecting-IP` (`header_up -Cf-Connecting-Ip`). Only Cloudflare's edge sets it on the tunnel path. |
| 3 | **Medium** | Request timeout was disabled (`requestTimeout: 0`) so big uploads couldn't time out. | Slowloris-style clients trickle request bodies and hold connections open indefinitely until the server runs out of sockets or memory. | Bounded to 1 hour, which is generous for a single upload request, since web uploads use ≤32 MB chunks. |
| 4 | **Medium** | File names could contain Unicode bidirectional-override characters. | A family member receives `invoice‮fdp.exe`, displayed as `invoiceexe.pdf`, and runs it thinking it's a PDF. | Names containing U+202A–U+202E or U+2066–U+2069 are rejected (along with control characters, `/` and `\`). Regression test added. |
| 5 | **Low** | An upload that started while the uploader had edit access to a shared folder could still complete after the share was revoked (up to the 24 h session lifetime). | After being removed from a shared folder, someone finishes an upload into it, consuming the owner's quota. | Access is re-checked when the upload completes; the reservation is released if it fails. Regression test added. |
| 6 | **Low** | `/readyz` returned disk names and per-check status to anyone on the internet. | Reconnaissance: learn disk layout and when a disk is offline. | Details only for loopback/private-network callers; public callers get `{ok}`. |

### Second review (automated PR review), all fixed

| # | Severity | Finding | Attack scenario | Fix |
| --- | --- | --- | --- | --- |
| 7 | **High** | Account lockout read the failure count, then wrote `count + 1`, from a stale row. | A burst of parallel wrong passwords all read "not locked" and write the same count, so far more than 5 guesses get through before the lock. | Each attempt is counted *before* the password is checked, in one atomic `UPDATE … WHERE not locked`. The row lock serializes a burst. Regression test: 12 parallel guesses → at most 5 checked, rest `429`. |
| 8 | **High** | The same stale-read pattern let two simultaneous sign-ins reuse one two-factor code. | An attacker who observes a code (shoulder-surfing, phishing proxy) races the real user with it. | The code's time-step is consumed with a conditional `UPDATE`. Regression test: the same code twice in parallel → exactly one success. |
| 9 | **High** | Access for chunked uploads (finding 5) was re-checked *outside* the commit transaction, and WebDAV `PUT`/`COPY` didn't re-check at all after streaming. | Someone whose share is revoked while an upload streams can still create or overwrite a file in the owner's folder. | `lockWriteAccess` re-checks inside the commit transaction and locks the folder row and the granting share row, so a revoke or trash lands entirely before (upload refused) or after (file already saved). Regression test: share revoked mid-`PUT` → `403`, no file. |
| 10 | **High** | `add-disk.sh` compared only one level of the device tree with the system disk. | On LVM or encrypted installs `/` is `/dev/mapper/…`, so an unmounted partition on the system disk could pass the check and be formatted. | Physical disks are resolved through the whole stack (partition → LVM/LUKS/md → disk) for `/`, `/boot`, `/boot/efi` and swap. Tested against a dual-boot machine's real disks. |
| 11 | **High** | `install.sh` wrote `deploy/.env` with `umask 077`, which only affects *new* files. | An existing `.env` with mode `644` stays world-readable, exposing `SECRET_KEY` and the database password to other local users. | Written to a `mktemp` file (mode 600), moved into place, then `chmod 600`. |
| 12 | Medium | Scripts `source`d `deploy/.env`, and values were written unquoted. | Re-running the installer with a name like "Family Cloud" failed. Executing a config file also runs any shell code placed in it. | `scripts/lib.sh` reads `.env` without executing it (`load_env`) and writes values quoted in the Compose-compatible subset (`env_line`). Tested with spaces, quotes, `$`, `=` and a `$(…)` injection. |
| 13 | Medium | Device-password and open-upload limits were checked with read-then-insert. | Parallel requests exceed the limit (e.g. 26 devices). | Checked under a per-user advisory lock / the reservation lock. Regression test: 30 parallel creates → exactly 25. |
| 14 | Medium | The installer printed "Done!" even when the app never became healthy. | An unusable install looks successful. | It exits with an error and shows container status and logs. The wait length is configurable (`WAIT_SECS`). |

### Third review (full audit), all fixed

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 15 | **High** | Two drain runs moving the same file could race, and the loser deleted the live copy. | Each attempt uses its own temp name; an existing copy is kept. |
| 16 | **High** | Re-running `cli export` into the same folder wrote new bytes through hard links into live blobs. | The old entry is removed first; copies use `COPYFILE_EXCL`. |
| 17 | **High** | `add-disk.sh` trusted udev's cached filesystem type before formatting. | It also probes the device with `wipefs -n` and refuses anything with a signature. |
| 18 | Medium | A zip containing a missing or wrong-size file crashed the whole API process. | The stream error fails that download only. |
| 19 | Medium | Two opposite moves at once (A into B, B into A) could detach both folders in a cycle. | Moves are serialised per owner and re-checked under the lock. |
| 20 | Medium | A WebDAV save over an existing file could replace one that had since moved into a folder the uploader can't edit. | The replace must still be in the same folder, re-checked in the commit. |
| 21 | Medium | Races around finalize (cancel, expiry, trash of the parent, late chunks) could double-release quota or leave a live file inside a trashed folder. | Commits require the session to still be `finalizing`; trashing locks the subtree first. WebDAV writes are upload sessions too. |
| 22 | Medium | A disk unmounted in the last 10 s could still receive files in its empty mount point (hidden once remounted). | The volume marker is re-checked just before writing. |
| 23 | Medium | A session lookup in flight during a revoke could put the revoked session back in the cache for 30 s. | An eviction counter discards stale lookups. |
| 24 | Medium | `/auth/totp/setup` could replace the secret of an account that already had two-factor on. | Conditional updates on the stored state. |
| 25 | Medium | Two admins demoting each other at the same time left no active admin. | The last-admin check runs under an advisory lock. |
| 26 | Medium | Per-IP limits (including the device-password throttle) keyed on the full IPv6 address. | Grouped by /64. |
| 27 | Medium | Invite tokens in the web page path `/invite/<token>` reached the request log. | Scrubbed like the API path. |
| 28 | Medium | `deploy/backup.env` (restic password, cloud keys) was sent into the Docker build context. | Excluded in `.dockerignore`. |
| 29 | Medium | `install.sh` would `chown`/`chmod` whatever storage path was typed, including `/`. Backup dumps (password hashes) were created with the default umask. | Unsafe paths refused; `backup.sh` uses `umask 077`. |
| 30 | Low | A view-only link with `?inline=1` downloaded files that can't be previewed. | 403. |
| 31 | Low | Past about 1000 failed sign-ins the lockout interval overflowed, and every later sign-in for that account returned 500. | The exponent is capped. |
| 32 | Low | API responses had no `Cache-Control`. | `private, no-store` unless a route sets its own. |
| 33 | Low | A `PUBLIC_URL` with another scheme or a path made the CSRF origin `"null"` or dropped the path from links. | Must be `http(s)://host[:port]` with no path. |

### Fourth review (full audit: security, safety of files, standard workflows), all fixed

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 34 | **High** (data loss) | Saving over a file from the network drive destroyed what it held, with no way back. | Version history: the old contents are kept (30 days by default, up to 50 per file) and can be downloaded or restored. |
| 35 | Medium | Word, Excel and LibreOffice save over WebDAV by writing a temporary file and renaming it over the original. Each save trashed the original, which **revoked its public links and dropped its shares**. | A file renamed over another file moves its contents onto the original, which keeps its identity; the old contents become a version. |
| 36 | Medium | A disabled account's public links kept working. | Links stop with the account (`resolveLink` checks the owner). |
| 37 | Medium | Link passwords were limited per IP only; many IPs could guess a short link password quickly. | Also 20 tries per 15 minutes per link, counted before the (slow) check. |
| 38 | Medium | The sign-in page said "ask a family admin to reset it", but admins had no way to do that without server access. | One-time reset links (see Controls). |
| 39 | Low | Rename, move and trash through a share checked access before their transaction but not inside it, so a share revoked in between let the change through. | Re-checked under lock (`lockWriteAccess`), like uploads. Regression test calls the write after a revoke. |
| 40 | Low | A visitor reaching the app over plain HTTP through a proxy wasn't sent to HTTPS by the app itself. | 308 redirect to `PUBLIC_URL`. |
| 41 | Low | The audit log was kept forever. | Kept a year. |
| 42 | Low | `maximum-scale=1` stopped pinch-zoom on Android (WCAG 1.4.4). | Removed; phone inputs are 16px, so iOS doesn't zoom into them anyway. |

Reliability fixes from the same audit: documents saved from the network drive never got an Office preview (the job wasn't queued); a job lost while enqueueing (a database blip) waited for the next worker restart (now an hourly recovery, with every media job idempotent); the upload finalizer's clean-up path sat in the same `try` as post-commit work, so a future error there could have deleted a committed file's bytes (moved out).

### Fifth review (multi-agent audit of every area, plus a click-through on phones and desktops), all fixed

Each fix below has a test that fails on the code before it (scripts: a CI step).

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 43 | **High** (data loss) | With the USB backup disk unplugged, `backup.sh` created a new restic repository in the empty mount point on the system disk, copied every file there and reported success. | The mount point a repository was created on is remembered; backing up anywhere else is refused. |
| 44 | Medium | A captured passkey sign-in could be sent again within its five minutes: signed tokens accepted anything after a second dot (`<token>.x`), the used-challenge check compared token text, and synced passkeys always report a signature counter of 0. | Signed tokens must be exactly `body.mac`, and challenges are remembered by value. |
| 45 | Medium | Adding a passkey, turning on two-factor or making a network-drive device password needed only a session: someone with a stolen session could add a way in that outlasts a password change and "sign out everywhere", or turn on two-factor with their own app and lock the owner out. | All three ask for the password first (ASVS re-authentication before changing factors). Wrong passwords there, and when changing the password or getting recovery codes, count toward the sign-in lockout, checked one at a time per account so parallel guesses can't outrun it. |
| 46 | Medium | A share link's download limit didn't count requests whose `Range` header didn't start with `bytes=0-` (a suffix range, a Range the server ignores, a stale `If-Range`, any ranged zip), though each sent the whole file. | A download is counted whenever what's sent starts at the file's first byte; zips always count. |
| 47 | Medium | On a view-only link, a video's player route sent the original of a type browsers can't play (`.mkv`, `.avi`) as an attachment until its streaming copy was ready, or for good if one couldn't be made: a download with downloads turned off, and uncounted. | The public player waits for the streaming copy; originals go through the download route and its rules. |
| 48 | Medium | A second copy of an upload chunk still streaming when the last chunk arrived kept writing into the stored file after its checksum and virus scan, and into every file sharing those bytes. A file-request sender could get past "held until scanned" this way. | Finalizing stops chunk writes in progress and waits for their files to close before the rename. |
| 49 | Medium | A DASH manifest uploaded as `.mp4` made ffprobe/ffmpeg fetch the addresses in it (other services on the home network) while making thumbnails, streaming copies and photo dates. | Every ffmpeg/ffprobe run on an upload is limited to real video containers and the `file` protocol. |
| 50 | Low | Instant upload counted every file in a trip folder as visible to the family, but albums show only photos and videos: someone with a document's checksum could confirm it was in another person's trip folder and get a copy. | Only an album's photos and videos match. |
| 51 | Low | A rename or move through a share re-checked the folder where the item was seen, then changed it wherever it was by then: if its owner had just moved it somewhere private, the grantee could still rename it or move it back out. New folders through a share (web app or network drive) weren't re-checked under lock at all. | The item must still be in the folder that was checked; every new folder is made under `lockWriteAccess` (`createFolder`). |
| 52 | Low | A network-drive password lookup in flight while the device was removed (or the account disabled) was cached afterwards and kept working for a minute (finding 23's race, in the WebDAV cache). | The same generation counter as the session cache. |
| 53 | Low | WebDAV COPY or MOVE with `Overwrite: T` trashed the item it replaced outside the copy's transaction (a copy that then failed left it in the trash) and without re-checking access where the item was by then. | Replaced inside the transaction, with the actor's access re-checked; a file copied over a file is a save that keeps its links, shares and a version. |

Reliability and data-safety fixes from the same audit: a drained disk could be marked "Safe to unmount" with a file an upload had just put on it; disaster-recovery exports and folder copies left out files still waiting for their virus check; two deletions at once could leave a blob's bytes on disk forever; moving a file out of a folder being trashed lost it from every trash entry; Rewind brought back items created after the chosen moment; names Postgres lowercases differently from JavaScript (Greek final sigma, Turkish İ) blocked uploads and restores; a partial WebDAV PUT replaced a whole file with its tail; media jobs gave up for good on files whose disk was briefly unplugged; LibreOffice kept running after a preview timed out; container logs had no size cap; `update.sh` never refreshed the database, tunnel, Caddy and ClamAV images, took its database copy minutes before the restart, and now goes back to the previous version (database included) when a new one crashes on start. Text Postgres can't store (a NUL) is answered with 400 on every route instead of 500. Locally, a failing server test (or a database that never started) used to exit 0 with the embedded Postgres; CI was unaffected.

## Accepted risks

| Severity | Item | Rationale / mitigation |
| --- | --- | --- |
| Low | After 5 failed sign-ins, the response for an existing account (`429 ACCOUNT_LOCKED`) differs from an unknown email (`401`), revealing that the account exists. | Requires sustained guessing, which per-IP limits already slow; knowing a family member's email is rarely secret. |
| Low | PDFs viewed inline aren't served with `CSP: sandbox`, because built-in browser PDF viewers refuse to render under it. | Browser PDF engines run document scripts in their own sandbox without access to the page's origin. Every other type keeps the sandbox. |
| Info | Every family member can see the names and emails of other members (share picker). | By design for a family app. |
| Info | Device passwords don't require a two-factor code. | Standard for app passwords. Mitigated by high entropy, WebDAV-only scope, per-device revocation and the failure throttle. |
| Info | WebDAV `LOCK` is advisory; two devices editing the same file can overwrite each other (last write wins). | Needed for Finder/Windows compatibility. Overwrites keep the file identity, and what was overwritten is kept in Version history. |
| Low | An admin can issue a password-reset link for a member, and could use it themselves to get into that account (a member who also uses two-factor would need the admin to reset that too). | Needed for forgotten passwords without email. Using it signs the member out everywhere (they'd notice), both steps are in the audit log, and it never skips two-factor. |
| Low | A share link's download limit counts each download that starts at the file's first byte. A client can fetch the rest of a file from its second byte on (`Range: bytes=1-`) without it counting, while downloads are left. | That is how an interrupted download resumes; counting it would use up the limit on a dropped connection. A zip always counts, and the limit still stops every new download once it's used up. |
| Low | A file request's link lets whoever has it use up to the request's size limit (5 GB by default) of the owner's storage. | Owner-chosen limit and expiry, 20 uploads in flight at most, per-IP rate limits, revocable at once (releasing what's in flight). |
| Info | Older versions count toward the owner's storage, and the oldest are deleted automatically when the owner's own save wouldn't otherwise fit. | Versions are a safety net that shouldn't stop their owner saving (Nextcloud does the same). Other people's uploads, through a share or a file request, never clear them. |
| Info | Session changes (disable, role change) are instant on a single server; with multiple app replicas, another replica may honour a revoked session for up to 30 s (cache TTL). | Single-replica by default; documented in the scaling path. |

## Deployment recommendations

1. **Use Cloudflare Tunnel.** No inbound ports, and your home IP stays private. Enable *Always Use HTTPS*, and add a *Bypass cache* rule for `/api/*` and `/dav/*` as a second safeguard ([guide](cloudflare-tunnel.md)).
2. **Turn on two-factor for every admin** (the app nags until you do). Consider a Cloudflare Access policy in front of `/admin*`.
3. **Back up the database *and* the files, off-site, encrypted**, and store `deploy/.env` and the restic password somewhere other than the server ([guide](backup-restore.md)). `SECRET_KEY` protects two-factor secrets and link tokens; losing it isn't fatal, but leaking it is serious.
4. **Keep things patched:** `unattended-upgrades` on the host; update the image regularly (Dependabot opens PRs in the repository).
5. **Firewall the host:** default-deny inbound, SSH from the LAN only, key-based SSH login ([guide](hardware-and-uptime.md#keeping-it-healthy)).
6. **Keep `PUBLIC_URL` exact.** It's used for the CSRF origin check and for secure-cookie decisions.
7. **Review the audit log** (Admin → Activity) now and then: sign-ins, failed sign-ins, sharing, admin changes and permanent deletions are recorded.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
