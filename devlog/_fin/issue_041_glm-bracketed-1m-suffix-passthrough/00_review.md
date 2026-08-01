# Issue #41 — glm-5.2[1m] fails with upstream 400 "Unknown Model" (Z.AI code 1211)

- **Reporter:** DomineYH (Lee YongHan)
- **URL:** https://github.com/<repo>/issues/41
- **Type:** Bug (model-string passthrough) + documentation gap
- **Severity:** Medium — one model variant unusable via openai-chat; clear workaround exists.
- **Status:** Root-caused and externally confirmed. Fix described below (NOT applied — documentation phase).

## Report summary

Routing Codex to Z.AI's GLM-5.2 1M-context variant with model id `glm-5.2[1m]`
via the `openai-chat` adapter fails every request with upstream 400, Z.AI code
`1211` "Unknown Model". The bare `glm-5.2` works. `glm-5.2[1m]` is Z.AI's
documented id for the 1M variant, so this looks like a passthrough issue.

## Root-cause analysis (confirmed in code + external docs)

opencodex forwards the model id **verbatim** as the chat-completions `model`
value. The openai-chat adapter builds the request body with:

```ts
// src/adapters/openai-chat.ts  (buildRequest, ~L164)
const body = { model: parsed.modelId, messages, stream: parsed.stream };
```

Routing only strips a leading `"<provider>/"` namespace; it does NOT touch a
trailing bracketed suffix:

```ts
// src/server.ts  handleResponses (~L375)
// "opencode-go/deepseek-v4-pro" -> "deepseek-v4-pro"; brackets are untouched.
```

So `<provider>/glm-5.2[1m]` → namespace-stripped to `glm-5.2[1m]` → sent verbatim
to `POST {baseUrl}/chat/completions` as `"model":"glm-5.2[1m]"`. Z.AI's
OpenAI-compatible endpoint does not recognize the bracketed code → `1211 Unknown
Model`.

### External confirmation (search skill, Tier 1 + Tier 2 fetch)

The `[1m]` suffix is a **Claude Code / Anthropic-endpoint-only convention**, not a
valid OpenAI chat-completions `model` value:

- Z.AI / harness setup guide (apidog, fetched):
  - Claude Code (Anthropic-compatible, base `https://api.z.ai/api/coding/paas/v4`)
    uses `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]`.
  - Cline & Cursor (OpenAI-compatible, base `https://api.z.ai/api/paas/v4/`) use
    the **bare** `glm-5.2`; the 1M context window is set **client-side**, not via
    the model id. Quote (paraphrased for compliance): the `[1m]` suffix is a
    Claude-Code-only convention; OpenAI-compatible harnesses pass the plain id and
    set the window in the UI.
    Source: https://apidog.com/blog/glm-5-2-claude-code-cline-cursor/
- Claude Code itself strips the suffix: "v2.1.173 strips [1m] suffix from custom
  inferenceGateway model names" — anthropics/claude-code issue #70419.
  Source: https://github.com/anthropics/claude-code/issues/70419

Evidence status: **sufficient** (primary vendor-adjacent guide fetched + upstream
Claude Code issue corroborates the strip behavior).
Content was rephrased for compliance with licensing restrictions.

## Proposed solution (not applied)

**Recommended (Option A — strip the bracketed suffix on the openai-chat path):**
Normalize the wire `model` value by removing a trailing `[...]` suffix before it
is sent to an OpenAI-compatible endpoint, mirroring what Claude Code does. Best
placed where the wire model is finalized — either a small normalization in
`openai-chat.ts buildRequest` (e.g. `model: stripBracketSuffix(parsed.modelId)`)
or in the routing/model-normalization layer so it is adapter-agnostic and logged
correctly. The 1M context window should come from the model's catalog/context
config, not from the suffix.

- Pros: `glm-5.2[1m]` "just works" via openai-chat; matches Claude Code behavior.
- Cons: a bracketed suffix could (in theory) be meaningful for some other
  provider — scope the strip to the openai-chat adapter and/or known Z.AI hosts,
  and keep it out of the Anthropic adapter (where `[1m]` IS valid).

**Option B (documentation-only):** Document that the GLM-5.2 1M variant via the
`openai-chat` adapter must use the bare `glm-5.2` id, and that the `[1m]`
convention is only valid through the `anthropic` adapter pointed at Z.AI's
Anthropic coding endpoint (`https://api.z.ai/api/coding/paas/v4`).

Best: ship Option A AND add the Option B doc note.

Answers to reporter's questions:
- Strip/translate the `[1m]` suffix on the openai-chat path: **yes** (Option A).
- The `[1m]` variant is reachable through the `anthropic` adapter at the Z.AI
  Anthropic coding endpoint: **yes**.
- Recommended config today (workaround until Option A ships): use model id
  `glm-5.2` (no suffix) with the `openai-chat` adapter at base
  `https://api.z.ai/api/paas/v4/`; configure the 1M context window in the model
  catalog/config rather than the model name.

## Verification approach

- Unit test: assert `buildRequest({ modelId: "glm-5.2[1m]" })` emits
  `body.model === "glm-5.2"` on the openai-chat path, and that the anthropic
  adapter leaves it untouched.
- Manual: route `glm-5.2[1m]` through openai-chat and confirm the upstream 400
  (code 1211) is gone.

## Effort & risk

- Effort: small (one normalization helper + tests + a README note).
- Risk: low — confine the strip to the OpenAI-compatible path; never alter the
  Anthropic adapter where `[1m]` is the documented convention.
