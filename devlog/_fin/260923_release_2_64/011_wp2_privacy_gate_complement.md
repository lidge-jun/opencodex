# 011 — wp2: privacy scan on every pull request that `gates` skips

## Problem

`privacy:scan` runs in two jobs of `.github/workflows/ci.yml`. `gates` runs it on every event
it runs for, and `gates` is skipped on a pull request whose paths miss the `ci` filter.
`privacy-gate` covers that gap only when the `privacy` filter matches, and that filter lists
`devlog/**` and `ci.yml` alone. A pull request touching only paths outside both filters
(for example `docs-site/**`, `structure/**`, `native/**`, `.github/actions/**`,
`.github/release.yml`, `.github/CODEOWNERS`, the pull request template, or root markdown
other than `README.md`) therefore runs no scan, and the `ci` aggregate still concludes
success.

The gap predates #5469, which closed it for `devlog/**` only. It does not reach an npm or
GitHub release: `release.yml` requires a push-event `ci.yml` success on the exact release
SHA, where `gates` scans the whole tree. It does reach GitHub Pages, because
`deploy-docs.yml` publishes `docs-site` on a `main` push without waiting for that scan.

## Change

Make `privacy-gate` the exact complement of `gates` on pull requests, so the scan's coverage
stops depending on an enumerated path list. The `privacy` filter then selects nothing and is
removed with its plumbing.

`.github/workflows/ci.yml`:

```diff
-            privacy:
-              - 'devlog/**'
-              - '.github/workflows/ci.yml'
```

(with the comment block above it, which describes the removed filter), the `privacy` output of
`changes`, the `PRIVACY_SCOPE` validation in the `scope` step, and the `CHANGES_PRIVACY` env
of the aggregate.

```diff
   privacy-gate:
     name: privacy gate
     needs: changes
-    if: github.event_name == 'pull_request' && needs.changes.outputs.ci != 'true' && needs.changes.outputs.privacy == 'true'
+    if: github.event_name == 'pull_request' && needs.changes.outputs.ci != 'true'
```

```diff
-          privacy=not-requested
-          if [ "$scoped" = not-requested ] && [ "$CHANGES_PRIVACY" = "true" ]; then
-            privacy=requested
-          fi
+          privacy=not-requested
+          if [ "$scoped" = not-requested ]; then
+            privacy=requested
+          fi
```

The aggregate already sets `scoped=not-requested` exactly when the event is `pull_request`
and `CHANGES_CI` is not `true`, which is the job's new condition, so both sides keep deriving
the same expectation. Comments above `privacy-gate` and the aggregate derivation are reworded
to state the complement rule.

Tests (`tests/ci-workflows/`):

- `ci-privacy-gate.test.ts`: the event × `ci` matrix expects exactly one scanner for every
  combination: `gates` off pull requests or when `ci` is true, `privacy-gate` otherwise.
  The executed-aggregate cases cover a docs-only and a no-filter pull request requiring
  `privacy-gate` success, `skipped`/`failure`/`cancelled` failing by name, and a second
  scan still rejected when `ci` is true. The filter and malformed-output cases for the removed
  `privacy` output are replaced by an assertion that no job or step reads it.
- `ci-review-lanes.test.ts` and any other test that executes the aggregate: a pull request
  with `CHANGES_CI=false` now requires `privacy-gate`; fixtures are updated to include it,
  never by loosening the aggregate.

No file-size cap is raised; if a test file would exceed its cap, the new cases move to a
sibling registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`. `structure/ops/cross-platform-ci.md` is updated
where it describes the privacy gate.

## Acceptance

- The PR changes `ci.yml`, so its own pull-request run sets `ci` true and scans in `gates`,
  not in `privacy gate`. The complement is proven by the executed tests above, which run
  the checked-in `if:` expressions and aggregate shell.
- `gates`, `structure gate` (the PR edits `structure/ops/`), and the `ci-privacy-gate` and
  `ci-review-lanes` tests pass at the exact PR head; the `ci` aggregate succeeds.
- An independent reviewer confirms that no event loses a scan it had before.
