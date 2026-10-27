# Append-only Claude Tool Loading

`src/claude/inbound-tool-loading.ts` reconstructs successful client `ToolSearch` discovery from
structured `tool_reference` results. For routes explicitly selected by
`claudeCode.appendOnlyToolLoadingModels`, and only with a metadata-derived cache key,
`src/server/claude-messages.ts` retains metadata-qualified discovery evidence out of body in
`anthropicToolLoadingSource`, without rewriting the translated catalog. At each physical adapter
binding, `src/server/responses/request-transport.ts` checks the final provider/model and adapter,
including late subagent fallback and adapter replacement. Only a selected direct `openai-responses`
adapter projects a shallow build-input copy; the original `_rawBody` and parsed tool catalog stay
available for retries, sidecars and other destinations. Combo attempts and policy-owned requests
are excluded even when a concrete child resembles a direct route. Rebuilt requests project afresh,
and cache diagnostics follow the projected body identity. Currently declared unused deferred
functions stay out of that outbound initial catalog before discovery; successful discovery places
them into developer-role `additional_tools` after the matching result. Replay preserves that
position; no session cache or new inferred capability is created. Eager tools, tools used before discovery, and explicitly forced undiscovered tools
remain in the initial catalog. Without an eager declared `ToolSearch`, translation is unchanged. Missing/revoked definitions, error results,
plain-text markers and unrelated calls cannot authorize additions; ambiguous IDs/catalogs keep
the original translation. Schemas and strictness remain unchanged. Compaction, schema changes
and revocation may legitimately invalidate the prefix.

Known destinations that flatten or reject `additional_tools` keep the original complete catalog:
OpenCode Go's Responses endpoint and the official xAI Responses hosts are excluded
even when selected. Promoting discoveries into initial tools defeats chronological prefix stability.
Provider-ID migration in `src/providers/provider-id-rewrite.ts` carries both exact and wildcard
selectors to the replacement provider without changing the selected model suffix.

The list defaults to absent/off, accepts provider-qualified exact routes or a single trailing
prefix wildcard, and must name only direct Responses destinations verified to support
`additional_tools`. A selected combo or policy route keeps the original catalog, because it can
settle on a destination that flattens the item back into initial tools. Native passthrough
and compatibility-enforcement admission are unchanged. Malformed lists are rejected on write;
load salvage drops only this optional setting, preserving providers and other client settings.
`tests/claude-integration/claude-inbound-tool-loading.test.ts` covers the real Responses parser,
prefix stability, authorization boundaries, configuration salvage, and real late subagent fallback
in both opt-in directions, including a fallback onto Chat that retains every original tool.
`tests/claude-integration/claude-tool-loading-destinations.test.ts` covers excluded physical
destinations, an ordinary gateway positive control and provider-ID selector migration.

This opt-in does not stabilize Claude models routed through a Responses gateway that lifts
`additional_tools` into Claude's top-level tools. For those, the documented operator path is a
provider with `adapter: "anthropic"`, per-model `modelAdapters` keeping non-Claude models on
Responses, and `protocols.rollout.managedMessagesNative`; native Messages keep Claude Code's
deferred definitions and `tool_reference` results unchanged. No code path changes for it.
