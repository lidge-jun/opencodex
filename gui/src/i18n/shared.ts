import { createContext, useContext } from "react";
import { en, type TKey } from "./en";
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";
import { zhTW } from "./zh-TW";
import { ru } from "./ru";
import { ja } from "./ja";

export type Locale = "en" | "de" | "ko" | "zh" | "zh-TW" | "ru" | "ja";
export type { TKey };

export const DICTS: Record<Locale, Record<TKey, string>> = {
  en, de, ko, zh, "zh-TW": zhTW, ru, ja,
};

export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "en", name: "English", htmlLang: "en" },
  { code: "de", name: "Deutsch", htmlLang: "de" },
  { code: "ko", name: "한국어", htmlLang: "ko" },
  { code: "zh", name: "简体中文", htmlLang: "zh-CN" },
  { code: "zh-TW", name: "繁體中文", htmlLang: "zh-TW" },
  { code: "ru", name: "Русский", htmlLang: "ru" },
  { code: "ja", name: "日本語", htmlLang: "ja" },
];

const LANG_KEY = "ocx-lang";
const LOCALE_CODES = new Set<string>(LOCALES.map(l => l.code));

export function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored && LOCALE_CODES.has(stored)) return stored as Locale;
  } catch { /* ignore */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  if (nav.startsWith("de")) return "de";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("zh")) {
    // zh-TW / zh-HK / zh-MO / zh-Hant → Traditional; everything else → Simplified.
    if (
      nav.includes("tw") ||
      nav.includes("hk") ||
      nav.includes("mo") ||
      nav.includes("hant")
    ) {
      return "zh-TW";
    }
    return "zh";
  }
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

export type Vars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: Vars) => string;

export interface I18nContextValue { locale: Locale; setLocale: (l: Locale) => void; t: TFn }

export const I18nContext = createContext<I18nContextValue | null>(null);

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  let out = s;
  for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}
