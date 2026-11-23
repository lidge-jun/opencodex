import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyDraft, type ComboItem } from "../src/combo-workspace-data";
import { ComboFallbackPreview } from "../src/components/combo-workspace-fallback";
import { LanguageProvider } from "../src/i18n/provider";

const providers = [
  { name: "openai", alias: "openai", comboBilling: "subscription" as const },
  { name: "openai-apikey" },
  { name: "anthropic", comboBilling: "subscription" as const },
];
const targets = [
  { provider: "openai", model: "shared-model", clientKey: "a" },
  { provider: "openai-apikey", model: "paid-model", clientKey: "b" },
  { provider: "anthropic", model: "shared-model", clientKey: "c" },
];

function preview(patch: Partial<ComboItem> = {}, routes?: Parameters<typeof ComboFallbackPreview>[0]["routes"]) {
  const draft = { ...emptyDraft(), strategy: "failover" as const, quotaOnlyFallback: true, targets, ...patch };
  return renderToStaticMarkup(
    <LanguageProvider><ComboFallbackPreview draft={draft} providers={providers} routes={routes} /></LanguageProvider>,
  );
}

test("the quota preview has a concise live stop and shows which targets are never reached", () => {
  const html = preview();
  expect(html).toMatch(/role="status"[^>]*>.*Stop at step 2\..*Paid API calls need permission/);
  expect(html).toContain('data-state="blocked"');
  expect(html).toContain('data-state="unreached"');
  expect(html).toContain("Not reached");
});

test("a skipped paid step does not change the preserved model", () => {
  const html = preview({ quotaOnlyFallback: false, preserveFallbackModel: true,
    targets: targets.map((target, index) => index === 1 ? { ...target, metered: true } : target),
  });
  expect(html).toContain("Skipped · Paid API calls need permission");
  expect(html).not.toContain('data-state="blocked"');
  expect(html).not.toContain('data-state="unreached"');
  expect(html).toContain("Stop after the last target if it also fails.");
});

test("after consent the model lock still reports the step that would switch models", () => {
  const html = preview({ allowMeteredTargets: true, preserveFallbackModel: true });
  expect(html).toContain("Stop at step 2.");
  expect(html).toContain("Different model with model lock on");
  expect(html).not.toContain("Paid API calls need permission");
});


test("the selected provider and model update to the resolved paid redirect", () => {
  const html = preview({}, {
    "openai/shared-model": { provider: "openai-apikey", model: "redirect-model", requiresConsent: true },
  });
  expect(html).toContain("Stop at step 1.");
  expect(html).toContain("Paid API calls need permission");
  expect(html).toContain("redirect-model");
});
