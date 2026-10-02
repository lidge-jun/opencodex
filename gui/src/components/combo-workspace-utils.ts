import {
  type ComboDraftError,
  type ComboItem,
  JEV_DECISION_ISSUE_LABEL_KEYS,
  jevDecisionProviderIssue,
} from "../combo-workspace-data";
import type { TFn } from "../i18n/shared";
import {
  type JevDecisionRow,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
} from "../jev-decision-service";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";

/** Localized validation message, with the bounds or the decision-service reason filled in. */
export function comboDraftErrorText(
  t: TFn,
  code: ComboDraftError,
  draft: ComboItem,
  providers: Readonly<Record<string, JevDecisionRow>>,
): string {
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
