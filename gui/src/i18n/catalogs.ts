import { en, type TKey } from "./en";
import { de } from "./de";
import { fr } from "./fr";
import { ko } from "./ko";
import { zh } from "./zh";
import { zhTW } from "./zh-TW";
import { ru } from "./ru";
import { ja } from "./ja";
import { tr } from "./tr";
import { LAB_CATALOG_OVERRIDES, type LabLocale } from "./lab-translations";

/** React-free locale catalog registry for formatters and other shared helpers. */
export type Locale = LabLocale;

function withLabTranslations(locale: Locale, catalog: Record<TKey, string>): Record<TKey, string> {
  return { ...catalog, ...LAB_CATALOG_OVERRIDES[locale] };
}

/**
 * CL-05 translations are overlaid centrally so the compatibility surface cannot regress to
 * copied English values in a locale catalog. The locale parity test still validates the base
 * catalogs; this overlay is deliberately limited to the closed `lab.*` namespace.
 */
export const DICTS: Record<Locale, Record<TKey, string>> = {
  en: withLabTranslations("en", en),
  de: withLabTranslations("de", de),
  fr: withLabTranslations("fr", fr),
  ko: withLabTranslations("ko", ko),
  zh: withLabTranslations("zh", zh),
  "zh-TW": withLabTranslations("zh-TW", zhTW),
  ru: withLabTranslations("ru", ru),
  ja: withLabTranslations("ja", ja),
  tr: withLabTranslations("tr", tr),
};

/** Native language names shown by the language picker, kept inside i18n rather than UI metadata. */
export function localeDisplayName(locale: Locale): string {
  return DICTS[locale]["lang.nativeName"];
}

export function catalogValue(locale: Locale, key: TKey): string {
  return DICTS[locale][key];
}

export type { TKey };
