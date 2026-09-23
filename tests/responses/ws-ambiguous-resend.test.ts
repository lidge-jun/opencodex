import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { handleResponses } from "../../src/server/responses";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import {
  CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS,
  codexWsSocketDeathStage,
  readCodexWsStage,
} from "../../src/server/responses/codex-ws-wire";
import {
  isNonReplayableResponse,
  REPLAY_REFUSED_STATUS,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../src/lib/upstream-retry";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { BOUNDED_WS_RUNTIME, codexWsUpstreamFetch, streamingInit } from "../helpers/ws-upstream-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #4191: a Codex WebSocket that dies after its create frame left, before any Responses event,
 * leaves the turn in the same unknown state as an HTTP connection that resets before the head.
 * The HTTP rows already answer that with the operator's `retryOnReset` grant. These cases hold the
 * WebSocket to the same answer: one replacement, over HTTP, only when the grant covers it, and
 * never a third send of the turn.
 */

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket, mirroring `ws-failure-stage.test.ts`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  headers: Headers;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string, options?: { headers?: HeadersInit }) {
    this.url = url;
    this.headers = new Headers(options?.headers);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() { this.closed = true; }
}

const RealWebSocket = globalThis.WebSocket;
const RealFetch = globalThis.fetch;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
let savedProxyEnv: Record<string, string | undefined>;
// A case that calls handleResponses directly never takes the writer lease startServer takes,
// so its dispatch is refused. Dropped in teardown so a throwing case cannot leave it behind.
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

const QUOTA_FRAME = JSON.stringify({
  type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } },
});

/** The three ways a socket can die under the send before anything was promised to the client. */
const SOCKET_DEATHS: Array<[string, (ws: FakeWebSocket) => void, "pre-header" | "protocol-prelude"]> = [
  ["nothing came back", ws => {
    ws.emit("open", {});
    ws.emit("close", { code: 1006 });
  }, "pre-header"],
  ["only quota came back", ws => {
    ws.emit("open", {});
    ws.emit("message", { data: QUOTA_FRAME });
    ws.emit("close", { code: 1006 });
  }, "protocol-prelude"],
  ["the transport errored", ws => {
    ws.emit("open", {});
    ws.emit("error", {});
  }, "pre-header"],
];

const noFallback = (async () => {
  throw new Error("fallback must not run after open");
}) as unknown as typeof fetch;

describe("the exchange records a socket that died under the send (#4191)", () => {
  test.each(SOCKET_DEATHS)("when %s it settles the same 502, marked with the stage it reached",
    async (_name, script, stage) => {
      installFake(script);
      const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), noFallback);
      expect(response.status).toBe(502);
      expect(isNonReplayableResponse(response)).toBe(true);
      expect(readCodexWsStage(response)?.sent).toBe(true);
      expect(codexWsSocketDeathStage(response)).toBe(stage);
    });

  test("silence keeps its 504 and is not a socket death", async () => {
    jest.useFakeTimers();
    const opened = Promise.withResolvers<void>();
    try {
      installFake(ws => { ws.emit("open", {}); opened.resolve(); });
      const pending = codexWsUpstreamFetch(CODEX_URL, streamingInit(), noFallback);
      await opened.promise;
      jest.advanceTimersByTime(CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(codexWsSocketDeathStage(response)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a drop after the response started stays a failed body and is not a socket death", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.emit("close", { code: 1006 });
    });
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), noFallback);
    expect(response.status).toBe(200);
    expect(codexWsSocketDeathStage(response)).toBeUndefined();
    await expect(response.text()).rejects.toThrow("closed before a Responses terminal event");
  });

  test("a steering exchange's death is not offered: its channel may have sent more than the create", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("close", { code: 1006 });
    });
    const init = streamingInit();
    const prepared = prepareCodexWsRequest(CODEX_URL, init)!;
    const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, true);
    const nativeControl = {
      kind: "steering" as const,
      relayActive: false,
      attached: false,
      ended: false,
      attach() { return () => {}; },
      observe() { return false; },
      steer() {},
      continue() { return false; },
    };
    try {
      expect(session.reserve()).toBe(true);
      const response = await codexWsExchange({ session, url: CODEX_URL, init, prepared, nativeControl, sseFallback: noFallback });
      expect(response.status).toBe(502);
      expect(codexWsSocketDeathStage(response)).toBeUndefined();
    } finally { session.dispose(); }
  });
});

