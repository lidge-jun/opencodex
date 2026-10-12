import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth, clearMainAccountInfoCache, listCodexAuthAccounts } from "../../src/codex/auth-api";
import { CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE } from "../../src/server/responses/codex-auth-error";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { codexAccountUnusableReason } from "../../src/codex/account-usability";
import { getValidMainAccountToken, isMainAccountRefreshGrantRejected, MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { withNativeMainSharedClaim } from "../../src/codex/native-main-claim";
import type { NativeProfileContext } from "../../src/codex/native-profile-store";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { resolveResponsesApiAuth } from "../../src/server/auth-cors";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import { clearComboSelectionState } from "../../src/combos/resolve";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { captureCallerDirectAuth } from "../../src/providers/caller-authorization";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** Smallest complete Anthropic stream: the combo's second target has to actually answer. */
const ANTHROPIC_SSE = [
  ["message_start", { type: "message_start", message: { id: "msg_fallback", type: "message", role: "assistant", model: "m2", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "served" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const originalFetch = globalThis.fetch;
let home = "";
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
const OTHER_ACCOUNT_ID = "other";

function config(options: { secondAccount?: boolean } = {}): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: options.secondAccount ? [{ id: OTHER_ACCOUNT_ID, label: "other" }] : [],
    ...(options.secondAccount ? { accountPoolStrategy: "fill-first" } : {}),
  } as OcxConfig;
}

function request(path: "/v1/responses" | "/v1/responses/compact", signal?: AbortSignal): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(path.endsWith("compact")
      ? { model: "gpt-5.5", input: [] }
      : { model: "gpt-5.5", input: "hello", stream: false }),
    signal,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-responses-main-refresh-"));
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  // Take the writer lease after this case installs its home so direct handler dispatch can open the spend journal.
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearComboTargetCooldowns();
  clearComboSelectionState();
  clearMainAccountInfoCache();
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: {
      access_token: "rejected-access",
      refresh_token: "refresh-grant",
      account_id: "account-main",
    },
  }));
});

afterEach(() => {
  // Release before restoring or removing the home to prevent Windows removal failures and POSIX unlinked databases.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearComboTargetCooldowns();
  clearComboSelectionState();
  clearMainAccountInfoCache();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function install401ThenRefreshHarness(): { sends: string[]; refreshes: string[] } {
  const sends: string[] = [];
  const refreshes: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "auth.openai.com") {
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshes.push(refresh);
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }
    if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/responses/compact")) {
      return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    sends.push(authorization);
    if (sends.length === 1) {
      return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
    }
    return Response.json({ id: "resp_refreshed", object: "response", status: "completed", output: [] });
  }) as typeof fetch;
  return { sends, refreshes };
}

