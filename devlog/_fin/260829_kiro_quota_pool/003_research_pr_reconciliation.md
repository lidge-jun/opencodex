# 003 — 429 PR reconciliation (state as of 2026-08-29)

`origin/dev` and GitHub `dev` both at `124a2b1487996f8a8ebb2067b22c9e758fa6016f`.

"Landed" below means the *behaviour* is on `dev`. Squash merges do not preserve the PR
head SHA in ancestry, so head-containment is the wrong test for all but one of these.

| PR | Subject | State | Landed as |
| --- | --- | --- | --- |
| #2590 | generic multi-account 429 failover (#2568a) | MERGED | `816f3a159` |
| #2607 | rotate generic OAuth accounts on 429 in sidecars | MERGED | `87250870c` |
| #2608 | cursor adapter-event 429 rotation | MERGED | `6b508d5a8` |
| #2640 | activate failover on account presence (#2568d) | MERGED | `8bfac7146` |
| #2841 | bind a rotated OAuth bearer to its own Copilot origin | MERGED | `5a829b7e9` |
| #927 | compact: alternate account on pool 429/402 | MERGED | `87c479006` (head in ancestry) |
| #2573 | antigravity quota exhaustion spelling | MERGED | `bfe2cb5a1` |
| #2745 | rebind credential identity on every OAuth 429 rotation | CLOSED | superseded by #2807 → #2841 |
| #2807 | same, v2 | CLOSED | superseded by #2841 |

## The nuance on #2745 / #2807

Their *security outcome* landed; their *complete diff* did not. #2841 fixed all four
snapshot/origin read sites and added stronger coverage, but the broader refactor those PRs
proposed — relocating `sentOAuthSnapshot`, replay identity, and Cursor cleanup into
`applyFailoverSnapshot` — was not adopted. Neither branch needs rebasing; the accepted
requirement is represented on `dev`.

What this means for **this** unit: the credential/identity-pairing invariant is already
enforced for Copilot origins and for Kiro's `_kiroAuthContext`
(`src/server/responses/core.ts:3050-3063`). Our Kiro work must not regress it, and our
regression test must prove a rotated Kiro bearer never travels with another account's
profile ARN.

## Still open and relevant

- **#2783** (quota-reset detection) — OPEN, CI green at its recorded head, but
  `CONFLICTING`/`DIRTY` against current `dev`. It is a *different* unit (usage-window
  reset detection and notification). Out of scope here; it needs its own rebase pass.

Not relevant: #2729, #1704, #150, #138 are closed and superseded or dormant.

## Conclusion

There is no unmerged 429 work to land. The reconciliation answer is "all merged except two
that were deliberately superseded by #2841", and the follow-up action is to *preserve* that
invariant while adding Kiro quota, not to re-open old branches.
