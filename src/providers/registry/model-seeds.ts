import type { ProviderModelDiscoverySpec } from "./types";

// Shared between the OAuth (Claude account) and API-key Anthropic entries so both expose the
// same static model seed.
// 260710 context refresh: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/001_research_frontier.md.
// 260902 Claude Fable 5.1 (`claude-fable-5-1`): 1M context / 128K output / adaptive thinking
// always on, per the official models overview and pricing page (platform.claude.com).
export const ANTHROPIC_MODELS = ["claude-fable-5-1", "claude-fable-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
export const ANTHROPIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = { "claude-fable-5-1": 1_000_000, "claude-sonnet-5": 1_000_000, "claude-fable-5": 1_000_000, "claude-opus-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000, "claude-opus-4-6": 1_000_000, "claude-sonnet-4-6": 1_000_000, "claude-haiku-4-5": 200_000 };
// All seeded Claude models support vision: https://platform.claude.com/docs/en/models/overview
export const ANTHROPIC_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  ANTHROPIC_MODELS.map(id => [id, ["text", "image"]]),
);
// Every current Claude family accepts at least 64k output tokens (Haiku 4.5 / Sonnet 4.x
// through Opus 5 and Fable 5). Anthropic caps max_tokens per model server-side, so a
// larger request never over-allocates; it only stops the 8192 truncation.
export const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
/**
 * The effort rungs opencodex exposes for native Anthropic models. Without this the
 * providers advertised no ladder at all, so every client that keys its effort control off
 * `reasoningEfforts` — Aside and the rest of the Pi-shaped exports — wrote these models
 * with no control, while the SAME Claude models routed through `cursor` or
 * `google-antigravity` had one.
 *
 * This is an opencodex ladder, not a claim that each model takes `output_config.effort`.
 * The adapter serves two wire shapes (src/adapters/anthropic.ts): adaptive families
 * (fable, sonnet >= 5, opus >= 4.7) send the effort directly, while opus 4.6, sonnet 4.6
 * and haiku 4.5 take the legacy path where `reasoningBudget` TRANSLATES each rung into
 * `thinking.budget_tokens`. Anthropic documents `low|medium|high|max` for the 4.6 models
 * and no effort parameter at all for haiku 4.5; the budget translation is what makes five
 * rungs meaningful there, and it clamps below `max_tokens` so none of them 400.
 *
 * Deliberately excluded, each because advertising it would offer a control that does not
 * do what it says:
 * - `minimal`: `adaptiveEffort` rewrites it to `low` (the adaptive wire 400s on it), so
 *   it is not a distinct setting.
 * - `none`: only sonnet >= 5 accepts an explicit thinking disable
 *   (`EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS`); Fable rejects one outright.
 * - `ultra`: not an Anthropic concept, and it is degraded to `max` at the request
 *   boundary anyway (src/responses/parser.ts).
 */
export const ANTHROPIC_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const ANTHROPIC_MODEL_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  ANTHROPIC_MODELS.map(id => [id, [...ANTHROPIC_REASONING_EFFORTS]]),
);

// 260814 GLM-5.3 is registered pre-emptively alongside 5.2 everywhere 5.2 appears. Z.AI's
// devpack "How to Switch Models" page (docs.z.ai/devpack/latest-model) lists glm-5.3 and
// glm-5.3[1m] as Coding Plan ids on the unchanged endpoints; the capability and pricing
// tables were not published yet, so every 5.3 row mirrors its 5.2 sibling until they settle.
// The non-Z.AI providers below are speculative on purpose: they carry 5.2 today and are
// expected to pick 5.3 up on their usual lag. Providers whose live /v1/models discovery is
// enabled self-correct on the next successful fetch; static ones need a follow-up refresh.
// Every 5.3 family member, so the effort ladder, the default effort and the output
// cap are derived in ONE place. `glm-5.3-flash` was seeded into the model list and
// the context map by hand and left out of this constant, which meant it advertised
// a 1M context with a null effort ladder, no default effort and no output cap while
// its siblings carried three tiers, a `max` default and 131072 tokens. A member
// added to the list but not to the family is a model whose metadata silently
// disappears.
export const ZAI_GLM_53_MODELS = ["glm-5.3", "glm-5.3[1m]", "glm-5.3-flash"];
export const ZAI_GLM_52_MODELS = ["glm-5.2", "glm-5.2[1m]"];
export const ZAI_GLM_5X_MODELS = [...ZAI_GLM_53_MODELS, ...ZAI_GLM_52_MODELS];
/**
 * The 5.x rows whose images the PROXY has to describe, which is NOT the same set as
 * the 5.x rows themselves.
 *
 * `glm-5.3-flash` is a native VLM (docs.z.ai/guides/vlm/glm-5.3-flash), so listing it
 * in `noVisionModels` sent an image through the vision sidecar and handed the model a
 * text description of a picture it could have read itself - no error, worse answer,
 * extra call. The correction commit fixed the Alibaba entries and left the eight
 * providers that reach this constant behind.
 *
 * Kept separate from ZAI_GLM_5X_MODELS rather than filtered at each use site: that
 * constant also drives `modelSupportsReasoningSummaries` and
 * `preserveReasoningContentModels`, where flash DOES belong.
 */
export const ZAI_GLM_5X_SIDECAR_VISION_MODELS = ZAI_GLM_5X_MODELS.filter(id => id !== "glm-5.3-flash");
/**
 * Positive input-modality declaration for the Chat-path GLM rows.
 *
 * `noVisionModels` already keeps Flash out of the vision sidecar, but that is a NEGATIVE
 * statement: it stops a detour without telling the catalog what the model can read. With
 * no `modelInputModalities` entry, `configuredInputModalities` returns undefined and the
 * catalog falls through to the `["text"]` floor, so every client export (ZCode, Pi, OMP)
 * listed a native VLM as text-only and its picker refused to attach an image.
 *
 * The Responses sibling row below already declares this positively, so the same model was
 * described two different ways in one registry.
 *
 * Authoritative source: `GET https://api.z.ai/api/v1/models` returns `input_modalities:
 * ["text"]` for glm-5.3 and `["text", "image"]` for glm-5.3-flash (captured in
 * devlog/_plan/260912_zcode_protocol_and_catalog/evidence/zai-responses-models.json).
 * docs.z.ai/devpack/latest-model says the same in prose: "GLM-5.3 is a text-only model...
 * GLM-5.3-FLASH is a multimodal model". Upstream also lists video and file for Flash;
 * neither the internal vocabulary nor the export vocabulary can express them, so `image`
 * is where this stops.
 */
export const ZAI_GLM_5X_INPUT_MODALITIES: Record<string, string[]> = {
  ...Object.fromEntries(ZAI_GLM_5X_SIDECAR_VISION_MODELS.map(id => [id, ["text"]])),
  "glm-5.3-flash": ["text", "image"],
};
export const ZAI_GLM_52_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * GLM-5.3 does NOT share 5.2's five-tier ladder. docs.z.ai/devpack/latest-model folds every
 * incoming effort into three effective tiers — low/minimal/light -> low, medium/high -> high,
 * xhigh/max/ultra -> max — with max as both the default and the unknown-value fallback.
 * Advertising five levels would publish two picker rows that are indistinguishable on the wire,
 * so only the effective tiers are exposed (same treatment Cursor and Baseten already give GLM).
 */
