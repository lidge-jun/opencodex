/**
 * Anthropic-flavor /v1/models entries in the official ModelInfo shape
 * (anthropic-sdk-typescript@9e46760 src/resources/models.ts — devlog 131).
 *
 * Why full ModelInfo: Claude Desktop 3P discovery is the only channel that can
 * carry per-model capabilities (effort ladder / thinking types); the static
 * inferenceModels schema has no capability fields. Claude Code CLI 2.1.207 strips
 * unknown fields, so the richer shape is backward-safe (audit 133 R1#4).
 *
 * Honesty rules (audit 133 R2#1/R2#2/R3#2/R4#1):
 *  - native ladders start from the injected catalog but advertise ONLY rungs that
 *    survive nativeEffortClamp as identity (`(clamp(r) ?? r) === r`), ultra excluded;
 *  - routed ladders use the adapter-reported CatalogModel.reasoningEfforts only —
 *    no ladder means effort.supported:false, never a guess;
 *  - created_at is a fixed constant; max_input_tokens is authoritative-or-null;
 *    max_tokens is always null (no authoritative output limit exists proxy-side).
 */
import { catalogModelEfforts, nativeEffortClamp, nativeOpenAiContextWindow, nativeOpenAiMaxInputTokens, type CatalogModel, type NativeContextLimitsInput } from "../codex/catalog";
import { claudeCodeAlias, claudeCodeNativeAlias } from "./alias";
import { desktop3pAlias } from "./desktop-3p";
import { AUTO_CONTEXT_OFF, type AutoContextMode } from "./context-windows";

const MODEL_INFO_CREATED_AT = "2026-01-01T00:00:00Z";
const ANTHROPIC_EFFORT_RUNGS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ONE_MILLION = 1_000_000;

interface CapabilitySupport { supported: boolean }

function cap(supported: boolean): CapabilitySupport {
  return { supported };
}

function effortCapability(ladder: readonly string[]) {
  const rungs = new Set(ladder.filter(r => ANTHROPIC_EFFORT_RUNGS.has(r)));
  const supported = rungs.size > 0;
  return {
    supported,
    low: cap(rungs.has("low")),
    medium: cap(rungs.has("medium")),
    high: cap(rungs.has("high")),
    max: cap(rungs.has("max")),
    xhigh: supported ? cap(rungs.has("xhigh")) : null,
  };
}

function modelCapabilities(ladder: readonly string[], imageInput: boolean) {
  const reasons = ladder.length > 0;
  return {
    batch: cap(false),
    citations: cap(false),
    code_execution: cap(false),
    context_management: {
      supported: false,
      clear_thinking_20251015: null,
      clear_tool_uses_20250919: null,
      compact_20260112: null,
    },
    effort: effortCapability(ladder),
    image_input: cap(imageInput),
    pdf_input: cap(false),
    structured_outputs: cap(false),
    thinking: reasons
      ? { supported: true, types: { adaptive: cap(true), enabled: cap(true) } }
      : { supported: false, types: { adaptive: cap(false), enabled: cap(false) } },
  };
}

/** Native ladder: catalog rungs that the native effort clamp passes through as identity. */
export function nativeEffectiveLadder(slug: string): string[] {
  const ladder = catalogModelEfforts([slug]).get(slug) ?? [];
  return ladder.filter(r => r !== "ultra" && (nativeEffortClamp(slug, r) ?? r) === r);
}

export interface AnthropicModelInfo {
  id: string;
  display_name: string;
  type: "model";
  created_at: string;
  capabilities: ReturnType<typeof modelCapabilities>;
  max_input_tokens: number | null;
  max_tokens: null;
}

function modelInfo(id: string, displayName: string, ladder: readonly string[], imageInput: boolean, contextWindow?: number): AnthropicModelInfo {
  return {
    id,
    display_name: displayName,
    type: "model",
    created_at: MODEL_INFO_CREATED_AT,
    capabilities: modelCapabilities(ladder, imageInput),
    max_input_tokens: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null,
    max_tokens: null,
  };
}

/**
 * Which id family the discovery list carries (devlog 050): Claude Code (CLI)
 * gets readable `claude-ocx-*` ids; Claude Desktop keeps the hashed
 * `claude-opus-4-8-<code>` family its 3P config was written with. Both families
 * decode in resolveInboundModel regardless of the style served here.
 */
export type AnthropicIdStyle = "desktop3p" | "readable";

