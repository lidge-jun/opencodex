/**
 * Qwen Cloud OpenAI-compatible endpoint presets.
 * Token plan is the GUI default; pay-as-you-go and custom are selectable.
 * Token plan host per https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart
 * (checked 2026-10-23); a saved older host stays usable as a custom URL.
 */
export const QWEN_CLOUD_TOKEN_PLAN_BASE_URL =
  "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1";
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
 * Alibaba Token Plan International (ap-southeast-1) endpoint presets.
 * Separate regional account and billing destination; both regions offer both tiers.
 * Alibaba Cloud's own quick start still documents this host (checked 2026-10-23):
 * https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-quick-start
 * Qwen Cloud documents a different Token Plan host, so the two constants are
 * independent and must not be assumed equal.
 */
export const ALIBABA_INTL_TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
export const ALIBABA_INTL_PAYG_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export const ALIBABA_INTL_BASE_URL_CHOICES: readonly ProviderBaseUrlChoice[] = [
  { id: "token-plan", label: "Token plan", baseUrl: ALIBABA_INTL_TOKEN_PLAN_BASE_URL },
  { id: "payg", label: "Pay as you go", baseUrl: ALIBABA_INTL_PAYG_BASE_URL },
  { id: "custom", label: "Custom" },
];

/** Alibaba Coding Plan endpoint presets (international default; China mainland selectable). */
export const ALIBABA_CODING_INTL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
export const ALIBABA_CODING_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";

export const ALIBABA_CODING_BASE_URL_CHOICES: readonly ProviderBaseUrlChoice[] = [
  { id: "intl", label: "International", baseUrl: ALIBABA_CODING_INTL_BASE_URL },
  { id: "china", label: "China", baseUrl: ALIBABA_CODING_CN_BASE_URL },
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

/** Moonshot/Kimi API endpoint presets (international default; China selectable). */
export const MOONSHOT_INTL_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

export const MOONSHOT_BASE_URL_CHOICES: readonly ProviderBaseUrlChoice[] = [
  { id: "international", label: "International (.ai)", baseUrl: MOONSHOT_INTL_BASE_URL },
  { id: "china", label: "China (.cn)", baseUrl: MOONSHOT_CN_BASE_URL },
  { id: "custom", label: "Custom" },
];
