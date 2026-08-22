# 000 — Research: open bug-PR backlog inventory, rubric, and disposition

Unit: 260820_bug_pr_backlog_consolidation
Work-phase: wp1 (docs-only roadmap cycle, LOOP-DOCS-FIRST-01)
Baseline: origin/dev = ceac592d7. Worktree branch codex/fix-subagent-roster-truncation (PR #2134).

Evidence for every claim below came from six read-only xai/grok-4.6 investigation lanes that
read the actual PR diffs with `gh pr diff` and cross-read the runtime in this worktree. Code
edits stay in the main agent.

## 1. Inventory

27 open bug-labeled PRs; 25 authored by someone other than lidge-jun. 17 open bug issues.

| PR | Author | Draft | Subsystem | Files |
|---|---|---|---|---|
| 2131 | bet4it | no | responses id backfill | server/responses |
| 2127 | agentHits | yes | antigravity thought_signature | adapters/google |
| 2115 | louis-tepe | no | adapter prompt nudge | adapters/* |
| 2110 | drakonkat | no | antigravity baseUrl override | providers/registry, lib/destination-policy |
| 2109 | drakonkat | no | anthropic baseUrl override | providers/registry, lib/destination-policy |
| 2105 | lilinxiong | no | claude shell hook | cli/index, server/system-env |
| 2104 | olddonkey | no | xai OAuth responses streaming | adapters/xai |
| 2102 | lilinxiong | no | gpt-5.6 prompt_cache_retention | adapters/openai-responses |
| 2101 | Ingwannu | no | account entitlement gating | codex/catalog |
| 2100 | ntdatt812 | no | routing capability evidence | routing/capability |
| 2099 | yzxcj797 | yes | gpt-5.6 prompt_cache_retention | adapters/openai-responses |
| 2091 | luvs01 | no | prompt_cache_retention (all forward) | adapters/openai-responses |
| 2082 | yzxcj797 | yes | AgentRouter language preamble | adapters |
| 2077 | ntdatt812 | no | lab behavior overrides | routing/compatibility/behavior |
| 2075 | olddonkey | no | Fast gate native chat (CONFLICTING) | adapters/openai-chat |
| 2067 | waw4303 | yes | opencode-free headers | providers/registry |
| 2063 | yzxcj797 | yes | K12 detail.code denials (CONFLICTING) | codex/quota-rejection |
| 2062 | yzxcj797 | yes | K12 short-window quota | codex/quota, codex/routing |
| 2056 | Ingwannu | no | K12 short-window quota | codex/quota, codex/routing |
| 2054 | keepitmello | yes | cursor checkpoints (CONFLICTING) | adapters/cursor |
| 2053 | Ingwannu | no | superseded OAuth commits | oauth/* |
| 2040 | Ingwannu | no | routed tool_search passthrough | server/responses |
| 2032 | yzxcj797 | yes | claude root bypass | cli/claude |
| 2029 | yzxcj797 | yes | probe session bus absent | service-manager-probe |
| 2027 | yzxcj797 | yes | opencode-go quota gating | providers/quota |

## 2. Scoring rubric

Score = severity (0-35) + blast radius (0-25) + evidence quality (0-20) + fix tractability (0-20).
Threshold for this campaign: **>= 60**.

- severity: does it break a core path (routing, auth, streaming, config persistence) for a
  default configuration, or is it peripheral/cosmetic?
- blast radius: how many users/configurations does the defect reach?
- evidence quality: deterministic reproduction with logs/curl, or assertion?
- fix tractability: is a correct, testable fix small and self-contained?

## 3. Scores and disposition

| Item | Score | Disposition |
|---|---|---|
| Issue #2132 bearer admission forces ChatGPT credential | 96 | ABSORB — no PR exists; highest-value gap in the backlog |
| Issue #2092 / PRs #2102,#2099,#2091 prompt_cache_retention | 86 | ABSORB #2102 as base; supersede #2099, #2091 |
| Issue #2114/#1939 / PR #2029 probe bus | 80 | SUPERSEDED by maintainer PR #2130 (already open) |
| PR #2131 responses output id backfill | 80 | ABSORB |
| PR #2100 routing capability evidence | 80 | ABSORB |
| PR #2047 / #2056 + #2062 K12 short-window quota | 72 | ABSORB #2056; supersede #2062 |
| PR #2053 superseded OAuth credential commits | 72 | KEEP — C4 auth, needs human security review (MAINTAINERS.md) |
| PRs #2109 + #2110 baseUrl override | 68 | HOLD — unresolved security gap, see §6 |
| PR #2101 account entitlement gating | 64 | KEEP — large (20 files), needs its own cycle |
| PR #2077 lab behavior overrides | 62 | ABSORB |
| PR #2040 routed tool_search passthrough | 62 | KEEP — 14 files, own cycle |
| PR #2105 claude shell hook | 60 | ABSORB |
| PR #2063 K12 detail.code | — | SUPERSEDED by already-merged #2055 |
| PR #2115 code mode nudge | 54 | BELOW THRESHOLD — contracts native-OpenAI detection; needs human adapter pass |
| PR #2082 AgentRouter language | 54 | BELOW THRESHOLD |
| PR #2027 opencode-go quota | 56 | BELOW THRESHOLD |
| PR #2067 opencode-free headers | 50 | BELOW THRESHOLD |
| PR #2054 cursor checkpoints | 46 | BELOW THRESHOLD — hypothesis pending wire trace |
| PR #2032 claude root bypass | 46 | BELOW THRESHOLD — maintainer already rejected the default |
| PR #2104, #2075, #2127 | n/a | Deferred: #2075 and #2054 are CONFLICTING; #2127 is an active draft by its author |

## 4. Duplicate clusters (evidence-backed)

**prompt_cache_retention (issue #2092).** #2102 gates on `forward && isCanonicalOpenAiForwardProvider`
and matches `gpt-5.6` / `gpt-5.6-*`. #2099 uses a looser `startsWith("gpt-5.6")` on ANY forward
provider and carries a stray package.json 2.24.2 -> 2.25.0 bump. #2091 strips the field for every
forward request and every model, which inverts the existing gpt-5.5 preserve pin at
tests/openai-responses-passthrough.test.ts:807 — the issue reporter explicitly withdrew the
global claim. #2102 is the correct contract.

**K12 short-window quota (issue #2047).** #2056 is a strict superset of #2062: it adds
`snapshotHasShort`, partial-snapshot preservation, `updateAccountQuota` carry, and the
parse -> cache -> DTO path the issue requires. Both rewrite the same two functions and WOULD
conflict. #2062 also carries the same stray version bump.

**Probe bus (issues #2114/#1939).** #2130's `busUnreachable()` is a superset of #2029's two
strings and adds the on-disk unit check that #2029's reviewer demanded. Landing #2029 on top of
#2130 would REGRESS the disk check back to unconditional `absent`.

## 5. Structural finding: this backlog is not one stack

DEV-STACK-01 permits stacking only when later parts consume earlier parts' output. Measured file
overlap across the absorb set:

| Cluster | Files |
|---|---|
| PCR consolidation | src/adapters/openai-responses.ts |
| #2132 + #2131 | src/server/responses/core.ts (**shared**) |
| #2100 | src/routing/capability.ts |
| #2077 | src/routing/compatibility/behavior.ts |
| K12 | src/codex/quota.ts, src/codex/routing.ts |
| #2105 | src/cli/index.ts, src/server/system-env.ts |

Exactly one real dependency edge exists: **#2132 and #2131 both modify
`src/server/responses/core.ts`**, so they must be ordered. Everything else is disjoint.

Forcing 12 disjoint fixes into one 12-layer chain would violate DEV-STACK-01's independence
clause and the 2-4 depth guidance, and would impose a false merge order in which an unrelated
layer blocks every layer above it. The honest shape is therefore **one bounded stack rooted on
#2134 for the genuinely dependent Responses work, plus sibling PRs off dev for the disjoint
fixes**. That is recorded here rather than silently reshaped.

## 6. Security holds (detail deliberately not recorded here)

The baseUrl-override pair (#2109/#2110) has an unresolved gap already raised publicly in the
CodeRabbit thread on those PRs. Per AGENTS.md, pre-disclosure security reasoning does not go in
this public directory: the analysis lives in scratch only, and these PRs are HOLD, not absorb,
until a human security pass. #2053 is C4 OAuth and requires the security review MAINTAINERS.md
mandates; it is KEEP, not absorb.

## 7. Attribution contract

Every superseded PR gets (a) its author credited by @login in the superseding PR body,
(b) a courteous closing comment naming the replacement PR and what was carried over,
(c) no force-push and no edit to the contributor's own branch.


---

# P-phase amendment (A-gate self-audit, 2026-08-20): the stack premise in §5 was WRONG

The A-phase auditor lane produced nothing across three wait cycles, so it was retired
(DISPATCH-RETIRE-01) and the load-bearing claims were verified directly. Two of them failed.

## Correction 1 — #2131 does NOT touch `src/server/responses/core.ts`

`gh pr diff 2131 --name-only` returns `src/server/responses/responses-field-backfill.ts`,
its test, and eight docs locales. `core.ts` already imports that module on `dev`
(`src/server/responses/core.ts:6-7`, called at :3098-3099); #2131 only changes the module's
internals and signature. It never edits `core.ts`.

#2132's fix lives in `resolveResponsesCodexAuth` (`core.ts:1082-1114`), a different region of
a file #2131 does not modify at all.

**Therefore the single dependency edge claimed in §5 does not exist.** The corrected file map:

| Item | Files | Overlap |
|---|---|---|
| #2132 | src/server/responses/core.ts (auth resolution) | none |
| #2131 | src/server/responses/responses-field-backfill.ts | none |
| #2102 | src/adapters/openai-responses.ts | none |
| #2100 | src/routing/capability.ts | none |
| #2077 | src/routing/compatibility/behavior.ts | none |
| #2056 | src/codex/quota.ts, src/codex/routing.ts | none |
| #2105 | src/cli/index.ts, src/server/system-env.ts | none |

Every absorbed item is disjoint. **There is no dependency-ordered chain in this backlog at all.**

## Consequence: this work must NOT be stacked

DEV-STACK-01 forbids stacking independent parts: "the parts are independent — open parallel PRs
off trunk instead, since a stack imposes a false merge order." Building the requested chain
would mean any layer's review blocking every layer above it, for zero dependency benefit, and
would violate the same rule the request asked to follow.

Docs 010 and 020 are therefore **superseded**: both become siblings based on `dev`, not layers.
PR #2134 remains its own independent PR. The stack rooted on #2134 is cancelled and the reason
is recorded here rather than the plan being quietly reshaped.

**One exception preserved:** if two absorbed items ever do touch one file, they stack. None do.

## Correction 2 — issue #2132 is confirmed present, with a sharper mechanism than 010 assumed

Verified in this worktree:
- `core.ts:1088`: `const substituteMainCredential = options.admission?.source === "bearer";`
  keys on HOW the caller authenticated, never on WHERE the request routes.
- `auth-context.ts:542-548`: with `ctx.kind === "main"` and that flag, a missing/dead stored
  main token throws `CodexMainSubstitutionUnavailableError`.
- `core.ts:1148-1153`: that becomes the reported 401.
- The `authCtx = { kind: "main" }` fallback at `core.ts:1105` is taken whenever
  `route.codexAccountMode` is unset — which is every non-`openai` provider.

So a key-auth routed provider reaches `kind: "main"` + `substituteMainCredential: true` and
fails, exactly as reported. The defect is real and 010's fix direction stands; only its stack
position changes.

## Correction 3 — supersede claims re-verified

`gh pr view 2055`: `MERGED` at 2026-08-19T00:11:27Z, merge commit `2648ffa879edf93e`. #2063's
supersede stands.

## Revised work-phase map

| WP | Doc | Branch | Base | Content |
|---|---|---|---|---|
| wp2 | 010 | codex/fix-bearer-admission-2132 | dev | issue #2132 (score 96) |
| wp3 | 030 | codex/consolidate-prompt-cache-retention | dev | absorb #2102; supersede #2099, #2091 |
| wp4 | 040 | codex/absorb-capability-evidence | dev | absorb #2100, #2077 |
| wp5 | 050 | codex/absorb-k12-short-window | dev | absorb #2056; supersede #2062, #2063 |
| wp6 | 020 | codex/absorb-responses-id-backfill | dev | absorb #2131 + unique-id correction |
| wp7 | 060 | — | — | close-outs with attribution |

Ordered by score, not by dependency, because no dependency exists. Each is independently
reviewable and independently mergeable, which is what DEV-STACK-01 actually asks for.


## Correction 4 — #2130 merged mid-cycle; #2029 is now superseded in fact, not in prospect

`gh pr view 2130`: `MERGED` at 2026-08-19T17:25:26Z. The probe lane's verdict was conditional
("SUPERSEDED, once #2130 merges"); that condition is now satisfied.

Consequence for `060`: **#2029 (@yzxcj797)** moves from a prospective close to an immediate one.
`dev` now carries `busUnreachable()` — a superset of #2029's two stderr strings — plus the
on-disk unit check that #2029's own reviewer demanded. Landing #2029 on top would REGRESS that
disk check back to an unconditional `absent`. Nothing from #2029 needs to be carried over; its
one unique behavior (keeping `DBUS_SESSION_BUS_ADDRESS not set` as `unknown`) is precisely what
the merged disk check replaces.

This also removes #2130 from the open-bug-PR set: the fresh count at wp1 close is 26 open bug
PRs, of which exactly one (#2134) is lidge-jun's and 25 are not.

## wp1 close-out evidence

`gh pr list --repo lidge-jun/opencodex --state open --label bug --limit 100` at close:
26 total, mine = [2134], non-mine = 25. Every one of those 25 numbers appears in §1/§3 of this
document (verified by a grep loop over the list, exit 0). No open bug PR is left without a
disposition.


---

# A-gate amendment 2 — retired auditor returned late with VERDICT: FAIL; findings adjudicated

The adversarial lane retired under DISPATCH-RETIRE-01 (three empty wait cycles) delivered after
retirement. Its verdict is FAIL. It is adjudicated here rather than discarded, because a late
reviewer is still a reviewer.

**Findings 1 and 2 — CONFIRMED, and already corrected.** It independently measured the same
`gh pr diff --name-only` evidence and reached the same conclusion as amendment 1: #2131 does not
touch `core.ts`, no dependency edge exists, and rooting a stack on #2134 (which only touches
`agent-settings-routes.ts`) is a second DEV-STACK-01 violation. Two independent measurements now
agree. Recorded as settled.

**Finding 5 — CONFIRMED, and it is the sharpest catch.** Doc 010 said to gate substitution on
"the native ChatGPT **pool**". That would exclude `codexAccountMode: "direct"` and re-break
#1686, whose whole point is that Direct bearer admission is only safe *because* substitution
still runs. The implemented fix uses `route.codexAccountMode !== undefined`, which covers both
`pool` and `direct` and matches the issue reporter's own suggested gate. 010's prose is
superseded by this line; the code is correct.

**Finding 3 — CONFIRMED and material.** Overlap was measured only inside the absorb set. Three
OTHER open PRs edit `src/server/responses/core.ts`:

| PR | Overlap with the #2132 fix |
|---|---|
| #2104 (@olddonkey) | `src/server/responses/core.ts` — review-ready, MERGEABLE |
| #2101 (@Ingwannu) | `core.ts` + `compact.ts` + `auth-context.ts` — all three files this fix touches |
| #2040 (@Ingwannu) | `core.ts` |

Verified by `gh pr diff --name-only`. The #2132 change is 5 lines across two files and does not
restructure either function, so a textual conflict is possible but small. This is a merge-order
hazard to state on the PR, not a reason to withhold the fix. #2104 is reclassified from `n/a`
to KEEP (review-ready, not a conflicting draft — the auditor is right that grouping it with
CONFLICTING #2075 and draft #2127 was an error, and its inventory row's "adapters/xai" file
attribution was wrong).

**Finding 4 — CONFIRMED. #2105 would have been lost.** It is scored 60 ABSORB in §3, has no
decade doc, and appears in no row of 060. An above-threshold item with no execution path is
exactly how a contributor's work disappears without a close comment. Disposition corrected to
**KEEP — remains open**, because no replacement exists. It is not closed.

**Nits accepted:** "strict superset" overstates #2056 vs #2062 (#2062 uniquely adds
`tests/rate-limit-reset-credits.test.ts`); #2130 has empty `closingIssuesReferences` so
#1939/#2114/#2108 will not auto-close; the rubric is recorded as a single integer, so the
component arithmetic is not independently auditable.

## Net effect on the plan

No absorbed item is dropped and no new one is added. Two dispositions change (#2104 n/a -> KEEP,
#2105 ABSORB -> KEEP), one prose invariant in 010 is superseded by the implemented predicate,
and one merge hazard is now stated. The sibling shape from amendment 1 stands, reinforced.

