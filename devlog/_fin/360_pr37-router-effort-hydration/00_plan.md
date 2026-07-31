# 360 PR #37 — router reasoning-effort hydration → dev

## Objective

Integrate PR #37 (`fix(router): hydrate registry reasoning effort defaults for
stale persisted provider configs`, contributor gomgom22222) into `dev`, apply
the review nits, verify, push dev, and close the PR. It reaches `main` later via
the dev→main flow.

## Background

`routeModel()` returned persisted provider configs verbatim. Built-in providers
(e.g. `ollama-cloud`) saved before `reasoningEffortMap` existed lack that field,
so `mapReasoningEffort()` falls back to the Codex label `xhigh`, which Ollama
Cloud rejects (`400 invalid reasoning value: 'xhigh' … must be "max"…`). The
registry already carries `OLLAMA_REASONING_MAP = { xhigh: "max" }` on `ollama`
and `ollama-cloud`, but nothing copied it onto the live provider object.

The PR adds `routedProviderConfig()` that merges the registry `reasoningEffortMap`
+ `modelReasoningEffortMap` UNDER the persisted config (user wins per-key), only
touching those two maps, no config mutation, no disk write.

## Review verdict (already done)

Approve with minor nits. Independently verified in a worktree:
typecheck clean, full suite 387 pass / 0 fail, the fix's dependency
(`registry.ts` ollama-cloud map) is present, helper signatures are type-safe
against `types.ts` + `registry.ts`.

Nits:
1. **Indentation** — the 4th return block (pattern-match, `src/router.ts:104-108`)
   is mis-indented (7/9 spaces vs the other four blocks' 8/10).
2. **Test gap** — `mergeNestedRecord` (the `modelReasoningEffortMap` nested
   merge) has no direct test; the 3 new tests only cover the flat
   `reasoningEffortMap` path.

## Classification

C2 (ordinary product slice): contributor fix integration + 2 small nits.
Touches `src/router.ts` (request path) + `tests/router.test.ts`. Affected-suite
gate (router + reasoning-effort + full suite) before push.

## Integration surface (verified)

- dev's `src/router.ts` is byte-identical to the PR base's pre-change router.ts
  (same 5 `{ ...prov, apiKey: resolveEnvValue(...) }` call sites at L34/44/54/69/80)
  → cherry-pick applies cleanly, no conflict.
- `tests/router.test.ts` is absent on dev → new file, no conflict.
- PR commit author: `gomgom22222 <inyongh0@daum.net>` → preserved via cherry-pick.

## Phases

### Phase 1 — Cherry-pick onto dev
`git cherry-pick -x 9553f79` (PR head). Preserves contributor authorship and
records the source commit. Expect clean apply (verified surface above).

### Phase 2 — Apply review nits (follow-up commit, my authorship)
- Fix indentation of the pattern-match return block in `src/router.ts` to match
  the surrounding 8/10-space blocks.
- Add a test to `tests/router.test.ts`: a stale persisted provider with a
  registry `modelReasoningEffortMap` (e.g. a zai/glm provider) hydrates the
  per-model wire map, and a per-model user override wins. Covers
  `mergeNestedRecord`.

### Phase 3 — Verify + push + close
- `bun run typecheck` clean; `bun test` full suite green (≥ 390 on dev base).
- `git push origin dev` (explicitly authorized: "dev에 머지").
- `gh pr close 37` with a comment crediting gomgom22222, explaining the change
  was integrated into `dev` (cherry-pick `-x`) + nits applied, and that it
  reaches `main` via the dev→main flow.

## File change summary

| Action | File | Change |
|--------|------|--------|
| ADD (cherry-pick) | `src/router.ts` | `routedProviderConfig()` + 5 call-site swaps |
| ADD (cherry-pick) | `tests/router.test.ts` | 3 hydration tests (NEW file) |
| MODIFY (nit) | `src/router.ts` | fix pattern-match block indentation |
| MODIFY (nit) | `tests/router.test.ts` | + nested `modelReasoningEffortMap` test |

## Risks

- Cherry-pick conflict — mitigated: surface verified identical, clean apply expected.
- Closing (not merging) the PR could lose contributor credit — mitigated:
  cherry-pick keeps author + `-x` records the source; close comment credits
  explicitly and explains the dev-flow rationale.
