import { expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import { hostedSendFixture } from "../helpers/hosted-send-fixture";

class HostedSocket {
  static frames = 0;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor() { queueMicrotask(() => this.emit("open", {})); }
  addEventListener(name: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: unknown) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: unknown) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    expect(frame.type).toBe("response.create"); HostedSocket.frames++;
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "response.completed", response: {
      id: "synthetic-hosted-response", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 },
    } }) }));
  }
  close() {}
}
for (const kind of ["search", "image", "video"] as const) test(`${kind} successful hosted WebSocket frame retains one durable booking`, async () => hostedSendFixture(kind, "failover", async f => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = HostedSocket as unknown as typeof WebSocket;
  HostedSocket.frames = 0;
  const create = ADAPTER_REGISTRY["openai-chat"].create;
  const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args),
    buildRequest() { return { url: "https://chatgpt.com/backend-api/codex/responses", method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer synthetic-token",
    }, body: JSON.stringify({ model: "m", stream: true, input: "Synthetic assignment" }) }; },
    async *parseStream(response) {
      expect(await response.text()).toContain("response.completed");
      yield { type: "text_delta", text: "hosted WebSocket final answer" } as const;
      yield { type: "done", usage: { inputTokens: 2, outputTokens: 1 } } as const;
    },
  }));
  try {
    f.config.providers.a!.upstreamWebsocket = true;
    // The installed Bun version is not used as evidence for the gated WS policy.
    // Pin the bounded-relay runtime through the normal handler option.
    const { handleResponses } = await import("../../src/server/responses/core");
    const req = f.request();
    const response = await handleResponses(req, f.config, f.log, { sendBudget: f.budget, abortSignal: req.signal, codexWsRuntimeIdentity: "1.4.0" });
    expect(response.status).toBe(200); expect(await response.text()).toContain("hosted WebSocket final answer");
    expect(HostedSocket.frames).toBe(1); expect(f.inference).toBe(0);
    expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
    expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 0 }); expect(getActiveTurnCount()).toBe(0);
  } finally { override.mockRestore(); globalThis.WebSocket = realWebSocket; }
}));
