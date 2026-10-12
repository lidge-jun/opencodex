# 090 — regaudit3: final recount and closeout

Terminal phase after `p3226`–`p3232` and `r3239`.

## Recount (2026-09-02, final)

`gh issue list -l bug --state open` → **4** (#3152, #3141, #2999, #1527),
`gh pr list -l bug --state open` → 0. Combined **4**.

An earlier pass of this doc read 5: #1419 (bundled Bun SIGTRAP) was closed by the maintainer at
2026-09-02T02:43Z as completed — the bundled Bun moved to 1.4.0, with a reopen invitation if it
recurs. That closure was not made by this loop and not made to lower the count; it is the
platform fix the blocker was waiting for. The four remaining are the recorded blockers from 072,
each with a maintainer comment naming the evidence it needs and `needs-info` where the
reporter owns the next step (#2999 is the runtime-primitive blocker).

`origin/dev` has since moved past `2cb592174` with feature/docs landings by the maintainer
(#3222, #3230, #3231, #3225); none carries the bug label and none is in this campaign's scope.
The CI verdict below is pinned to `2cb592174`, the last commit this campaign put on `dev`.

## Landings since regaudit2 (all ancestors of `origin/dev`)

| item | landing | note |
|---|---|---|
| #3226 → #3234 | `b732b0d0f` | carry + nested `function.name` fix |
| #3227 → #3236 | `1c8278b4d` | carry, author credit |
| #3228 → #3239 | `744d12d02` | **reverted** by #3242 `2cb592174` — see below |
| regression from #3239 → #3240 | `7f00d0eee` | **reverted** by #3242 together with #3239 |
| #3229 → #3241 | `b54508c8c` | carry on the repaired tip |
| #3232 | `261b7e012` | merged by the maintainer directly; verified |

## Trailing CI

The `push` runs on `dev` during this train were all cancelled by the next push. The r3239
regression was caught by the next cycle's focused check, not by CI, and repaired before anything
else landed — which is the point of pairing "CI behind the work" with a focused red-green gate
on every PR. Exact-head `workflow_dispatch` on `b54508c8c` (branch
`codex/regaudit-ci-b54508c8c`, run 33581824312, Windows on): **test 3/4 failed** on
`tests/agent-task-recovery.test.ts` "keeps the disabled fail-fast response byte-identical to
the absent feature" (400 expected, 502 received). Bisect: 19/19 at `1c8278b4d`, 7/19 at
`744d12d02` (#3239), 18/19 at `7f00d0eee` (#3240). The contract that file pins — recovery
absent/disabled ⇒ fail-fast 400 with zero upstream fetches — is a credential-spend boundary:
synthesizing a native chain reroutes a routed spawn to the ChatGPT backend without the operator
opting in. #3240 could not restore that without removing the feature, so **both were reverted**
in #3242 → `2cb592174` (92 pass / 0 fail across the three recovery/fallback files after the
revert). #3228's disposition is corrected on the PR: the reported behaviour is the documented
opt-in, not a bug; a defaults change is a product decision for a feature request. The p3228
review ran the fallback and security files but not `agent-task-recovery.test.ts` — recorded
as the miss.

Second dispatch on the reverted tip `2cb592174` (run 33582128589, Windows on): Linux test
1/4–4/4 all green (the `agent-task-recovery` failure is gone), gates, storage, api-usage,
keyring ×3, npm-global ×3 green. Windows 1/2/4 failed with the known runner signatures
(`EPERM rm tests/.tmp-codex-accounts-test` ×49, icacls `ETIMEDOUT`, "Bun runtime crash");
3/4 cancelled by the gate. macOS failed one case: `native-profile-manager` "preserves exact
auth bytes, encrypts inactive profiles…" at 12.7 s — a file untouched since `#3054`
(2026-08-29, on `main`), which passed in both earlier dispatches (33562938994, 33581824312)
and 49/49 three times locally on this tip; its history is two macOS-timing bounding commits
(`bef2869c7`, `c1be34da4`). Classified as a macOS timing flake; a third dispatch
(run 33584155821) is recorded below to settle it.

Third dispatch on `2cb592174` (run 33584155821): **macOS green**, Linux 1/4–4/4 green, gates,
storage, api-usage, keyring ×3, npm-global ×3 green. The `native-profile-manager` case is
settled as a macOS timing flake (fail 1 of 3 dispatches on an unchanged file). Windows shards
remain the hosted-runner defect proven on `main` in 071. Verdict for the campaign's last
source commit: green on every platform this repository can currently trust.

## Devlog landing

PR #3218 (this stack, rebased on the current `dev` tip) → admin squash-merge; SHA recorded in
the ledger and the goalplan criterion evidence.

## Criterion c-7

Met: **4** open bug-labelled items (≤5 fallback; 3 would have required closing a blocker without
its evidence), all four with recorded, evidence-backed blockers. From 24 at the start of the
campaign: 14 PRs + 10 issues → 0 PRs + 4 issues. 22 landings / closures with SHAs or evidence
comments, one honest revert.
