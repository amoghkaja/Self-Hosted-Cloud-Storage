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
| GET | `/auth/setup-status` | `{needsSetup, appName, wordmark, logoVersion, homeUrl}`: public |
| GET | `/auth/storage` | `{usedBytes, quotaBytes, availableBytes}`: space left, after quota, family limit and disks |
| POST | `/auth/setup` | Create the first admin (needs the setup token) |
| POST | `/auth/login` | `{email, password}` → `{status:"ok", user}` or `{status:"mfa_required", mfaToken}` |
| POST | `/auth/login/totp` | `{mfaToken, code}` → `{status:"ok", user}` |
| POST | `/auth/logout` | End this session |
| GET / PATCH | `/auth/me` | Current user (fresh usage numbers) / change display name |
| POST | `/auth/password` | Change password; signs out other sessions |
| GET / DELETE | `/auth/sessions[/:id]` | List / revoke signed-in devices |
| POST | `/auth/totp/setup`, `/enable`, `/disable` | Two-factor (TOTP) management |
| GET / POST / DELETE | `/auth/app-passwords[/:id]` | Network-drive device passwords |
| GET | `/invites/:token` | Invite details (public) |
| POST | `/invites/:token/accept` | Create an account from an invite |

### Files and folders

| Method | Path | Description |
| --- | --- | --- |
| GET | `/nodes/:id` | Node, your access level, owner, breadcrumbs |
| GET | `/nodes/:id/children` | `?limit&cursor&sort=name\|updated\|size&dir=asc\|desc`; folders first |
| POST | `/folders` | `{parentId, name, reuseExisting?}` |
| PATCH | `/nodes/:id` | `{name?}` rename / `{parentId?}` move |
| DELETE | `/nodes/:id` | Move to trash (with everything inside) |
| POST | `/nodes/lookup` | `{ids}` → the ones you can see |
| GET | `/nodes/:id/content` | Download; `?inline=1` to view. Supports `Range` and `If-None-Match`. |
| GET | `/nodes/:id/thumbnail` | `?size=256\|1600` WebP |
| GET | `/zip?ids=a,b,c` | Stream a zip of files/folders |
| GET | `/search?q=` | Search your own files by name |

### Uploads (chunked, resumable)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/uploads` | `{parentId, name, size, mimeType?}` → session with `chunkSize`, `totalChunks` |
| PUT | `/uploads/:id/chunks/:index` | Raw bytes (`application/octet-stream`). The last chunk returns the new `node`. |
| GET | `/uploads/:id` | `receivedChunks` for resuming; `node` once complete |
| DELETE | `/uploads/:id` | Cancel and release the reserved quota |

Chunks may be sent in any order and in parallel; re-sending one is harmless. Every chunk except the last must be exactly `chunkSize` bytes.

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
| GET / POST | `/nodes/:id/links` | Public links: `{password?, expiresAt?, allowDownload}`. `url` is `null` for links made before a `SECRET_KEY` change (they can still be revoked) |
| DELETE | `/links/:id` | Revoke a link |

### Public links (no account)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/public/links/:token` | What the link points to (or `locked: true`) |
| POST | `/public/links/:token/unlock` | `{password}` → sets a 12 h cookie scoped to link routes |
| GET | `/public/links/:token/folder` | `?folderId&limit&cursor` listing inside a shared folder |
| GET | `/public/links/:token/content/:nodeId` | Download (`?inline=1` to view; on a view-only link only previewable types are served) |
| GET | `/public/links/:token/thumbnail/:nodeId` | Thumbnail |
| GET | `/public/links/:token/zip/:nodeId` | Zip of a shared folder |

### Admin (role `admin`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/overview` | Disks, people, totals and warnings |
| GET / PATCH | `/admin/users[/:id]` | Quota, role, disable |
| POST | `/admin/users/:id/reset-totp`, `/sign-out` | Recovery actions |
| GET / POST / DELETE | `/admin/invites[/:id]` | Invite links |
| GET | `/admin/volumes/candidates` | Unregistered folders under the volumes root |
| POST / PATCH | `/admin/volumes[/:id]` | Add a disk / change limits or pause |
| POST | `/admin/volumes/:id/drain`, `/cancel-drain` | Move files off a disk and retire it |
| GET / PATCH | `/admin/settings` | Family limit, max file size, trash retention, default quota |
| GET / PATCH | `/admin/branding` | Word beside the logo and a link to the family's website |
| POST / DELETE | `/admin/branding/logo` | `{mimeType, data}` (base64 SVG/PNG/WebP, ≤256 KB) / back to the built-in logo |
| GET | `/brand/logo`, `/brand/icon/:size` | Public: the logo, and PNG app icons made from it (`180`, `192`, `512`, `maskable`) |
| GET | `/admin/audit` | Audit log (`?before=&limit=`) |

### Health

| Path | Description |
| --- | --- |
| `/healthz` | Process is up |
| `/readyz` | `200` if the database and every disk are OK, `503` otherwise (details only for local callers) |

## WebDAV

`/dav/` speaks WebDAV class 1 and 2 (`PROPFIND`, `GET`/`HEAD` with `Range`, `PUT`, `MKCOL`, `MOVE`, `COPY`, `DELETE`, `LOCK`/`UNLOCK`, `PROPPATCH`, `OPTIONS`, plus RFC 4331 quota properties). Authentication is HTTP Basic with the account email and a device password. `PUT` honours `If-Match` / `If-None-Match` (`412` when they fail). Folder listings are streamed, so there is no item limit. See [network-drive.md](network-drive.md).
