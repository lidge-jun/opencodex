import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StrategySeg } from "../src/components/combo-workspace-controls";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: previousLanguage });
});

test("combo strategy selector exposes all runtime strategies", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <StrategySeg value="random" onChange={() => {}} />
    </LanguageProvider>,
  );
  const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
  expect(radios).toHaveLength(5);
  expect(html).toContain("Failover");
  expect(html).toContain("Round-robin");
  expect(html).toContain("Random");
  expect(html).toContain("Least-used");
  expect(html).toContain("Reset-window");
  expect(radios.every((button) => !button.includes("disabled="))).toBe(true);
});
