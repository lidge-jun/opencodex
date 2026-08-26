import { describe, expect, test } from "bun:test";

const LOCALES = ["", "fr", "ja", "ko", "ru", "tr", "zh-cn", "zh-tw"] as const;

const DIRECT_DISABLE_MARKER: Record<(typeof LOCALES)[number], string> = {
  "": "without changing the separate generic OAuth fallback",
  fr: "sans modifier le basculement OAuth générique distinct",
  ja: "別個の汎用 OAuth fallback は変更されません",
  ko: "별도의 일반 OAuth fallback은 변경되지 않습니다",
  ru: "отдельный generic OAuth fallback не изменится",
  tr: "ayrı genel OAuth fallback ayarını değiştirmez",
  "zh-cn": "不会改变独立的通用 OAuth fallback",
  "zh-tw": "不會改變獨立的通用 OAuth fallback",
};

const PARTIAL_UPDATE_MARKER: Record<(typeof LOCALES)[number], string> = {
  "": "updates that omit `enabled` preserve",
  fr: "omet `enabled` conserve",
  ja: "`enabled` を省略した部分更新は",
  ko: "`enabled`를 생략한 부분 업데이트는",
  ru: "Частичное обновление без `enabled` сохраняет",
  tr: "`enabled` alanını atlayan kısmi güncellemeler",
  "zh-cn": "省略 `enabled` 的 部分更新会保留",
  "zh-tw": "省略 `enabled` 的 部分更新會保留",
};

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

  test("every provider reference distinguishes direct disable from operational off", async () => {
    for (const locale of LOCALES) {
      const text = await Bun.file(new URL(providersReferencePath(locale), import.meta.url)).text();
      const section = headingSection(text, "### `googleAntigravityAccountPool`");
      const compactSection = section.replace(/\s+/g, " ");
      expect(section, providersReferencePath(locale)).toContain(
        "ocx account auto-switch google-antigravity off",
      );
      expect(section, providersReferencePath(locale)).toContain("PUT/PATCH /api/oauth/accounts/pool");
      expect(section, providersReferencePath(locale)).toContain("enabled: false");
      expect(section, providersReferencePath(locale)).toContain(
        "providers.google-antigravity.oauthAccountFailover.enabled",
      );
      expect(section, providersReferencePath(locale)).toContain("`true`");
      expect(compactSection, providersReferencePath(locale)).toContain(DIRECT_DISABLE_MARKER[locale]);
      expect(compactSection, providersReferencePath(locale)).toContain(PARTIAL_UPDATE_MARKER[locale]);
      expect(section, providersReferencePath(locale)).not.toContain("ocx account pool google-antigravity");
    }
  });
});
