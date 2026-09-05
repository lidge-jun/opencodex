# 007 — wp0 adversarial plan audit (A-phase, READ-ONLY)

Role: A-phase adversarial plan auditor. Skills loaded: `cxc-dev-code-reviewer`
(REVIEW-POSTURE-01, REVIEW-FALSIFY-01, REVIEW-COVERAGE-01, REVIEW-OUTPUT-01,
REVIEW-WORKTREE-01) and `cxc-search` (no external/current claim required a web tier;
all evidence is repository- and `gh`-local, which is Tier-2-equivalent primary source).

## Anchors (REVIEW-WORKTREE-01)

| Anchor | Value |
|---|---|
| `pwd -P` | `/private/tmp/ocx-closeout.xomWAA/wt` |
| Worktree `HEAD` | `0f27bbeb3ce6a92077652695e161d49b88eedc7a` (detached, unchanged; no checkout performed) |
| `origin/dev` at audit start | `79e03643d7cfa2b6c3c4eb8afd6179a140b197a3` |
| `origin/dev` at pre-verdict re-read | `79e03643d7cfa2b6c3c4eb8afd6179a140b197a3` (unchanged) |
| Index at pre-verdict re-read | nothing staged; only `?? devlog/_plan/260905_open_work_closeout/` untracked |
| Audit target | `000`, `006`, `010`, `020`, `030`, `040`, `050`, `060` (all read in full); `001`-`005` as supporting evidence |

`git merge-base --is-ancestor HEAD origin/dev` -> exit 0. The worktree is **3 commits behind**
`origin/dev` (`6580694c7`, `bdafc5191`, `79e03643d`). `git checkout` is denied in this
sandbox (`index.lock: Operation not permitted`), so verifier runs below executed at
`0f27bbeb3` and every `origin/dev` claim was checked through `git show origin/dev:<path>`,
which reads the real tip tree. This is stated because it bounds what the local runs prove.

## Coverage ledger (REVIEW-COVERAGE-01)

| Doc | Status |
|---|---|
| `000_plan.md` | reviewed (full) |
| `006_dispositions.md` | reviewed (full) |
| `010_wp1_stack_a_land_as_is.md` | reviewed (full, 1112 lines) |
| `020_wp2_stack_b_bug_carry.md` | reviewed (full, 1148 lines) |
| `030_wp3_stack_c_v2_passthrough.md` | reviewed (full, 656 lines) |
| `040_wp4_stack_d_usage_quota.md` | reviewed (full, 925 lines) |
| `050_wp5_stack_e_else.md` | reviewed (full, 1036 lines) |
| `060_ledger.md` | reviewed (full, 18 lines) |
| `001`-`005` lane docs | reviewed as supporting evidence, sampled for the claims cited below |

---

## What the audit confirmed (so the blockers are read in proportion)

This is a strong unit. Confirmed by execution, not by reading:

- **Every verifier command I sampled exists and reproduces the documented count exactly.**
  17 focused runs, zero discrepancies: `key-failover` 12, `google-adapter` 32,
  `test-layout` 2, `management-route-registry` 13, `management-integration-journal-delete` 12,
  `error-fidelity` 7, `google-errors` 10, `provider-model-discovery-contract` 36,
  `oauth-provider-reconcile` 9, `always-on-429-failover` 8, `native-codex-toggle` 6,
  `claude-cli` 34, `agent-task-recovery` 19, the `030` V2 triple 40,
  `pr-sponsored-surface.test.cjs` 7, `provider-quota` 110, `provider-account-quota` 17,
  `core-lab-boundary` 17, `kiro-stream` 113, `codex-catalog` 268,
  `provider-model-aliases` 7, `codex-routing` 168, `service` 193.
- **Every disposition defect I sampled is live on current `origin/dev`** (details in §4 below).
- **The security-gate reasoning is correct.** `RESTRICTED_PREFIXES` = `.github/workflows/`,
  `src/oauth/`; `RESTRICTED_FILES` includes `src/server/auth-cors.ts`
  ([pr-sponsored-surface.cjs:24-53](../../../.github/scripts/pr-sponsored-surface.cjs)).
  `READINESS_LATEST_DEV_BEHIND_MAX = 10` at
  [pr-quality-state.cjs:26](../../../.github/scripts/pr-quality-state.cjs). Both are cited
  accurately, including `030`'s central argument that the `auth-cors.ts` row is
  compiler-forced by `satisfies Record<keyof OcxProviderConfig, ...>` at
  [auth-cors.ts:870](../../../src/server/auth-cors.ts) — I confirmed line 870 is exactly that
  `satisfies` clause, so the gate genuinely cannot be engineered around.
