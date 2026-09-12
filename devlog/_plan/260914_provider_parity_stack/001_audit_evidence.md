# Audit evidence and vendor contracts

Research for the provider parity stack. Source anchors and external contracts only;
the diffs live in the decade documents.

## Provenance

The 2026-09-14 audit classified 93 providers across 13 base adapters at `dev`
`cb2e15ba6f`, using static tracing and offline mocks with no live account inference.
Its confirmed findings are at
`/Users/jun/.aside/u/0/opencodex-provider-audit-20260914-012106/AUDIT-SUMMARY.ko.md`,
with reproduction output in `probe-results.json` and `codex-audio-probe.json`.

The individual reports behind that summary contain speculative candidates and some
wrong scope estimates. Only the independently reproduced table is treated as input
here, and every anchor below was re-read in this worktree at `df7dc1be53`.

A passing probe in that suite means the defect reproduces. Those probes are not
reused as this unit's acceptance gate: they assert current behavior, so they would
pass before a fix and fail after it.

## Confirmed findings

### F1 — native Chat image recognition is narrower than the translated path

`isNativeChatRouteEligible` diverts an image-bearing body away from the native fast
path when the routed model is text-only (`src/server/chat-native.ts:155`), but the
predicate it calls only recognizes `image_url`
(`chatBodyCarriesImage`, `src/server/chat-native.ts:168-177`).

The translated path is strictly wider. `imageUrlFromPart`
(`src/chat/inbound.ts:48-79`) also accepts Pi/MCP-style `{type:"image", data,
mimeType}` parts and Anthropic-shaped `{type:"image", source:{...}}` parts, in both
base64 and URL form.

Two consequences follow from the same gap. A text-only routed model keeps a body
carrying a Pi or Anthropic image, because the eligibility check cannot see it. And
because the native path is a whitelist passthrough
(`buildOpenAIChatPassthroughRequest`, `src/adapters/openai-chat.ts:115-134`), the
non-OpenAI-shaped part is forwarded to the upstream verbatim rather than in the
`image_url` form an OpenAI-compatible endpoint accepts.

Probe: `probe-results.json` `F1` records `nativeEligible:true` for two `image`
parts and `false` for `image_url`.

### F7 — an explicit reasoning disable is dropped at the Chat boundary

`OUTPUT_CONFIG_EFFORTS` (`src/chat/inbound.ts:28`) is the allowlist
`resolveReasoningEffort` filters against (`src/chat/inbound.ts:243-253`). It holds
`minimal` through `ultra` and omits `none`.

`none` is a real sentinel elsewhere in the runtime, not an unknown string.
`src/reasoning-effort.ts:41` accepts it as a valid effort and `:196` maps it to
"omit the reasoning parameter". The Pi client export depends on that meaning:
`src/clients/config-export.ts:909-916` maps Pi's `off` level to `none`.

So a Pi user who turns thinking off sends `reasoning_effort:"none"`, the allowlist
drops it as if nothing was requested, and a provider default takes over. For
Anthropic families that think by default, omission is not neutral —
`src/adapters/anthropic.ts:960-966` documents that `"none" is not the same as
absent`, because only an explicit `thinking:{type:"disabled"}` turns thinking off.

Probe: `probe-results.json` `F7` — the Responses ingress yields
`thinking:{type:"disabled"}`, the Chat ingress yields `thinking:{type:"adaptive"}`
and an output config of `effort:"high"` from the same caller intent.

### F2 — the Responses control strip is adapter-wide, not ChatGPT-scoped

`src/server/chat-completions.ts:223-230` deletes `max_output_tokens`,
`temperature`, `top_p`, `stop` and `user` whenever
`settledRoute?.provider.adapter === "openai-responses"`, with the comment
"ChatGPT backend rejects store:true and unsupported sampling knobs".

The restriction is real for the canonical ChatGPT backend. The condition is not:
`provider-inventory.json` lists seven providers on that adapter — `openai`,
`openai-apikey`, `meta-model`, `meta-muse`, `zai`,
`zhipu-bigmodel-responses`, `volcengine-agent-plan`. A generic API-key Responses
endpoint loses the caller's output cap and sampling controls for no upstream reason.

