import { afterEach, describe, expect, test } from "bun:test";
import {
  buildGithubDeviceVerifyUrl,
  githubCopilotHttpError,
  isAllowedGithubDeviceVerifyUrl,
  loginGithubCopilot,
  refreshGithubCopilotToken,
  resolveCopilotApiBaseUrl,
  validateCopilotApiBaseUrl,
} from "../src/oauth/github-copilot";
import type { OAuthController } from "../src/oauth/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GH_ACCESS = "gho_fixture_access_DO_NOT_LEAK";
const GH_REFRESH = "ghr_fixture_refresh_DO_NOT_LEAK";
const COPILOT_TOKEN = "tid=fixture-copilot-token;DO_NOT_LEAK";

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

function expectNoSecretLeak(err: Error): void {
  const msg = err.message;
  expect(msg).not.toContain(GH_ACCESS);
  expect(msg).not.toContain(GH_REFRESH);
  expect(msg).not.toContain(COPILOT_TOKEN);
  expect(msg).not.toContain("device_code_secret");
}

describe("github-copilot URL allowlists", () => {
  test("buildGithubDeviceVerifyUrl constructs an allowlisted github.com URL", () => {
    const url = buildGithubDeviceVerifyUrl("ABCD-1234");
    expect(url).toBe("https://github.com/login/device?user_code=ABCD-1234");
    expect(isAllowedGithubDeviceVerifyUrl(url)).toBe(true);
  });

  test("rejects phishing or non-github verification URLs", () => {
    expect(isAllowedGithubDeviceVerifyUrl("https://evil.example/login/device?user_code=ABCD")).toBe(false);
    expect(isAllowedGithubDeviceVerifyUrl("http://github.com/login/device?user_code=ABCD")).toBe(false);
    expect(isAllowedGithubDeviceVerifyUrl("https://github.com.evil/login/device")).toBe(false);
    // Split userinfo so privacy-scan does not treat "pass@host" as an email literal.
    expect(isAllowedGithubDeviceVerifyUrl("https://user:pass@" + "github.com/login/device")).toBe(false);
    expect(isAllowedGithubDeviceVerifyUrl("https://github.com/login/oauth/authorize")).toBe(false);
  });

  test("validateCopilotApiBaseUrl allows only https *.githubcopilot.com", () => {
    expect(validateCopilotApiBaseUrl("https://api.githubcopilot.com")).toBe("https://api.githubcopilot.com");
    expect(validateCopilotApiBaseUrl("https://api.githubcopilot.com/v1")).toBe("https://api.githubcopilot.com");
    expect(validateCopilotApiBaseUrl("https://corp.githubcopilot.com")).toBe("https://corp.githubcopilot.com");
    expect(validateCopilotApiBaseUrl("http://api.githubcopilot.com")).toBeUndefined();
    expect(validateCopilotApiBaseUrl("https://127.0.0.1")).toBeUndefined();
    expect(validateCopilotApiBaseUrl("https://localhost")).toBeUndefined();
    expect(validateCopilotApiBaseUrl("https://evil.com")).toBeUndefined();
    expect(validateCopilotApiBaseUrl("https://api.githubcopilot.com.evil.com")).toBeUndefined();
    expect(validateCopilotApiBaseUrl("https://user:x@" + "api.githubcopilot.com")).toBeUndefined();
    expect(resolveCopilotApiBaseUrl("https://evil.com")).toBe("https://api.githubcopilot.com");
  });

  test("http errors never include response bodies", () => {
    const err = githubCopilotHttpError("token exchange", 401);
    expect(err.message).toBe("GitHub Copilot token exchange failed (401)");
    expectNoSecretLeak(err);
  });
});