- **Every carry author login resolves to a real GitHub account** (11/11 checked via
  `gh api users/<login>`), so no trailer is unresolvable in principle.
- **DIFFLEVEL-ROADMAP-01 / LEXICO-SPLIT-01 pass.** Six work-phases, six decade docs
  (`010`-`060`), numbered filenames only, no unnumbered strays.

---

## Numbered blockers

### 1. [High] The stack-shape claims in `010` are contradicted by `git merge-tree`: nine "must rebase" items merge CLEAN

**Location:** [010_wp1_stack_a_land_as_is.md:27-78](./010_wp1_stack_a_land_as_is.md) (§0.1-0.2),
restated at [010:1096-1112](./010_wp1_stack_a_land_as_is.md) (§10) and
[006_dispositions.md:81-83](./006_dispositions.md).

**Trigger:** `010` §0.1 asserts `79e03643d` "flipped five of seven items to CONFLICTING",
concludes "Stack A as specified can no longer execute end-to-end today", and reduces the
expected outcome to **2/7 merged**. That conclusion is derived from `gh`'s `mergeable` field.

**Evidence (I ran this):** `git merge-tree --write-tree origin/dev refs/tmp/pr<n>` against
the real `origin/dev` tip:

```
pr3515 CLEAN     pr3525 CLEAN     pr3484 CLEAN     pr3323 CLEAN     pr3529 CLEAN
pr3489 CLEAN     pr3444 CLEAN     pr3447 CLEAN     pr3487 CLEAN
pr3531 CLEAN     pr3528 CLEAN
pr3469 CONFLICT  (tests/server/error-fidelity.test.ts, 3-stage entry)
```

Only **#3469** actually conflicts. All five Stack A items `010` calls blocked merge clean.

