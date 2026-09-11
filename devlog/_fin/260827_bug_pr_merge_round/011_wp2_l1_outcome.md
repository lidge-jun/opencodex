# wp2 — L1 lane outcome

Landed on `dev` as `2feffbdc3` (PR #2720), which carried four merges:

| PR | author | preserved as | disposition |
|---|---|---|---|
| #2672 | Ingwannu | `2a9c18dc5` | MERGED, no changes needed |
| #2674 | Ingwannu | `e3b136fb7` | MERGED, no changes needed |
| #2671 | DevonGithub | `17aadf88e` | MERGED + one added test (`4a4df12f2`) |
| #2684 | Michael-Z-Freeman | `2c85dd48d` | MERGED, checklist-only CI failures |

All four show `MERGED` on GitHub with a comment naming the landed sha.

## Evidence

- `bun run test` (full suite, local, session 77096): exit 0.
- PR #2720 CI after one rerun: 23 pass, 1 skipping, 0 fail.
- `bun x tsc --noEmit`: clean on the merged tree.
- Focused: forward-prompt-envelope + posit-continuation 9/9, muse-vision 6/6,
  azure-model-router 2/2, repo-hygiene 11/11.

## The `test 1/4` failure was a flake, and it was checked rather than assumed

First CI run failed one case: `update stops the running proxy before replacing files >
npm launcher restarts the stopped runtime after a staged update failure`, at 46797ms.
The same case passes locally in 2.6s, this branch touches no update/launcher file
(`git diff --name-only 9b838d062 HEAD | grep -E 'update|launcher'` is empty), and the
test already carries two prior timing-budget repairs (`538a602af`, `34ef53966`). Rerun
of the failed job alone: green.

That is the standard this round applies — a rerun-to-green is only acceptable when the
causal question was actually asked first.

## Discovered constraint: `dev` is protected

A direct `git push origin dev` is rejected: "Changes must be made through a pull
request." So every later lane lands the same way — a `codex/` branch plus a PR, not a
local merge and push. The local merges are still how the work is built and verified;
they simply travel through a PR.

## Carried forward

- #2671's probe-evidence question (007, finding 10) is open on a MERGED change.
- #2690 is now guaranteed to conflict with `dev`, since #2684 landed. That was the
  intended ordering, not an accident.
- `src/server/responses/core.ts` evidence for #2663/#2638/#2497/#2694 is unaffected by
  this lane: none of the four L1 merges touched it.
