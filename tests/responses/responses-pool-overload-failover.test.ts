import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../../src/codex/routing";
import { handleResponses } from "../../src/server/responses";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { subscriptionPreOutputRefusalHold } from "../../src/server/responses/core-codex-account";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { configureSharedSpendLedger, DEFAULT_SPEND_RESERVATION_POLICY, sharedSpendLedger } from "../../src/lib/spend-reservation-ledger";
import { clearPoolRecoveryState, configureSharedPoolBackpressure } from "../../src/routing/probe-lease";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #6969 end to end: a pooled native Codex turn that the upstream refuses over the WebSocket before
 * any output now takes the same-account transient ladder and then one alternate account, and a
 * turn nothing recovers reaches the client as the stream it always received. Output already
 * relayed, a pinned account and a cancelled caller keep today's answers.
 */

const WORK = "work";
const OTHER = "other";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

type Listener = (event: unknown) => void;
type Step = "refuse" | "ok" | "output-then-refuse" | "refuse-then-abort" | "transport-error" | "silent"
  | "heartbeat-then-refuse" | "heartbeat-output-then-refuse" | "unsafe-heartbeat-then-refuse"
  | "heartbeat-bare-then-refuse" | "heartbeat-then-abort" | "unsafe-created-then-refuse" | "unsafe-refusal"
  | "unsafe-extension-then-refuse" | "unsafe-extension-snapshot-then-refuse" | "unsafe-untyped-then-refuse"
  | "refusal-with-frame-output" | "refusal-with-snapshot-output" | "queued-with-frame-output"
  | "failed-with-frame-output";

