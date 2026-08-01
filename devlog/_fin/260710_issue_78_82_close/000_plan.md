# 260710 — Fix + close issues #78 (opencode-go DeepSeek 400) and #82 (hy3-preview catalog)

## Loop-spec
- Archetype: spec-satisfaction (each issue closes pass/fail: root cause proven, fix or upstream verdict, comment posted, issue CLOSED).
- Trigger: user request 2026-07-10 — run cxc-loop, solve, comment, close. Subagents unlimited (sol medium; terra low for small lanes).
- Goal: #78 and #82 both CLOSED with substantive root-cause comments; any opencodex-side fix implemented with regression tests; bun test + tsc green.
- Non-goals: gui/docs-site work; version bumps/publishing; reverting user's dirty worktree (.github/workflows/*, src/codex/catalog.ts, tests/* are user-owned).
- Verifier: `bun test ./tests/` (0 fail) + `bun x tsc --noEmit` (exit 0); `gh issue view {78,82} --json state` == CLOSED.
- Stop: DONE / BLOCKED (upstream unprovable or gh perms) / NEEDS_HUMAN (fix conflicts with other providers) / BUDGET_EXHAUSTED (>6 work-phases or ~2h).
- Memory: this unit + `.codexclaw/goalplans/fix-and-close-opencodex-issues-78-opencode-go-de/`.
- Resource bounds: repo-local writes + gh API on lidge-jun/opencodex; read-only explorers; workers scoped to src/ + tests/.

## Context (evidence)
- #78: DeepSeek via opencode-go → `Provider error 400: Error from provider (Console Go): Upstream request failed`. Other opencode-go models fine. One contributor says it works for them; owner comment (WP4 of 260710_pr_triage) reproduced a 200 on deepseek-v4-flash high — intermittent or config/flow-dependent.
- Prior Tier-2 research (this session): DeepSeek V4 requires reasoning_content replay on tool-call turns (else 400); rejects tool_choice required/named in thinking mode; narrow strict-schema dialect ($ref/unions rejected).
- #82: hy3-preview selectable in catalog but upstream 400 model_not_supported ("lite model list", GET /inference/go/openai/v1/models).
- Dirty worktree: user WIP in .github/workflows/{ci,service-lifecycle}.yml, src/codex/catalog.ts, tests/{codex-catalog,kiro-retry}.test.ts + untracked tests/ci-workflows.test.ts — may already touch #82 surface; verify before editing.

## Work phases
1. WP1 — #78: adapter trace (Lagrange/sol), external evidence (Heisenberg/terra low) → fix in openai-chat path or upstream verdict → test → comment + close.
2. WP2 — #82: catalog trace (Hume/sol) → align catalog with upstream lite list (respect user WIP) → test → comment + close.

## Dispatch ledger
- Lagrange (sol/medium, explorer): #78 openai-chat adapter reasoning-replay/tool_choice/schema trace. [dispatched]
- Hume (sol/medium, explorer): #82 catalog origin + user WIP diff review. [dispatched]
- Heisenberg (terra/low, explorer+cxc-search): upstream evidence (opencode #36157, proxy fixes elsewhere, lite model list). [dispatched]

## WP2 evidence (Hume, #82)
- hy3-preview came from Jawcode augmentation (catalog.ts:1246 appends generated rows missing from live /models; only opencode-go opted in at catalog.ts:304).
- Already removed from opencode-go bundle on HEAD by commit 8d69372d (generated metadata refresh). User's uncommitted catalog.ts changes are unrelated (dated-alias handling).
- Remaining: negative regression assertion `opencode-go/hy3-preview` absent in augmentation test (tests/codex-catalog.test.ts:766 area). Verdict: NOOP on HEAD + test hardening; comment should say fixed in v2.7.4+ metadata refresh.

## WP1 evidence (Lagrange, #78) + plan
- Root cause (99%): opencode-go provider entry (registry.ts:342 block) omits deepseek-v4-pro/flash from `preserveReasoningContentModels` (line ~375: only glm-5.2, kimi-k2.7-code*). Adapter (openai-chat.ts:57) only replays reasoning_content for listed models -> assistant tool-call turns sent WITHOUT reasoning_content -> DeepSeek V4 thinking contract violation -> 400. Direct `deepseek` provider already has the flag (registry.ts:458) + effort map — proves the pattern.
- Secondary gaps: opencode-go has no DeepSeek effort map (Codex xhigh sent literally; direct provider maps via DEEPSEEK_THINKING_REASONING_MAP at registry.ts:136) and no efforts advertised.
- Fix plan (B, worker 1, write scope: src/providers/registry.ts + tests/opencode-go-deepseek.test.ts NEW):
  1. opencode-go modelReasoningEfforts += DEEPSEEK_THINKING_MODELS -> DEEPSEEK_THINKING_EFFORTS
  2. opencode-go modelReasoningEffortMap += DEEPSEEK_THINKING_MODELS -> DEEPSEEK_THINKING_REASONING_MAP
  3. preserveReasoningContentModels += ...DEEPSEEK_THINKING_MODELS
  4. Regression test: opencode-go/deepseek-v4-* assistant tool-call turn replays reasoning_content; effort mapping asserted.
- #82 plan (B, worker 2, write scope: tests/codex-catalog.test.ts append-only): negative assertion `opencode-go/hy3-preview` absent after augmentation (fix already on HEAD via 8d69372d; NOOP + hardening). MUST NOT revert user's uncommitted changes in that file.
- A-gate: heuristic light audit by main (user requested heuristic mode) — plan matches direct-deepseek precedent, scoped, test-covered.

## D close-out (DONE)
- #78: fix 8942c7c3 (preserveReasoningContentModels + effort map for deepseek-v4-* on opencode-go) + tests/opencode-go-deepseek.test.ts. Comment https://github.com/lidge-jun/opencodex/issues/78#issuecomment-4932494922 — CLOSED.
- #82: NOOP on HEAD (8d69372d) + negative regression assertion in tests/codex-catalog.test.ts. Comment https://github.com/lidge-jun/opencodex/issues/82#issuecomment-4932494919 — CLOSED.
- Gates: bun test 1929/0, tsc exit 0, pushed origin/dev. Goalplan E8 validate OK. Terminal outcome: DONE.
