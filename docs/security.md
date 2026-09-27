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
| Family member | A normal account | Read another member's private files, escape their quota |
| Malicious file | Something uploaded or downloaded | Run script in the app's origin (stored XSS), crash the thumbnailer |
| Someone on the home network | LAN access | Reach the database or internal services |

## Controls

| Threat | Control | Verified by |
| --- | --- | --- |
| **Stored XSS via uploaded HTML/SVG** | Only an allowlist of media types is ever shown inline. Everything else is forced to download as `application/octet-stream`. All file responses carry `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`. SVGs are never rasterized server-side. The app's own CSP has no inline or remote scripts. | `uploads.test.ts` "never renders uploaded HTML or SVG" |
| **Reading someone else's files (IDOR)** | One authorization function (`loadAccess`) used by every route, including WebDAV. Inaccessible items return 404, identical to missing ones. Admins can't read files. | `authz.test.ts`: every endpoint × no share / view / edit; `webdav.test.ts` shares |
| **Path traversal** | File names never touch the filesystem (blobs are stored under UUIDs). Volume paths must `realpath` to a direct child of the volumes root. Zip entry names are validated. | `volumes.test.ts` "refuses paths outside the volumes root" |
| **Session theft / fixation** | 256-bit random tokens in `__Host-` cookies (HttpOnly, Secure, SameSite=Lax), stored as SHA-256, new token per login. Sliding 30-day, absolute 90-day expiry. Password change revokes other sessions. | `auth.test.ts` cookie flags, password change |
| **CSRF** | SameSite cookies, an `Origin` check on every state-changing API call, and JSON-only bodies (form encodings rejected with 415). WebDAV uses Basic auth and needs CORS-preflighted methods, which aren't allowed cross-origin. | `auth.test.ts` "rejects … other origins", "form-encoded bodies" |
| **Password guessing** | argon2id (19 MiB, t=2). 10 sign-ins/min per IP. Per-account progressive lockout after 5 failures. Dummy hash for unknown emails (no timing oracle). Optional TOTP with replay protection (a code can't be reused). | `auth.test.ts` lockout, rate limit, TOTP replay |
| **First-run takeover** | Creating the first account needs a one-time token that is only visible in server logs / CLI. Compared in constant time; rate-limited; creation serialized by a lock. | `auth.test.ts` setup |
| **Share-link guessing** | 192-bit link tokens stored hashed (plus AES-GCM for owner re-display). Optional argon2 password with a 10/min unlock limit. Expiry and revocation. A link only ever reaches its own subtree. | `links.test.ts` |
| **Network-drive credentials** | Device passwords are random (~99 bits), separate from the account password, hashed, revocable per device, and never accepted by the web API. 10 failures/min per IP triggers a throttle. | `webdav.test.ts` |
| **Quota bypass by racing uploads** | Atomic conditional reservation under an advisory lock; nightly reconciliation. | `uploads.test.ts` "never over-commits under concurrent uploads" |
| **Malicious media (decompression bombs, exploits in decoders)** | Decoding happens only in the worker, never the API. Pixel limit 16384². Each external tool has a 60 s timeout and SIGKILL. Arguments are passed as arrays (no shell). Containers run non-root with no capabilities. | Code review |
| **Upload abuse** | Chunk lengths enforced while streaming, 100 open uploads per user, optional max file size, 24 h session expiry that releases reserved space. JSON bodies ≤ 1 MB. | `uploads.test.ts` chunk validation |
| **Spoofed client IPs (to dodge rate limits)** | `CF-Connecting-IP` / `X-Forwarded-For` are honoured only from trusted proxy addresses on the Docker network; Caddy strips client-supplied `CF-Connecting-IP`. | Code review; finding 2 below |
| **Secrets in logs** | Cookies and auth headers redacted. Share and invite tokens scrubbed from every logged URL. Passwords never logged. | `lib.test.ts` "never writes share or invite tokens to the logs" |
| **Secrets at rest** | TOTP secrets and link tokens encrypted (AES-256-GCM, per-purpose keys derived with HKDF from `SECRET_KEY`). `deploy/.env` created with mode 600 and git-ignored. | `lib.test.ts` Keyring |
| **Infrastructure** | App and worker run read-only, as the host user, with `cap_drop: ALL` and `no-new-privileges`. PostgreSQL and the worker sit on an `internal` network with no internet route. No host ports except `127.0.0.1:3080`. The tunnel needs no inbound ports. HSTS on HTTPS. | `deploy/docker-compose.yml` |
| **Clickjacking** | `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. | Headers verified on the production build |
| **Supply chain** | Lockfile with `--frozen-lockfile` builds. Install scripts allowed only for two named packages. `pnpm audit` in CI (no known vulnerabilities at review time). Dependabot for npm, Docker and Actions. Release images carry SBOM and provenance. | CI |
| **Deleting the wrong disk** | `add-disk.sh` refuses the system disk, mounted devices and any whole disk with partitions (e.g. a Windows disk). It formats only after the device path is re-typed. | Checked against a dual-boot machine's real disks |

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

## Accepted risks

| Severity | Item | Rationale / mitigation |
| --- | --- | --- |
| Low | After 5 failed sign-ins, the response for an existing account (`429 ACCOUNT_LOCKED`) differs from an unknown email (`401`), revealing that the account exists. | Requires sustained guessing, which per-IP limits already slow; knowing a family member's email is rarely secret. |
| Low | PDFs viewed inline aren't served with `CSP: sandbox`, because built-in browser PDF viewers refuse to render under it. | Browser PDF engines run document scripts in their own sandbox without access to the page's origin. Every other type keeps the sandbox. |
| Info | Every family member can see the names and emails of other members (share picker). | By design for a family app. |
| Info | Device passwords don't require a two-factor code. | Standard for app passwords. Mitigated by high entropy, WebDAV-only scope, per-device revocation and the failure throttle. |
| Info | WebDAV `LOCK` is advisory; two devices editing the same file can overwrite each other (last write wins). | Needed for Finder/Windows compatibility. Overwrites keep the file identity; old content is not versioned (future work). |
| Info | There are no two-factor recovery codes. | An admin can reset a member's two-factor; the sole admin can use `cli reset-totp` on the server. |
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
