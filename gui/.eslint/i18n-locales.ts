import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const I18N_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");

/** Source locale / `TKey` definition (`src/i18n/en.ts`). */
export const I18N_SOURCE_LOCALE = "en";

/** Non-dictionary modules under `src/i18n/`. */
const I18N_MODULE_SKIP = new Set(["index", "shared", "provider"]);

/** Locale module ids matching `src/i18n/{id}.ts` (discovered at lint time). */
export function listI18nLocaleModules(): string[] {
  if (!fs.existsSync(I18N_DIR)) return [I18N_SOURCE_LOCALE];
  return fs
    .readdirSync(I18N_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.replace(/\.ts$/, ""))
    .filter((id) => !I18N_MODULE_SKIP.has(id))
    .sort((a, b) => {
      if (a === I18N_SOURCE_LOCALE) return -1;
      if (b === I18N_SOURCE_LOCALE) return 1;
      return a.localeCompare(b);
    });
}

/** Locales that need a translation entry when adding a new key (all except source). */
export function listTranslationLocales(): string[] {
  return listI18nLocaleModules().filter((code) => code !== I18N_SOURCE_LOCALE);
}

/** Hint for ESLint/docs — picks up new files like `src/i18n/fr.ts` automatically. */
export function i18nLocaleFileHint(): string {
  const modules = listI18nLocaleModules();
  if (modules.length <= 1) {
    return `src/i18n/${I18N_SOURCE_LOCALE}.ts`;
  }
  const files = modules.map((code) => `src/i18n/${code}.ts`);
  return files.join(", ");
}

export function formatHardcodedSnippet(value: string, maxLen = 56): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty)";
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