describe("handleResponses replaces a dead socket's send once under retryOnReset (#4191)", () => {
  function forwardConfig(provider: Partial<OcxProviderConfig> = {}): OcxConfig {
    return {
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
          ...provider,
        },
      },
    } as OcxConfig;
  }

  /** A turn whose second send can only repeat the inference: nothing stored, no hosted tools. */
  function turn(body: Record<string, unknown> = {}): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true, store: false, ...body }),
    });
  }

  function completed(): Response {
    return new Response(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "r-http", status: "completed", output: [] },
    })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  /** Every HTTP send reaches upstream through here, so its length is the number of HTTP sends. */
  function stubHttp(answer: () => Response): string[] {
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return answer();
    }) as typeof fetch;
    return bodies;
  }

  async function send(
    request: Request,
    config: OcxConfig,
    logCtx: RequestLogContext = { model: "", provider: "" },
    sendBudget = createRequestExecutionBudget(),
  ): Promise<Response> {
    takeSpendHome();
    return handleResponses(request, config, logCtx, { codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME, sendBudget });
  }

  describe("in pool mode", () => {
    const ACCOUNT_ID = "work";
    const OTHER_ACCOUNT_ID = "other";
    const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
    let home = "";
    let previousHomes: Array<string | undefined>;

    function clearPoolState(): void {
      clearAccountNeedsReauth(ACCOUNT_ID);
      clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearPoolRotationState();
      clearAccountQuota();
    }

    beforeEach(() => {
      previousHomes = HOME_KEYS.map(key => process.env[key]);
      home = mkdtempSync(join(tmpdir(), "ocx-ws-ambiguous-pool-"));
      for (const key of HOME_KEYS) process.env[key] = home;
      takeSpendHome();
      clearPoolState();
      // A primed pool does not issue unrelated background usage requests during the turn.
      for (const id of [ACCOUNT_ID, OTHER_ACCOUNT_ID]) {
        setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
      }
      writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(
        [ACCOUNT_ID, OTHER_ACCOUNT_ID].map(id => [id, {
          credential: {
            accessToken: `${id}-access`,
            refreshToken: `${id}-grant`,
            expiresAt: Date.now() + 3_600_000,
            chatgptAccountId: `acc-${id}`,
          },
          generation: 1,
          refreshGrantFingerprint: createHash("sha256")
            .update(`codex-refresh-grant:${id}-grant`).digest("hex"),
        }]),
      )));
    });

    afterEach(() => {
      // Release the writer before removing its database or restoring the surrounding home.
      releaseSpendHome?.();
      releaseSpendHome = undefined;
      clearPoolState();
      for (const [index, key] of HOME_KEYS.entries()) {
        if (previousHomes[index] === undefined) delete process.env[key];
        else process.env[key] = previousHomes[index];
      }
      removeTreeWithRetry(home);
    });

    for (const [status, body] of [
      [429, JSON.stringify({ error: { message: "quota exhausted" } })],
      [503, "busy"],
      [400, JSON.stringify({
        detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
      })],
    ] as const) {
      test(`a replacement ${status} cannot send the turn through the second account`, async () => {
        installFake(SOCKET_DEATHS[0]![1]);
        const http: Headers[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          http.push(new Headers(init?.headers));
          return new Response(body, { status });
        }) as typeof fetch;
        const config: OcxConfig = {
          ...forwardConfig({ codexAccountMode: "pool", retryOnReset: {} }),
          activeCodexAccountId: ACCOUNT_ID,
          autoSwitchThreshold: 0,
          accountPoolStrategy: "round-robin",
          codexAccounts: [{ id: ACCOUNT_ID, label: "work" }, { id: OTHER_ACCOUNT_ID, label: "other" }],
        };
        const request = new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true, store: false }),
        });
        const response = await send(request, config);

        // Both transports count: the dead socket's 502 must not rotate before the HTTP row.
        const credentials = [...FakeWebSocket.instances.map(ws => ws.headers), ...http];
        expect(credentials.map(headers => headers.get("authorization"))).not.toContain("Bearer other-access");
        expect(FakeWebSocket.instances).toHaveLength(1);
        const socket = FakeWebSocket.instances[0]!;
        expect(socket.headers.get("authorization")).toBe("Bearer work-access");
        expect(socket.sent).toHaveLength(1);
        expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "response.create" });
        expect(http).toHaveLength(1);
        expect(http[0]!.get("authorization")).toBe("Bearer work-access");
        expect(http[0]!.get("chatgpt-account-id")).toBe("acc-work");
        if (status === 400) {
          expect(response.status).toBe(400);
          expect(await response.text()).toBe(body);
        } else {
          expect(response.status).toBe(REPLAY_REFUSED_STATUS);
          expect(response.headers.get("x-should-retry")).toBe("false");
          expect(await response.json()).toMatchObject({ error: { code: UPSTREAM_RESET_REPLAY_REFUSED_CODE } });
        }
      });
    }
  });

  test.each(SOCKET_DEATHS)("when %s, one HTTP send of the same turn serves it", async (_name, script) => {
    installFake(script);
    const http = stubHttp(completed);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await send(turn(), forwardConfig({ retryOnReset: {} }), logCtx);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    // Over HTTP: the transport that just failed is not asked again.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(http).toHaveLength(1);
    const frame = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!) as { input?: unknown };
    expect((JSON.parse(http[0]!) as { input?: unknown }).input).toEqual(frame.input);
    // Both sends are on the record, and the dead socket's evidence stays beside its replacement.
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["connection-reset"]);
    expect(logCtx.activeAttempt?.codexWsStage?.sent).toBe(true);
  });

  test.each([
    ["the provider grants nothing", {}, {}],
    ["the turn is stored upstream", { retryOnReset: {} }, { store: true }],
  ])("the 502 stands and nothing else is sent when %s", async (_name, provider, body) => {
    installFake(SOCKET_DEATHS[0]![1]);
    const http = stubHttp(completed);
    const response = await send(turn(body), forwardConfig(provider));

    expect(response.status).toBe(502);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(http).toHaveLength(0);
  });

  test.each([
    ["a status the client would retry", () => new Response("busy", { status: 503 })],
    ["a reset of its own", () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); }],
  ])("a replacement that fails with %s settles as the refusal, with no third send", async (_name, answer) => {
    installFake(SOCKET_DEATHS[0]![1]);
    const http = stubHttp(answer);
    const response = await send(turn(), forwardConfig({ retryOnReset: {} }));

    expect(response.status).toBe(REPLAY_REFUSED_STATUS);
    expect(await response.json()).toMatchObject({ error: { code: UPSTREAM_RESET_REPLAY_REFUSED_CODE } });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(http).toHaveLength(1);
  });

  test("a spent replacement's effort rejection does not start a downgrade send", async () => {
    installFake(SOCKET_DEATHS[0]![1]);
    const http = stubHttp(() => Response.json(
      { error: { param: "reasoning.effort", message: "Unsupported reasoning effort" } },
      { status: 400 },
    ));
    const config = forwardConfig({ retryOnReset: {}, reasoningEfforts: ["low", "high"] });
    const response = await send(turn({ reasoning: { effort: "high" } }), config);

    // The 400 answers the replacement, not the send that may already have run the turn.
    expect(response.status).toBe(400);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(http).toHaveLength(1);
  });

  test("the grant is not spent on a replacement the send budget cannot fund", async () => {
    installFake(SOCKET_DEATHS[0]![1]);
    const http = stubHttp(completed);
    const sendBudget = createRequestExecutionBudget();
    // Room for the socket's own send and nothing after it.
    sendBudget.used = sendBudget.policy.baseSendAllowance - 1;
    const response = await send(turn(), forwardConfig({ retryOnReset: {} }), undefined, sendBudget);

    expect(response.status).toBe(502);
    expect(http).toHaveLength(0);
    expect(sendBudget.claimAmbiguousResend?.(1)).toBe(true);
  });

  test("the SSE row cannot buy a second replacement after the socket's", async () => {
    installFake(SOCKET_DEATHS[0]![1]);
    const encoder = new TextEncoder();
    // The replacement's stream dies after its prelude with nothing written, the SSE row's case.
    const http = stubHttp(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({
          type: "response.created", response: { id: "r-http", status: "in_progress" },
        })}\n\n`));
        controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await send(turn(), forwardConfig({ retryOnReset: {} }));
    await response.text().catch(() => "");

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(http).toHaveLength(1);
  });

  test("a replacement that resets before its head may use a configured second grant", async () => {
    installFake(SOCKET_DEATHS[0]![1]);
    let calls = 0;
    const http = stubHttp(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return completed();
    });
    const response = await send(turn(), forwardConfig({ retryOnReset: { replacements: 2 } }));

    expect(response.status).toBe(200);
    await response.text();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(http).toHaveLength(2);
  });

  test("with one grant, a replacement that resets before its head settles as the refusal", async () => {
    installFake(SOCKET_DEATHS[0]![1]);
    const http = stubHttp(() => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const response = await send(turn(), forwardConfig({ retryOnReset: {} }));

    expect(response.status).toBe(REPLAY_REFUSED_STATUS);
    expect(await response.json()).toMatchObject({ error: { code: UPSTREAM_RESET_REPLAY_REFUSED_CODE } });
    expect(http).toHaveLength(1);
  });
});
