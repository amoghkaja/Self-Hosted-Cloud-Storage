# Versions and releases

Families update with one command (`./scripts/update.sh`), often automatically on a Sunday
morning. These rules keep that safe and tell them what changed.

## Version numbers

Releases are numbered `vMAJOR.MINOR.PATCH` ([semantic versioning](https://semver.org)):

| Raise | When | Example |
| --- | --- | --- |
| **PATCH** | Only fixes: nothing new to learn, nothing to do | `v0.3.0` → `v0.3.1` |
| **MINOR** | New features or visible changes, still updating by itself | `v0.3.1` → `v0.4.0` |
| **MAJOR** | The admin must do something by hand, or an old setup stops working (a setting renamed, a manual migration, a new required service) | `v0.4.0` → `v1.0.0` |

Before `v1.0.0`, a change that needs manual steps raises MINOR instead, and is still listed
under **Before you update**. Test builds are pre-releases, `v1.2.0-rc.1`: they're never
`latest` and `update.sh` skips them.

## The changelog

Every change a family would notice adds a line to the **Unreleased** section of
[CHANGELOG.md](../CHANGELOG.md), in the same commit. Refactors, tests and CI don't.

- Group lines under `### New`, `### Improved`, `### Fixed`, `### Security` and
  `### Before you update`, in that order, leaving out empty groups.
- Write for the person who runs the server, not for developers: what they'll see or can now
  do, starting with a **bold** area name. "**Photos:** swipe down to close a photo", not
  "Add a pan gesture handler to Lightbox".
- `### Before you update` gives exact steps, e.g. which line in `deploy/.env` to change.

## Names

| Thing | Name |
| --- | --- |
| Git tag | `v0.4.0` |
| Release commit | `Release v0.4.0` |
| GitHub release | `Family Cloud v0.4.0`, with that version's changelog section as notes |
| Changelog heading | `## v0.4.0 (2026-10-12)` |
| Images (`ghcr.io/amoghkaja/self-hosted-cloud-storage`) | `:v0.4.0` (exact), `:v0.4` (newest patch), `:latest` (newest release), `:edge` (main), `:sha-…` |
| `version` in every `package.json` | `0.4.0` |

`scripts/release.sh` produces all of these, so none are typed by hand.

## Updating must always work

- **Database migrations run forwards only, on start**, and every release must update from
  *any* earlier release: people skip versions. Never edit a migration that has shipped.
- `update.sh` backs up the database first. Going back to an older version means restoring
  that backup (it does so itself when a new version crashes on start), so a release never needs
  a "downgrade" path.
- Automatic updates (`update.sh -y`) stop before any release with a **Before you update**
  section, so those steps are never skipped.
- `main` must always be deployable: people on the `main` channel build it as it is.

## Update channels

`UPDATE_CHANNEL` in `deploy/.env`:

- `stable` (default): the newest release. `update.sh` checks out its tag and pins `IMAGE` to
  that exact version, so the scripts, compose file and image always match.
- `main`: the latest code on the main branch, built on the machine (`IMAGE=familycloud:local`).
  For people working on Family Cloud itself.

## Cutting a release

1. Make sure CI is green on `main` and the Unreleased section says everything that changed.
2. `./scripts/release.sh 0.4.0`. It checks the version is newer than the last release, moves
   Unreleased into `## v0.4.0 (date)`, sets the package versions, commits and tags.
3. `git show v0.4.0` to check, then `git push origin main v0.4.0`.
4. The [release workflow](../.github/workflows/release.yml) builds the amd64 and arm64 images,
   pushes them to GHCR and creates the GitHub release. Families get it on their next update.
