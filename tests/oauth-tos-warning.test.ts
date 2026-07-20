import { describe, expect, test } from "bun:test";
import { oauthTosRisk } from "../gui/src/oauth-tos-risk";

describe("oauth ToS risk map", () => {
  test("flags high-risk subscription OAuth providers", () => {
    expect(oauthTosRisk("anthropic")).toBe("high");
    expect(oauthTosRisk("google-antigravity")).toBe("high");
    expect(oauthTosRisk("Anthropic")).toBe("high");
  });

  test("flags elevated unofficial bridges", () => {
    expect(oauthTosRisk("github-copilot")).toBe("elevated");
    expect(oauthTosRisk("cursor")).toBe("elevated");
  });

  test("leaves lower-risk OAuth providers unmarked", () => {
    expect(oauthTosRisk("xai")).toBeNull();
    expect(oauthTosRisk("kimi")).toBeNull();
    expect(oauthTosRisk("kiro")).toBeNull();
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
    expect(modal).toContain("OAuthTosWarningModal");
    expect(modal).toContain("requestLoginOAuth");
    expect(warn).toContain("oauthTos.acknowledge");
    expect(warn).toContain("disabled={!acknowledged}");
  });
});
