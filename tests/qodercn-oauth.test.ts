import { describe, expect, test } from "bun:test";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { refreshQoderCnToken } from "../src/oauth/qodercn";

describe("Qoder CN OAuth & Expiry Lifecycle", () => {
  test("public provider registration and default model", () => {
    const entry = (OAUTH_PROVIDERS as any).qodercn;
    expect(entry).toBeDefined();
    expect(typeof entry.login).toBe("function");
    expect(typeof entry.refresh).toBe("function");
    expect(entry.defaultModel).toBe("GLM-5.3-Flash");
  });

  test("token refresh parses relative expires_in and absolute expires_at", async () => {
    const originalFetch = globalThis.fetch;
    const now = Date.now();
    try {
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("/api/v1/deviceToken/refresh")) {
          return new Response(
            JSON.stringify({
              token: "new_refreshed_token",
              refresh_token: "new_refresh_token_2",
              expires_in: 7200,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const result = await refreshQoderCnToken("old_refresh_token");
      expect(result.access).toBe("new_refreshed_token");
      expect(result.refresh).toBe("new_refresh_token_2");
      expect(result.expires).toBeGreaterThan(now);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("token refresh rejects non-2xx failures immediately", async () => {
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () => {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      };

      expect(refreshQoderCnToken("bad_token")).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
