import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

test("an empty combo list renders the first-combo editor inline", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <ComboWorkspace
        combos={[]}
        providers={[{ name: "openai" }]}
        models={[{ provider: "openai", id: "gpt-5" }]}
        loading={false}
        onRefresh={() => {}}
        onSave={async () => ({ ok: true })}
        onRemove={async () => ({ ok: true })}
        onAdd={() => {}}
        adding={false}
        onCloseAdd={() => {}}
        onCreated={() => {}}
      />
    </LanguageProvider>,
  );

  expect(html).toContain("combos-workspace-root");
  expect(html).toContain('id="cwi-edit-id"');
  expect(html).toContain("Create combo");
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain("Create your first combo");
});
