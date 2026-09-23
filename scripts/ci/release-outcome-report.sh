#!/usr/bin/env bash
# Report what a release run established, one fact per row.
#
# npm publication, the registry read-back, the dist-tag and the public GitHub release are four
# separate facts, and a green run used to read the same whichever of them were true: the registry
# smoke warns "Registry lookup not confirmed" and the run still continues to the GitHub release.
# This writes each outcome as its own row of the job summary and adds a warning annotation for
# every row that is not confirmed. It never changes the run's result; publishing behaviour is
# owned by the publish and attach steps.
#
# Environment: RELEASE_VERSION, NPM_DIST_TAG, GITHUB_STEP_SUMMARY (required);
# NPM_VERSION_STATE and NPM_DIST_TAG_STATE from the publish job (confirmed | mismatch |
# unconfirmed; empty when the smoke never ran); PUBLISH_RESULT and ATTACH_RESULT (job results).
#
# The GitHub row reads the release with a contents: read token. A draft release is not visible to
# that token, so anything but a published release reads as not public.
set -uo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${NPM_DIST_TAG:?NPM_DIST_TAG is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
release_tag="v${RELEASE_VERSION}"

github_state="not public (draft, missing or unreadable)"
if draft="$(gh release view "$release_tag" --json isDraft --jq .isDraft 2>/dev/null)"; then
  case "$draft" in
    false) github_state="published" ;;
    true) github_state="draft (not public)" ;;
  esac
fi

describe() {
  case "$1" in
    confirmed) echo "confirmed" ;;
    mismatch) echo "points at another version" ;;
    *) echo "not confirmed" ;;
  esac
}
npm_version_state="$(describe "${NPM_VERSION_STATE:-}")"
npm_tag_state="$(describe "${NPM_DIST_TAG_STATE:-}")"

{
  echo "### Release outcomes for ${RELEASE_VERSION}"
  echo ""
  echo "| Outcome | State |"
  echo "| --- | --- |"
  echo "| GitHub release \`${release_tag}\` | ${github_state} |"
  echo "| npm version \`${RELEASE_VERSION}\` read back from the registry | ${npm_version_state} |"
  echo "| npm dist-tag \`${NPM_DIST_TAG}\` points at \`${RELEASE_VERSION}\` | ${npm_tag_state} |"
  echo ""
  echo "Publish job: ${PUBLISH_RESULT:-unknown}. Attach job: ${ATTACH_RESULT:-unknown}."
  echo ""
  echo "Each row is read separately. A row that is not confirmed is not a failure of this run; inspect it before announcing availability, and never republish the version."
} >> "$GITHUB_STEP_SUMMARY"

[[ "$github_state" == "published" ]] \
  || echo "::warning::GitHub release ${release_tag} is ${github_state}"
[[ "$npm_version_state" == "confirmed" ]] \
  || echo "::warning::npm version ${RELEASE_VERSION} was not read back from the registry"
[[ "$npm_tag_state" == "confirmed" ]] \
  || echo "::warning::npm dist-tag ${NPM_DIST_TAG} ${npm_tag_state} for ${RELEASE_VERSION}"
exit 0
