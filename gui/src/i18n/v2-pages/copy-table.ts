/*
 * Shared shape of the v2 page copy tables: one row per key, one column per locale, so a
 * page's new strings land as one reviewable table instead of eleven scattered edits.
 */
export type Locale = "en" | "ko" | "de" | "fr" | "zh" | "zh-TW" | "ru" | "ja" | "tr" | "vi" | "pt";
const locales: readonly Locale[] = ["en", "ko", "de", "fr", "zh", "zh-TW", "ru", "ja", "tr", "vi", "pt"];
export type Row = readonly [string, string, string, string, string, string, string, string, string, string, string];

/** Turns a table into a per-locale dictionary whose keys carry `prefix`. */
export function copyTable<P extends string, R extends Record<string, Row>>(prefix: P, rows: R) {
  return (locale: Locale) => {
    const index = locales.indexOf(locale);
    return Object.fromEntries(
      Object.entries(rows).map(([key, row]) => [`${prefix}.${key}`, row[index]!]),
    ) as { [K in keyof R & string as `${P}.${K}`]: string };
  };
}