describe("github-copilot login + refresh", () => {
  test("device flow exchanges for a Copilot token and stores allowlisted apiBaseUrl", async () => {
    let poll = 0;
    routeFetch((url) => {
      if (url.includes("/login/device/code")) {
        return new Response(JSON.stringify({
          user_code: "ABCD-1234",
          device_code: "device_code_secret",
          verification_uri: "https://evil.example/phish",
          verification_uri_complete: "https://evil.example/phish?user_code=ABCD-1234",
          expires_in: 900,
          interval: 1,
        }), { status: 200 });
      }
      if (url.includes("/login/oauth/access_token")) {
        poll += 1;
        if (poll === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: GH_ACCESS,
          refresh_token: GH_REFRESH,
          expires_in: 28800,
        }), { status: 200 });
      }
      if (url.includes("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({
          token: COPILOT_TOKEN,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://api.githubcopilot.com/v1" },
        }), { status: 200 });
      }
      if (url.includes("api.github.com/user")) {
        return new Response(JSON.stringify({ login: "octocat", id: 1 }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });

    const opened: string[] = [];
    const ctrl: OAuthController = {
      onAuth: ({ url }) => {
        opened.push(url);
      },
    };
    const cred = await loginGithubCopilot(ctrl);
    expect(opened).toEqual(["https://github.com/login/device?user_code=ABCD-1234"]);
    expect(cred.access).toBe(COPILOT_TOKEN);
    expect(cred.refresh).toBe(GH_REFRESH);
    expect(cred.apiBaseUrl).toBe("https://api.githubcopilot.com");
    expect(cred.accountId).toBe("1");
    expect(cred.email).toBeUndefined();
  });

  test("honors slow_down without failing the device flow", async () => {
    let poll = 0;
    routeFetch((url) => {
      if (url.includes("/login/device/code")) {
        return new Response(JSON.stringify({
          user_code: "ZZZZ-9999",
          device_code: "device_code_secret",
          expires_in: 900,
          interval: 1,
        }), { status: 200 });
      }
      if (url.includes("/login/oauth/access_token")) {
        poll += 1;
        if (poll === 1) return new Response(JSON.stringify({ error: "slow_down", interval: 1 }), { status: 200 });
        return new Response(JSON.stringify({
          access_token: GH_ACCESS,
          refresh_token: GH_REFRESH,
        }), { status: 200 });
      }
      if (url.includes("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({
          token: COPILOT_TOKEN,
          refresh_in: 1500,
        }), { status: 200 });
      }
      if (url.includes("api.github.com/user")) return new Response("{}", { status: 200 });
      return new Response("no", { status: 404 });
    });
    const cred = await loginGithubCopilot({});
    expect(poll).toBeGreaterThanOrEqual(2);
    expect(cred.access).toBe(COPILOT_TOKEN);
  });

  test("refresh re-exchanges without leaking tokens on failure", async () => {
    routeFetch((url) => {
      if (url.includes("/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: GH_ACCESS, refresh_token: GH_REFRESH }), { status: 200 });
      }
      if (url.includes("/copilot_internal/v2/token")) {
        return new Response(`unauthorized ${COPILOT_TOKEN}`, { status: 401 });
      }
      return new Response("no", { status: 404 });
    });
    let caught: Error | undefined;
    try {
      await refreshGithubCopilotToken(GH_REFRESH);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("GitHub Copilot token exchange failed (401)");
    expectNoSecretLeak(caught!);
  });

  test("login cancel aborts the poll loop", async () => {
    const ac = new AbortController();
    routeFetch((url) => {
      if (url.includes("/login/device/code")) {
        return new Response(JSON.stringify({
          user_code: "CANCEL-1",
          device_code: "device_code_secret",
          expires_in: 900,
          interval: 5,
        }), { status: 200 });
      }
      if (url.includes("/login/oauth/access_token")) {
        ac.abort();
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    await expect(loginGithubCopilot({ signal: ac.signal })).rejects.toThrow("Login cancelled");
  });

  test("rejects SSRF endpoints.api and falls back to default host", async () => {
    routeFetch((url) => {
      if (url.includes("/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: GH_ACCESS, refresh_token: GH_REFRESH }), { status: 200 });
      }
      if (url.includes("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({
          token: COPILOT_TOKEN,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://169.254.169.254/latest" },
        }), { status: 200 });
      }
      if (url.includes("api.github.com/user")) return new Response("{}", { status: 200 });
      return new Response("no", { status: 404 });
    });
    const cred = await refreshGithubCopilotToken(GH_REFRESH);
    expect(cred.apiBaseUrl).toBe("https://api.githubcopilot.com");
  });
});
