# wp2 — Shadow-call source moves to gpt-6-luna

## File change map

| Path | Change |
|------|--------|
| `src/lib/shadow-call.ts` | MODIFY default + comments |
| `src/server/responses/request-prepare.ts` | MODIFY both intercept sites to skip spawned-child requests |
| `src/types/config.ts` | MODIFY `shadowCallIntercept` doc comments (~739-752) |
| `gui/src/pages/shadow-call-source.ts` | MODIFY fallback + comment |
| `structure/gui-and-management-api.md` | MODIFY default sentence |
| `docs-site/src/content/docs/**` | MODIFY pages naming the shadow default (reference + fr/ja/ko/ru/tr/zh-cn/zh-tw) |
| `tests/responses/responses-shadow-intercept.test.ts` | MODIFY default assertions; ADD spawned-child exemption cases |
| `gui/tests/shadow-call-source.test.ts` | MODIFY fallback and badge expectations (A1) |

## Diffs

`src/lib/shadow-call.ts`

```diff
- * Codex 0.145.0+ uses `gpt-5.6-luna` for helper calls. Older clients through
- * 0.144.x used `gpt-5.4-mini`; ...
-export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.6-luna"] as const;
+ * Codex 0.154.0+ sends `gpt-6-luna` for helper calls; 0.145.0-0.153.x sent
+ * `gpt-5.6-luna`, which stays as a legacy prefix so those clients keep interception.
+ * Clients through 0.144.x used `gpt-5.4-mini`; restore it with `sourceModels`.
+export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const;
```

`shouldInterceptShadowCall` keeps its signature; the spawned-child exemption is applied at
the two call sites in request-prepare so the pure helper stays header-free:

```diff
 // early combo site (~231)
     if (shadowIntercept?.enabled && shadowIntercept.model && typeof rawShadowModel === "string"
+      && !isThreadSpawnRequest(req.headers)
       && isShadowSourceModel(rawShadowModel, shadowIntercept.sourceModels)) {
 // late site (~484)
-    if (!options.compactionRoutingOverride && _sci?.enabled && _sci.model && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
+    if (!options.compactionRoutingOverride && _sci?.enabled && _sci.model && !isThreadSpawnRequest(req.headers)
+      && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
```

If `req` is not in scope at a site, hoist the existing `threadSpawn` const (~552) above both
sites and reuse it; verify in B.

`gui/src/pages/shadow-call-source.ts`: `FALLBACK_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"]`
plus the same comment update. The badge renders `6-luna, 5.6-luna`.

## Acceptance (with activation)

- Default: `shadowSourceModels(undefined)` returns `["gpt-6-luna","gpt-5.6-luna"]`; a bare
  `gpt-6-luna` helper request with intercept enabled is rewritten to the target
  (`shadowCallRewrittenFrom = "gpt-6-luna"`).
- Legacy: bare `gpt-5.6-luna` still rewrites.
- Exemption: the same `gpt-6-luna` request with `x-openai-subagent: collab_spawn`, or
  `x-codex-turn-metadata` containing `"subagent_kind":"thread_spawn"`, is NOT rewritten;
  `x-openai-subagent: compact` (maintenance turn) IS rewritten.
- GET `/api/shadow-call-settings` reports both source models.
- Verifiers: `bun test tests/responses/responses-shadow-intercept.test.ts` (reads the target
  directly), `bun run typecheck`, `bun run test:changed`.