Probe: `probe-results.json` `F2` — same request, Responses ingress keeps
`max_output_tokens:123 / temperature:0.2 / top_p:0.8`, Chat ingress yields null for
all three.

`stop` is deliberately not treated as universally supported: it is not part of the
claim this unit makes.

### F6 — translated Chat loses assistant reasoning and penalties

`assistantContentToBlocks` (`src/chat/inbound.ts:121-137`) keeps `text` and
`output_text` only. An assistant turn's `reasoning_content` or
`reasoning_details` is dropped before the Responses projection exists.

The outbound direction is already implemented: `src/adapters/openai-chat.ts:800-843`
reconstructs `reasoning_content` or `reasoning_details` for providers listed in
`preserveReasoningContentModels`, falling back to a replay cache. So the runtime
can express the field; the inbound translation is the asymmetry.

Penalties are the second half. `src/responses/schema.ts:162-163` accepts
`presence_penalty` and `frequency_penalty`, `src/responses/parser.ts:544-545`
parses them into `options.presencePenalty`/`frequencyPenalty`, and
`src/adapters/openai-chat.ts:1600-1603` writes them back to the wire. The Chat
inbound body builder (`src/chat/inbound.ts:337-362`) never copies them, so the
chain is broken only at its first link.

Probe: `probe-results.json` `F6` — `projectedPenaltyPresent:false` while the
native path reports `nativePenalty:0.4` and `nativeReasoning:"prior analysis"`.

Boundary: a thinking signature and cross-provider opaque reasoning metadata are not
representable from a plain Chat string and must never be forged. Only plaintext and
the numeric controls are in scope; opaque replay is recorded as residual.

### F3 — Google structured output never reaches the wire

`src/adapters/google.ts:816-849` builds `generationConfig` from
`maxOutputTokens`, `temperature`, `topP`, `stopSequences`, `thinkingConfig`
and `responseModalities`. It never reads `parsed.options.textFormat`, which the
Responses parser populates at `src/responses/parser.ts:561-562`.

`compileGenerationConfig` (`src/adapters/google-wire-compiler.ts:118-151`)
whitelists the same six keys, so the defect is two-layer: adding a field in the
adapter alone would still be dropped before the wire.

Probe: `probe-results.json` `F3` — a well-formed `irFormat` with
`googleGenerationConfig:null` and `compiledGenerationConfig:null`.

Google `tool_choice` is already implemented
(`toolChoiceToGeminiToolConfig`, used at `src/adapters/google.ts:822-823`); the
individual reports' claim that it is missing is not adopted.

### F4 — Anthropic parallel-tool disable is not mapped

`src/adapters/anthropic.ts:1015-1022` maps `toolChoice` onto Anthropic's
`tool_choice` object and never emits `disable_parallel_tool_use`.
`parsed.options.parallelToolCalls` (`src/types/request.ts:250`) carries the
caller's intent and has no Anthropic consumer.

The block is also gated on `parsed.options.toolChoice` being set, so a request
that sends only `parallel_tool_calls:false` emits no `tool_choice` at all.

Probe: `probe-results.json` `F4` — `inputParallel:false` produces
`toolChoice:{type:"auto"}` with no disable flag.

### F8 — CodeBuddy keeps user images and flattens tool-result images

`buildConversationInput` (`src/adapters/coding-agent/protocol.ts:415-462`) is
shared by the CodeBuddy and Qoder adapters. A current `user` message's image parts
become real image blocks through `imagePart` (`:423`), and history user images are
collected the same way (`:446`).

A `toolResult` message takes a different branch (`:431-436`): its content parts are
mapped with `p.type === "text" ? p.text : "[image]"` and joined into prose. The
image carrier is discarded and replaced by a literal marker. A current user message's
non-image media takes the same shape at `:425` with `"[video]"`.

Probe: `probe-results.json` `F8` — `userImageParts:1`,
`currentToolImageParts:0`, `historicalToolImageParts:0`.

Qoder's explicit 400 on original images and the vendor-tools-disabled policy on both
adapters are deliberate and stay.

### F5 — file and audio payloads disappear in the translated IR

`OcxContentPart` (`src/types/request.ts:189-204`) is `text | image | video`.
There is no file or audio member.