**Impact:** the plan under-promises its own achievable outcome by five items and prescribes an
unnecessary rebase-or-escalate decision for the parent. It also invents a hand-rebase risk the
work-phase exists to avoid, and it burns an escalation ("this stop condition has already fired
once", [010:209-213](./010_wp1_stack_a_land_as_is.md)) on a non-event.

**Why the plan should have caught it:** `040` already documents the exact mechanism at
[040_wp4_stack_d_usage_quota.md:182-184](./040_wp4_stack_d_usage_quota.md) — *"GitHub reports
`CONFLICTING`; git does not. ... GitHub's probe skips rename detection; `merge-tree` exits 0."*
`040` applies rename-awareness to #3447; `010` and `006` do not apply it to the identical
`tests/<domain>/` rename wave, and the two docs now contradict each other on the same fact.

**Concrete fix:** in `010` §0.1/§0.2 and §10, and in the `006` drift block, replace the
`gh`-derived CONFLICTING verdict with a `git merge-tree --write-tree` result per item, using
`040`'s wording as the precedent. State that GitHub's mergeability probe is not
rename-aware and is therefore not the authority. Restore the expected terminal outcome to
7/7 (subject to draft/approval gates, which are unaffected), and keep the rebase recipe only
for #3469. Note that a squash merge through the GitHub API may still refuse a
`CONFLICTING`-flagged PR even when git can merge it — so the fix is to re-probe and, if
GitHub still refuses, use the local-merge carry path rather than the hand-rebase path.

**verification: verified**

### 2. [High] Eight documented PR heads have moved; three dispositions rest on superseded evidence

**Location:** [000_plan.md:37-68](./000_plan.md) (manifest table),
[010:33-41](./010_wp1_stack_a_land_as_is.md), [050:20-27](./050_wp5_stack_e_else.md) (D3/D4).

**Trigger:** the manifest records an exact head per PR and every decade doc keys its
RED/GREEN and CI-of-record claims to those heads.

**Evidence (live `gh pr view`, taken during this audit):**

| PR | Doc head | Live head | Also changed |
|---|---|---|---|
| #3529 | `4f103a1e7` -> `81e692313` (010 §3.7) | **`92b4eda26`** | review now `CHANGES_REQUESTED` (010 §0.1 says `REVIEW_REQUIRED`) |
| #3531 | `f486b5d60` -> `e5137f6f2` (050 D3) | **`aef450d93`** | now **non-draft**, `CHANGES_REQUESTED` |
| #3528 | `735e3f5c5` -> `f9f5f836d` (050 D4) | **`456bd8ed3`** | still draft |
| #3530 | listed OPEN in the `000` manifest | **MERGED** (`6580694c7`) | already corrected in 006/050, not in 000 |
| #3480 | `63623c640` (000) -> `74ef8faae` (010 §0.4) | `74ef8faae` | stable; 010 is right, 000 is stale |

#3529 has now moved **twice** inside this unit's lifetime, and its review decision flipped to
`CHANGES_REQUESTED` — which `010` §3.7 does not contemplate; it plans `gh pr ready` + matrix
with no review-dismissal step. #3531's `CHANGES_REQUESTED` is likewise unaddressed by E4.

**Impact:** `010` §2.3 P3 exists precisely to catch a moved head, but the *plan's* per-item
RED/GREEN analyses, trailer table, and CI-of-record rows are keyed to heads that no longer
exist. An implementer following `010` §3.7 or `050` E4 literally will merge against evidence
that was never produced for the current head.

**Concrete fix:** add a "head as of" column with the live SHA to the `000` manifest and mark
#3530 MERGED there; re-read #3529/#3531/#3528 heads and re-state their review decisions; add
an explicit review-dismissal or re-review step to `010` §3.7 and `050` E4 for the new
`CHANGES_REQUESTED` state. Per `050`'s own standing instruction
([050:29-31](./050_wp5_stack_e_else.md)), treat every SHA as a checkpoint — apply that rule to
`000` and `010`, which currently do not carry it.

**verification: verified**

### 3. [Medium] `050` E0's patch anchors are stale: the target test sits at :144, not :122, and the quoted import line is wrong

**Location:** [050_wp5_stack_e_else.md:212-257](./050_wp5_stack_e_else.md).

**Trigger:** E0 quotes `tests/routing/anthropic-quorum-cache.test.ts:122-134` as "current code
on `dev`" and prescribes an import edit at `:27`.

**Evidence:** on `origin/dev` (`79e03643d`) the removal test begins at **line 144**, not 122;
line 122 is now `test("a stale quorum cannot dispatch on a reauth-flagged account")` — added
by `bdafc5191` (#3533). The import at `:27` is already
`import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";`,
not the two-symbol form the doc shows, so the prescribed `-`/`+` pair will not apply. The
sibling test E0 cites as its unchanged-behavior guard is at `:157`, not `:136-147`.

**Falsification attempt:** the doc's quoted body *is* byte-exact at `6580694c7`, so this is
drift, not fabrication — and `050` §0 does claim plan-time tip `79e03643d`. The anchors were
simply not re-read after `bdafc5191` landed. **The defect itself is real and still live:** the
merged test at `:144-155` calls `clearAnthropicSessionAffinityForAccount` without
`removeAccount`, so the roster is never reduced and the named transition is unobservable.
`removeAccount` exists at [src/oauth/store.ts:899](../../../src/oauth/store.ts) with the
documented signature, and the DELETE route does call `removeAccount` first
([oauth-account-routes.ts:550](../../../src/server/management/oauth-account-routes.ts)), so
E0's reasoning survives. Only the anchors fail.

**Concrete fix:** re-quote the block from `origin/dev` at `:144-155`, change the import edit
to add only `removeAccount` to the existing three-symbol import at `:27`, and re-point the
sibling-guard citation to `:157`.

**verification: verified**

### 4. [Medium] Two conflicting `Co-authored-by` forms for the same author, and one that credits nobody

**Location:** [020:243](./020_wp2_stack_b_bug_carry.md), [020:248](./020_wp2_stack_b_bug_carry.md),
[050:178](./050_wp5_stack_e_else.md) vs [010:378](./010_wp1_stack_a_land_as_is.md).

**Trigger:** `AGENTS.md` "Landing another author's work" and `missing_coauthor_credit`
([pr-carry-attribution.cjs:212](../../../.github/scripts/pr-carry-attribution.cjs)) make the
trailer the load-bearing artifact; GitHub matches it to an account by **email**, not login.

**Evidence:** the unit prescribes two different addresses for `Ingwannu`:

- `010:378` -> `Ingwannu <186453546+Ingwannu@users.noreply.github.com>` — the canonical
  `<id>+<login>@users.noreply.github.com` form. `gh api users/Ingwannu` -> id **186453546**, so
  this one resolves.
- `020:243`, `020:601`, `020:668`, `050:178`, `050:387` -> `Ingwannu
  <ingwannu@users.noreply.github.com>` — the **id-less** form. GitHub only links the id-less
  variant for accounts created before the ID-prefixed scheme; for a modern account
  (id 186453546) it does not attach to the contributor graph, which is exactly the
  `CREDITS.md` failure mode this repository documents.
- `020:248`/`020:351` -> `Flowershangfromthebranches <flowershangfromthebranches@users.noreply.github.com>`
  — same id-less problem; the real id is **152056395**.

`020:251-256` correctly diagnoses that #3489's commit email `<opencodex-fix@local>` credits
nobody and says "use the `@users.noreply.github.com` form above, which resolves by login" —
that premise is wrong for id-less addresses.

**Impact:** a carry landed with the id-less trailer satisfies the `hygiene` regex (it only
looks for the trailer) while still crediting nobody — the precise outcome `CREDITS.md` exists
to prevent, dressed up as compliance.

**Concrete fix:** normalize every trailer in `020` and `050` to the ID-prefixed form used in
`010`: `Ingwannu <186453546+Ingwannu@users.noreply.github.com>`,
`Flowershangfromthebranches <152056395+Flowershangfromthebranches@users.noreply.github.com>`.
All eleven logins resolve (`gh api users/<login>`), so every carried item has a resolvable
identity once the form is fixed. Correct the "resolves by login" sentence at `020:254`.

**verification: verified**

### 5. [Medium] `050` E4's `Co-authored-by` name and #3329's authorship gate are inconsistent with the DEFER decision

**Location:** [050:181-188](./050_wp5_stack_e_else.md), [006:89-91](./006_dispositions.md).

**Trigger:** E4 prescribes `Co-authored-by: benedictusrey888 <hartanto...@s.mail.nagoya-u.ac.jp>`
while `010:374` uses `benedictusrey <hartanto...>` for the same person, and `gh` reports the
PR author login as `benedictusrey` (id 74437942).

**Evidence:** `gh api users/benedictusrey888` was **not** resolvable in my checks as a distinct
account from `benedictusrey`; the login that owns #3531 and #3528 is `benedictusrey`. The
doc's own justification ("that is what the contributor graph keys on") is right about commit
identity but the graph keys on the **email**, which is identical in both rows — so the display
name difference is cosmetic while the login mismatch invites a wrong trailer.

Separately, `006:89-91` records #3329 as `LAND_WITH_FIX pending ... if authorship can be
resolved via the PR author login; else DEFER`, while `050` §6 and the `006` Family-4 table
list it as a straight `LAND_WITH_FIX ... wp5` and then as deferred. The `Counts` line
(`006:76`) tallies `LAND_WITH_FIX 13 · DEFER 10`, which cannot be true under both readings.

**Concrete fix:** use one identity per author across the unit (`benedictusrey` + the Nagoya
address, or the ID-prefixed noreply form). Resolve #3329 to a single disposition and make the
`Counts` line match; `gh` shows #3329 author `Veritas-7`, so the "resolve via PR author login"
branch is decidable now rather than left conditional.

**verification: verified**

### 6. [Low] `060` is a bare skeleton with no per-work-phase rows, so wp6's stop condition is unfalsifiable

**Location:** [060_ledger.md:1-18](./060_ledger.md).

**Trigger:** `000:31` assigns wp6 "PR/issue closure, merge ledger, unit to `_fin`", and every
decade doc names `060` as its memory artifact.

**Evidence:** `060` is 18 lines: a header, an empty table, "(none yet)", and a verifier-policy
paragraph. It carries no row template beyond the header, no per-item closure list, and no
`_fin` move criteria — while `010` §7 defines a **nine**-column row format
(`| PR | Title | Author | Head merged | Squash SHA | Ancestor proof | CI evidence | Bypass | Notes |`)
that does not match `060`'s **eight**-column header
(`| WP | Item | Carry branch / PR | Head SHA | CI run | Landing SHA | Ancestry proof | Original closed |`).

**Impact:** two incompatible row schemas means the ledger cannot be appended consistently, and
wp6 has no written completion criteria — unlike wp1-wp5, which all have explicit stop
conditions. This is a diff-level gap in the one doc that is supposed to prove the campaign
finished.

**Concrete fix:** reconcile the two schemas into one, list the expected closure comments
(#3522 stays open, #3467/#3406 close with landing SHA, #3462 do-not-auto-close, #3424 closes
with `878f75417`, #3528 supersession) as unchecked rows, and write wp6's stop condition and
`_fin` move criteria explicitly.

**verification: verified**

---

## Audit checks that PASSED

**PLAN-VERIFIER-REAL-01 — PASS.** I ran 23 verifier commands across all five decade docs
(>=3 per doc as required). Every one exists, reads the change target, and reproduces the
documented count exactly. Sampled: `010` V3/V6/V7/V8/V9; `020` V1-V8;
`030` V1/V2/V4 plus the `auth-cors.ts:870` `satisfies` anchor; `040` V1/V2/V3;
`050` five of six E-layer verifiers. Two documented-environment-red verifiers reproduce as
documented: `040` V4 exits 1 in-sandbox (EADDRINUSE) exactly as
[040:76-79](./040_wp4_stack_d_usage_quota.md) predicts, and `050`'s quorum verifier is
unrunnable at the worktree's older HEAD but the file exists on `origin/dev`. Both docs flag
these as hosted-CI-only and explicitly warn not to read them as regressions — correct, and
`040:86-88`'s warning that a piped `bun test` masks the exit status is a genuinely good catch.

**PHASE-SPLIT-01 / DIFFLEVEL-ROADMAP-01 / LEXICO-SPLIT-01 — PASS.** Six work-phases, six
decade docs, all numbered. The map is dependency-ordered, not effort-bucketed: wp1 (clean
merges) -> wp2 (carries touching `core.ts`, ordered after wp1's #3515 lands there) -> wp3
(#3444 first because #3447/#2783/#2973 add fields to the same schema objects) -> wp4 (#3447
before #2783 because both restructure `quota.ts`) -> wp5 (independent residue) -> wp6. Each
ordering claim is justified by a **shared file**, and I verified the key ones
(`core.ts` line separation ~4925 vs ~3380/6693; `quota.ts` shared by #3447/#2783).

**DEV-STACK-01..03 — PASS on shape, with blocker 1 as the caveat.** `010` §2.1 correctly
refuses to manufacture a branch stack for seven independent PRs and justifies it (disjoint
file sets, verified — no source file appears in two Stack A PRs). `030` §2 correctly refuses
to split #3444, and proves it: a lower `auth-cors.ts`-only layer **does not typecheck**
because of the `satisfies` constraint. `050` §2 correctly declines to stack seven items with
a measured zero-overlap file matrix. `020` and `040` do build real chains, each justified by
a shared file (`src/oauth/` + `core.ts` for B1->B2; `quota.ts` for layer 1->2). Base refs form
valid bottom-up chains and stacked children target the parent head per `AGENTS.md`. No
independent item is falsely stacked and no stacked item is falsely independent.

**Disposition sanity — PASS (>=6 LAND + >=3 DEFER sampled).** Verified live on `origin/dev`:
#3515 (`relay.ts:1269` listener and `:1323` `onReadError` both present; `core.ts` passes only
`clientGoneSignal: clientGone.signal`); #3525 (`state.ts:172` is exactly the three-integer
`spillCounters`); #3490 (`project-config-warnings.ts:65` regex ends `\\s*$`, so a trailing
comment misparses — and `layout.json` still has **no** `codex-legacy-config-keys` entry, with
`codex-integration` in `migrated`, so the §3.4 entry+move finding holds); #3484
(`integration-routes.ts:379` has the `if (!pruned.ok)` with no success branch; `:343` has
`integration_operation_not_found`); #3480 (`GOOGLE_BREVITY_INSTRUCTION` is adapter-scoped per
the `:47` comment and contains no LaTeX guidance); #3323 (the repo-root
`.tmp-scanner-probe.ts` write is live, at `:126` — doc says `:125`, a one-line drift);
#3444 (`config.ts` and `auth-cors.ts` rows byte-exact as quoted); #3464
(`service.ts:66` bakes package-local paths); #3425 (`isTerminalShortWindow` at
`codex/routing.ts:409`). DEFERs: #3388 **135** behind (doc says 132), #2956 **477** (doc says
474), #3383 **124** (doc says 121), #2716 **121** (doc says 118) — all four drifted by exactly
the 3 commits `origin/dev` advanced, which is internally consistent and does not change any
rationale. #3508's `logs-filter.ts` is indeed absent from `dev` and `Logs.tsx` contains only
CSS-class matches for `logs-filter`, never an import — the "unreachable duplicate" DEFER holds.

**Security boundary — PASS.** Items touching restricted surfaces are correctly identified and
the `MAINTAINERS.md` routing is named where it applies: #3524 and B1 (`src/oauth/`), #3444
(`src/server/auth-cors.ts`). `030` §1 explicitly forbids routing around the gate by splitting
`auth-cors.ts` into its own PR, citing the gate's stated purpose — correct, and it is
reinforced by the typecheck proof. `010` §5.1 correctly finds **no** Stack A item touches a
restricted surface and distinguishes CODEOWNERS approval routing (`core.ts`, `router.ts`
owner-only — verified at [CODEOWNERS:46](../../../.github/CODEOWNERS)) from a security
exception. The `--admin` bypass discipline quotes `MAINTAINERS.md` accurately ("That is a
bypass, not an exemption") and requires it recorded on the PR. "Authors do not approve their
own pull requests" is correctly applied to `Ingwannu`'s #3525/#3484.

**C-ACTIVATION-GROUNDING-01 — PASS.** Every conditional path the plans add carries a named
activation scenario in a table, and both branches are named rather than just the positive one:
#3515 (2 rows, including the negative twin that must stay green — the doc explicitly says a
merge turning it red is a regression); #3490 (6 rows, including the `existsSync`+`isFile`
degrade-to-skip path); #3484 (4); #3525 (4, including the `cause`-chain depth-4 case); #3529
(4); #3489 (9 rows for the new security-relevant exception, including fail-closed default,
DNS-rebind mixed answers, and the literal-`198.18.x.x` gate). I found **no
unreachable-by-construction branch**: the one branch that is unreachable by design —
`providerOutboundPost`'s non-HTTPS rejection after the URL is pinned to a constant
([040:274-277](./040_wp4_stack_d_usage_quota.md)) — is explicitly called out as unreachable
"which is the point", rather than presented as live coverage.

**PLAN-FIELD-CHAIN-01 — PASS.** The one genuinely new config field in the unit,
`allowEncryptedV2AgentTasks`, has its full chain enumerated in `030` §3.1: declaration
(`src/types/provider.ts`), serialization/validation (`src/config.ts` Zod row, `.optional()`
with no `.default()` — correctly identified as what makes it default-off at the
deserialization boundary), policy (`auth-cors.ts` row), consumer
(`canPassThroughEncryptedV2AgentTask` + two call sites in `core.ts`), and docs. `010` §4
correctly distinguishes #3525's **metrics** surface from a config field and explains why the
deserialization stage is legitimately "none" (never parsed back, never written to
`config.json`). Both are honest chains, not checkbox-filling.

---

## blocking_issues

| # | Severity | Summary | Location |
|---|---|---|---|
| 1 | High | `merge-tree` contradicts the CONFLICTING claim; 9 items merge clean, plan under-promises 5 landings | 010 §0.1-0.2, §10; 006 drift block |
| 2 | High | 8 documented PR heads moved; #3529/#3531 now `CHANGES_REQUESTED` with no dismissal step; #3530 still OPEN in the 000 manifest | 000:37-68; 010 §3.7; 050 D3/D4 |
| 3 | Medium | E0 patch anchors stale (`:122` -> `:144`), quoted import line no longer exists | 050:212-257 |
| 4 | Medium | Id-less `Co-authored-by` addresses credit nobody while passing the hygiene regex | 020:243/248/601/668; 050:178/387 |
| 5 | Medium | Conflicting author identity for #3531; #3329 disposition and `Counts` line self-contradict | 050:181-188; 006:76, 89-91 |
| 6 | Low | `060` ledger schema conflicts with 010 §7 and has no wp6 stop condition | 060:1-18 |

Blockers 1 and 2 are High: each would cause an implementer to act on false state — one by
abandoning five landable merges, the other by merging against evidence produced for a head
that no longer exists. Both are fixable by re-running two commands
(`git merge-tree --write-tree`, `gh pr view --json headRefOid,reviewDecision`) and editing
prose; neither invalidates the unit's research, its verifiers, or any disposition.

**Verdict:** the plan's substance is sound and unusually well-evidenced — the defects are
real, the verifiers are real and reproduce, the security reasoning is correct, and the
stack shapes are justified rather than assumed. What fails is **freshness**: the unit was
written across three `origin/dev` moves and two PR-head moves, and its state layer did not
keep up with its analysis layer. Fix the six items above and this is ready to execute.

VERDICT: GO-WITH-FIXES (blockers=6)

---

## Round 2

Re-audit of the round-1 blockers against `008_audit_synthesis.md` and the amended docs.

| Anchor | Value |
|---|---|
| `pwd -P` | `/private/tmp/ocx-closeout.xomWAA/wt` (HEAD `0f27bbeb3`, detached, unchanged) |
| `origin/dev` round 1 | `79e03643d` |
| `origin/dev` round 2 (start and pre-verdict re-read) | **`6d9639165`** — one new commit, `docs(layout): closeout ... (#3534)`; delta to `src`/`tests`/`gui`/`scripts` is two one-word edits (`scripts/test.ts:463`, `tests/test-layout-tooling.test.ts:271`). No plan file:line is affected. |
| Index at pre-verdict re-read | nothing staged; only the untracked plan directory |
| Interdiff reviewed | 008 (new), banners atop 010/020/050, 060 schema, 000 #3530 row |

The `git merge-tree` re-probe was re-run against `6d9639165` for all 26 heads. **008's table
is exact**: CLEAN for 19, CONFLICT for #3502 (20 docs-site locale files + 2 tests), #3469
(`tests/server/error-fidelity.test.ts`), #3388, #3348, #2956, #2783, #2973. Note for future
re-probes: inside the sandbox `merge-tree` fails with `unable to create temporary file`
(exit 128) — that is not a conflict (exit 1) and must not be read as one.

### Per-blocker status

**1 — mergeability (High) → FOLDED.** Banner atop
[010:1](./010_wp1_stack_a_land_as_is.md) supersedes §0.1-0.2/§10 and restores 7/7;
[020:1](./020_wp2_stack_b_bug_carry.md) narrows the rename recipe to #3469. 008's fallback
(rename-aware `git merge origin/dev` onto the head, never a hand file-move) is the right
one. The body text at 010:78, :215, :221, :1113 still says 2/7 — acceptable under the
banner convention, since the banner names the superseded sections explicitly.

**2 — head drift (High) → FOLDED.** [000:58](./000_plan.md) now reads `14fbbd187 → MERGED
6580694c7`. 008's live-head table matches `gh` today (#3529 `92b4eda26`, #3531
`aef450d93`, #3528 `dad2112a1` — #3528 moved once more since round 1, and 008 already has
the new SHA). The per-item "re-read `headRefOid` before any merge/carry" rule is in 008
rather than in 010 §3.7's body, and the banner points there; sufficient. One observation for
the implementer, not a blocker: #3529's two `CHANGES_REQUESTED` reviews (Ingwannu) were
submitted against `8b0327f4b`, two pushes ago — so "stale on the new head" is the likely
branch of 008's dismiss-or-fold rule, but it has to be checked, not assumed.

**3 — E0 anchors (Medium) → FOLDED.** [050:1](./050_wp5_stack_e_else.md) + 008 relocate to
`:144`; confirmed on `6d9639165` (`:144` is the removal test, `:151` the affinity-only
clear). The `rg` re-anchor instruction is the right shape for a moving file.

**4 — Co-authored-by form (Medium) → FOLDED.** 008 forbids the id-less form unit-wide. The
id-less rows still sit in the bodies (020:245, :250, :353, :603, :670; 050:180, :389) — a
copy-paste hazard, but the banner on both docs states the rule, and the resolved form for
Ingwannu is already written down (010:378). Accepting; the rows should be cleaned when
those docs are next touched.

**5 — #3531 identity + #3329 disposition (Medium) → split.**

*#3531 half: REBUTTED-ACCEPTED, with a correction to round 1.* I wrote that
`benedictusrey888` "was not resolvable as a distinct account". That was wrong:
`gh api users/benedictusrey888` → id **192305729**, a real account distinct from
`benedictusrey` (74437942), and `gh pr view 3531 --json commits` shows the Nagoya email
is *already linked* to login `benedictusrey888`. So 050:183's trailer credits a real
account, and 050:185-186's reasoning ("use the commit identity") was correct as written.
008's amendment resolves the trailer to the *PR-opener* login instead; that also credits a
real account. Either is defensible; the commit-linked email is the one GitHub will match
without any lookup. Not a blocker. If the maintainer wants both accounts credited, two
trailers are legal.

*#3329 half: STILL OPEN (Medium).* 008 §5 decides "single disposition = LAND_WITH_FIX, wp5
layer E7", but the amendment stops at the banner. Remaining gaps, each verified:

- **No E7 exists.** `rg -n 'E7' 050_wp5_stack_e_else.md` matches only the banner (050:1).
  There is no file change map, conflict recipe, regression test, activation table, verifier
  list, or PR skeleton — the things DIFFLEVEL-ROADMAP-01 requires of every landing and that
  E0–E6 all have.
- **050's body still says DEFER in three places** ([050:113](./050_wp5_stack_e_else.md)
  "4 deferrals (#3508, #3383, #2716, #3329)", [050:188](./050_wp5_stack_e_else.md)
  "deferred in section 6, not landed here", [050:1024](./050_wp5_stack_e_else.md) "**DEFER
  from wp5** (was LAND_WITH_FIX)" with a good argument for deferring). The banner asserts
  the opposite without engaging that argument.
- **The one named verifier does not exist.** 008:80 cites
  `tests/core-lab-boundary.test.ts`; on `origin/dev` that path is absent — the file is
  `tests/lab/core-lab-boundary.test.ts`. PLAN-VERIFIER-REAL-01 fails for E7 as written.
- **The "semantic conflict" premise is not what git reports.** `git merge-tree --write-tree
  origin/dev refs/tmp/pr-3329` → **CLEAN** (tree `47cc7a46b`). 006:89 and 050:1024 both
  describe a hand re-resolution of `src/server/responses/core.ts`; the ten `core.ts` hunks
  (`@@ -67`, `-1472`, `-1639`, `-2290`…`-2569`) auto-merge. That does not make the
  change *safe* — 138 commits of drift under a protected core path still warrants the
  lab-boundary verifier and a real review — but it is the same probe-vs-git error class as
  blocker 1, and the plan should say what is actually true. Separately, #3329's four test
  files are at pre-migration root paths (`tests/combos.test.ts`,
  `tests/server-combo-failover-e2e.test.ts`, …); a pick must not recreate them at root or
  the duplicate-basename gate fires (040 §3.1 already documents this trap for #3447).
- Authorship is resolvable now: `Veritas-7` → id **234569343**, so
  `Co-authored-by: Veritas-7 <234569343+Veritas-7@users.noreply.github.com>` is available.
  The lane's High correctness finding (reset metadata dropped for body-confirmed quota
  inside 5xx) is still present on the PR head at `core.ts:1645-1647`
  (`...(!cyberFailure && (response.status === 429 || response.status === 402) ? {resetAt} : {})`),
  so the LAND_WITH_FIX fix list from lane 004 is still the right starting point.

**Concrete fix (either branch closes this):** (a) write E7 into 050 §3 at the same depth as
E0–E6 — file map from the lane's fix list, the `core.ts` merge verified by
`bun test tests/lab/core-lab-boundary.test.ts` plus `tests/routing/combo-management-api.test.ts`
and `tests/server/server-combo-failover-e2e.test.ts` (hosted-CI-only per 020), the
Veritas-7 trailer, and a root-file check after the pick — and change 050:113/:188/:1024 to
match; **or** (b) keep 050's own DEFER argument, revert 008 §5 to DEFER, and correct
006:76 to `LAND_WITH_FIX 12 · DEFER 11`. The plan must not carry both.

**6 — ledger schema + wp6 stop condition (Low) → STILL OPEN (Low).** 060 now has a
nine-column header ([060:6](./060_ledger.md)) and it matches 008 §6 — good. But 008:85
says this is "the nine-column form from 010 §7", and it is not: 010 §7
([010:1008](./010_wp1_stack_a_land_as_is.md)) still specifies
`PR | Title | Author | Head merged | Squash SHA | Ancestor proof | CI evidence | Bypass | Notes`,
a different nine columns, and 010 carries no banner about it. Two schemas still coexist,
and the wp6 stop condition lives only in 008 — `rg -in 'stop condition|_fin|privacy:scan'
060_ledger.md` returns nothing. **Fix:** one line in 010 §7 deferring to 060's header, and
paste 008 §6's stop condition into 060 so the ledger doc is self-describing.

### Summary

| # | Round 1 | Round 2 status | Residual severity |
|---|---|---|---|
| 1 | High | FOLDED | — |
| 2 | High | FOLDED | — |
| 3 | Medium | FOLDED | — |
| 4 | Medium | FOLDED | — |
| 5a | Medium | REBUTTED-ACCEPTED (my evidence was wrong; 050's trailer is valid) | — |
| 5b | Medium | STILL OPEN — E7 has no plan body, 050 contradicts itself, verifier path wrong, conflict premise false | Medium |
| 6 | Low | STILL OPEN — 010 §7 schema not reconciled, stop condition not in 060 | Low |

No High remains. One Medium (5b) and one Low (6), both docs-only edits in the same unit.

VERDICT: GO-WITH-FIXES (blockers=2)