/** Build the full anthropic-flavor discovery list (ids are Desktop 3P aliases). */
export function buildAnthropicModelInfos(
  nativeSlugs: readonly string[],
  routedModels: readonly CatalogModel[],
  auto: AutoContextMode = AUTO_CONTEXT_OFF,
  idStyle: AnthropicIdStyle = "desktop3p",
  aliasForRoute: (provider: string, modelId: string) => string = desktop3pAlias,
  nativeContextCap?: NativeContextLimitsInput,
): AnthropicModelInfo[] {
  const out: AnthropicModelInfo[] = [];
  const seen = new Set<string>();
  // [1m] picker variant (devlog 260712 B1): Claude Code accounts exactly 1M for ids
  // carrying the marker (2.1.207 binary: /\[1m\]/i → 1e6, compaction preserved), so
  // ONLY models with an authoritative >=1M window get a second selectable row —
  // the auto-context widening that let a 372K route carry the marker (and be
  // over-filled) is the #854 defect and does not come back. Guards (audit R1#11):
  // same dedupe set, never double-suffix.
  const push1mVariant = (base: AnthropicModelInfo, contextWindow: number | undefined, maxInputTokens?: number) => {
    // The [1m] marker makes Claude Code account 1e6 tokens for the row, so it
    // may only name models whose AUTHORITATIVE effective window is >= 1M —
    // never the auto-context widening, which would mark a 372K route and have
    // Claude Code over-fill it (the #854 defect).
    if (contextWindow === undefined || contextWindow < ONE_MILLION) return;
    if (base.id.includes("[1m]")) return;
    const id = `${base.id}[1m]`;
    if (seen.has(id)) return;
    seen.add(id);
    // The marker fixes Claude Code's accounting at 1e6, but a model may accept less input
    // than that — a routed GPT-5.6 row runs a 1,050,000 window while refusing past 922,000
    // (measured — see devlog/_plan/260817_native_gpt56_1m_context/001_measurement_evidence.md).
    // Advertising the flat 1e6 there would invite mid-session context_length_exceeded, so the
    // variant reports whichever of the two is smaller.
    const advertised = typeof maxInputTokens === "number" && maxInputTokens > 0
      ? Math.min(ONE_MILLION, maxInputTokens)
      : ONE_MILLION;
    out.push({ ...base, id, display_name: `${base.display_name} · 1M`, max_input_tokens: advertised });
  };
  for (const slug of nativeSlugs) {
    const id = idStyle === "readable" ? claudeCodeNativeAlias(slug) : aliasForRoute("native", slug);
    if (seen.has(id)) continue;
    seen.add(id);
    const nativeWindow = nativeOpenAiContextWindow(slug, nativeContextCap);
    const nativeMaxInput = nativeOpenAiMaxInputTokens(slug, nativeContextCap);
    // max_input_tokens is an INPUT limit, so it follows the measured input ceiling rather
    // than the total window whenever the model publishes one.
    const info = modelInfo(id, `${slug} (native)`, nativeEffectiveLadder(slug), true, nativeMaxInput ?? nativeWindow);
    out.push(info);
    push1mVariant(info, nativeWindow, nativeMaxInput);
  }
  for (const m of routedModels) {
    const id = idStyle === "readable" ? claudeCodeAlias(m.provider, m.id) : aliasForRoute(m.provider, m.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const ladder = Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : [];
    const imageInput = Array.isArray(m.inputModalities) ? m.inputModalities.includes("image") : false;
    // max_input_tokens is an input limit, so a row that publishes a lower input ceiling than
    // its window (native GPT-5.6 forwarded through a provider: 922k under 1.05M) reports the
    // ceiling. Rows without one keep reporting the window, as before.
    const routedMaxInput = typeof m.maxInputTokens === "number" && m.maxInputTokens > 0
      ? (typeof m.contextWindow === "number" && m.contextWindow > 0
        ? Math.min(m.maxInputTokens, m.contextWindow)
        : m.maxInputTokens)
      : undefined;
    const info = modelInfo(id, `${m.id} (${m.provider})`, ladder, imageInput, routedMaxInput ?? m.contextWindow);
    out.push(info);
    // Anthropic passthrough guard (audit 021 #3): never auto-widen canonical claude
    // routes — only a genuine >=1M window earns the variant row there.
    push1mVariant(info, m.contextWindow, routedMaxInput);
  }
  return out;
}