export const ZAI_GLM_53_REASONING_EFFORTS = ["low", "high", "max"];
/** Per-model ladders for the Coding Plan rows: 5.3 gets its three effective tiers, 5.2 keeps five. */
export const ZAI_GLM_5X_REASONING_EFFORTS: Record<string, string[]> = {
  ...Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, ZAI_GLM_53_REASONING_EFFORTS])),
  ...Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_EFFORTS])),
};
// 260710 MiniMax models and context windows: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/002_research_cn.md.
export const MINIMAX_MODELS = [
  "MiniMax-M3",
  "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1", "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
];
export const MINIMAX_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  MINIMAX_MODELS.map(id => [id, id === "MiniMax-M3" ? 1_000_000 : 204_800]),
);
export const MINIMAX_M3_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const MINIMAX_M3_REASONING_EFFORT_MAP: Record<string, string> = {
  none: "disabled",
  minimal: "disabled",
  low: "disabled",
  medium: "adaptive",
  high: "adaptive",
  xhigh: "adaptive",
  max: "adaptive",
};
export const OPENAI_GPT56_MODELS = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
export const OPENAI_GPT56_PRO_MODELS = ["gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro"];
export const OPENAI_API_GPT56_CONTEXT_WINDOW = 1_050_000;
export const OPENAI_API_GPT56_CONTEXT_WINDOWS: Record<string, number> = {
  ...Object.fromEntries([...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, OPENAI_API_GPT56_CONTEXT_WINDOW])),
  "gpt-5.5": OPENAI_API_GPT56_CONTEXT_WINDOW,
};
export const OPENAI_API_GPT56_MAX_INPUT_TOKENS: Record<string, number> = {
  ...Object.fromEntries([...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, 922_000])),
  "gpt-5.5": 922_000,
};
export const OPENAI_API_GPT56_VIRTUAL_MODELS: Record<string, { wireModelId: string; reasoningMode: "pro" }> = {
  "gpt-5.6-sol-pro": { wireModelId: "gpt-5.6-sol", reasoningMode: "pro" },
  "gpt-5.6-terra-pro": { wireModelId: "gpt-5.6-terra", reasoningMode: "pro" },
  "gpt-5.6-luna-pro": { wireModelId: "gpt-5.6-luna", reasoningMode: "pro" },
};
export const OPENAI_API_GPT56_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/*
 * Meta Model API (https://api.meta.ai/v1) — published ladder, deliberately NOT the
 * house set. dev.meta.ai/docs/reasoning lists "none", "minimal", "low", "medium",
 * "high", "xhigh" and then excludes "none" for this family: "not supported by Muse
 * Spark and returns HTTP 400". "max" and "ultra" are absent from the vendor's list
 * entirely, so appending one by family resemblance would invent a wire value.
 *
 * Corroborated on a second surface: an unauthenticated OpenCode Zen probe of
 * muse-spark-1.3-contributor-free (2026-09-03) accepted minimal..xhigh, rejected
 * max/ultra with `unknown variant`, and rejected none with "does not support none
 * with this model".
 */
export const META_MUSE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
/*
 * Identity wire map. `requestToCodexEffort` (src/reasoning-effort.ts) rewrites
 * `minimal` to `low` unless a model-scoped wire map says otherwise, so without this
 * the picker would advertise an effort the wire never sends — and a registry-array
 * assertion would pass while the request body was wrong. Identity because Meta's
 * values ARE the Codex names.
 */
export const META_MUSE_REASONING_EFFORT_MAP: Record<string, string> = Object.fromEntries(
  META_MUSE_REASONING_EFFORTS.map(effort => [effort, effort]),
);
/*
 * Muse Code credentials have a separate capability contract. Meta's authenticated
 * /muse-code/models roster advertises max for both 1.3 models, and the Responses API
 * accepts it when the request identifies the Muse client surface.
 */
export const META_MUSE_CODE_REASONING_EFFORTS = [...META_MUSE_REASONING_EFFORTS, "max"];
export const META_MUSE_CODE_REASONING_EFFORT_MAP: Record<string, string> = Object.fromEntries(
  META_MUSE_CODE_REASONING_EFFORTS.map(effort => [effort, effort]),
);
/** Both Muse Spark 1.3 tiers publish a 1,048,576-token window (dev.meta.ai/docs/models). */
export const META_MUSE_CONTEXT_WINDOW = 1_048_576;
export const META_MUSE_MODELS = ["muse-spark-1.3", "muse-spark-1.3-contributor"];
/**
 * Daybreak program aliases. These `-latest` ids are the stable contract: OpenAI repoints
 * them at newer snapshots over time (red -> gpt-5.6-cyber, blue -> gpt-5.6-sol as of
 * 2026-08-11), so registering the ALIAS inherits future model swaps while a pinned
 * snapshot id would silently go stale. Snapshot ids are deliberately absent here.
 * Responses-only per both published endpoint tables (`v1/chat/completions` is marked
 * Not supported) — never add these to a chat-completions provider. Access needs separate
 * Daybreak approval and provisioning, so neither is ever a default.
 * Verified 2026-08-11: developers.openai.com/api/docs/models/daybreak-red-latest.md
 * and .../daybreak-blue-latest.md
 */
export const OPENAI_DAYBREAK_MODELS = ["daybreak-red-latest", "daybreak-blue-latest"];
export const OPENAI_DAYBREAK_CONTEXT_WINDOWS: Record<string, number> = {
  "daybreak-red-latest": 400_000,
  "daybreak-blue-latest": 1_050_000,
};
export const OPENAI_DAYBREAK_MAX_INPUT_TOKENS: Record<string, number> = {
  "daybreak-red-latest": 272_000,
  "daybreak-blue-latest": 922_000,
};
/**
 * Neither Daybreak page publishes a reasoning-effort ladder. An explicit empty array means
 * "expose no effort control"; OMITTING the key would instead fall back to the full routed
 * ladder (`configuredReasoningEfforts` returns undefined -> `applyReasoningLevels` uses
 * ROUTED_REASONING_LEVELS), which would advertise efforts the models never documented.
 * `noReasoningModels` is wrong here: both pages document reasoning-token support, so these
 * are reasoning models with no *selectable* ladder.
 */
export const OPENAI_DAYBREAK_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  OPENAI_DAYBREAK_MODELS.map(id => [id, [] as string[]]),
);
export const OPENROUTER_GPT56_MODELS = OPENAI_GPT56_MODELS.map(id => `openai/${id}`);
export const XAI_MODELS = [
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-multi-agent-0309",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
];
// OpenRouter's live /endpoints routes report 1,050,000; keep this separate from the
// unverified OpenAI API-key seed. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
export const OPENROUTER_GPT56_CONTEXT_WINDOW = 1_050_000;
export const OPENROUTER_GPT56_CONTEXT_WINDOWS = {
  "openai/gpt-5.6-sol": OPENROUTER_GPT56_CONTEXT_WINDOW,
  "openai/gpt-5.6-terra": OPENROUTER_GPT56_CONTEXT_WINDOW,
  "openai/gpt-5.6-luna": OPENROUTER_GPT56_CONTEXT_WINDOW,
};

/**
 * Vendor thinking-toggle models (MiMo v2.x, GLM 5/5.1 on Zen Go): the wire knob is
 * `thinking: {type: enabled|disabled}` — a binary. Advertise the full Codex picker ladder
 * and map efforts onto the toggle. Zen Go
 * pass-through probed live 2026-07-07 (glm-5.2 toggle verified; mimo/minimax accept shape).
 */