`inputContentParts` (`src/responses/parser-content.ts:33-60`) converts
`input_file` into a `[file: name]` text marker and has no `input_audio` branch at
all, so an audio part is silently dropped. `outputToToolResultContent`
(`:94-120`) has the same gap on the tool-output side.

The upstream Codex wire shape was checked directly rather than assumed:
`git show HEAD:codex-rs/protocol/src/models.rs` in the Codex mirror carries
`input_audio` with an `audio_url` field, in both user content and tool output.

Probe: `codex-audio-probe.json` — `rawUserPreserved:true` and
`rawToolPreserved:true` against `irUserPreserved:false` and
`irToolPreserved:false`. The raw passthrough keeps the payload; only the translated
IR loses it.

This unit prefers a scoped explicit refusal over a speculative universal audio
implementation, and native raw passthrough keeps its existing capability. No raw
media bytes may appear in an error message.

### F9 — translated Chat video vanishes or becomes a malformed part

The IR does carry video: `parser-content.ts:48-50` produces
`{type:"video", videoUrl}`. The loss is in the Chat adapter's serialization
(`src/adapters/openai-chat.ts:770-792`), where a non-text timeline part
"serializes to nothing", and the image-bearing branch maps every non-image part to
`{type:"text", text: (p as OcxTextContent).text}` — for a video part `text` is
`undefined`, producing a text part with no text.

Probe: `probe-results.json` `F9` — `textVideoMessages` shows the video gone and
`imageVideoHasMissingTextField:true`.

Native Chat passthrough and Google inline video behavior are unaffected and must stay.

### Kiro remote image

Recorded by the audit as a static-path loss where both the bytes and any marker are
absent. Treated here as a candidate for an explicit refusal or fallback with a
regression test. No fetching is introduced to resolve a remote reference.

## Vendor contracts

### Google — structured output on `generateContent`

Sources: `https://ai.google.dev/gemini-api/docs/generate-content/structured-output`
and `https://ai.google.dev/api/generate-content`.

Structured output is configured inside `generationConfig`, on `generateContent`
itself. There is no separate Interactions API involved.

- `responseMimeType: "application/json"` selects JSON output.
- `responseJsonSchema` accepts an ordinary JSON Schema object — lowercase type
  names, `required`, `additionalProperties` — the shape produced by
  `zodToJsonSchema` or Pydantic.
- `responseSchema` accepts Gemini's own typed `Schema` form with uppercase type
  names such as `"OBJECT"` and `"STRING"`.

`parsed.options.textFormat.schema` is already an OpenAI-style JSON Schema with
lowercase types, so `responseJsonSchema` is the matching field and no type-case
translation is required.

Two cautions carry into the diff. The response type does not change: the model still
returns text, and that text contains the conforming JSON, so Google response parsing
stays untouched. And `sanitizeGeminiToolParameters` exists to coerce schemas into
the tool-declaration subset — applying it to an output schema would corrupt a valid
JSON Schema, so the output path needs its own handling.

Mode support is not assumed uniform. AI Studio and Vertex `generateContent` are in
scope. The Cloud Code Assist envelope used by Antigravity, and Claude models served
through it, are not verified for this field, so they get an explicit refusal rather
than a silent drop.

### Anthropic — parallel tool use

Source: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use`
and the tool-use implementation guide.

`disable_parallel_tool_use` is a boolean nested inside the `tool_choice` object.
Its per-mode meaning:

| `tool_choice` | with `disable_parallel_tool_use: true` |
|---|---|
| `{"type":"auto"}` | zero or more tools -> at most one tool call |
| `{"type":"any"}` | must call one -> exactly one call |
| `{"type":"tool","name":...}` | must call that tool -> exactly one call |
| `{"type":"none"}` | tool use is off; the flag is irrelevant |

That table settles every branch the adapter has. An implicit auto needs a
synthesized `{"type":"auto", disable_parallel_tool_use:true}`, because today no
`tool_choice` is emitted at all. `required` maps to `any` and a named choice maps
to `tool`; both accept the flag. `none` does not get the flag, and a request with
no tools emits no `tool_choice`.

The flag constrains the model's output, not execution ordering — sequential tool
use is enforced by the caller's own loop returning each `tool_result` before the
next request. The PR states that boundary rather than claiming general parallelism
control.
