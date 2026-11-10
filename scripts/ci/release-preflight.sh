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
# Environment: RELEASE_VERSION, NPM_DIST_TAG, GITHUB_REF, GITHUB_SHA, SOURCE_SHA (required); DRY_RUN, RESUME.
# Reads the checkout's tags, `gh release view`, and `npm view`.
# Every problem is reported before the script exits, so one run names all of them.
set -euo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${NPM_DIST_TAG:?NPM_DIST_TAG is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"
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

# The workflow revision and candidate source are distinct identities.
[[ "$GITHUB_REF" == "refs/heads/dev" ]] || fail "Release must run from dev; got ${GITHUB_REF}"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "workflow SHA must be a full 40-character commit SHA"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "source SHA must be a full 40-character commit SHA"
case "$NPM_DIST_TAG" in
  latest) [[ "$RELEASE_VERSION" != *-* ]] || fail "version does not match npm dist-tag 'latest'" ;;
  preview) [[ "$RELEASE_VERSION" == *-preview.* ]] || fail "version does not match npm dist-tag 'preview'" ;;
  *) fail "invalid npm dist-tag '${NPM_DIST_TAG}'" ;;
esac

if [[ "$resume" == "true" && "$dry_run" == "true" ]]; then
  fail "resume-after-npm-publish is a real-publication recovery path and cannot combine with dry-run"
fi

# Every version source (package.json and the desktop manifests) must already name the release.
if ! bun "$repo_root/scripts/release-version-sources.ts" check "$RELEASE_VERSION"; then
  fail "a version source does not match ${RELEASE_VERSION}; stamp and verify all version sources before preflight"
fi

# Git tag. A tag at another commit is always fatal; one at this commit is expected only when a
# dry run is repeated or a partial publication is resumed.
existing_tag_sha="$(git rev-parse -q --verify "refs/tags/${release_tag}^{commit}" || true)"
if [[ -n "$existing_tag_sha" && "$existing_tag_sha" != "$SOURCE_SHA" ]]; then
  fail "${release_tag} already points at ${existing_tag_sha}, not ${SOURCE_SHA}"
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
  if [[ "$npm_answer" == "$RELEASE_VERSION" ]]; then npm_state="present"; fi
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
    fail "Could not establish npm state for ${pkg_name}@${RELEASE_VERSION}; refusing an unverifiable release"
    ;;
esac

# Cross-channel ordering against the whole tag set: the gate run 35783865160 reached too late.
allow=""
if [[ ( "$dry_run" == "true" || "$resume" == "true" ) && -n "$existing_tag_sha" && "$existing_tag_sha" == "$SOURCE_SHA" ]]; then
  allow="--allow-existing-tag-at-head"
fi
if ! git tag --list 'v*' | bun "$repo_root/scripts/version-line.ts" assert-releasable "$RELEASE_VERSION" ${allow:+"$allow"}; then
  fail "${RELEASE_VERSION} does not outrank the current tag set"
fi

if (( problems > 0 )); then
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### Release preflight refused %s\n\n%s' "$RELEASE_VERSION" "$problem_list" >> "$GITHUB_STEP_SUMMARY"
  fi
  echo "Release preflight found ${problems} blocking problem(s); nothing was packaged."
  exit 1
fi
echo "Release preflight passed for ${RELEASE_VERSION} at ${SOURCE_SHA}; the publish job repeats these checks before publishing."