export const THINKING_TOGGLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const THINKING_TOGGLE_MAP: Record<string, string> = {
  none: "disabled",
  minimal: "disabled",
  low: "disabled",
  medium: "enabled",
  high: "enabled",
  xhigh: "enabled",
  max: "enabled",
};
export const OPENCODE_GO_THINKING_TOGGLE_MODELS = [
  "mimo-v2.5", "mimo-v2.5-pro", "glm-5", "glm-5.1",
];
/**
 * Zhipu's domestic BigModel platform. Text families first, then the vision member: modalities are
 * declared per model because `noVisionModels` means the opposite of "text only" here — it routes
 * images through the proxy's vision sidecar (src/codex/catalog/provider-fetch.ts), a claim nobody
 * has verified for BigModel-hosted GLM.
 */
// `glm-5.3-flash` is deliberately absent: it is a native VLM
// (docs.z.ai/guides/vlm/glm-5.3-flash), unlike glm-5.3 itself.
export const ZHIPU_BIGMODEL_TEXT_MODELS = ["glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3"];
export const ZHIPU_BIGMODEL_MODELS = [...ZHIPU_BIGMODEL_TEXT_MODELS, "glm-4.6v"];
export const ZHIPU_BIGMODEL_INPUT_MODALITIES: Record<string, string[]> = {
  ...Object.fromEntries(ZHIPU_BIGMODEL_TEXT_MODELS.map(id => [id, ["text"]])),
  "glm-4.6v": ["text", "image"],
};
export const ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS = ["glm-4.6", "glm-4.7", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash"];
export const THINKING_BUDGET_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Qwen3.8-Max is the first Qwen3.x model with official direct `reasoning_effort` support.
// Evidence: https://qwen.ai/blog?id=qwen3.8
export const QWEN38_REASONING_EFFORTS = ["low", "medium", "xhigh"];
export const THINKING_BUDGET_MODELS = [
  "qwen3.5-397b", "qwen3.6-35b",
  "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus",
];
export const OPENCODE_GO_THINKING_BUDGET_MODELS = ["qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"];
/*
 * DeepSeek moved the whole V4 name set on 2026-09-10. V4.1-Flash ships as deepseek-flash
 * on the first-party API; deepseek-v4-flash and the vision preview retire as models but
 * keep routing there as compatibility aliases, and deepseek-v4-pro follows from
 * 2026-09-14 04:00 UTC. Evidence: https://api-docs.deepseek.com/news/news260910/.
 *
 * The spelling differs by who serves it, so one shared list cannot express it: the
 * first-party API answers to deepseek-flash, while the Zen gateway exposes the route as
 * deepseek-v4.1-flash (issue #4253, PR #4258). Vendor-hosted rosters (Volcengine plan
 * snapshots, Alibaba) publish on their own schedule and keep the legacy set until they say
 * otherwise - a first-party retirement notice does not end their deployment.
 */
export const DEEPSEEK_V4_LEGACY_MODELS = ["deepseek-v4-flash"];
/*
 * `deepseek-v4-pro` is deliberately absent from both live sets. DeepSeek retires it from
 * 2026-09-14 04:00 UTC and routes its requests to V4.1-Flash until a V4.1 Pro exists, so a
 * row here would advertise a Pro context window and Pro pricing for a route that serves
 * Flash. The retirement is followed through every roster in this file, including the
 * vendor-hosted ones; providers that discover their models live are handled by
 * `ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS` because deleting a row there removes the
 * model's capabilities rather than the model.
 */
export const DEEPSEEK_NATIVE_THINKING_MODELS = ["deepseek-flash", "deepseek-v4-flash"];
export const DEEPSEEK_GATEWAY_THINKING_MODELS = ["deepseek-v4.1-flash", "deepseek-v4-flash"];
/*
 * DeepSeek's legacy vision preview id (released 2026-08-21). First-party probes
 * in #4436 resolve it to image-capable `deepseek-flash`; retain the existing
 * declarations because gateway support is specific to each served identifier.
 */
export const DEEPSEEK_VISION_PREVIEW_MODEL = "deepseek-v4-flash-vision-exp";
/**
 * CommandCode routes verified to accept image input end-to-end (#2406).
 *
 * Verified-negative and therefore deliberately ABSENT: deepseek/deepseek-v4-flash,
 * zai-org/GLM-5.2, zai-org/GLM-5.3, xai/grok-4.6. Those
 * routes accept the request and drop the image, which is worse than declining it — the
 * model answers about an image it never saw. Do not add an id here on family resemblance;
 * capability intersection trusts this map.
 */
export const COMMAND_CODE_IMAGE_MODELS = [
  `deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`,
  // Probed 2026-09-18 through a running 2.58.0 proxy: a 3x3 random-color grid
  // (180x180 PNG, six candidate colors) came back 9/9 correct both as a user
  // message and as a tool_result, and the request logs show the route served
  // the image natively — no vision-sidecar call in either window. #4505 asked
  // for exactly this upstream probe before promoting the id. The sibling
  // deepseek/deepseek-v4-flash route remains verified-negative above.
  "deepseek/deepseek-v4.1-flash",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "MiniMaxAI/MiniMax-M3",
  "moonshotai/Kimi-K3",
  "meta/muse-spark-1.3",
  "meta/muse-spark-1.3-contributor",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  // Native Z.AI VLM (docs.z.ai/guides/vlm/glm-5.3-flash). This exact id is already
  // classified as natively vision-capable in NVIDIA_NIM_VISION_MODELS in this file;
  // it is not one of the verified-negative ids the header names (those are
  // deepseek/deepseek-v4-flash, zai-org/GLM-5.2, zai-org/GLM-5.3, xai/grok-4.6 —
  // different ids). Adding it on the shared GLM-5.3 prefix would be the family-
  // resemblance mistake the header forbids; the VLM docs are the evidence (#4505).
  "z-ai/glm-5.3-flash",
] as const;
/**
 * Native image stays sourced from COMMAND_CODE_IMAGE_MODELS. Text-only routes
 * sit beside that list so the catalog can still advertise sidecar coverage
 * without claiming the gateway itself accepts a picture. A positive text-only
 * declaration makes the route a vision-sidecar consumer
 * (src/vision/eligibility.ts), so the catalog advertises image input on its
 * behalf — without claiming native vision — and modelInputModalities is
 * per-key filled, so that reaches an existing install even when noVisionModels
 * was persisted before the id joined a list.
 *
 * Empty as of 2026-09-18. Its only entry, deepseek/deepseek-v4.1-flash, moved
 * to COMMAND_CODE_IMAGE_MODELS once the #4505-requested probe passed on both
 * the user-message and tool-result paths (see the note at that entry). The
 * mechanism stays for the next route that measures text-only.
 */
export const COMMAND_CODE_TEXT_ONLY_MODELS = [] as const;
export const COMMAND_CODE_MODEL_INPUT_MODALITIES: Record<string, ["text"] | ["text", "image"]> = {
  ...Object.fromEntries(COMMAND_CODE_IMAGE_MODELS.map(id => [id, ["text", "image"] as ["text", "image"]])),
  ...Object.fromEntries(COMMAND_CODE_TEXT_ONLY_MODELS.map(id => [id, ["text"] as ["text"]])),
};
export const OPENCODE_FREE_DEEPSEEK_MODELS = ["deepseek-v4-flash-free"];
/*
 * Zen free models that reject `image_url` upstream (#1043, and the reproducible
 * half of #1024).
 *
 * Zen publishes NO modality metadata — its `/v1/models` returns only id, object,
 * created, owned_by — so this list is measured, not derived. Each id was probed
 * once against https://opencode.ai/zen/v1 on 2026-08-05 with a text control first
 * and then a 1x1 PNG; the six below failed the image request, four of them with
 * `[404] No endpoints found that support image input` and `big-pickle` with the
 * exact deserialize error quoted in #1043.
 *
 * `mimo-v2.5-free` and `longcat-2.0-free` ACCEPT images. They remain absent
 * from the blind list and are recorded separately as positive input-modality evidence,
 * so capability-positive dispatch can forward images without relying on blacklist absence.
 *
 * Zen's roster is discovered live while this list is static, so it is a dated
 * exception list, not a capability model. Re-probe before extending it.
 * Evidence: devlog/_fin/260805_bug_fix_stack/002_zen_modality_probe.md
 */
export const OPENCODE_ZEN_TEXT_ONLY_MODELS = [
  "big-pickle",
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "deepseek-v4-flash-free",
];
export const OPENCODE_ZEN_IMAGE_MODELS = ["mimo-v2.5-free", "longcat-2.0-free"] as const;
/*
 * DeepSeek's Codex ladder is low/high/max. With the V4 Pro GA release
 * (DeepSeek-V4-Pro-0813) the official thinking-mode table is IDENTICAL for both
 * V4 models (api-docs.deepseek.com/guides/thinking_mode, verified 2026-08-13):
 *
 *   requested  | v4-flash | v4-pro
 *   low        | low      | low
 *   medium     | high     | high
 *   high       | high     | high
 *   xhigh      | high     | high
 *   max        | max      | max
 *
 * Before GA, Pro silently upgraded low->high and mapped xhigh->max (#1057-era
 * table); the page's footnote about an early-August Pro mapping update landed
 * with this GA, so Pro now advertises the same three real tiers as Flash.
 *
 * Two standing notes (#1057):
 *
 * - `xhigh` is a COMPATIBILITY ALIAS, not a native tier. It stays in the wire maps
 *   so existing requests and saved configs keep working, but it is not advertised.
 * - `medium` has no row in the vendor table — mapping it to `high` is OUR
 *   compatibility choice for clients that only speak the OpenAI ladder.
 */
export const DEEPSEEK_FLASH_THINKING_EFFORTS = ["low", "high", "max"];
export const DEEPSEEK_PRO_THINKING_EFFORTS = ["low", "high", "max"];
export const DEEPSEEK_PRO_REASONING_MAP: Record<string, string> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};
export const DEEPSEEK_FLASH_REASONING_MAP: Record<string, string> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};
/**
 * Flash-versus-Pro classification for DeepSeek V4 model ids, including prefixed
 * (`deepseek/deepseek-v4.1-flash`) and suffixed (`deepseek-v4-flash-free`) forms.
 * `tests/providers/provider-registry-parity.test.ts` enumerates every id the registry
 * actually passes here, so a future id this substring test would misread cannot
 * land silently.
 */
