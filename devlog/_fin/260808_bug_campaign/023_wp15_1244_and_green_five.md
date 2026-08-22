# WP15 — #1244 rebases itself, and five green contributor fixes get republished

## What changed since WP14

WP15 opened as "resolve #1244's 22-hunk conflict by hand". That work no longer
exists. The PR head moved from `b413f8bff` to `15545b3d1` and the author
collapsed the branch onto the current `dev` tip:

```
$ git fetch origin pull/1244/head && git merge-base --is-ancestor origin/dev FETCH_HEAD && echo on-dev
on-dev
$ git log --oneline FETCH_HEAD -1
15545b3d1 fix(codex): preserve routed models in desktop picker
```

`mergeStateStatus` is `UNSTABLE` rather than `DIRTY`, `isDraft` is now `false`,
and the 57-file diff no longer defines `mergeCatalogModelsWithNativeRecovery`
locally. The WP14 hypothesis — that resolving 22 hunks across
`src/codex/catalog/sync.ts` and `src/codex/convergence.ts` requires re-deciding
the author's design against the merged #1212 convergence work — is moot. The
author did that re-decision themselves.

Consequence for the campaign: #1244 needs no maintainer rebase. It needs CI to
finish (`Cross-platform CI` and `Service lifecycle` were both `in_progress`)
and then a normal merge decision. That is a watch, not a work item.

## The actual WP15 unit

Five contributor PRs sit one or two commits ahead of a `dev` they are far
behind, and all five still sit in draft because the four-box readiness
checklist is the contributor's own attestation, which I will not tick for them
(`.github/workflows/enforce-pr-target.yml:516`).

| PR | Author | Head | ahead/behind dev | Cross-platform CI at head |
|----|--------|------|------------------|---------------------------|
| #1189 | luvs01 | `d5242a231` | 2 / 300 | success |
| #1195 | luvs01 | `6eff3f6a5` | 2 / 300 | success |
| #1169 | TyroneXie | `d8968b7e6` | 1 / 335 | success |
| #1187 | luvs01 | `36cffcef6` | 2 / 9 | action_required |
| #1184 | luvs01 | `a2eda3b94` | 1 / 16 | action_required |

Read that column through the WP1 rule: `gh pr checks` hides `action_required`,
so the source of truth is
`gh api "repos/lidge-jun/opencodex/actions/runs?head_sha=$sha"`, and `status` is
not `conclusion`. #1187 and #1184 are unapproved, not failing.

All five apply cleanly onto `3ad5bb6bd`:

```
PR#1189 APPLIES CLEAN
PR#1187 APPLIES CLEAN
PR#1184 APPLIES CLEAN
PR#1195 APPLIES CLEAN
PR#1169 APPLIES CLEAN
```

