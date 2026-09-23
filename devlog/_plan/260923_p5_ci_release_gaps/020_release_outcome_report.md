# 020 — Separate release outcomes (wp2)

## Change map

| Path | Action |
| --- | --- |
| `.github/workflows/release.yml` | MODIFY — registry smoke records `npm_version` and `npm_dist_tag`; `publish` exposes them as job outputs; `attach-release` ends with an always-run report |
| `scripts/ci/release-outcome-report.sh` | NEW — writes one summary row per outcome |
| `tests/ci-workflows/release-outcome-report.test.ts` | NEW |
| layout files | MODIFY — register the test |

## Registry smoke diff (publish job, step `registry-smoke`)

Publishing behaviour is unchanged: the same six bounded version reads, the same single
`npm dist-tag ls`, the same continuation to the GitHub release when reads stay pending, the same
hard failure on an unexpected version. The existing executed test in
`tests/ci-workflows/ci-workflows.test.ts` pins every npm call shape; nothing here adds a call.

```diff
       - name: Post-publish registry smoke
         id: registry-smoke
         env:
           RELEASE_VERSION: ${{ inputs.version }}
+          NPM_DIST_TAG: ${{ inputs.tag }}
           PUBLISHED: ${{ steps.publication.outputs.published }}
 ...
               echo "verification=verified" >> "$GITHUB_OUTPUT"
+              echo "npm_version=confirmed" >> "$GITHUB_OUTPUT"
               echo "Registry verified ${pkg_name}@${RELEASE_VERSION}." >> "$GITHUB_STEP_SUMMARY"
-              timeout ... npm dist-tag ls "$pkg_name" ... || echo "::warning::Could not read npm dist-tags; exact version was verified"
+              dist_tag_state="unconfirmed"
+              if dist_tags="$(timeout ... npm dist-tag ls "$pkg_name" ...)"; then
+                printf '%s\n' "$dist_tags"
+                tagged="$(printf '%s\n' "$dist_tags" | awk -F': ' -v tag="$NPM_DIST_TAG" '$1 == tag { print $2; exit }')"
+                if [ "$tagged" = "$RELEASE_VERSION" ]; then dist_tag_state="confirmed"
+                elif [ -n "$tagged" ]; then dist_tag_state="mismatch"; echo "::warning::npm dist-tag ... points at ${tagged}"
+                else echo "::warning::npm dist-tag ${NPM_DIST_TAG} is not listed"; fi
+              else
+                echo "::warning::Could not read npm dist-tags; exact version was verified"
+              fi
+              echo "npm_dist_tag=${dist_tag_state}" >> "$GITHUB_OUTPUT"
+              echo "npm dist-tag ${NPM_DIST_TAG}: ${dist_tag_state}." >> "$GITHUB_STEP_SUMMARY"
               exit 0
 ...
           echo "verification=pending" >> "$GITHUB_OUTPUT"
+          echo "npm_version=unconfirmed" >> "$GITHUB_OUTPUT"
+          echo "npm_dist_tag=unconfirmed" >> "$GITHUB_OUTPUT"
```

```diff
   publish:
     needs: [validate-dispatch, verify-release]
+    outputs:
+      npm_version: ${{ steps.registry-smoke.outputs.npm_version }}
+      npm_dist_tag: ${{ steps.registry-smoke.outputs.npm_dist_tag }}
```

```diff
   attach-release:  (last step)
+      - name: Report release outcomes
+        if: always()
+        env:
+          GH_TOKEN: ${{ github.token }}
+          RELEASE_VERSION: ${{ inputs.version }}
+          NPM_DIST_TAG: ${{ inputs.tag }}
+          NPM_VERSION_STATE: ${{ needs.publish.outputs.npm_version }}
+          NPM_DIST_TAG_STATE: ${{ needs.publish.outputs.npm_dist_tag }}
+        run: bash scripts/ci/release-outcome-report.sh
```

`attach-release` already holds `contents: write` for the upload; the report only reads
(`gh release view`). Job permissions are unchanged. The step runs after "Attach to the release",
so the GitHub row reflects the draft flip, and `always()` keeps the row visible when the attach
step failed. The resume path (`published=true` without a new publish) reaches the same smoke and
report.

## scripts/ci/release-outcome-report.sh (full text)

```bash
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
# unconfirmed; empty when the smoke never ran).
set -uo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${NPM_DIST_TAG:?NPM_DIST_TAG is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
release_tag="v${RELEASE_VERSION}"

github_state="not found"
if draft="$(gh release view "$release_tag" --json isDraft --jq .isDraft 2>/dev/null)"; then
  case "$draft" in
    false) github_state="published" ;;
    true) github_state="draft (not public)" ;;
    *) github_state="unreadable" ;;
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
  echo "Each row is read separately. A row that is not confirmed is not a failure of this run; inspect it before announcing availability, and never republish the version."
} >> "$GITHUB_STEP_SUMMARY"

[[ "$github_state" == "published" ]] \
  || echo "::warning::GitHub release ${release_tag} is ${github_state}"
[[ "$npm_version_state" == "confirmed" ]] \
  || echo "::warning::npm version ${RELEASE_VERSION} was not read back from the registry"
[[ "$npm_tag_state" == "confirmed" ]] \
  || echo "::warning::npm dist-tag ${NPM_DIST_TAG} ${npm_tag_state} for ${RELEASE_VERSION}"
exit 0
```

## Tests (`tests/ci-workflows/release-outcome-report.test.ts`)

Structure (fail on the old shape): the smoke step writes `npm_version=` and `npm_dist_tag=`;
`publish.outputs` maps both from `steps.registry-smoke.outputs`; the last `attach-release` step
has `if: always()`, reads both job outputs through `env`, and runs the report script.

Execution, smoke (fake `npm`/`timeout` shell functions as in the existing executed test):

| npm dist-tag ls output | `npm_dist_tag` |
| --- | --- |
| `latest: 9.8.7` | confirmed |
| `latest: 9.8.6` | mismatch + warning |
| read fails | unconfirmed + warning |
| version reads stay pending | `npm_version=unconfirmed`, `npm_dist_tag=unconfirmed` |

Execution, report (fake `gh` on PATH):

| gh answer | NPM states | Summary rows |
| --- | --- | --- |
| `false` | confirmed / confirmed | published / confirmed / confirmed; no warning |
| `true` | confirmed / mismatch | draft / confirmed / points at another version; two warnings |
| exit 1 | empty / empty | not found / not confirmed / not confirmed; exit 0 |
