# 008 — Model/provider logic delta

> Evidence boundary: jawcode paths below refer to the fingerprinted local uncommitted snapshot, not a merged upstream release.

## 1. Cursor client version

### jawcode

`packages/ai/src/providers/cursor/client-version.ts` owns one `CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335"`, used by model discovery and run transport. Its invariant is valuable: one backend integration should not silently drift because only one caller was updated.

### OCX

- discovery: `src/adapters/cursor/live-models.ts:20` — `cli-2026.02.13-41ac335`
- run: `src/adapters/cursor/live-transport.ts:56` — `cli-2026.07.08-0c04a8a`

### Decision

- Shared owner: `ADAPT`.
- Exact value: `RESEARCH`.

The centralization can be imported as an invariant, but choosing the older jawcode value would be an unsupported behavior change. Probe both endpoints with one value first.

## 2. OpenAI/Azure bounded 429

### jawcode

`openai-bounded-rate-limits.ts` wraps the OpenAI SDK fetch. A 429 is marked `x-should-retry:false` when Retry-After exceeds 60 seconds or the body matches permanent quota phrases such as `out_of_credits`, `insufficient_quota`, or monthly usage limit.

### OCX

- `src/lib/upstream-retry.ts:38` retries selected 500/502/503/504/520/521/522 statuses only.
- 429 is not a generic transient retry.
- `src/providers/key-failover.ts:73` can rotate an API-key pool on 429; with no alternative it surfaces the failure.

### Decision

Direct port is `REJECT`; outcome is currently `NOOP`. The jawcode wrapper solves SDK-internal retry behavior that OCX does not use. If OCX later adopts an SDK or begins retrying 429, bring over the **classification tests**, not necessarily the wrapper.

## 3. GPT-5.6 policy

jawcode adds curated Luna/Sol/Terra descriptors and constructs 1.05M OpenAI API rows plus 373K Codex rows, then `applyGpt56ContextWindow` resets both to 373K. OCX already exposes the IDs but has route-specific 372K/1.05M contracts.

Decision: model IDs `NOOP`, context `RESEARCH`, cost `REJECT` current scope. See [007](./007_model_id_delta.md).

## 4. Antigravity retired model

jawcode `model-manager.ts` filters `google-antigravity/gemini-3.1-pro-high` from bundled, cached, and dynamic model lists. OCX still maps it to `gemini-pro-agent` in `src/providers/antigravity-models.ts:21` and tests both picker presence and wire mapping.

Two contracts must not be collapsed:

1. **Picker exposure:** `RESEARCH`; remove only after authenticated availability/inference proof.
2. **Inbound compatibility alias:** `NOOP` now; preserve existing saved config even if the picker row is retired later.

## 5. OpenCode Go Kimi effort

jawcode's local compatibility logic records:

- `kimi-k2.5`: `minimal -> low`
- `kimi-k2.7-code`: `xhigh -> high`, `max -> high`
- Kimi reasoning is disabled for forced tool-choice cases.

OCX currently sets an empty effort list and `noReasoningModels` for both `kimi-k2.7-code` and `kimi-k2.7-code-highspeed`, while preserving reasoning content for replay.

Decision: keep the conservative behavior until live probes establish a matrix. The base model could become `ADAPT`; highspeed remains independent `RESEARCH` because jawcode evidence does not cover it.

## 6. Anthropic thinking and stream hardening

### Disabled thinking

OCX `src/adapters/anthropic.ts:629` only sends thinking for a string effort other than `none`. This already matches jawcode's general-path omission, so it is `NOOP`.

`tests/web-search-anthropic.test.ts:196` proves the web-search sidecar intentionally sends `{type:"disabled"}`. This is a separate endpoint contract and is not evidence of a bug in the general adapter.

### Tool argument and block-index changes

jawcode also sanitizes tool argument JSON and tracks stream block indices. Those are SDK/event-shape-specific. Before adapting them, reproduce malformed JSON or interleaved block loss in OCX's own adapter/parser fixtures. Decision: `RESEARCH`, then architecture-specific `ADAPT` only if reachable.

## 7. Google request compatibility

jawcode changes Gemini CLI version headers and sanitizes JSON strings in tool arguments. OCX's Google AI Studio/Vertex/Antigravity ownership does not automatically share the Gemini CLI fingerprint.

- Header version: direct port `REJECT` unless OCX sends the same endpoint/header contract.
- Tool JSON sanitizer: `RESEARCH`; require a failing OCX fixture before adding normalization.

## 8. Generated metadata consumption

The generator writes six model fields: provider, id, context window, max tokens, input modalities, reasoning, and optional wire model ID. OCX catalog application at `src/codex/catalog.ts:517` consumes only context window and input modalities. `CatalogModel` has no max-output or wire-ID field, and missing rows are appended only for `opencode-go`.

Consequences:

- Refreshing the generated file can update context/input on an already discovered row.
- It cannot by itself expose new OpenRouter/xAI/Anthropic rows.
- `maxTokens` diffs have no current runtime effect.
- Adding consumers requires an explicit precedence contract against live metadata and registry hints.

Decision: generator refresh and consumer expansion are separate tasks. The former is mechanical; the latter is `RESEARCH`/`ADAPT` with focused tests.

## 9. Anthropic organization identity

jawcode chase cites upstream organization-scoped auth behavior, but the inspected local source does not establish that full change. OCX `src/oauth/anthropic.ts:30-67` parses account UUID/email and the credential store uses those identities.

Decision: `RESEARCH`. Obtain the actual token response schema and a multi-org collision scenario before changing storage identity. This is `chase-only`, not a confirmed local implementation delta.

## 10. Safety, invalid prompt, and terminality

Chase items describe invalid-prompt breakers, refusal/safety stops, and fallback boundaries. In OCX, 400 errors are not generic retry candidates and the Responses parser already understands refusals. Therefore a retry circuit-breaker port is `NOOP`; cross-provider safety normalization remains `RESEARCH` only if a concrete terminality bug appears.

## 11. LiteLLM metadata

OCX live model parsing accepts ID/owner, context length variants, and limited reasoning/vision capabilities. It intentionally drops arbitrary rich metadata.

Decision: `ADAPT` consumer-first. Add only a field that a Codex-visible catalog or request adapter consumes, together with precedence and fixture tests. Do not add a lossless passthrough bag merely to mirror OMP.

## 12. Product-boundary rejects

The following chase ideas belong to jawcode/OMP agent products and are not direct OCX proxy imports:

- floating model selection and model hub UX;
- custom role models and task-agent resolution;
- agent prompt caps and dispatch preprocessing;
- standalone Fugu/Sakana login without an OCX endpoint/auth requirement.

They are `REJECT` for direct port, not claims that the ideas are intrinsically invalid. A future OCX product requirement must start a separate owner-first design.

## 13. Recommended implementation order

1. Probe and centralize Cursor client version.
2. Probe Antigravity picker retirement while preserving inbound alias compatibility.
3. Decide whether generated jawcode metadata should be refreshed only, or whether a specific unconsumed field needs a real consumer.
4. Probe OpenCode Go Kimi base/highspeed effort support separately.
5. Add Z.AI/LiteLLM/Anthropic changes only from provider-specific fixtures.
