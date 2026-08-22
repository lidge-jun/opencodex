import type { Locale } from "./catalogs";

type CompatibilityFieldLabels = {
  maxEvidenceAgeMs: string;
  unknownEvidence: string;
  degradedEvidence: string;
};

/**
 * Small closed translation surface for the CL-06 compatibility editor fields.
 * Keeping all supported locales together prevents raw config keys from leaking
 * into the UI without widening the compile-checked base catalog for three
 * CL-06-only labels.
 */
export const ROUTING_COMPATIBILITY_FIELD_LABELS: Record<Locale, CompatibilityFieldLabels> = {
  en: {
    maxEvidenceAgeMs: "Maximum evidence age (ms)",
    unknownEvidence: "Unknown evidence",
    degradedEvidence: "Degraded evidence",
  },
  de: {
    maxEvidenceAgeMs: "Maximales Evidenzalter (ms)",
    unknownEvidence: "Unbekannte Evidenz",
    degradedEvidence: "Eingeschränkte Evidenz",
  },
  fr: {
    maxEvidenceAgeMs: "Âge maximal des preuves (ms)",
    unknownEvidence: "Preuves inconnues",
    degradedEvidence: "Preuves dégradées",
  },
  ko: {
    maxEvidenceAgeMs: "최대 증거 유효 기간 (ms)",
    unknownEvidence: "알 수 없는 증거",
    degradedEvidence: "저하된 증거",
  },
  zh: {
    maxEvidenceAgeMs: "证据最大有效期（毫秒）",
    unknownEvidence: "未知证据",
    degradedEvidence: "降级证据",
  },
  "zh-TW": {
    maxEvidenceAgeMs: "證據最大有效期限（毫秒）",
    unknownEvidence: "未知證據",
    degradedEvidence: "降級證據",
  },
  ru: {
    maxEvidenceAgeMs: "Максимальный возраст доказательств (мс)",
    unknownEvidence: "Неизвестные доказательства",
    degradedEvidence: "Ухудшенные доказательства",
  },
  ja: {
    maxEvidenceAgeMs: "エビデンスの最大有効期間 (ms)",
    unknownEvidence: "不明なエビデンス",
    degradedEvidence: "低下したエビデンス",
  },
  tr: {
    maxEvidenceAgeMs: "Maksimum kanıt yaşı (ms)",
    unknownEvidence: "Bilinmeyen kanıt",
    degradedEvidence: "Bozulmuş kanıt",
  },
};
