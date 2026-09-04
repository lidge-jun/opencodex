> **Amended by 008 (audit round 1):** `git merge-tree` shows all seven items merge clean at `79e03643d`; the "CONFLICTING" rows in §0 and the 2/7 outcome are superseded — expected outcome is 7/7. #3529 head is now `92b4eda26` with CHANGES_REQUESTED; see 008 Blocker 2.

# 010 — wp1 / Stack A: the LAND_AS_IS merge train

Work-phase: **wp1**. Unit `devlog/_plan/260905_open_work_closeout`.
Scope: **#3515, #3529, #3525, #3490, #3484, #3480, #3323** — seven independent open pull
requests whose code is correct as written. This is a **merge-train recipe**, not a rebase
or reimplementation plan: no `src/`, `tests/`, or `gui/` file is authored in this
work-phase except the one layout-registry line forced by #3490 (§3.4).

Source lanes: `001_lane_bug_prs_a.md` (#3515 #3529 #3525 #3490),
`002_lane_bug_prs_b.md` (#3484 #3480), `004_lane_else_prs.md` §#3323.

## 0. Re-verification against current `dev` (drift check)

> **Read this section before touching anything.** `origin/dev` moved **twice while this doc
> was being written**, and the second move changed the shape of the entire work-phase. The
> per-item sections below are correct on the merits; this section overrides their
> *mergeability* status.

Lane research ran at `origin/dev` = `0f27bbeb3`. Current `origin/dev` = **`79e03643d`**:

```
79e03643d test(layout): move server, storage, ci-workflows into tests/<domain>/ (#3497) (#3518)
bdafc5191 test(oauth): prove the unobservable quorum staleness window is harmless (#3533)
6580694c7 test(oauth): restore a deleted contract test, and fail when one disappears (#3530)
```

### 0.1 `79e03643d` flipped five of seven items to CONFLICTING

`79e03643d` migrated the **`server`**, **`storage`** and **`ci-workflows`** domains into
`tests/<domain>/`, adding all three to `layout.migrated`. Every Stack A PR that edits a test
file which just moved is now `CONFLICTING / DIRTY`. Re-read with `gh pr view` after the move:

| PR | Head now | Mergeable | Draft | Review |
|----|----------|-----------|-------|--------|
| #3515 | `4f09faf5d` | **CONFLICTING** | no | REVIEW_REQUIRED |
| #3529 | **`81e692313`** (moved) | **CONFLICTING** | yes | REVIEW_REQUIRED |
| #3525 | `288506dc6` | **CONFLICTING** | no | REVIEW_REQUIRED |
| #3484 | `a4c50d104` | **CONFLICTING** | no | REVIEW_REQUIRED |
| #3323 | `0facdae69` | **CONFLICTING** | no | REVIEW_REQUIRED |
| #3490 | `3fbe8a2c7` | MERGEABLE / BLOCKED | yes | REVIEW_REQUIRED |
| #3480 | `74ef8faae` | MERGEABLE / BLOCKED | **no** (exited draft) | **CHANGES_REQUESTED** |

**The conflict is mechanical in every case, and provably so.** For each PR I compared its
changed-file list against `origin/dev` and asked whether each path still exists. Exactly the
relocated test files are `GONE`; **every source, GUI, and docs path is `OK`**:

| PR | Conflicting path(s) — all test-only | New path on `dev` | Source conflicts |
|----|--------------------------------------|--------------------|------------------|
| #3515 | `tests/server-auth.test.ts` | `tests/server/server-auth.test.ts` | **none** |
| #3484 | `tests/management-integration-journal-delete.test.ts` | `tests/server/…` | **none** |
| #3323 | `tests/management-route-registry.test.ts` | `tests/server/…` | **none** (it is the only file in the PR) |
| #3525 | `tests/memory-watchdog.test.ts` | `tests/server/…` | **none**; its two `tests/responses/` files are still `OK` |
| #3529 | `tests/server-combo-failover-e2e.test.ts`, `tests/terminal-guard-server.test.ts` | `tests/server/…` both | **none**; `tests/adapters/` and `tests/providers/` files still `OK` |

No two PRs conflict with each other, and no PR conflicts with `dev` on a source file. This is
the same `tests/<domain>/` migration lane 002 already identified as "the dominant blocker" —
it has now reached the `server` domain and swept up Stack A.

### 0.2 What this means for the work-phase

A merge train requires `MERGEABLE` heads. Five items no longer have one, so **Stack A as
specified can no longer execute end-to-end today.** The disposition of every item is unchanged
— the code is still correct and the defects are still live — but five of them now need a
mechanical rebase first, which §1 explicitly places out of scope.

Two paths, and the choice belongs to the parent, not to this doc (§1 escalation):

- **(A) Ask each author to rebase.** Preferred: attribution stays native, the merge stays a
  plain squash, and the rebase is a file move plus a specifier rewrite
  (`../src/` -> `../../src/`). #3529's author is already responsive — that head moved from
  `4f103a1e7` to `81e692313` during this session.
- **(B) Move the five rebases into wp2** (`020`), which already owns mechanical
  `tests/<domain>/` rebases for #3489, #3469, #3487 and #3528. Stack A then lands only what
  is still mergeable.

**Executable today, unchanged:** #3480 (step 2) and #3490 (step 6, with its §3.4 fix).
Everything else waits on a rebase. The merge order in §2.2 stays valid as the order to use
*once* heads are mergeable again.

**Rebase recipe** (identical for all five; this is the whole of it):

```
git rebase origin/dev                      # conflicts land as delete/modify on the moved file
git mv-equivalent: re-apply the PR's test hunk onto tests/server/<file>.test.ts
rewrite relative specifiers one level deeper:  ../src/  ->  ../../src/
bun test tests/server/<file>.test.ts        # must be GREEN with the src half applied
bun test tests/test-layout.test.ts          # must stay 2 pass / 0 fail
```

Do **not** re-run the lanes' red/green analysis after the rebase: the RED-on-dev arguments in
§3 are about source behavior and are unaffected by a file move.

### 0.3 A baseline an implementer will otherwise misread

On `0f27bbeb3`, `bun test tests/test-layout-tooling.test.ts` was **14 pass / 1 fail**
(`membership oracle > the live tree and the fixture agree entry by entry`,
`missingFromTree: ["anthropic-quorum-cache.test.ts"]`). `6580694c7` adds that file at
`tests/routing/`, so the failure is **already repaired by the drift**. If it is red after
checkout, the checkout is stale — it is not a Stack A regression.

Likewise, `bun test tests/server/<file>.test.ts` fails with *"Tests need .test..."* in a
worktree still detached at `0f27bbeb3`, because those paths only exist from `79e03643d`
onward. The verifier table in §1 lists pre-migration paths as executed; **on a checkout at
`79e03643d` or later, prefix them with `tests/server/`** — V2, V5, V6, V8.

### 0.4 State captured before the drift (still the CI evidence of record)

These are the heads and exact-head CI results the dispositions rest on. They remain valid *for
those heads*; a rebase invalidates the run and requires a fresh one.

| PR | Author | Head | Draft | +/- | Exact-head CI at capture |
|----|--------|------|-------|-----|--------------------------|
| #3515 | VXNCXNX | `4f09faf5d` | no | 87/1 | **full green** (26 checks) |
| #3525 | Ingwannu | `288506dc6` | no | 305/43 | **full green** (27 checks) |
| #3484 | Ingwannu | `a4c50d104` | no | 187/1 | **full green** (25 checks) |
| #3323 | luvs01 | `0facdae69` | no | 6/4 | **full green** (22 checks) |
| #3529 | yansigit | `4f103a1e7` | yes | 165/68 | intake only (4) |
| #3490 | yxr1995-maker | `3fbe8a2c7` | yes | 159/1 | intake only (4) |
| #3480 | benedictusrey | `74ef8faae` | yes -> **no** | 11/0 | intake only (4) |

**Three corrections to the lane docs**, all established by execution:

1. **#3480's draft state changed twice.** Lane 002 recorded non-draft; mid-session it was
   `isDraft: true`; at final re-read it is **non-draft** again with `CHANGES_REQUESTED` still
   standing. Treat only the stale review as the blocker (§3.2) and re-check draft state at P1.
2. **#3490 is NOT mergeable as-is — it fails a `dev` gate that did not exist when it was
   branched.** Overrides lane 001's clean `LAND_AS_IS`. See §3.4. Still true at
   `79e03643d`: `origin/dev:scripts/test-layout/layout.json` has **no** entry for the file.
3. **Five items are now CONFLICTING** (§0.1), which lane 001 and 002 could not have seen.

Drift/behind measurements (`git rev-list --count <head>..origin/dev`), all seven heads
fetched read-only into `refs/tmp/pr<n>`:

| PR | merge-base | behind `dev` | ahead | `pr-quality` latest-dev box (max 10 behind) |
|----|-----------|--------------|-------|---------------------------------------------|
| #3480 | `0f27bbeb3` | 1 | 1 | passes |
| #3529 | `0f27bbeb3` | 1 | 1 | passes |
| #3525 | `99fc38c39` | 3 | 1 | passes |
| #3515 | `6edc56328` | 14 | 2 | **fails** (>10) |
| #3490 | `85e42117c` | 24 | 3 | **fails** (>10) |
| #3484 | `066146980` | 28 | 1 | **fails** (>10) |
| #3323 | `ff1ac6b8c` | **152** | 2 | **fails** (>10) |

`READINESS_LATEST_DEV_BEHIND_MAX = 10` at
[pr-quality-state.cjs:26](/private/tmp/ocx-closeout.xomWAA/wt/.github/scripts/pr-quality-state.cjs:26).
This matters only for the *draft-checklist* path (§2.4): a maintainer merging directly
is not gated by it. It is recorded because an implementer who tries to drive #3323 or
#3490 through the contributor checklist will be bounced by a box the author cannot tick.

---

## 1. Loop-spec header

**Archetype.** Spec-satisfaction repair — every item's *specification* (the defect and its
regression test) is already satisfied by an open PR head. The repair is to the repository
state (the defects are live on `dev`), not to the diffs. One item (#3490) additionally
needs a one-line spec-satisfaction fix against a gate introduced after it branched.

**Trigger.** Seven open PRs are `MERGEABLE` with correct, test-backed diffs and are blocked
only on procedure: missing approval, draft status, or a stale review. Their defects are all
confirmed live on `origin/dev` = `6580694c7` (per-item evidence in §3).

**Goal.** All seven landed on `dev` by squash merge, each proven an ancestor of
`origin/dev`, with attribution preserved and a ledger row per PR in `060`.

**Non-goals.**

- No rebase, carry, or reimplementation. Any PR that turns `CONFLICTING` mid-train leaves
  Stack A and is handed to wp2 (`020`) — do not resolve conflicts here.
- No `main`/`preview` promotion, no release, no version bump.
- No repository-wide `bun run test` or bare `bun test`. Focused files only (AGENTS.md).
- No edits to `src/`, `tests/`, or `gui/` beyond §3.4's single `layout.json` line.
- No re-review of code the lanes already cleared; this phase re-verifies **state**, not merit.

**Verifier commands.** Every command below was executed in
`/private/tmp/ocx-closeout.xomWAA/wt` at `0f27bbeb3` and reads the change target of at
least one item. Exit codes are recorded as observed.

| # | Command | Reads | Observed result |
|---|---------|-------|-----------------|
| V1 | `git fetch origin dev && git rev-parse --short origin/dev` | drift | exit 0 -> `6580694c7` |
| V2 | `bun test tests/server/server-auth.test.ts` | #3515 target | file existed at `tests/server-auth.test.ts` (183327 B) pre-migration; **path moved by `79e03643d`** (§0.3) |
| V3 | `bun test tests/adapters/key-failover.test.ts` | #3529 target | file exists (11183 B); exit 0 |
| V4 | `bun test tests/responses/responses-state.test.ts` | #3525 target | file exists (159759 B); exit 0 |
| V5 | `bun test tests/server/memory-watchdog.test.ts` | #3525 second target | file existed at root (15259 B) pre-migration; **path moved** (§0.3) |
| V6 | `bun test tests/server/management-integration-journal-delete.test.ts` | #3484 target | **12 pass / 0 fail**, exit 0 (at the pre-migration root path) |
| V7 | `bun test tests/adapters/google/google-adapter.test.ts` | #3480 target | **32 pass / 0 fail**, exit 0 |
| V8 | `bun test tests/server/management-route-registry.test.ts` | #3323 target | **13 pass / 0 fail**, exit 0 (at the pre-migration root path) |
| V9 | `bun test tests/test-layout.test.ts` | #3490 gate | **2 pass / 0 fail**, exit 0 (clean dev) |
| V10 | `bun test tests/lab/core-lab-boundary.test.ts` | #3529 import-graph invariant | file exists (21129 B) |
| V11 | `gh pr checks <n>` | exact-head CI | exit 0 for all seven |
| V12 | `git merge-base --is-ancestor <squash-sha> FETCH_HEAD` | landing proof | run per merge |

`tests/codex-legacy-config-keys.test.ts` is deliberately **absent** from this table:
`ls` returns `No such file or directory` on `dev` (exit 1). It arrives with #3490 and is
only runnable after that merge — which is precisely the §3.4 finding.

**Path caveat.** V2, V5, V6 and V8 were executed at `0f27bbeb3`, where these files sat at the
`tests/` root; `79e03643d` moved all four into `tests/server/`. The table lists the
**post-migration** paths, which are the ones to use on any current checkout. Running the old
root path on a current checkout produces Bun's *"Tests need .test..."* message — that is a
wrong path, not a missing test.

**Stop condition.** All seven PRs `MERGED`, each squash SHA proven by V12, seven ledger rows
written to `060`, and `origin/dev` green. Stop early and escalate on any of: a PR flipping
to `CONFLICTING`; a required check failing on an exact head; a squash merge that does not
become an ancestor of `origin/dev`.

**This stop condition has already fired once** — `79e03643d` flipped five items to
`CONFLICTING` mid-planning (§0.1). Per the rule above that is an escalation, not something to
work around inside this work-phase. The parent decides between §0.2 option (A) author rebase
and option (B) hand the five to wp2. Until that decision, the achievable terminal state is
**2/7 merged** (#3480, #3490), which is a legitimate *partial* outcome, not a failure.

**Memory artifact.** This doc plus the merge ledger in `060` (row format in §7).

**Expected terminal outcomes.**

- *Success:* 7/7 merged, 7 ledger rows, `dev` green. **Not reachable today** — see §0.2.
- *Partial (the expected outcome as of `79e03643d`):* #3480 and #3490 merged; the other five
  carry a one-line reason (`CONFLICTING on the `server` test migration`) and a target
  (author rebase, or wp2). Partial is legitimate here — the items are independent by
  construction (§2.1), so a blocked item blocks nothing else.
- *Failure:* a merged change turns `dev` red -> revert that squash commit immediately
  (§6), do not attempt a forward fix inside this work-phase.

**Escalation.** Stop and hand back to the parent when: (a) any item needs a code change
beyond §3.4's one line; (b) a security-boundary approval is required that the operator
cannot self-grant (§6.2); (c) a contributor must act and has not (draft exit, stale-review
dismissal) — that is external coordination, not a blocker to work around.

---

## 2. Stack map (DEV-STACK-01..03)

### 2.1 There is no branch stack in this work-phase — and that is the finding

DEV-STACK-01..03 govern *dependent* work split across a chain of reviewable PRs. Stack A has
**no dependency chain**. Every item is already an open PR targeting `dev`, every one is
`MERGEABLE`, and the file sets are disjoint. Building a branch stack here would mean
re-creating seven contributor PRs as maintainer branches — discarding attribution, discarding
seven exact-head CI runs (four of them full-matrix green), and manufacturing the rebase risk
this work-phase exists to avoid.

**So Stack A is a merge train: seven direct squash merges into `dev`, ordered by risk.**
DEV-STACK-01..03 are satisfied vacuously (depth 1, no upper layers). The ordering below is a
*sequencing* discipline, not a branch topology.

Disjointness, verified from the `gh pr view --json files` output — no source file appears
in two PRs:

| PR | Source files touched |
|----|----------------------|
| #3515 | `src/server/relay.ts`, `src/server/responses/core.ts` |
| #3529 | `src/providers/key-failover.ts` |
| #3525 | `src/responses/state.ts`, `src/server/management/system-routes.ts` |
| #3490 | `src/cli/doctor.ts`, `src/codex/legacy-config-keys.ts` (new), `src/codex/project-config-warnings.ts` |
| #3484 | `src/server/management/integration-routes.ts`, 3 `gui/src/pages/integrations/` files |
| #3480 | `src/adapters/google.ts` |
| #3323 | none (test-only) |

Re-verified against `79e03643d`: for every PR, each changed **source**, **GUI**, and **docs**
path still exists on `dev` — only relocated *test* paths are missing (§0.1). This
disjointness table is therefore unaffected by the migration.

The single **near**-collision is `src/server/responses/core.ts`: #3515 edits it at line 4925.
Lane 001 flags #3502 (wp2) as also touching that file at ~3364/6693 — 1,500 lines away, and
#3502 is not in Stack A. Landing #3515 first is what makes that separation trivial, which is
why #3515 is first in the train regardless of its other properties.

Two **docs** files are shared and are append-only in both PRs, so ordering is irrelevant but
the second merge must be re-checked for mergeability:
`docs-site/src/content/docs/reference/management-api.md` is touched by **#3525** (1/-1, the
spill-health field) and **#3484** (+10, the 404 reconcile code) — different sections. Verify
with V11 after the first of the two lands; if GitHub reports `CONFLICTING`, that is a
one-hunk docs conflict and the PR leaves Stack A for wp2.

### 2.2 Merge order (risk-ascending, and why)

Ordered so that anything capable of destabilizing `dev` lands while the train is shortest,
and so that each merge's blast radius is understood before the next begins. **As of
`79e03643d` only steps 2 and 6 have a mergeable head** (§0.1); the rest of the order applies
once the five conflicting items are rebased.

| Step | PR | Why here |
|------|----|----------|
| 1 | **#3323** | Test-only, +6/-4, one file, no runtime reachability. Zero-risk train warm-up: proves the merge/ancestry/ledger loop works before any runtime change. |
| 2 | **#3480** | Smallest runtime delta in the set: one string appended to a prompt constant. No control flow. |
| 3 | **#3515** | Full-matrix green, maintainer-approved, 4 lines of runtime change — but it lands on `src/server/responses/core.ts`, the owner-only proxy-core boundary. Land it early so #3502 (wp2) rebases against a known state. |
| 4 | **#3484** | Full-matrix green, 2-line server change + GUI. Larger surface than #3515 but confined to the integrations subsystem. |
| 5 | **#3525** | Full-matrix green, but the largest diff in the train (+305/-43) and it rewrites the spill-counter shape in `src/responses/state.ts`. Land after the small items so a regression is unambiguously attributable. |
| 6 | **#3490** | Needs the §3.4 registry line before it can go green. Land after everything that is merge-ready today. |
| 7 | **#3529** | Last by risk: 429 key-failover rotation with persistence semantics, +165/-68, six test files, and **no full-matrix run has ever executed on this head**. It also adds a `src/router` import to a module on the request path — cleared by lane 001 against `core-lab-boundary`, but it is the one item whose CI evidence must be created from scratch. |

Steps 1-5 were mergeable at capture time (§0.4) and are **now blocked on a mechanical rebase**
(§0.1-0.2). Steps 6-7 always required author or maintainer action first (§2.4). Net today:
**#3480 and #3490 are executable; the other five are not.**

### 2.3 Per-PR pre-merge checks (run for every item, in this order)

```
P1  gh pr view <n> --json headRefOid,mergeable,mergeStateStatus,reviewDecision,isDraft
      -> mergeable == "MERGEABLE"; record headRefOid as HEAD_N
P2  gh pr checks <n>          -> every required check "pass" on HEAD_N; no pending, no fail
P3  gh pr view <n> --json headRefOid   -> re-read; MUST still equal HEAD_N
      (a push between P1 and P4 invalidates both the CI evidence and any ticked checklist)
P4  gh pr merge <n> --squash --admin --body-file <ledger-body>
P5  git fetch origin dev && git merge-base --is-ancestor <squash-sha> FETCH_HEAD; echo $?
      -> 0 is the landing proof; anything else stops the train
P6  append the §7 ledger row to 060
```

P3 is not ceremony. `pr-quality` resets the readiness checklist and re-drafts a PR on any new
push ([pr-quality-messages.cjs:272](/private/tmp/ocx-closeout.xomWAA/wt/.github/scripts/pr-quality-messages.cjs:272)),
so a head that moved has neither valid CI nor a valid checklist.

**On `--admin`.** `MAINTAINERS.md` records that ruleset `Protect dev` (id 20763889) requires
one approving review plus code-owner review, and that the `maintain`/`admin` role holds a
`pull_request` bypass —
[MAINTAINERS.md:172](/private/tmp/ocx-closeout.xomWAA/wt/MAINTAINERS.md:172): *"That is a
bypass, not an exemption ... an owner who uses the bypass should record it on the pull
request rather than leave it to be inferred from a merge timestamp."* Therefore **every
`--admin` merge in this train must leave a comment on the PR stating that the bypass was
used and why** (author-approval unavailable / maintainer-authorized closeout). The ledger row
(§7) carries the same fact. Squash is the correct method: rebase merges are disabled on this
repository.

**Authors do not approve their own pull requests.** #3525 and #3484 are authored by
`Ingwannu`, a maintainer — so `Ingwannu` cannot supply their approval. Those two land on the
owner's bypass or on a second maintainer's review.

### 2.4 Drafts with an 0/4 checklist

Three items are drafts: **#3529, #3490, #3480**. Their heavy CI is draft-gated — each shows
exactly `enforce-target`, `hygiene`, `label`, `resolve-pr` and a CodeRabbit *"Review skipped:
draft pull request"*. Per AGENTS.md, an empty required set is not green.

The maintainer-authorized path, which does **not** require the author to act:

```
D1  gh pr ready <n>                     # maintainer marks ready; unblocks the full matrix
D2  wait for the matrix to complete on the unchanged head:
      gh pr checks <n> --watch
D3  require: test 1/4..4/4, gates, macos, keyring x3, npm-global x3,
             storage policy, api usage, react-doctor, enforce-target, hygiene  -> all pass
D4  then run P1..P6 from §2.3
```

`gh pr ready` is the mechanism because the four-box checklist is a *contributor* gate: the
local-CI box is an author attestation the gate never disproves, and for #3490 (24 behind) and
#3323 (152 behind) the latest-dev box cannot be ticked at all under the 10-commit rule. The
maintainer marking ready and admin-merging is the authorized substitute, and it is why D2/D3
exist — **the exact-head matrix is the evidence the checklist was standing in for.** Do not
skip D3 and merge on intake checks alone.

If marking ready flips the PR back to draft (the gate re-drafts on a new push), the head
moved: return to P1.

### 2.5 Carried contributor work

**None in Stack A.** Every item merges from its own PR head, so GitHub records authorship
natively and no `Co-authored-by` trailer is required —
`missing_coauthor_credit` in `.github/scripts/pr-carry-attribution.cjs` applies to
reimplementation and carry, which this work-phase forbids (§1 non-goals).

Trailers are needed **only** on the contingency in §6.3 (a PR is closed and its content
carried onto a maintainer branch). Emails resolved now so the contingency is executable
without further lookup — `gh pr view <n> --json commits` gives the commit email; where that
email is unusable the GitHub `id` gives the canonical noreply form:

| PR | Author | Trailer to use |
|----|--------|----------------|
| #3529 | yansigit | `Co-authored-by: yansigit <44089734+yansigit@users.noreply.github.com>` |
| #3480 | benedictusrey | `Co-authored-by: benedictusrey <hartanto.benedictus.reynaldo.w0@s.mail.nagoya-u.ac.jp>` |
| #3490 | yxr1995-maker | `Co-authored-by: yxr1995-maker <257504378+yxr1995-maker@users.noreply.github.com>` (commit email is `earan@localhost`, unusable) |
| #3515 | VXNCXNX | `Co-authored-by: VXNCXNX <93332837+VXNCXNX@users.noreply.github.com>` |
| #3323 | luvs01 | `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>` |
| #3525, #3484 | Ingwannu | `Co-authored-by: Ingwannu <186453546+Ingwannu@users.noreply.github.com>` |

---

## 3. Per-item execution

Each item below states the live defect (re-verified on `6580694c7`), the file change map,
the RED/GREEN argument, the focused verifier, and accept criteria. **No file map is a work
instruction except §3.4** — for the other six the diff already exists on the PR head, and the
map is what the reviewer confirms is what merged.

### 3.1 #3515 — fix(responses): keep caller cancellations out of upstream failure logs

Head `4f09faf5d3e08275476b31f4b6a8ed30d04a8a66` · VXNCXNX · +87/-1 · 4 files · **full-matrix
green** · `bug`, `review-ready` · not draft · REVIEW_REQUIRED.
**Now `CONFLICTING`** on `tests/server-auth.test.ts` -> `tests/server/server-auth.test.ts`
(§0.1). Source files are clean; rebase per §0.2 before P1.

**Defect, live on `6580694c7`.** The inspection pump learns the client is gone only via the
listener at [relay.ts:1269](/private/tmp/ocx-closeout.xomWAA/wt/src/server/relay.ts:1269):

```ts
  clientGoneSignal?.addEventListener("abort", markClientGone, { once: true });
```

and its `catch` reaches `options.onReadError?.()` at
[relay.ts:1323](/private/tmp/ocx-closeout.xomWAA/wt/src/server/relay.ts:1323) whenever
`clientGone` is still false. Bun can settle the body read before dispatching every abort
listener, so a caller abort lands there. The call site compounds it —
[core.ts:4925](/private/tmp/ocx-closeout.xomWAA/wt/src/server/responses/core.ts:4925) passes
only the synthetic signal:

```ts
        clientGoneSignal: clientGone.signal,
```

never the inbound `options.abortSignal` available on the same object. Result: a client cancel
logs 502 and increments the account-pool failure streak.

**File change map (confirm, do not author).**

| Path | Change |
|------|--------|
| `src/server/relay.ts` | +4: treat a read rejection as a caller cancel when the inbound signal is aborted, before the `onReadError` classification |
| `src/server/responses/core.ts` | +4/-1 at ~4925: widen `clientGoneSignal` to include `options.abortSignal` (`AbortSignal.any`) |
| `tests/server-auth.test.ts` -> **`tests/server/server-auth.test.ts`** | +75: the two regressions below; re-target on rebase |
| `docs-site/src/content/docs/reference/proxy-formats.md` | +4: documents 499 vs 502 |

**Regression tests** (`tests/server-auth.test.ts`), both confirmed present in the head diff:

- `native passthrough caller abort logs cancellation without penalizing the pool` — asserts
  499, `closeReason: "client_cancel"`, `consecutiveFailures === 0`. **RED on dev**: the
  `catch` classifies the abort as an upstream fault, so the log is 502 and the streak
  increments. **GREEN after**: the inbound signal is consulted first.
- `native passthrough upstream reset still logs 502 and penalizes the pool` — asserts 502,
  `streamAborted: true`, `consecutiveFailures === 1`. Green both before and after **by
  design**: it is the negative twin proving the fix narrows classification instead of
  suppressing 502 wholesale. A merge that turns this one red is a regression, not a pass.

**Verifier.** `bun test tests/server/server-auth.test.ts` (V2; root path pre-`79e03643d`).

**Accept criteria + activation scenarios (C-ACTIVATION-GROUNDING-01).** Both branches of the
new conditional must be exercised, and both are:

| Path | Activation scenario | Expected |
|------|--------------------|----------|
| inbound signal aborted | client disconnects mid-stream | 499, `client_cancel`, streak unchanged |
| inbound signal not aborted | upstream resets the connection | 502, `streamAborted`, streak +1 |

**Docs sync.** Satisfied in-PR (`proxy-formats.md`). No locale twin required — the PR touches
only the English reference and `hygiene` passes.

**Security boundary.** `src/server/responses/core.ts` is **owner-only** in
[CODEOWNERS:46](/private/tmp/ocx-closeout.xomWAA/wt/.github/CODEOWNERS:46) (proxy-core
boundary, `@lidge-jun` alone). Not an auth/OAuth/workflow surface, so no
`maintainer-sponsored` label is needed — but the merge requires the owner, not any
maintainer. No `src/lab/` import is added; the core/lab invariant is untouched.

**PR body.** Already conformant; do not rewrite. Add only the §2.3 bypass comment at merge.

### 3.2 #3480 — fix(google): steer Google models away from unrendered LaTeX math

Head `74ef8faaed94d61835a6ffbade7bdc345829408b` · benedictusrey · +11/-0 · 2 files ·
**CHANGES_REQUESTED (stale)** · **still `MERGEABLE` after `79e03643d`** — its test lives in
`tests/adapters/google/`, an already-migrated domain, so the `server` move did not touch it.
Draft state flapped during the session and was **non-draft** at final re-read (§0.4); confirm
at P1. One of only two items executable today.

**Defect, live on `6580694c7`.** `GOOGLE_BREVITY_INSTRUCTION` at
[google.ts:49](/private/tmp/ocx-closeout.xomWAA/wt/src/adapters/google.ts:49) has four
bullets — output style, internal reasoning, tool preference, final-answer exemption — and
says nothing about math delimiters. Google models emit `$...$` / `\\(...\\)` / `\\text{}`,
which the Codex desktop renderer shows raw.

**File change map.** `src/adapters/google.ts` +1 (a fifth bullet);
`tests/adapters/google/google-adapter.test.ts` +10.

**Regression test.** `systemInstruction includes formatting guidance against unrendered
LaTeX math` — asserts `toContain` on `String.raw`does not support LaTeX math delimiters
($...$, $$...$$, \(...\), \[...\])`` and `String.raw`\text{}, \times, \le, \ge``.
**RED on dev**: I ran V7 on clean dev — **32 pass / 0 fail**, and dev's instruction contains
no LaTeX text at all, so both `toContain` calls cannot match. **GREEN after**: the bullet
supplies both substrings. The `String.raw` usage is what makes the assertion independent of
source-level escaping — which is exactly the reviewer's original objection, now moot.

**Stale review — the reason it is dismissible.** The objection was that a single-backslash
`\text{}` in a normal JS string becomes a tab at runtime. Lane 002 verified byte-exactly that
the current head uses doubled escapes and that the test asserts via `String.raw`. The
requested change is in; only the review state was never refreshed.

**Verifier.** `bun test tests/adapters/google/google-adapter.test.ts` (V7, exit 0, 32/0 on dev).

**Accept criteria + activation.** Single unconditional code path — the bullet is appended to
every `google`-adapter `systemInstruction`. No conditional, so C-ACTIVATION-GROUNDING-01 is
satisfied by the one scenario: any Google-adapter request carries the guidance; non-Google
adapters are untouched because the constant is adapter-scoped
([google.ts:47](/private/tmp/ocx-closeout.xomWAA/wt/src/adapters/google.ts:47) comment).

**Docs sync.** None. An internal prompt constant is not user-facing configuration.

**Security boundary.** `/src/adapters/` is maintainer-owned (CODEOWNERS:5), not a security
surface. No exception needed.

**Pre-merge, in addition to §2.3.** (a) `Ingwannu` dismisses the stale
`CHANGES_REQUESTED` — `gh pr review 3480 --approve` or an explicit dismissal; (b) `gh pr
ready 3480`; (c) D2/D3 full matrix. **This head has never run the shards** — it is the first
that will.

**Judgment note carried from lane 002.** This steers Google models globally, including
clients that *can* render LaTeX. The maintainer endorsed that tradeoff in-thread. Recorded,
not re-litigated.

### 3.3 #3323 — test: isolate the route scanner probe in a unique temp directory

Head `0facdae6990716c49b793df5e237ea26354262c1` · luvs01 · +6/-4 · 1 file · **full-matrix
green** · `chore`, `review-ready` · 152 behind `dev`.
**Now `CONFLICTING`**: its single file moved to
`tests/server/management-route-registry.test.ts` (§0.1). The PR's whole content is that one
file, so the rebase *is* re-applying the +6/-4 hunk at the new path.

**Defect, live on `6580694c7`.**
[management-route-registry.test.ts:125](/private/tmp/ocx-closeout.xomWAA/wt/tests/management-route-registry.test.ts:125)
still writes the probe into the repository root:

```ts
    const tmp = join(repoRoot, ".tmp-scanner-probe.ts");
```

A crash between the write and the `finally` leaves `.tmp-scanner-probe.ts` in the working
tree; concurrent runs collide on the fixed path. Target: `mkdtempSync` +
`rmSync(tempDir, { recursive: true, force: true })`, `writeFileSync` moved **inside** the
`try`, and two `require("node:fs")` calls converted to ESM imports.

**Regression test.** N/A by construction — the change *is* the test. There is no RED-on-dev
expectation; the pass/fail semantics of the suite are unchanged and only the temp-file
location moves. Accept criterion is that the suite still passes and no repo-root artifact
remains.

**Verifier.** `bun test tests/server/management-route-registry.test.ts` (V8, exit 0,
**13 pass / 0 fail** measured at the pre-migration root path). After merge, re-run and
additionally confirm `git status --porcelain | rg 'tmp-scanner-probe'` is empty.

**Accept criteria + activation.** The `finally` cleanup path is the only conditional and it
activates on both scenarios: normal completion, and a throw inside the `try` (the case the
change exists for — write failure now also triggers cleanup because `writeFileSync` moved
inside).

**Staleness note.** 152 commits behind, merge-base `ff1ac6b8c`. It stayed `MERGEABLE` for
152 commits because `dev` never touched this file — and then `79e03643d` moved it, which is
exactly the "if P1 returns `CONFLICTING`" branch this note anticipated. Its green CI (run
33717654059) remains valid for its head but a rebase invalidates it. Hand to wp2 or ask
`luvs01` to re-apply at `tests/server/`.

**Docs sync / security.** None; test-only, no runtime reachability.

### 3.4 #3490 — fix(codex): diagnose invalid persistent instructions config

Head `3fbe8a2c760016fcd7c0d8aafa0ad0fe060060a5` · yxr1995-maker · +159/-1 · 4 files ·
**draft** · intake-only CI · merge-base `85e42117c`.
**Still `MERGEABLE` after `79e03643d`** — none of its four paths moved. One of only two
items executable today, and the layout fix below is still required: re-checked at
`79e03643d`, `origin/dev:scripts/test-layout/layout.json` has **no** entry for
`codex-legacy-config-keys.test.ts`.

**Disposition change vs lane 001: LAND_AS_IS -> LAND_AS_IS + one registry line.** Lane 001
cleared this on the merits and was right about the code. It could not have caught what
follows, because the gate post-dates the PR's merge-base.

**Defect, live on `6580694c7`.** The hand-rolled TOML table matcher at
[project-config-warnings.ts:65](/private/tmp/ocx-closeout.xomWAA/wt/src/codex/project-config-warnings.ts:65):

```ts
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
```

The trailing `\s*$` rejects a trailing comment, so `[model_messages] # templates` never
matches, `current` is never switched, and every key under that header is attributed to the
document root. Target: tolerate a trailing `#` comment. Valid TOML, misparsed today.

**BLOCKER — the new test file does not resolve under `dev`'s layout guard.** The PR adds
`tests/codex-legacy-config-keys.test.ts` **at the tests root**. Between the PR's merge-base
and today, `5df664cda` introduced `tests/test-layout.test.ts`, which requires every
`*.test.ts` to resolve to a domain. Verified three ways:

1. `git cat-file -e 85e42117c:tests/test-layout.test.ts` -> **ABSENT** at the merge-base.
   The guard did not exist when this branch was cut.
2. Running the repository's own resolver against the filename:
   `resolveTarget(layout, "codex-legacy-config-keys.test.ts")` -> **`null`**, and
   `keepAtRoot` -> `false`. The `codex-integration` regex seed matches
   `^(?:active|app|bearer|catalog|combos...|native|parallel|project|...)-`; `codex-` is not a
   seed, and every existing `codex-*` file is mapped through the `explicit` map instead.
   `git show refs/tmp/pr3490:scripts/test-layout/layout.json` contains **no** entry for it.
3. **Executed the failure.** I copied the PR's test file to the tests root on clean dev, ran
   V9, and got `1 pass / 1 fail` with `unresolved` non-empty; removing the file restored
   `2 pass / 0 fail`. The worktree was left clean (`git status --porcelain` shows only the
   untracked devlog directory).

So merging #3490 unchanged turns `tests/test-layout.test.ts` **red on `dev`**. Its
intake-only CI cannot reveal this: the shard that runs the guard is draft-gated.

**File change map.**

| Path | Change | Origin |
|------|--------|--------|
| `src/codex/project-config-warnings.ts` | +1/-1 at line 65: regex tolerates a trailing comment | PR |
| `src/codex/legacy-config-keys.ts` | **new**, +66: legacy-key detection | PR |
| `src/cli/doctor.ts` | +10: surface the diagnostic | PR |
| `tests/codex-legacy-config-keys.test.ts` | **new**, +82, at tests root | PR |
| `scripts/test-layout/layout.json` | **+1 — authored in this work-phase**: `"codex-legacy-config-keys.test.ts": "codex-integration"` in the `explicit` map | **this doc** |

**The one authored line.** Add to the `explicit` object in
`scripts/test-layout/layout.json`, in its alphabetical slot among the `codex-*` keys (they
run from `codex-log-guard-*` at lines 406-415; `codex-legacy-config-keys.test.ts` sorts
immediately before `codex-log-guard-coderabbit.test.ts`):

```json
    "codex-legacy-config-keys.test.ts": "codex-integration",
```

Verified sufficient: with that entry injected, the resolver returns **`"codex-integration"`**
instead of `null`.

**Which resolution, and why this one.** Two options exist and they are not equivalent:

- *(chosen)* **Keep the file at the tests root, add the explicit entry.** `resolveTarget`
  returns `codex-integration`, which **is** in `layout.migrated`, so the guard's straggler
  rule fires for a root file resolving to a migrated domain — meaning the file must **also**
  move to `tests/codex-integration/`. Read the guard precisely: a root file whose target is a
  migrated domain is a *straggler*. So the complete fix is **entry + move**:
  `tests/codex-integration/codex-legacy-config-keys.test.ts`, with import specifiers
  rewritten one level deeper (`../src/` -> `../../src/`).
- *(rejected)* Adding the file to `keepAtRoot`. That list is for support files
  (`preload.ts`, `fake-codex-server.ts`, the layout tests themselves), not domain tests.
  Using it would satisfy the guard while lying about the file's nature.

**Therefore the authored change is: the `layout.json` explicit entry, plus the file placed at
`tests/codex-integration/codex-legacy-config-keys.test.ts` with `../../src/` specifiers.**
Ask the author to do this on their branch (preferred — keeps attribution native and the merge
a plain squash); if they do not respond, it is a two-line maintainer commit pushed to the PR
branch, which is still not a carry and still needs no trailer.

After the move, confirm the tooling oracle agrees:
`bun test tests/test-layout-tooling.test.ts` — expect **15 pass / 0 fail** on a checkout at
`6580694c7` (see §0: 14/1 at `0f27bbeb3` is the stale-checkout signature, not this change).

**Regression tests** (in the PR's new file, names read from the head):

- `a table header with a trailing comment does not leak fields into root` — **RED on dev**,
  and lane 001 isolated it by applying the test file and the new module while *withholding*
  the one-line regex fix: `5 pass, 1 fail`, `Expected length: 0, Received length: 1`. That
  isolation is what proves the regex is load-bearing rather than incidental.
- `flags top-level persistent_instructions as an unsupported legacy key`,
  `ignores a table-scoped key with the same name`, `formats one doctor line per legacy key`,
  `does not flag a clean config`, `reports unavailable when the config path is not a regular
  file` — new-module coverage; RED on dev only in the trivial sense that the module does not
  exist.

**Verifiers.**

```
bun test tests/test-layout.test.ts                              # V9 — the gate; MUST stay 2 pass / 0 fail
bun test tests/codex-integration/codex-legacy-config-keys.test.ts   # post-merge only; absent on dev (ls -> exit 1)
bun test tests/codex-integration/project-config-warnings.test.ts    # shared-parser consumer, must not regress
```

Lane 001 measured the last two together at **27 pass / 0 fail** with the full patch.

**Accept criteria + activation (C-ACTIVATION-GROUNDING-01).** The diff adds several
conditionals; each needs a named scenario:

| Conditional | Activation scenario | Expected |
|-------------|--------------------|----------|
| regex matches a commented header | `[model_messages] # templates` | section switches; root gains no key |
| regex matches a plain header | `[model_messages]` | unchanged from dev |
| top-level legacy key present | `persistent_instructions` at root | one doctor line |
| same key table-scoped | `persistent_instructions` under a table | **not** flagged |
| config path is not a regular file | path is a directory / missing | `unavailable`, check skipped, doctor still runs |
| clean config | no legacy keys | no output |

The `existsSync` + `statSync().isFile()` guard degrading to a skipped check (rather than
failing doctor) is the behavior the fifth row pins.

**Docs sync.** None required: a doctor diagnostic string is not documented configuration.

**Security boundary.** `/src/codex/` and `/src/cli/` are maintainer-owned; `src/codex/
auth-context.ts` is the only security-listed file in that tree and is not touched. `node:fs`
is acceptable here — `doctor.ts` and neighbouring `src/codex/` modules already use it, and
the Bun-native rule targets the server request path. No exception needed.

**Pre-merge.** layout fix -> `gh pr ready 3490` -> D2/D3 full matrix -> §2.3 P1-P6.

### 3.5 #3484 — fix(integrations): reconcile journal deletion cleanup

Head `a4c50d104778d2ac11fc4c91b29b3e505cb68c2a` · Ingwannu · +187/-1 · 14 files ·
**full-matrix green** (25 checks, macOS 16m1s) · `bug`, `gui-screenshot-waived` · not draft.
**Now `CONFLICTING`** on `tests/management-integration-journal-delete.test.ts` ->
`tests/server/…` (§0.1). All 13 other paths — server, GUI, and 8 locales — are clean.

**Defects, both live on `6580694c7`.**

1. Stale prune-failure marker at
   [integration-routes.ts:379](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/integration-routes.ts:379):

   ```ts
       const pruned = store.pruneSnapshots(operation.clientId);
       if (!pruned.ok) store.markPruneFailure(operation.clientId, pruned.error);
   ```

   No success branch, so a later successful prune never clears an earlier marker and
   `retentionDegraded` latches forever. It is an oversight, not a design choice: the other two
   call sites already pair the clear with the prune —
   [journal.ts:180](/private/tmp/ocx-closeout.xomWAA/wt/src/integrations/journal.ts:180) and
   [store.ts:97](/private/tmp/ocx-closeout.xomWAA/wt/src/integrations/store.ts:97).
2. `integration_operation_not_found` exists at
   [integration-routes.ts:343](/private/tmp/ocx-closeout.xomWAA/wt/src/server/management/integration-routes.ts:343)
   but no client predicate consumes it, so a second tab completing the same delete leaves the
   first tab offering a retry that can only 404 again.

**File change map.** `src/server/management/integration-routes.ts` +2/-1 (the `pruned.ok`
clear); `gui/src/pages/integrations/{IntegrationsOverview.tsx,FileIntegrationPage.tsx}` +9
each; `gui/src/pages/integrations/integration-api.ts` +7 (`isMissingJournalEntry`);
`gui/tests/integrations-surfaces.test.tsx` +69; `management-api.md` +10 in **8 locales**.

**Regression tests.**

- `tests/management-integration-journal-delete.test.ts`: `a successful delete-triggered prune
  clears an older failure marker` — marks a failure, deletes, asserts `pruneFailures.hermes`
  is `undefined`. **RED on dev**: nothing clears the marker. **GREEN after**: the success
  branch clears it. V6 on clean dev is **12 pass / 0 fail**; the merged file adds this 13th.
- `gui/tests/integrations-surfaces.test.tsx` +69 covers the 404 reconcile path.

**Verifier.** `bun test tests/server/management-integration-journal-delete.test.ts` (V6,
exit 0 at the pre-migration root path). The GUI test runs under the `react-doctor` / GUI job,
already green on the head.

**Accept criteria + activation.**

| Conditional | Activation scenario | Expected |
|-------------|--------------------|----------|
| `pruned.ok` true | delete succeeds after an earlier prune failure | marker cleared, `retentionDegraded` false |
| `pruned.ok` false | prune fails | marker set (dev behavior preserved) |
| `isMissingJournalEntry` true | second tab already completed the delete | dialog reconciles to "already gone", no retry |
| `isMissingJournalEntry` false | genuine transient error | retry still offered |

The post-commit ordering documented in the comment above line 379 is preserved — the clear is
added, the sequence is not reordered.

**Docs sync.** Satisfied: all 8 locales updated in-PR, matching the repo rule.

**Security boundary.** `/src/server/` is maintainer-owned. `integration-routes.ts` is **not**
in the auth/credential CODEOWNERS block and is not `management-auth.ts` or
`management-api.ts`, so no `maintainer-sponsored` label is required. The `gui` screenshot
gate is already satisfied by the `gui-screenshot-waived` label.

**Cross-PR note.** Shares `docs-site/.../reference/management-api.md` with #3525 (§2.1) and
`IntegrationsOverview.tsx` with #3407 (wp2, not in this train) — land #3484 first so #3407
rebases onto it.

### 3.6 #3525 — fix(responses): expose continuation spill write health

Head `288506dc6883fa8433cf89014e72d01c1675317d` · Ingwannu · +305/-43 · 8 files ·
**full-matrix green** (27 checks) · CodeRabbit "No actionable comments".
**Now `CONFLICTING`** on `tests/memory-watchdog.test.ts` -> `tests/server/…` only; its two
`tests/responses/` files and all source/docs paths are clean (§0.1).

**Defect, live on `6580694c7`.** `spillCounters` at
[state.ts:172](/private/tmp/ocx-closeout.xomWAA/wt/src/responses/state.ts:172):

```ts
const spillCounters = { writes: 0, writeFailures: 0, readFailures: 0 };
```

Three cumulative integers. An operator cannot distinguish "failed 10,000 times and is still
failing" from "failed 10,000 times an hour ago and recovered" — which is exactly the #3522
Windows report (successful spills frozen at 1,988 while failures climbed past 10,000, and
`/healthz` still reporting healthy). Observability, not a crash fix: it does **not** close
#3522, and the author says so. Do not write `Closes #3522` on this merge.

**File change map.** `src/responses/state.ts` +124/-28 (streak/last-failure shape +
`classifySpillWriteFailure`); `src/server/management/system-routes.ts` +3/-2 (expose on
`/api/system/memory`); `tests/responses/responses-state.test.ts` +124/-1;
`tests/memory-watchdog.test.ts` +26/-6; `tests/responses/continuation-dedup.test.ts` +3/-2;
`structure/05_gui-and-management-api.md` +9/-1;
`docs-site/.../reference/management-api.md` +1/-1;
`docs-site/.../troubleshooting/windows-memory.md` +15/-2.

**Regression tests**, names read from the head diff:

- `a successful spill clears a repeated failure streak without erasing the last failure`
  (`tests/responses/responses-state.test.ts`) — **RED on dev**: with three cumulative
  integers there is no streak to clear and no last-failure to retain.
- `Windows spill reports exhausted ACL retry and recovers after a healthy runner`
  (`tests/memory-watchdog.test.ts`) — RED on dev for the same reason.
- `response-state management metrics keep every added field finite scalar and privacy-safe` —
  the privacy guard on the new fields.

Lane 001 measured tests-only on clean dev at **137 pass / 6 fail**, and the full patch across
`responses-state` + `memory-watchdog` + `continuation-dedup` at **172 pass / 0 fail**.

**Verifiers.** `bun test tests/responses/responses-state.test.ts` (V4);
`bun test tests/server/memory-watchdog.test.ts` (V5, moved by `79e03643d`);
`bun test tests/responses/continuation-dedup.test.ts`.

**Accept criteria + activation.**

| Conditional | Activation scenario | Expected |
|-------------|--------------------|----------|
| spill succeeds after failures | healthy runner follows an ACL-exhausted streak | streak resets; last-failure retained |
| spill fails repeatedly | Windows ACL retry exhausted | streak increments; classification recorded |
| `cause` chain up to 4 deep | nested error carrying a path/username | collapses to the fixed 9-member enum; no message or path surfaces |
| unclassifiable failure | unknown error shape | falls to the enum's catch-all, still a scalar |

**Privacy — the reason this is safe to expose.** `classifySpillWriteFailure` walks up to four
`cause` levels and collapses everything to a fixed 9-member enum, so no message or filesystem
path can leak; the diff's own comment names the nested-`cause` username/path risk. The new
fields are scalars on the **authenticated** `/api/system/memory` and explicitly **not** on
`/healthz`. `privacy:scan` passes on the head.

**Docs sync.** Satisfied in-PR: `structure/05`, the management-API reference, and the Windows
memory troubleshooting page.

**Known non-blocking nit (do not fix here).** `windows-memory.md` adds "run `ocx observe
memory --json`". The command resolves — `observe` with a `memory` subcommand at
[registry.ts:237](/private/tmp/ocx-closeout.xomWAA/wt/src/cli/registry.ts:237) and an alias at
line 264 — but line 264's summary reads "Alias of `ocx n memory`" while the canonical name is
`observe`. **That inconsistency is pre-existing on `dev`, not introduced by this PR.** Out of
scope (§8).

**Security boundary.** `/src/server/` maintainer-owned; `system-routes.ts` is not in the
auth block. Author is `Ingwannu`, so the approval must come from the owner or a second
maintainer (§2.3).

### 3.7 #3529 — fix(providers): rebase key failover on persisted state

Head **`81e692313`** (was `4f103a1e71bd8712fc31e856ca105864811d8b7f`; the author pushed
during this session) · yansigit · +165/-68 · 6 files · **draft** · intake-only CI.
**Now `CONFLICTING`** on two moved files — `tests/server-combo-failover-e2e.test.ts` and
`tests/terminal-guard-server.test.ts`, both -> `tests/server/…` (§0.1). Its
`tests/adapters/` and `tests/providers/` files and `src/providers/key-failover.ts` are clean.
**Re-read the head before any action** — the moving head is exactly why P3 exists (§2.3).

**Defects, both live on `6580694c7`.**

1. `rotateKeyOn429` mutates the request's in-memory config and writes the whole object —
   [key-failover.ts:221-222](/private/tmp/ocx-closeout.xomWAA/wt/src/providers/key-failover.ts:221):

   ```ts
         provider.apiKey = candidate.key;
         saveConfigPreservingClaudeCode(config);
   ```

   A key deleted from the pool through the management API between request start and rotation
   is **resurrected** by that whole-object write.
2. `rotateProviderTransportOn429` at
   [key-failover.ts:280](/private/tmp/ocx-closeout.xomWAA/wt/src/providers/key-failover.ts:280)
   spreads `{ ...routedProvider, apiKey: rotated.apiKey }`, so a concurrent edit to any other
   persisted provider field is dropped on the retry. The module's own doc comment at line 176
   already warns not to assign a routed provider wholesale.

**File change map.** `src/providers/key-failover.ts` +62/-46;
`tests/adapters/key-failover.test.ts` +62/-7;
`tests/terminal-guard-server.test.ts` +33/-15 -> **`tests/server/terminal-guard-server.test.ts`**;
`tests/server-combo-failover-e2e.test.ts` +4 -> **`tests/server/server-combo-failover-e2e.test.ts`**;
`tests/adapters/openai/openai-chat-native-policy.test.ts` +2;
`tests/providers/openrouter-provider-routing.test.ts` +2.
The two `-> tests/server/` re-targets are the whole of this PR's rebase.

**Regression tests**, names read from the head diff (`tests/adapters/key-failover.test.ts`):

- `rebases over a concurrent pool edit without resurrecting a removed key`
- `inherits routed-only backfills while persisted fields stay authoritative`
- `unavailable persistence does not publish a tentative cooldown`
- `two stale handlers adopt one committed rotation without rotating twice`

Lane 001 executed the tests-only half on clean dev: **12 pass / 3 fail**, with the
persisted-field case failing `Expected: "https://api.example.com/v1" Received:
"https://registry-pinned.example/v1"` — the routed value winning over the persisted one, which
*is* defect 2. Adding the `src/` half gives **15 pass / 0 fail**. Honestly RED on dev.

**Verifier.** `bun test tests/adapters/key-failover.test.ts` (V3). Also run
`bun test tests/lab/core-lab-boundary.test.ts` (V10) — see the invariant note below.

**Accept criteria + activation.**

| Conditional | Activation scenario | Expected |
|-------------|--------------------|----------|
| key removed from pool mid-request | management API deletes the key, then a 429 rotates | removed key stays removed |
| other provider field edited mid-request | `baseUrl` changed concurrently, then a 429 | persisted `baseUrl` wins over the routed backfill |
| persistence unavailable | config write fails | **no** tentative cooldown published |
| two stale handlers race | two in-flight requests both see the pre-rotation key | one committed rotation adopted; no double rotation |

**Invariant cleared, and worth re-checking after any rebase.** The diff adds
`import { routedProviderConfig } from "../router"` to a module that
`src/server/responses/core.ts` and `compact.ts` import. Lane 001 verified `src/router.ts`
does **not** import `key-failover` (checked against router.ts:1-47), so there is no cycle,
and `tests/lab/core-lab-boundary.test.ts` passed **17/17** with the patch applied. `src/
router.ts` is one of the four owner-only proxy-core files, so if the head is ever rebased,
re-run V10 before merging.

**Docs sync.** None — internal rotation semantics, no user-facing surface change.

**Security boundary.** `/src/providers/` is maintainer-owned. Key logging stays id-only (lane
001 verified), so `privacy:scan` is unaffected. Not an auth/OAuth surface: no
`maintainer-sponsored` label needed.

**Pre-merge.** `gh pr ready 3529` -> D2/D3. This is the **highest-risk item in the train** and
the one whose CI evidence must be created from nothing: rotation + persistence semantics with
zero full-matrix history. Merge last, and treat any shard failure as a stop, not a flake,
unless the same test is independently shown failing on `dev`.

---

## 4. Field / enum chains for new config fields

**N/A for six of seven items** — #3515, #3490, #3484, #3480, #3323, #3529 add no persisted
configuration field, no serialized enum, and no new wire key. #3529 changes *how* an existing
`provider.apiKey` write is composed, not the field's shape or type.

**#3525 is the one item with a new serialized surface**, and it is a **metrics** surface
rather than a config field — nothing is read back or persisted to `config.json`, so there is
no deserialization consumer:

| Stage | Where | Note |
|-------|-------|------|
| creation | `src/responses/state.ts` — `spillCounters` gains streak / last-failure fields alongside `writes`, `writeFailures`, `readFailures` | in-memory only, process-lifetime |
| classification | `classifySpillWriteFailure` -> fixed **9-member enum** | walks <=4 `cause` levels; collapses to the enum so no message or path escapes |
| serialization | `src/server/management/system-routes.ts` -> `GET /api/system/memory` | authenticated; finite scalars only; **not** `/healthz` |
| deserialization | **none** | never parsed back; not written to `config.json` |
| consumer | operator / dashboard; documented in `structure/05` and `reference/management-api.md` | the `windows-memory.md` runbook is the human consumer |

The enum is closed by construction — that is what makes the privacy guarantee hold, and the
`...keep every added field finite scalar and privacy-safe` test is what enforces it. Any
future member must be added at the classification site and nowhere else.

---

## 5. Risk and rollback

Rollback is per-merge and uniform, because each item is one squash commit:

```
git revert --no-edit <squash-sha>     # then open the revert as a PR to dev
```

Never force-push `dev`: the `Protect dev` ruleset blocks non-fast-forward pushes and
deletion, so revert-forward is the only available path.

| Step | PR | Risk | Blast radius if wrong | Rollback |
|------|----|------|----------------------|----------|
| 1 | #3323 | **negligible** | test-only; cannot affect runtime | revert; nothing depends on it |
| 2 | #3480 | **low** | every Google-adapter request gets one extra prompt line; worst case is prompt-quality regression, not failure | revert restores the 4-bullet constant |
| 3 | #3515 | **medium** | proxy-core: a misclassification could hide a genuine 502 or mislabel a cancel | revert; the negative-twin test is the tripwire — if it goes red post-merge, revert immediately |
| 4 | #3484 | **low-medium** | integrations delete flow + GUI dialog; failure is a stuck dialog, not data loss (ordering preserved: journal retired before prune) | revert server + GUI together (one squash) |
| 5 | #3525 | **medium** | largest diff; `state.ts` is on the continuation path. A shape error surfaces as bad metrics, but the module is request-path adjacent | revert; `/api/system/memory` returns to the 3-integer shape |
| 6 | #3490 | **low** | doctor diagnostics + a shared TOML parser used by `collectProjectCodexConfigWarnings`. Parser regression would mis-attribute config keys | revert; **also** revert the `layout.json` line if it was a separate commit |
| 7 | #3529 | **highest** | 429 rotation + config persistence. A wrong rebase could drop a concurrent config edit or fail to rotate under load | revert immediately; do not forward-fix. Re-run V3 and V10 on `dev` after the revert |

**Train-level risk.** The only cross-item coupling is the two docs files in §2.1. If the
second of #3525/#3484 reports `CONFLICTING` at P1, stop that item and hand it to wp2 — do not
resolve a docs conflict inside a merge train.

### 5.1 Security-boundary items and the MAINTAINERS.md exception needed

No item in Stack A touches `src/oauth/`, `auth-cors.ts`, `management-auth.ts`,
`admin-secrets.ts`, `.github/` workflows, or release automation. **No `maintainer-sponsored`
label and no security review is required for any of the seven.** For contrast, the
`unsponsored_surface` hygiene failure that blocks #3524 (wp2) —
*"This changes an authentication, workflow, release-automation, or dependency surface"*,
[pr-hygiene.cjs:242](/private/tmp/ocx-closeout.xomWAA/wt/.github/scripts/pr-hygiene.cjs:242) —
has **no analogue here**: `hygiene` passes on all seven heads.

Two ownership constraints do apply, and they are approval routing, not security exceptions:

| Item | Path | Constraint |
|------|------|-----------|
| #3515 | `src/server/responses/core.ts` | **owner-only** ([CODEOWNERS:46](/private/tmp/ocx-closeout.xomWAA/wt/.github/CODEOWNERS:46)) — proxy-core boundary; `@lidge-jun` must approve or merge |
| #3529 | imports `src/router.ts` | `router.ts` is owner-only; the import is cleared by V10 but a rebase must re-run it |
| #3525, #3484 | authored by `Ingwannu` | *"Authors do not approve their own pull requests"* — needs the owner or a second maintainer |

Every `--admin` merge needs the bypass recorded on the PR (§2.3).

---

## 6. Contingencies

**6.1 A PR turns `CONFLICTING` mid-train.** Stop that item, leave it open, record it in the
ledger as `DEFERRED -> wp2` with the conflicting paths. Do not rebase inside this
work-phase.

**6.2 An approval cannot be obtained.** If the owner is unavailable for #3515's proxy-core
approval, or no second maintainer exists for #3525/#3484, stop and escalate (§1). Do not
widen the bypass beyond what `MAINTAINERS.md` already grants.

**6.3 A contributor is unreachable and the PR must be closed.** Only then does carry apply:
create `codex/260905-<slug>` from the PR head (`git checkout -b codex/260905-<slug>
refs/tmp/pr<n>`), keep the author's commits, add the §2.5 trailer so it survives the squash,
and open a new PR crediting the original. This is a wp2-shaped action; prefer waiting.

**6.4 `dev` goes red after a merge.** Revert that squash (§5) before merging the next item.
A red `dev` invalidates the CI evidence of every remaining head.

---

## 7. Ledger row format (for `060`)

One row per PR, appended in merge order:

```
| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof (cmd + exit) | Original closed (comment URL) |
```

- **Head merged** — the `headRefOid` confirmed at P3, not P1.
- **Ancestor proof** — `git merge-base --is-ancestor <squash> FETCH_HEAD` exit code, plus the
  `origin/dev` SHA it was checked against.
- **CI evidence** — `full-matrix green (N checks)` or `ready+matrix run <id>` for a draft
  released via D1-D3. Never `intake-only`.
- **Bypass** — `admin-squash (recorded on PR)` or `approved by <login>`.
- **Notes** — one line; for #3490 record the `layout.json` entry and the test relocation.

Worked example (illustrative shape, SHAs filled at execution):

```
| #3323 | test: isolate the route scanner probe... | luvs01 | 0facdae69 | <squash> | 0 vs <dev-sha> | full-matrix green (22) | admin-squash (recorded) | 152 behind; file untouched on dev since merge-base |
```

---

## 8. Out of scope / deferred (evidence carried from the lanes)

- **#3502** (LAND_WITH_FIX, wp2) — `CONFLICTING`; its docs prose contradicts #3520 which
  already landed, and three of its four test files no longer exist on `dev`.
- **#3519** (LAND_WITH_FIX, wp2) — both reviewer blockers are genuinely fixed, but the
  behavior change ships with no `docs-site/` update and carries an unresolved
  `CHANGES_REQUESTED`.
- **#3524** (REIMPLEMENT, wp2) — adds an unguarded `throw` on the `startServer` path,
  reproduced live as a boot failure, and is `hygiene`-blocked on `unsponsored_surface` for
  `src/oauth/index.ts`.
- **#3489, #3469** (LAND_WITH_FIX, wp2) — approved and green, but both conflict on the
  `tests/<domain>/` migration and need a mechanical test-path rebase. **`79e03643d` has now
  put five Stack A items in the same position (§0.1)** — if the parent chooses option (B),
  wp2 should handle all of them with one recipe rather than two.
- **#3407** (REIMPLEMENT, wp2) — 5 failing CI jobs on its exact head, 121 commits behind, and
  a tracked 166 KB PNG that does not belong in the tree.
- **#3388** (DEFER) — draft, 132 commits behind, shards never ran, and a 327-line stream
  rewriter lands on the protected `responses/core.ts` path with no maintainer review.
- **#3348** (REIMPLEMENT) — the 2165-line diff bundles unrelated disk persistence and a silent
  policy-fallback status change; only a classification-only subset should land.
- **The `ocx observe memory` alias-summary inconsistency** (`registry.ts:264` says "Alias of
  `ocx n memory`" while the canonical name at line 237 is `observe`) — pre-existing on
  `dev`, surfaced by #3525's docs but not caused by it; fix separately.
- **#3522 remains open after #3525 lands** — #3525 is observability only and does not fix the
  Windows spill failure it diagnoses. Do not write `Closes #3522`.

---

## 9. PR body skeleton

Stack A merges **existing contributor PRs**, so no new PR is authored and no new body is
written. Do not rewrite contributor descriptions — `enforce-target` already passes on all
seven, and editing a body can reset the readiness checklist.

The skeleton below applies **only** to the §6.3 carry contingency or to the #3490
`layout.json` fix if it is opened as its own PR rather than pushed to the author's branch.
It follows `.github/PULL_REQUEST_TEMPLATE.md` (Summary / Verification / Checklist):

```markdown
## Summary

<what changed and why, in prose; name the defect and the file:line it lives at>

| Layer | Branch | Targets | Proves alone |
|-------|--------|---------|--------------|
| 1 | codex/260905-<slug> | dev | <the single verifiable claim> |

Closes #<issue>   <!-- only if a real issue is fixed; PRs target dev, so close manually -->

## Verification

- \`bun test tests/<file>.test.ts\` — N pass / 0 fail
- \`bun run typecheck\` — exit 0
- exact-head CI: <run id>, all required checks green

## Checklist

- [x] Local CI green
- [x] Branch on the latest \`dev\` commit
- [x] Codex and CodeRabbit findings fixed
- [x] Ready for review

Co-authored-by: <login> <email>
```

For the #3490 layout fix specifically: title
`test(layout): map codex-legacy-config-keys to codex-integration`, no `Closes` line, and the
`yxr1995-maker` trailer only if it is carried rather than pushed to the author's branch.

---

## 10. Stack map table

All rows target `dev` directly — Stack A is depth-1 by construction (§2.1), so no branch
targets another PR's head. `Mergeable` is as of `origin/dev` = `79e03643d`.

| Step | PR | Branch (head) | Targets | Proves alone | Mergeable now | CI of record | Pre-merge action | Risk |
|------|----|---------------|---------|--------------|---------------|--------------|------------------|------|
| 1 | #3323 | `test/route-scanner-private-temp` | `dev` | the route-scanner probe no longer writes into the repo root | **CONFLICTING** — file moved to `tests/server/` | full green (22) | rebase test path (§0.2); then approve + admin squash | negligible |
| 2 | #3480 | `fix/google-latex-formatting` | `dev` | Google `systemInstruction` carries LaTeX-avoidance guidance | **MERGEABLE** | intake only (4) | dismiss stale `CHANGES_REQUESTED`; confirm draft state; `gh pr ready`; full matrix | low |
| 3 | #3515 | `fix/native-caller-cancel-502` | `dev` | a caller abort logs 499 without penalizing the pool, while an upstream reset still logs 502 | **CONFLICTING** — `server-auth.test.ts` moved | full green (26) | rebase test path; **owner** approval (proxy-core); admin squash | medium |
| 4 | #3484 | `ingw/fix-journal-delete-followup-3477` | `dev` | a successful prune clears a stale failure marker; the GUI reconciles a 404 | **CONFLICTING** — journal-delete test moved | full green (25) | rebase test path; owner/2nd-maintainer approval (author is a maintainer) | low-medium |
| 5 | #3525 | `fix/3522-spill-health-diagnostics` | `dev` | spill health distinguishes an active failure streak from a recovered one | **CONFLICTING** — `memory-watchdog.test.ts` moved | full green (27) | rebase test path; owner/2nd-maintainer approval; **no `Closes #3522`** | medium |
| 6 | #3490 | `fix/doctor-legacy-codex-config` | `dev` | a TOML table header with a trailing comment no longer leaks keys into root | **MERGEABLE** | intake only (4) | **add `layout.json` entry + place test at `tests/codex-integration/`** (§3.4); `gh pr ready`; full matrix | low |
| 7 | #3529 | `codex/upstream-key-failover-rebase` (head `81e692313`) | `dev` | 429 rotation rebases on persisted state instead of resurrecting a removed key | **CONFLICTING** — two `tests/server/` moves | intake only (4) | rebase both test paths; `gh pr ready`; full matrix; re-run `core-lab-boundary` | highest |

**Executable today: steps 2 and 6.** Steps 1, 3, 4, 5, 7 need the §0.2 mechanical rebase
first — author-driven (A) or handed to wp2 (B); that call belongs to the parent.
