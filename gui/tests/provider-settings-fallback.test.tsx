import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

let previousLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  if (previousLanguageDescriptor) {
    Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis.navigator, "language");
  }
});

const item: WorkspaceItem = {
  name: "google-antigravity",
  adapter: "google",
  baseUrl: "https://example.test",
  authMode: "oauth",
  defaultModel: "gemini-3.6-flash",
  fallback: [{ provider: "deepseek", model: "deepseek-v4-flash" }],
};

test("ProviderSettings renders configured fallback targets", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <ProviderSettings
        item={item}
        peerProviders={[
          { name: "google-antigravity", models: ["gemini-3.6-flash"] },
          { name: "deepseek", models: ["deepseek-v4-flash"], defaultModel: "deepseek-v4-flash" },
          { name: "cursor", models: ["claude-sonnet-5"] },
        ]}
      />
    </LanguageProvider>,
  );

  expect(html).toContain("Fallback providers");
  expect(html).toContain("deepseek");
  expect(html).toContain("deepseek-v4-flash");
  expect(html).toContain("Add fallback");
});
