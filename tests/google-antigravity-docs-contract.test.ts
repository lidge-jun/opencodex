import { describe, expect, test } from "bun:test";

const LOCALES = ["", "fr", "ja", "ko", "ru", "tr", "zh-cn", "zh-tw"] as const;

function providersReferencePath(locale: string): string {
  const prefix = locale ? `${locale}/` : "";
  return `../docs-site/src/content/docs/${prefix}reference/configuration/providers.md`;
}

function headingSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = text.slice(start + heading.length);
  const nextHeading = body.indexOf("\n### ");
  return nextHeading === -1 ? body : body.slice(0, nextHeading);
}

describe("Google Antigravity documentation contract", () => {
  test("every provider reference scopes specialized failure rotation away from sidecar loops", async () => {
    for (const locale of LOCALES) {
      const text = await Bun.file(new URL(providersReferencePath(locale), import.meta.url)).text();
      const section = headingSection(text, "### `googleAntigravityAccountPool`");
      expect(section, providersReferencePath(locale)).toContain("image/video bridge");
      expect(section, providersReferencePath(locale)).toContain("web-search sidecar");
      expect(section, providersReferencePath(locale)).toContain("402/429");
    }
  });

  test("account quota docs name both providers with per-account probes", async () => {
    const text = await Bun.file(new URL(
      "../docs-site/src/content/docs/reference/cli/providers-accounts.md",
      import.meta.url,
    )).text();
    expect(text).toContain("per-account probe (Anthropic and Google Antigravity today)");
  });
});
