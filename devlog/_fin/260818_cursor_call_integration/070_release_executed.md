# 070 — The release that 060 prepared: v2.25.0 and v2.25.0-preview.20260818

060 ended with a promotion sequence "prepared and NOT executed". It has now been
executed. This document records what actually ran, and corrects the one thing 060
got wrong about how it could run.

## What 060 got wrong

060's promotion sequence was:

    git checkout preview && git merge --no-ff origin/dev
    git push origin preview

That push cannot succeed. Both integration branches carry a `pull_request` rule:

| Ruleset | Id | Rules |
|---------|-----|-------|
| Protect main | 20764415 | deletion, non_fast_forward, pull_request |
| Protect preview | 20764486 | deletion, non_fast_forward, pull_request |
| Protect release tags | 20769150 | deletion, non_fast_forward, update (refs/tags/v*) |

The bypass actor on both is `{actor_id: 5 (RepositoryRole), bypass_mode: "pull_request"}`,
and `gh api` reports `current_user_can_bypass: "pull_requests_only"` for the maintainer.
**Admin bypass exists, but only through a pull request** — a direct `git push` to
`main` or `preview` is refused regardless of permission.

The same constraint rules out running `scripts/release.ts` as written: its version-bump
push (`scripts/release.ts:390-395`) is a direct branch push. This is not a new discovery
so much as a rediscovery — every prior release used PRs for exactly this reason
(#1914 `release: v2.24.2` base=main head=release-2.24.2, #1910, #1986).

So the release ran as four pull requests plus two manual workflow dispatches, which is
what the repository's own history already showed was the working path.

## What ran

| Step | PR | Merge SHA |
|------|-----|-----------|
| Promote dev → preview | [#2000](https://github.com/lidge-jun/opencodex/pull/2000) | `70d7ba5ad2ca0b439df8d608cffcbf0ca76e3c0e` |
| Promote dev → main | [#2001](https://github.com/lidge-jun/opencodex/pull/2001) | `19986ca9c5490b00afbaaf95b98d72db6049c4e2` |
| Bump preview → 2.25.0-preview.20260818 | [#2002](https://github.com/lidge-jun/opencodex/pull/2002) | `11f6f4c98559d2f8bf1818e83dfbaecdc189702e` |
| Bump main → 2.25.0 | [#2003](https://github.com/lidge-jun/opencodex/pull/2003) | `e97fb262167b5eea4b84c67b2a1e4954d3929ee9` |

All four merged with `gh pr merge --admin --merge` — owner authority through the exact
bypass mode the ruleset permits.

RC: `314f3edbf30333b64e63ec96b4e7349d2c7d2406`, proven an ancestor of both release
branches with `git merge-base --is-ancestor` rather than assumed.

**The release SHA is the bump PR's merge commit, not the bump commit.** `release.yml`
validates `expected-sha == GITHUB_SHA` (`:87-97`) and a `workflow_dispatch` on
`--ref preview|main` resolves `GITHUB_SHA` to the branch tip. The version check at
`:125-143` then reads `package.json` from that same tree, so the merge commit is the
correct target and the bump commit would have been wrong.

## Gates at the release SHAs

| SHA | Cross-platform CI | Service lifecycle |
|-----|-------------------|-------------------|
| `11f6f4c98` (preview) | 32108062957 success | 32108063000 success |
| `e97fb2621` (main) | 32108072698 success | 32108072743 success |

Service lifecycle fired on both, which 060 predicted correctly: it never ran on `dev`
because the campaign touched none of its trigger paths, and the version bump puts
`package.json` into the diff.

Local gates against the RC tree, in a clean worktree pinned to `314f3edbf`:

    bun x tsc --noEmit          exit 0
    bun run privacy:scan        Privacy scan passed
    bun run audit:high          No vulnerabilities found (root and gui)
    bun test --isolate tests    12875 pass, 10 skip, 0 fail, 833 files, 475s

This closes the platform gap 060 flagged: it noted Windows and macOS were unverified for
this diff and that Linux-only evidence was the whole of the platform argument. The two
release SHAs each carry a full multi-OS CI run, so that gap is now closed by CI rather
than by argument.

## Publication

| Run | Result |
|-----|--------|
| Release (preview) 32110365931 | success — validate-dispatch, publish |
| Release (main) 32110525253 | success — validate-dispatch, publish |

Verified afterwards, not assumed:

    npm dist-tags   { latest: '2.25.0', preview: '2.25.0-preview.20260818' }
    v2.25.0^{}                    = e97fb262167b5eea4b84c67b2a1e4954d3929ee9 = origin/main
    v2.25.0-preview.20260818^{}   = 11f6f4c98559d2f8bf1818e83dfbaecdc189702e = origin/preview
    npm pack @bitkyc08/opencodex@2.25.0 → package.json version 2.25.0

## Why a minor

060 recommended 2.25.0 over 2.24.3 and that recommendation was taken. The externally
observable behaviour of a failed turn changed: a turn that previously returned
`completed` with a vanished tool call now returns `failed` with a truncation error, an
unrequested CANCEL is a typed transport failure instead of a silent return, and a
truncated compaction turn no longer installs half-written replacement history.

## Still open

060's follow-up list is unchanged by this release — shipping the code did not close any
of it. Cursor tool-result images still do not reach production because every Cursor model
sits in `noVisionModels`; Kiro's `completionMode: "disabled"` still drops stop reasons;
Google ordinary mode still forwards only a subset; user-message images are still
flattened; phase 030 was never reproduced. Each remains a candidate for its own unit.

