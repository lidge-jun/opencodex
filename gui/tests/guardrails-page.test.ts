import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "ja", "ko", "ru", "zh", "zh-TW", "tr"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

test("Guardrails is a direct, bookmarkable dashboard route", async () => {
  const { hashBelongsToPage, readPageFromHash, resolveAppHashChange } = await import("../src/app-routing");
  for (const hash of [
    "guardrails",
    "guardrails/rules",
    "guardrails/tester",
    "guardrails/activity",
    "guardrails/settings",
  ]) {
    expect(readPageFromHash(hash)).toBe("guardrails");
    expect(hashBelongsToPage(hash, "guardrails")).toBe(true);
    expect(resolveAppHashChange(hash).replaceTo).toBeNull();
  }
  expect(resolveAppHashChange("guardrails/nope").replaceTo).toBe("guardrails");

  const app = await read("../src/App.tsx");
  expect(app).toContain('id: "guardrails"');
  expect(app).toContain('<Guardrails apiBase={API_BASE} />');
});

test("Guardrails page uses the management API and shared UI primitives", async () => {
  const page = await read("../src/pages/Guardrails.tsx");
  const api = await read("../src/pages/guardrails/guardrails-api.ts");
  const managementClient = `${page}\n${api}`;
  for (const endpoint of [
    "/api/guardrails",
    "/api/guardrails/activity",
    "/api/guardrails/export",
    "/api/guardrails/import",
    "/api/guardrails/rules",
    "/api/guardrails/settings",
    "/api/guardrails/test",
  ]) {
    expect(managementClient).toContain(endpoint);
  }
  expect(page).not.toContain("localStorage");
  expect(page).not.toContain("sessionStorage");
  expect(page).not.toContain("window.confirm");
});

test("every dashboard locale carries the Guardrails interface", async () => {
  const keys = [
    "nav.guardrails",
    "guardrails.title",
    "guardrails.enabled",
    "guardrails.mode",
    "guardrails.failurePolicy",
    "guardrails.dataTypes",
    "guardrails.rulesTitle",
    "guardrails.customRules",
    "guardrails.saveRule",
  ];
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dictionary = await read(`../src/i18n/${locale}.ts`);
    for (const key of keys) {
      if (!new RegExp(`"${key.replace(".", "\\.")}":\\s*"`).test(dictionary)) missing.push(`${locale}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});

test("Guardrails keeps activity and controls usable on mobile", async () => {
  const styles = await read("../src/styles-guardrails-workspace.css");
  const activity = await read("../src/pages/guardrails/activity-panel.tsx");

  expect(styles).toContain(".guardrails-wide-table { overflow-x: auto;");
  expect(styles).toContain(".guardrails-wide-table table { width: 100%; min-width: 54rem;");
  expect(styles).toContain("@media (max-width: 640px)");
  expect(styles).toContain(".guardrails-table-scroll-hint { display: block; }");
  expect(styles).toContain(".guardrails-activity-toolbar { grid-template-columns: 1fr;");
  expect(activity).toContain('role="region"');
  expect(activity).toContain("tabIndex={0}");
  expect(activity).toContain("guardrails.tableScrollHint");
});
