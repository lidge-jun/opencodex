# Append-only Claude Tool Loading

## Translated tool admission

`src/claude/inbound-content-options.ts` omits hosted search from the translated catalog when any
`web_search*` declaration supplies `allowed_domains`, `blocked_domains` or `user_location`.
All duplicate hosted-search declarations are omitted together; shared sidecar backends cannot
uniformly enforce these constraints. A forced hosted-search choice without a surviving declaration
refuses locally. Typed originals still reach first-party Anthropic through the existing out-of-body
server-tool lane; native passthrough retains its own declaration. Unrestricted search is unchanged.
Valid function definitions marked `defer_loading` lower to ordinary callable functions on combo
Responses/Chat destinations; the flag never drops the function or alone triggers compatibility
rejection. `src/claude/compatibility.ts` still rejects unsupported top-level deferral, schema-less
deferred declarations and server-executed discovery in enforce mode. This is eager-loading
degradation, not native deferred discovery. `tests/claude-integration/claude-translated-tool-restrictions.test.ts`
covers both physical fallback wires, sidecar availability, restriction combinations and duplicates,
forced choice, original Anthropic declarations and deferred-function admission.

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

A Responses destination that accepts the request but silently drops `additional_tools` must not
be selected either: the loaded definition never reaches the model. DeepSeek's official Responses
API behaves this way (same input token count with and without the item, measured 2026-10-31).

## Chat-wire dispatcher

The Chat wire has no chronological tool carrier, and `src/adapters/tool-catalog-nudge.ts` lists
every current tool name in the system message, so a ToolSearch load rewrites the prefix twice. For
routes selected by `claudeCode.chatToolDispatchModels` (same selector grammar, validation, salvage
and provider-ID migration as `appendOnlyToolLoadingModels`), `request-transport.ts` applies
`applyChatToolDispatch` from `src/claude/chat-tool-dispatch.ts` at the same physical-adapter
binding, only when the final adapter is a direct `openai-chat`; combo attempts and policy-owned
requests are excluded, and late subagent fallback is judged by the physical route. It reads the
same discovery evidence through `readClientToolDiscovery`.

Each build projects afresh. The catalog carries one stable `use_loaded_tool {name, arguments}`
function from the first request with an eager `ToolSearch`; unused deferred tools stay out of it,
so the catalog and the nudge never change on load. A discovered definition is appended as text to
the ToolSearch result that loaded it, and earlier calls to discovered tools are re-encoded as
dispatcher calls so replay is byte-stable. Both parse paths (`parseStream`, `parseResponse`) map a
dispatcher call back to the client tool only when its payload is exactly `{name, arguments?}`
(`arguments` an object, or a JSON string holding one) and the name is a tool discovered in that
request or already in the visible catalog; an undiscovered deferred tool, extra top-level keys,
malformed or incomplete calls pass through unchanged. Dispatcher-call arguments are buffered
until the call ends. Tools called before discovery, including a hidden deferred tool the model
called directly, keep or regain their native slot, which changes the catalog once. A forced
choice of any tool the projection would hide, duplicate tool_use ids, a discovery result that is
not present exactly once, a duplicate declared name, or a client tool already named
`use_loaded_tool` sends the request unprojected and leaves its response untouched. Absent, empty or unlisted
configuration is byte-identical to no configuration. Definitions travel as text, so provider-side
strict schema enforcement does not apply to them.
`tests/claude-integration/claude-chat-tool-dispatch.test.ts` covers projection, prefix stability on
the real Chat adapter output, bail-out cases and the stream rewrite;
`tests/claude-integration/claude-chat-tool-dispatch-routes.test.ts` covers byte identity when off,
Responses and combo routes, late fallback in both directions, the non-streaming client response,
both parse paths and configuration salvage/migration.

## Claude models behind a Responses gateway

This opt-in does not stabilize Claude models routed through a Responses gateway that lifts
`additional_tools` into Claude's top-level tools. For those, the documented operator path is a
provider with `adapter: "anthropic"`, per-model `modelAdapters` keeping non-Claude models on
Responses, and `protocols.rollout.managedMessagesNative`; native Messages keep Claude Code's
deferred definitions and `tool_reference` results unchanged. No code path changes for it.