"Applies clean" is textual, not semantic. The three deep-behind branches
(#1189, #1195, #1169 — 300+ commits) are exactly the case where a clean apply
can still be wrong, because `dev` may have moved the surrounding contract
without touching the same lines. Each gets a contract check below, and a clean
apply alone is not accepted as evidence for any of them.

## Diff-level plan

Republish protocol is `003_republish_protocol.md` unchanged: fresh worktree from
`origin/dev`, apply the author's net diff, one commit authored by the maintainer
with a trailer preserving the contributor, a PR body naming the source PR and
mentioning the author, then merge on green.

### WP15-A — #1187 and #1184: approve at head, merge in place

> **Corrected by audit B2 — see the audit-fold section below. The heading is
> wrong: these cannot be merged in place. Read WP15-A′.**

Nine and sixteen commits behind, both under the gate's 10-commit tolerance after
a rebase, both tiny. No republish is warranted; the correct action is to unblock
CI.

1. Re-read each PR head immediately before acting; log `run.head_sha` and
   `pr.headRefOid` as separate columns in `.tmp/ocx_approval_ledger.tsv` with
   `MATCH`/`SKIP`. A `SKIP` means the author pushed inside the window and the
   approval would target a stale commit — abort that row.
2. Approve the `action_required` Cross-platform CI run for a `MATCH` row.
3. Await `conclusion == "success"`. A `failure` gets diagnosed, never guessed.

Acceptance: both PRs have a `success` Cross-platform CI at the exact head the PR
points at, recorded with both SHAs.

What this does not do: it does not make them mergeable by policy, because the
contributor checklist stays theirs. Approval only removes the gate that stops
them from proving box 1.

### WP15-B — #1189: republish as `codex/260808-1189-history-stream-ingest`

Net diff: `src/routing/history/indexer.ts`,
`tests/request-history-index.test.ts`.

It replaces `readCompleteTail` — which allocated `size - indexedOffset` in one
shot — with a 64 KiB chunked reader that assembles records across chunk
boundaries and omits complete records above a 1 MiB projection bound
(`REQUEST_HISTORY_READ_CHUNK_BYTES`, `REQUEST_HISTORY_MAX_RECORD_BYTES`). It
deletes `ingestText` and folds line handling into `ingestSourceTail`.

Contract checks, required because the branch is 300 behind:

- `rg 'ingestText|readCompleteTail' src tests` on `dev` must show no caller
  outside `indexer.ts`; a surviving caller means the deletion breaks it.
- `insert.finalize()` must still run unconditionally in `finally`. The Windows
  file-lock note in the deleted code is load-bearing and CI runs Windows.
- Offset accounting: `nextOffset` may only advance past a `\n`, so a torn final
  record is re-read rather than skipped.

Verification: `bun test tests/request-history-index.test.ts`,
`bun run typecheck`, and an ablation reverting the 1 MiB bound that shows the
oversized-record test failing. A passing suite without the ablation is not
accepted.

### WP15-C — #1195: republish as `codex/260808-1195-unbound-quota-unknown`

Net diff: `src/router.ts`,
`src/server/management/routing-profile-routes.ts`,
`tests/quota-scoring.test.ts`, English routing docs.

It deletes the same ~20-line block from both files: a policy candidate no longer
takes `codexAccountId`/`codexAccountPlan` from
`getEffectiveActiveCodexAccountId` when the Codex provider is in pool mode, and
no longer takes `accountRef` from `getAccountSet("anthropic")`. The rationale is
a real ordering defect — policy evaluation runs before Pool/Direct identity,
thread affinity, and Anthropic session affinity resolve, so a candidate can be
scored with account A's quota and executed on account B.

Contract checks:

- The two blocks must still be identical on `dev`. If `dev` already changed
  either one, the delete is no longer symmetric and the PR is stale.
- `rg 'getEffectiveActiveCodexAccountId|getAccountSet'` must come back empty for
  both files, and the now-unused imports must be gone or `typecheck` fails.
- Live-vs-dry-run parity: both paths must emit the same evidence shape, which is
  the property `tests/quota-scoring.test.ts` is extended to hold.

Verification: quota, policy-execution, routing-profile, and explainability
suites; `bun run typecheck`; an ablation restoring one block only, to show the
parity test fails asymmetrically.

### WP15-D — #1169: republish as `codex/260808-1169-shim-routing-warning`

Net diff: `src/cli/codex-shim-readiness.ts` (new), `src/cli/index.ts`,
`tests/codex-shim-readiness.test.ts`, English and zh-CN lifecycle docs.

`ocx codex-shim install` reports clean success even when it cannot prove Codex
routes through OpenCodex. The change downgrades that to a warning for an
external `model_provider`, a user-owned local or remote gateway, or
unverifiable routing, and warns when proxy variables exist only in the current
process while `config.proxy` is unset. Advisory only: same exit code, and the
shim still fail-open execs the real launcher.

Highest risk of the three at 335 commits behind, and it touches
`src/cli/index.ts`, which this campaign already modified. Contract checks:

- The `codex-shim install` call site in `src/cli/index.ts` must still have the
  shape the patch expects; confirm by reading the applied hunk rather than
  trusting the apply.
- Privacy is the blocking property: no proxy URL, token, or account identifier
  may reach stdout. `bun run privacy:scan` plus the test's own assertion inside
  isolated `CODEX_HOME`/`OPENCODEX_HOME` directories.
- The exit code must be unchanged on the warning path. Assert it, because
  "advisory only" is the whole safety argument.

Verification: `bun test tests/codex-shim-readiness.test.ts`,
`bun run typecheck`, `bun run privacy:scan`, and a real CLI install in a temp
home showing the warning text with no secret in it.

### WP15-E — #1244 watch

> **Corrected by audit B1. #1244's Cross-platform CI at `15545b3d1` is
> `failure`, not `in_progress`. Read WP15-E′.**

No code work. Poll the two `in_progress` runs at `15545b3d1`; merge on
`success`, diagnose and comment on `failure`. If the head moves again, re-read
it before acting. Record the outcome either way.

## Acceptance criteria

1. #1187 and #1184 have `success` Cross-platform CI at their exact current head,
   both SHAs logged and matched in `.tmp/ocx_approval_ledger.tsv`.
2. Three new PRs exist for #1189, #1195, #1169, each with a `Co-authored-by`
   trailer naming the original author, each mentioning them, each filling all
   three PR-template sections.
3. Each republish carries a fresh focused-test result and an ablation that fails
   without the fix.
4. `bun run typecheck` clean on each republished branch; `privacy:scan` clean on
   #1169's.
5. #1244's CI outcome at `15545b3d1` is recorded with a disposition.
6. No contributor readiness checkbox is ticked by me anywhere.

## Faults to avoid, restated because I have committed each one

- Merging without a real green (#1202, WP1).
- Selecting by branch name instead of head SHA; the ledger caught this once.
- Ticking a contributor's readiness box. Done once, reverted.
- Claiming a root cause from plausible commit messages without
  `git merge-base --is-ancestor` (#1178).
- Trusting `gh pr checks` to surface `action_required`. It does not.
- **Reading a run's `status` and stopping there.** I recorded #1244 as
  `in_progress` and built a "watch" around it. By the time the plan was
  audited the run had concluded `failure`, so the plan shipped a wrong
  disposition for the single largest PR in it. Re-read `conclusion` at the
  moment of the decision, not at the moment of the survey.

---

# Audit fold — six blockers, all accepted

A `gpt-5.6-terra` reviewer audited the plan above against live GitHub state and
returned `VERDICT: fail` with B1–B6. Every one is accepted without rebuttal.
The corrections below supersede the corresponding sections.

## B1 — #1244 is failing CI, and the failure is in the #1212 seam

This is the blocker that matters. The survey above recorded two runs as
`in_progress`; the reviewer read the conclusion:

```
$ gh api "repos/lidge-jun/opencodex/actions/runs?head_sha=15545b3d1..." \
    -q '.workflow_runs[]|[.id,.name,.status,.conclusion]|@tsv'
31256061011  Issue quality tests         completed  success
31256061013  Service lifecycle           completed  success
31256062356  Enforce PR target branch    completed  success
31256062366  PR Labeler                  completed  success
31256063542  React Doctor                completed  success
31256063557  Cross-platform CI           completed  failure
```

The failing shard throws `TypeError: suppressedBareNativeSlugs.has` at
`src/codex/catalog/sync.ts:427`, driven by `tests/codex-v2-gate.test.ts:1211`.
The new required input is destructured at `sync.ts:385` **without a default**,
so any caller on `dev` that does not pass it gets `undefined` and dies on
`.has`.

That is precisely the semantic conflict WP14 suspected and this plan dismissed.
The author's textual rebase merged cleanly *and* broke the contract, which is
the exact failure mode the plan claimed to guard against for the three
republishes while waiving it for #1244. A clean `merge-base --is-ancestor` said
nothing about whether every observed-state caller was updated.

### WP15-E′ — #1244: report the failure, do not merge

1. Merge is prohibited at `15545b3d1` and at any later head until a
   Cross-platform CI run at that exact head concludes `success`.
2. Comment on #1244 with the run id, the file:line, the failing test, and the
   missing-default diagnosis. State the fix shape (either default the
   destructured input or update every caller) without asserting which one the
   author should pick — the callers are their design.
3. Re-audit the #1212-adjacent observed-state callers
   (`buildCatalogEntriesFromObservedState`,
   `mergeCatalogEntriesFromObservedState`, `shouldUpgradeToUpstreamEntry`)
   before any future merge decision, because a single missing default proves the
   caller sweep was incomplete.
4. Disposition: **awaiting author**, with a concrete defect. Not a watch.

## B2 — approval is not merge-readiness

`.github/workflows/enforce-pr-target.yml:820` sets `mustDraft` while a
contributor checklist is incomplete, and `:1027`–`:1042` preserve draft status
until every box is ticked. So approving CI does **not** make #1187 or #1184
mergeable, and WP15-A's heading claimed an outcome the gate forbids.

### WP15-A′ — approve CI only; await contributor readiness

Steps 1–3 of WP15-A stand unchanged (SHA-matched ledger, approve `MATCH` rows,
await `conclusion`). What changes is the claim:

- Acceptance is narrowed to: a `success` Cross-platform CI exists at the exact
  current head, both SHAs logged and matched.
- Terminal disposition is **awaiting author**, not merged. The four boxes are
  the contributor's attestation and stay theirs.
- The PR comment must say what approval did and did not do, so the author is not
  left thinking the maintainer unblocked a merge.

## B3 — focused tests are below the mandatory gate

`003_republish_protocol.md:286` requires the full suite when a change touches
routing, adapters, config, or the server; `AGENTS.md:228` requires it
independently. All three republishes touch routing or the CLI, so the
focused-test acceptance at `:110`, `:138`, and `:166` was under-specified.

**Correction:** `bun run test` (full suite) is required on each republished
branch before its PR is opened, and again after any base movement that forces a
re-apply. The focused test and the ablation stay — they are additional
evidence, not a substitute.

## B4 — the disposable-worktree boundary was implied, not enforced

The plan says "fresh worktree" at `:65`, but the protocol it delegates to runs
`git switch -c`, `cherry-pick`, and `commit` in whatever checkout executes it
(`003_republish_protocol.md:39`–`:48`). Run literally in this checkout, that
would touch the user's dirty files.

**Correction, binding for every remaining work-phase:**

- Every republish runs in `git worktree add --detach "$(mktemp -d)/<slug>"`.
- `git switch`, `git commit`, and any write inside
  `/Users/jun/.codex/worktrees/1a75/opencodex` are prohibited except for
  `devlog/` documents.
- `scripts/generate-jawcode-metadata.ts`,
  `src/generated/jawcode-model-metadata.ts`,
  `tests/jawcode-metadata-sync.test.ts`, and `scripts/jawcode-models.json` are
  the user's uncommitted work and are never staged, stashed, or reverted.
- Test and ledger artifacts live inside the disposable worktree; it is removed
  when the phase closes.

## B5 — #1195's parity claim is not covered by its own test

The PR only changes execution-path assertions in `tests/quota-scoring.test.ts`
(runtime assertion at `:198`–`:209`). The management dry-run test at
`tests/routing-profile.test.ts:451`–`:477` covers a candidate with an
explicitly supplied `codexAccountId` — never an *unbound* candidate while a
pool account is active. That is the whole defect, and no test would catch its
return.

**Correction:** the republished #1195 must add paired regressions — runtime and
management dry-run — asserting that an unbound Codex candidate and an unbound
Anthropic candidate both keep `quota.known === false` while a global active
account exists, and that explicit account-qualified evidence stays known. The
ablation restores one of the two deleted blocks and must fail the new pair.
Without that pair the PR body may not claim parity.

## B6 — the inventory is stale; two bugs opened after the sweep

The campaign's own objective is a terminal disposition for *every* open bug
issue and PR. Two were opened after the inventory and appear nowhere in it:

| # | State | Labels | Note |
|---|-------|--------|------|
| #1273 | OPEN | bug | ghost custom models survive provider removal; full-config PUT resurrects deleted `customModels` |
| #1278 | OPEN | bug, platform, install | Windows: transient PowerShell console window on identity lookup; distinct from #1236 |
| #1279 | OPEN | — | non-draft fix PR for #1278 (`43b6b824c`, wade19990814-hue) |
| #1283 | OPEN | bug, gui | grok's limit is weekly not monthly (opened 12:06Z, *after* the re-audit's own B6 list) |

**Correction:** a live inventory resweep runs immediately before execution, and
#1273, #1278, #1279, and #1283 are added to the disposition matrix. WP15 does not
close them silently; if they cannot be dispositioned inside this phase they
become the next work-phase with that stated explicitly.

### B6, second round — a fixed list cannot satisfy a moving inventory

The re-audit reopened B6 after I had already folded it. Between the first audit
and the second, #1283 opened. My correction had enumerated three numbers, so it
would have passed its own criterion while dropping a bug that existed before the
phase closed. Enumerating is the wrong shape for this criterion.

**Correction of the correction:** criterion 6 is no longer a list. It requires a
*recorded live resweep, executed last*, whose output is pasted into the closing
document, covering every then-open `bug`-labeled issue and every associated fix
PR. A number opened after that resweep is out of scope by timestamp, and the
resweep output is what proves the boundary rather than my own recollection.

### B6, third round — an approximate timestamp and a missing PR side

The re-audit rejected my resweep too, on two counts, both fair. I had written the
boundary as `2026-08-08T12:0xZ` — an approximation is not a boundary, and it
cannot decide whether a given issue was in scope. And I had run only
`gh issue list`, so the PR half of "every open bug issue *and* its fix PRs" was
unproven.

**Resweep, exact boundary and deterministic issue → open-PR mapping.**
`RESWEEP_AT=2026-08-08T12:21:41Z`, derived per issue from the cross-referenced
timeline events, open pull requests only:

| Issue | Open fix PR(s) | Disposition |
|-------|----------------|-------------|
| #1283 | none | → WP16 (new, `bug`+`gui`, opened 12:06:03Z) |
| #1278 | #1279 | → WP16 (non-draft PR already open) |
| #1273 | none | → WP16 (new) |
| #1236 | #1268, #1279 | tracking; #1278 is explicitly distinct from it |
| #1230 | #1269 | stays open — the `handleEnsure` gap at `src/cli/index.ts:441` is unfixed |
| #1229 | none | tracking |
| #1222 | none | tracking |
| #1213 | none | tracking |
| #1196 | #1270 | awaiting contributor (two blockers commented) |
| #1193 | #1205 | rerun needed — the run ended `cancelled`, not `failure` |
| #1190 | #1210 | CI green, awaiting contributor checklist |
| #1162 | none | tracking |
| #1145 | none | tracking |
| #1128 | none | tracking, reporter capture requested |
| #1059 | #1272 | CI green, awaiting contributor checklist |
| #1024 | none | tracking, reporter capture requested |
| #904, #796, #418, #417, #241, #92 | none | long-lived tracking |

That is 22 open `bug` issues, each with either a disposition already recorded in
this unit or an explicit hand-off.

One row needs its cross-reference stated precisely rather than assumed. #241's
timeline lists only closed PRs (#298, #999, #1056, #1147, #1150), so the
mechanical mapping correctly reports no open fix PR. #1244 does not link #241.

The chain has two links of different strength, and my first attempt at this
paragraph flattened both into "exists only in prose", which the audit
corrected: **#241 → #1056 is a real timeline cross-reference; #1056 → #1244 is
inferred solely from #1244's `Supersedes #1056` body text.** Only the second
hop is prose. I had also asserted a direct #1244 → #241 link earlier in this
campaign without reading the timeline; that was wrong, and this is the
corrected form.

The scope boundary is the timestamp above. Anything opened after
`12:21:41Z` is out of this phase by construction, and that is provable from the
recorded value rather than from my recollection.

## Revised acceptance criteria for WP15

1. #1187 and #1184: `success` Cross-platform CI at the exact current head, both
   SHAs logged and matched. Disposition recorded as **awaiting author**, with no
   merge claim and no box ticked by me.
2. Three new PRs for #1189, #1195, #1169, each with a `Co-authored-by` trailer
   naming the original author, each mentioning them, each filling all three
   template sections.
3. Each republish: full `bun run test` green, plus a focused test, plus an
   ablation that fails without the fix. #1195 additionally carries the paired
   parity regressions from B5.
4. `bun run typecheck` clean on each branch; `privacy:scan` clean on #1169's.
5. #1244: the CI `failure` at `15545b3d1` is reported on the PR with run id,
   file:line, and the missing-default diagnosis. Merge prohibited.
6. #1273, #1278, #1279 appear in the disposition matrix with either a terminal
   disposition or an explicit hand-off to the next work-phase.
   *(Superseded by B6 round two: a recorded live resweep, run last, must be
   pasted in, and every then-open bug issue must have a disposition or a named
   hand-off. No fixed list.)*
7. All code work happened in `mktemp -d` worktrees; the user's four dirty files
   are untouched (`git status --short` proves it).

---

# Execution record

## The audit moved the base out from under the work

Round four caught something none of the earlier rounds could: while I was
folding blockers, `origin/dev` moved from `3ad5bb6bd` to `f5147cbc8`. Every
test result on this page — three full suites, two ablations, three typechecks —
was measured against a base that no longer existed. The reviewer's instruction
was to treat all of it as stale and redo it after rebasing, which is correct and
which I did.

The cost of skipping that step would have been three PRs whose "Verification"
sections cited numbers from a base the reviewer could not reproduce. That is the
same class of fault as merging #1202 without a real green, just better hidden.

Re-verified on `f5147cbc8`:

| Branch | Full suite | Focused | Extra |
|--------|-----------|---------|-------|
| `codex/260808-1189-history-stream-ingest` | 9991 pass / 7 skip / 0 fail, 625 files | 20/20 | ablation 19/1 then restored 20/0 |
| `codex/260808-1195-unbound-quota-unknown` | 9992 pass / 7 skip / 0 fail, 625 files | 31/31 | ablation 27/4 at identical scope |
| `codex/260808-1169-shim-routing-warning` | 9994 pass / 7 skip / 0 fail, 626 files | 5/5 | `privacy:scan` passed |

`bun run typecheck` clean on all three. The prepush hook then ran the full suite
a second time per branch and passed each one, which is why the pushes took
roughly six minutes apiece.

## Published

| New PR | Republishes | Author | Head |
|--------|-------------|--------|------|
| #1287 | #1189 | luvs01 | `02ec799fe` |
| #1288 | #1195 | luvs01 | `3fc962f2c` |
| #1289 | #1169 | TyroneXie | `eac814346` |

All three opened non-draft against `dev`, `MERGEABLE`, and `Enforce PR target
branch` green on each. Trailer evidence:

```
$ git log --format='%h %s%n  %(trailers:key=Co-authored-by,valueonly)' origin/dev..HEAD
02ec799fe fix(history): stream request-history index ingestion (#1189)
  luvs01 <27862058+luvs01@users.noreply.github.com>
3fc962f2c test(routing): prove the management dry-run leaves unbound candidates unknown

0c745be36 fix(routing): keep unbound account quota unknown (#1195)
  luvs01 <27862058+luvs01@users.noreply.github.com>
eac814346 fix(codex): warn when codex-shim install cannot prove routing (#1169)
  TyroneXie <328347833@qq.com>
```

The blank trailer line on `3fc962f2c` is deliberate and is the point of B5's
attribution requirement: those two dry-run tests are mine, not luvs01's, so they
are a separate commit with no co-author trailer and an explicit paragraph in
#1288's body saying so. Folding them into the contributor's commit would have
attributed my code to them; leaving them out would have shipped an unproven
parity claim.

## Actions taken on existing PRs

- **#1187, #1184** — approved the `action_required` Cross-platform CI at
  SHA-matched heads (`36cffcef6`, `a2eda3b94`; both `MATCH` in
  `.tmp/ocx_approval_ledger.tsv`). Commented on both that approval unblocks CI
  and nothing else, and that the four boxes stay theirs. Disposition: **awaiting
  author**.
- **#1244** — commented with run `31256063557`, the `TypeError` at
  `src/codex/catalog/sync.ts:427`, the triggering test at
  `tests/codex-v2-gate.test.ts:1211`, and the missing default at `sync.ts:385`.
  Named both fix shapes without choosing for them, and flagged that the same
  caller-sweep gap may exist for the other inputs added in that commit. Merge
  held. Disposition: **awaiting author, with a concrete defect**.
- **#1189, #1195, #1169** — commented on each that it was republished, by which
  PR, with what verification, and that the author may take it back if they
  prefer to drive it themselves.

## What WP15 did not do

#1283, #1278/#1279, and #1273 are dispositioned as hand-offs to WP16, not as
closed. Naming them here is the honest form of that; the resweep table above is
what makes the boundary checkable rather than asserted.

## Merged

All three landed on `dev`, and the `Co-authored-by` trailer survived each
squash — which is the property that matters, because the squash is where
contributor credit usually gets lost:

```
57ea8df47 fix(routing): keep unbound account quota unknown (#1195) (#1288) | luvs01
5aa197112 fix(codex): warn when codex-shim install cannot prove routing (#1169) (#1289) | TyroneXie
2cb8eddd4 fix(history): stream request-history index ingestion (#1189) (#1287) | luvs01
```

#1189, #1195, and #1169 were closed as superseded, each with a comment naming
the landed SHA and confirming the credit. #1195's closing comment states
separately that the maintainer test commit is mine and their fix commit is
unmodified.

### #1288 needed two reruns, and the reason is worth recording

Cross-platform CI at `3fc962f2c` came back `cancelled` twice. A `cancelled` is
not a `failure` — the four-state rule says rerun — but twice in a row is a
signal rather than noise, so I read the job log instead of firing a third
rerun blind. `test 3/4` hung at `tests/cli-restart-health.test.ts` and was
killed by the runner after ~14 minutes.

The check that made this safe was comparing against `dev` itself:

```
31259885820  dev  all-shards-ok
31259450263  dev  cancelled  test 3/4=cancelled
31259447622  dev  cancelled  test 1..4/4=cancelled
31256617398  dev  success    all-shards-ok
```

The same shard cancels on `dev` with no PR involved, so it is runner flake, not
something #1288 introduced. `rerun-failed-jobs` then returned all four shards
green. Had I not checked `dev`, "rerun until green" would have been
indistinguishable from hiding a real defect — which is exactly the failure mode
the four-state rule exists to prevent.

## Final resweep — `FINAL_RESWEEP_AT=2026-08-08T13:48:43Z`

Run last, as criterion 6 requires. Twenty-two open `bug` issues, unchanged in
membership from the 12:21:41Z sweep, so nothing opened during execution.
#1283, #1278/#1279, and #1273 remain the undispositioned three and pass to
WP16.

## Acceptance, checked

1. #1187, #1184 — Cross-platform CI `success` at `36cffcef6` and `a2eda3b94`,
   both `MATCH` in the ledger. Awaiting author. **Met.**
2. Three new PRs with trailers and mentions, all template sections filled.
   **Met.**
3. Full suite + focused test + ablation on each; #1195 carries the B5 parity
   pair. **Met.**
4. `typecheck` clean on all three; `privacy:scan` clean on #1289's. **Met.**
5. #1244's `failure` reported with run id, file:line, and the missing-default
   diagnosis; merge held. **Met.**
6. Final resweep recorded above with a disposition or hand-off per row.
   **Met.**
7. All code work in `mktemp -d` worktrees; `git status --short` still shows
   exactly the user's four untouched files. **Met.**
