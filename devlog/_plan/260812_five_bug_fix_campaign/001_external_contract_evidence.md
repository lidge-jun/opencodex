# 001 — External contract evidence (Luna search lanes)

Three `gpt-5.6-luna` explorer lanes were dispatched under `cxc-lunasearch`,
each attached to `cxc-search` for the proof ladder. Luna output is discovery;
the claims below were kept only where the lane opened a primary source. One
lane (first OpenAI attempt) errored with `Request blocked` and was respawned.

All retrievals: **2026-08-12**. Source anchors are given per lane below so each
claim can be re-checked independently (audit blocker B12).

## Source anchors

**Lane A (OpenAI streaming tool calls)**

- `openai-python` chunk schema — `src/openai/types/chat/chat_completion_chunk.py`
  <https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_chunk.py>
- `openai-python` stream accumulator — `src/openai/lib/streaming/chat/_completions.py`
  (accumulate at ~`:329-365`, strict-tool lookup ~`:409-424`, event build ~`:483-496`)
  <https://github.com/openai/openai-python/blob/main/src/openai/lib/streaming/chat/_completions.py>
- `openai-node` accumulator — `src/lib/ChatCompletionStream.ts` (~`:533-679`, `:747-765`)
  <https://github.com/openai/openai-node/blob/master/src/lib/ChatCompletionStream.ts>
- LiteLLM streaming handler — `litellm/litellm_core_utils/streaming_handler.py`
  (~`:804-827`, `:1411-1449`, `:1472-1487`)
  <https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/streaming_handler.py>
- OpenAI API reference (streaming) <https://developers.openai.com/api/reference/overview>

**Lane B (Gemini `thought`)**

- Gemini `generateContent` REST reference <https://ai.google.dev/api/generate-content>
- `@google/genai` `Part.thought`
  <https://googleapis.github.io/js-genai/release_docs/interfaces/types.Part.html#thought>
- Gemini thinking / thought summaries <https://ai.google.dev/gemini-api/docs/thinking>
- Thought signatures (Google AI)
  <https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures>
- Thought signatures (Vertex / Gemini Enterprise)
  <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thought-signatures>
- OpenRouter reasoning tokens
  <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- LiteLLM Gemini reasoning issue (lead only, opened 2026-04-24)
  <https://github.com/BerriAI/litellm/issues/26413>

**Lane C (Bun SIGTRAP)**

- Bun latest release — `bun-v1.3.14`, 2026-05-13
  <https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14>
- Bun #31894 stale pooled socket (1.3.14, hang) <https://github.com/oven-sh/bun/issues/31894>
- Bun #31463 `ECONNRESET` after `Connection: close` <https://github.com/oven-sh/bun/issues/31463>
- Bun #5570 `NODE_TLS_REJECT_UNAUTHORIZED` <https://github.com/oven-sh/bun/issues/5570>
- Bun #17325 self-signed CA <https://github.com/oven-sh/bun/issues/17325>

The reviewer independently re-confirmed the Lane C conclusions (Bun 1.3.14 is
current; the adjacent pooled-socket and TLS issues do not establish this
`SIGTRAP`).

## Lane A — OpenAI-compatible streaming tool-call metadata

| Claim | Status | Source |
|---|---|---|
| `function.name` normally arrives in the first delta for a tool-call index; later deltas carry only `arguments` fragments | verified | `openai-python` generated chunk schema |
| Both `name` and `arguments` are optional in the wire schema, so an arguments-only delta is structurally representable | verified | same |
| `openai-python` accumulates by index and neither synthesizes a name nor raises a name-specific error; an empty name simply fails to match an input tool | verified | `src/openai/lib/streaming/chat/_completions.py` |
| `openai-node` initializes `function.name` to `''`, overwrites only when a non-empty name arrives, and validates `finish_reason` rather than name presence at completion | verified | `src/lib/ChatCompletionStream.ts` |
| LiteLLM forwards tool-call deltas, repairs a missing `type`, but never synthesizes or rejects a missing `function.name` | verified | `litellm/litellm_core_utils/streaming_handler.py` |

**Consequence for #1514.** A call that reaches end-of-stream with no non-empty
name is not executable. The reference implementations refuse to invent one; they
simply carry an unusable object and let the caller fail. OpenCodex sits at the
boundary where the unusable object becomes a *Codex tool-call contract event*,
so the equivalent of "let the caller fail" is to not emit the call as usable.
Inventing a name is ruled out by every reference implementation, and
provider-specific tolerance is ruled out because the shape is non-conforming for
every provider, not special to one.

## Lane B — Gemini `thought` part semantics

| Claim | Status | Source |
|---|---|---|
| `Part.thought` means "this part represents the model's thought process or reasoning" | verified | Gemini `generateContent` REST reference; `@google/genai` `Part` interface |
| A text-bearing part with `thought: true` is a thought summary, not the answer channel; summaries are opt-in via `includeThoughts` | verified | Gemini thinking guide |
| `thoughtSignature` is an opaque encrypted reasoning handle that must be replayed byte-for-byte in its original part; Gemini 3 function calling returns 400 if the first function-call part of a step omits it | verified | Google AI + Vertex thought-signature guides |
| Official SDK examples branch on `part.thought` and render thought text in a separate channel | verified | `python-genai` examples |
| OpenRouter and LiteLLM normalize Gemini thoughts into a reasoning/thinking field rather than merging into visible content | verified (proxy behavior, not REST semantics) | OpenRouter reasoning docs; LiteLLM issue #26413 |
| Vertex and Cloud Code Assist / Antigravity use the same `Part.thought` / `thoughtSignature` semantics; no separate documented wire contract was found | verified-negative | Vertex guide; no contradicting official doc located |

**Consequence for #1503.** Routing `thought: true` text to hidden reasoning is
the vendor-documented contract, and preserving `thoughtSignature` untouched is a
hard API requirement for Gemini 3 tool calls — so the fix must classify text
**without** disturbing the existing `observeAntigravityReplay` path.

## Lane C — Bun SIGTRAP on macOS after TLS failure

| Claim | Status | Source |
|---|---|---|
| No `oven-sh/bun` issue was found establishing that TLS verification failure or a socket reset aborts the process with `SIGTRAP`/`EXC_BREAKPOINT` | verified-negative | issue search across TLS/fetch/crash families |
| Current stable Bun is `1.3.14`, released 2026-05-13; no 1.3.15+ stable release notes exist to inspect | verified | official GitHub `releases/latest` |
| Known adjacent defects: #31894 stale pooled keep-alive socket (1.3.14, hang not abort); #31463 `ECONNRESET` after `Connection: close` | verified | linked issues |
| Older TLS issues (#5570 `NODE_TLS_REJECT_UNAUTHORIZED`, #17325 self-signed CA) surface certificate *errors*, not process aborts | verified | linked issues |
| "Unhandled rejection in a TLS/fetch callback aborts the process" as a general Bun pattern | **unverified lead** | not established by any opened source |

**Consequence for #1419.** The issue cannot be closed by a runtime bump: the
reporter is already on the newest stable line, and no upstream fix exists to
point at. Attribution to Bun's TLS stack versus JavaScriptCore's unhandled-
exception path still requires the full faulting frame list the maintainer
requested. This unit therefore treats #1419 as *survivability hardening on the
paths we own* plus an evidence-backed disposition, and explicitly does not claim
a fix for the native trap.
