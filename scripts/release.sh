#!/usr/bin/env bash
# Cuts a release: turns CHANGELOG.md's "Unreleased" section into the new version's, sets the
# version in every package.json, commits "Release vX.Y.Z" and tags vX.Y.Z. Nothing is pushed;
# pushing the tag publishes the images and the GitHub release (.github/workflows/release.yml).
#
#   ./scripts/release.sh 0.2.0        (or v0.2.0; pre-releases like 1.0.0-rc.1 work too)
#
# Which number to raise is in docs/releasing.md.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $# -eq 1 ]] || { sed -n '2,8p' "$0"; exit 1; }
VERSION=${1#v}
TAG="v$VERSION"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
  || die "The version must look like 0.2.0 (MAJOR.MINOR.PATCH), optionally with -rc.1."

[[ "$(git symbolic-ref --quiet --short HEAD)" == main ]] || die "Release from the main branch."
git diff --quiet HEAD && [[ -z "$(git status --porcelain --untracked-files=no)" ]] \
  || die "Commit or stash your changes first."
git fetch --quiet --tags origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || die "main differs from origin/main: push or pull first."
git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null && die "$TAG already exists."
LATEST=$(latest_release)
if [[ -n "$LATEST" && "$(printf '%s\n%s\n' "$LATEST" "$TAG" | sort -V | tail -1)" != "$TAG" ]]; then
  die "$TAG isn't newer than the latest release, $LATEST."
fi

NOTES=$(changelog_section Unreleased < CHANGELOG.md)
[[ -n "${NOTES//[[:space:]]/}" ]] \
  || die "CHANGELOG.md's Unreleased section is empty: describe what changed first."

# A fresh, empty Unreleased section stays on top for the next release.
awk -v heading="## $TAG ($(date +%Y-%m-%d))" '
  !done && $0 == "## Unreleased" { print; print ""; print heading; done = 1; next }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

for f in package.json apps/*/package.json packages/*/package.json; do
  node -e '
    const fs = require("node:fs");
    const [f, v] = process.argv.slice(1);
    const text = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, text.replace(/"version": "[^"]*"/, `"version": "${v}"`));
  ' "$f" "$VERSION"
done

git add CHANGELOG.md package.json apps/*/package.json packages/*/package.json
git commit --quiet -m "Release $TAG"
git tag -a --cleanup=verbatim "$TAG" -F - <<<"Family Cloud $TAG

$NOTES"

echo "Tagged $TAG. Check it (git show $TAG), then publish:"
echo "  git push origin main $TAG"
