# 001 — Research record (Luna swarm + sol recon)

## Luna discovery swarm (4 lanes, gpt-5.6-luna explorers, 260715)

Hardcoded `gpt-5.3-codex-luna` was not in this session's spawn catalog; lanes ran on `gpt-5.6-luna` (stated fallback, not silent).

### Lane 1 — Fermat: /v1/models vs invocability
- `/v1/models` is catalog metadata, NOT an invocability list. Confirmed listed-but-404 case (`aisingapore/sea-lion-7b-instruct`, "404 function not found for account"): https://forums.developer.nvidia.com/t/404-function-not-found-for-account-when-calling-aisingapore-sea-lion-7b-instruct-via-integrate-api-nvidia-com/361577 (2026-02-24)
- Same pattern with kimi-k2.5: https://forums.developer.nvidia.com/t/api-url-not-working/359304 (2026-02-02)
- Some catalog models are served only at `ai.api.nvidia.com` per-model routes (e.g. VILA): https://docs.api.nvidia.com/nim/reference/nvidia-vila-infer (primary)
- Preview/rollout visibility can precede callable endpoints: https://forums.developer.nvidia.com/t/404-error-missing-api-endpoint-code-for-cosmos3-nano-on-build-nvidia-com/372044 (2026-06)

### Lane 2 — Hegel: kimi family on NIM
- Documented served ids on integrate chat/completions: `moonshotai/kimi-k2-instruct`, `kimi-k2-thinking`, `kimi-k2.5`, `kimi-k2.6` — all with tools (primary: https://docs.api.nvidia.com/nim/reference/llm-apis, https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6)
- **Smoking gun for the 400**: NIM kimi-k2.5 returns HTTP 400 `"This model only supports single tool-calls at once!"` on `parallel_tool_calls: true` — https://github.com/openclaw/openclaw/issues/37048 (2026-03-06, lead)
- No credible 404 evidence for the four documented ids → reporter's 404 is most likely account-scoped enablement or rollout gap.

### Lane 3 — Hilbert: NIM 400 validation
- `reasoning_effort` not portable across NIM models (chat_template_kwargs is the native mechanism): https://pi.dev/packages/pi-nvidia-nim (lead)
- DeepSeek on NIM: no tool calling; `tool_choice:"required"` no longer supported: https://docs.nvidia.com/nim/large-language-models/1.13.0/release-notes.html (primary)
- Unknown fields → pydantic `extra_forbidden` 400 (e.g. `max_new_tokens`): https://forums.developer.nvidia.com/t/openai-compatible-api-does-not-work/303942
- `parallel_tool_calls`/`stream_options` as NIM-wide 400 triggers: unconfirmed beyond the kimi single-tool-call case.

### Lane 4 — Zeno: free tier behavior
- 429 below nominal 40 RPM, hour-long lockouts; NVIDIA staff: limits are dynamic per model/traffic: https://forums.developer.nvidia.com/t/getting-429-too-many-request-for-nim-cloud-api/335755 (2026-06, primary)
- kimi on NIM repeatedly reported extremely slow / queued (minutes, ~5 tok/s incidents): reddit r/SillyTavernAI 2026-03/04 threads (leads).

## Local probes (Tier 2, this machine, 260715)
- `GET https://integrate.api.nvidia.com/v1/models` unauthenticated → 200, **121 models**, includes `moonshotai/kimi-k2.6` (only moonshot entry currently listed).
- POST chat/completions unauthenticated: 401 before model validation (`definitely-not-a-model` → 404 page-not-found only for garbage path-style ids). Keyed repro not possible here (no NVIDIA key configured locally).

## sol recon (Averroes) — repo trace, file:line
- Live NIM models get NO capability hints (no jawcodeBundle; NVIDIA /v1/models carries no `metadata.capabilities`): src/codex/catalog.ts:1094-1109, src/generated/jawcode-model-metadata.ts:14/45/49, src/providers/derive.ts:202.
- Routed catalog entries clone a GPT template and receive the generic reasoning ladder + default `medium`: src/codex/catalog.ts:825/846/723/741/752 → Codex sends `reasoning:{effort:"medium"}` → openai-chat emits `reasoning_effort:"medium"` to NIM (src/adapters/openai-chat.ts:263-274, src/reasoning-effort.ts:114-133).
- Suppression mechanism of record: `noReasoningModels` (src/types.ts:610, src/reasoning-effort.ts:59/116); provider-wide `reasoningEfforts: []` would wrongly kill gpt-oss reasoning on NIM. Lists are exact-id + colon-family match only (src/types.ts:158).
- `parallelToolCalls:false` sends literal `parallel_tool_calls:false` when tools are present; field omitted without tools (src/adapters/openai-chat.ts:285-290).

## Error-shape analysis (why the reporter saw bare "Provider error N")
- web-search sidecar loop: bare `Provider error ${status}` unless `responseAdapter.formatErrorBody` exists and body is display-safe (src/web-search/loop.ts:319-333); openai-chat has no formatErrorBody → detail swallowed.
- Normal bridge path appends `: ${errorText.slice(0,500)}` (src/server/responses.ts:1036) → screenshots' bare messages prove the sidecar path (mobile app had web search enabled).
