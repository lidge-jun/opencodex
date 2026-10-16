import { test, expect } from "bun:test";
import { NATIVE_MAIN_EN, NATIVE_MAIN_TRANSLATIONS } from "../src/i18n/native-main-translations";
import { nativeMainTranslator } from "../src/i18n/native-main-copy";
import { DICTS, type Locale } from "../src/i18n/catalogs";

test("native-main English guidance names the server, checkbox, result and manual retry", () => {
  expect(NATIVE_MAIN_EN).toMatchObject({
    "nativeMain.stepClose": "Close native Codex on the server computer for the displayed CODEX_HOME. Keep it closed until you have checked the result.",
    "nativeMain.stepConfirm": "Select the checkbox below to confirm Codex is closed, then confirm the change.",
    "nativeMain.stepResult": "Wait for the result and the updated active profile, then follow the instructions to reopen Codex.",
    "nativeMain.reopenHint": "Check the updated active profile, then reopen native Codex on the server computer with the displayed CODEX_HOME. Follow any restart requirement shown here.",
    "nativeMain.retryHint": "Refresh the status and review the active profile. To retry a login change, select the action again and confirm that Codex is closed. Nothing is retried automatically.",
    "nativeMain.error": "The result could not be confirmed. A missing response does not mean the original login was restored.",
    "nativeMain.errorBusy": "Another native-login operation is running. Wait for it to finish before trying again.",
    "nativeMain.errorStorage": "The server cannot safely access the login folder or profile storage. Check the server diagnostics before another change.",
  });
});

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
