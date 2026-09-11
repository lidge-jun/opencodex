import { en, type TKey as BaseTKey } from "./en";
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
export type TKey = BaseTKey;

/** Apply the centrally maintained Lab closed-surface translations to one base locale catalog. */
function withCatalogOverlays(locale: Locale, catalog: Record<BaseTKey, string>): Record<TKey, string> {
  return {
    ...catalog,
    ...LAB_CATALOG_OVERRIDES[locale],
  };
}

/**
 * Lab translations are overlaid centrally so the compatibility surface cannot regress to copied
 * English values. Base locale parity remains compile-checked by the locale modules.
 */
export const DICTS: Record<Locale, Record<TKey, string>> = {
  en: withCatalogOverlays("en", en),
  de: withCatalogOverlays("de", de),
  fr: withCatalogOverlays("fr", fr),
  ko: withCatalogOverlays("ko", ko),
  zh: withCatalogOverlays("zh", zh),
  "zh-TW": withCatalogOverlays("zh-TW", zhTW),
  ru: withCatalogOverlays("ru", ru),
  ja: withCatalogOverlays("ja", ja),
  tr: withCatalogOverlays("tr", tr),
};

/** Native language names shown by the language picker, kept inside i18n rather than UI metadata. */
export function localeDisplayName(locale: Locale): string {
  return DICTS[locale]["lang.nativeName"];
}

/** Read one localized string without requiring React context. */
export function catalogValue(locale: Locale, key: TKey): string {
  return DICTS[locale][key];
}
