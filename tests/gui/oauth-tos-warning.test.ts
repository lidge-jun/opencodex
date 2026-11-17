import { describe, expect, test } from "bun:test";
import {
  oauthRiskAcknowledgementBody,
  oauthTosCopyKeys,
  oauthTosRisk,
  oauthTosRiskBodyKey,
  oauthTosRiskTitleKey,
} from "../../gui/src/oauth-tos-risk";
import { ANTIGRAVITY_RISK_ACK_FIELD, ANTIGRAVITY_TOS_BAN_MESSAGE, hasAntigravityRiskAcknowledgement } from "../../src/oauth/antigravity-risk";

describe("oauth ToS risk map", () => {
  test("flags high-risk subscription OAuth providers", () => {
    expect(oauthTosRisk("anthropic")).toBe("high");
    expect(oauthTosRisk("google-antigravity")).toBe("high");
    // Meta restricts the Muse Code credential to its own CLI in writing, which is the
    // documented difference between "high" and "elevated".
    expect(oauthTosRisk("meta-muse")).toBe("high");
    expect(oauthTosRisk("Anthropic")).toBe("high");
    expect(oauthTosRisk("  anthropic  ")).toBe("high");
  });

  test("flags elevated unofficial bridges", () => {
    expect(oauthTosRisk("github-copilot")).toBe("elevated");
    expect(oauthTosRisk("cursor")).toBe("elevated");
    expect(oauthTosRisk("zed")).toBe("elevated");
  });

  test("leaves lower-risk OAuth providers unmarked", () => {
    expect(oauthTosRisk("xai")).toBeNull();
    expect(oauthTosRisk("kimi")).toBeNull();
    expect(oauthTosRisk("kiro")).toBeNull();
    // The supported Meta path: the user's own key on a documented endpoint.
    expect(oauthTosRisk("meta-model")).toBeNull();
    expect(oauthTosRisk("")).toBeNull();
    expect(oauthTosRisk("   ")).toBeNull();
  });

  test("maps risk levels to distinct i18n keys", () => {
    expect(oauthTosRiskTitleKey("high")).toBe("oauthTos.highTitle");
    expect(oauthTosRiskTitleKey("elevated")).toBe("oauthTos.elevatedTitle");
    expect(oauthTosRiskBodyKey("high")).toBe("oauthTos.highBody");
    expect(oauthTosRiskBodyKey("elevated")).toBe("oauthTos.elevatedBody");
  });

  test("Anthropic and Antigravity get their own dialog copy; other providers keep the shared keys", () => {
    expect(oauthTosCopyKeys(" Anthropic ", "high")).toEqual({
      tone: "warning",
      title: "oauthTos.anthropicTitle",
      body: "oauthTos.anthropicBody",
      conditions: "oauthTos.anthropicConditions",
      saferPath: "oauthTos.anthropicSaferPath",
      acknowledge: "oauthTos.anthropicAcknowledge",
      continue: "oauthTos.anthropicContinue",
    });
    expect(oauthTosCopyKeys(" Google-Antigravity ", "high")).toEqual({
      tone: "danger",
      title: "oauthTos.antigravityTitle",
      body: "oauthTos.antigravityBody",
      conditions: "oauthTos.antigravityConditions",
      saferPath: "oauthTos.antigravitySaferPath",
      acknowledge: "oauthTos.antigravityAcknowledge",
      continue: "oauthTos.antigravityContinue",
    });
    expect(oauthTosCopyKeys("meta-muse", "high")).toEqual({
      tone: "warning",
      title: "oauthTos.highTitle",
      body: "oauthTos.highBody",
      conditions: null,
      saferPath: null,
      acknowledge: "oauthTos.acknowledge",
      continue: "oauthTos.continue",
    });
    expect(oauthTosCopyKeys("cursor", "elevated").title).toBe("oauthTos.elevatedTitle");
    expect(oauthTosCopyKeys("cursor", "elevated").saferPath).toBeNull();
  });

  test("the dashboard sends the exact acknowledgement the API requires, and only when acknowledged", () => {
    const sent = oauthRiskAcknowledgementBody("google-antigravity", true);
    expect(Object.keys(sent)).toEqual([ANTIGRAVITY_RISK_ACK_FIELD]);
    expect(hasAntigravityRiskAcknowledgement({ provider: "google-antigravity", ...sent })).toBe(true);
    expect(oauthRiskAcknowledgementBody("google-antigravity", false)).toEqual({});
    expect(oauthRiskAcknowledgementBody("anthropic", true)).toEqual({});
  });
});

describe("oauth ToS warning UI seam", () => {
  test("Providers and AddProvider gate OAuth login behind the warning modal", async () => {
    const [page, modals, modal, warn, risk] = await Promise.all([
      Bun.file("gui/src/pages/Providers.tsx").text(),
      Bun.file("gui/src/pages/providers-page-modals.tsx").text(),
      Bun.file("gui/src/components/AddProviderModal.tsx").text(),
      Bun.file("gui/src/components/OAuthTosWarningModal.tsx").text(),
      Bun.file("gui/src/oauth-tos-risk.ts").text(),
    ]);
    const providersSeam = page + modals;
    expect(risk).toContain('"anthropic"');
    expect(risk).toContain('"google-antigravity"');
    expect(risk).toContain('"github-copilot"');
    expect(providersSeam).toContain("OAuthTosWarningModal");
    expect(providersSeam).toContain("requestLoginOAuth");
    expect(providersSeam).toContain("oauthTosRisk(provider)");
    expect(providersSeam).toContain("if (busy === provider) return");
    expect(modal).toContain("OAuthTosWarningModal");
    expect(modal).toContain("requestLoginOAuth");
    expect(modal).toContain("if (oauthBusy) return");
    expect(modal).toContain("!oauthTosPending");
    expect(warn).toContain("oauthTosCopyKeys(providerId, level)");
    expect(warn).toContain("t(copy.acknowledge)");
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
      "oauthTos.acknowledge",
      "oauthTos.continue",
      "oauthTos.anthropicTitle",
      "oauthTos.anthropicConditions",
      "oauthTos.anthropicSaferPath",
      "oauthTos.anthropicAcknowledge",
      "oauthTos.anthropicContinue",
      "oauthTos.antigravityTitle",
      "oauthTos.antigravityBody",
      "oauthTos.antigravityConditions",
      "oauthTos.antigravitySaferPath",
      "oauthTos.antigravityAcknowledge",
      "oauthTos.antigravityContinue",
    ];
    for (const locale of ["en", "de", "fr", "ja", "ko", "pt", "ru", "tr", "vi", "zh", "zh-TW"]) {
      const text = await Bun.file(`gui/src/i18n/${locale}.ts`).text();
      for (const key of keys) {
        expect(text).toContain(`"${key}"`);
      }
      // The ban message is quoted verbatim, in English, in every locale: it is what the user
      // will actually see from Google, so a translation would make it unrecognisable.
      expect(text, locale).toContain(ANTIGRAVITY_TOS_BAN_MESSAGE);
    }
  });
});
