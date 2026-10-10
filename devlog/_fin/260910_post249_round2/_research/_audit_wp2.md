Post-merge audit against `origin/dev` `5b8f1fcfa` (local worktree HEAD is still `3b9fab90e`; all citations are `origin/dev`). No product tests were run.

Both landings match the chosen fixes. The regression tests would be red on the old code, and the “must stay green” cases were not weakened.

**NOTE** Local checkout is behind `origin/dev`. Grep in this worktree will still show the old hoist test.

## #4129 / PR #4157 (`4498fb910`, head `421aea87a`)

The lane implemented the plan, not a swap of the two blocks.

In `handleResponsesInner`, a combo-named `shadowCallIntercept` is rewritten **before** `comboIdFromRawBody`:

```3313:3336:src/server/responses/core.ts
  if (!options.comboAttempt && body && typeof body === "object" && !Array.isArray(body)) {
    const shadowIntercept = config.shadowCallIntercept;
    const rawShadowModel = (body as { model?: unknown }).model;
    if (shadowIntercept?.enabled && shadowIntercept.model && typeof rawShadowModel === "string"
      && isShadowSourceModel(rawShadowModel, shadowIntercept.sourceModels)) {
      const shadowComboId = resolveComboId(config, shadowIntercept.model);
      if (shadowComboId && Object.hasOwn(config.combos ?? {}, shadowComboId)) {
        (body as Record<string, unknown>).model = shadowIntercept.model;
        logCtx.shadowCallRewrittenFrom = sanitizeLogMetadataString(
          shadowSourceModelPrefix(rawShadowModel, shadowIntercept.sourceModels),
        );
      }
    }
  }
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body, config) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    return handleComboResponses(...)
```

Identity is `resolveComboId` in [src/combos/identifiers.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/combos/identifiers.ts) (`parseComboModelId` + alias scan). That is config lookup. It does not go through `routeModel` / `tryPickComboModel`.

The late site still uses `shouldInterceptShadowCall` for direct replacements ([src/server/responses/core.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/server/responses/core.ts) ~3504–3527). Combo children pass `comboAttempt: true` ([src/server/responses/core.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/server/responses/core.ts) ~2880), so they skip both the early rewrite and `comboIdFromRawBody`. Child bodies are `provider/model`; `isShadowSourceModel` hard-excludes slash ids, so the late site cannot recurse either.

`shadowCallRewrittenFrom` is still the sanitized prefix, same helper as the late site. Success-path `Object.assign(logCtx, childLog, …)` does not copy that field off the child, and the new tests assert the marker after combo return.

**Tests.** [tests/responses/responses-shadow-intercept.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/responses/responses-shadow-intercept.test.ts) gained the planned cases:

- Hop: 429 then 200 → `urls` length 2, `logCtx.provider === "combo"`, `routeKind === "combo"`, `shadowCallRewrittenFrom === "gpt-5.6-luna"`, attempts `xai/grok-4.5` then `alt/grok-4.5` (lines 298–326). Red without the rewrite: `comboIdFromRawBody` still sees `gpt-5.6-luna`, so there is no failover loop.
- Intersecting first target: one upstream call, marker set, `routeKind === "combo"` (lines 329–359). Red without the rewrite: collapsed pick hits `shouldInterceptShadowCall` and leaves a native route with no marker.
- Extra keep-green: non-combo replacement still uses the late intercept (lines 362–377).

Existing #2706 self-target and prefix-log tests were not edited. `421aea87a` only retargeted the **new** fixture off the pinned `openai` provider after CI proved the combo hop, then 401’d on `chatgpt.com`. Same intersect condition, using `sourceModels: ["custom-helper"]` and first target `xai/custom-helper`.

**NOTE** [src/server/management/shadow-call-validation.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/server/management/shadow-call-validation.ts):7 still validates via `routeModel`, so a dashboard PUT of a Luna-first `combo/shadow` can still 400. Plan called this follow-up unless trivial.

**NOTE** `parsed._cursorIsolateConversation` is still not plumbed onto combo children. Plan deferred that.

## #4148 / PR #4161 (`5b8f1fcfa`, head `799330bcf`)

Matches the policy choice: **every** in-messages `role: "system"` becomes a chronological `developer` item, not a leading-only hoist.

[src/claude/inbound.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/claude/inbound.ts):329–360: top-level Anthropic `system` still goes through `systemToInstructions` into `systemParts` → `body.instructions`. In-messages system is pushed as `{ type: "message", role: "developer", content: [{ type: "input_text", text }] }`. No `role: "system"` input item.

`parseRequest` still re-hoists `role: "system"` onto `systemPrompt` and keeps `developer` as a timeline message ([src/responses/parser.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/responses/parser.ts) ~246–258). Using `developer` is the only shape that survives that parser.

**`prompt_cache_key`.** The fallback still hashes `systemParts` ([src/claude/inbound.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/claude/inbound.ts):385–402), now **only** top-level system. With top-level `system: "S"` and no `metadata.user_id`, the key is stable across turns (tested).

If a request has **only** in-messages system and no `user_id`, `systemParts` is empty, so **no key is emitted** (`cacheKeySource = null`). That is absence, not rotation. Previously those turns hashed the reminders and the key moved. The plan’s test used top-level `"S"`; the existing “no metadata + no system: no key” case (line 532) still describes this edge.

**Tests.** [tests/claude-integration/claude-inbound.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/claude-integration/claude-inbound.test.ts):

- Old hoist test rewritten at 335: `instructions === "top-level"`, input roles `["developer","developer","user"]`, no `role === "system"`. Red on the old fold (`"top-level\n\nbe terse\n\nblock form"`).
- New #4148 case at 359: `turn1.instructions === turn2.instructions === "S"`, roles `["user","developer","assistant","user","developer"]`, texts `u1,r1,a1,u2,r2`, `prompt_cache_key` equal, schema + `parseRequest` both succeed. Red if reminders still land in `instructions`.

Top-level-system cases at the old :66 / :429 / :439–492 sites were left as-is (now ~83, 497, 511+). Nothing in that file was deleted to stay green; the one rewritten test is the contract change the plan named.

**NOTE** Out of scope as planned: `src/adapters/openai-chat.ts` still re-hoists developer text into a leading `system` chat message for non-`api.openai.com` Chat Completions. DeepSeek/SenseNova stay on the old prefix-bust path. Anthropic/Google outbound still present developer items as chronological `user`.

No new secret logging, no `role: "system"` on the Responses wire, marker still sanitized. I do not see a contract or security blocker in either diff.

PASS
