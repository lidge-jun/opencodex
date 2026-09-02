# 040 — wp4: delivery

## Branch and commits

This worktree starts detached at `529639a57`. Adopt in place (WORKTREE-GUARD-01):

```bash
git switch -c codex/gemini-3.8-flash-rollout
```

One commit per work-phase (DEV-GIT-COMMIT-01): the docs unit, then wp1, wp2, wp3.

## The push constraint, stated exactly

The user said `로컬스위트는 절대 돌리지 말고 no verify로 푸시하고`. The repository's pre-push
hook runs the full suite, which is precisely what is forbidden, so:

```bash
git push --no-verify -u origin codex/gemini-3.8-flash-rollout
```

`--no-verify` bypasses the LOCAL hook only. It does not and cannot bypass branch protection:
`dev`, `main` and `preview` carry rulesets requiring a reviewed PR, so a direct push to `dev`
is rejected regardless. This is a feature branch push, which is allowed.

## Pull request

Target `dev` (never `main`). Fill all three template sections from
`.github/PULL_REQUEST_TEMPLATE.md`: Summary, Verification, Checklist. No GUI change, so no
screenshot is required — but the description must not mention `gui`, or `enforce-target` will
demand one.

The Verification section lists the focused commands actually run and states plainly that the
repository-wide suite was not run locally by the maintainer's instruction, with CI as the gate.

## CI evidence standard

`gh pr checks --required` returning empty is NOT green evidence. Read the full current rollup
for the exact head SHA:

```bash
HEAD_SHA=$(git rev-parse HEAD)
gh pr checks --watch
gh api repos/:owner/:repo/commits/$HEAD_SHA/check-runs --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion)"'
```

A rollup for a stale SHA proves nothing about the head being merged.

## Merge and landing proof

The user pre-authorized the merge (`ci 보고 바로 머지해놔`), scoped to this PR after CI is read.
Squash-merge, then prove the merge actually landed rather than trusting the API response:

```bash
git fetch origin dev
git merge-base --is-ancestor <merge-sha> FETCH_HEAD && echo LANDED
```

## Post-merge runtime check (optional but cheap)

The user's proxy runs from a source checkout on port 10100. After the merge, that checkout can
be refreshed and `ocx models live --provider google-antigravity --json` should show one
`gemini-3.8-flash` row with `reasoningEfforts: ["low","medium","high"]` instead of today's three
effortless rows. Do NOT restart the user's service without asking; report the command instead.

## Terminal outcomes for this phase

- `DONE` — merged with ancestry proof.
- `BLOCKED` — CI red for a cause outside this change, or protection refuses the merge.
- `NEEDS_HUMAN` — a reviewer raises a scope question only the maintainer can settle.
