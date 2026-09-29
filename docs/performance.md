# Performance

Measured on the production build (`node dist/index.js`, Node 24, PostgreSQL 18) on a 24-core desktop with an NVMe disk, client on the same machine. Numbers are for orientation; a family server's real limit is almost always the home internet upload speed.

## Results

### API: a folder with 10,000 files

| Request | p50 | p95 |
| --- | --- | --- |
| List first page (200 items, name order) | 2.2 ms | 3.9 ms |
| List a deep page (~item 5,000, keyset cursor) | 4.0 ms | 4.6 ms |
| List sorted by size, descending (no covering index) | 4.5 ms | 5.4 ms |
| Folder details (permission check + breadcrumbs) | 1.0 ms | 1.2 ms |
| Name search | 0.8 ms | 1.5 ms |

- **Throughput:** 50 concurrent clients × 20 listings of 200 items each → about **930 requests/s** from a single Node process.
- **Transfers:** a 64 MiB chunked upload (3 parallel 32 MiB chunks) ran at about **300 MiB/s**, and download at about **1 GiB/s**. Both are disk- and loopback-bound.

### Memory

| Situation | Server RSS |
| --- | --- |
| Idle, before tuning | 223 MB |
| Idle, with `--max-semi-space-size=16` (shipped) | 142 MB |
| Peak while uploading 1 GiB and streaming 4 × 1 GiB downloads in parallel | unchanged from idle (streaming) |
| After three back-to-back full benchmark runs | 308 → 325 → 332 MB (plateau; no leak) |

### Web app

| Metric | Value |
| --- | --- |
| Folder with 10,000 files: time to first rows after navigation | 53 ms |
| DOM rows rendered for 10,000 items | 17 (virtualized) |
| Scroll through all 10,000 items (50 pages loaded on the way) | 2.6 s |
| JS heap with 10,000 items loaded | 46 MB |
| Initial JavaScript and CSS (gzipped) | ~213 KB (204 KB JS + 9 KB CSS), with admin, settings, preview, public, sharing and version-history screens loaded on demand |

Reproduce: `E2E_PERF_FOLDER=<folder id> pnpm e2e e2e/perf.spec.ts`.

## What made it fast (and what was fixed)

**Measured problems, then fixed:**

| Problem found | Impact | Fix |
| --- | --- | --- |
| Zod was bundled into the browser: the web app imported the shared package's root, which built every schema at load time | ~100 KB extra JS (~27 KB gzipped) and parse time on every visit | Split `@familycloud/shared` into a browser entry (helpers + *types only*) and a server entry (`/all`) with runtime schemas |
| V8 sized the young generation to the host's 30 GB of RAM (128 MB of mostly empty heap) | +80 MB idle memory, which matters on a Raspberry Pi | `NODE_OPTIONS=--max-semi-space-size=16` in the image; no measurable latency or throughput change |
| The upload client treated `507 Quota exceeded` as retryable (all 5xx were retried) | A full account retried each upload 7 times with backoff before failing | Retry only transient statuses (0, 408, 429, 500, 502, 503, 504) |

**Design choices that keep it fast:**

- **Copies and repeat uploads cost nothing.** Copies, instant uploads and versions point at stored bytes that already exist, so they're immediate and take no disk (they still count toward the owner's quota).
- **Branding is cached.** The logo (up to a few hundred KB in the database) is read once every few seconds, not on every page load, favicon and manifest request.

- **Streaming end to end.** Uploads go from the socket straight into a pre-allocated file at the chunk's offset; downloads and zips stream from disk. Memory stays flat regardless of file size.
- **Keyset pagination with a covering index** on `(parent_id, type, lower(name), id)`. Pages stay fast at any depth; offsets would degrade linearly.
- **One query for permissions and breadcrumbs** (recursive CTE) instead of a query per ancestor.
- **Heavy work out of the request path.** Thumbnails and checksums run in the worker; finishing an upload is a rename plus one transaction.
- **Cheap auth.** A session LRU avoids a database hit per request; the last-seen timestamp is written at most hourly.
- **Caching at every layer:** immutable hashed assets and thumbnails, ETag/304 for file content, precompressed brotli, TanStack Query with targeted invalidation. Details in [architecture.md](architecture.md#caching).
- **Frontend rendering:**
  - The file list is virtualized against the window scroll.
  - Upload progress is batched to one update per animation frame, from a store outside React.
  - Thumbnails lazy-load and decode asynchronously in fixed-size boxes (no layout shift).
  - Admin, settings, the previewer, the public link page and dialogs opened on demand (sharing, version history) are separate chunks.

## Scaling recommendations

- **More users or traffic:** run more `app` replicas behind the proxy (see [architecture.md](architecture.md#scaling-path)). A single process already serves far more than a family generates.
- **Big photo libraries:** thumbnail throughput scales with `WORKER_CONCURRENCY` (default: half the CPU cores) and with more worker replicas.
- **Slow home upload bandwidth** is the usual bottleneck for remote access. Cloudflare's network helps with latency but not with your line's upload speed.
- **Databases beyond a few million files:** add read replicas for listings, and partition `audit_log` by month.
