import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { WsData } from "../../src/server/ws-bridge";
import type { OcxConfig } from "../../src/types";
import { resendPermission } from "../../src/lib/request-failure-model";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const originalFetch = globalThis.fetch;
let home: TempHome;
let release: () => void;
let finishClient: (() => Promise<void>) | undefined;

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("WebSocket refusal fixture did not settle");
    await Bun.sleep(1);
  }
}

beforeEach(() => {
  home = createTempHome("ocx-ws-refusal-");
  release = acquireOwnedSpendHome();
  clearRequestLogsForTests();
});

afterEach(async () => {
  try { await finishClient?.(); }
  finally {
    finishClient = undefined;
    globalThis.fetch = originalFetch;
    try { runOptionalShutdownHooks(); }
    finally { try { release(); } finally { home.remove(); } }
  }
});

async function turn(canonical: boolean, reset: boolean) {
  const config = { port: 0, defaultProvider: "fixture", websockets: true, providers: {
    fixture: { adapter: "openai-responses", upstreamWebsocket: false, retryOn429: { enabled: false },
      ...(canonical
        ? { baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" }
        : { baseUrl: "https://fixture.invalid/v1", authMode: "key", apiKey: "synthetic-fixture" }),
    },
  } } as OcxConfig;
  let sends = 0;
  globalThis.fetch = (async (url: unknown) => {
    expect(String(url)).toBe(canonical
      ? "https://chatgpt.com/backend-api/codex/responses" : "https://fixture.invalid/v1/responses");
    sends++;
    if (reset) throw Object.assign(new Error("synthetic connection reset"), { code: "ECONNRESET" });
    return Response.json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Fixture rate limit" } },
      { status: 429, headers: { "retry-after": "7" } });
  }) as typeof fetch;
  const handler = createWebsocketHandler({ config, deps: {} } as ServeOptionsContext);
  const frames: Record<string, any>[] = [];
  const ws = { readyState: 1,
    data: { headers: new Headers({ authorization: "Bearer synthetic-fixture", "thread-id": "ws-refusal-fixture" }) } as WsData,
    send: (text: string) => { frames.push(JSON.parse(text)); return 1; },
  } as unknown as ServerWebSocket<WsData>;
  finishClient = async () => {
    handler.close(ws, 1000, "fixture teardown");
    await until(() => !ws.data.cancel && !ws.data.nativeControl);
  };
  handler.message(ws, JSON.stringify({ type: "response.create", model: "fixture/gpt-test", input: "fixture", store: false }));
  await until(() => frames.some(frame => frame.type === "error") && !ws.data.cancel);
  expect(sends).toBe(1);
  expect(getRequestLogEntries()).toHaveLength(1);
  const row = getRequestLogEntries()[0]!;
  expect(row.attempts).toHaveLength(1);
  expect(row.attempts![0]!.sendCount).toBe(1);
  expect(row.attempts![0]!.recoveryKinds).toEqual([]);
  return { row, error: frames.find(frame => frame.type === "error")! };
}

for (const canonical of [true, false]) {
  test(`WebSocket ingress records a ${canonical ? "canonical" : "gateway"} HTTP reset as ambiguous`, async () => {
    const { row, error } = await turn(canonical, true);
    expect(error.status).toBe(429);
    expect(error.error.code).toBe("upstream_reset_replay_refused");
    expect(row.errorCode).toBe("upstream_reset_replay_refused");
    expect(row.failureCause).toBe("transport-ambiguous");
    expect(row.terminalSource).toBe("synthetic");
    expect(row.failureStage).toBe("headers-only");
    expect(row.attempts![0]!.failureCause).toBe("transport-ambiguous");
    expect(resendPermission(row.failureStage!, row.failureCause!)).toBe("refused-ambiguous");
  });
}

test("WebSocket ingress retains a genuine upstream 429 as rate-limit evidence", async () => {
  const { row, error } = await turn(false, false);
  expect(error.status).toBe(429);
  expect(error.error.code).toBe("rate_limit_exceeded");
  expect(row.failureCause).toBe("rate-limit");
  expect(row.attempts![0]!.failureCause).toBe("rate-limit");
  expect(row.terminalSource).not.toBe("synthetic");
});
