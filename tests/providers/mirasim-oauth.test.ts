import { afterEach, describe, expect, test } from "bun:test";
import {
  handleMirasimBrowserOAuthRequest,
  loginMirasim,
  mirasimClientVersion,
  mirasimRelayUrl,
} from "../../src/oauth/mirasim";
import { parseMirasimLoginOpts } from "../../src/oauth/login-cli";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type AuthCall = {
  path: string;
  body?: Record<string, unknown>;
};

function installEmailAuthServer(
  calls: AuthCall[],
  verifyPayload: Record<string, unknown> = {
    access_token: "opaque-access-token",
    refresh_token: "opaque-refresh-token",
    expires_in: 1800,
  },
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const path = new URL(url).pathname;
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
    calls.push({ path, ...(body ? { body } : {}) });
    if (path === "/auth/code") {
      // Development servers may echo a code. OpenCodex must never consume or surface it.
      return new Response(JSON.stringify({ code: "server-must-not-drive-login" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/auth/verify") {
      return new Response(JSON.stringify(verifyPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ email: "user@example.com", plan: "pro" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected Mirasim auth path: ${path}`);
  }) as typeof fetch;
}

function installBrowserAuthServer(calls: AuthCall[]): void {
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const path = new URL(url).pathname;
    calls.push({ path });
    if (path === "/auth/oauth/providers") {
      return new Response(JSON.stringify({ providers: ["github", "google"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ email: "browser@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected Mirasim auth path: ${path}`);
  }) as typeof fetch;
}

describe("Mirasim OAuth/email login", () => {
  test("rejects control characters in the runtime protocol version", () => {
    const previous = process.env.MIRASIM_CLIENT_VERSION;
    try {
      process.env.MIRASIM_CLIENT_VERSION = "0.0.336\r\nInjected: yes";
      expect(() => mirasimClientVersion()).toThrow("Invalid Mirasim client version");
    } finally {
      if (previous === undefined) delete process.env.MIRASIM_CLIENT_VERSION;
      else process.env.MIRASIM_CLIENT_VERSION = previous;
    }
  });
  test("email login requests a code, prompts locally, and persists renewable credential material", async () => {
    const calls: AuthCall[] = [];
    installEmailAuthServer(calls);
    const progress: string[] = [];
    const prompts: string[] = [];

    const credential = await loginMirasim({
      onProgress: message => progress.push(message),
      onManualCodeInput: async (_state, prompt) => {
        prompts.push(prompt ?? "");
        return " 123456 ";
      },
    }, { email: " user@example.com " });

    expect(calls).toEqual([
      { path: "/auth/code", body: { email: "user@example.com" } },
      { path: "/auth/verify", body: { email: "user@example.com", code: "123456" } },
      { path: "/auth/me" },
    ]);
    expect(progress).toEqual(["Mirasim sent a sign-in code to user@example.com."]);
    expect(prompts).toEqual(["Enter the Mirasim sign-in code: "]);
    expect(credential.access).toBe("opaque-access-token");
    expect(credential.refresh).toBe("opaque-refresh-token");
    expect(credential.email).toBe("user@example.com");
    expect(credential.mirasim?.devicePrivateKey).toContain("PRIVATE KEY");
    expect(credential.mirasim?.relayUrl).toBe("https://relay.mirasim.ai");
  });

  test("provided email code skips the send-code request", async () => {
    const calls: AuthCall[] = [];
    installEmailAuthServer(calls);

    const credential = await loginMirasim({}, {
      email: "user@example.com",
      code: "654321",
    });

    expect(calls).toEqual([
      { path: "/auth/verify", body: { email: "user@example.com", code: "654321" } },
      { path: "/auth/me" },
    ]);
    expect(credential.refresh).toBe("opaque-refresh-token");
  });

  test("email login refuses a non-renewable response", async () => {
    const calls: AuthCall[] = [];
    installEmailAuthServer(calls, { access_token: "short-lived-only" });

    await expect(loginMirasim({}, {
      email: "user@example.com",
      code: "123456",
    })).rejects.toThrow("no renewable credential");
  });

  test("CLI Mirasim email options map into the normal OAuth login transaction", () => {
    expect(parseMirasimLoginOpts([])).toBeUndefined();
    expect(() => parseMirasimLoginOpts([
      "--email", "user@example.com",
      "--code", "123456",
    ])).toThrow("Usage: ocx login mirasim");
    expect(parseMirasimLoginOpts([
      "--email", "user@example.com",
      "--code", "-",
    ])).toEqual({
      mirasimEmail: "user@example.com",
      mirasimCode: "-",
    });
    expect(() => parseMirasimLoginOpts(["--code", "123456"]))
      .toThrow("--code requires --email");
    expect(() => parseMirasimLoginOpts(["--wat"]))
      .toThrow("Unknown Mirasim login option");
    const accidentalSecret = "654321-sensitive";
    try {
      parseMirasimLoginOpts([accidentalSecret]);
      throw new Error("expected parser failure");
    } catch (error) {
      expect(String(error)).not.toContain(accidentalSecret);
      expect(String(error)).toContain("position 1");
    }
  });

  test("a malformed relay env is validated only when Mirasim config is resolved", () => {
    const previous = process.env.MIRASIM_RELAY_URL;
    process.env.MIRASIM_RELAY_URL = "http://example.com";
    try {
      expect(() => mirasimRelayUrl()).toThrow("must use HTTPS unless it is loopback");
      const child = Bun.spawnSync({
        cmd: [process.execPath, "-e", 'await import("./src/oauth/index.ts");'],
        cwd: process.cwd(),
        env: { ...process.env, MIRASIM_RELAY_URL: "http://example.com" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.MIRASIM_RELAY_URL;
      else process.env.MIRASIM_RELAY_URL = previous;
    }
  });

  test("malformed management callback paths terminate inside the OAuth namespace", async () => {
    const response = await handleMirasimBrowserOAuthRequest(new Request(
      "http://127.0.0.1:10100/oauth/mirasim/callback/abc?lang=zh-TW",
    ));
    expect(response?.status).toBe(400);
    expect(await response!.text()).toContain("Mirasim 登入連結已過期");
  });

  test("management browser flow starts on a local provider chooser instead of silently preferring GitHub", async () => {
    const calls: AuthCall[] = [];
    installBrowserAuthServer(calls);
    let authUrl = "";
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();

    expect(new URL(authUrl).origin).toBe("http://127.0.0.1:10100");
    expect(new URL(authUrl).pathname).toBe("/oauth/mirasim/start");
    expect(new URL(authUrl).searchParams.get("lang")).toBe("en");
    expect(authUrl).not.toContain("/auth/oauth/github/login");

    const chooser = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
    expect(chooser?.status).toBe(200);
    const chooserHtml = await chooser!.text();
    expect(chooserHtml).toContain("/provider-icons/mirasim.svg");
    expect(chooserHtml).toContain("Continue with GitHub");
    expect(chooserHtml).toContain("Continue with Google");

    const start = new URL(authUrl);
    const state = start.searchParams.get("state");
    expect(state).toBeTruthy();
    start.searchParams.set("provider", "google");
    const redirect = await handleMirasimBrowserOAuthRequest(new Request(start));
    expect(redirect?.status).toBe(302);
    const upstream = new URL(redirect!.headers.get("location")!);
    expect(upstream.origin).toBe("https://auth.mirasim.ai");
    expect(upstream.pathname).toBe("/auth/oauth/google/login");
    const redirectUri = new URL(upstream.searchParams.get("redirect_uri")!);
    expect(redirectUri.origin).toBe("http://127.0.0.1:10100");
    expect(redirectUri.pathname).toMatch(/^\/oauth\/mirasim\/callback\/[A-Za-z0-9_-]{20,}$/);
    expect(upstream.searchParams.get("state")).toBe(state);

    // Current Mirasim production omits the separately supplied state on the token callback.
    // The unguessable one-use callback path is therefore the channel binding, matching the
    // upstream CLI implementation.
    const callback = new URL(redirectUri);
    callback.searchParams.set("access_token", "browser-access");
    callback.searchParams.set("refresh_token", "browser-refresh");
    const callbackResponse = await handleMirasimBrowserOAuthRequest(new Request(callback));
    expect(callbackResponse?.status).toBe(303);
    const clean = callbackResponse!.headers.get("location");
    expect(clean).not.toContain("access_token");
    expect(clean).not.toContain("refresh_token");

    const completion = await handleMirasimBrowserOAuthRequest(new Request(clean!));
    expect(completion?.status).toBe(200);
    const credential = await login;
    expect(credential.access).toBe("browser-access");
    expect(credential.refresh).toBe("browser-refresh");
    expect(credential.email).toBe("browser@example.com");
    expect(calls.map(call => call.path)).toEqual([
      "/auth/oauth/providers",
      "/auth/oauth/providers",
      "/auth/me",
    ]);
  });

  test("management browser flow follows English, Traditional Chinese, and Simplified Chinese locale", async () => {
    const calls: AuthCall[] = [];
    installBrowserAuthServer(calls);
    const cases = [
      {
        locale: "en",
        htmlLang: "en",
        title: "Sign in to Mirasim",
        chooser: "Choose the account provider you want to use.",
        button: "Continue with GitHub",
        instruction: "Choose GitHub or Google on the Mirasim sign-in page.",
      },
      {
        locale: "zh-TW",
        htmlLang: "zh-TW",
        title: "登入 Mirasim",
        chooser: "選擇要用於登入的帳號供應商。",
        button: "使用 GitHub 繼續",
        instruction: "請在 Mirasim 登入頁面選擇 GitHub 或 Google。",
      },
      {
        locale: "zh",
        htmlLang: "zh-CN",
        title: "登录 Mirasim",
        chooser: "选择用于登录的账户提供商。",
        button: "使用 GitHub 继续",
        instruction: "请在 Mirasim 登录页面选择 GitHub 或 Google。",
      },
    ] as const;

    for (const item of cases) {
      const abort = new AbortController();
      let authUrl = "";
      let instruction = "";
      const login = loginMirasim({
        signal: abort.signal,
        onAuth: info => {
          authUrl = info.url;
          instruction = info.instructions ?? "";
        },
      }, {
        browserBaseUrl: "http://127.0.0.1:10100",
        browserLocale: item.locale,
      });
      await Promise.resolve();

      expect(new URL(authUrl).searchParams.get("lang")).toBe(item.htmlLang);
      expect(instruction).toBe(item.instruction);
      const chooser = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
      expect(chooser?.status).toBe(200);
      const html = await chooser!.text();
      expect(html).toContain(`<html lang="${item.htmlLang}"`);
      expect(html).toContain(item.title);
      expect(html).toContain(item.chooser);
      expect(html).toContain(item.button);

      abort.abort();
      await expect(login).rejects.toThrow("cancelled");
    }
  });

  test("expired browser links keep locale-aware recovery copy", async () => {
    const traditional = await handleMirasimBrowserOAuthRequest(new Request(
      "http://127.0.0.1:10100/oauth/mirasim/start?state=missing&lang=zh-TW",
    ));
    expect(traditional?.status).toBe(400);
    expect(await traditional!.text()).toContain("此登入連結無效或已過期");

    const simplified = await handleMirasimBrowserOAuthRequest(new Request(
      "http://127.0.0.1:10100/oauth/mirasim/start?state=missing&lang=zh-CN",
    ));
    expect(simplified?.status).toBe(400);
    expect(await simplified!.text()).toContain("此登录链接无效或已过期");

    const english = await handleMirasimBrowserOAuthRequest(new Request(
      "http://127.0.0.1:10100/oauth/mirasim/start?state=missing&lang=en",
    ));
    expect(english?.status).toBe(400);
    expect(await english!.text()).toContain("This sign-in link is invalid or has expired");
  });

  test("cancelled management browser flow invalidates its start capability", async () => {
    const calls: AuthCall[] = [];
    installBrowserAuthServer(calls);
    const abort = new AbortController();
    let authUrl = "";
    const login = loginMirasim({
      signal: abort.signal,
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();
    abort.abort();
    await expect(login).rejects.toThrow("cancelled");

    const expired = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
    expect(expired?.status).toBe(400);
    expect(await expired!.text()).toContain("invalid or has expired");
  });

  test("random callback path accepts omitted state but rejects a present mismatched state", async () => {
    const calls: AuthCall[] = [];
    installBrowserAuthServer(calls);
    let authUrl = "";
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();

    const start = new URL(authUrl);
    start.searchParams.set("provider", "github");
    const redirect = await handleMirasimBrowserOAuthRequest(new Request(start));
    const upstream = new URL(redirect!.headers.get("location")!);
    const callback = new URL(upstream.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", "wrong-state");
    callback.searchParams.set("access_token", "must-not-save");
    callback.searchParams.set("refresh_token", "must-not-save");

    const denied = await handleMirasimBrowserOAuthRequest(new Request(callback));
    expect(denied?.status).toBe(400);
    expect(await denied!.text()).toContain("did not match this OpenCodex login attempt");
    await expect(login).rejects.toThrow("state mismatch");
  });
});
