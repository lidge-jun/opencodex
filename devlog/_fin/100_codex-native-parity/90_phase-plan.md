# 100.90 — Phase Plan

## Scope

Phase 100 should convert this research into explicit catalog/runtime metadata policy for opencodex.
The goal is not to make every routed provider fully native in one pass. The goal is to prevent
accidental native-template inheritance from changing routed model behavior silently.

## Implementation Order

### 100.1 Catalog Selector Normalization

Primary file:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

Tasks:

1. Add a routed-entry normalization function after template cloning.
2. For non-OpenAI routed entries, explicitly handle:
   - `model_messages`
   - `tool_mode`
   - `multi_agent_version`
   - `use_responses_lite`
   - service/speed tier fields already handled in Phase 90
3. Preserve these fields only for native OpenAI passthrough entries.
4. Add catalog snapshot tests around generated routed entries.

Expected first policy:

- strip `model_messages` for routed models first;
- delete `tool_mode`;
- delete `multi_agent_version`;
- delete or force `use_responses_lite = false`;
- keep `supports_websockets` unset at provider level.

### 100.2 Search Capability Policy

Primary files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts
/Users/jun/Developer/new/700_projects/opencodex/src/web-search/synthetic-tool.ts
```

Tasks:

1. Decide whether routed models should expose deferred `tool_search`.
2. Set `web_search_tool_type` according to opencodex sidecar capability, not template inheritance.
3. Add tests proving hosted `web_search` is either converted to the synthetic sidecar tool or
   suppressed predictably.

### 100.3 Thinking and Usage Parity

Primary files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts
```

Tasks:

1. Extend usage to include cached input and reasoning output tokens.
2. Emit nested Responses usage details.
3. Decide per adapter whether `thinking_delta` means summary or raw reasoning.
4. Honor `reasoning.summary = "none"` in stream output.
5. Add a regression fixture for streaming reasoning and final usage.

### 100.4 Context Window Metadata

Primary files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
/Users/jun/Developer/new/700_projects/opencodex/src/generated/jawcode-model-metadata.ts
/Users/jun/Developer/new/700_projects/opencodex/scripts/generate-jawcode-metadata.ts
```

Tasks:

1. Add a build-time/generated jawcode metadata snapshot with provider/model context metadata where
   known.
2. Extend internal routed `CatalogModel` metadata before writing every field into Codex catalog JSON.
3. Populate `context_window`, `max_context_window`, `auto_compact_token_limit`, and related
   metadata for routed entries.
4. Use conservative defaults when exact model limits are unknown.
5. Verify Codex token status and auto-compact behavior against at least one routed large-context
   model.

### 100.5 Error and Header Fidelity

Primary files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts
```

Tasks:

1. Emit `response.error` in failure payloads where upstream Codex expects it.
2. Preserve `last_error` only if it is also useful for Responses compatibility.
3. Add context-window exceeded and quota/rate-limit fixtures.
4. Synthesize Codex-relevant headers only where opencodex has truthful data.

### 100.6 Websocket Work Removed

Phase 100 will not include a websocket spike.

Final policy:

```text
routed providers keep supports_websockets absent/false
```

Reason:

opencodex routed models mostly end in upstream HTTP/SSE Chat Completions or HTTP/SSE-compatible
streams. Adding websocket only between Codex and opencodex does not make those upstream providers
websocket-native. It would advertise a capability the routed model path does not support end-to-end
and is not expected to materially improve speed.

Future websocket work, if any, must be a separate provider-specific transport project for a provider
that actually exposes a websocket-native API. It is not part of Phase 100.

## Verification Gates

Minimum checks for the first implementation pass:

```bash
bun x tsc --noEmit
```

Catalog checks:

```bash
ocx sync
codex debug models
```

Expected routed-model assertions:

- no OpenAI/GPT identity leak in active instructions;
- no `service_tiers` / `additional_speed_tiers`;
- no accidental `use_responses_lite`;
- no accidental `tool_mode` / `multi_agent_version` unless deliberately chosen;
- no `supports_websockets` provider flag;
- context-window fields are provider-appropriate or conservative.

Runtime checks:

- streamed text still arrives incrementally;
- thinking blocks render in the intended Codex channel;
- usage includes total/input/output and, where available, cached/reasoning details;
- web-search sidecar behavior is deterministic when prerequisites are present or absent;
- context-window errors classify as Codex-recognizable failures.

## Open Decisions

1. Resolved: routed models should strip `model_messages` first. Provider-safe personality templates
   can be added later.
2. Should routed models inherit Codex feature-default multi-agent behavior by deleting
   `multi_agent_version`, or should opencodex force a specific version?
3. Resolved in Phase 100.2/100.16:
   - routed models expose deferred `tool_search` by default;
   - routed hosted web-search metadata is `text_and_image` because actual hosted search runs via
     native `gpt-5.4-mini` sidecar.
4. What conservative context-window default should apply when jawcode has no exact provider/model
   match?
5. Resolved: Phase 100 will not implement websocket support or a websocket spike. Routed providers
   keep `supports_websockets` absent/false.

## Proposed First Build Slice

Start with catalog normalization only. It has the highest leverage and lowest runtime risk:

1. strip routed `model_messages`;
2. normalize `tool_mode`, `multi_agent_version`, and `use_responses_lite`;
3. preserve native OpenAI passthrough entries;
4. keep websocket disabled;
5. add catalog snapshot tests;
6. run `bun x tsc --noEmit`;
7. manually inspect `codex debug models`.

Then add jawcode metadata snapshot support:

1. generate a small opencodex-owned metadata projection from jawcode;
2. map provider ids explicitly;
3. enrich internal routed model metadata;
4. write only Codex-verified catalog fields.

Streaming/context/error parity should follow after catalog semantics are stable.

Websocket work is intentionally excluded from this phase.