describe("native main 401 refresh and replay", () => {
  test.each(["/v1/responses", "/v1/responses/compact"] as const)(
    "%s strips caller account identity when a bearer key selects stored Direct",
    async path => {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
      const storedCredential = `header.${payload}.signature`;
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        tokens: { access_token: storedCredential },
      }));
      const cfg = config();
      cfg.hostname = "0.0.0.0";
      cfg.providers.openai!.codexAccountMode = "direct";
      cfg.apiKeys = [{
        id: "direct-test", name: "direct-test", key: "ocx_data_direct_ingress",
        createdAt: "2026-09-14T00:00:00.000Z",
      }];
      const req = request(path);
      req.headers.set("authorization", "Bearer ocx_data_direct_ingress");
      req.headers.set("chatgpt-account-id", "caller-account");
      const admission = resolveResponsesApiAuth(req, cfg);
      expect(admission?.source).toBe("bearer");
      const sent: Headers[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/responses") || url.pathname.endsWith("/responses/compact")) {
          sent.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
          return Response.json({ id: "resp_direct", object: "response", status: "completed", output: [] });
        }
        return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
      }) as typeof fetch;

      const turn = tryAdmitTurn();
      expect(turn).not.toBeNull();
      try {
        const log = { model: "", provider: "" } as RequestLogContext;
        const response = path === "/v1/responses"
          ? await handleResponses(req, cfg, log, { admission: admission!, turnAdmissionLease: turn! })
          : await handleResponsesCompact(req, cfg, log, turn!, admission!);
        expect(response.status).toBe(200);
        await response.text();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.get("authorization")).toBe(`Bearer ${storedCredential}`);
        expect(sent[0]!.get("chatgpt-account-id")).toBeNull();
      } finally {
        turn?.release();
      }
    },
  );

  test.each([false, true])("caller Direct 401 stays caller-owned when injected token bytes match=%s", async sameBytes => {
    const caller = fakeChatGptJwt("caller-account");
    const stored = sameBytes ? caller : fakeChatGptJwt("stored-account");
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { access_token: stored, refresh_token: "stored-grant", account_id: sameBytes ? "caller-account" : "stored-account" },
    }));
    const cfg = config();
    const callerDirectAuth = captureCallerDirectAuth(new Headers({ authorization: `Bearer ${caller}` }), cfg);
    expect(callerDirectAuth).not.toBeNull();
    const sends: Headers[] = [];
    const refreshes: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "auth.openai.com") {
        refreshes.push(url.pathname);
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (!url.pathname.endsWith("/responses")) throw new Error("unexpected mocked endpoint");
      sends.push(new Headers(init?.headers));
      return Response.json({ error: { code: "token_invalidated", message: "caller credential refused" } }, { status: 401 });
    }) as typeof fetch;
    const turn = tryAdmitTurn();
    expect(turn).not.toBeNull();
    const originalRead = fs.readFileSync as (...args: unknown[]) => unknown;
    let authReads = 0;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].endsWith("auth.json")) authReads += 1;
      return originalRead(...args);
    }) as typeof fs.readFileSync);
    try {
      // Calibrate the read observation before dispatch, then require zero native reads.
      readFileSync(join(home, "auth.json"));
      expect(authReads).toBe(1);
      authReads = 0;
      const response = await handleResponses(request("/v1/responses"), cfg,
        { model: "", provider: "" } as RequestLogContext, {
          turnAdmissionLease: turn!, callerDirectAuth,
          stripClaudeMainAuthForNoncanonicalForward: true,
          trustedClaudeMainAuth: { authorization: `Bearer ${stored}`, chatgptAccountId: sameBytes ? "caller-account" : "stored-account" },
        });
      expect(response.status).toBe(401);
      await response.text();
      expect(sends).toHaveLength(1);
      expect(sends[0]!.get("authorization")).toBe(`Bearer ${caller}`);
      expect(sends[0]!.get("chatgpt-account-id")).toBe("caller-account");
      expect(authReads).toBe(0);
      expect(refreshes).toEqual([]);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    } finally {
      readSpy.mockRestore();
      turn?.release();
    }
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
  });

  test("refreshes a refresh-only native main credential before upstream I/O", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
    }));
    const sends: string[] = [];
    let refreshes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "auth.openai.com") {
        refreshes += 1;
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      if (url.pathname.endsWith("/responses")) {
        sends.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      return Response.json({ id: "resp_refreshed", object: "response", status: "completed", output: [] });
    }) as typeof fetch;

    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(refreshes).toBe(1);
    expect(sends).toEqual(["Bearer refreshed-access"]);
  });

  test("converts an outer native-main claim timeout into a transient refresh failure", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
    }));
    let releaseHolder!: () => void;
    const holderRelease = new Promise<void>(resolve => { releaseHolder = resolve; });
    let holderEntered!: () => void;
    const holderReady = new Promise<void>(resolve => { holderEntered = resolve; });
    const holder = withNativeMainSharedClaim(
      { codexHome: home } as NativeProfileContext,
      async () => {
        holderEntered();
        await holderRelease;
      },
      { hardenPath: async () => {} },
    );
    await holderReady;

    const timeout = new AbortController();
    const addListener = spyOn(timeout.signal, "addEventListener");
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const pending = getValidMainAccountToken();
      // Yield to the macrotask queue, not only microtasks: on Windows the exclusive claim
      // hardens its lock file through an icacls/PowerShell subprocess before it ever reaches
      // the abort listener, and a microtask spin never lets that child's exit callback run.
      // Dispatch 33597649234 shard 4 sat here for 8 minutes until the job ceiling.
      while (!addListener.mock.calls.some(([type]) => type === "abort")) await Bun.sleep(1);
      timeout.abort(new DOMException("claim timed out", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({
        name: "MainAccountTokenRefreshError",
        reason: "transient",
      });
    } finally {
      timeoutSpy.mockRestore();
      releaseHolder();
      await holder;
    }
  });

  test("Responses refreshes and performs exactly one physical replay", async () => {
    const harness = install401ThenRefreshHarness();
    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.refresh_token)
      .toBe("rotated-refresh");
  });

  test("compact refreshes and performs exactly one physical replay", async () => {
    const harness = install401ThenRefreshHarness();
    const response = await handleResponsesCompact(
      request("/v1/responses/compact"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  for (const path of ["/v1/responses", "/v1/responses/compact"] as const) {
    test(`${path} keeps main-pool recovery eligible for a later Pool account`, async () => {
      saveCodexAccountCredential(OTHER_ACCOUNT_ID, {
        accessToken: "other-access",
        refreshToken: "other-refresh",
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: "account-other",
      });
      const sends: string[] = [];
      const refreshes: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "auth.openai.com") {
          refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
          return Response.json({
            access_token: "refreshed-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          });
        }
        if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/responses/compact")) {
          return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
        }
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        sends.push(authorization);
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          return Response.json({ error: { message: "main quota exhausted" } }, { status: 429 });
        }
        if (authorization === "Bearer other-access") {
          return Response.json({ id: "resp_other", object: "response", status: "completed", output: [] });
        }
        return Response.json({ error: { message: "unexpected bearer" } }, { status: 500 });
      }) as typeof fetch;

      const cfg = config({ secondAccount: true });
      const response = path.endsWith("compact")
        ? await handleResponsesCompact(request(path), cfg, { model: "", provider: "" } as RequestLogContext)
        : await handleResponses(request(path), cfg, { model: "", provider: "" } as RequestLogContext);

      expect(response.status).toBe(200);
      expect(sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access", "Bearer other-access"]);
      expect(refreshes).toEqual(["refresh-grant"]);
    });
  }

  /**
   * The revoked-session harness: the access-token JWT still looks live, every send earns
   * `token_invalidated`, and only the forced refresh can prove the credential is dead. The
   * token endpoint's answer to that refresh is the variable.
   */
  function installRevokedSessionHarness(refusal: { status: number; body: unknown }): {
    sends: string[];
    refreshes: string[];
  } {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: {
        access_token: `header.${payload}.signature`,
        refresh_token: "refresh-grant",
        account_id: "account-main",
      },
    }));
    const sends: string[] = [];
    const refreshes: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "auth.openai.com") {
        refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return Response.json(refusal.body, { status: refusal.status });
      }
      if (!url.pathname.endsWith("/responses")) {
        return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
      }
      sends.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({
        error: {
          message: "private-upstream-body-marker: token invalidated",
          type: "invalid_request_error",
          code: "token_invalidated",
        },
      }, { status: 401 });
    }) as typeof fetch;
    return { sends, refreshes };
  }

  // Production only ever confirmed bare 400 `invalid_grant`. These are the siblings upstream
  // also emits for a revoked or downgraded session; each must retire the grant, not just the
  // one code the incident happened to produce.
  test.each([
    [400, "invalid_grant"],
    [401, "refresh_token_invalidated"],
    [401, "token_invalidated"],
    [401, "refresh_token_expired"],
    [401, "refresh_token_reused"],
  ] as const)(
    "retires native main on %i %s so the next request never sends",
    async (status, code) => {
      const { sends, refreshes } = installRevokedSessionHarness({ status, body: { error: code } });
      const refreshLines: string[] = [];
      const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        refreshLines.push(args.map(String).join(" "));
      });

      let first: Response;
      try {
        first = await handleResponses(
          request("/v1/responses"),
          config(),
          { model: "", provider: "" } as RequestLogContext,
        );
      } finally {
        warnSpy.mockRestore();
      }
      expect(first.status).toBe(401);
      expect(JSON.parse(await first.text()).error.message).toBe(CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE);
      // The verdict is on the record, with the endpoint's own status and code and nothing else.
      // A revoked session is otherwise invisible: no write, and a status like any other 401.
      expect(refreshLines).toContain(`[codex] native main refresh: reauth status=${status} code=${code}`);
      expect(sends).toHaveLength(1);
      expect(refreshes).toEqual(["refresh-grant"]);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      expect(isMainAccountRefreshGrantRejected()).toBe(true);
      expect(codexAccountUnusableReason(config(), MAIN_CODEX_ACCOUNT_ID)).toBe("needs_reauth");

      const second = await handleResponses(
        request("/v1/responses"),
        config(),
        { model: "", provider: "" } as RequestLogContext,
      );
      // The point of the quarantine: the second request is refused locally, so a combo's next
      // target is reached without paying another upstream round trip on a dead credential -- and
      // it says the same actionable thing the discovering request said, not "no usable credential".
      expect(second.status).toBe(401);
      expect(JSON.parse(await second.text()).error.message).toBe(CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE);
      expect(sends).toHaveLength(1);
      expect(refreshes).toEqual(["refresh-grant"]);
    },
  );

  test("keeps a 5xx whose description reads terminal transient and leaves the grant alive", async () => {
    // The other half of the classification, and the reason it reads the structured code rather
    // than the formatted message: upstream puts arbitrary prose in `error_description`, so a
    // token-endpoint 5xx that happens to say "session expired" must stay a retryable refusal.
    // Quarantining on it would retire a live grant and demand a sign-in nobody needs.
    const { sends, refreshes } = installRevokedSessionHarness({
      status: 503,
      body: { error: "server_error", error_description: "session expired or revoked; retry" },
    });

    const transientLines: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      transientLines.push(args.map(String).join(" "));
    });
    let response: Response;
    try {
      response = await handleResponses(
        request("/v1/responses"),
        config(),
        { model: "", provider: "" } as RequestLogContext,
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(transientLines).toContain("[codex] native main refresh: transient status=503 code=server_error");
    expect(response.status).toBe(503);
    expect(sends).toHaveLength(1);
    expect(refreshes).toEqual(["refresh-grant"]);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test.each(["/v1/responses", "/v1/responses/compact"] as const)(
    "%s keeps the WebSocket string-abort claim cancellation as 499 without quarantining main",
    async path => {
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
      }));
      let releaseHolder!: () => void;
      const holderRelease = new Promise<void>(resolve => { releaseHolder = resolve; });
      let holderEntered!: () => void;
      const holderReady = new Promise<void>(resolve => { holderEntered = resolve; });
      const holder = withNativeMainSharedClaim(
        { codexHome: home } as NativeProfileContext,
        async () => {
          holderEntered();
          await holderRelease;
        },
        { hardenPath: async () => {} },
      );
      await holderReady;

      const controller = new AbortController();
      const originalAny = AbortSignal.any;
      let claimWaitListener: ReturnType<typeof spyOn> | undefined;
      const anySpy = spyOn(AbortSignal, "any").mockImplementation(signals => {
        const combined = originalAny.call(AbortSignal, signals);
        claimWaitListener = spyOn(combined, "addEventListener");
        return combined;
      });
      try {
        const pending = path === "/v1/responses"
          ? handleResponses(
            request(path, controller.signal),
            config(),
            { model: "", provider: "" } as RequestLogContext,
            { abortSignal: controller.signal, inboundTransport: "websocket" },
          )
          : handleResponsesCompact(
            request(path, controller.signal),
            config(),
            { model: "", provider: "" } as RequestLogContext,
          );
        while (!claimWaitListener?.mock.calls.some(([type]) => type === "abort")) await Bun.sleep(1);
        controller.abort("websocket turn superseded or closed");

        const response = await pending;
        expect(response.status).toBe(499);
        expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      } finally {
        anySpy.mockRestore();
        releaseHolder();
        await holder;
      }
    },
  );

  /**
   * The shape that actually runs in production: Claude Code POSTs /v1/messages with
   * `model: combo/codexfirst`, whose first leg is the openai pool-main provider. The inbound
   * wire is claude-messages, so that leg is TRANSLATED rather than passed through -- it
   * dispatches through `prepareAdapterExchange`, not the passthrough route, and that dispatch
   * recorded no Codex account outcome and attempted no refresh on a pre-stream 401. The
   * revoked session was therefore rediscovered by a fresh upstream 401 on every request.
   */
  test("a /v1/messages combo leg retires the dead grant instead of re-earning its 401", async () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: {
        access_token: `header.${payload}.signature`,
        refresh_token: "refresh-grant",
        account_id: "account-main",
      },
    }));
    const codexSends: string[] = [];
    const refreshes: string[] = [];
    let fallbackSends = 0;
    let whamSends = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "auth.openai.com") {
        refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return Response.json({ error: "token_invalidated" }, { status: 401 });
      }
      if (url.hostname === "fallback.test") {
        fallbackSends += 1;
        return new Response(ANTHROPIC_SSE, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/wham/usage")) {
        whamSends += 1;
        return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } });
      }
      if (url.hostname !== "chatgpt.com" || !url.pathname.endsWith("/responses")) {
        throw new Error("unexpected mocked endpoint");
      }
      codexSends.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({
        error: {
          message: "private-upstream-body-marker: token invalidated",
          type: "invalid_request_error",
          code: "token_invalidated",
        },
      }, { status: 401 });
    }) as typeof fetch;

    const comboConfig = {
      ...config(),
      providers: {
        ...config().providers,
        fallback: {
          adapter: "anthropic",
          baseUrl: "https://fallback.test",
          apiKey: "k",
        },
      },
      combos: {
        codexfirst: {
          strategy: "failover",
          targets: [
            { provider: "openai", model: "gpt-5.5" },
            { provider: "fallback", model: "m2" },
          ],
        },
      },
    } as unknown as OcxConfig;
    const messagesRequest = (): Request => new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/codexfirst",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    // The stored-main enrichment in handleClaudeMessages is gated on a claimed native-main
    // profile for the turn, which needs a real admission lease. Without one the enrichment never
    // fires and the leg resolves to `main-pool` -- which is exactly why every earlier attempt to
    // reproduce the Mini from a leaseless harness came out already fixed.
    // A fresh turn lease per request: reading a response to completion releases its lease, and a
    // reused inactive lease would refuse the main-profile claim before refresh or send, letting the
    // send-count assertions below pass without exercising the quarantine at all.
    const turns: NonNullable<ReturnType<typeof tryAdmitTurn>>[] = [];
    const freshTurn = () => {
      const turn = tryAdmitTurn();
      expect(turn).not.toBeNull();
      turns.push(turn!);
      return turn!;
    };
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      let first: Response;
      try {
        first = await handleClaudeMessages(
          messagesRequest(),
          comboConfig,
          { model: "", provider: "" } as RequestLogContext,
          { requestId: `combo-401-${crypto.randomUUID()}`, start: Date.now(), turnAdmissionLease: freshTurn() },
        );
        await first.text();
      } finally {
        warnSpy.mockRestore();
      }
      // One failure is one line, and it names the refusal rather than reprinting the envelope.
      // The raw body is multi-line JSON; a log built from it spread a single 401 over the screen.
      const comboLine = warnings.find(line => line.startsWith("[combo] codexfirst: openai/"));
      expect(comboLine).toBeDefined();
      expect(comboLine).not.toContain("\n");
      expect(comboLine).not.toContain("{");
      expect(comboLine).toContain("401");
      expect(warnings.join("\n")).not.toContain("private-upstream-body-marker");
      expect(warnings).toContain("[codex] native main refresh: reauth status=401 code=token_invalidated");
      // The combo still serves the turn from its second target; that was never the problem.
      expect(first.status).toBe(200);
      expect(fallbackSends).toBe(1);
      // One send, one refresh attempt, and the refusal retired the grant for good.
      expect(codexSends).toHaveLength(1);
      expect(refreshes).toEqual(["refresh-grant"]);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      expect(isMainAccountRefreshGrantRejected()).toBe(true);
      expect(codexAccountUnusableReason(config(), MAIN_CODEX_ACCOUNT_ID)).toBe("needs_reauth");

      // Re-offer the openai leg. Without this the combo's own target cooldown skips it and the
      // assertions below would pass whether or not the account was ever quarantined.
      clearComboTargetCooldowns();
      clearComboSelectionState();
      const second = await handleClaudeMessages(
        messagesRequest(),
        comboConfig,
        { model: "", provider: "" } as RequestLogContext,
        { requestId: `combo-401-${crypto.randomUUID()}`, start: Date.now(), turnAdmissionLease: freshTurn() },
      );
      await second.text();
      expect(second.status).toBe(200);
      expect(fallbackSends).toBe(2);
      // THE POINT: the quarantined main account is not sent to again, and its dead grant is not
      // retried either. Before the fix this was a second upstream 401, three hundred times over.
      expect(codexSends).toHaveLength(1);
      expect(refreshes).toEqual(["refresh-grant"]);

      // A real explicit WHAM success clears its generic mark, but cannot revive this grant.
      markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
      clearMainAccountInfoCache();
      const whamBefore = whamSends;
      const accounts = await listCodexAuthAccounts(comboConfig, true);
      expect(whamSends).toBe(whamBefore + 1);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      expect(accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)?.needsReauth).toBe(true);
      expect(isMainAccountRefreshGrantRejected()).toBe(true);
      clearComboTargetCooldowns();
      clearComboSelectionState();
      const third = await handleClaudeMessages(
        messagesRequest(),
        comboConfig,
        { model: "", provider: "" } as RequestLogContext,
        { requestId: `combo-401-${crypto.randomUUID()}`, start: Date.now(), turnAdmissionLease: freshTurn() },
      );
      await third.text();
      expect(third.status).toBe(200);
      expect(fallbackSends).toBe(3);
      expect(codexSends).toHaveLength(1);
      expect(refreshes).toEqual(["refresh-grant"]);
    } finally {
      warnSpy.mockRestore();
      for (const turn of turns) turn.release();
    }
  });
});
