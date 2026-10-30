# LM Studio Chat instructions

`singleLeadingSystemMessage: true` consolidates text-only Chat system/developer messages
into one leading system message, separated by two newlines. The LM Studio local registry
entry seeds this policy; explicit `false` overrides it. The persisted value survives
provider renaming and endpoint changes; an old renamed row needs an explicit opt-in.
`src/adapters/openai-chat/single-system.ts` owns the outbound-copy normalization used by
both translated Chat and direct Chat passthrough. It preserves instruction order in the
serialized IR (base system prompts, then timeline developer instructions), or native Chat
message order, and preserves non-instruction message/tool-call/result order and content.
The Responses parser already collects system items into the IR system prompt; this policy
does not recover their original positions relative to developer items. Hoisting later
instructions changes their chronological scope and may invalidate prompt-cache prefixes.
The explicit policy takes precedence over the model-name-based late-developer-to-user
mapping. Other presets and unflagged custom endpoints keep their existing behavior.
Non-text native instruction parts fail explicitly rather than being discarded; translated
developer image/audio messages retain the existing user-compatible mapping.
Translated developer documents retain file parts in a user message at the tool-barrier-adjusted
timeline slot; accompanying text joins the leading instruction block in IR order.
Tests: `tests/adapters/openai/openai-chat-single-system.test.ts` and
`tests/config/lmstudio-system-policy.test.ts`.

Configuration uses the optional boolean in `src/types/provider.ts` and
`src/config/schema/leaf-validators.ts`. `src/providers/registry/entries-core.ts` seeds
true only for LM Studio; `src/providers/derive.ts`, `src/providers/resolved-model-policy.ts`
and `src/providers/routed-config.ts` preserve explicit false during backfill/resolution.

The field is classified as `editor` in the restricted `src/server/auth-cors.ts` provider
policy table. `src/server/management/provider-overwrite-carry.ts` validates POST booleans,
preserves omitted true/false on same-destination saves, and accepts boolean/null on PATCH.
A destination-changing POST requires resubmitting the flag; it does not inherit the previous
upstream compatibility. The field grants no credential or network access.
