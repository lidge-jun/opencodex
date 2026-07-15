import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cancelLoginFlow,
  clearLoginState,
  getLoginStatus,
  startLoginFlow,
  submitManualLoginCode,
} from "../src/oauth";
import { parseCallbackInput } from "../src/oauth/callback-server";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-manual-code-test");
let previousOpencodexHome: string | undefined;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** JWT-shaped access token so identity parsing has something to chew on. */
function fakeAccessToken(): string {
  const header = b64url(JSON.stringify({ alg: "none" }));
  const payload = b64url(JSON.stringify({ sub: "user-1", email: "manual@example.com", exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${header}.${payload}.sig`;
}

describe("parseCallbackInput kinds", () => {
  test("redirect URL -> kind url with code/state", () => {
    expect(parseCallbackInput("http://127.0.0.1:56121/callback?code=abc&state=xyz")).toEqual({
      kind: "url", code: "abc", state: "xyz",
    });
  });

  test("redirect URL without state keeps kind url (state undefined)", () => {
    expect(parseCallbackInput("http://127.0.0.1:56121/callback?code=abc")).toEqual({
      kind: "url", code: "abc", state: undefined,
    });
  });

  test("query-string form -> kind query", () => {
    expect(parseCallbackInput("?code=abc&state=xyz")).toEqual({ kind: "query", code: "abc", state: "xyz" });
  });

  test("raw authorization code -> kind raw", () => {
    expect(parseCallbackInput("  raw-auth-code  ")).toEqual({ kind: "raw", code: "raw-auth-code", state: undefined });
  });
});

describe("OAuth manual login code fallback", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearLoginState("xai");
  });

  afterEach(() => {
    cancelLoginFlow("xai");
    clearLoginState("xai");
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("submitManualLoginCode rejects when no login is in progress", () => {
    expect(submitManualLoginCode("xai", "http://127.0.0.1/callback?code=a&state=b")).toEqual({
      ok: false,
      error: "no login in progress",
    });
  });

  test("submitManualLoginCode rejects empty input", () => {
    expect(submitManualLoginCode("xai", "   ")).toEqual({ ok: false, error: "empty code" });
  });

  test("manual paste completes the login using the ORIGINAL flow PKCE verifier", async () => {
    const originalFetch = globalThis.fetch;
    let tokenRequestBody: URLSearchParams | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.x.ai/authorize",
            token_endpoint: "https://auth.x.ai/oauth/token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("oauth/token")) {
        tokenRequestBody = new URLSearchParams(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({ access_token: fakeAccessToken(), refresh_token: "refresh-1", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const started = await Promise.race([
        startLoginFlow("xai", { forceLogin: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startLoginFlow timed out")), 10_000)),
      ]);
      expect(started.url).toContain("https://auth.x.ai/authorize");
      const authUrl = new URL(started.url);
      const state = authUrl.searchParams.get("state")!;
      const challenge = authUrl.searchParams.get("code_challenge")!;
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      expect(state).toBeTruthy();
      expect(challenge).toBeTruthy();

      // Wait until the flow registers its expected state with the manual-code slot:
      // a mismatched redirect URL must then be rejected SYNCHRONOUSLY.
      const deadline = Date.now() + 5_000;
      let mismatch = submitManualLoginCode("xai", `${redirectUri}?code=evil&state=WRONG`);
      while (mismatch.ok && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
        mismatch = submitManualLoginCode("xai", `${redirectUri}?code=evil&state=WRONG`);
      }
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.error).toContain("state mismatch");

      // URL-shaped input with NO state is rejected, not downgraded to a raw code.
      const missingState = submitManualLoginCode("xai", `${redirectUri}?code=abc`);
      expect(missingState.ok).toBe(false);
      if (!missingState.ok) expect(missingState.error).toContain("missing the state");

      // Correct paste: matching state completes the login via the original verifier.
      const goodSubmit = submitManualLoginCode("xai", `${redirectUri}?code=pasted-auth-code&state=${state}`);
      expect(goodSubmit).toEqual({ ok: true });

      // Background runLogin finishes: poll status until done.
      const statusDeadline = Date.now() + 10_000;
      while (!getLoginStatus("xai").done && Date.now() < statusDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      const status = getLoginStatus("xai");
      expect(status.done).toBe(true);
      expect(status.error).toBeUndefined();
      expect(status.loggedIn).toBe(true);

      // Token exchange used the pasted code + the ORIGINAL PKCE verifier + redirect URI.
      expect(tokenRequestBody).not.toBeNull();
      const body = tokenRequestBody!;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("pasted-auth-code");
      expect(body.get("redirect_uri")).toBe(redirectUri);
      const verifier = body.get("code_verifier")!;
      expect(verifier).toBeTruthy();
      expect(b64url(createHash("sha256").update(verifier).digest())).toBe(challenge);

      // Credential persisted under OPENCODEX_HOME.
      const authFile = join(TEST_DIR, "auth.json");
      expect(existsSync(authFile)).toBe(true);
      expect(readFileSync(authFile, "utf8")).toContain("refresh-1");
    } finally {
      globalThis.fetch = originalFetch;
      cancelLoginFlow("xai");
      clearLoginState("xai");
    }
  });

  test("raw code paste is accepted without state at submit time", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.x.ai/authorize",
            token_endpoint: "https://auth.x.ai/oauth/token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: fakeAccessToken(), refresh_token: "refresh-raw", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await startLoginFlow("xai", { forceLogin: true });
      const raw = submitManualLoginCode("xai", "manual-auth-code-only");
      expect(raw).toEqual({ ok: true });
      const statusDeadline = Date.now() + 10_000;
      while (!getLoginStatus("xai").done && Date.now() < statusDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(getLoginStatus("xai").loggedIn).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      cancelLoginFlow("xai");
      clearLoginState("xai");
    }
  });

  test("route POST /api/oauth/login/code: 400 unknown provider, 400 oversized, 409 no login", async () => {
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } },
    } as OcxConfig);
    const server = startServer(0);
    try {
      const post = (body: unknown) => fetch(new URL("/api/oauth/login/code", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const unknown = await post({ provider: "not-a-provider", input: "code" });
      expect(unknown.status).toBe(400);

      const oversized = await post({ provider: "xai", input: "x".repeat(5000) });
      expect(oversized.status).toBe(400);
      expect(((await oversized.json()) as { error?: string }).error).toContain("too long");

      const noLogin = await post({ provider: "xai", input: "some-code" });
      expect(noLogin.status).toBe(409);
      expect(((await noLogin.json()) as { error?: string }).error).toContain("no login in progress");
    } finally {
      await server.stop(true);
    }
  });
});