export const isDeepseekFlashModel = (modelId: string): boolean =>
  modelId.toLowerCase().includes("flash");
export const deepseekThinkingEffortsFor = (modelId: string): string[] =>
  isDeepseekFlashModel(modelId) ? DEEPSEEK_FLASH_THINKING_EFFORTS : DEEPSEEK_PRO_THINKING_EFFORTS;
export const deepseekReasoningMapFor = (modelId: string): Record<string, string> =>
  isDeepseekFlashModel(modelId) ? DEEPSEEK_FLASH_REASONING_MAP : DEEPSEEK_PRO_REASONING_MAP;
// 260719 Alibaba Token Plan Personal Edition (China/Beijing). Keep it distinct from
// Coding Plan: the products use different exact allowlists and different base URLs.
// Evidence: https://help.aliyun.com/en/model-studio/token-plan-personal-overview
//           https://help.aliyun.com/en/model-studio/token-plan-quickstart
// 260909 refresh, re-probed against the live gateway (both regions, both tiers):
// https://github.com/oliver-mee/alibaba-token-plan-wiki (machine-readable catalog).
// 260918: glm-5.3 returns. The 260909 removal was correct at the time (the id
// 404'd on every plan key), but the gateway started serving glm-5.3 on 260917:
// it now appears on /models for global Team, global Personal, and CN Team, and
// answers a completion on a Personal key (probed 260918). Contract on the plan
// gateway: effort low/high/max (default max), thinking always-on (the gateway
// rejects enable_thinking:false with 400), 1M context, 131,072 max output,
// text-only input, strict json_schema accepted. glm-5.3-flash REMAINS OUT:
// still never served by the Token Plan gateway (docs.z.ai VLM id, not plan
// entitlement).
// The Beijing preset keeps the Personal Edition subset; non-chat ids (audio/image/
// video families) stay out: they answer only on async endpoints openai-chat cannot
// reach. deepseek-v4-pro-0813 is callable but NOT listed by /models, which is the
// reason liveModels must stay false for this provider. deepseek-v4.1-flash is the
// 260910 DeepSeek rename row: listed on /models on both tiers and regions from 260915,
// hybrid thinking, vision via user message and tool result, json_object but not
// json_schema (see noJsonSchemaModels on the entries).
// Beijing serves the Personal Edition, so this is the Personal-tier roster probed
// 260909 (a strict subset of Team). deepseek-v4-pro-0813 stays out of the Beijing
// entry: its callability is only proven on Team keys, and no Personal key has been
// shown to reach it. The Beijing entry also shares the intl maps, so it carries a
// few orphan keys (kimi/glm-5/MiniMax rows); harmless, and one map beats two
// drifting ones.
export const ALIBABA_TOKEN_PLAN_MODELS = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "glm-5.2", "glm-5.3",
];
export const ALIBABA_TOKEN_PLAN_QWEN_MODELS = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
];
export const ALIBABA_TOKEN_PLAN_INPUT_MODALITIES: Record<string, string[]> = {
  "qwen3.8-max": ["text", "image"],
  "qwen3.8-flash": ["text", "image"],
  "qwen3.7-max": ["text"],
  "qwen3.7-plus": ["text", "image"],
  "qwen3.6-flash": ["text", "image"],
  "deepseek-v4-pro": ["text"],
  "deepseek-v4-pro-0813": ["text"],
  "deepseek-v4-flash-0731": ["text"],
  // Vision probed on the plan gateway 260915 (user message and tool result, both 200).
  "deepseek-v4.1-flash": ["text", "image"],
  "glm-5.2": ["text"],
  "glm-5.3": ["text"],
};

// 260721 Alibaba Token Plan International (ap-southeast-1 / Singapore, hardened 260721).
// Multi-vendor lineup distinct from Beijing — includes DeepSeek V4 flash, Kimi K2.7, MiniMax.
// Evidence: https://www.alibabacloud.com/help/en/model-studio/token-plan-overview
//           https://qwencloud.com/pricing/token-plan (qwen3.8 metadata)
// The Team Edition roster (Singapore), verified identical to the CN Team set on 260909.
// deepseek-v4-pro is restored: it remains callable on the plan gateway (probed 260909,
// listed on /models on both regions) after being dropped as "retired" upstream.
export const ALIBABA_INTL_TOKEN_PLAN_MODELS = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "deepseek-v3.2",
  "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "glm-5.2", "glm-5.3", "glm-5.1", "glm-5",
  "MiniMax-M2.5",
];
export const ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
];

