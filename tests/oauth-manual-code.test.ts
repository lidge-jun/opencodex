import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { removeTreeWithRetry } from "./helpers/remove-tree";
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
import { findAvailablePort } from "../src/server/ports";
import type { OcxConfig } from "../src/types";
import { flushConfigDirHardeningForTests } from "../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";

// Per-test scratch home with both icacls runners stubbed: this file tests the manual-code
// login flow, not Windows ACLs. With a real icacls the credential persist failed on the hosted
// runner and the login settled as "OAuth authentication failed" (run 33603770447 shard 4).
let TEST_DIR = "";
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
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

  test("code#state in a raw paste keeps the state alongside the code", () => {
    // Supported since the branch was written, never asserted.
    expect(parseCallbackInput("raw-auth-code#xyz")).toEqual({ kind: "raw", code: "raw-auth-code", state: "xyz" });
  });

  test("a redirect URL carrying code/state in the FRAGMENT is read, not rejected", () => {
    // Defensive: no provider configured here returns a fragment response. A full
    // URL with hash parameters is nonetheless a valid URL with no query code,
    // and used to come back as "no authorization code found in input".
    expect(parseCallbackInput("http://127.0.0.1:56121/callback#code=abc&state=xyz")).toEqual({
      kind: "url", code: "abc", state: "xyz",
    });
  });

  test("the query wins when both query and fragment carry a code", () => {
    // The query is the authorization-code response location, so no paste that
    // works today changes meaning.
    expect(parseCallbackInput("http://127.0.0.1:56121/callback?code=q&state=qs#code=f&state=fs")).toEqual({
      kind: "url", code: "q", state: "qs",
    });
  });

  test("code and state are never mixed across the query and the fragment", () => {
    // `?state=<expected>#code=<other>` used to parse as one response assembled
    // from two collections: a state the user's own login supplied, paired with
    // a code from somewhere else. PKCE limits what that buys an attacker, but
    // pairing them at all defeats the check state exists to perform.
    //
    // The query wins as a WHOLE or not at all. Here it carries no code, so the
    // fragment is the response — and it brought no state, which
    // submitManualLoginCode then rejects.
    expect(parseCallbackInput("http://127.0.0.1:56121/callback?state=expected#code=other")).toEqual({
      kind: "url", code: "other", state: undefined,
    });
    // The mirror image: the query owns the response, so a fragment state is
    // never borrowed to complete it.
    expect(parseCallbackInput("http://127.0.0.1:56121/callback?code=q#state=borrowed")).toEqual({
      kind: "url", code: "q", state: undefined,
    });
  });

  test("a fragment code without state stays kind url, so state stays mandatory", () => {
    // kind must NOT degrade to raw: that is what would exempt it from the CSRF
    // check and turn a convenience into a hole.
    expect(parseCallbackInput("http://127.0.0.1:56121/callback#code=abc")).toEqual({
      kind: "url", code: "abc", state: undefined,
    });
  });

  test("a token fragment is not an authorization response", () => {
    // This repo does not implement the implicit grant, and a paste field must
    // not become the place it appears.
    expect(parseCallbackInput("http://127.0.0.1:56121/callback#access_token=t&token_type=bearer")).toEqual({
      kind: "url", code: undefined, state: undefined,
    });
  });
});

describe("OAuth manual login code fallback", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-oauth-manual-code-"));
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearLoginState("xai");
  });

  afterEach(async () => {
    cancelLoginFlow("xai");
    clearLoginState("xai");
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (TEST_DIR && existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    TEST_DIR = "";
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

  test("OAuth pending code rejects 4097 UTF-8 bytes in the owner", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("openid-configuration")) {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://auth.x.ai/authorize",
          token_endpoint: "https://auth.x.ai/oauth/token",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await startLoginFlow("xai", { forceLogin: true });
      expect(submitManualLoginCode("xai", `${"한".repeat(1365)}xx`)).toEqual({
        ok: false,
        error: "code too large",
      });
    } finally {
      globalThis.fetch = originalFetch;
      cancelLoginFlow("xai");
      clearLoginState("xai");
    }
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

      // A FRAGMENT-carried response gets the same CSRF treatment: reading the
      // fragment must not have opened a hole beside the query it copies.
      const fragmentMismatch = submitManualLoginCode("xai", `${redirectUri}#code=evil&state=WRONG`);
      expect(fragmentMismatch.ok).toBe(false);
      if (!fragmentMismatch.ok) expect(fragmentMismatch.error).toContain("state mismatch");

      const fragmentNoState = submitManualLoginCode("xai", `${redirectUri}#code=abc`);
      expect(fragmentNoState.ok).toBe(false);
      if (!fragmentNoState.ok) expect(fragmentNoState.error).toContain("missing the state");

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

  test("headless manual-code route is available through hub management ingress", async () => {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    const publicPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: managementPort });
    const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    process.env.OPENCODEX_API_AUTH_TOKEN = "hub-data-secret";
    saveConfig({
      port: 0,
      hostname: "0.0.0.0",
      runtimeRole: "hub",
      hub: {
        managementPublicOrigin: "https://hub.example.test",
        managementIngress: { enabled: true, port: managementPort },
      },
      oauthOpenBrowser: false,
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } },
    } as OcxConfig);
    const server = startServer(publicPort);
    try {
      const response = await fetch(`http://127.0.0.1:${managementPort}/api/oauth/login/code`, {
        method: "POST",
        headers: {
          Host: "hub.example.test",
          Origin: "https://hub.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "xai", input: "some-code" }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error?: string }).error).toContain("no login in progress");
    } finally {
      await server.stop(true);
      if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
    }
  });
});
