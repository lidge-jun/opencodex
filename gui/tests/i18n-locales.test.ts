import { describe, expect, test } from "bun:test";
import {
  DICTS,
  LOCALES,
  localeDisplayName,
  detectInitial,
} from "../src/i18n/shared";
import { en } from "../src/i18n/en";
import { formatUptime } from "../src/formatUptime";

describe("i18n locale contracts", () => {
  test("LOCALES and DICTS contain exactly the same locales", () => {
    const localeCodes = LOCALES.map(locale => locale.code).sort();
    const dictCodes = Object.keys(DICTS).sort();

    expect(dictCodes).toEqual(localeCodes);
    expect(new Set(localeCodes).size).toBe(localeCodes.length);

    for (const locale of LOCALES) {
      expect(locale.htmlLang.length).toBeGreaterThan(0);
      expect("name" in locale).toBe(false);
    }
  });

  test("every locale has a catalog-backed display name", () => {
    for (const { code } of LOCALES) {
      const displayName = DICTS[code]["lang.nativeName"];

      expect(displayName.trim().length).toBeGreaterThan(0);
      expect(localeDisplayName(code)).toBe(displayName);
    }
  });

  test("every locale catalog has exactly the English key set", () => {
    const expectedKeys = Object.keys(en).sort();

    for (const { code } of LOCALES) {
      const actualKeys = Object.keys(DICTS[code]).sort();
      expect(actualKeys).toEqual(expectedKeys);
    }
  });

  test("every locale preserves interpolation placeholders exactly", () => {
    const placeholderRe = /\{([a-zA-Z0-9_]+)\}/g;
    const mismatches: string[] = [];

    for (const { code } of LOCALES) {
      if (code === "en") continue;

      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        const enValue = en[key];
        const localeValue = DICTS[code][key];

        const enPlaceholders = [...enValue.matchAll(placeholderRe)]
          .map(match => match[1])
          .sort();

        const localePlaceholders = [...localeValue.matchAll(placeholderRe)]
          .map(match => match[1])
          .sort();

        if (
          enPlaceholders.length !== localePlaceholders.length ||
          enPlaceholders.some(
            (placeholder, index) => placeholder !== localePlaceholders[index],
          )
        ) {
          mismatches.push(
            `${code}.${key}: en=[${enPlaceholders.join(",")}] locale=[${localePlaceholders.join(",")}]`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("locale source files contain no duplicate dictionary keys", async () => {
    const duplicates: string[] = [];

    for (const { code } of LOCALES) {
      const text = await Bun.file(
        new URL(`../src/i18n/${code}.ts`, import.meta.url),
      ).text();

      const keyRe = /^\s*"([^"]+)":/gm;
      const seen = new Set<string>();

      for (const match of text.matchAll(keyRe)) {
        const key = match[1];

        if (seen.has(key)) {
          duplicates.push(`${code}.${key}`);
        } else {
          seen.add(key);
        }
      }
    }

    expect(duplicates).toEqual([]);
  });

  test("formatUptime uses catalog units for every locale", () => {
    for (const { code } of LOCALES) {
      const day = DICTS[code]["uptime.day"];
      const hour = DICTS[code]["uptime.hour"];
      const minute = DICTS[code]["uptime.minute"];
      const second = DICTS[code]["uptime.second"];

      expect(formatUptime(45, code)).toBe(`45${second}`);
      expect(formatUptime(300, code)).toBe(`5${minute}`);
      expect(formatUptime(3600, code)).toBe(`1${hour}`);
      expect(formatUptime(3660, code)).toBe(`1${hour} 1${minute}`);
      expect(formatUptime(86400, code)).toBe(`1${day}`);
      expect(formatUptime(90000, code)).toBe(`1${day} 1${hour}`);
    }
  });

  test("detectInitial recognizes every supported navigator locale", () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    const originalStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );

    try {
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
        configurable: true,
        writable: true,
      });

      for (const { code, htmlLang } of LOCALES) {
        Object.defineProperty(globalThis, "navigator", {
          value: { language: htmlLang },
          configurable: true,
          writable: true,
        });

        expect(detectInitial()).toBe(code);
      }
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, "navigator", originalNavigator);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }

      if (originalStorage) {
        Object.defineProperty(globalThis, "localStorage", originalStorage);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });

  test("detectInitial maps French regional navigator locales to French", () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

    try {
      Object.defineProperty(globalThis, "localStorage", {
        value: { getItem: () => null },
        configurable: true,
      });

      for (const language of ["fr", "fr-FR", "fr-CA", "fr-BE", "fr-CH"]) {
        Object.defineProperty(globalThis, "navigator", {
          value: { language },
          configurable: true,
        });
        expect(detectInitial()).toBe("fr");
      }
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("detectInitial recognizes every supported stored locale", () => {
    const originalStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );

    let storedLocale: string | null = null;

    try {
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: (key: string) =>
            key === "ocx-lang" ? storedLocale : null,
          setItem: (_key: string, value: string) => {
            storedLocale = value;
          },
          removeItem: () => {
            storedLocale = null;
          },
        },
        configurable: true,
        writable: true,
      });

      for (const { code } of LOCALES) {
        storedLocale = code;
        expect(detectInitial()).toBe(code);
      }
    } finally {
      if (originalStorage) {
        Object.defineProperty(globalThis, "localStorage", originalStorage);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});
