# 360-10 Verification — PR #37 integration

## Outcome

PR #37 (`fix(router): hydrate registry reasoning effort defaults`, contributor
gomgom22222) integrated into `dev`, review nits applied, verified, pushed, and
the PR closed.

## Commits (on dev, pushed 153b50f..dc28d12)

| Commit | Author | What |
|--------|--------|------|
| `a3bc9ab` | agent | devlog 360 plan |
| `ba7dec7` | **gomgom22222** | the contributor fix, cherry-picked `-x` (authorship preserved) |
| `dc28d12` | agent | 2 review nits (indentation + nested test) |

## Review verdict

Approve with minor nits. Independently verified in a git worktree before
integration: typecheck clean, full suite 387 pass / 0 fail, fix dependency
(`registry.ts` ollama-cloud `reasoningEffortMap: {xhigh:"max"}`) present, helper
signatures type-safe against `types.ts` + `registry.ts`.

## Nits applied (commit dc28d12)

1. **Indentation** — the 4th `routeModel` return block (pattern-match) was
   mis-indented (7/9 spaces); aligned to the other four blocks' 8/10.
2. **Test gap** — `mergeNestedRecord` (the `modelReasoningEffortMap` nested
   merge) had no direct test. Added 2:
   - stale `opencode-go` config hydrates the per-model `glm-5.2` map (`xhigh→max`);
   - a user per-model override wins (`xhigh→high`) while an un-overridden registry
     key survives the nested merge (`minimal→none`), proving per-key layering.

## Verification (fresh)

```
$ bun run typecheck      # tsc --noEmit
(clean, exit 0)

$ bun test
395 pass
0 fail
3171 expect() calls
Ran 395 tests across 45 files.

$ bun test tests/router.test.ts
5 pass / 0 fail   (3 contributor + 2 nested)
```

- `git push origin dev` → `153b50f..dc28d12` (explicitly authorized).
- `gh pr close 37` → state CLOSED; comment posted crediting gomgom22222 and
  explaining the dev-flow integration + nits.

## Notes

- Contributor authorship preserved via cherry-pick (`ba7dec7` author =
  gomgom22222 <inyongh0@daum.net>); close comment credits explicitly.
- The user's concurrent `devlog/350_cursor-provider-add` working-tree edit was
  left untouched (not staged into any agent commit).
- Reaches `main` via the normal `dev → main` flow (out of scope here).
