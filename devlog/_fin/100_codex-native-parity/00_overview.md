# 100 — Codex Native Parity Plan

Date: 2026-06-20

## Goal

Phase 90 proved that opencodex can make Codex CLI/App treat the proxy as a native Codex
provider by injecting the right provider config and model catalog. Phase 100 is the next
parity pass: audit every Codex-native catalog/runtime selector that opencodex currently
inherits from a template, then decide which fields should be preserved, rewritten, or stripped
for routed non-OpenAI models.

This started as planning-only research. Implementation now proceeds in independent PABCD slices,
with each slice recorded in this devlog and committed separately.

## Research Split

The investigation was split lexicographically by decade:

| File | Topic |
| --- | --- |
| `10_search-and-tool-discovery.md` | `supports_search_tool`, `web_search_tool_type`, hosted vs deferred search fallback |
| `11_search-defaults-and-inherited-state.md` | Native Codex search defaults and current opencodex inherited catalog state |
| `12_catalog-normalization-implementation-plan.md` | Phase 100.1 implementation plan for routed catalog selector normalization |
| `13_catalog-normalization-completion.md` | Phase 100.1 completion evidence and verification record |
| `20_personality-model-messages.md` | `model_messages`, `supports_personality`, prompt identity/personality support |
| `21_model-messages-strip-first.md` | Follow-up decision: strip `model_messages` from routed models first |
| `30_tool-mode-multi-agent.md` | `tool_mode`, `multi_agent_version`, code-mode and subagent selector behavior |
| `40_responses-lite-websockets.md` | `use_responses_lite`, `supports_websockets`, HTTP/SSE vs WS viability |
| `41_responses-lite-policy.md` | Follow-up policy for `use_responses_lite` inheritance |
| `50_streaming-thinking-context.md` | intermediate text, thinking blocks, token usage, context window metadata |
| `51_raw-reasoning-bridge.md` | Raw `response.reasoning_text.delta` evidence and required bridge shape |
| `60_jawcode-metadata-snapshot.md` | jawcode metadata reuse plan for context/capability defaults |
| `90_phase-plan.md` | implementation order and verification gates |

## Primary Finding

opencodex intentionally clones a native Codex model template so Codex's strict catalog parser and
App/TUI picker recognize routed model entries. That was necessary for Phase 90, but it means routed
models can also inherit native-only runtime selectors:

- hosted/deferred search capabilities;
- `model_messages` identity/personality templates;
- code-mode tool exposure;
- multi-agent V1/V2/disabled selection;
- responses-lite behavior;
- context-window and token accounting defaults;
- websocket capability hints.

For routed models, every inherited field should be considered unsafe until opencodex either proves
it is provider-neutral or normalizes it deliberately.

## Recommended Principle

Use native Codex metadata only as a structural template. For routed entries:

1. Preserve fields that are purely parser/picker compatibility.
2. Rewrite fields that mention model identity, provider identity, reasoning semantics, context size,
   tool exposure, or runtime transport.
3. Strip fields that advertise native OpenAI-only capability unless opencodex implements an
   equivalent bridge.

## Highest Priority Fixes

1. Strip `model_messages` from routed non-OpenAI models first so GPT/Codex/OpenAI identity does not
   leak through `instructions_template`.
2. Normalize `tool_mode`, `multi_agent_version`, and `use_responses_lite` instead of inheriting them
   silently from the native template.
3. Do not implement websocket support in Phase 100. Keep `supports_websockets` absent/false for
   routed providers because the routed path is upstream HTTP/SSE, and a websocket first hop cannot
   make non-websocket upstream models websocket-capable.
4. Add provider/model-specific context-window metadata instead of inheriting native GPT limits.
5. Extend usage/reasoning streaming parity so Codex receives cached/reasoning token details and the
   correct reasoning channel shape.

## Websocket Decision Update

Earlier Phase 100 docs treated websocket as a possible later spike. That is now explicitly out of
scope for Phase 100.

```text
Decision: no 100.6 websocket spike
Policy: routed providers keep supports_websockets absent/false
Reason: upstream routed providers are HTTP/SSE, so websocket is not end-to-end
```

If websocket-native provider support is ever useful, it should be a separate transport project after
a provider exposes a real websocket endpoint that opencodex can bridge without converting back to
HTTP/SSE internally.

## Follow-up Decision Update

The follow-up investigation changed the first implementation recommendation:

```text
Earlier: try rewriting model_messages first.
Now: strip model_messages from routed non-OpenAI entries first.
```

Reason: Codex prefers `model_messages.instructions_template` over `base_instructions`. The current
opencodex catalog rewrite only changes `base_instructions`, so routed models cloned from native
`gpt-5.5` can still receive the native GPT/Codex template. Stripping is the lowest-risk way to make
Codex use the already-rewritten `base_instructions` and disables `/personality` only until
provider-safe templates exist.

## Source Baseline

The upstream Codex source inspected for this planning pass was cloned at:

```text
/tmp/opencodex-codex-src
```

The inspected commit was:

```text
c83618ab2098525d343df2160d98b2449dca6d5d
```

The main opencodex implementation surfaces referenced by the plan are:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts
```