// 260722 Tencent Cloud Coding Plan. The plan's model set is explicitly dynamic; these are the
// current documented ids and live discovery remains enabled so successful /models responses win.
// Tencent marks every Coding Plan model as text-only input and restricts plan keys to interactive
// coding tools (not custom application backends or non-interactive batch automation).
// Evidence: https://cloud.tencent.cn/document/product/1823/130092
export const TENCENT_CODING_PLAN_MODELS = ["tc-code-latest", "glm-5", "kimi-k2.5", "minimax-m2.5"];
// Volcengine's authenticated /api/v3/models catalog mixes chat models with embedding,
// image, video, and 3D generation resources. Keep the Codex-facing presets scoped to
// models documented for text/agent or Coding Plan use.
//
// Maintenance owner: @lidge-jun. Verified 2026-08-01 against the vendor's own docs —
// endpoints https://docs.volcengine.com/docs/82379/1528783 (Coding Plan) and
// https://docs.volcengine.com/docs/82379/2165245 (Agent Plan); Codex CLI integration
// https://www.volcengine.com/docs/82379/2556056; supported clients
// https://www.volcengine.com/docs/82379/2188957; terms https://www.volcengine.com/docs/6256/64903
// (北京火山引擎科技有限公司). Plan quota is restricted to supported AI coding tools and misuse
// is documented as grounds for suspension — see the `note` on both Plan entries.
// Report a break by opening an issue tagging the owner; the three things that rot first are the
// static catalogs (liveModels:false cannot self-heal), the base URLs, and those Plan terms.
// Full evidence ledger: devlog/_fin/260801_pr611_volcengine_evidence/000_evidence_ledger.md
export const VOLCENGINE_ARK_MODELS = [
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-evolving",
  "deepseek-v4-flash-260425",
  "deepseek-v3-2-251201",
  // No glm-5-3 row: Ark pins date-stamped snapshot ids (glm-5-2-260617) that cannot be
  // guessed ahead of the vendor publishing them. Add it once /api/v3/models lists one.
  "glm-5-2-260617",
  "glm-4-7-251222",
];
export const VOLCENGINE_DOUBAO_THINKING_MODELS = [
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-evolving",
];
export const VOLCENGINE_CODING_PLAN_MODELS = [
  "ark-code-latest",
  "doubao-seed-2.0-code",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "kimi-k2.6",
  "minimax-m3",
];
export const VOLCENGINE_AGENT_PLAN_MODELS = [
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "kimi-k2.6",
  "minimax-m3",
  "doubao-seed-2.0-pro",
];
export const VOLCENGINE_PLAN_INPUT_MODALITIES: Record<string, string[]> = {
  "kimi-k2.6": ["text", "image"],
  "minimax-m3": ["text", "image"],
  // Native VLM (docs.z.ai/guides/vlm/glm-5.3-flash), so it is declared here and left
  // out of the text-only list below.
  "glm-5.3-flash": ["text", "image"],
};
// Every other Plan model is text-only. Declaring this explicitly keeps the vision
// sidecar from advertising image input for models that cannot accept it — the same
// treatment tencent-coding-plan gives its (entirely text-only) plan catalog.
export const VOLCENGINE_PLAN_TEXT_ONLY_MODELS = [
  "ark-code-latest",
  "doubao-seed-2.0-code",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.2",
  "doubao-seed-2.0-pro",
];
export const ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES: Record<string, string[]> = {
  ...ALIBABA_TOKEN_PLAN_INPUT_MODALITIES,
  "qwen3.6-plus": ["text", "image"],
  "deepseek-v4-flash": ["text"],
  "deepseek-v3.2": ["text"],
  "kimi-k2.7-code": ["text", "image"],
  "kimi-k2.6": ["text", "image"],
  "kimi-k2.5": ["text", "image"],
  "glm-5.1": ["text"],
  "glm-5": ["text"],
  "MiniMax-M2.5": ["text"],
};

// Shared Token Plan metadata (260909 gateway probes; output ceilings are max_tokens
// boundary probes: accept at N, reject at N+1).
export const QWEN38_FAMILY = ["qwen3.8-max", "qwen3.8-flash"];
export const ALIBABA_TOKEN_PLAN_CONTEXT_WINDOWS: Record<string, number> = {
  "qwen3.8-max": 1_000_000, "qwen3.8-flash": 1_000_000, "qwen3.7-max": 1_000_000, "qwen3.7-plus": 1_000_000,
  "qwen3.6-plus": 1_000_000, "qwen3.6-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000, "deepseek-v4-pro-0813": 1_000_000, "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-flash-0731": 1_000_000, "deepseek-v4.1-flash": 1_000_000, "deepseek-v3.2": 131_072,
  "kimi-k2.7-code": 262_144, "kimi-k2.6": 262_144, "kimi-k2.5": 262_144,
  "glm-5.2": 1_000_000, "glm-5.3": 1_000_000, "glm-5.1": 202_752, "glm-5": 202_752,
  "MiniMax-M2.5": 196_608,
};
export const ALIBABA_TOKEN_PLAN_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "qwen3.8-max": 131_072, "qwen3.8-flash": 131_072, "qwen3.7-max": 131_072, "qwen3.7-plus": 131_072,
  "qwen3.6-plus": 65_536, "qwen3.6-flash": 65_536,
  "deepseek-v4-pro": 393_216, "deepseek-v4-pro-0813": 393_216, "deepseek-v4-flash": 393_216,
  "deepseek-v4-flash-0731": 393_216, "deepseek-v4.1-flash": 393_216, "deepseek-v3.2": 65_536,
  "kimi-k2.7-code": 262_144, "kimi-k2.6": 262_144, "kimi-k2.5": 98_304,
  "glm-5.2": 131_072, "glm-5.3": 131_072, "glm-5.1": 128_000, "glm-5": 16_384,
  "MiniMax-M2.5": 32_768,
};
export const ALIBABA_TOKEN_PLAN_NO_VISION = [
  "qwen3.7-max", "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash",
  "deepseek-v4-flash-0731", "deepseek-v3.2", "glm-5.2", "glm-5.3", "glm-5.1", "glm-5", "MiniMax-M2.5",
];
export const ALIBABA_TOKEN_PLAN_PRESERVE_REASONING = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash", "deepseek-v4-flash-0731",
  "deepseek-v4.1-flash", "glm-5.2", "glm-5.3",
];

