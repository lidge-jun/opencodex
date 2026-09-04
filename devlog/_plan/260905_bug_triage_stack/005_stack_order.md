# 005 — Stack order and PR contract

All five fixes are mutually independent in code. The stack order is chosen so each
lower PR is reviewable and mergeable alone and each higher PR carries the smallest
possible diff relative to its base.

| Pos | Doc | Branch | Base | Closes | Author trailer |
|---|---|---|---|---|---|
| 1 | 010 | `codex/3467-google-location-error` | `dev` | #3467 | agentHits |
| 2 | 020 | `codex/3462-mihomo-ipv6-fakeip` | pos 1 head | #3462 | — |
| 3 | 030 | `codex/3464-launchd-stable-launcher` | pos 2 head | Refs #3464 (does not close; running-process mismatch remains) | — |
| 4 | 040 | `codex/3522-spill-write-health` | pos 3 head | (references #3522, does not close) | Ingwannu |
| 5 | 050 | `codex/3406-codex-toggle-truth` | pos 4 head | #3406 | turin |

Per-PR contract (each PR):

1. Branch from the previous position's head (pos 1 from fresh `origin/dev`).
2. Implement per its decade doc; focused tests + `bun run typecheck` only.
3. Commit with trailer where applicable; `git push --no-verify -u origin <branch>`.
4. `gh pr create --base <base> --draft=false` with the full template (Summary /
   Verification / Checklist), `Closes #N`, and for 050 a GUI screenshot.
5. Record `headRefOid` + `gh pr checks` run ids in `060_ledger.md`; fix forward on red.
6. After a lower PR merges, restack the next one onto `dev` (retarget base) — out of
   scope for this loop (no merges authorized).

Existing contributor PRs superseded by carries: #3469, #3525, #3407. Leave them open;
the maintainer decides whether to close them after the carry lands.


Child propagation (audit blocker 3): any commit added to a lower position after higher
branches exist must be propagated upward — `git rebase <lower-head>` each descendant in
order, `git push --no-verify --force-with-lease`, then re-verify
`git merge-base --is-ancestor <lower-head> <child-head>` and re-record fresh exact-head
`gh pr checks` for every child. A child's earlier green does not survive a parent change.

