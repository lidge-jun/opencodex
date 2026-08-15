import type { Locale } from "./shared";

export type VisionReasoningLabelLevel = "low" | "medium" | "high" | "xhigh" | "max";

const VISION_REASONING_LABELS = {
  en: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" },
  de: { low: "Niedrig", medium: "Mittel", high: "Hoch", xhigh: "Sehr hoch", max: "Maximum" },
  fr: { low: "Faible", medium: "Moyen", high: "Élevé", xhigh: "Très élevé", max: "Maximum" },
  ko: { low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" },
  zh: { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" },
  "zh-TW": { low: "低", medium: "中", high: "高", xhigh: "極高", max: "最大" },
  ru: { low: "Низкий", medium: "Средний", high: "Высокий", xhigh: "Очень высокий", max: "Максимальный" },
  ja: { low: "低", medium: "中", high: "高", xhigh: "非常に高い", max: "最大" },
  tr: { low: "Düşük", medium: "Orta", high: "Yüksek", xhigh: "Çok yüksek", max: "Maksimum" },
} satisfies Record<Locale, Record<VisionReasoningLabelLevel, string>>;

/** Localized display label for the wire-level vision reasoning value. */
export function visionReasoningLabel(locale: Locale, level: VisionReasoningLabelLevel): string {
  return VISION_REASONING_LABELS[locale][level];
}