// 260717 Kimi K3: the subscription endpoint uses one upstream id (`k3`) for both
// entitlement tiers. Bare `k3` advertises the Moderato 256K ceiling; the local `[1m]`
// alias advertises Allegretto's 1M ceiling and is stripped before the upstream request.
// The separately billed Moonshot API uses `kimi-k3`.
// Evidence: https://www.kimi.com/code/docs/en/kimi-code/models.html
//           https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
export const KIMI_K3_STANDARD_CONTEXT_WINDOW = 262_144;
export const KIMI_K3_1M_CONTEXT_WINDOW = 1_048_576;
export const KIMI_CODING_K3_MODELS = ["k3", "k3[1m]"];
// 260921 Kimi K2.8: `kimi-for-coding` is the stable subscription alias Moonshot re-points
// at each coding release. Live GET /coding/v1/models lists only kimi-for-coding[-highspeed],
// k3, k3-256k — the k2.x ids are retired from the subscription endpoint. Since K2.8 Preview
// the alias serves an adjustable low/high/max thinking ladder (same wire map as k3) and a
// 1M context ceiling. Verified live 260921: 350K-token request accepted; upstream rejects
// with "model token limit: 1048576" beyond that.
// Evidence: https://www.kimi.com/code/docs/en/kimi-code/models.html
export const KIMI_CODING_K28_MODELS = ["kimi-for-coding"];
export const KIMI_CODING_LIVE_MODELS = [...KIMI_CODING_K3_MODELS, ...KIMI_CODING_K28_MODELS];
export const KIMI_CODING_ADJUSTABLE_THINKING_MODELS = [...KIMI_CODING_LIVE_MODELS];
export const KIMI_LEGACY_API_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
export const KIMI_API_MODELS = ["kimi-k3", ...KIMI_LEGACY_API_MODELS];
// Every kimi coding preset record - picker, context windows, locked-parameter lists -
// derives from the live ids only. seeding a retired id in a metadata list would re-arm
// the model-rename migration on every boot (#5066): the list holds the retired id but
// not the live alias, so the residue guard cannot skip it. The retired ids survive only
// in KIMI_LEGACY_API_MODELS (moonshot platform API records); model-rename-migration
// repairs saved rows still naming them.
export const KIMI_THINKING_MODELS = KIMI_CODING_LIVE_MODELS;
export const KIMI_CODING_NO_REASONING_MODELS = KIMI_CODING_LIVE_MODELS.filter(id => !KIMI_CODING_ADJUSTABLE_THINKING_MODELS.includes(id));
export const KIMI_API_NO_REASONING_MODELS = KIMI_API_MODELS.filter(id => id !== "kimi-k3");
export const KIMI_CODING_K3_REASONING_EFFORTS = ["low", "high", "max"];
export const KIMI_CODING_K3_REASONING_EFFORT_MAP: Record<string, string> = {
  none: "none",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
export const KIMI_CODING_REASONING_EFFORTS = Object.fromEntries(
  KIMI_CODING_LIVE_MODELS.map(id => [id, KIMI_CODING_ADJUSTABLE_THINKING_MODELS.includes(id) ? KIMI_CODING_K3_REASONING_EFFORTS : []]),
);
export const KIMI_CODING_DEFAULT_REASONING_EFFORTS = Object.fromEntries(
  KIMI_CODING_ADJUSTABLE_THINKING_MODELS.map(id => [id, "max"]),
);
export const KIMI_CODING_REASONING_EFFORT_MAPS = Object.fromEntries(
  KIMI_CODING_ADJUSTABLE_THINKING_MODELS.map(id => [id, KIMI_CODING_K3_REASONING_EFFORT_MAP]),
);
export const KIMI_API_REASONING_EFFORTS = Object.fromEntries(
  KIMI_API_MODELS.map(id => [id, id === "kimi-k3" ? ["max"] : []]),
);
export const KIMI_LOCKED_PARAMETER_MODELS = KIMI_CODING_LIVE_MODELS;
export const KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS = ["kimi-for-coding"];
export const KIMI_API_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  KIMI_API_MODELS.map(id => [id, id === "kimi-k3" ? KIMI_K3_1M_CONTEXT_WINDOW : 262_144]),
);
export const KIMI_API_MODEL_INPUT_MODALITIES = { "kimi-k3": ["text", "image"] };

// 260715 NVIDIA NIM kimi family (issue #126): documented served ids on integrate
// chat/completions per docs.api.nvidia.com/nim/reference/llm-apis; live /v1/models
// currently lists only kimi-k2.6 but the list is dynamic, so carry the documented family.
export const NVIDIA_NIM_KIMI_THINKING_MODELS = [
  "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking",
];
export const NVIDIA_NIM_KIMI_MODELS = [
  ...NVIDIA_NIM_KIMI_THINKING_MODELS,
  "moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905",
];
/**
 * 260804 issue #956: NIM publishes no input-modality metadata on `/v1/models`, so the
 * registry is the only source of truth for which models can see images.
 *
 * Two lists, both verified per-model against NVIDIA documentation on 2026-08-04
 * (build.nvidia.com model pages and docs.api.nvidia.com/nim/reference/*). Evidence and
 * the per-id audit: devlog/_fin/260804_stack7_service_vision/011_nim_id_audit.md.
 *
 * Read `noVisionModels` carefully — it lists models that CANNOT see images, which is
 * what routes them through the proxy's vision sidecar (src/vision/index.ts) and makes the
 * catalog advertise image input for them. Membership is wrong in BOTH directions:
 *   - a text-only model missing from it keeps issue #956 (images blocked or rejected);
 *   - a vision model wrongly IN it gets its image silently replaced by another model's
 *     text description — no error, worse answers, extra cost.
 *
 * A new NIM id must be classified DELIBERATELY against its NVIDIA page, never assumed
 * from its name: `google/gemma-4-31b-it` carries no vision marker yet accepts images,
 * `-vl` also appears on embedding/reranking models, and `google/codegemma-7b` is
 * text-only while `google/codegemma-1.1-7b` has no current page at all. An unclassified
 * id is intentionally left alone rather than defaulted, because NIM serves non-chat
 * endpoints (embeddings, rerankers, guards, OCR) that reach the same code path.
 */
export const NVIDIA_NIM_VISION_MODELS = [
  "meta/llama-3.2-11b-vision-instruct", "meta/llama-3.2-90b-vision-instruct",
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", "nvidia/nemotron-nano-12b-v2-vl",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "nvidia/cosmos3-nano-reasoner",
  "nvidia/ising-calibration-1.5-31b", "nvidia/ising-calibration-1-35b-a3b",
  "google/gemma-4-31b-it", "google/diffusiongemma-26b-a4b-it",
  "minimaxai/minimax-m3", "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5",
  "stepfun-ai/step-3.7-flash", "thinkingmachines/inkling",
  "mistralai/mistral-medium-3.5-128b",
  "z-ai/glm-5.3-flash",
];
/**
 * The catalog advertises image input only for `noVisionModels` members, so a natively
 * vision-capable model would otherwise be published as text-only and the Codex app would
 * block attachments before the native path ever runs.
 */
export const NVIDIA_NIM_VISION_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  NVIDIA_NIM_VISION_MODELS.map(id => [id, ["text", "image"]]),
);
/**
 * Text-only NIM chat models — 26 ids, each carrying an explicit `Input Modalities: Text`
 * (or equivalent) on its NVIDIA page. PR #964 proposed ~64; six of those are natively
 * image-capable and live in NVIDIA_NIM_VISION_MODELS above, and 32 more had no current
 * NVIDIA page and were dropped rather than assumed.
 *
 * kimi-k2-thinking and kimi-k2-instruct are text-only while k2.5/k2.6 are not — vision
 * and reasoning are independent axes, so all four stay in NVIDIA_NIM_KIMI_MODELS for
 * reasoning suppression regardless of which list they appear in here.
 */
