import { describe, expect, test } from "bun:test";
import { oauthLoginSummary } from "../src/oauth/index";

describe("oauthLoginSummary (ocx status OAuth logins)", () => {
  test("lists every OAuth provider with a boolean login state, including cursor", () => {
    const summary = oauthLoginSummary();
    const providers = summary.map(e => e.provider);
    expect(providers).toContain("cursor");
    expect(providers).toContain("xai");
    expect(providers).toContain("anthropic");
    expect(providers).toContain("kimi");
    for (const e of summary) {
      expect(typeof e.loggedIn).toBe("boolean");
    }
  });

  test("never exposes an access/refresh token (only provider/loggedIn/masked-email)", () => {
    const json = JSON.stringify(oauthLoginSummary());
    // No JWT-shaped token should ever appear in the status summary.
    expect(json).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    for (const e of oauthLoginSummary()) {
      expect(Object.keys(e).sort()).toEqual(e.email ? ["email", "loggedIn", "provider"] : ["loggedIn", "provider"]);
    }
  });
});
