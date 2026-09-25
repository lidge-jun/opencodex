# 010 — Release preflight before packaging (wp1)

## Change map

| Path | Action |
| --- | --- |
| `scripts/ci/release-preflight.sh` | NEW — every precondition decidable at dispatch |
| `.github/workflows/release.yml` | MODIFY — new `preflight` job; both packaging jobs need it |
| `tests/ci-workflows/release-preflight.test.ts` | NEW — structure + execution contract |
| `tests/ci-workflows/release-pipeline-contract.test.ts` | unchanged (`verify-release`/`publish`/`attach-release` needs are unchanged) |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | MODIFY — register the new test |
| `structure/ops/cross-platform-ci.md`, `structure/ops/docs-and-release.md` | MODIFY — describe the order (see 050 for the text owner) |

## Job order after the change

```
validate-dispatch -> preflight -> package-standalone ┐
                               -> package-desktop    ┴-> verify-release -> publish -> attach-release
```

`publish` keeps every existing step, in order, including "Preflight release metadata" and
"Refuse a release the current tag set already outranks". Those are the final check; the new job
never replaces them. New step names are distinct from the publish-job names because
`tests/ci-workflows/ci-workflows.test.ts` locates those by first occurrence.

## release.yml diff

```diff
+  # Every publication precondition the dispatch can already decide, checked before any runner
+  # starts packaging. <incident + coordination comment, see script header>
+  preflight:
+    name: release preflight
+    needs: validate-dispatch
+    runs-on: ubuntu-latest
+    timeout-minutes: 5
+    permissions:
+      contents: read
+    steps:
+      - name: Checkout
+        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
+        with:
+          persist-credentials: false
+          fetch-tags: true
+      - name: Setup project Bun
+        uses: ./.github/actions/setup-project-bun
+      - name: Fetch the dev line
+        run: git fetch --no-tags --depth=1 origin +refs/heads/dev:refs/remotes/origin/dev
+      - name: Refuse a release that cannot publish
+        env:
+          GH_TOKEN: ${{ github.token }}
+          RELEASE_VERSION: ${{ inputs.version }}
+          NPM_DIST_TAG: ${{ inputs.tag }}
+          DRY_RUN: ${{ inputs.dry-run }}
+          RESUME: ${{ inputs.resume-after-npm-publish }}
+        run: bash scripts/ci/release-preflight.sh
   package-standalone:
-    needs: validate-dispatch
+    needs: [validate-dispatch, preflight]
   package-desktop:
-    needs: validate-dispatch
+    needs: [validate-dispatch, preflight]
```

Inputs reach shell only through `env` (repository rule enforced by `ci-workflows.test.ts`).
`GH_TOKEN` is the job token with `contents: read`; nothing prints it. `npm view` needs no
credential. No new action is introduced.

## Coordination decision

Kept: the workflow-level `concurrency: { group: release, cancel-in-progress: false }`. It is a
constant string, so every dispatch on every ref shares one slot, and run 35783865160 shows it
worked. A new version reservation would add a write surface for no gain. The residual known
limitation is GitHub's single pending slot per group: a third dispatch replaces a pending one.
That is unchanged and is stated in the structure doc. The test pins the group as a constant with
`cancel-in-progress: false`, because a per-ref group is the one edit that would let a stable and a
preview run overlap.

## Enforcement record (PLAN-BYPASS-NAMED-01)

| Field | Value |
| --- | --- |
| Tier | CI job gate (early warning) |
| Executing surface | `preflight` job in `release.yml` |
| Known bypass | State change after the preflight (manual tag, first local publish); npm/GitHub read failure is treated as absent/unknown |
| Residual risk | Covered by the unchanged publish-job checks, which remain the final layer |
| Wording | "preflight", not "enforcement"; the final layer is the publish job |

## scripts/ci/release-preflight.sh (full text)

```bash
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
npm_error="$(mktemp)"
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
```

## Tests (`tests/ci-workflows/release-preflight.test.ts`)

Structure (fail on the old shape):

1. `jobs.preflight` exists, `needs: validate-dispatch`, `permissions == { contents: read }`, runs
   `bash scripts/ci/release-preflight.sh` with inputs passed through `env`.
2. `package-standalone` and `package-desktop` both list `preflight` in `needs`.
3. `publish` still contains "Refuse a release the current tag set already outranks" running
   `assert-releasable` (the final check stays).
4. `concurrency.group` is a constant containing no `${{` and `cancel-in-progress` is false.

Execution (Linux/macOS; `bash`, real `bun scripts/version-line.ts`, fake `gh`/`npm` on PATH,
temporary git repository with tags and `refs/remotes/origin/dev`; `RELEASE_VERSION` is the
checkout's own `package.json` version so the real version-source check passes):

| Scenario | Expect |
| --- | --- |
| Incident replay: stable `X.Y.0` on main, tag `vX.(Y+1).0-preview.20260923` exists | exit 1, ordering error, nothing else blocking |
| Clean stable: lower tags only, dev ahead, npm E404, no GitHub release | exit 0 |
| npm already has the version, no resume, not dry-run | exit 1 naming npm |
| Same, dry-run | exit 0 with notice |
| dev not ahead | exit 1 naming the dev pre-move |
| Two problems at once (wrong dist-tag and npm present) | exit 1, both reported |

Activation: the incident replay is the conditional path; its observable effect is a non-zero exit
naming the blocking tag before any packaging job could start (the workflow `needs` edge).
