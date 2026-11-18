import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { handleResponses } from "../../src/server/responses";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #8107 end to end: a failover combo whose native Codex target declines with a zero-output
 * `server_is_overloaded` must move on to its next target. The Codex WebSocket metadata channel
 * writes a `codex.rate_limits` frame ahead of `response.created`, and the combo preflight used to
 * treat that frame as output and commit the native child, so the overload reached the client in a
 * 200 stream and the second target was never dispatched.
 */

const WORK = "work";
const FALLBACK_URL = "https://combo-fixture.invalid/v1/responses";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

type Listener = (event: unknown) => void;
type Step = "quota-then-refuse" | "quota-output-then-refuse";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static plan: Step[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    const step = FakeWebSocket.plan[FakeWebSocket.instances.length] ?? "quota-then-refuse";
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.run(step));
  }

  run(step: Step) {
    this.emit("open", {});
    const id = `resp_${FakeWebSocket.instances.indexOf(this)}`;
    this.frame({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } });
    this.frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    this.frame({ type: "response.in_progress", response: { id, status: "in_progress", output: [] } });
    if (step === "quota-output-then-refuse") {
      this.frame({ type: "response.output_item.added", response_id: id, output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] } });
    }
    this.frame({ type: "error", status: 503,
      error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } });
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
let fallbackSends = 0;

function clearState(): void {
  clearAccountNeedsReauth(WORK);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAccountQuota();
  clearPoolRecoveryState();
  clearComboSelectionState();
  clearComboTargetCooldowns();
}

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-combo-codex-overload-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearState();
  setAccountQuotaFromParsed(WORK, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({
    [WORK]: {
      credential: {
        accessToken: `${WORK}-access`,
        refreshToken: `${WORK}-grant`,
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: `acc-${WORK}`,
      },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${WORK}-grant`).digest("hex"),
    },
  }));
  FakeWebSocket.instances = [];
  FakeWebSocket.plan = [];
  fallbackSends = 0;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  // The native target must ride the WebSocket; only the keyed second target may use HTTP.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== FALLBACK_URL) throw new Error(`unexpected HTTP send to ${url}`);
    fallbackSends += 1;
    const completed = { type: "response.completed",
      response: { id: "resp_fallback", status: "completed", model: "fallback-model", output: [] } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  codexWsPool.dispose();
  clearState();
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

function comboConfig(): OcxConfig {
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
      fallback: {
        adapter: "openai-responses",
        baseUrl: "https://combo-fixture.invalid/v1",
        authMode: "key",
        apiKey: "synthetic-fixture",
        upstreamWebsocket: false,
      },
    },
    activeCodexAccountId: WORK,
    autoSwitchThreshold: 0,
    codexAccounts: [{ id: WORK, label: WORK }],
    combos: {
      overload: {
        alias: "chain/overload",
        strategy: "failover",
        waitForCooldownMs: 0,
        targets: [{ provider: "openai", model: "gpt-5.5" }, { provider: "fallback", model: "fallback-model" }],
      },
    },
  } as OcxConfig;
}

async function send() {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chain/overload", input: "hello", stream: true, store: false }),
  });
  const response = await handleResponses(request, comboConfig(), logCtx, {
    codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    sendBudget: createRequestExecutionBudget(),
  });
  const body = await response.text().catch(error => `<body error: ${String(error)}>`);
  return { response, body, logCtx };
}

describe("a failover combo moves past a native Codex overload that preceded any output (#8107)", () => {
  test("a rate-limit frame ahead of the preamble does not commit the native target", async () => {
    FakeWebSocket.plan = ["quota-then-refuse"];
    const { response, body, logCtx } = await send();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fallbackSends).toBe(1);
    expect(response.status).toBe(200);
    expect(body).toContain("resp_fallback");
    expect(body).not.toContain("server_is_overloaded");
    // The refused native target's metadata never reaches the client of the replacement.
    expect(body).not.toContain("codex.rate_limits");
    // The pooled attempt's provider label carries an account suffix, so match its status instead.
    // The serving attempt settles its status asynchronously after the relay, so only its identity
    // is asserted here.
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[0]?.status).toBe(503);
    expect(logCtx.attempts?.[1]?.provider).toBe("fallback");
  });

  test("output after the rate-limit frame still commits the native target", async () => {
    FakeWebSocket.plan = ["quota-output-then-refuse"];
    const { response, body } = await send();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fallbackSends).toBe(0);
    expect(response.status).toBe(200);
    expect(body).toContain("response.output_item.added");
    expect(body).toContain("server_is_overloaded");
  });
});
