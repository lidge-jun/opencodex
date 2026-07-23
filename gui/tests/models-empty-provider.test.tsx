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

function renderHint(liveModels: boolean, discovery?: ProviderDiscoverySummary): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <EmptyProviderHint liveModels={liveModels} discovery={discovery} />
    </LanguageProvider>,
  );
}

test("empty live-discovery provider renders endpoint guidance and a settings link", () => {
  const html = renderHint(true, { status: "ok" });
  expect(html).toContain("No models were discovered");
  expect(html).toContain('href="#providers"');
  expect(html).toContain("Open provider settings");
  expect(html).not.toContain("Discovery failed");
});

test("failed HTTP discovery renders an amber status badge and reason", () => {
  const html = renderHint(true, { status: "failed", reason: "http", httpStatus: 401 });
  expect(html).toContain("Discovery failed");
  expect(html).toContain("HTTP 401");
  expect(html).toContain('class="badge badge-amber"');
  expect(html).toContain('role="status"');
  expect(html).toContain('href="#providers"');
});

test("failed discovery renders each server-owned reason without provider detail", () => {
  const cases: Array<[ProviderDiscoverySummary, string]> = [
    [{ status: "failed", reason: "blocked" }, "blocked by the destination policy"],
    [{ status: "failed", reason: "invalid_response" }, "returned an invalid response"],
    [{ status: "failed", reason: "network" }, "due to a network error"],
    [{ status: "failed", reason: "provider" }, "provider reported a model discovery error"],
  ];

  for (const [discovery, reason] of cases) {
    const html = renderHint(true, discovery);
    expect(html).toContain("Discovery failed");
    expect(html).toContain(reason);
    expect(html).toContain("Open provider settings");
  }
});

test("empty static provider explains that live discovery is disabled", () => {
  const html = renderHint(false);
  expect(html).toContain("Live model discovery is off");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("Discovery failed");
});