export const NVIDIA_NIM_NO_VISION_MODELS = [
  "deepseek-ai/deepseek-v4-flash",
  "google/codegemma-7b",
  "meta/llama-3.1-70b-instruct", "meta/llama-3.1-8b-instruct",
  "meta/llama-3.2-1b-instruct", "meta/llama-3.2-3b-instruct",
  "meta/llama-3.3-70b-instruct", "meta/llama2-70b",
  "mistralai/mistral-7b-instruct-v0.3", "mistralai/mistral-nemotron",
  "moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2-instruct",
  "nvidia/llama-3.1-nemotron-nano-8b-v1", "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1", "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-3-nano-30b-a3b", "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-mini-4b-instruct",
  "nvidia/nvidia-nemotron-nano-9b-v2",
  "openai/gpt-oss-120b", "openai/gpt-oss-20b",
  // z-ai/glm-5.3-flash belongs in NVIDIA_NIM_VISION_MODELS, not here: Z.AI documents
  // it under docs.z.ai/guides/vlm/. The header above says an id must be classified
  // deliberately rather than assumed from its name, and inheriting glm-5.3's
  // text-only verdict because of the shared prefix is exactly that mistake.
  "poolside/laguna-xs-2.1", "z-ai/glm-5.3", "z-ai/glm-5.2",
];
export const KIMI_CODING_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  KIMI_CODING_LIVE_MODELS.map(id => [id, (id === "k3[1m]" || KIMI_CODING_K28_MODELS.includes(id)) ? KIMI_K3_1M_CONTEXT_WINDOW : KIMI_K3_STANDARD_CONTEXT_WINDOW]),
);
export const KIMI_CODING_MODEL_INPUT_MODALITIES = Object.fromEntries(
  KIMI_CODING_ADJUSTABLE_THINKING_MODELS.map(id => [id, ["text", "image"]]),
);
export const NEURALWATT_REASONING_HISTORY_MODELS = [
  "glm-5.3", "glm-5.3-short", "glm-5.3-flash",
  "glm-5.2", "glm-5.2-short",
  "kimi-k2.6", "kimi-k2.7-code",
  "qwen3.5-397b", "qwen3.6-35b",
];

// 260728 Baseten Model APIs: `/v1/models` owns the live lineup, while these hints
// describe only capabilities that Baseten documents per slug. Unlisted live models
// intentionally inherit the empty provider ladder instead of being advertised with
// opencodex's generic reasoning defaults. Audio is omitted because the current proxy
// request model does not carry OpenAI `audio_url` parts.
// Evidence: https://docs.baseten.co/inference/model-apis/reasoning
//           https://docs.baseten.co/inference/model-apis/vision
export const BASETEN_FULL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const BASETEN_MODEL_REASONING_EFFORTS: Record<string, string[]> = {
  "thinkingmachines/inkling": BASETEN_FULL_REASONING_EFFORTS,
  "openai/gpt-oss-120b": BASETEN_FULL_REASONING_EFFORTS,
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  // 260814: GLM-5.3 honours low/high/max upstream, unlike 5.2's high/max on Baseten.
  "zai-org/GLM-5.3": ["low", "high", "max"],
  "zai-org/GLM-5.3-Fast": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.2-Fast": ["high", "max"],
};
export const BASETEN_MODEL_REASONING_EFFORT_MAP: Record<string, Record<string, string>> = {
  "thinkingmachines/inkling": { none: "none", minimal: "minimal" },
  "openai/gpt-oss-120b": { none: "none", minimal: "minimal" },
  "moonshotai/Kimi-K3": { none: "none" },
  "zai-org/GLM-5.3": { none: "none" },
  "zai-org/GLM-5.3-Fast": { none: "none" },
  "zai-org/GLM-5.2": { none: "none" },
  "zai-org/GLM-5.2-Fast": { none: "none" },
};
export const BASETEN_MODEL_DEFAULT_REASONING_EFFORTS: Record<string, string> = {
  "thinkingmachines/inkling": "high",
  "openai/gpt-oss-120b": "medium",
  "moonshotai/Kimi-K3": "max",
};
export const BASETEN_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  "thinkingmachines/inkling": ["text", "image"],
  "moonshotai/Kimi-K2.6": ["text", "image"],
  "moonshotai/Kimi-K2.7-Code": ["text", "image"],
  "moonshotai/Kimi-K3": ["text", "image"],
};

// 260801 DigitalOcean and Scaleway expose OpenAI-shaped `/v1/models` rows with only
// id/object/created/owned_by, while their shared serverless catalogs also contain
// non-chat and endpoint-specific models. Fail closed by intersecting live discovery
// with ids that the providers' current first-party model tables establish for Chat
// Completions. A newly listed id therefore needs a docs-backed registry refresh before
// it can enter the Codex catalog.
// Evidence: https://docs.digitalocean.com/products/inference/details/models/
//           https://docs.digitalocean.com/reference/api/reference/serverless-inference/
//           https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/
export const DIGITALOCEAN_CHAT_COMPLETION_MODELS = [
  "arcee-trinity-large-thinking",
  "openai-gpt-5.6-sol",
  "openai-gpt-5.6-terra",
  "openai-gpt-5.6-luna",
  "qwen3-coder-flash",
  "qwen3.5-397b-a17b",
  "deepseek-4-flash",
  "deepseek-3.2",
  "gemma-4-31B-it",
  "minimax-m2.5",
  "kimi-k3",
  "kimi-k2.6",
  "kimi-k2.5",
  "llama3.3-70b-instruct",
  "llama-4-maverick",
  "mistral-3-14B",
  "nemotron-3-ultra-550b",
  "nvidia-nemotron-3-super-120b",
  "nemotron-3-nano-omni",
  "nemotron-nano-12b-v2-vl",
  "mimo-v2.5-pro",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  // The API reference uses this native slash id in its Chat Completions example.
  "meta-llama/Meta-Llama-3.1-8B-Instruct",
] as const;
export const SCALEWAY_SERVERLESS_CHAT_MODELS = [
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  // gpt-oss-120b is intentionally omitted: Scaleway requires Responses API for tool calling,
  // while this preset routes Codex agent tools through Chat Completions.
  "qwen3.6-35b-a3b",
  "qwen3.5-397b-a17b",
  "qwen3-235b-a22b-instruct-2507",
  "qwen3-coder-30b-a3b-instruct",
  "gemma-4-26b-a4b-it",
  "llama-3.3-70b-instruct",
  "mistral-medium-3.5-128b",
  "mistral-small-3.2-24b-instruct-2506",
  "pixtral-12b-2409",
] as const;
export const SCALEWAY_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  "pixtral-12b-2409": ["text", "image"],
};
export const UMANS_MODELS = [
  "umans-coder",
  "umans-kimi-k2.7",
  "umans-flash",
  "umans-glm-5.3",
  "umans-glm-5.3-flash",
  "umans-glm-5.2",
  "umans-glm-5.1",
  "umans-qwen3.6-35b-a3b",
];
export const UMANS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const UMANS_GLM_REASONING_EFFORTS = ["high", "xhigh", "max"];
// 260814: Z.AI folds GLM-5.3 efforts into low/high/max, so `low` is a real tier here and
// `xhigh` is not distinct from `max` (docs.z.ai/devpack/latest-model).
export const UMANS_GLM_53_REASONING_EFFORTS = ["low", "high", "max"];
// `umans-glm-5.3-flash` is NOT here: Z.AI documents glm-5.3-flash under
// docs.z.ai/guides/vlm/, so it takes images natively and does not need the proxy's
// vision sidecar. The seeding pass classified it from the family name and a later
// pass corrected only some of the providers; this is one it missed.
export const UMANS_TEXT_ONLY_MODELS = ["umans-glm-5.3", "umans-glm-5.2", "umans-glm-5.1"];
export const UMANS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "umans-coder": 262_144,
  "umans-kimi-k2.7": 262_144,
  "umans-flash": 262_144,
  "umans-glm-5.3": 405_504,
  // Mirrors the sibling this provider already carries. Umans has not published a
  // separate window for the flash tier; asserting a different number would be a guess.
  "umans-glm-5.3-flash": 405_504,
  "umans-glm-5.2": 405_504,
  "umans-glm-5.1": 202_752,
  "umans-qwen3.6-35b-a3b": 262_144,
};
export const UMANS_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  UMANS_MODELS.map(id => [id, UMANS_TEXT_ONLY_MODELS.includes(id) ? ["text"] : ["text", "image"]]),
);
export const CLINE_PASS_MODELS = [
  "cline-pass/glm-5.3",
  "cline-pass/glm-5.3-flash",
  "cline-pass/glm-5.2",
  "cline-pass/kimi-k3",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/kimi-k2.6",
  "cline-pass/deepseek-v4-flash",
  "cline-pass/mimo-v2.5",
  "cline-pass/mimo-v2.5-pro",
  "cline-pass/minimax-m3",
  "cline-pass/qwen3.8-max",
  "cline-pass/qwen3.7-max",
  "cline-pass/qwen3.7-plus",
];

