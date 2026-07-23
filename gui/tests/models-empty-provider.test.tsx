import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { EmptyProviderHint } from "../src/pages/Models";
import type { ProviderDiscoverySummary } from "../src/models-groups";

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

function renderHint(liveModels: boolean, discovery?: ProviderDiscoverySummary | null): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <EmptyProviderHint liveModels={liveModels} discovery={discovery} />
    </LanguageProvider>,
  );
}

test("empty live-discovery provider renders endpoint guidance and a settings link", () => {
  const html = renderHint(true);
  expect(html).toContain("No models were discovered");
  expect(html).toContain('href="#providers"');
  expect(html).toContain("Open provider settings");
});

test("empty static provider explains that live discovery is disabled", () => {
  const html = renderHint(false);
  expect(html).toContain("Live model discovery is off");
  expect(html).toContain('role="status"');
});

test("empty provider with HTTP 401 discovery status surfaces the concrete reason (#329)", () => {
  const html = renderHint(true, {
    ok: false,
    kind: "http",
    httpStatus: 401,
    fallback: "configured",
  });
  expect(html).toContain("Discovery failed (HTTP 401)");
  expect(html).toContain("provider stays visible");
  expect(html).toContain('href="#providers"');
});
