# 040 — Delivery record

Work-phase `wp4`. All three PRs merged to `dev` with admin authority.

| PR | merge SHA | what |
|---|---|---|
| [#3491](https://github.com/lidge-jun/opencodex/pull/3491) | `85e42117c` | #3483 empty red notice (CSS cascade) |
| [#3496](https://github.com/lidge-jun/opencodex/pull/3496) | `3e65218ba` | never prompt a local dashboard |
| [#3493](https://github.com/lidge-jun/opencodex/pull/3493) | `8b961b198` | #3353 dialog guidance + docs anchor |

Ancestry proven for each: `git fetch origin dev` then
`git merge-base --is-ancestor <sha> FETCH_HEAD` exit 0.

Issues #3483 and #3353 closed with landing comments.

## The stack-parent close race

#3492 was the original middle PR. Merging #3491 with `--delete-branch` removed
`codex/admin-token-empty-notice`, which was #3492's base, and GitHub auto-closed
it. A closed PR cannot be retargeted, and it could not be reopened because its
base branch no longer existed. #3496 carries the identical commits rebased onto
`dev`; #3492 records the supersession.

**For the next stack: retarget children to `dev` BEFORE merging the parent, or
merge without `--delete-branch` and delete the branch afterwards.** The order
that looks natural — merge, then restack — is the one that loses the PR.

## Trailing CI, classified

Two failures on green-otherwise heads, both proven flakes rather than assumed:

- `test 3/4` on `6da1269f8`: `tests/responses-state.test.ts:1464` through
  `fallbackPendingResponseSpills` (`src/responses/state.ts:714`), which is the
  `remaining <= 0` deadline-budget branch in a 2 MB shutdown-spill test — a
  loaded-runner timeout. The diff touches no `responses/` file; the file passes
  141/141 locally twice; it passed on rerun.
- `macos` on `87abc9152`: `tests/shutdown-launcher.test.ts:147`. That PR changes
  only GUI copy, i18n, and docs — no runtime code at all. Passes 3/3 locally;
  passed on rerun.

Both were rerun to green rather than merged over.

## Verification actually run

No repository-wide local suite (prohibited for this task). Instead:

- `bun run typecheck` — clean
- `cd gui && bun test` — 1366 pass / 0 fail across 220 files
- `bun test tests/gui-static.test.ts tests/server-management-auth.test.ts tests/server-auth.test.ts` — 143 pass / 0 fail
- `bun run lint:gui`, `bun run privacy:scan` — clean
- exact-head CI green on `d9a1afc71`, `6da1269f8`, `87abc9152` before each merge

The full GUI suite earned its place: it caught 7 tests in `api-auth-memory`
that assumed the prompt always fires, which the focused files did not cover.

## One correction worth recording

The first implementation gated the prompt on `runtimeRole === "hub"`. A review
lane checking "would this lock anyone out?" found that it would: `standalone` +
`hostname: "0.0.0.0"` is an operator who deliberately exposed the dashboard and
must type the token, and `tests/server-management-auth.test.ts` already proves
that bind mints no session. The role is topology; the question is the bind. The
shipped predicate is `isApiAuthRequired`, the same one the server gates the mint
with, and a regression now covers the exposed-standalone case explicitly.
