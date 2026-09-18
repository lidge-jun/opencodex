import type { OcxConfig } from "../../types";
import { effectiveProviderAlias } from "../../providers/default-aliases";
import { identifyRoutedModel } from "../../adapters/identity";
import { COMBO_NAMESPACE } from "../../combos";
import {
  CODEX_CUSTOM_MODEL_CATALOG_KIND,
  applyCatalogMetadata,
  applyNativeOpenAiContextOverride,
  applyRoutedCodexToolMode,
  catalogModelSlug,
  ensureStrictCatalogFields,
  normalizeRoutedCatalogEntry,
  normalizeServiceTiers,
} from "./parsing";
import type { CatalogModel, RawEntry } from "./parsing";
import {
  hasNativeOpenAiCapabilityMetadata,
  upstreamNativeEntry,
  type NativeContextLimitsInput,
} from "./metadata";
import {
  applyCatalogModelMetadata,
  applyReasoningLevels,
  ensureGpt56ReasoningLevels,
  ensureUltraReasoningLevel,
  isGpt56NativeSlug,
} from "./effort";
import { CATALOG_INACTIVE_REASON_FIELD, SPAWN_PRIORITY_FIELD } from "./subagent-roster";

export function finishUpstreamNativeEntry(clone: RawEntry, priority: number, contextCap?: NativeContextLimitsInput): RawEntry {
  if (priority !== 9) clone.priority = priority;
  applyNativeOpenAiContextOverride(clone, contextCap);
  // GPT-5.6 natives keep their exact upstream ladders (e.g. luna has max but no ultra).
  // Older natives (gpt-5.5) get mock max + ultra
  // (wire-clamped to xhigh). Ultra is always advertised regardless of v2 toggle.
  if (!isGpt56NativeSlug(String(clone.slug ?? ""))) ensureUltraReasoningLevel(clone);
  return ensureStrictCatalogFields(normalizeServiceTiers(clone));
}

export function isExactComboCatalogModel(
  model: CatalogModel | undefined,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return model?.provider === COMBO_NAMESPACE && exactComboSlugs.has(catalogModelSlug(model));
}

export function isExactComboCatalogEntry(
  entry: RawEntry,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return entry.owned_by === COMBO_NAMESPACE
    && typeof entry.slug === "string"
    && exactComboSlugs.has(entry.slug);
}

/**
 * Friendly Codex-picker label for a routed `provider/model` slug. Command Code's two config
 * ids differ by a single dash (`command-code` vs `commandcode`), so relabel them to the
 * lowercase-dash style the opencode presets use: `commandcode-auth/x` and `commandcode-api/x`.
 * The model-id portion also carries a redundant `<vendor>-` prefix (`deepseek-deepseek-v4-flash`)
 * that is dropped for display. Google Antigravity is relabeled to the compact `agy/` prefix for
 * the same reason: `google-antigravity/` alone consumes most of the picker row. That prefix comes
 * from the row's own `providerAlias`, decided once per gather flight; `null` means a cross-provider
 * collision suppressed it and the canonical slug stands. This is the raw-slug path only -- a
 * configured `modelAliases` entry is labeled by the effective-alias path in
 * catalog/provider-fetch.ts (#2960) and keeps the canonical provider name. All other providers
 * keep the raw slug exactly as before.
 */
function routedDisplayName(slug: string, model?: CatalogModel, config?: Pick<OcxConfig, "providers">): string {
  const slash = slug.indexOf("/");
  if (slash <= 0) return slug;
  const provider = slug.slice(0, slash);
  let modelId = slug.slice(slash + 1);
  if (provider === "google-antigravity") {
    if (model?.providerAlias === null) return slug;
    const alias = (typeof model?.providerAlias === "string" && model.providerAlias.trim().length > 0)
      ? model.providerAlias.trim()
      : effectiveProviderAlias(provider, undefined, config);
    return alias ? `${alias}/${modelId}` : slug;
  }
  if (provider === "command-code" || provider === "commandcode") {
    const m = modelId.match(/^([a-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)+)$/i);
    if (m && modelId.startsWith(`${m[1]}-${m[1]}-`)) modelId = modelId.slice(m[1]!.length + 1);
    return `${provider === "command-code" ? "commandcode-auth" : "commandcode-api"}/${modelId}`;
  }
  return slug;
}

function preservePinnedNativeCustomReasoning(model?: CatalogModel): boolean {
  return model !== undefined
    && model.catalogKind === CODEX_CUSTOM_MODEL_CATALOG_KIND
    && hasNativeOpenAiCapabilityMetadata(model.id)
    && Array.isArray(model.reasoningEfforts);
}

/**
 * Cria uma entrada nativa ou roteada a partir do snapshot upstream, de um clone
 * do template ou de campos mínimos. Aplica os metadados e limites pertinentes
 * sem alterar o template nem herdar sua marca de nome ou histórico de prioridade.
 */
