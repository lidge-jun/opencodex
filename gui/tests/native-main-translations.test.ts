import { test, expect } from "bun:test";
import { NATIVE_MAIN_EN, NATIVE_MAIN_TRANSLATIONS } from "../src/i18n/native-main-translations";
import { nativeMainTranslator } from "../src/i18n/native-main-copy";
import { DICTS, type Locale } from "../src/i18n/catalogs";

test("native-main copy covers all supported locales and preserves placeholders", () => {
  const keys = Object.keys(NATIVE_MAIN_EN).sort() as (keyof typeof NATIVE_MAIN_EN)[];
  // Derived from the shipped catalogs rather than restated here. A hardcoded list went
  // stale the moment Vietnamese landed in #4984, and the resulting gap broke typecheck
  // for the whole repository rather than only this namespace.
  expect(Object.keys(NATIVE_MAIN_TRANSLATIONS).sort()).toEqual(Object.keys(DICTS).sort());
  const variables = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
  for (const locale of Object.keys(NATIVE_MAIN_TRANSLATIONS) as Locale[]) {
    const dictionary = NATIVE_MAIN_TRANSLATIONS[locale];
    expect(Object.keys(dictionary).sort()).toEqual(keys);
    for (const key of keys) {
      expect(dictionary[key].trim().length).toBeGreaterThan(0);
      expect(variables(dictionary[key])).toEqual(variables(NATIVE_MAIN_EN[key]));
    }
    const translated = nativeMainTranslator(locale)("nativeMain.switchTo", { label: "example-profile" });
    expect(translated).toContain("example-profile");
    expect(translated).not.toContain("{label}");
  }
});
