# 2026-06-23 PR #16/#22 Dev Integration Plan

## Objective

Absorb the remaining open PRs into `dev` without routing them through the GitHub PR merge button:

- PR #16: static provider model catalogs via `liveModels: false`.
- PR #22: Anthropic Messages tool-result history repair.

The final state must preserve existing live `/models` discovery by default, keep static allowlists opt-in only, fix invalid Anthropic `tool_result` history shapes, push `dev`, and close both superseded PRs with attribution.

## Current State

- Repository: `/Users/jun/Developer/new/700_projects/opencodex`
- Branch: `dev`
- Latest release baseline: `v2.1.7` / `241e327 release: v2.1.7`
- Open PRs:
  - `#16 [codex] Allow static provider model catalogs` by `0disoft`, mergeable, CI green.
  - `#22 fix anthropic tool result history` by `jaekwonhong`, draft, mergeable, no reported checks.

## Planned Changes

### MODIFY `src/types.ts`

Add optional provider config:

```ts
liveModels?: boolean;
```

Behavior:

- `undefined` and `true` keep the current live `/models` behavior.
- `false` means `models` is an intentional static Codex catalog allowlist.

### MODIFY `src/codex-catalog.ts`

Change `fetchProviderModels` order:

1. Skip forward providers and unresolved OAuth providers as today.
2. Build configured model hints first from `prov.models`.
3. If `prov.liveModels === false`, return configured models immediately.
4. Do not write static allowlists into the live model cache.
5. Otherwise use fresh cache, live `/models`, stale cache, and configured fallback as today.

This preserves the existing dashboard `/api/models`, Codex `/v1/models`, and catalog sync behavior because all three already route through `gatherRoutedModels(config)`.

### MODIFY `tests/codex-catalog.test.ts`

Add/absorb regression tests:

- `liveModels:false` never calls `fetch`.
- A fresh live cache cannot override a static allowlist.
- Static allowlists do not poison the live cache after toggling back to live models.
- Config catalog hints still apply to static configured models, specifically `modelContextWindows`
  and `modelInputModalities` on a `liveModels:false` provider.

### MODIFY docs

Update configuration reference pages:

- `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/reference/configuration.md`
- `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/ko/reference/configuration.md`
- `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/zh-cn/reference/configuration.md`

Document:

- `models` remains seed/fallback by default.
- `liveModels:false` makes `models` an exact allowlist.
- Empty `models` with `liveModels:false` exposes no routed models.

### MODIFY `src/adapters/anthropic.ts`

Repair Anthropic tool-result history conversion:

- Adjacent `toolResult` messages immediately following assistant `tool_use` blocks must be folded into one user message containing Anthropic `tool_result` blocks.
- Missing tool results should be represented by synthetic `is_error: true` tool_result blocks so the request stays valid.
- Duplicate or orphan tool results should be preserved as text instead of invalid standalone Anthropic `tool_result` blocks.
- Image/tool content blocks should continue using existing `toAnthropicContentPart`.

### MODIFY `tests/adapter-usage.test.ts`

Add/absorb regression tests:

- Multiple adjacent tool results are folded into one user message.
- Missing tool result is synthesized with `is_error: true`.
- Orphan tool result is preserved as text.
- Duplicate tool results after one matching assistant `tool_use` are preserved as text, not a
  second invalid Anthropic `tool_result` block.
- Non-string tool-result content, including image content, still maps through Anthropic content
  blocks.
- Existing OpenAI Chat history repair tests remain green.

## Integration Strategy

1. Enter PABCD `A` and dispatch a read-only plan audit.
2. Merge PR #16 into local `dev` using git, preserving contributor history where practical.
3. Merge PR #22 into local `dev`, despite draft status, because the user explicitly authorized absorbing and closing it.
4. Resolve conflicts manually if needed; add small follow-up patch if PR code regresses existing metadata caps or cache semantics.
5. Run focused verification:
   - `bun test tests/codex-catalog.test.ts`
   - `bun test tests/adapter-usage.test.ts tests/umans-provider.test.ts`
   - `bun run typecheck`
6. Run full verification:
   - `bun test tests`
   - `cd docs-site && bun run build`
   - `git diff --check`
7. Commit or preserve merge commits atomically.
8. Push `dev` to `origin/dev`.
9. Comment on PR #16 and PR #22 with absorbed commit/evidence and close them.
10. Record final goal evidence and pause the goal with an independent stop audit.

## Risks

- PR #16 could accidentally make static allowlists the default. Mitigation: tests assert the default live path still fetches.
- PR #16 could pollute the live model cache with static allowlists. Mitigation: cache toggle test.
- PR #22 could alter valid Anthropic history order. Mitigation: focused adapter tests plus existing usage tests.
- PR #22 is draft. Mitigation: do not GitHub-merge the draft PR; absorb into `dev` with explicit user authorization and close as superseded.

## Completion Evidence Required

- Documentation: this devlog plan plus final devlog notes.
- Implementation: changed source/tests/docs paths listed above.
- Verification: focused tests, typecheck, full tests, docs build, diff check.
- GitHub: `origin/dev` updated, PR #16 and #22 commented and closed.
