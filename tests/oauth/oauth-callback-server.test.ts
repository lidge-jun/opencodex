import { describe, expect, test } from "bun:test";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "../../src/oauth/callback-server";
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


/** A barrier-owned login: readiness follows callback registration, and cleanup always settles it. */
function startCallbackLogin(options: OAuthCallbackFlowOptions, holdExchange?: Promise<void>) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  class HeldFlow extends ManualFallbackFlow {
    override async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
      await holdExchange;
      return super.exchangeToken(code, state, redirectUri);
    }
  }
  const flow = new HeldFlow({
    signal: controller.signal,
    onAuth: () => queueMicrotask(() => {
      deadline = setTimeout(() => controller.abort(new Error("callback test deadline")), 5_000);
      ready.resolve();
    }),
  }, options);
  const login = flow.login();
  void login.catch(error => ready.reject(error));
  return {
    flow, login, ready: ready.promise, signal: controller.signal,
    stop() {
      if (deadline !== undefined) clearTimeout(deadline);
      controller.abort(new Error("callback test cleanup"));
    },
  };
}

async function availableCallbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch: () => new Response("probe") });
  const port = server.port;
  await server.stop(true);
  return port;
}

async function callbackResponse(port: number, path: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal });
  await response.text();
  return response;
}

for (const favicon of [false, true]) {
  test(favicon
    ? "a non-callback request cannot pin the socket to the retiring flow"
    : "a retired flow cannot serve the next login on the same callback port", async () => {
    const port = await availableCallbackPort();
    const options = { preferredPort: port, callbackPath: "/callback", callbackHostname: "127.0.0.1", callbackBindHostname: "127.0.0.1" };
    const exchange = Promise.withResolvers<void>();
    const started: ReturnType<typeof startCallbackLogin>[] = [];
    try {
      const first = startCallbackLogin(options, exchange.promise);
      started.push(first);
      await first.ready;
      const firstState = first.flow.generated!.state;
      const success = await callbackResponse(port, `/callback?code=first-code&state=${firstState}`, first.signal);
      expect(success.status).toBe(200);
      expect(success.headers.get("connection")).toBe("close");
      if (favicon) {
        const stray = await callbackResponse(port, "/favicon.ico", first.signal);
        expect(stray.status).toBe(404);
        expect(stray.headers.get("connection")).toBe("close");
      }
      exchange.resolve();
      await first.login;
      const second = startCallbackLogin(options);
      started.push(second);
      await second.ready;
      const secondState = second.flow.generated!.state;
      expect(secondState).not.toBe(firstState);
      const retired = await callbackResponse(port, `/callback?code=old-code&state=${firstState}`, second.signal);
      expect(retired.status).toBe(400);
      expect(retired.headers.get("connection")).toBe("close");
      const malformed = await callbackResponse(port, "/callback", second.signal);
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("connection")).toBe("close");
      const live = await callbackResponse(port, `/callback?code=second-code&state=${secondState}`, second.signal);
      expect(live.status).toBe(200);
      expect(live.headers.get("connection")).toBe("close");
      await second.login;
      expect(second.flow.exchanged?.state).toBe(secondState);
    } finally {
      exchange.resolve();
      for (const flow of started) flow.stop();
      await Promise.allSettled(started.map(flow => flow.login));
    }
  }, 15_000);
}

test("provider errors close the callback response without retaining the socket", async () => {
  const port = await availableCallbackPort();
  const flow = startCallbackLogin({ preferredPort: port, callbackHostname: "127.0.0.1", callbackBindHostname: "127.0.0.1" });
  try {
    await flow.ready;
    const response = await callbackResponse(port, `/callback?error=access_denied&state=${flow.flow.generated!.state}`, flow.signal);
    expect(response.status).toBe(500);
    expect(response.headers.get("connection")).toBe("close");
    await expect(flow.login).rejects.toThrow("Authorization failed");
  } finally {
    flow.stop();
    await Promise.allSettled([flow.login]);
  }
});