const partialOutput = [{ id: "msg_partial", type: "message", role: "assistant", status: "in_progress",
  content: [{ type: "output_text", text: "partial answer", annotations: [] }] }];

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static plan: Step[] = [];
  static onAbortStep: (() => void) | undefined;
  url: string;
  headers: Headers;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string, options?: { headers?: HeadersInit }) {
    this.url = url;
    this.headers = new Headers(options?.headers);
    const step = FakeWebSocket.plan[FakeWebSocket.instances.length] ?? "ok";
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.run(step));
  }

  run(step: Step) {
    if (step === "transport-error") {
      // Fails before the upgrade: the exchange falls back to HTTP, whose send then fails too.
      this.emit("error", {});
      return;
    }
    this.emit("open", {});
    if (step === "silent") return;
    const id = `resp_${FakeWebSocket.instances.indexOf(this)}`;
    this.frame({ type: "response.created", response: { id, status: "in_progress", output: [] },
      ...(step === "unsafe-created-then-refuse" ? { replayUnsafe: true } : {}) });
    if (step === "heartbeat-then-refuse" || step === "heartbeat-output-then-refuse"
      || step === "unsafe-heartbeat-then-refuse" || step === "heartbeat-bare-then-refuse"
      || step === "heartbeat-then-abort") {
      // A heartbeat only keeps the connection alive. The bare-code case also carries the sequence
      // marker the Responses wire puts on every event.
      this.frame(step === "heartbeat-bare-then-refuse"
        ? { type: "response.heartbeat", sequence_number: 2 }
        : { type: "response.heartbeat" });
      // A side-effect mark must never become replayable, even on a heartbeat.
      if (step === "unsafe-heartbeat-then-refuse") this.frame({ type: "response.heartbeat", replayUnsafe: true });
    }
    this.frame({ type: "response.in_progress", response: { id, status: "in_progress", output: [] } });
    if (step === "unsafe-extension-then-refuse") this.frame({ type: "extension.notice", replayUnsafe: true });
    if (step === "unsafe-extension-snapshot-then-refuse") this.frame({ type: "extension.notice", response: { id, replayUnsafe: true } });
    if (step === "unsafe-untyped-then-refuse") this.frame({ replayUnsafe: true });
    if (step === "ok") {
      this.frame({ type: "response.completed", response: { id, status: "completed", output: [] } });
      return;
    }
    if (step === "output-then-refuse") {
      this.frame({ type: "response.output_item.added", response_id: id, output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] } });
    }
    if (step === "heartbeat-output-then-refuse") {
      this.frame({ type: "response.output_item.added", response_id: id, output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] } });
    }
    if (step === "queued-with-frame-output") {
      this.frame({ type: "response.queued", output: partialOutput, response: { id, status: "queued", output: [] } });
    }
    if (step === "failed-with-frame-output") {
      this.frame({ type: "response.failed", output: partialOutput, response: { id, status: "failed", output: [],
        error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." } } });
      return;
    }
    if (step === "heartbeat-bare-then-refuse") {
      // The field shape: the sequence marker on the heartbeat, then a refusal whose code alone
      // identifies the overload with no numeric wrapper status.
      this.frame({ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." } });
    } else {
      this.frame({ type: "error", status: 503,
        ...(step === "refusal-with-frame-output" ? { output: partialOutput } : {}),
        ...(step === "refusal-with-snapshot-output" ? { response: { id, output: partialOutput } } : {}),
        ...(step === "unsafe-refusal" ? { replayUnsafe: true } : {}),
        error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } });
    }
    if (step === "refuse-then-abort" || step === "heartbeat-then-abort") setTimeout(() => FakeWebSocket.onAbortStep?.(), 100);
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

  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(data: string) { this.sent.push(data); }

  close() { this.closed = true; }
}

const RealWebSocket = globalThis.WebSocket;
const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let savedProxyEnv: Record<string, string | undefined> = {};
let releaseSpendHome: (() => void) | undefined;

function clearPoolState(): void {
  for (const id of [WORK, OTHER]) clearAccountNeedsReauth(id);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAccountQuota();
  clearPoolRecoveryState();
}

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-pool-overload-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearPoolState();
  for (const id of [WORK, OTHER]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(
    [WORK, OTHER].map(id => [id, {
      credential: {
        accessToken: `${id}-access`,
        refreshToken: `${id}-grant`,
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: `acc-${id}`,
      },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
    }]),
  )));
  FakeWebSocket.instances = [];
  FakeWebSocket.plan = [];
  FakeWebSocket.onAbortStep = undefined;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  // Every send must ride the WebSocket; an HTTP send here is a failure of the test's premise.
  globalThis.fetch = (async () => { throw new Error("unexpected HTTP send"); }) as unknown as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  codexWsPool.dispose();
  clearPoolState();
  for (const [index, key] of HOME_KEYS.entries()) {
    if (previousHomes[index] === undefined) delete process.env[key];
    else process.env[key] = previousHomes[index];
  }
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  removeTreeWithRetry(home);
});

function poolConfig(accounts: string[] = [WORK, OTHER], extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    activeCodexAccountId: WORK,
    autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin",
    codexAccounts: accounts.map(id => ({ id, label: id })),
    ...extra,
  } as OcxConfig;
}

