# Architecture

This document explains how Family Cloud is put together and why. It's written for contributors and for anyone evaluating whether the design fits their needs.

## Goals and constraints

- **Runs on one ordinary home computer**, installed by a non-expert with one script.
- **Family-sized** (a handful to a few dozen people, up to tens of TB, folders with 10k+ files), but with **clean seams** so each part could be scaled independently.
- **Safe with irreplaceable data**: every write is verified, nothing is deleted without a trash period, disks can be replaced without downtime.
- **Reachable from anywhere without opening ports** (Cloudflare Tunnel), which imposes a 100 MB request limit and a 100 s response timeout.

## System overview

```
                        ┌───────────────────────────── host ─────────────────────────────┐
 Browser / phone ──┐    │  docker network "edge"          docker network "internal"      │
 Files-app helper  ├─►  │  cloudflared ──► app :3000 ───────────────► db (PostgreSQL 18) │
 Finder / Windows ─┘    │   (or caddy)     │  API /api/v1  ▲           ▲ jobs (pg-boss)   │
       HTTPS            │                  │  WebDAV /dav  │           │                  │
  Cloudflare edge       │                  │  web app  /   │         worker              │
                        │                  ▼               │   thumbnails, checksums,    │
                        │  /srv/familycloud/volumes/disk1, disk2 … (bind mount, rslave)  │
                        │  /srv/familycloud/cache (thumbnails)                           │
                        └────────────────────────────────────────────────────────────────┘
```

| Component | Responsibility | Scales by |
| --- | --- | --- |
| **app** | HTTP API, WebDAV, serving the web app, streaming file bytes | Stateless apart from short-lived caches; run N replicas behind a load balancer |
| **worker** | CPU-heavy or slow work: thumbnails (sharp, libheif, ffmpeg, poppler), SHA-256 checksums, draining disks, scheduled cleanup | More replicas; pg-boss hands each job to exactly one worker |
| **db** | Accounts, folder tree, sharing, sessions, upload state, audit log, job queue | Vertical first; read replicas for listings |
| **volumes** | File bytes on one or more disks | Add disks; or swap the local blob store for S3-compatible storage |

The worker is a separate process so decoding a 50-megapixel photo or a 4K video never delays API responses.

## Storage model

**The folder tree is data; file contents are opaque blobs.**

- `nodes` is an adjacency list (`parent_id`) of folders and files. A file node points to a `blobs` row.
- A blob lives at `<volume>/blobs/<last-2-hex>/<prev-2-hex>/<uuidv7>` on exactly one volume (`blobs.volume_id`). UUIDv7 starts with a timestamp, so the directory fan-out uses the random tail.
- Names never touch the filesystem, which eliminates path traversal and filename-encoding problems. Rename and move are single-row updates.
- Case-insensitive unique names per folder are enforced by a partial unique index on `(parent_id, lower(name)) WHERE deleted_at IS NULL`. Names are NFC-normalized, so macOS and Windows spellings of "é" compare equal.

### Volumes

A volume is a directory under `/data/volumes` containing a marker file with its ID. The host bind mount uses `propagation: rslave`, so a disk mounted on the host later appears inside the running container.

- **Health:** each volume is probed (marker + `statfs`) at most every 10 s. A missing marker means *offline*, which covers the classic failure where an unmounted disk's empty mount point silently fills the root filesystem.
- **Placement:** a new upload goes to the active, online volume with the most usable space. That's free space minus the volume's reserve minus bytes already promised to in-flight uploads, capped by an optional per-volume limit.
- **Drain:** a job copies each blob to another volume, streaming it through SHA-256, re-hashes the copy, and flips `volume_id` in a transaction. Only then does it unlink the source. Readers holding the old file keep their open descriptor. The job is resumable and idempotent.

### Quotas

Usage is tracked in counters on `users` (`used_bytes`, `reserved_bytes`) rather than summed on demand:

1. **Reserve** when an upload starts. One conditional `UPDATE … WHERE used + reserved + n <= quota` under an exclusive advisory lock that also serializes the family-wide cap check. Twenty concurrent uploads can't overshoot (tested).
2. **Commit** when it finishes (`reserved → used`), in the same transaction that creates the node.
3. **Release** on abort or expiry.
4. **Reconcile** nightly: recompute from `nodes` under the same lock and correct any drift.

Uploads into a shared folder are charged to the folder's owner, because the tree is theirs.

## Upload protocol

Built around Cloudflare's limits (100 MB per request, 100 s per response):

```
POST /uploads {parentId, name, size}      → authorize, reserve quota, pick volume,
                                             create sparse temp file of `size` bytes
PUT  /uploads/:id/chunks/:i  (≤32 MiB)    → stream body to the temp file at i*chunkSize,
                                             verify length, record chunk (idempotent)
     …chunks in any order, 3 in parallel…
     last chunk → atomic uploading→finalizing flip (exactly one request wins),
                  fsync, rename temp → blob path (same filesystem: atomic),
                  one transaction: blob row + node row + usage counters,
                  enqueue checksum + thumbnail jobs
GET  /uploads/:id                          → which chunks the server has (resume)
```

