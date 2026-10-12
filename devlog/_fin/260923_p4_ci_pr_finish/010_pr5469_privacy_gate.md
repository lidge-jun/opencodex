# 010 — #5469: privacy scan on devlog-only changes

## Acceptance

- (a) A devlog-only pull request runs `privacy:scan`, through `privacy-gate` alone.
- (b) No event runs the scan twice: `gates` and `privacy-gate` are never both selected.
- (c) The aggregate `ci` cannot conclude success on a devlog change whose privacy gate did
  not run, including when the `privacy` filter output is missing or malformed.

## Findings against the branch head

1. `privacy-gate` stands down only on `ci == 'true'`, but `gates` also runs on every
   non-pull-request event. Today every push that starts this workflow and every dispatch
   reads `ci=true`, so no double run is reachable yet; making the job the exact complement of
   `gates` keeps that true if a trigger or the push `paths` list changes.
2. `privacy` is consumed straight from the filter. A missing value reads as "not changed",
   skips the job and leaves the aggregate green. `dev` already re-emits `ci` through a
   validating step for this reason; `privacy` needs the same.
3. `ci-review-lanes.test.ts` executes the real aggregate step under `set -u` with every
   `needs` job successful and no `CHANGES_PRIVACY`; it would abort on the unbound variable.
4. `ci-privacy-gate.test.ts` is not registered in the two test-layout files.
5. Extending the pinned `GATED_JOBS` line forces an edit to `ci-structure-gate.test.ts`; a
   separate line for `privacy-gate` keeps that sibling test untouched.

## Changes

MODIFY `.github/workflows/ci.yml`

```diff
 outputs:
-  privacy: ${{ steps.filter.outputs.privacy }}
+  privacy: ${{ steps.scope.outputs.privacy }}
 ...
   - name: Assert the scope output is usable
     env:
       CI_SCOPE: ${{ steps.filter.outputs.ci }}
+      PRIVACY_SCOPE: ${{ steps.filter.outputs.privacy }}
     run: |
       ...existing ci case unchanged...
+      case "$PRIVACY_SCOPE" in
+        true|false) printf 'privacy=%s\n' "$PRIVACY_SCOPE" >> "$GITHUB_OUTPUT" ;;
+        *) printf '::error::changes.outputs.privacy was %q, expected true or false\n' "$PRIVACY_SCOPE"; exit 1 ;;
+      esac
 ...
 privacy-gate:
-  if: needs.changes.outputs.privacy == 'true' && needs.changes.outputs.ci != 'true'
+  if: github.event_name == 'pull_request' && needs.changes.outputs.ci != 'true' && needs.changes.outputs.privacy == 'true'
 ...
-if [ "$CHANGES_PRIVACY" = "true" ] && [ "$CHANGES_CI" != "true" ]; then
+if [ "$scoped" = not-requested ] && [ "$CHANGES_PRIVACY" = "true" ]; then
   privacy=requested
 fi
 ...
-GATED_JOBS="$GATED_JOBS structure-gate privacy-gate widget"
+GATED_JOBS="$GATED_JOBS structure-gate widget"
+GATED_JOBS="$GATED_JOBS privacy-gate"
```

The conflict with `dev` is resolved by keeping every `dev` change (native outputs and
matrices, `CHANGES_NATIVE`, the native `expected_for` arm) and re-applying the lines above.

MODIFY `tests/ci-workflows/ci-structure-gate.test.ts`: take `dev`'s version unchanged.

MODIFY `tests/ci-workflows/ci-review-lanes.test.ts`: in the executed release-gates case, add
`results["privacy-gate"] = { result: "skipped" }` and `CHANGES_PRIVACY: "false"`. The job is
a producer the dispatch did not request, exactly like `structure-gate`.

MODIFY `tests/ci-workflows/ci-privacy-gate.test.ts`

- Evaluate the checked-in `if:` of `gates` and `privacy-gate` over every
  event, `ci` and `privacy` combination: at most one selected, exactly one when
  `privacy` is true, and `privacy-gate` alone for a devlog-only pull request.
- Execute the scope step: a `PRIVACY_SCOPE` of `""` or `maybe` exits 1; `true` writes
  `privacy=true`.
- Execute the aggregate step for a devlog-only pull request: `privacy-gate` success passes,
  `privacy-gate` skipped fails naming the job. For a `ci.yml` pull request, `privacy-gate`
  reporting success fails the aggregate as a run it did not request.
- Replace the verbatim `GATED_JOBS` and aggregate-condition string pins with those executions.

MODIFY `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`: add
`"ci-privacy-gate.test.ts": "ci-workflows"` in sorted position.

## Out of scope

The `maintainer-sponsored` label: it attests a maintainer security review and is left for a
maintainer. The `push` trigger's `paths` stay equal to the `ci` filter.

`docs`, `structure`, `gui` and `packaging` are also consumed unvalidated from the filter.
Closing that class belongs in its own change; it would alter pins in `ci-structure-gate.test.ts`
and widen this pull request beyond the privacy gate.

## Outcome

Delivered on the contributor branch as the merge commit `3f4d7ad4fe` (dev `0f9254b564` merged).
Cross-platform CI run 35819557849 at that head concluded success on every job, with
`privacy gate` skipped as expected: this pull request edits `ci.yml`, so `ci` is true and
`gates` ran the scan. The new executed cases passed on Linux and macOS:

- `runs at most once for every event and scope, and exactly once for a devlog change` (b, a)
- `is green on a devlog-only pull request only when the privacy gate ran` (a, c)
- `a missing or malformed privacy output fails the changes job` (c)
- `rejects a second scan on a pull request that gates already scans` (b)

One more defect surfaced while merging: the branch's test pinned `ci.yml` as a literal entry of
the `ci` filter, which on `dev` lists `.github/workflows/**` instead. The condition matrix
replaced it.

Left for a maintainer: the `maintainer-sponsored` label (`hygiene`, `enforce-target`), and the
author's re-attestation of the readiness checklist, which `enforce-target` now requires because
the body still carries the previous first item.
