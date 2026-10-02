# Family Cloud

Self-hosted family cloud storage. pnpm workspace: `apps/server` (Fastify 5 + Drizzle + pg-boss),
`apps/web` (React 19 + Vite + TanStack Query + Radix + Tailwind 4), `packages/shared` (Zod schemas,
helpers). See `docs/architecture.md` for the design and `README.md` for the layout.

## Commands

Node 24+ is required. If `node -v` is older, put nvm's Node 24 first on PATH:
`export PATH=$HOME/.nvm/versions/node/v24.*/bin:$PATH`.

- `pnpm install`
- `pnpm lint`: Biome lint + format check. Check the **exit code**; format diffs don't print "error".
- `pnpm format`: apply Biome fixes.
- `pnpm typecheck`
- `pnpm test`: server tests start an embedded Postgres (or use `TEST_DATABASE_URL`), and web tests run in jsdom.
- `pnpm build`
- `pnpm dev:db` then `pnpm dev`: local Postgres, then the API on :3000 and Vite on :5173.
- `pnpm e2e`: Playwright against a running dev or prod build.
- `pnpm --filter @familycloud/server db:generate`: new migration after editing `db/schema.ts`.
- `./scripts/update.sh [--check]`: update an install. `./scripts/release.sh X.Y.Z`: cut a release (never push without asking).

## Conventions

- **Authorization:** every file route goes through `modules/files/access.ts`.
  - Reads use `loadAccess`/`requireAccess`.
  - Writes re-check inside the transaction with `lockWriteAccess`.
  - An item the user can't see returns 404, not 403.
- **Quota changes** run under the `QUOTA_LOCK` advisory lock (`modules/files/tree.ts`). Never update `used_bytes`/`reserved_bytes` outside it.
- **File contents** change only through `replaceContent` (`modules/versions/service.ts`), which keeps the old contents as a version. Blobs are shared (instant uploads, copies, versions): delete one only with `blobUnused`/`deleteUnusedBlobs`, under the quota lock.
- **Virus scanning** is optional (`CLAMAV_HOST`). File bytes leave only through `sendBlob`/`sendZip` (`modules/files/serve.ts`), which refuse infected blobs: a new download route must use them.
- **Public links** have two kinds. Every route that shows content resolves the token with `resolveUnlocked(…, 'view')`; file requests (`'upload'`) must never reach one.
- **File names never touch disk.** Blobs are stored by UUID, and names are validated in `packages/shared/src/names.ts`.
- **Errors** are `AppError` with a stable `code` and come back as RFC 9457 problem+json.
- **Browser entry:** web code imports `@familycloud/shared` (types plus helpers only). The server imports `@familycloud/shared/all` (runtime Zod schemas).
- **Tests:**
  - Server tests use `test/helpers.ts` (`createTestEnv`, `Client`, `setupAdmin`, `addMember`, `uploadFile`).
  - A security fix gets a regression test that fails on the old code.
- **Changelog and versions** (full rules: `docs/releasing.md`):
  - A change a family would notice adds a line under `## Unreleased` in `CHANGELOG.md`, in the same commit, written for the person running the server.
  - Anything an admin must do by hand when updating goes under `### Before you update`.
  - Versions are `vMAJOR.MINOR.PATCH`; releases are cut only with `scripts/release.sh`.
  - Migrations are forward-only and must upgrade from any earlier release. Never edit a shipped migration.
- **Shell scripts:** `set -euo pipefail`. Read `.env` files with `load_env` from `scripts/lib.sh`, never `source`.
- **Style:** match the surrounding code: Biome formatting, sparse comments that say why, no dead code.

## Don't

- Read or print `deploy/.env`, `deploy/backup.env` or real tokens.
- Run `add-disk.sh` or `mkfs` against real devices.
- Commit anything under `deploy/cloudflare/` (personal DNS zone).
