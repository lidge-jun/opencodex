import { expect, test } from "bun:test";

test("Models provider headers use wrap-safe classes and a sibling toggle boundary", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  expect(src).toContain("models-provider-head");
  expect(src).toContain("models-provider-actions");
  expect(src).toContain("models-provider-toggle");
  // Collapse lives on a sibling button; the actions row no longer needs stopPropagation.
  expect(src).toMatch(/className="row models-provider-toggle"/);
  expect(src).toMatch(/className="row models-provider-actions"/);
  expect(src).not.toMatch(/className="row models-provider-actions"\s+onClick=\{e => e\.stopPropagation\(\)\}/);
  // Both Classic and Workspace share renderGroup — no duplicate unclassed group-head for providers.
  const providerHeads = src.match(/models-provider-head/g) ?? [];
  expect(providerHeads.length).toBeGreaterThanOrEqual(1);
  expect(src).toContain("models.allOn");
  expect(src).toContain("models.allOff");
});

test("Models workspace stacks via content-width container query before mobile drawer", async () => {
  const css = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();
  expect(css).toContain("container-name: models-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container models-workspace (max-width: 720px)");
  expect(css).toContain(".models-provider-head");
  expect(css).toContain(".models-provider-actions");
  expect(css).toContain(".models-provider-toggle");
  expect(css).toMatch(/\.models-provider-head\s*\{[^}]*flex-wrap:\s*wrap/s);
  expect(css).toMatch(/\.models-provider-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  expect(css).toMatch(/\.models-provider-toggle\s*\{[^}]*min-width:\s*0/s);
  // Mobile media rule retained for drawer layouts.
  expect(css).toContain("@media (max-width: 768px)");
});

test("Models catalog and routing tabs keep the same wide page width", async () => {
  const css = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();

  // Both panels stay mounted after first visit, so the width rule must follow the
  // visible panel rather than the catalog shell's historical presence in the DOM.
  expect(css).toMatch(
    /\.main-inner:has\(\s*#models-panel-catalog:not\(\[hidden\]\),\s*#models-panel-routing:not\(\[hidden\]\)\s*\)\s*\{\s*max-width:\s*1200px;/s,
  );
  expect(css).not.toContain("#models-panel-catalog:not([hidden]) .models-workspace-shell");
});

test("Models exposes provider and per-model context-window controls (#1073)", async () => {
  const page = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  const groups = await Bun.file(new URL("../src/models-groups.ts", import.meta.url)).text();

  expect(groups).toContain("contextWindow?: number");
  expect(groups).toContain("modelContextWindows?: Record<string, number>");
  expect(page).toContain('t("models.contextSettings")');
  expect(page).toContain("modelContextWindows");
  expect(page).toMatch(/\/api\/providers\?name=.*method:\s*"PATCH"/s);
  expect(page).toContain('className="models-context-fields"');

  const css = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();
  expect(css).toMatch(/\.models-context-fields\s*\{[^}]*gap:\s*var\(--space-4\)/s);
});
