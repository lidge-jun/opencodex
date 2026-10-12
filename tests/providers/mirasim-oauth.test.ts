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

  test("legacy management token-callback paths are no longer owned", async () => {
    const response = await handleMirasimBrowserOAuthRequest(new Request(
      "http://127.0.0.1:10100/oauth/mirasim/callback/abc?access_token=must-not-arrive&refresh_token=must-not-arrive",
    ));
    expect(response).toBeNull();
  });

  test("default CLI login uses email verification without creating a browser callback", async () => {
    const calls: AuthCall[] = [];
    installEmailAuthServer(calls);
    const prompts: string[] = [];
    const answers = ["cli@example.com", "123456"];
    let authUrl = "";

    const credential = await loginMirasim({
      onAuth: info => { authUrl = info.url; },
      onManualCodeInput: async (_state, prompt) => {
        prompts.push(prompt ?? "");
        return answers.shift() ?? "";
      },
    });

    expect(authUrl).toBe("");
    expect(prompts).toEqual([
      "Enter the Mirasim account email: ",
      "Enter the Mirasim sign-in code: ",
    ]);
    expect(calls.map(call => call.path)).toEqual(["/auth/code", "/auth/verify", "/auth/me"]);
    expect(credential.access).toBeTruthy();
    expect(credential.refresh).toBeTruthy();
  });

  test("management browser flow exchanges an emailed code server-side without credentials in the URL", async () => {
    const calls: AuthCall[] = [];
    installEmailAuthServer(calls, {
      access_token: "browser-access",
      refresh_token: "browser-refresh",
      expires_in: 1800,
    });
    let authUrl = "";
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();

    const start = new URL(authUrl);
    expect(start.origin).toBe("http://127.0.0.1:10100");
    expect(start.pathname).toBe("/oauth/mirasim/start");
    expect(start.searchParams.get("lang")).toBe("en");
    expect(authUrl).not.toContain("access_token");
    expect(authUrl).not.toContain("refresh_token");
    expect(authUrl).not.toContain("/auth/oauth/");

    const entry = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
    expect(entry?.status).toBe(200);
    const entryHtml = await entry!.text();
    expect(entryHtml).toContain("/provider-icons/mirasim.svg");
    expect(entryHtml).toContain("Send verification code");
    expect(entryHtml).not.toContain("access_token");
    expect(entryHtml).not.toContain("refresh_token");

    const send = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=send&email=browser%40example.com",
    }));
    expect(send?.status).toBe(200);
    expect(await send!.text()).toContain("Verification code");

    const duplicateSend = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=send&email=browser%40example.com",
    }));
    expect(duplicateSend?.status).toBe(409);
    expect(calls.filter(call => call.path === "/auth/code")).toHaveLength(1);

    const verify = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=verify&code=123456",
    }));
    expect(verify?.status).toBe(200);
    const verifyHtml = await verify!.text();
    expect(verifyHtml).toContain("Mirasim sign-in complete");
    expect(verifyHtml).not.toContain("browser-access");
    expect(verifyHtml).not.toContain("browser-refresh");

    const credential = await login;
    expect(credential.access).toBe("browser-access");
    expect(credential.refresh).toBe("browser-refresh");
    expect(credential.email).toBe("user@example.com");
    expect(calls).toEqual([
      { path: "/auth/code", body: { email: "browser@example.com" } },
      { path: "/auth/verify", body: { email: "browser@example.com", code: "123456" } },
      { path: "/auth/me" },
    ]);

    const replay = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=verify&code=123456",
    }));
    expect(replay?.status).toBe(400);
    expect(await replay!.text()).toContain("invalid or has expired");
  });

  test("management browser flow follows English, Traditional Chinese, and Simplified Chinese locale", async () => {
    const cases = [
      {
        locale: "en",
        htmlLang: "en",
        title: "Sign in to Mirasim",
        chooser: "Enter the email address for your Mirasim account.",
        button: "Send verification code",
        instruction: "Complete Mirasim sign-in in the browser using the emailed verification code.",
      },
      {
        locale: "zh-TW",
        htmlLang: "zh-TW",
        title: "登入 Mirasim",
        chooser: "輸入 Mirasim 帳號的電子郵件地址",
        button: "傳送驗證碼",
        instruction: "請在瀏覽器中使用電子郵件驗證碼完成 Mirasim 登入。",
      },
      {
        locale: "zh",
        htmlLang: "zh-CN",
        title: "登录 Mirasim",
        chooser: "输入 Mirasim 账户的电子邮件地址",
        button: "发送验证码",
        instruction: "请在浏览器中使用电子邮件验证码完成 Mirasim 登录。",
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
      const page = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
      expect(page?.status).toBe(200);
      const html = await page!.text();
      expect(html).toContain(`<html lang="${item.htmlLang}"`);
      expect(html).toContain(item.title);
      expect(html).toContain(item.chooser);
      expect(html).toContain(item.button);
      expect(html).not.toContain("access_token");
      expect(html).not.toContain("refresh_token");

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

  test("management browser verification caps failed code attempts and expires the session", async () => {
    const calls: AuthCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      calls.push({ path });
      if (path === "/auth/code") return new Response(null, { status: 200 });
      if (path === "/auth/verify") return new Response(null, { status: 400 });
      throw new Error(`unexpected Mirasim auth path: ${path}`);
    }) as typeof fetch;

    let authUrl = "";
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();

    const send = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=send&email=user%40example.com",
    }));
    expect(send?.status).toBe(200);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const denied = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `action=verify&code=${100000 + attempt}`,
      }));
      expect(denied?.status).toBe(400);
    }
    expect(calls.filter(call => call.path === "/auth/verify")).toHaveLength(5);
    await expect(login).rejects.toThrow("verification attempts exhausted");

    const expired = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
    expect(expired?.status).toBe(400);
    expect(await expired!.text()).toContain("invalid or has expired");
  });

  test("management browser verification reserves the five-attempt budget before concurrent upstream calls", async () => {
    let verifyCalls = 0;
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>(resolve => { releaseVerify = resolve; });
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/auth/code") return new Response(null, { status: 200 });
      if (path === "/auth/verify") {
        verifyCalls += 1;
        await verifyGate;
        return new Response(null, { status: 400 });
      }
      throw new Error(`unexpected Mirasim auth path: ${path}`);
    }) as typeof fetch;

    let authUrl = "";
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();

    const send = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=send&email=user%40example.com",
    }));
    expect(send?.status).toBe(200);

    let locallySettled = 0;
    const attempts = Array.from({ length: 8 }, (_, index) =>
      handleMirasimBrowserOAuthRequest(new Request(authUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `action=verify&code=${200000 + index}`,
      })).finally(() => { locallySettled += 1; }),
    );

    for (let spin = 0; spin < 1_000 && verifyCalls + locallySettled < attempts.length; spin += 1) {
      await Bun.sleep(1);
    }
    const callsBeforeRelease = verifyCalls;
    releaseVerify();

    const responses = await Promise.all(attempts);
    expect(responses.every(response => response?.status === 400)).toBe(true);
    await expect(login).rejects.toThrow("verification attempts exhausted");
    expect(callsBeforeRelease).toBe(5);
    expect(verifyCalls).toBe(5);

    const expired = await handleMirasimBrowserOAuthRequest(new Request(authUrl));
    expect(expired?.status).toBe(400);
    expect(await expired!.text()).toContain("invalid or has expired");
  });

  test("management browser verification waits for a reserved late success before exhausting the session", async () => {
    let verifyCalls = 0;
    let releaseFailures!: () => void;
    let releaseSuccess!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailures = resolve; });
    const successGate = new Promise<void>(resolve => { releaseSuccess = resolve; });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/auth/code") return new Response(null, { status: 200 });
      if (path === "/auth/verify") {
        verifyCalls += 1;
        const payload = JSON.parse(String(init?.body ?? "{}")) as { code?: string };
        if (payload.code === "300004") {
          await successGate;
          return Response.json({
            access_token: "late-success-access",
            refresh_token: "late-success-refresh",
            expires_in: 1800,
          });
        }
        await failureGate;
        return new Response(null, { status: 400 });
      }
      if (path === "/auth/me") {
        return Response.json({ email: "user@example.com" });
      }
      throw new Error(`unexpected Mirasim auth path: ${path}`);
    }) as typeof fetch;

    let authUrl = "";
    let loginSettled = false;
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    }).finally(() => { loginSettled = true; });
    await Promise.resolve();

    await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=send&email=user%40example.com",
    }));

    const attempts = Array.from({ length: 5 }, (_, index) =>
      handleMirasimBrowserOAuthRequest(new Request(authUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `action=verify&code=${300000 + index}`,
      })),
    );
    for (let spin = 0; spin < 1_000 && verifyCalls < attempts.length; spin += 1) {
      await Bun.sleep(1);
    }
    expect(verifyCalls).toBe(5);

    releaseFailures();
    const failed = await Promise.all(attempts.slice(0, 4));
    expect(failed.every(response => response?.status === 400)).toBe(true);
    await Promise.resolve();
    expect(loginSettled).toBe(false);

    releaseSuccess();
    expect((await attempts[4])?.status).toBe(200);
    const credential = await login;
    expect(credential.access).toBe("late-success-access");
    expect(credential.refresh).toBe("late-success-refresh");
  });

  test("management browser verification refuses a non-renewable auth response without exposing it", async () => {
    const calls: AuthCall[] = [];
    installEmailAuthServer(calls, { access_token: "short-lived-only" });
    let authUrl = "";
    const login = loginMirasim({
      onAuth: info => { authUrl = info.url; },
    }, {
      browserBaseUrl: "http://127.0.0.1:10100",
    });
    await Promise.resolve();

    await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=send&email=user%40example.com",
    }));
    const denied = await handleMirasimBrowserOAuthRequest(new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=verify&code=123456",
    }));
    expect(denied?.status).toBe(502);
    const html = await denied!.text();
    expect(html).not.toContain("short-lived-only");
    await expect(login).rejects.toThrow("no renewable credential");
  });

});
