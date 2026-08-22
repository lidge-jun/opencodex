import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "zh", "zh-TW"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

// The page may write its own SELECTION and ask the proxy to re-run the guarded sync,
// but it must never gain a path that writes ~/.grok/config.toml directly. injectGrokConfig
// owns that file (backup, byte-for-byte preservation, non-loopback refusal).
test("the Grok page only writes selection state and triggers the guarded sync", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("/api/grok/selection");
  expect(page).toContain("/api/grok/apply");
  expect(page).not.toContain("writeFile");
  expect(page).not.toContain("atomicWriteFile");
});

// UX-STATE-01: absent is a normal state, not a failure — it must name the next action rather
// than rendering an empty panel, and the error state must offer a way out.
test("the Grok page covers loading, absent and error states", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("grok.loading");
  expect(page).toContain("grok.notConfiguredTitle");
  expect(page).toContain("grok.notConfiguredHint");
  expect(page).toContain("common.retry");
});

/*
 * Grok is no longer a top-level page. WP5 collapsed `api`, `claude` and `grok`
 * into one Integrations route, so reachability now means: the nested hash is a
 * registered route, and an old `#grok` bookmark still lands on the Grok tab
 * rather than on Overview.
 */
test("the Grok surface is reachable through the Integrations route", async () => {
  const { INTEGRATION_TAB_HASHES, readPageFromHash, resolveAppHashChange } =
    await import("../src/app-routing");
  expect(INTEGRATION_TAB_HASHES).toContain("integrations/grok");
  expect(readPageFromHash("integrations/grok")).toBe("integrations");
  expect(resolveAppHashChange("integrations/grok").replaceTo).toBeNull();
  // The legacy bookmark keeps its destination.
  expect(resolveAppHashChange("grok").replaceTo).toBe("integrations/grok");
});

test("every locale carries the Grok keys", async () => {
  const keys = ["nav.grok", "grok.title", "grok.subtitle", "grok.loading", "grok.loadFail",
    "grok.notConfiguredTitle", "grok.notConfiguredHint", "grok.endpoint",
    "grok.colModel", "grok.colAlias", "grok.colContext",
    "grok.groupNative", "grok.groupRouted", "grok.enabledCount",
    "grok.saved", "grok.savedApplied", "grok.saveFailed", "grok.applyFailed",
    "grok.applySkipped", "grok.saveApply", "grok.saving", "grok.applying",
    "grok.unsaved", "grok.upToDate", "grok.toggleModel"];
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dict = await read(`../src/i18n/${locale}.ts`);
    for (const key of keys) {
      const match = new RegExp(`"${key.replace(".", "\\.")}":\\s*"([^"]+)"`).exec(dict);
      if (!match) missing.push(`${locale}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});
