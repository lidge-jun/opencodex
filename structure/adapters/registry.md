# Adapter Registry Authority

## Decision

Runtime adapter construction has one authority: `src/adapters/registry.ts`.

`src/server/adapter-resolve.ts` may resolve a provider/model onto an adapter id, but it does not maintain a second adapter factory inventory. The selected persisted/configured adapter id remains an untrusted string until the registry lookup succeeds. Unknown ids fail with the existing `Unknown adapter: <id>` error instead of widening configuration types around a closed compile-time union.

## Semantic inheritance is not constructor inheritance

Some adapters share another adapter's routed-tool semantics while retaining independent runtime construction:

- `azure` and `azure-openai` inherit the `openai-responses` contract.
- `mimo-free` inherits the `openai-chat` contract.
- `cursor` stays direct because its `runTurn` transport and gated native-file fallback are distinct.
- `devin-cli` stays direct for the same reason, one layer further out: it has no HTTP transport at
  all. The turn runs as an Agent Client Protocol session against a local `devin acp` child process,
  so `buildRequest` returns a placeholder and `parseStream` is disabled. Its registry `baseUrl` is a
  canonical identity URL rather than a destination anything connects to, which is what keeps the
  generated configuration loadable: `providerBaseUrlConfigError` accepts only `http(s)` schemes.
- `devin` is the cloud half of the same family and is also direct. It streams Cognition's
  `ApiServerService/GetChatMessage` over Connect-RPC from `runTurn` with hand-written protobuf
  framing, so like Cursor and `devin-cli` it never travels the `buildRequest`/`parseStream` path.
  The `devin-cli` PRESET streams over this same adapter: the installed CLI's own
  `credentials.toml` holds an ordinary `devin-session-token`, so that provider imports the token
  rather than spawning a child, and the two rows differ only in where the credential came from —
  a browser sign-in versus a signed-in local CLI. The ACP adapter above remains registered and is
  selected by a custom-named row, never by the `devin-cli` id, because `routedProviderConfig` pins
  the adapter from the registry for any registry id.

The registry records those relationships with `contractParent`. A parent relationship does **not** mean the registry recursively constructs a parent adapter and injects it into the child. Azure and MiMo keep owning their existing internal composition. This avoids making production constructors depend on test/conformance needs and keeps this authority refactor behavior-neutral.

## Wrapper-cycle and runtime validation policy

`effectiveAdapterContract()` follows `contractParent` links at runtime with a visited set. Unknown parents and cycles fail closed. This is intentionally runtime validation: registry/config values can originate in persisted files written by older or hand-edited installations, so compile-time typing alone is not an adequate boundary.

## Extension policy

Adding a production adapter requires:

1. one `ADAPTER_REGISTRY` entry with its factory;
2. either a direct `wire` + mutation contract or an explicit `contractParent`;
3. provider/model adapter ids that point only at registered ids;
4. registry-derived conformance coverage in the follow-up conformance layer.

Do not add a second switch/list of adapter factories in request routing. Focused tests may construct a concrete adapter directly when they are testing that adapter itself; cross-adapter production routing should use registry authority.

## Scope boundary

This decision does not change routed `apply_patch` behavior, Cursor structured-edit conversion, Azure/MiMo request construction, or provider wire selection. Those behaviors remain owned by their existing modules and focused tests. The registry exposes the universe and semantic relationships; the next stack layer consumes that metadata for generic conformance.

## Moonshot `$ref`-with-siblings normalization

Moonshot/Kimi enforce the draft-07 reading where `$ref` must stand alone and 400 the whole
request when a node carries both. Codex's own deferred tool catalog emits exactly that shape,
so the schema is not something a user can fix from configuration (issue #2673).

> Decision record: [ADR-0093](../decisions/ADR-0093-moonshot-ref-with-siblings-normalization.md)

## Truncated tool finalization

The bridge keeps an open function, custom, or tool-search call incomplete when an adapter ends with a recognized truncated stop reason. Streaming emits no argument/input completion frame for that open call, and buffered JSON applies the same status. A call already closed by its own tool-call end retains its completed state. The response remains incomplete, partial output is preserved, and truncated compaction never replaces history.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.
