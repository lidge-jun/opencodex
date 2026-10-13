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
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
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
type Step = "refuse" | "ok" | "output-then-refuse" | "refuse-then-abort" | "transport-error" | "silent";

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
    this.frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    this.frame({ type: "response.in_progress", response: { id, status: "in_progress", output: [] } });
    if (step === "ok") {
      this.frame({ type: "response.completed", response: { id, status: "completed", output: [] } });
      return;
    }
    if (step === "output-then-refuse") {
      this.frame({ type: "response.output_item.added", response_id: id, output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] } });
    }
    this.frame({ type: "error", status: 503,
      error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } });
    if (step === "refuse-then-abort") setTimeout(() => FakeWebSocket.onAbortStep?.(), 100);
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

async function send(config: OcxConfig, options: { model?: string; abortSignal?: AbortSignal } = {}) {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: options.model ?? "gpt-5.5", input: "hello", stream: true, store: false }),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  });
  const response = await handleResponses(request, config, logCtx, {
    codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    sendBudget: createRequestExecutionBudget(),
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
