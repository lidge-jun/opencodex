# wp3 — Promote `dev` onto `main`

## Preconditions

wp2 closed: `origin/preview` is at the preview promotion SHA with green push CI and
green Service lifecycle. wp1 produced no surviving blocker.

`preview` being green is not a precondition `release.yml` enforces for the stable
publish — the two channels gate independently, and v2.38.0 shipped stable while its
preview was red. We sequence preview first anyway: it is the cheaper place to discover
that a promotion merge breaks something.

## Version

`main` requires stable semver and dist-tag `latest`. `dev` already carries `2.39.0`,
so the merge should be clean with no version conflict — the same shape as v2.38.0, whose
promotion PR recorded "the tree is byte-identical to `dev`".

## Steps

1. Branch `codex/promote-main-2390` from `origin/main`.
2. Merge `origin/dev`. Expect no conflict. Verify `git diff origin/dev HEAD` is empty —
   the promoted tree should be byte-identical to `dev`.
3. Push and open the PR against `main`, with a description that names what ships: the
   43-commit delta, the bug fixes, and any residual the audit recorded rather than hid.
4. `enforce-target` fails and drafts the PR, as on every promotion. `gh pr ready`, then
   admin merge.
5. Wait for push-event Cross-platform CI and Service lifecycle on the merge commit.

## Evidence to capture

- merge SHA, `git ls-remote origin refs/heads/main`
- `gh api actions/runs?head_sha=<sha>` with both workflows `success`
- the empty-diff proof from step 2

## Stop conditions

A failing job on the promotion commit that is not the documented macOS launcher flake
stops the train here. `main` is the release branch; a red `main` is worse than a late
release, and `release.yml` would refuse the dispatch regardless.

## Executed

PR #3125, merged at `af6113a0381d6fff2e4dce587652825c7eeb6423`. The merge was clean
with no version conflict and `git diff origin/dev HEAD` was empty — the promoted tree
is byte-identical to `dev`, as predicted.

Push-event Cross-platform CI: run `33463473330`, success on rerun. Service lifecycle:
success. The first attempt failed on the Linux `test 3/4` shard, same
`tests/server-auth.test.ts:2288` assertion the preview run hit on macOS — which is how
we learned the flake is cross-platform rather than macOS-specific. The PR run for the
identical tree had already passed `macos` and every shard, which is the contrast that
made the flake diagnosis defensible rather than convenient.
