# HTTP API

The web app talks to a JSON API under `/api/v1`. Every request and response is validated against the Zod schemas in [`packages/shared`](../packages/shared/src/schemas); those schemas are the contract. In development, interactive OpenAPI docs are at **`/api/docs`** (off in production).

## Conventions

- **Auth:** a session cookie (`__Host-fc_session` over HTTPS) set by `POST /auth/login`. It's HttpOnly and SameSite=Lax; tokens are stored hashed.
- **CSRF:** state-changing requests must come from the app's own origin (`Origin` header). Only JSON bodies are accepted, plus raw bytes for upload chunks.
- **Errors:** always [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`:

  ```json
  { "type": "about:blank", "title": "Insufficient Storage", "status": 507,
    "code": "QUOTA_EXCEEDED", "detail": "Not enough storage left in your quota for this file" }
  ```

  Switch on `code` (stable, listed in [`errors.ts`](../packages/shared/src/errors.ts)), not on `detail`. Validation errors add an `issues` array.
- **Not found vs forbidden:** items you can't see return `404`, exactly like items that don't exist. `403` means you can see it but lack the permission for this action.
- **Rate limits:** 1200 requests/min per IP overall; sign-in, setup, invite-acceptance and link-password endpoints 5–10/min. Exceeding one returns `429 RATE_LIMITED`.
- **Pagination:** folder listings (including public links) use opaque keyset cursors (`nextCursor`). Pass it back as `?cursor=`. Stable under concurrent changes. Names sort case-insensitively in natural order (`IMG_2` before `IMG_10`).
- **Caching:** API responses are `Cache-Control: private, no-store` unless noted (file content revalidates with its `ETag`; thumbnails are immutable).
- **Timestamps:** ISO-8601 UTC. **Sizes:** bytes.

## Endpoints

### Session and account

| Method | Path | Description |
| --- | --- | --- |
| GET | `/auth/setup-status` | `{needsSetup, appName, wordmark, logoVersion, homeUrl, sourceUrl, privacyNotice, trashRetentionDays, versionRetentionDays}`: public |
| GET | `/about` | `{version, releases:[{version, date, groups:[{title, items}]}]}`: the running version and the changelog; "Before you update" groups go to admins only |
| GET | `/admin/scanner` | `{installed, enabled, reachable, version, waiting, infected:[{name, owner, signature}]}`: virus scanning status (admin) |
| GET / POST | `/auth/passkeys` | List your passkeys / add one (after `POST /auth/passkeys/register/options`) |
| PATCH / DELETE | `/auth/passkeys/:id` | Rename / remove a passkey |
| POST | `/auth/passkeys/login/options`, `/auth/passkeys/login` | Sign in with a passkey (no email needed; counts as two-factor) |
| GET | `/auth/storage` | `{usedBytes, quotaBytes, availableBytes}`: space left, after quota, family limit and disks |
| POST | `/auth/setup` | Create the first admin (needs the setup token) |
| POST | `/auth/login` | `{email, password}` → `{status:"ok", user}` or `{status:"mfa_required", mfaToken}` |
| POST | `/auth/login/totp` | `{mfaToken, code}` → `{status:"ok", user}` |
| POST | `/auth/login/recovery` | `{mfaToken, code}`: the second step with a recovery code (single use; counts toward the lockout) |
| POST | `/auth/logout` | End this session |
| GET / PATCH | `/auth/me` | Current user (fresh usage numbers) / change display name |
| POST | `/auth/password` | Change password; signs out other sessions |
| GET / DELETE | `/auth/sessions[/:id]` | List / revoke signed-in devices |
| POST | `/auth/totp/setup`, `/enable`, `/disable` | Two-factor (TOTP) management. `enable` also returns ten `recoveryCodes` (shown once); `disable` takes `{password, code}` or `{password, recoveryCode}` |
| GET / POST | `/auth/recovery-codes` | `{remaining}` / `{password}` → `{codes}`: new codes replace the old ones |
| GET / POST / DELETE | `/auth/app-passwords[/:id]` | Network-drive device passwords |
| GET | `/invites/:token` | Invite details (public) |
| POST | `/invites/:token/accept` | Create an account from an invite |
| GET / POST | `/password-resets/:token` | A reset link from an admin: `{email, displayName, expiresAt}` / `{password}` sets the new password (single use; signs out everywhere; doesn't sign in, so two-factor still applies) |

### Files and folders

| Method | Path | Description |
| --- | --- | --- |
| GET | `/nodes/:id` | Node, your access level, owner, breadcrumbs |
| GET | `/nodes/:id/children` | `?limit&cursor&sort=name\|updated\|size&dir=asc\|desc`; folders first |
| POST | `/nodes/:id/name-check` | `{names}` → `{files, folders, versionRetentionDays}`: which names a folder already has |
| POST | `/folders` | `{parentId, name, reuseExisting?}` |
| POST | `/nodes/:id/copy` | `{parentId, name?}`: copy a file or folder (up to 10,000 items). Instant: copies share the stored bytes. Counts toward the destination owner's storage |
| PATCH | `/nodes/:id` | `{name?}` rename / `{parentId?}` move |
| DELETE | `/nodes/:id` | Move to trash (with everything inside) |
| POST | `/nodes/lookup` | `{ids}` → the ones you can see |
| GET | `/nodes/:id/content` | Download; `?inline=1` to view. Supports `Range` and `If-None-Match`. |
| GET | `/nodes/:id/thumbnail` | `?size=256\|1600` WebP |
| GET | `/nodes/:id/stream` | A video's 720p H.264 streaming copy once the worker has made it, else the original |
| GET | `/nodes/:id/preview` | Office documents: a PDF (or, for spreadsheets, an HTML copy served as an attachment); `404` with `X-Preview-Status` until it's ready |
| GET | `/zip?ids=a,b,c` | Stream a zip of files/folders |
| GET | `/search?q=` | Search by name: your files and everything shared with you |
| GET | `/recent` | Files added or changed lately, yours and in folders shared with you (`?limit`) |
| GET | `/starred` | Your starred items that you can still open |
| PUT / DELETE | `/nodes/:id/star` | Star / unstar |

### Uploads (chunked, resumable)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/uploads` | `{parentId, name, size, mimeType?, onConflict?}` → session with `chunkSize`, `totalChunks`. `onConflict: "replace"` saves over a file of that name (its contents become a version) instead of adding "name (1)" |
| POST | `/uploads/instant` | The same plus `sha256`: adds the file without sending it when the same bytes are already stored in something you can see; `{node: null}` otherwise |
| PUT | `/uploads/:id/chunks/:index` | Raw bytes (`application/octet-stream`). The last chunk returns the new `node`. |
| GET | `/uploads/:id` | `receivedChunks` for resuming; `node` once complete |
| DELETE | `/uploads/:id` | Cancel and release the reserved quota |

Chunks may be sent in any order and in parallel; re-sending one is harmless. Every chunk except the last must be exactly `chunkSize` bytes.

### Versions

When a file is saved over (network drive, `onConflict: "replace"`, restoring), its previous contents are kept for `versionRetentionDays` (admin setting, default 30; 0 turns versions off), up to 50 per file. They count toward the owner's storage, and the oldest are deleted automatically when the owner's own upload would otherwise not fit their quota (never for someone else's upload). Seeing, downloading and restoring versions needs edit access to the file; deleting them needs ownership.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/nodes/:id/versions` | `{current, items, retentionDays, canDelete}`, newest first |
| GET | `/nodes/:id/versions/:versionId/content` | Download a version (`?inline=1` to view) |
| POST | `/nodes/:id/versions/:versionId/restore` | Make it current again (what was current becomes a version) |
| DELETE | `/nodes/:id/versions[/:versionId]` | Delete one version / all of a file's versions (owner only) |

### Trash

| Method | Path | Description |
| --- | --- | --- |
| GET | `/trash` | Your trashed items and the retention period |
| POST | `/trash/:id/restore` | Restore (into the original folder if it still exists) |
| DELETE | `/trash/:id` / `/trash` | Delete one item / everything forever |

### Sharing

| Method | Path | Description |
| --- | --- | --- |
| GET | `/users/directory` | Family members, for the share picker |
| GET / POST | `/nodes/:id/shares` | List / add `{userId, permission: view\|edit}` (owner only) |
| PATCH / DELETE | `/shares/:id` | Change permission / remove (a recipient may remove themselves) |
| GET | `/shared-with-me` | Items others shared with you |
| GET / POST | `/nodes/:id/links` | Public links: `{kind?, title?, password?, expiresAt?, allowDownload, maxDownloads?, maxUploadBytes?}`. `kind: "upload"` makes a file request (folders only; `maxUploadBytes` defaults to 5 GB). Links report `downloadCount`, `uploadCount` and `uploadBytes`. `url` is `null` for links made before a `SECRET_KEY` change (they can still be revoked) |
| DELETE | `/links/:id` | Revoke a link (uploads still coming in through a file request stop at once) |
| GET | `/shared-by-me` | Everything you share with family or by link |

### Photos (trip albums)

An album is a trip: a name, dates and who went. Each person's photos live in a folder in their own space (`Trips/<album>`), so they use that person's quota and also appear in My Files and on the network drive. Every family member can see every album; people on the trip can add photos.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/albums` | All trips, newest first (`?person=<userId>` to filter) |
| POST | `/albums` | `{title, startDate, endDate?, note?, peopleIds}` |
| GET / PATCH / DELETE | `/albums/:id` | Album details / edit (starter or admin; also `coverNodeId`) / delete (photos stay in people's folders) |
| POST | `/albums/:id/folder` | Your upload folder for the album (created on first use); then upload with `POST /uploads` |
| GET | `/albums/:id/photos` | Photos and videos in the order they were taken (camera clock; upload time for photos without a date), with `takenAt` and `location` (`?cursor&limit`) |
| GET | `/albums/:id/photos/:nodeId/content`, `/thumbnail` | A photo, or its thumbnail (`?size=256\|1600`) |
| GET | `/albums/:id/zip` | Every photo in one zip |

### Public links (no account)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/public/links/:token` | `{kind, title, locked, sharedBy, node, …}`: what the link points to (`node` is `null` while locked, and always for file requests) |
| POST | `/public/links/:token/unlock` | `{password}` → sets a 12 h cookie scoped to link routes |
| GET | `/public/links/:token/folder` | `?folderId&limit&cursor` listing inside a shared folder |
| GET | `/public/links/:token/content/:nodeId` | Download (`?inline=1` to view; on a view-only link only previewable types are served) |
| GET | `/public/links/:token/thumbnail/:nodeId` | Thumbnail |
| GET | `/public/links/:token/zip/:nodeId` | Zip of a shared folder |
| POST | `/public/links/:token/uploads` | File requests only: `{name, size, mimeType?, from?}` starts an upload (the sender's name puts their files in a folder named after them, or prefixes photos sent to an album) |
| PUT | `/public/links/:token/uploads/:id/chunks/:index` | Raw bytes → `{receivedCount, totalChunks, status, done}` |
| GET / DELETE | `/public/links/:token/uploads/:id` | Resume / cancel |

Every view route (`folder`, `content`, `stream`, `preview`, `thumbnail`, `zip`) answers `404` for a file request's token: a request never shows what's in its folder. Downloads (not previews or streaming) count toward a link's `maxDownloads`; past it, the link answers `410`. A disabled account's links stop working.

### Admin (role `admin`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/overview` | Disks, people, totals and warnings |
| GET / PATCH | `/admin/users[/:id]` | Quota, role, disable |
| POST | `/admin/users/:id/reset-totp`, `/sign-out` | Recovery actions |
| POST | `/admin/users/:id/password-reset` | `{url, expiresAt}`: a one-time link (3 days) for the person to choose a new password; only the newest works |
| POST | `/admin/users/:id/delete` | `{confirmEmail}`: delete a **disabled** account and everything in it for good |
| GET / POST / DELETE | `/admin/invites[/:id]` | Invite links |
| GET | `/admin/volumes/candidates` | Unregistered folders under the volumes root |
| POST / PATCH | `/admin/volumes[/:id]` | Add a disk / change limits or pause |
| POST | `/admin/volumes/:id/drain`, `/cancel-drain` | Move files off a disk and retire it |
| GET / PATCH | `/admin/settings` | Family limit, max file size, trash and version retention, default quota, allowed email domains |
| GET / PATCH | `/admin/branding` | Word beside the logo, a link to the family's website, and a notice for the Privacy page |
| POST / DELETE | `/admin/branding/logo` | `{mimeType, data}` (base64 SVG/PNG/WebP, ≤256 KB) / back to the built-in logo |
| GET | `/brand/logo`, `/brand/icon/:size` | Public: the logo, and PNG app icons made from it (`180`, `192`, `512`, `maskable`) |
| GET | `/admin/audit` | Audit log (`?before=&limit=`); entries older than a year are removed |

### Health

| Path | Description |
| --- | --- |
| `/healthz` | Process is up |
| `/readyz` | `200` if the database and every disk are OK, `503` otherwise (details only for local callers) |

## WebDAV

`/dav/` speaks WebDAV class 1 and 2 (`PROPFIND`, `GET`/`HEAD` with `Range`, `PUT`, `MKCOL`, `MOVE`, `COPY`, `DELETE`, `LOCK`/`UNLOCK`, `PROPPATCH`, `OPTIONS`, plus RFC 4331 quota properties). Authentication is HTTP Basic with the account email and a device password. `PUT` honours `If-Match` / `If-None-Match` (`412` when they fail). Folder listings are streamed, so there is no item limit. See [network-drive.md](network-drive.md).
