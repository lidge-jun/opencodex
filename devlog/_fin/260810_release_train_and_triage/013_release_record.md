# 013 — WP7: the release as executed

`010` is the runbook; this file is what actually happened. Where the two
disagree, this file is the record.

## Released artifacts

| Field | Value |
|-------|-------|
| RC | `9c051342d7ff7ad81b71911e359ad5935eaaf235` |
| preview version | `2.12.0-preview.20260810` |
| stable version | `2.12.0` |
| `preview` head after promotion | `f0306192e` (merge `eb96b3d42` + release bump) |
| `main` head after promotion | `6d881db20` (merge `1ed62f819` + release bump) |

```
$ npm view @bitkyc08/opencodex dist-tags --json
{ "latest": "2.12.0", "preview": "2.12.0-preview.20260810" }

$ gh release view v2.12.0                    -> isDraft=false, isPrerelease=false
$ gh release view v2.12.0-preview.20260810   -> isDraft=false, isPrerelease=true

$ git merge-base --is-ancestor 9c051342d origin/preview   # exit 0
$ git merge-base --is-ancestor 9c051342d origin/main      # exit 0
```

Sibling containment holds in both directions from the RC, and `preview ⊆ main`
is deliberately not asserted — see `010` §"Promotion model".

## Gates on the RC

| Gate | Result |
|------|--------|
| Exact-SHA Cross-platform CI on `9c051342d` | success (run 31386116765, after one rerun) |
| `bun run typecheck` | exit 0 |
| `bun run test` | 10,679 pass / 7 skip / 0 fail (663 files) |
| `bun run privacy:scan` | passed |
| pre-push isolated suite | 10,686 tests, 0 fail |
| Security review | `READY TO SHIP` (see `012`) |

## Two red gates, both infrastructure

The flake budget in `010` allows one `gh run rerun --failed` per gate. Both
were spent, and both failures were diagnosed before the rerun rather than
retried blindly.

**RC gate — run 31386116765.** One macOS test failed:

```
(fail) native profile OpenCodex process-exit phases > hard OpenCodex process
       exit after each published transaction phase converges exact auth, vault,
       journal, gate, and runtime bearer
error: Was there a typo in the url or port?
  path: "http://127.0.0.1:0/v1/responses",  code: "FailedToOpenSocket"
```

Port `0` means the harness read the child's port before it was published — a
startup race in the test, not in the product. The same test passed locally in
the same suite run, and the three sibling cases in the same file passed on the
same runner. Rerun: green.

**Stable gate — run 31390767959.** Every test job passed, including macOS.
The aggregate was `cancelled` because the `storage policy` job's
`bun install --frozen-lockfile` produced no output for five minutes and was
killed:

```
2026-08-10T13:01:35Z bun install v1.3.14 (0d9b296a)
2026-08-10T13:06:40Z ##[error]The operation was canceled.
```

A dependency install that never starts resolving is a runner/registry stall.
Rerun: green.

Neither failure touched the release delta, and neither is #1302.

## Recovery path taken for the stable publish

`release.ts:217-228` exits the moment it sees a completed failed run — after
the version bump is already committed and pushed. That happened here, exactly
as `010` §"Recovery when a gate goes red" predicted, so the documented
continuation was used rather than re-running the helper:

```bash
gh run rerun 31390767959 --failed          # -> success
gh run list --commit 6d881db20…            # Cross-platform CI + Service lifecycle both success
git ls-remote origin refs/heads/main       # still 6d881db20…, unmoved
gh workflow run release.yml --ref main \
  -f version=2.12.0 -f tag=latest \
  -f expected-sha=6d881db206c6a74da6b64fa22b6980faf05d0122 -f dry-run=false
gh run watch 31391815425 --exit-status     # -> success
```

The preview publish needed no recovery: run 31389633331 succeeded on the
helper's own dispatch.

## One surprise worth recording

The stable release worktree was created fresh, so it had no `node_modules`.
`release.ts` runs its dependency audit before typecheck, and the audit passes
in an empty tree while typecheck then dies on `Cannot find type definition file
for 'bun-types'`. The fix is `bun install` in both the root and `gui/` before
invoking the helper. Worth folding into the next train's runbook: a clean
worktree is a *dependency-less* worktree, and the helper's preflight ordering
does not catch that early.

## Release-notes annotation

The publish workflow noted that the preview tag is not an ancestor of the
stable commit and kept `v2.11.1` as the notes baseline. That is the sibling
promotion model working as designed, not a defect: the two release commits are
siblings by construction. The workflow carried the preview notes forward into
`v2.12.0` on its own.
