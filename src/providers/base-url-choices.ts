/**
 * Qwen Cloud OpenAI-compatible endpoint presets.
 * Token plan is the GUI default; pay-as-you-go and custom are selectable.
 */
export const QWEN_CLOUD_TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
export const QWEN_CLOUD_PAYG_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

export type ProviderBaseUrlChoice = {
  id: string;
  /** English label projected to the GUI; GUI may i18n by `id`. */
  label: string;
  /** Omitted for `custom` — user supplies the URL. */
  baseUrl?: string;
};

export const QWEN_CLOUD_BASE_URL_CHOICES: readonly ProviderBaseUrlChoice[] = [
  { id: "token-plan", label: "Token plan", baseUrl: QWEN_CLOUD_TOKEN_PLAN_BASE_URL },
  { id: "payg", label: "Pay as you go", baseUrl: QWEN_CLOUD_PAYG_BASE_URL },
  { id: "custom", label: "Custom" },
];

/**
 * Alibaba Token Plan OpenAI-compatible endpoint presets.
 * Beijing is the registry default (Personal Edition); the international
 * Singapore endpoint (Team Edition) and custom are selectable, so a saved
 * non-Beijing baseUrl is honored instead of silently overridden.
 */
export const ALIBABA_TOKEN_PLAN_BEIJING_BASE_URL =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
export const ALIBABA_TOKEN_PLAN_INTL_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

export const ALIBABA_TOKEN_PLAN_BASE_URL_CHOICES: readonly ProviderBaseUrlChoice[] = [
  { id: "beijing", label: "China (Beijing)", baseUrl: ALIBABA_TOKEN_PLAN_BEIJING_BASE_URL },
  { id: "intl", label: "International (Singapore)", baseUrl: ALIBABA_TOKEN_PLAN_INTL_BASE_URL },
  { id: "custom", label: "Custom" },
];

/** Match a saved baseUrl to a known choice id (`custom` when it does not match). */
export function matchBaseUrlChoice(
  choices: readonly ProviderBaseUrlChoice[],
  baseUrl: string,
): string {
  if (!choices.length) return "custom";
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  for (const choice of choices) {
    if (!choice.baseUrl) continue;
    if (choice.baseUrl.trim().replace(/\/+$/, "") === normalized) return choice.id;
  }
  return choices.some(c => c.id === "custom") ? "custom" : choices[0]!.id;
}
