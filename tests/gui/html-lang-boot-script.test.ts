import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { detectInitial, LOCALES } from "../../gui/src/i18n/shared";

// The inline <head> script in gui/index.html sets <html lang> before first paint so the
// :lang() font stacks in styles.css apply without a flash. It must agree with detectInitial().
const html = readFileSync(join(import.meta.dir, "../../gui/index.html"), "utf8");
const bootScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
});

function storageWith(lang: string | null, blocked = false) {
  return {
    getItem: (key: string) => {
      if (blocked) throw new Error("SecurityError");
      return key === "ocx-lang" ? lang : null;
    },
  };
}

function bootLang(storage: ReturnType<typeof storageWith>, language: string): string {
  const documentElement = { lang: "en", setAttribute() {} };
  runInNewContext(bootScript, { localStorage: storage, navigator: { language }, document: { documentElement } });
  return documentElement.lang;
}

function expectedLang(storage: ReturnType<typeof storageWith>, language: string): string {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: { language }, configurable: true, writable: true });
  const locale = detectInitial();
  return LOCALES.find((entry) => entry.code === locale)!.htmlLang;
}

const cases: [string | null, boolean, string][] = [
  [null, false, "zh-CN"],
  [null, false, "zh-HK"],
  [null, false, "zh-Hant-TW"],
  [null, false, "ja-JP"],
  [null, false, "ko-KR"],
  [null, false, "de-DE"],
  [null, false, "fr-FR"],
  [null, false, "ru-RU"],
  [null, false, "tr-TR"],
  [null, false, "vi-VN"],
  [null, false, "pt-BR"],
  ["zh", false, "en-US"],
  ["zh-TW", false, "en-US"],
  ["ko", false, "ja-JP"],
  ["bogus", false, "ja-JP"],
  ["zh", true, "zh-TW"],
];

test("index.html boot script sets <html lang> exactly like detectInitial()", () => {
  expect(bootScript).toContain("ocx-lang");
  for (const [stored, blocked, language] of cases) {
    const storage = storageWith(stored, blocked);
    expect(`${stored}/${blocked}/${language} -> ${bootLang(storage, language)}`).toBe(
      `${stored}/${blocked}/${language} -> ${expectedLang(storage, language)}`,
    );
  }
});
