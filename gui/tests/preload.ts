// Test-environment locale pin.
//
// PaohupByPaoZa changed the product's default locale from "en" to "th"
// (gui/src/i18n/shared.ts detectInitial), which is asserted by
// tests/i18n-locales.test.ts via its own localStorage mock. The DOM-backed UI
// tests, however, render against happy-dom's real localStorage with nothing
// stored, so they now resolve to Thai and their English-text assertions fail.
//
// This preload runs for every 'bun test' invocation in gui/ (registered via
// gui/bunfig.toml [test] preload) and answers the "ocx-lang" storage read with
// "en" before the app code sees it. detectInitial returns "en" for UI tests,
// while users keep the Thai default. Tests that stub localStorage themselves
// (i18n-locales, locale-parity) are unaffected because they replace the whole
// storage object, not just reads.
import { Window, Storage } from "happy-dom";

const originalGetItem = Storage.prototype.getItem;
Storage.prototype.getItem = function (key: string): string | null {
  const stored = originalGetItem.call(this, key);
  if (key === "ocx-lang" && (stored === null || stored === undefined)) return "en";
  return originalGetItem.call(this, key);
};

// Files that mount React without installing a happy-dom localStorage still hit
// the runtime-level localStorage global; give them an English-pinned one too.
if (typeof globalThis.localStorage === "undefined") {
  const pinWindow = new Window({ url: "http://localhost/" });
  (globalThis as { localStorage?: unknown }).localStorage = pinWindow.localStorage;
}