export const ORCAROUTER_MODEL_DISCOVERY: ProviderModelDiscoverySpec = {
  path: "models",
  query: { capability: "chat" },
  maxResponseBytes: 512 * 1024,
  maxModels: 512,
  filter: {
    anyOf: [{
      path: ["supported_endpoint_types"],
      containsAny: ["openai", "openai-response", "anthropic", "gemini"],
      caseInsensitive: true,
    }],
    noneOf: [{
      path: ["supported_endpoint_types"],
      containsAny: ["image-generation", "openai-video", "jina-rerank"],
      caseInsensitive: true,
    }],
  },
};
// Preserve the previously verified cold-start catalog. Live discovery remains authoritative
// when it succeeds, but a temporary catalog outage must not erase the provider's known-good
// selectors from the picker. `orcarouter/auto` is intentionally retained here even though the
// public catalog did not enumerate it at the latest verification (2026-09-07).
export const ORCAROUTER_MODELS = [
  "openai/gpt-5.5",
  "anthropic/claude-opus-4.8",
  "google/gemini-3.5-flash",
  "orcarouter/auto",
];
export const ORCAROUTER_MODEL_REASONING_EFFORTS = {
  // Live /models currently exposes ids and modalities, not the accepted reasoning ladder.
  "openai/gpt-5.5": ["low", "medium", "high", "xhigh"],
};
export const CLINE_PASS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "cline-pass/glm-5.3": 1_048_576,
  "cline-pass/glm-5.3-flash": 1_048_576,
  "cline-pass/glm-5.2": 1_048_576,
  "cline-pass/kimi-k3": 1_048_576,
  "cline-pass/kimi-k2.7-code": 262_144,
  "cline-pass/kimi-k2.6": 262_144,
  "cline-pass/deepseek-v4-flash": 1_048_576,
  "cline-pass/mimo-v2.5": 1_050_000,
  "cline-pass/mimo-v2.5-pro": 1_050_000,
  "cline-pass/minimax-m3": 1_048_576,
  "cline-pass/qwen3.7-max": 1_000_000,
  "cline-pass/qwen3.7-plus": 1_000_000,
};
export const CLINE_PASS_IMAGE_MODELS = new Set([
  "cline-pass/kimi-k3",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/kimi-k2.6",
  "cline-pass/mimo-v2.5",
  "cline-pass/minimax-m3",
  "cline-pass/qwen3.7-plus",
  // Native VLM (docs.z.ai/guides/vlm/), so its images do not go through the proxy's
  // sidecar. Adding it here moves it out of CLINE_PASS_TEXT_ONLY_MODELS and flips its
  // declared modalities to ["text", "image"] in one edit, because both are derived
  // from this set.
  "cline-pass/glm-5.3-flash",
]);
export const CLINE_PASS_MODALITY_KNOWN_MODELS = CLINE_PASS_MODELS.filter(id => id !== "cline-pass/qwen3.8-max");
export const CLINE_PASS_TEXT_ONLY_MODELS = CLINE_PASS_MODALITY_KNOWN_MODELS.filter(id => !CLINE_PASS_IMAGE_MODELS.has(id));
export const CLINE_PASS_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  CLINE_PASS_MODALITY_KNOWN_MODELS.map(id => [id, CLINE_PASS_IMAGE_MODELS.has(id) ? ["text", "image"] : ["text"]]),
);

// Opper seed: bare *pool* names. A pool is every provider Opper serves that model through; Opper
// picks the route per request. Each name is the `.model` of a `pooled: true` entry in the public
// catalogue snapshot supplied by the original provider author
// (https://api.opper.ai/v3/models?limit=2000, captured 2026-09-14); `vendor/model` ids
// (anthropic/claude-sonnet-4-6) pin one route and stay valid, they are just not seeded.
export const OPPER_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-5",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gemini-3.8-flash",
  "deepseek-v4-pro",
  "kimi-k3",
  "mistral-large-2512",
];
// Smallest value across each pool's members in that snapshot, capped at the lab model's own limit
// (kimi-k3 output); live discovery owns which models exist.
export const OPPER_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-5": 1_000_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gemini-3.8-flash": 1_048_576,
  "deepseek-v4-pro": 1_000_000,
  "kimi-k3": 1_048_576,
  "mistral-large-2512": 256_000,
};
export const OPPER_MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-sonnet-4-6": 64_000,
  "claude-opus-5": 128_000,
  "gpt-5.5": 128_000,
  "gpt-5.4-mini": 128_000,
  "gemini-3.8-flash": 65_536,
  "deepseek-v4-pro": 65_536,
  "kimi-k3": 131_072,
  "mistral-large-2512": 8_192,
};
// Pools whose members do not all accept image input (deepseek-v4-pro: no member does; kimi-k3: the
// sference route is text-only), so the shared modality set is text.
export const OPPER_TEXT_ONLY_MODELS = ["deepseek-v4-pro", "kimi-k3"];
export const OPPER_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  OPPER_MODELS.map(id => [id, OPPER_TEXT_ONLY_MODELS.includes(id) ? ["text"] : ["text", "image"]]),
);

export const STEPFUN_MODELS = [
  "step-5-preview",
  "step-3.5-flash",
  "step-3.7-flash",
];

export const STEPFUN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "step-5-preview": 1_000_000,
  "step-3.5-flash": 256_000,
  "step-3.7-flash": 256_000,
};

export const STEPFUN_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  "step-5-preview": ["text", "image"],
  "step-3.5-flash": ["text"],
  "step-3.7-flash": ["text", "image"],
};

export const STEPFUN_NO_VISION_MODELS = ["step-3.5-flash"];

export const STEPFUN_REASONING_EFFORTS = ["low", "medium", "high"];
