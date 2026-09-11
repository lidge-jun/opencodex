# 001 — live rescan verdicts for all 25 scoped items

Four read-only `xai/grok-4.6` high-effort lanes, split so no two lanes shared a
verdict: (A) issues a prior scan believed the tree already answered, (B) the model
catalog dated-variant cluster, (C) platform/service and cursor transport, (D) request
metadata, account-pool auth, and the residual bug PRs. Every lane was instructed that
the tree wins over the issue body and the PR description.

## The headline: the prior scan was wrong in both directions

The round-2 below-bar table (`260831_prio70_train_round2/000_plan.md`) was written to
justify *exclusion* from a merge train, not to decide disposition. Read as disposition,
it misclassifies five items:

| item | prior scan said | the tree says |
| --- | --- | --- |
| #3041 | reverse inference can resurrect retired ids | the author **removed** the reverse fold in `4e131140c`; the danger is in `aef4bec2`, which is no longer the head |
| #3070 | model filtering landed in `b68edc077` | that commit is CLI/API only and does not touch `gui/src/pages/Logs.tsx`; the dashboard still cannot find a Terra row |
| #1527 | all four named mechanisms are fixed on `dev` | all four SHAs are ancestors, but `envelope_exhausted` still silently full-replays for external-root models |
| #3021 | one occurrence, no ciphertext captured | `structurallyValidFernetTokens` already exists, so a bounded output filter needs no reporter ciphertext |
| #3053 | no linked user report | the runtime/catalog drift is real and the PR's tests drive production; absence of an issue number is not a defect |

#3059 and #1419 held up only halfway, and audit round 1 caught the other half. The tree
does contradict #3059's unmount path, but a real focus residual survives that
refutation, so it became a wp9 fix instead of a close. #1419 was reported against a Bun
this tree no longer ships, but the maintainer explicitly declined to claim 1.4.0 fixed
it, so it became the second declared `UNSOLVABLE` instead of a close. See `002`.

## Verdicts

| item | verdict | one-line basis | phase |
| --- | --- | --- | --- |
| #3068 | `CLOSE_DUPLICATE` | same author, body and `input[240]` log as #3071; author already said "superseded" | wp1 |
| #3059 | `REIMPLEMENT` (was `CLOSE_INVALID`; see `002`) | the reported unmount cannot run — `refresh()` keeps stale data at `gui/src/client-resource.ts:339-341` — but the focus residual at `RestoreDialog.tsx:49-50` is real | wp9 |
| #1419 | `UNSOLVABLE` (was `CLOSE_NOT_REPRO`; see `002`) | `27764f342` moved the pin to Bun 1.4.0 and 200 TLS-failure cases produced no SIGTRAP, but the maintainer explicitly declined to claim that fixed the reporter's trap | residual |
| PR #3030 | `CLOSE_INVALID` | the branch is 61 files / +5114 of unrelated `main` work, and the classification it tests does not exist in `provider-routes.ts:957` | wp1 |
| #3024 | `REIMPLEMENT` | widen the suffix matcher one-way only; a live base row is not callability evidence for a configured dated snapshot | wp2 |
| PR #3034 | `MERGE_AFTER_REBASE` | the calendar matcher is the better vehicle; graft #3041's merge-loop tests, whose reverse test is the real resurrection guard | wp2 |
| PR #3041 | `CHERRY_PICK` | take the two merge tests and the directional comment; leave `isDateSuffix`, which still folds `0231` | wp2 |
| #3051 | via PR | — | wp3 |
| PR #3052 | `MERGE_AFTER_REBASE` | one production line; a pre-header EOF is `status === 0` and must be `transport`, not `HTTP unknown` | wp3 |
| #3064 | via PR | — | wp4 |
| PR #3067 | `REIMPLEMENT` | `[^\\\\/]*` leaves a fully CJK segment with no anchors, so `...\\김병준\\...` matches `...\\Admin\\...`; restrict the lossy run to `[?\\uFFFD]*` and give `<UserId>` its own matcher | wp4 |
| #3009 | via PR | — | wp4 |
| PR #3039 | `MERGE_AFTER_REBASE` | correct remedy; restore `expect(probes).toBe(1)` and pin the 45s budget absolutely | wp4 |
| PR #3066 | `MERGE_AFTER_REBASE` | strips at the noncanonical adapter boundary only, copy-on-write, ChatGPT preserved; tests drive `buildRequest` | wp5 |
| PR #3038 | `CLOSE_DUPLICATE` | same defect, wrong layer (mutates canonical ChatGPT too) and its tests stay green with both call sites deleted | wp5 |
| #2999 | `REIMPLEMENT` | refresh lock is keyed on `OPENCODEX_HOME` while the file lives in `CODEX_HOME`; coordinate on the existing native-main claim instead | wp6 |
| PR #3000 | `REIMPLEMENT` (close in favor of the rewrite) | `dlopen(\"libc.so.6\")` breaks musl, and a late cancel discards an already-rotated grant | wp6 |
| PR #3003 | `MERGE_AFTER_REBASE` | a failed WHAM prime writes no quota, so the account is stale forever; the PR's tests drive `primeCodexPoolQuotas` | wp6 |
| PR #2989 | `MERGE_AFTER_REBASE` | the existing 503 test never re-enters, so it stays green on the broken path; the PR's tests do re-enter | wp6 |
| PR #3078 | `REIMPLEMENT` on `dev` | both production hunks are right; it targets `main` and its test file does not typecheck | wp7 |
| PR #3063 | `MERGE_AFTER_REBASE` | the second commit's tests do drive `handleResponsesCompact`; the "vacuous" reading was of the first commit | wp5 (moved: it now edits two train-owned files, `003`) |
| PR #3053 | `MERGE_AS_IS` | already rebased onto `b4303bb9e`; mirrors `isModelTextOnly` at both catalog sites | wp7 |
| #3070 | `REIMPLEMENT` | add a Logs model/provider query; the intercepted toggle stays Luna-only | wp9 |
| #1527 | `REIMPLEMENT` | fail closed on `envelope_exhausted` for external-root models instead of silently full-replaying | wp9 |
| #3021 | `REIMPLEMENT` | replace a client-visible Fernet payload with a structured error; do not widen recovery to `MESSAGE` | wp9 |
| #2813 | `UNSOLVABLE` | needs `/v1/models` and `/api/models` dumps from an account actually in Reserve; a picker screenshot cannot separate proxy-missing from client-filter | residual |

## Residual candidates

Two are declared unsolvable after audit round 1: #2813 and #1419. The round budget
allows three to four, so the remaining slots are held for phases that hit a genuine
wall, not spent in advance.

## Note on phase numbering

wp9 (residual issue reimplementations: #3070, #1527, #3021, and #3059 after audit round
1) was appended after this scan, because the roadmap assumed those would close without
code. wp8 remains the closeout and runs last.

## This table is living

Two audit rounds moved four rows after they were first written (#3059, #1419, #3063,
and #3030's label). PR file lists in particular are a moving target — #3063 grew from
two files to five during wp0 — so every phase re-reads `gh pr diff --name-only` for its
own PRs before merging rather than trusting this table's snapshot.
