# 100.10 — Search and Tool Discovery

## Questions

- What does `supports_search_tool` do?
- What does `web_search_tool_type` do?
- If opencodex omits or inherits these fields, what fallback does Codex use?
- Does this map to opencodex's current web-search sidecar correctly?

## Codex RS Behavior

`supports_search_tool` is not the hosted OpenAI web-search tool. It gates Codex's deferred
`tool_search` discovery surface for MCP/app/extension tools. If it is false or omitted, Codex does
not expose deferred `tool_search` to the model. Direct tools can still be exposed through the normal
tool plan.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:408
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:328
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:941
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:992
```

`web_search_tool_type` controls the hosted web-search tool shape. The default is text-only. A
`text_and_image` value causes Codex to emit a hosted search tool with image search content types.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:279
/tmp/opencodex-codex-src/codex-rs/core/src/tools/hosted_spec.rs:20
/tmp/opencodex-codex-src/codex-rs/core/src/tools/hosted_spec.rs:28
/tmp/opencodex-codex-src/codex-rs/core/src/config/mod.rs:2403
/tmp/opencodex-codex-src/codex-rs/core/src/config/mod.rs:3283
/tmp/opencodex-codex-src/codex-rs/tools/src/tool_spec.rs:36
```

## Fallbacks

If metadata is missing or unknown:

- `supports_search_tool` falls back to false.
- `web_search_tool_type` falls back to text-only.
- hosted web-search availability is still gated by Codex config, model transport, and hosted-tool
  mode.
- unknown model fallback metadata does not enable deferred tool discovery.

## Current opencodex Behavior

opencodex clones a native Codex catalog template in:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

The routed entries currently do not explicitly remove or override:

- `supports_search_tool`
- `web_search_tool_type`

That means routed models can inherit native OpenAI search/tool-discovery capability hints.

For hosted web search, opencodex mitigates at request time:

- the Responses parser recognizes hosted `web_search` tools;
- routed-model translation drops hosted OpenAI web-search from upstream tool calls;
- the sidecar can inject a synthetic `web_search(query)` tool only when its prerequisites pass.

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:134
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:141
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:142
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:380
/Users/jun/Developer/new/700_projects/opencodex/src/web-search/index.ts:30
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:159
/Users/jun/Developer/new/700_projects/opencodex/src/web-search/synthetic-tool.ts:11
```

## Gap

The catalog may advertise native hosted search semantics even when the routed upstream provider
does not have native OpenAI-hosted search. opencodex's sidecar makes this partially usable, but the
metadata is still not explicit.

If sidecar prerequisites are missing, Codex may plan around a capability that gets removed before
the routed provider sees the request.

## Phase 100 Recommendation

Keep the two search concepts separate:

1. `supports_search_tool`: preserve only if opencodex intentionally wants routed models to use
   Codex deferred tool discovery.
2. `web_search_tool_type`: set based on opencodex sidecar capability, not native template
   inheritance.
3. Add regression tests proving hosted `web_search` is either translated to the synthetic sidecar
   tool or suppressed with predictable behavior.
4. Document that native OpenAI passthrough can keep hosted search metadata, while non-OpenAI routed
   models depend on opencodex sidecar search.

See `11_search-defaults-and-inherited-state.md` for the concrete native model defaults and current
observed opencodex catalog state.
