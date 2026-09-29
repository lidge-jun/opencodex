import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  cancelLoginFlow,
  clearLoginState,
  getLoginStatus,
  startLoginFlow,
  supportsCodeLoginMode,
} from "../../src/oauth";
import { getAccountSet, removeCredential, resetOAuthReauthReconcileStateForTests } from "../../src/oauth/store";
import { loginState, resetOAuthFlowReconcileStateForTests } from "../../src/oauth/login-flow-state";
import { ANTHROPIC_CODE_REDIRECT_URI, AnthropicOAuthFlow } from "../../src/oauth/anthropic";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";

// Same scratch-home + icacls stubbing as tests/oauth/oauth-manual-code.test.ts: this file tests
// the code-display flow, not Windows ACLs, and a real icacls makes the credential persist fail.
let TEST_DIR = "";
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let previousOpencodexHome: string | undefined;

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function challengeOf(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

interface TokenRequest {
  code: string;
  state: string;
  redirect_uri: string;
  code_verifier: string;
  grant_type: string;
}

type TokenReply =
  | { kind: "ok"; uuid: string; email: string }
  | { kind: "error"; status: number; body: string };

/** Mock Anthropic's token endpoint; records every request body it is given. */
function installTokenMock(reply: (request: TokenRequest) => TokenReply): {
  requests: TokenRequest[];
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const requests: TokenRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith(TOKEN_URL)) return originalFetch(input, init);
    const request = JSON.parse(String(init?.body ?? "{}")) as TokenRequest;
    requests.push(request);
    const answer = reply(request);
    if (answer.kind === "error") {
      return new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify({
        access_token: `access-${answer.uuid}`,
        refresh_token: `refresh-${answer.uuid}`,
        expires_in: 3600,
        account: { uuid: answer.uuid, email_address: answer.email },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

const okReply = (uuid = "account-1", email = "one@example.com") => (): TokenReply => ({ kind: "ok", uuid, email });

function anthropicConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    oauthOpenBrowser: false,
    defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
  } as OcxConfig;
}

/** Start a code-mode login and return the authorize URL's parameters. */
async function startCodeLogin(): Promise<{ url: URL; state: string; challenge: string; expiresAt?: number }> {
  const started = await startLoginFlow("anthropic", { forceLogin: true, codeMode: true });
  const url = new URL(started.url);
  return {
    url,
    state: url.searchParams.get("state")!,
    challenge: url.searchParams.get("code_challenge")!,
    expiresAt: started.expiresAt,
  };
}

async function postCode(body: unknown, server: { url: string | URL }): Promise<Response> {
  return await fetch(new URL("/api/oauth/login/code", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("OAuth code-display login", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-oauth-code-login-"));
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearLoginState("anthropic");
    saveConfig(anthropicConfig());
  });

  afterEach(async () => {
    cancelLoginFlow("anthropic");
    clearLoginState("anthropic");
    // The credential store caches per provider in module state, which outlives this file's
    // scratch home — leave no anthropic account behind for the next test file.
    await removeCredential("anthropic");
    // Completing a login through the management route runs a real state-store reconciliation,
    // which leaves a generation high-water mark in module state. Left behind, it outranks the
    // next file's counter and silently disables its needsReauth writes.
    resetOAuthReauthReconcileStateForTests();
    resetOAuthFlowReconcileStateForTests();
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (TEST_DIR && existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    TEST_DIR = "";
  });

  // Spec test 1.
  test("code mode advertises the platform code redirect and mentions no localhost anywhere", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/oauth/login", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", mode: "code", addAccount: true, openBrowser: false }),
      });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as { url: string; mode: string; flowId: string; expiresAt: number };
      const authUrl = new URL(body.url);
      expect(authUrl.origin + authUrl.pathname).toBe("https://claude.ai/oauth/authorize");
      expect(authUrl.searchParams.get("redirect_uri")).toBe(ANTHROPIC_CODE_REDIRECT_URI);
      expect(authUrl.searchParams.get("code")).toBe("true");
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authUrl.searchParams.get("state")).toBeTruthy();
      expect(body.mode).toBe("code");
      expect(body.flowId).toBeTruthy();
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      // Not "the redirect is right" but "no localhost leaked into the response at all",
      // including any instructions text.
      expect(raw.toLowerCase()).not.toContain("localhost");
      expect(raw).not.toContain("127.0.0.1");
      expect(raw).not.toContain("54545");
    } finally {
      await server.stop(true);
    }
  });

  // Spec test 2. Bun.serve is the ONLY way this process can open a listener, so counting its
  // calls across the whole login is the property itself, not a proxy for it.
  test("code mode opens no listening socket, while the default mode does", async () => {
    const serve = spyOn(Bun, "serve");
    try {
      await startCodeLogin();
      expect(serve.mock.calls.length).toBe(0);
      // The port the callback flow would have taken is still free, from outside the process.
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 54545, reusePort: false, fetch: () => new Response("") });
      probe.stop(true);
      cancelLoginFlow("anthropic");
      clearLoginState("anthropic");

      // Contrast: the default flow DOES bind, so the assertion above is not vacuous.
      serve.mockClear();
      const callback = await startLoginFlow("anthropic", { forceLogin: true });
      expect(serve.mock.calls.length).toBeGreaterThan(0);
      expect(new URL(callback.url).searchParams.get("redirect_uri")).toBe("http://localhost:54545/callback");
    } finally {
      serve.mockRestore();
      cancelLoginFlow("anthropic");
      clearLoginState("anthropic");
    }
  });

  // Spec test 3.
  test("a code#state paste exchanges with the platform redirect and this flow's verifier", async () => {
    const mock = installTokenMock(okReply());
    const server = startServer(0);
    try {
      const { state, challenge, expiresAt } = await startCodeLogin();
      const flowId = getLoginStatus("anthropic").flowId;
      expect(getLoginStatus("anthropic").status).toBe("pending");
      expect(expiresAt).toBeGreaterThan(Date.now());

      const response = await postCode({ provider: "anthropic", flowId, input: `displayed-code#${state}` }, server);
      expect(response.status).toBe(200);
      // The email follows the operator's privacy.maskEmails policy, masked by default, exactly
      // as /api/oauth/status reports it — this route must not become the unmasked way to read it.
      expect(await response.json()).toEqual({
        ok: true,
        account: { id: getAccountSet("anthropic")!.activeAccountId, email: "o***e@example.com" },
      });

      expect(mock.requests).toHaveLength(1);
      const exchanged = mock.requests[0]!;
      expect(exchanged.grant_type).toBe("authorization_code");
      expect(exchanged.code).toBe("displayed-code");
      expect(exchanged.state).toBe(state);
      expect(exchanged.redirect_uri).toBe(ANTHROPIC_CODE_REDIRECT_URI);
      expect(challengeOf(exchanged.code_verifier)).toBe(challenge);

      const status = getLoginStatus("anthropic");
      expect(status.status).toBe("complete");
      expect(status.loggedIn).toBe(true);
      expect(status.email).toBe("o***e@example.com");
      expect(status.errorCode).toBeUndefined();
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  // Spec test 4.
  test("a mismatched state is refused without ever calling the token endpoint", async () => {
    const mock = installTokenMock(okReply());
    const server = startServer(0);
    try {
      const { state } = await startCodeLogin();
      const flowId = getLoginStatus("anthropic").flowId;
      const response = await postCode({ provider: "anthropic", flowId, input: "stolen-code#NOT-THE-STATE" }, server);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "state_mismatch" });
      expect(mock.requests).toHaveLength(0);
      // The flow survives a bad paste, so the correct one still completes it.
      expect(getLoginStatus("anthropic").status).toBe("pending");
      const good = await postCode({ provider: "anthropic", flowId, input: `real-code#${state}` }, server);
      expect(good.status).toBe(200);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]!.code).toBe("real-code");
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  // Spec test 5.
  test("invalid_grant from the token endpoint answers invalid_or_expired_code", async () => {
    const mock = installTokenMock(() => ({
      kind: "error",
      status: 400,
      body: JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
    }));
    const server = startServer(0);
    try {
      const { state } = await startCodeLogin();
      const flowId = getLoginStatus("anthropic").flowId;
      const response = await postCode({ provider: "anthropic", flowId, input: `stale-code#${state}` }, server);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "invalid_or_expired_code" });
      expect(getLoginStatus("anthropic").status).toBe("error");
      expect(getLoginStatus("anthropic").errorCode).toBe("invalid_or_expired_code");
      expect(getLoginStatus("anthropic").loggedIn).toBe(false);
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  test("a 5xx from the token endpoint answers provider_unreachable", async () => {
    const mock = installTokenMock(() => ({ kind: "error", status: 503, body: "upstream down" }));
    const server = startServer(0);
    try {
      const { state } = await startCodeLogin();
      const flowId = getLoginStatus("anthropic").flowId;
      const response = await postCode({ provider: "anthropic", flowId, input: `code#${state}` }, server);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "provider_unreachable" });
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  // Spec test 6. Two flows run at once, each pasting its OWN code, and neither exchange may
  // carry the other's verifier. Driven at the flow object because the management API keys an
  // in-flight login by provider and refuses a second concurrent anthropic login outright —
  // which this also asserts, since that guard is what the API relies on.
  test("two concurrent code flows each exchange with their own verifier", async () => {
    const mock = installTokenMock(request => ({
      kind: "ok",
      uuid: `account-${request.code}`,
      email: `${request.code}@example.com`,
    }));
    try {
      const pastes = new Map<string, (value: string) => void>();
      const makeFlow = (label: string) => {
        let captured: { url: string } | undefined;
        const ready = Promise.withResolvers<string>();
        const flow = new AnthropicOAuthFlow({
          onAuth: info => { captured = info; ready.resolve(info.url); },
          onManualCodeInput: () => new Promise<string>(resolve => { pastes.set(label, resolve); }),
        }, { codeMode: true });
        return { flow, ready: ready.promise, url: () => captured!.url };
      };

      const first = makeFlow("first");
      const second = makeFlow("second");
      const firstLogin = first.flow.login();
      const secondLogin = second.flow.login();
      const firstUrl = new URL(await first.ready);
      const secondUrl = new URL(await second.ready);
      const firstChallenge = firstUrl.searchParams.get("code_challenge")!;
      const secondChallenge = secondUrl.searchParams.get("code_challenge")!;
      expect(firstChallenge).not.toBe(secondChallenge);

      // Paste out of order: the SECOND flow completes first, so a shared verifier would be
      // the one this paste finds.
      pastes.get("second")!(`code-second#${secondUrl.searchParams.get("state")}`);
      const secondCred = await secondLogin;
      pastes.get("first")!(`code-first#${firstUrl.searchParams.get("state")}`);
      const firstCred = await firstLogin;

      expect(secondCred.email).toBe("code-second@example.com");
      expect(firstCred.email).toBe("code-first@example.com");
      const byCode = new Map(mock.requests.map(request => [request.code, request]));
      expect(challengeOf(byCode.get("code-first")!.code_verifier)).toBe(firstChallenge);
      expect(challengeOf(byCode.get("code-second")!.code_verifier)).toBe(secondChallenge);
      expect(byCode.get("code-first")!.code_verifier).not.toBe(byCode.get("code-second")!.code_verifier);

      // The other half of the guarantee at the API level: a second concurrent login for the
      // same provider is refused rather than allowed to share the first flow's slot.
      await startCodeLogin();
      await expect(startLoginFlow("anthropic", { forceLogin: true, codeMode: true }))
        .rejects.toThrow("already in progress");
    } finally {
      mock.restore();
      cancelLoginFlow("anthropic");
      clearLoginState("anthropic");
    }
  });

  // Spec test 7.
  test("re-login refreshes one account in place; a different account is appended", async () => {
    const server = startServer(0);
    const accounts = ["account-1", "account-1", "account-2"];
    const mock = installTokenMock(() => {
      const uuid = accounts.shift() ?? "account-2";
      return { kind: "ok", uuid, email: `${uuid}@example.com` };
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clearLoginState("anthropic");
        const { state } = await startCodeLogin();
        const flowId = getLoginStatus("anthropic").flowId;
        const response = await postCode({ provider: "anthropic", flowId, input: `code-${attempt}#${state}` }, server);
        expect(response.status).toBe(200);
        // 1 after the first login, still 1 after the SAME account logs in again, 2 after a
        // different one.
        expect(getAccountSet("anthropic")!.accounts).toHaveLength(attempt === 2 ? 2 : 1);
      }
      const emails = getAccountSet("anthropic")!.accounts.map(account => account.credential.email).sort();
      expect(emails).toEqual(["account-1@example.com", "account-2@example.com"]);
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  // Spec test 8.
  test("omitting mode keeps the callback response shape and the localhost redirect", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/oauth/login", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", addAccount: true, openBrowser: false }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(new URL(String(body.url)).searchParams.get("redirect_uri")).toBe("http://localhost:54545/callback");
      // The code-mode fields are absent, not null: an old caller sees exactly today's keys.
      expect(body).not.toHaveProperty("mode");
      expect(body).not.toHaveProperty("flowId");
      expect(body).not.toHaveProperty("expiresAt");
      expect(getLoginStatus("anthropic").mode).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  // Spec test 9.
  test("code mode on a provider with no code redirect is refused, not downgraded", async () => {
    expect(supportsCodeLoginMode("anthropic")).toBe(true);
    expect(supportsCodeLoginMode("xai")).toBe(false);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/oauth/login", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "xai", mode: "code", openBrowser: false }),
      });
      expect(response.status).toBe(400);
      const raw = await response.text();
      expect(JSON.parse(raw)).toEqual({ error: "code_mode_unsupported" });
      expect(raw).not.toContain("127.0.0.1");
      expect(raw.toLowerCase()).not.toContain("localhost");
      expect(getLoginStatus("xai").status).toBe("idle");
    } finally {
      await server.stop(true);
      clearLoginState("xai");
    }
  });

  test("an unknown mode is rejected before any flow starts", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/oauth/login", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", mode: "device", openBrowser: false }),
      });
      expect(response.status).toBe(400);
      expect(getLoginStatus("anthropic").status).toBe("idle");
    } finally {
      await server.stop(true);
    }
  });

  test("a paste with nothing code-like in it answers malformed_input", async () => {
    const mock = installTokenMock(okReply());
    const server = startServer(0);
    try {
      await startCodeLogin();
      const flowId = getLoginStatus("anthropic").flowId;
      const empty = await postCode({ provider: "anthropic", flowId, input: "   " }, server);
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ ok: false, error: "malformed_input" });

      const oversized = await postCode({ provider: "anthropic", flowId, input: "x".repeat(5000) }, server);
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toEqual({ ok: false, error: "malformed_input" });
      expect(mock.requests).toHaveLength(0);
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  test("a paste for a finished or expired flow answers no_pending_login", async () => {
    const mock = installTokenMock(okReply());
    const server = startServer(0);
    try {
      // Unknown flow id against a live flow.
      await startCodeLogin();
      const flowId = getLoginStatus("anthropic").flowId!;
      const wrongFlow = await postCode({ provider: "anthropic", flowId: "not-this-flow", input: "code" }, server);
      expect(wrongFlow.status).toBe(409);
      expect(await wrongFlow.json()).toEqual({ ok: false, error: "no_pending_login" });

      // Past its TTL: the flow object is still live, the paste window is not.
      loginState.get("anthropic")!.expiresAt = Date.now() - 1;
      const expired = await postCode({ provider: "anthropic", flowId, input: "code" }, server);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toEqual({ ok: false, error: "no_pending_login" });
      expect(mock.requests).toHaveLength(0);
    } finally {
      await server.stop(true);
      mock.restore();
    }
  });

  // The spec's CLI half: `ocx login anthropic --code`.
  test("ocx login --code runs the code flow, launches nothing, and reads the code back", async () => {
    const { handleLogin, listCodeLoginProviders } = await import("../../src/oauth/login-cli");
    expect(listCodeLoginProviders()).toEqual(["anthropic"]);

    const launched: string[] = [];
    const asked: string[] = [];
    let seenOpts: { codeMode?: boolean } | undefined;
    let printed = "";
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed += `${args.join(" ")}\n`;
    });
    try {
      await handleLogin("anthropic", {
        openUrl: async (target: string) => { launched.push(target); return { kind: "opened" as const }; },
        ask: async (question: string) => { asked.push(question); return "pasted-code#state"; },
        runLogin: async (_provider, ctrl, opts) => {
          seenOpts = opts;
          ctrl.onAuth?.({ url: "https://claude.ai/oauth/authorize?code=true" });
          expect(await ctrl.onManualCodeInput?.()).toBe("pasted-code#state");
          return { refresh: "r", access: "a", expires: Date.now() + 3600_000, email: "cli@example.com" };
        },
      }, { codeMode: true });
    } finally {
      logSpy.mockRestore();
    }

    expect(seenOpts?.codeMode).toBe(true);
    // The point of --code is that there is no browser here to open.
    expect(launched).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Paste the code");
    expect(printed).toContain("https://claude.ai/oauth/authorize");
    expect(printed).toContain("Logged in to anthropic");
  });

  test("the callback flow's paste route keeps its original accept-only contract", async () => {
    const server = startServer(0);
    try {
      // No flowId and no code-mode flow: the legacy shape, error string and 409 are unchanged.
      const response = await postCode({ provider: "anthropic", input: "some-code" }, server);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "no login in progress" });
    } finally {
      await server.stop(true);
    }
  });
});
