# 002 — A-gate audit + C-gate verification (WP1)

## A-gate (sol reviewer "Locke", gpt-5.6-sol + cxc-search)

VERDICT: **PASS**, 0 blockers, 5 advisories (all folded into B):

1. `noReasoningModels` exact-scoped; gpt-oss unaffected (reasoning-effort.ts:58-63,114-133; effort-policy.ts:101-114); registry merge verified (router.ts:95-106, derive.ts:82-89).
2. `parallelToolCalls:false` is provider-wide; catalog advertises `supports_parallel_tool_calls:false` (catalog.ts:486-514,1033-1049) — request-body AND catalog-bit tests required. NVIDIA function-calling docs document the param as Boolean defaulting to false → sending `false` is valid: https://docs.nvidia.com/nim/large-language-models/1.8.0/function-calling.html
3. formatErrorBody: recognized JSON string fields only, reject HTML/non-JSON, `redactSecretString`, 400-char cap; web-search loop is the sole production consumer.
4. Normal bridge path (responses.ts:1031-1037) already appends a redacted 500-char slice — no change needed.
5. Cross-provider disposition: **nvidia patch-now**; kimi/moonshot/kimi-code already covered by shared lists; opencode-go/umans expose different kimi products (k2.7-code, umans-kimi-k2.7); huggingface defer (generic router — provider-wide kimi restrictions would hit unrelated backends); fireworks/firepass defer (frozen pending entitlement proof); openrouter defer (gateway normalizes); novita/baseten absent from registry.

## B implementation

- `src/providers/registry.ts`: `NVIDIA_NIM_KIMI_MODELS` (5 documented ids) + `NVIDIA_NIM_KIMI_THINKING_MODELS`; nvidia entry gains `parallelToolCalls:false`, `noReasoningModels`, `modelReasoningEfforts:{id:[]}`, `preserveReasoningContentModels` (thinking family), evidence comment.
- `src/adapters/openai-chat.ts`: `formatOpenAIChatErrorBody` (exported) wired as the adapter's `formatErrorBody`. JSON-only; error.message / error-string / detail-string / pydantic detail[].msg join / message / title; HTML+non-JSON → ""; redact; 400-char cap.
- `tests/nvidia-nim-hardening.test.ts` (new file only — existing test files are dirty from parallel agents).

## C-gate verification (260715)

- `bun test tests/nvidia-nim-hardening.test.ts` → **14 pass / 0 fail** (28 expects).
- `bun test tests/parallel-tool-calls-optin.test.ts tests/reasoning-effort.test.ts tests/openai-chat-model-suffix.test.ts` → 70 pass / 0 fail (with new file).
- `bun test tests/web-search*.test.ts` (5 files) → 66 pass / 0 fail; `tests/codex-catalog.test.ts tests/catalog-cursor-search.test.ts tests/umans-provider.test.ts` → 67 pass / 0 fail.
- `npx tsc --noEmit`: 3 errors, ALL pre-existing in parallel agents' dirty files (`src/cli/claude.ts`, `src/server/system-env.ts` — authMode on OcxClaudeCodeConfig); zero errors in registry.ts / openai-chat.ts / new test.
