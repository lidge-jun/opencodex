# 020 — wp2: land #3122 (canonical fake-IP addresses on provider PATCH)

PR #3122, author `Flowershangfromthebranches` (fork, `maintainerCanModify = true`),
branch `fix/openai-patch-fake-ip`, labels `bug` + `review-ready`. `+150 −1` across 2 files:
`src/server/management/provider-routes.ts` and `tests/management-provider-validation.test.ts`.

## The defect

Canonical OpenAI provider **creation** and **re-enable** already pass
`allowBenchmarkAddresses`, which permits the `198.18.0.0/15` range that Clash/Mihomo-style
fake-IP DNS returns. The ordinary field-mask **PATCH** path did not pass the same exception,
so a provider that was created successfully rejected a later context-window PATCH against
the identical address.

One call site, one flag, and the asymmetry is the whole bug. The test file is the larger half
of the diff.

## Why the matrix is red, and why it is not this change

`gh run view --job 99726180475 --log-failed` on head `f463e124`:

```
(fail) release version line > the in-tree version is never behind a released one [74.60ms]
1 tests failed:
```

That assertion compares the in-tree `package.json` version against the published release
line. The head's base predates `3e0f99a19` (#3127, "move dev to 2.40.0 after the v2.39.0
release"), so the in-tree 2.39.0 is exactly level with — and by the gate's reading, behind —
the released 2.39.0. It is unrelated to provider validation and disappears on rebase.

The branch is 3 commits behind `dev`, so this is a short rebase.

## Amended by audit round 1 (blocker 3): carry, do not force-push

`maintainerCanModify` is true, so a force-push is technically available. It is the wrong
move. `.github/workflows/enforce-pr-target.yml:740-746` applies the readiness checklist to
authors without push permission, and `Flowershangfromthebranches` has `read`. A maintainer
push re-drafts the PR and resets four boxes only the author can tick — the train would strand
the PR in draft, waiting on a contributor, having done the work.

So this lands the way this repository already lands contributor work (#3104 carries
#3039/#3067, #3109 carries #3063, #3111 carries #2989): **cherry-pick onto a maintainer
branch with authorship preserved.**

## Steps

1. `git checkout -b codex/3122-provider-patch-fake-ip origin/dev`.
2. `git cherry-pick -x f463e124` — `-x` records the source commit; the original
   `Author:` line is preserved by cherry-pick without further flags.
3. `git show --format='%an <%ae>' -s` to prove the authorship survived.
4. Push the maintainer branch and open a PR against `dev` that credits
   @Flowershangfromthebranches, links #3122, and fills the PR template.
5. Wait for the full matrix. `release version line` must pass — that assertion is the entire
   reason the original head is red, and a rebased base is the fix. If it still fails, stop:
   the diagnosis is wrong.
6. Merge, then close #3122 with a comment naming the merged commit.

## Accept criteria

- Carrier head's matrix fully green, including `macos` and all four `test` shards.
- `git log origin/dev` shows the commit authored by the original contributor.
- The diff at `dev` is still 2 files.
- #3122 closed with credit, not merged-and-forgotten.
