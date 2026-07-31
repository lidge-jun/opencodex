# WP2 — provider opt-in wiring

## Scope
- MODIFY src/types.ts (OcxProviderConfig: + parallelToolCalls?: boolean).
- MODIFY src/providers/registry.ts (ProviderRegistryEntry: + parallelToolCalls?: boolean; xai entry: parallelToolCalls: true).
- MODIFY src/providers/derive.ts (providerConfigSeed + enrichProviderFromRegistry propagate the flag).
- MODIFY src/router.ts (routedProviderConfig registry->user-config backfill merges parallelToolCalls;
  audit round 1 blocker #2 — stale persisted provider configs must still receive the flag).
- MODIFY src/adapters/openai-chat.ts (buildRequest flag logic; assistant history content hardening).
- MODIFY src/codex/catalog.ts (CatalogModel + parallelToolCalls; applyProviderConfigHints/
  catalogHintsFromProviderConfig propagate; normalizeRoutedCatalogEntry(entry, parallelOptIn?)).
- NEW/EXTEND tests: request-body flag per provider, catalog bit per provider, content serialization.
- OUT: zai/GLM enablement, cursor path changes, other adapters.

## Diffs
1. types.ts OcxProviderConfig (after noPenaltyModels block):
```ts
/**
 * Allow multiple tool calls per completion. Opt-in per provider with PROVEN support
 * (xAI: docs.x.ai function-calling, default-on upstream). When false/unset the adapter
 * forces parallel_tool_calls:false (8d9a3f6 safety default) and the catalog does not
 * advertise supports_parallel_tool_calls.
 */
parallelToolCalls?: boolean;
```
2. registry.ts: same optional field on ProviderRegistryEntry; xai entry adds
   `parallelToolCalls: true`. zai/others untouched.
3. derive.ts providerConfigSeed: `...(entry.parallelToolCalls !== undefined ? { parallelToolCalls: entry.parallelToolCalls } : {})`.
   enrichProviderFromRegistry: fill when absent on existing config (same pattern as other capability fields — verify exact style in B).
4. openai-chat.ts:233 replace:
```ts
if (tools) body.parallel_tool_calls = false;
```
with:
```ts
if (tools) {
  // Opt-in providers follow Codex's request bit (default true); everyone else keeps
  // the serialized-safety default (see devlog/_plan/260709_parallel_tool_calls).
  body.parallel_tool_calls = provider.parallelToolCalls === true
    ? parsed.options.parallelToolCalls !== false
    : false;
}
```
5. openai-chat.ts:79 `if (!chatMsg.content) chatMsg.content = null;` ->
   `if (chatMsg.content === undefined) chatMsg.content = "";`
   Rationale: xAI 400 "Each message must have at least one content element" (langchain#34140);
   "" is valid for OpenAI-compatible validators, null is the riskier value. ALSO: the
   orphan-toolResult synthetic assistant message at openai-chat.ts:100 (`content: null` -> `""`).
   Reviewer note: DeepSeek docs allow nullable content; no primary evidence any served provider
   rejects "" — treated as low-risk, covered by serialization test.
6. router.ts (~:80-101) routedProviderConfig: add parallelToolCalls to the registry-seed
   backfill merge (same pattern as sibling capability fields), so persisted configs created
   before this change still inherit `parallelToolCalls: true` for xai.
7. catalog.ts:
   - CatalogModel: + `parallelToolCalls?: boolean`.
   - applyProviderConfigHints: spread `...(prov.parallelToolCalls === true ? { parallelToolCalls: true } : {})`.
   - catalogHintsFromProviderConfig: same propagation (B verifies which of the two paths feeds deriveEntry and covers both).
   - `normalizeRoutedCatalogEntry(entry: RawEntry, parallelToolCalls = false)`:
     `entry.supports_parallel_tool_calls = isCursorEntry || parallelToolCalls === true;`
   - deriveEntry callsite: `normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true)`.

## Accept criteria / activation scenarios
- buildRequest(xai-like provider w/ parallelToolCalls:true): body.parallel_tool_calls === true;
  when the incoming Responses request body carries `parallel_tool_calls:false`
  (parser.ts:466 -> parsed.options.parallelToolCalls === false) -> false.
  (Audit round 1 blocker #4: compaction is NOT the trigger — routed compaction deletes
  options+tools at responses.ts:241,245; the parser-level request bit is the real scenario.)
- buildRequest(zai-like default provider): body.parallel_tool_calls === false (unchanged).
- Stale persisted xai config (routedProviderConfig backfill path): parallel_tool_calls === true.
- normalizeRoutedCatalogEntry: xai slug + optIn -> supports_parallel_tool_calls true;
  default routed entry -> false; cursor/ slug -> true (unchanged).
- Assistant tool_calls history message serializes content "" (test asserts no null).
- Existing catalog/provider tests stay green.
