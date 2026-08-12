import { describe, expect, test } from "bun:test";
import { OAuthCallbackFlow } from "../src/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";

class TestFlow extends OAuthCallbackFlow {
  async generateAuthUrl(): Promise<{ url: string }> {
    return { url: "https://example.test/auth" };
  }

  async exchangeToken(): Promise<OAuthCredentials> {
    return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
  }
}

class ManualFallbackFlow extends OAuthCallbackFlow {
  generated?: { state: string; redirectUri: string };
  exchanged?: { code: string; state: string; redirectUri: string };

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
    this.generated = { state, redirectUri };
    return { url: `https://example.test/auth?state=${state}` };
  }

  async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
    this.exchanged = { code, state, redirectUri };
    return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
  }
}

const ctrl: OAuthController = {};

describe("OAuth callback server defaults", () => {
  test("binds callback listeners to numeric loopback by default", () => {
    const flow = new TestFlow(ctrl, 54545, "/callback");

    expect(flow.callbackHostname).toBe("localhost");
    expect(flow.callbackBindHostname).toBe("127.0.0.1");
  });

  test("keeps explicit callback bind hostname overrides", () => {
    const flow = new TestFlow(ctrl, {
      preferredPort: 54545,
      callbackPath: "/callback",
      callbackHostname: "localhost",
      callbackBindHostname: "127.0.0.1",
    });

    expect(flow.callbackBindHostname).toBe("127.0.0.1");
  });

  test("continues with manual input when an exact redirect port is unavailable", async () => {
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      reusePort: false,
      fetch: () => new Response("occupied"),
    });
    const redirectUri = `http://127.0.0.1:${blocker.port}/callback`;
    let authUrl = "";
    const flow = new ManualFallbackFlow(
      {
        onAuth: ({ url }) => {
          authUrl = url;
        },
        onManualCodeInput: async () => "manual-code",
      },
      {
        preferredPort: blocker.port,
        callbackPath: "/callback",
        callbackHostname: "127.0.0.1",
        callbackBindHostname: "127.0.0.1",
        redirectUri,
      },
    );

    try {
      const credential = await flow.login();

      expect(authUrl).toStartWith("https://example.test/auth?state=");
      expect(flow.generated?.redirectUri).toBe(redirectUri);
      expect(flow.exchanged).toEqual({
        code: "manual-code",
        state: flow.generated?.state,
        redirectUri,
      });
      expect(credential.access).toBe("access");
    } finally {
      blocker.stop(true);
    }
  });

  test("fails closed when an exact redirect port is unavailable without manual input", async () => {
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      reusePort: false,
      fetch: () => new Response("occupied"),
    });
    const redirectUri = `http://127.0.0.1:${blocker.port}/callback`;
    const flow = new TestFlow(
      {},
      {
        preferredPort: blocker.port,
        callbackPath: "/callback",
        callbackHostname: "127.0.0.1",
        callbackBindHostname: "127.0.0.1",
        redirectUri,
      },
    );

    try {
      await expect(flow.login()).rejects.toThrow(
        `OAuth callback port ${blocker.port} unavailable; cannot fall back to a random port when redirectUri is set`,
      );
    } finally {
      blocker.stop(true);
    }
  });
});
