import { describe, expect, test } from "bun:test";
import { OAuthCallbackFlow } from "../../src/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../../src/oauth/types";

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

/** Keeps the listener alive across the token exchange so stray requests can reach it. */
class SlowExchangeFlow extends ManualFallbackFlow {
  holdExchange?: Promise<void>;

  override async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
    await this.holdExchange;
    return super.exchangeToken(code, state, redirectUri);
  }
}

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

  test("a retired flow cannot serve the next login on the same callback port", async () => {
    // The preferred callback port is fixed per provider, so consecutive logins listen on the
    // same number. Stopping a listener does not close a connection that is already open, so a
    // client that pools the socket would deliver the SECOND login's callback to the FIRST
    // flow, which rejects the unknown state as a CSRF mismatch while the live flow waits.
    const port = await freeLoopbackPort();
    const options = {
      preferredPort: port,
      callbackPath: "/callback",
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
    };
    const deliver = async (state: string): Promise<number> => {
      const url = new URL(`http://127.0.0.1:${port}/callback`);
      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", state);
      const res = await fetch(url);
      await res.text();
      return res.status;
    };

    const first = new ManualFallbackFlow(ctrl, options);
    const firstLogin = first.login();
    await waitForState(() => first.generated?.state);
    const firstState = first.generated!.state;
    expect(await deliver(firstState)).toBe(200);
    await firstLogin;

    const second = new ManualFallbackFlow(ctrl, options);
    const secondLogin = second.login();
    await waitForState(() => second.generated?.state);
    const secondState = second.generated!.state;
    expect(secondState).not.toBe(firstState);
    // Served by the LIVE flow, so the retired state is now an unknown one.
    expect(await deliver(firstState)).toBe(400);
    expect(await deliver(secondState)).toBe(200);
    await secondLogin;
    expect(second.exchanged?.state).toBe(secondState);
  });

  test("a non-callback request cannot pin the socket to the retiring flow", async () => {
    // A browser that asks for /favicon.ico after the success page would pool the socket on the
    // 404 while exchangeToken() is still running, which re-pins it to the flow that is about to
    // retire. The close policy therefore belongs to EVERY response, not just the callback path.
    const port = await freeLoopbackPort();
    const options = {
      preferredPort: port,
      callbackPath: "/callback",
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
    };
    const deliver = async (state: string): Promise<number> => {
      const url = new URL(`http://127.0.0.1:${port}/callback`);
      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", state);
      const res = await fetch(url);
      await res.text();
      return res.status;
    };

    // The exchange is held open so the listener is still up for the stray request, which is
    // exactly the window the reproduction describes.
    const exchanging = Promise.withResolvers<void>();
    const first = new SlowExchangeFlow(ctrl, options);
    first.holdExchange = exchanging.promise;
    const firstLogin = first.login();
    await waitForState(() => first.generated?.state);
    expect(await deliver(first.generated!.state)).toBe(200);
    const favicon = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    await favicon.text();
    expect(favicon.status).toBe(404);
    exchanging.resolve();
    await firstLogin;

    const second = new ManualFallbackFlow(ctrl, options);
    const secondLogin = second.login();
    await waitForState(() => second.generated?.state);
    // Without the close policy on the 404 this is answered by the retired flow and returns 400.
    expect(await deliver(second.generated!.state)).toBe(200);
    await secondLogin;
    expect(second.exchanged?.state).toBe(second.generated!.state);
  });
});

/** A port that is free right now; the flows bind it themselves, so it must not stay held. */
async function freeLoopbackPort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch: () => new Response("probe") });
  const { port } = probe;
  probe.stop(true);
  return port;
}

async function waitForState(read: () => string | undefined, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (read() === undefined) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the login flow to publish its state");
    await Bun.sleep(5);
  }
}
