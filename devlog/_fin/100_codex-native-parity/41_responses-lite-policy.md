# 100.41 — Responses Lite Policy

## Decision

For routed non-OpenAI models:

```text
delete use_responses_lite
```

or explicitly set:

```text
use_responses_lite = false
```

Either is acceptable. Deleting is cleaner because Codex's default is false.

## Why

`use_responses_lite` is not just a UI flag. When true, Codex changes the outgoing request shape:

- strips image detail fields;
- sets reasoning context differently;
- disables parallel tool calls;
- sends a Responses Lite internal header on HTTP paths;
- sends `responses_lite = true` metadata on websocket paths;
- changes hosted tool exposure.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:408
/tmp/opencodex-codex-src/codex-rs/models-manager/src/model_info.rs:68
/tmp/opencodex-codex-src/codex-rs/core/src/client_common.rs:52
/tmp/opencodex-codex-src/codex-rs/core/src/client.rs:700
/tmp/opencodex-codex-src/codex-rs/core/src/client.rs:759
/tmp/opencodex-codex-src/codex-rs/core/src/client.rs:811
/tmp/opencodex-codex-src/codex-rs/core/src/client.rs:840
/tmp/opencodex-codex-src/codex-rs/core/src/client.rs:1644
/tmp/opencodex-codex-src/codex-rs/core/src/client.rs:1746
```

## Current Observation

The current local opencodex catalog shows:

```text
use_responses_lite: false
```

for both native and routed sample entries in:

```text
/Users/jun/.codex/opencodex-catalog.json
```

That is currently safe, but still inherited. The Phase 100 policy is to make the safe value
deliberate instead of accidental.

## Websocket Policy

Do not set provider-level:

```text
supports_websockets = true
```

for opencodex until there is an end-to-end Responses websocket proxy.

Current routed providers mostly end in HTTP/SSE provider APIs. A websocket first hop from Codex to
opencodex would not remove the upstream HTTP/SSE bottleneck and can introduce fallback or protocol
mismatch risk.

## Implementation Rule

In routed-entry normalization:

```text
if slug includes "/":
  delete use_responses_lite
```

Keep native OpenAI passthrough untouched.
