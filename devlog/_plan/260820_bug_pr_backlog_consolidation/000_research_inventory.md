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

