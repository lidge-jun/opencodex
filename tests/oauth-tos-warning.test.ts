import { describe, expect, test } from "bun:test";
import {
  oauthTosRisk,
  oauthTosRiskBodyKey,
  oauthTosRiskTitleKey,
} from "../gui/src/oauth-tos-risk";

describe("oauth ToS risk map", () => {
  test("flags high-risk subscription OAuth providers", () => {
    expect(oauthTosRisk("anthropic")).toBe("high");
    expect(oauthTosRisk("google-antigravity")).toBe("high");
    expect(oauthTosRisk("Anthropic")).toBe("high");
    expect(oauthTosRisk("  anthropic  ")).toBe("high");
  });

  test("flags elevated unofficial bridges", () => {
    expect(oauthTosRisk("github-copilot")).toBe("elevated");
    expect(oauthTosRisk("cursor")).toBe("elevated");
  });

  test("leaves lower-risk OAuth providers unmarked", () => {
    expect(oauthTosRisk("xai")).toBeNull();
    expect(oauthTosRisk("kimi")).toBeNull();
    expect(oauthTosRisk("kiro")).toBeNull();
    expect(oauthTosRisk("")).toBeNull();
    expect(oauthTosRisk("   ")).toBeNull();
  });

  test("maps risk levels to distinct i18n keys", () => {
    expect(oauthTosRiskTitleKey("high")).toBe("oauthTos.highTitle");
    expect(oauthTosRiskTitleKey("elevated")).toBe("oauthTos.elevatedTitle");
    expect(oauthTosRiskBodyKey("high")).toBe("oauthTos.highBody");
    expect(oauthTosRiskBodyKey("elevated")).toBe("oauthTos.elevatedBody");
  });
});

describe("oauth ToS warning UI seam", () => {
  test("Providers and AddProvider gate OAuth login behind the warning modal", async () => {
    const [page, modal, warn, risk] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/components/AddProviderModal.tsx").text(),
      Bun.file("gui/src/components/OAuthTosWarningModal.tsx").text(),
      Bun.file("gui/src/oauth-tos-risk.ts").text(),
    ]);
    expect(risk).toContain('"anthropic"');
    expect(risk).toContain('"google-antigravity"');
    expect(risk).toContain('"github-copilot"');
    expect(page).toContain("OAuthTosWarningModal");
    expect(page).toContain("requestLoginOAuth");
    expect(page).toContain("oauthTosRisk(provider)");
    expect(page).toContain("if (busy === provider) return");
    expect(modal).toContain("OAuthTosWarningModal");
    expect(modal).toContain("requestLoginOAuth");
    expect(modal).toContain("if (oauthBusy) return");
    expect(modal).toContain("!oauthTosPending");
    expect(warn).toContain("oauthTos.acknowledge");
    expect(warn).toContain("disabled={!acknowledged || submitted}");
    expect(warn).toContain("showModal()");
    expect(warn).toContain("onCancel={handleCancel}");
    expect(warn).not.toContain('?? "elevated"');
  });

  test("i18n locales define oauthTos keys", async () => {
    const keys = [
      "oauthTos.highTitle",
      "oauthTos.elevatedTitle",
      "oauthTos.anthropicBody",
      "oauthTos.highBody",
      "oauthTos.elevatedBody",
      "oauthTos.saferPath",
      "oauthTos.acknowledge",
      "oauthTos.continue",
    ];
    for (const locale of ["en", "de", "ko", "zh"]) {
      const text = await Bun.file(`gui/src/i18n/${locale}.ts`).text();
      for (const key of keys) {
        expect(text).toContain(`"${key}"`);
      }
    }
  });
});
