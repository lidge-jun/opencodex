# 070 — Retarget, maintainer judgment and merge (wp8)

Waits for the telemetry stack (#8300 → #8348 → #8303 → #8304 → #8305 → #8308) to land on `dev`; the coordinator
announces #8308's merge (decision `stackwait`, 2026-11-09). Do not poll.

## Prep done before the stack lands

- Regression guard for existing users: `tests/usage/usage-telemetry-profile-lifecycle.test.ts` proves that a proxy with
  no `telemetry-profile.json` starts no profile loop and loads no profile module at background start, with telemetry on
  or off (`OCX_TELEMETRY=0`), so installs that never connect a profile behave as before.

## Steps after #8308 merges

1. `gh pr edit 8393 --base dev`; merge `dev` into the branch only if GitHub reports a conflict.
2. `git commit --allow-empty -m "ci: build on current dev"` and `git push --no-verify` (CI then builds on current `dev`,
   which carries 2.100.0 and clears the inherited `release-version-line` failure).
3. Post the Maintainer judgment comment (draft below), citing the head SHA.
4. Fresh independent review (task.create role=review) on that exact head; fold any P0/P1 or correctness/security P2 with a
   failing-first test and repeat on the new head.
5. When the exact head's hosted CI is green: `gh pr ready 8393`, then
   `gh pr merge 8393 --squash --admin --match-head-commit <sha>`; close #8372 manually (PRs into `dev` do not auto-close).
6. Report via origin.report (Korean) with PR URL, merge SHA, judgment summary, NOT RUN.

## Draft: Maintainer judgment

> **Value.** Implements #8372: an opt-in public profile and personal usage rank, built on the anonymous telemetry
> stack, as requested by the owner. Not a duplicate; no other open PR touches profiles or a leaderboard.
>
> **UX change — intentional and documented.** New surfaces only: a *Public profile & rank* card on the dashboard Home
> (shown while anonymous telemetry is on, or while a profile exists), `ocx telemetry profile connect|disconnect|status`,
> collector profile/leaderboard endpoints, and a leaderboard section on opencodex.me/dashboard. Existing flows, defaults,
> CLI output of existing commands, config semantics and the anonymous payload are unchanged; the README privacy line,
> code-signing pages, telemetry guide and `AGENTS_INSTALL.md` describe the new opt-in.
>
> **No regression for existing users.** Nothing happens until a person connects: no profile file means no profile loop
> and no profile module loaded (lifecycle test), the card stays hidden while telemetry is off (GUI test), telemetry-off
> users send nothing (sync tests for `OCX_TELEMETRY=0`, `DO_NOT_TRACK=1`, declined), connecting never writes
> `config.json` or the anonymous telemetry files, and the core request path does not reach `src/telemetry/` (boundary
> test). Reviews: <fresh review on head>, privacy review PASS-WITH-NITS (P2 fixed); exact-head CI <link>.

