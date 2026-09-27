# Contributing

Thanks for helping. Family Cloud aims to stay small, dependable and easy to self-host, so changes are judged by how well they serve a family running it on one home computer.

## Setup

See the [development section of the README](README.md#development). In short: Node 24 (`nvm use`), `pnpm install`, `pnpm dev:db`, `pnpm dev`.

## Before opening a pull request

```bash
pnpm lint && pnpm typecheck && pnpm test
```

For UI changes, also run the end-to-end smoke test against your dev instance (`pnpm e2e`) and check keyboard use and a phone-sized window.

## Conventions

- **TypeScript everywhere, strict.** The API contract lives in `packages/shared` (Zod schemas). Change it there first; the server validates it and the web app types against it.
- **Server features** go in `apps/server/src/modules/<feature>/` (`routes.ts` + service code). All access to files goes through `loadAccess` / `requireAccess`; never query `nodes` for a user without it.
- **Database changes:** edit `src/db/schema.ts`, then `pnpm --filter @familycloud/server db:generate` and commit the generated migration.
- **Tests:** server features get integration tests against real PostgreSQL (`apps/server/test`). UI components get Testing Library + axe tests next to them. Query by role and name, not by class or test id.
- **UI:** build from `components/ui` primitives; see [docs/ui-components.md](docs/ui-components.md). Every control needs an accessible name and must work with the keyboard.
- **Security-sensitive changes** (auth, sharing, file serving, WebDAV) should say in the PR description what threat they touch; see [docs/security.md](docs/security.md).
- **Formatting and lint:** Biome (`pnpm format`). Keep comments for the *why*.

## Releases

Maintainers tag `vX.Y.Z`; the release workflow publishes multi-arch images to GHCR.
