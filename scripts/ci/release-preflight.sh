#!/usr/bin/env bash
# Release preflight: every publication precondition the dispatch can already decide, checked
# before any runner starts packaging.
#
# The publish job repeats these checks immediately before `npm publish`, and that copy stays the
# final authority: tags, releases and registry state can still move while a run packages. This
# copy exists so a release that can never publish fails in its first minute. Run 35783865160
# packaged 2.62.0 for nineteen minutes and then failed the ordering gate on a preview tag that
# already existed when its first job started.
#
# Environment: RELEASE_VERSION, NPM_DIST_TAG, GITHUB_REF, GITHUB_SHA (required); DRY_RUN, RESUME.
# Reads the checkout's tags and refs/remotes/origin/dev, `gh release view` and `npm view`.
# Every problem is reported before the script exits, so one run names all of them.
set -euo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${NPM_DIST_TAG:?NPM_DIST_TAG is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
dry_run="${DRY_RUN:-false}"
resume="${RESUME:-false}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release_tag="v${RELEASE_VERSION}"

problems=0
problem_list=""
fail() {
  problems=$((problems + 1))
  problem_list="${problem_list}- $1
"
  echo "::error::$1"
}

# Channel and dist-tag, exactly as the publish job derives them from the dispatched ref.
expected_tag=""
case "$GITHUB_REF" in
  refs/heads/main)
    expected_tag="latest"
    [[ "$RELEASE_VERSION" != *-* ]] \
      || fail "main releases must use a stable semver version; got ${RELEASE_VERSION}"
    ;;
  refs/heads/preview)
    expected_tag="preview"
    [[ "$RELEASE_VERSION" == *-preview.* ]] \
      || fail "preview releases must use a preview prerelease version; got ${RELEASE_VERSION}"
    ;;
  *)
    fail "Release must run from main or preview; got ${GITHUB_REF}"
    ;;
esac
if [[ -n "$expected_tag" && "$NPM_DIST_TAG" != "$expected_tag" ]]; then
  fail "${GITHUB_REF#refs/heads/} releases must publish with npm dist-tag '${expected_tag}', got '${NPM_DIST_TAG}'"
fi

if [[ "$resume" == "true" && "$dry_run" == "true" ]]; then
  fail "resume-after-npm-publish is a real-publication recovery path and cannot combine with dry-run"
fi

# Every version source (package.json and the desktop manifests) must already name the release.
if ! bun "$repo_root/scripts/release-version-sources.ts" check "$RELEASE_VERSION"; then
  fail "a version source does not match ${RELEASE_VERSION}; run scripts/release.ts on the release branch first"
fi

# Git tag. A tag at another commit is always fatal; one at this commit is expected only when a
# dry run is repeated or a partial publication is resumed.
existing_tag_sha="$(git rev-parse -q --verify "refs/tags/${release_tag}^{commit}" || true)"
if [[ -n "$existing_tag_sha" && "$existing_tag_sha" != "$GITHUB_SHA" ]]; then
  fail "${release_tag} already points at ${existing_tag_sha}, not ${GITHUB_SHA}"
elif [[ -n "$existing_tag_sha" && "$resume" != "true" && "$dry_run" != "true" ]]; then
  fail "${release_tag} already exists. Refusing to publish a version with pre-existing Git metadata."
fi

# GitHub release. An unreadable answer counts as absent here; the publish job reads it again.
if gh release view "$release_tag" >/dev/null 2>&1 && [[ "$resume" != "true" && "$dry_run" != "true" ]]; then
  fail "GitHub Release ${release_tag} already exists. Choose the next unused version."
fi

# npm. Only an exact version answer counts as present and only E404 counts as absent; anything
# else is a registry read failure, which warns rather than blocking a release it cannot judge.
pkg_name="$(node -p "require(process.argv[1]).name" "$repo_root/package.json")"
npm_error="$(mktemp "${TMPDIR:-/tmp}/ocx-release-preflight.XXXXXX")"
trap 'rm -f -- "$npm_error"' EXIT
npm_state="unknown"
if npm_answer="$(npm view "${pkg_name}@${RELEASE_VERSION}" version --fetch-retries=0 --fetch-timeout=8000 2>"$npm_error")"; then
  if [[ "$npm_answer" == "$RELEASE_VERSION" ]]; then npm_state="present"; else npm_state="absent"; fi
elif grep -q "E404" "$npm_error"; then
  npm_state="absent"
fi
case "$npm_state" in
  present)
    if [[ "$resume" == "true" ]]; then
      echo "${pkg_name}@${RELEASE_VERSION} is on npm; the publish job verifies its source before resuming."
    elif [[ "$dry_run" == "true" ]]; then
      echo "::notice::${pkg_name}@${RELEASE_VERSION} already exists on npm; dry-run only"
    else
      fail "${pkg_name}@${RELEASE_VERSION} already exists on npm. Re-dispatch with resume-after-npm-publish: true if a previous run acknowledged it; otherwise choose the next unused version."
    fi
    ;;
  absent)
    [[ "$resume" != "true" ]] \
      || fail "resume-after-npm-publish is set, but ${pkg_name}@${RELEASE_VERSION} is not on npm"
    ;;
  *)
    echo "::warning::Could not read npm for ${pkg_name}@${RELEASE_VERSION}; the publish job checks again before publishing."
    ;;
esac

# Cross-channel ordering against the whole tag set: the gate run 35783865160 reached too late.
allow=""
if [[ ( "$dry_run" == "true" || "$resume" == "true" ) && -n "$existing_tag_sha" && "$existing_tag_sha" == "$GITHUB_SHA" ]]; then
  allow="--allow-existing-tag-at-head"
fi
if ! git tag --list 'v*' | bun "$repo_root/scripts/version-line.ts" assert-releasable "$RELEASE_VERSION" ${allow:+"$allow"}; then
  fail "${RELEASE_VERSION} does not outrank the current tag set"
fi

# dev must already carry a higher version (the pre-move).
if dev_package="$(git show refs/remotes/origin/dev:package.json 2>/dev/null)"; then
  dev_version="$(printf '%s' "$dev_package" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")"
  bun "$repo_root/scripts/version-line.ts" assert-ahead "$dev_version" "$RELEASE_VERSION" \
    || fail "dev carries ${dev_version}, which does not outrank ${RELEASE_VERSION}; merge the dev pre-move first"
else
  fail "cannot read package.json from refs/remotes/origin/dev"
fi

if (( problems > 0 )); then
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### Release preflight refused %s\n\n%s' "$RELEASE_VERSION" "$problem_list" >> "$GITHUB_STEP_SUMMARY"
  fi
  echo "Release preflight found ${problems} blocking problem(s); nothing was packaged."
  exit 1
fi
echo "Release preflight passed for ${RELEASE_VERSION} at ${GITHUB_SHA}; the publish job repeats these checks before publishing."