async function send(config: OcxConfig, options: { model?: string; abortSignal?: AbortSignal; inputEstimate?: number } = {}) {
  const logCtx: RequestLogContext = { model: "", provider: "", spendInputEstimateTokens: options.inputEstimate };
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json",
      ...(config.providers.openai!.codexAccountMode === "direct" ? { authorization: "Bearer caller-access" } : {}) },
    body: JSON.stringify({ model: options.model ?? "gpt-5.5", input: "hello", stream: true, store: false }),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  });
  const response = await handleResponses(request, config, logCtx, {
    codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    ...(config.providers.openai!.codexAccountMode === "pool" ? { sendBudget: createRequestExecutionBudget() } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  const body = await response.text().catch(error => `<body error: ${String(error)}>`);
  return { response, body, logCtx };
}

function sockets(): Array<string | null> {
  return FakeWebSocket.instances.map(ws => ws.headers.get("authorization"));
}

function failures(accountId: string): number {
  return getCodexUpstreamHealth(accountId)?.consecutiveFailures ?? 0;
}

describe("pooled native Codex recovers a pre-output upstream refusal (#6969)", () => {
  test.each([undefined, {}, { enabled: false, attempts: 4 }])("main leaves the hold off with policy %j", async policy => {
    const config = poolConfig([]);
    const provider = config.providers.openai!;
    provider.codexAccountMode = "direct";
    provider.transientRetryOn5xx = policy;
    FakeWebSocket.plan = ["heartbeat-bare-then-refuse", "ok"];
    expect(subscriptionPreOutputRefusalHold({ kind: "main", accountId: null }, provider, 20_000, false)).toBeUndefined();
    const { response, body } = await send(config);
    expect(response.status).toBe(200);
    expect(body).toContain("response.created");
    expect(body).toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer caller-access"]);
    expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
  });

  for (const mode of ["direct", "pool"] as const) {
    test.each([
      ["queued-with-frame-output", "response.queued"],
      ["failed-with-frame-output", "response.failed"],
    ] as const)(`${mode} relays partial output without replay (%s)`, async (step, eventType) => {
      const config = poolConfig();
      const provider = config.providers.openai!;
      provider.codexAccountMode = mode;
      if (mode === "direct") provider.transientRetryOn5xx = { attempts: 3 };
      FakeWebSocket.plan = [step, "ok"];

      const { response, body } = await send(config);

      expect(FakeWebSocket.instances.flatMap(socket => socket.sent)).toHaveLength(1);
      expect(sockets()).toEqual([mode === "direct" ? "Bearer caller-access" : "Bearer work-access"]);
      expect(response.status).toBe(200);
      const prefix = `event: ${eventType}\ndata: `;
      const data = body.split("\n\n").find(frame => frame.startsWith(prefix));
      expect(data).toBeDefined();
      expect(JSON.parse(data!.slice(prefix.length))).toMatchObject({ output: partialOutput, response: { output: [] } });
      expect(body).toContain("server_is_overloaded");
    });

    test.each(["refusal-with-frame-output", "refusal-with-snapshot-output"] as const)(
      `${mode} delivers a bare error carrying partial output without replay (%s)`, async step => {
        const config = poolConfig();
        const provider = config.providers.openai!;
        provider.codexAccountMode = mode;
        if (mode === "direct") provider.transientRetryOn5xx = { attempts: 3 };
        FakeWebSocket.plan = [step, "ok"];
        const { response, body } = await send(config);
        expect(sockets()).toEqual([mode === "direct" ? "Bearer caller-access" : "Bearer work-access"]);
        expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
        expect(response.status).toBe(200);
        const errorData = body.split("\n\n").find(frame => frame.startsWith("event: error\ndata: "));
        expect(errorData).toBeDefined();
        const errorFrame = JSON.parse(errorData!.slice("event: error\ndata: ".length));
        expect(errorFrame.error.code).toBe("server_is_overloaded");
        expect(step === "refusal-with-frame-output" ? errorFrame.output : errorFrame.response.output).toEqual(partialOutput);
      },
    );

    test.each(["unsafe-created-then-refuse", "unsafe-refusal"] as const)(
      `${mode} never retries a pre-output stream with a replay-unsafe mark (%s)`, async step => {
        const config = poolConfig();
        const provider = config.providers.openai!;
        provider.codexAccountMode = mode;
        if (mode === "direct") provider.transientRetryOn5xx = { attempts: 3 };
        FakeWebSocket.plan = [step, "ok"];
        const { response, body } = await send(config);
        expect(response.status).toBe(200);
        expect(body).toContain("server_is_overloaded");
        expect(sockets()).toEqual([mode === "direct" ? "Bearer caller-access" : "Bearer work-access"]);
        expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
      },
    );
  }

  test.each(["unsafe-extension-then-refuse", "unsafe-extension-snapshot-then-refuse", "unsafe-untyped-then-refuse"] as const)(
    "opted-in main honors replay marks on filtered frames (%s)", async step => {
      const config = poolConfig([]);
      config.providers.openai!.codexAccountMode = "direct";
      config.providers.openai!.transientRetryOn5xx = { attempts: 3 };
      FakeWebSocket.plan = [step, "ok"];
      const { response, body } = await send(config);
      expect(response.status).toBe(200);
      expect(body).toContain("server_is_overloaded");
      expect(body).not.toContain("extension.notice");
      expect(body).not.toContain("replayUnsafe");
      expect(sockets()).toEqual(["Bearer caller-access"]);
      expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
    },
  );

  test.each([1, 2, 3, 4])("main respects a %i-send capacity budget on the requested model", async attempts => {
    const config = poolConfig([]);
    config.providers.openai!.codexAccountMode = "direct";
    config.providers.openai!.transientRetryOn5xx = { attempts };
    FakeWebSocket.plan = ["heartbeat-bare-then-refuse", "heartbeat-bare-then-refuse", "heartbeat-bare-then-refuse", "ok"];
    const { body } = await send(config);
    expect(body).toContain(attempts === 4 ? "response.completed" : "server_is_overloaded");
    expect(sockets()).toEqual(Array(attempts).fill("Bearer caller-access"));
    for (const socket of FakeWebSocket.instances) {
      expect(JSON.parse(socket.sent[0]!).model).toBe("gpt-5.5");
    }
  });

  test.each([
    { label: "a 100-token ceiling", ceiling: 100, expectedSends: 1 },
    { label: "a 400-token ceiling", ceiling: 400, expectedSends: 4 },
    { label: "no ceiling", ceiling: undefined, expectedSends: 4 },
  ])("opted-in main admits $expectedSends sends with $label", async ({ ceiling, expectedSends }) => {
    configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: ceiling } });
    const config = poolConfig([]);
    config.providers.openai!.codexAccountMode = "direct";
    config.providers.openai!.transientRetryOn5xx = { attempts: 4 };
    FakeWebSocket.plan = ["heartbeat-bare-then-refuse", "refuse", "refuse", "ok"];

    const { response, body, logCtx } = await send(config, { inputEstimate: 100 });
    expect(FakeWebSocket.instances.flatMap(socket => socket.sent)).toHaveLength(expectedSends);
    expect(sockets()).toEqual(Array(expectedSends).fill("Bearer caller-access"));
    expect(response.status).toBe(200);
    if (expectedSends === 1) {
      expect(body).toContain('"id":"resp_0"');
      expect(body).toContain('"code":"server_is_overloaded"');
    } else {
      expect(body).toContain("response.completed");
    }
    logCtx.spendTracker!.settle(undefined);
    expect(sharedSpendLedger().snapshot("pool", "openai")).toMatchObject({ reserved: 0, unresolved: expectedSends * 100 });
  });

  test("the same account is retried first and serves the turn", async () => {
    FakeWebSocket.plan = ["refuse", "ok"];
    const { response, body, logCtx } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access"]);
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toContain("transient-5xx");
  });

  test("after the same-account ladder, one alternate account serves the turn", async () => {
    FakeWebSocket.plan = ["refuse", "refuse", "refuse", "ok"];
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access", "Bearer other-access"]);
    // The refused account is recorded once, as a transient failure.
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("with every account overloaded the client receives the original stream, once per account in health", async () => {
    FakeWebSocket.plan = ["refuse", "refuse", "refuse", "refuse"];
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("event: response.created");
    expect(body).toContain("server_is_overloaded");
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(sockets().at(-1)).toBe("Bearer other-access");
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(1);
  });

  test("a single-account pool retries only that account, then delivers the original stream", async () => {
    FakeWebSocket.plan = ["refuse", "refuse", "refuse"];
    const { response, body } = await send(poolConfig([WORK]));
    expect(response.status).toBe(200);
    expect(body).toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access"]);
    expect(failures(WORK)).toBe(1);
  });

  test("a pinned account never moves to another account", async () => {
    FakeWebSocket.plan = ["refuse", "refuse", "refuse", "ok"];
    const { response, body } = await send(poolConfig([WORK, OTHER], { codexAccountNamespaces: { side: WORK } }),
      { model: "side/gpt-5.5" });
    expect(response.status).toBe(200);
    expect(body).toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access"]);
  });

  test("a refusal after output started is never sent again", async () => {
    FakeWebSocket.plan = ["output-then-refuse", "ok"];
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.output_item.added");
    expect(body).toContain("server_is_overloaded");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("a heartbeat before the refusal takes the same-account ladder", async () => {
    FakeWebSocket.plan = ["heartbeat-then-refuse", "ok"];
    const { response, body, logCtx } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access"]);
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toContain("transient-5xx");
    expect(failures(WORK)).toBe(0);
  });

  test("a heartbeat before the refusal still moves to the alternate after the ladder", async () => {
    FakeWebSocket.plan = ["heartbeat-then-refuse", "heartbeat-then-refuse", "heartbeat-then-refuse", "ok"];
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access", "Bearer other-access"]);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("the field shape recovers: heartbeat then a bare-code 503", async () => {
    FakeWebSocket.plan = ["heartbeat-bare-then-refuse", "ok"];
    const { response, body, logCtx } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access"]);
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toContain("transient-5xx");
    expect(failures(WORK)).toBe(0);
  });

  test("output after a heartbeat is never sent again", async () => {
    FakeWebSocket.plan = ["heartbeat-output-then-refuse", "ok"];
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("response.heartbeat");
    expect(body).toContain("response.output_item.added");
    expect(body).toContain("server_is_overloaded");
    expect(FakeWebSocket.instances).toHaveLength(1);
    // Nothing was sent again; the committed 503 still counts once as this account's failure.
    expect(failures(WORK)).toBe(1);
  });

  test("a replay-unsafe heartbeat is never sent again", async () => {
    FakeWebSocket.plan = ["unsafe-heartbeat-then-refuse", "ok"];
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("server_is_overloaded");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(failures(WORK)).toBe(1);
  });

  test("a heartbeat refusal still respects a pinned account", async () => {
    FakeWebSocket.plan = ["heartbeat-then-refuse", "heartbeat-then-refuse", "heartbeat-then-refuse", "ok"];
    const { response, body } = await send(poolConfig([WORK, OTHER], { codexAccountNamespaces: { side: WORK } }),
      { model: "side/gpt-5.5" });
    expect(response.status).toBe(200);
    expect(body).toContain("server_is_overloaded");
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access"]);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("a heartbeat refusal still stops at the request's four-send budget", async () => {
    FakeWebSocket.plan = Array.from({ length: 6 }, () => "heartbeat-then-refuse");
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("server_is_overloaded");
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(sockets()).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access", "Bearer other-access"]);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(1);
  });

  test("a caller cancelling during a heartbeat refusal's backoff stops every later send", async () => {
    const abort = new AbortController();
    FakeWebSocket.plan = ["heartbeat-then-abort", "ok"];
    FakeWebSocket.onAbortStep = () => abort.abort();
    const { response } = await send(poolConfig(), { abortSignal: abort.signal });
    expect(response.status).toBe(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(failures(WORK)).toBe(1);
  });

  test("a caller cancelling during the backoff stops every later send and records the refusal once", async () => {
    const abort = new AbortController();
    FakeWebSocket.plan = ["refuse-then-abort", "ok"];
    FakeWebSocket.onAbortStep = () => abort.abort();
    const { response } = await send(poolConfig(), { abortSignal: abort.signal });
    expect(response.status).toBe(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(failures(WORK)).toBe(1);
  });

  test("a recovery window that refuses the move keeps the first account's stream and records it once", async () => {
    FakeWebSocket.plan = ["refuse", "refuse", "refuse", "ok"];
    configureSharedPoolBackpressure({ windowMs: 10_000, maxRetryRatio: 0, minRecoveryAllowance: 0 });
    const { response, body } = await send(poolConfig());
    expect(response.status).toBe(200);
    expect(body).toContain("server_is_overloaded");
    expect(sockets().every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("a refusal followed by a failed send is recorded once, by the transport failure", async () => {
    FakeWebSocket.plan = ["refuse", "transport-error"];
    const { response } = await send(poolConfig());
    expect(response.status).toBe(502);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(failures(WORK)).toBe(1);
  });

  test("a refusal followed by a header timeout settles the timeout and records the account once", async () => {
    FakeWebSocket.plan = ["refuse", "silent"];
    const { response } = await send(poolConfig([WORK, OTHER], { connectTimeoutMs: 1_000 }));
    expect(response.status).toBe(504);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(sockets().every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
  });
});
