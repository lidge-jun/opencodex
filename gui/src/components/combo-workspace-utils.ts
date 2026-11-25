import {
  type ComboDraftError,
  type ComboItem,
  emptyDraft,
  newComboTarget,
  JEV_DECISION_ISSUE_LABEL_KEYS,
  jevDecisionProviderIssue,
} from "../combo-workspace-data";
import type { TFn } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import {
  type JevDecisionRow,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
} from "../jev-decision-service";
import type { ModelOption, ProviderOption, QuotaComboPreset } from "./combo-workspace-types";
import { JEV_SESSION_PIN_TTL_MIN_MS, JEV_SESSION_PIN_TTL_MAX_MS } from "../../../src/combos/jev-session-pin-config";
import { comboProviderBilling } from "../../../src/combos/suggestion-channel";

export function comboTargetBilling(provider: ProviderOption) {
  return provider.comboBilling ?? comboProviderBilling(provider);
}

export function comboTargetProviderName(name: string, provider: ProviderOption | undefined, t: TFn): string {
  const identity = provider?.alias || name;
  return identity === "anthropic-apikey" ? "Anthropic API" : formatProviderDisplayName(identity, t);
}

/** Localized validation message, with the bounds or the decision-service reason filled in. */
export function comboDraftErrorText(
  t: TFn,
  code: ComboDraftError,
  draft: ComboItem,
  providers: Readonly<Record<string, JevDecisionRow>>,
): string {
  if (code === "invalidSessionPin") {
    return t("cws.err.invalidSessionPin", { min: JEV_SESSION_PIN_TTL_MIN_MS, max: JEV_SESSION_PIN_TTL_MAX_MS });
  }
  if (code === "invalidDecisionTimeout") {
    return t("cws.err.invalidDecisionTimeout", { min: JEV_DECISION_TIMEOUT_MIN_MS, max: JEV_DECISION_TIMEOUT_MAX_MS });
  }
  if (code === "invalidDecisionProvider") {
    const issue = jevDecisionProviderIssue(draft.decisionProvider, providers) ?? "missing";
    return t("cws.err.invalidDecisionProvider", {
      name: draft.decisionProvider ?? "",
      reason: t(JEV_DECISION_ISSUE_LABEL_KEYS[issue]),
    });
  }
  return t(`cws.err.${code}`);
}

export function enabledProviders(providers: ProviderOption[]): ProviderOption[] {
  return providers
    .filter((p) => !p.disabled && !p.hiddenFromPicker)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a number input and clamp to [min, max]. Empty / non-finite values return
 * `undefined` so callers can ignore the keystroke without writing NaN.
 */
export function clampedNumberInput(raw: string, min: number, max: number): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** ChatGPT passthrough has no /models catalog — GPT slugs are listed under provider "openai". */
export function isChatGptForwardOption(p: ProviderOption | undefined): boolean {
  if (!p) return false;
  const id = p.name.toLowerCase();
  if (id !== "openai" && id !== "chatgpt") return false;
  if ((p.authMode ?? "").toLowerCase() !== "forward") return false;
  if ((p.adapter ?? "").toLowerCase() !== "openai-responses") return false;
  const base = (p.baseUrl ?? "").replace(/\/+$/, "");
  return !base || base.includes("chatgpt.com/backend-api/codex");
}

export function modelsForProvider(
  models: ModelOption[],
  provider: string,
  providers: ProviderOption[],
): string[] {
  const keys = new Set<string>([provider]);
  const meta = providers.find((p) => p.name === provider);
  // Alias chatgpt → openai native GPT rows (forward providers don't publish their own catalog).
  if (provider.toLowerCase() === "chatgpt" || isChatGptForwardOption(meta)) {
    keys.add("openai");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!keys.has(m.provider) || !m.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    ids.push(m.id);
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

const OPENAI_QUOTA_PAIR = ["openai", "openai-apikey"] as const;
const ANTHROPIC_QUOTA_PAIR = ["anthropic", "anthropic-apikey"] as const;

export function quotaComboDraft(
  preset: QuotaComboPreset,
  providers: ProviderOption[],
  models: ModelOption[],
): ComboItem | undefined {
  const enabled = enabledProviders(providers);
  const providerFor = (id: string) => enabled.find(provider => provider.name === id)
    ?? enabled.find(provider => provider.alias === id);
  const targets = [];
  const pairs = preset === "openai-first"
    ? [OPENAI_QUOTA_PAIR, ANTHROPIC_QUOTA_PAIR]
    : [ANTHROPIC_QUOTA_PAIR, OPENAI_QUOTA_PAIR];
  for (const [subscription, api] of pairs) {
    const included = providerFor(subscription);
    const key = providerFor(api);
    if (!included || !key || comboTargetBilling(included) === "consent" || comboTargetBilling(key) !== "consent") return undefined;
    const includedModels = modelsForProvider(models, included.name, providers);
    const keyModels = modelsForProvider(models, key.name, providers);
    const includedModel = included.defaultModel || includedModels[0];
    const keyModel = includedModel && keyModels.includes(includedModel) ? includedModel : key.defaultModel || keyModels[0];
    if (!includedModel || !keyModel) return undefined;
    targets.push(
      newComboTarget({ provider: included.name, model: includedModel, metered: false }),
      newComboTarget({ provider: key.name, model: keyModel, metered: true }),
    );
  }
  return { ...emptyDraft(preset), targets, quotaOnlyFallback: true };
}