Finalizing is a rename plus one short transaction, so even a 50 GB file completes well inside the proxy timeout. The browser's upload manager retries failed chunks with exponential backoff, waits for the network when offline, and skips chunks the server already has.

WebDAV clients upload a whole file in one `PUT`. That goes through the same reservation path (`uploads/ingest.ts`), streaming straight to a temp file.

## Permissions

A single function, `loadAccess(user, node)`, decides everything. In one recursive CTE it walks the node's ancestors and joins any shares for the user:

- the owner of a tree has **owner** access to all of it;
- a share on a folder grants **view** or **edit** on that folder and everything below;
- anything else returns **404**, whether the item doesn't exist or you just can't see it (no existence leaks).

Changing where an item appears (rename, move, trash) needs edit access on its **parent**. So someone you shared a folder with can manage its contents but can't rename or delete the shared folder itself, which lives in your space. Moves across owners are refused because they would silently shift quota. Admins manage accounts and disks but **cannot read anyone's files**.

## Data model

| Table | Purpose |
| --- | --- |
| `users` | Accounts, argon2id password hash, role, quota counters, encrypted TOTP secret, lockout state |
| `sessions` | SHA-256 of session tokens; sliding (30 d) and absolute (90 d) expiry |
| `invites` | Hashed single-use invite tokens with role and quota |
| `nodes` | Folder tree: owner, parent, name, blob, trash state (`deleted_at`, `trash_root_id`) |
| `blobs` | Where bytes live: volume, size, SHA-256, thumbnail status |
| `storage_volumes` | Disks: path, status (active/readonly/draining/retired), limit, reserve |
| `upload_sessions`, `upload_chunks` | Resumable upload state |
| `shares` | Family shares (view/edit) |
| `share_links` | Public links: token hash + encrypted token (so owners can copy it again), optional password, expiry |
| `app_passwords` | Per-device WebDAV passwords (hashed) |
| `settings` | Family limit, max file size, trash retention, default quota |
| `audit_log` | Sign-ins, admin actions, sharing, deletions |

Migrations are generated by drizzle-kit and applied automatically on start, guarded by an advisory lock so the app and worker can start together.

## Caching

| Layer | What | Policy |
| --- | --- | --- |
| Cloudflare edge | Hashed web assets | `public, max-age=31536000, immutable` |
| Cloudflare edge | API, WebDAV, file content | `private`: never stored at the edge |
| Browser | Thumbnails (URL keyed by immutable blob id) | `private, max-age=31536000, immutable` |
| Browser | File content | `private, no-cache` + ETag → 304 |
| App memory | Session lookups | LRU (10k entries, 30 s), evicted on sign-out, role change or disable |
| App memory | Disk health / free space | 10 s |
| App memory | Settings | 5 s |
| Web app | Server state | TanStack Query (30 s stale time), optimistic rename/move/trash, per-folder invalidation |

Pre-compressed brotli and gzip copies of the web assets are produced at build time and served without runtime compression.

## Background jobs

pg-boss queues live in PostgreSQL (no Redis). Jobs are retried with backoff; recurring ones use pg-boss's cron scheduler.

| Job | Trigger |
| --- | --- |
| `thumbnail`, `hash` | After each upload (and re-queued on worker start if missed) |
| `drain-volume` | Admin clicks "Move files off & retire"; resumed on worker start |
| `purge-trash` | Daily 03:17 (items older than the retention period) |
| `reconcile-usage` | Daily 03:47 |
| `expire-uploads` | Every 15 min (abandoned uploads release their reservation) |
| `cleanup-sessions` | Daily |

## Scaling path

The deployment is deliberately single-node. The seams to grow past it, roughly in order:

1. **More app replicas.** The app is stateless. Move the session LRU to Redis (or accept the 30 s revocation window) and put a load balancer in front.
2. **Object storage.** `VolumeManager` and `blobFile()` are the only code that knows blobs are local files. An S3 adapter (presigned downloads, multipart uploads) slots in there.
3. **Database.** Listings and authz are indexed keyset queries. Add read replicas for listings, and partition `audit_log` by time.
4. **Workers.** Add replicas; pg-boss is safe with multiple consumers. Move media work to dedicated machines.
5. **Queue.** If job volume outgrows PostgreSQL, swap pg-boss for a dedicated broker behind the `JobQueue` interface.

## Repository layout

See the [README](../README.md#repository-layout). Server features live in `apps/server/src/modules/<feature>/` (routes + service). The API contract is shared from `packages/shared`, so the server validates and the web app types the same Zod schemas.
