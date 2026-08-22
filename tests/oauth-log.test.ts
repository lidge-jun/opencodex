import { describe, expect, test } from "bun:test";
import { logOAuthEvent } from "../src/oauth/log";

describe("logOAuthEvent", () => {
  test("emits redacted account and never prints a token-looking field value", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logOAuthEvent("OAuth refresh started", {
        provider: "kiro",
        accountId: "acct_abcdefghijklmnopqrstuvwxyz",
        until: "2026-07-23T14:30:00.000Z",
      });
    } finally {
      console.info = original;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[opencodex]");
    expect(lines[0]).toContain("provider=kiro");
    expect(lines[0]).toContain("account=account-…wxyz");
    expect(lines[0]).not.toContain("acct_abcdefghijklmnopqrstuvwxyz");
  });

  test("omits forbidden token-like field keys from output", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logOAuthEvent("OAuth refresh started", {
        provider: "kiro",
        access: "secret-access-value",
        refresh: "secret-refresh-value",
        authorization: "secret-authorization-value",
        code: "secret-code-value",
        token: "secret-token-value",
        accessToken: "secret-accessToken-value",
        refreshToken: "secret-refreshToken-value",
        access_token: "secret-access_token-value",
        refresh_token: "secret-refresh_token-value",
        id_token: "secret-id_token-value",
        client_secret: "secret-client_secret-value",
        oauth_code: "secret-oauth_code-value",
        code_verifier: "secret-code_verifier-value",
        "client-secret": "secret-client-secret-value",
        safe: "visible",
      });
    } finally {
      console.info = original;
    }
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line).toContain("provider=kiro");
    expect(line).toContain("safe=visible");
    for (const key of [
      "access",
      "refresh",
      "authorization",
      "code",
      "token",
      "accessToken",
      "refreshToken",
      "access_token",
      "refresh_token",
      "id_token",
      "client_secret",
      "oauth_code",
      "code_verifier",
      "client-secret",
    ]) {
      expect(line).not.toContain(`${key}=`);
    }
    expect(line).not.toContain("secret-");
  });

  test("redacts token-shaped values inside otherwise safe cleanup fields", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logOAuthEvent("OAuth account cleanup failed", {
        provider: "xai",
        cause: "upstream returned Bearer credentialvalue123456",
        request: "sk-fixturecredential",
        status: 500,
      });
    } finally {
      console.info = original;
    }

    expect(lines).toEqual([
      "[opencodex] OAuth account cleanup failed provider=xai cause=upstream returned Bearer [REDACTED] request=[REDACTED] status=500",
    ]);
  });
});