export function deriveEntry(
  template: RawEntry | null,
  slug: string,
  desc: string,
  priority: number,
  model?: CatalogModel,
  exactComboSlugs: ReadonlySet<string> = new Set(),
  contextCap?: NativeContextLimitsInput,
): RawEntry {
  const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
  // Go exposes model-specific upstream enums; synthetic tiers mislead subagent overrides.
  const preserveExactReasoning = preserveExact || model?.provider === "opencode-go";
  const codexForwardNativeCapabilityAlias = model?.codexForwardNativeCapabilityAlias === true
    ? upstreamNativeEntry(model.id)
    : null;
  const isRouted = model !== undefined;
  if (!isRouted && !slug.includes("/")) {
    // Supported native slug covered by the upstream snapshot: use the REAL entry (exact
    // reasoning ladder — e.g. luna has no ultra — default effort, identity, model_messages)
    // instead of cloning an older template.
    const upstream = upstreamNativeEntry(slug);
    if (upstream) return finishUpstreamNativeEntry(upstream, priority, contextCap);
  }
  if (template || codexForwardNativeCapabilityAlias) {
    const e = JSON.parse(JSON.stringify(codexForwardNativeCapabilityAlias ?? template)) as RawEntry;
    delete e.opencodex_native_display_name;
    // A cached template may carry display-order history; each new row owns its natural rank.
    delete e[SPAWN_PRIORITY_FIELD];
    e.slug = slug;
    e.display_name = routedDisplayName(slug, model);
    e.description = desc;
    e.priority = priority;
    e.visibility = "list";
    if ("upgrade" in e) e.upgrade = null;
    delete e.availability_nux; // don't replay another model's "now available" NUX
    // Routed (namespaced) models inherit the gpt template — correct its OpenAI/GPT identity
    // and advertise the reasoning ladder Codex accepts.
    if (isRouted) {
      // A routed model is NOT the native template: never inherit its context
      // window when /models omits context metadata (#992). Known metadata
      // restores exact values below; an enabled Context cap fills the gap;
      // otherwise the strict-fields fallback supplies the 128k triple.
      if (!codexForwardNativeCapabilityAlias) {
        delete e.context_window;
        delete e.max_context_window;
        delete e.auto_compact_token_limit;
      }
      // Native id for identity text + metadata lookups — the slug may be an encoded
      // alias (`provider/vendor-model`); the model object carries the native id.
      const modelName = model?.id ?? slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        // Proxy-neutral: keep the GPT-5/OpenAI disclaimer but never advertise the opencodex proxy
        // (leaking that into base_instructions is a non-first-party signature → ToS risk).
        e.base_instructions = identifyRoutedModel(e.base_instructions, modelName);
      }
      applyReasoningLevels(
        e,
        model?.reasoningEfforts,
        model?.defaultReasoningEffort,
        preserveExactReasoning
          || codexForwardNativeCapabilityAlias !== null
          || preservePinnedNativeCustomReasoning(model),
      );
      // This exact provider/model pair is the ChatGPT/Codex forward surface. Keep the pinned
      // native tool/search/responses-lite contract while preserving the routed slug and wire id.
      if (!codexForwardNativeCapabilityAlias) {
        normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true, model?.codexToolMode);
      } else if (model?.codexToolMode !== undefined) {
        applyRoutedCodexToolMode(e, model.codexToolMode);
      }
      if (model) applyCatalogMetadata(e, model.provider, model.id, model.contextCap);
      applyCatalogModelMetadata(e, model);
      if (model?.catalogKind) e.opencodex_catalog_kind = model.catalogKind;
      // Additive only. `visibility` is untouched: an inactive row must still be OFFERED, which is
      // the whole point of #1711 — operator disable is what removes rows, and it stays a separate
      // path from this one.
      if (model?.quotaInactiveReason) e[CATALOG_INACTIVE_REASON_FIELD] = model.quotaInactiveReason;
    } else {
      applyNativeOpenAiContextOverride(e, contextCap);
      if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(e);
      else ensureUltraReasoningLevel(e);
      // Older natives do not support Responses Lite. A newer template must not enable
      // reasoning.context or WebSockets on those models.
      if (!isGpt56NativeSlug(slug)) {
        delete e.use_responses_lite;
        delete e.supports_websockets;
      }
    }
    return ensureStrictCatalogFields(normalizeServiceTiers(e), {
      preserveExactInputModalities: preserveExact,
      isRouted,
    });
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  // Routed fallbacks default to code-mode tool exposure (or shell mode when codexToolMode === "shell");
  // otherwise the nested catalog expands into `exec.description` and can exceed Cursor's 120 KB serialized tool limit (#1830).
  // Cursor still omits hosted web-search metadata because runTurn bypasses that separate sidecar.
  const isCursorFallback = isRouted && model?.provider === "cursor";
  const entry: RawEntry = {
    slug, display_name: routedDisplayName(slug, model), description: desc,
    shell_type: "unified_exec", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
    ...(isRouted
      ? isCursorFallback
        ? { supports_search_tool: true }
        : { web_search_tool_type: "text_and_image", supports_search_tool: true }
      : {}),
  };
  if (isRouted) {
    applyRoutedCodexToolMode(entry, model?.codexToolMode);
    applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExactReasoning || preservePinnedNativeCustomReasoning(model));
  }
  else {
    applyReasoningLevels(entry, isGpt56NativeSlug(slug) ? undefined : ["low", "medium", "high", "xhigh"]);
    if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(entry);
  }
  if (model && isRouted) applyCatalogMetadata(entry, model.provider, model.id, model.contextCap);
  applyCatalogModelMetadata(entry, model);
  if (model?.catalogKind) entry.opencodex_catalog_kind = model.catalogKind;
  // Same additive stamp as the templated path above. A routed row that reaches the no-template
  // fallback is still a served row, so omitting it here would make the field depend on whether a
  // template happened to be cached — which is exactly what the regression test caught.
  if (model?.quotaInactiveReason) entry[CATALOG_INACTIVE_REASON_FIELD] = model.quotaInactiveReason;
  if (!isRouted) applyNativeOpenAiContextOverride(entry, contextCap);
  return ensureStrictCatalogFields(normalizeServiceTiers(entry), {
    preserveExactInputModalities: preserveExact,
    isRouted,
  });
}
