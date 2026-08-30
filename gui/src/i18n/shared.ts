import { createContext, useContext } from "react";
import { DICTS, localeDisplayName, type Locale, type TKey } from "./catalogs";

export { DICTS, localeDisplayName, type Locale, type TKey };

export const LOCALES: { code: Locale; htmlLang: string }[] = [
  { code: "th", htmlLang: "th" },
  { code: "en", htmlLang: "en" },
  { code: "de", htmlLang: "de" },
  { code: "fr", htmlLang: "fr" },
  { code: "ko", htmlLang: "ko" },
  { code: "zh", htmlLang: "zh-CN" },
  { code: "zh-TW", htmlLang: "zh-TW" },
  { code: "ru", htmlLang: "ru" },
  { code: "ja", htmlLang: "ja" },
  { code: "tr", htmlLang: "tr" },
];

const LANG_KEY = "ocx-lang";

let activeLocale: Locale | null = null;

export function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "th" || stored === "en" || stored === "de" || stored === "fr" || stored === "ko" || stored === "zh" || stored === "zh-TW" || stored === "ru" || stored === "ja" || stored === "tr") return stored;
  } catch { /* ignore */ }
  return "th";
}

/** Current LanguageProvider locale for non-React UI such as the auth fetch dialog. */
export function getActiveLocale(): Locale {
  return activeLocale ?? detectInitial();
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
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
