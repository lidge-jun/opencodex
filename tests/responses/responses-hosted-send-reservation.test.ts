import { expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import { hostedSendFixture } from "../helpers/hosted-send-fixture";
import { chatStream } from "../helpers/combo-failover-upstream";
import * as keyFailover from "../../src/providers/key-failover";

for (const kind of ["search", "image", "video"] as const) {
  for (const strategy of ["failover", "jev"] as const) {
    test(`${kind}/${strategy} final HTTP inference retains prepaid durable booking`, async () => hostedSendFixture(kind, strategy, async f => {
      const response = await f.dispatch();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hosted route final answer");
      expect(f.inference).toBe(1); expect(f.judge).toBe(strategy === "jev" ? 1 : 0);
      expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
      expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 0 });
      expect(getActiveTurnCount()).toBe(0);
      expect(f.bodies[0]?.model).toBe("m");
      expect(f.bodies[0]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "Synthetic assignment" })]));
      if (strategy === "jev") expect(f.bodies[0]?.reasoning_effort).toBe("low");
    }));
  }
  test(`${kind} adapter-owned fetchResponse consumes once, without a duplicate receipt`, async () => hostedSendFixture(kind, "failover", async f => {
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => {
      const adapter = create(...args);
      return { ...adapter, async fetchResponse(request, ctx) {
        const send = createAdapterPhysicalSend(ctx);
        return send({ url: request.url, dispatch: executor => executor(request.url, {
          method: request.method, headers: request.headers, body: request.body, signal: ctx?.abortSignal,
        }) });
      } };
    });
    try {
      const response = await f.dispatch();
      expect(await response.text()).toContain("hosted route final answer");
      expect(f.inference).toBe(1); expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
      expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 0 });
      expect(getActiveTurnCount()).toBe(0);
    } finally { override.mockRestore(); }
  }));
  test(`${kind} direct hosted inference preserves its existing non-Combo accounting contract`, async () => hostedSendFixture(kind, "failover", async f => {
    const req = f.request(); const body = await req.json() as Record<string, unknown>; body.model = "a/m";
    const { handleResponses } = await import("../../src/server/responses/core");
    const response = await handleResponses(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) }), f.config, f.log, { sendBudget: f.budget });
    expect(await response.text()).toContain("hosted route final answer"); expect(f.inference).toBe(1);
    expect(f.budget.used).toBe(0); expect(f.charges).toBe(0); expect(f.refunds).toBe(0); expect(getActiveTurnCount()).toBe(0);
  }));
  for (const firstOwned of [false, true]) test(`${kind} rotated ${firstOwned ? "adapter-to-generic" : "generic-to-adapter"} dispatch uses its actual accounting owner`, async () => hostedSendFixture(kind, "failover", async f => {
    delete f.config.providers.a!.transientRetryOn5xx;
    // Mock credential selection only; both inference dispatches use the real core/loop/executor.
    const rotate = spyOn(keyFailover, "rotateProviderTransportOn429").mockImplementation(() => {
      const next = { ...f.config.providers.a!, apiKey: "synthetic-second-key" };
      f.config.providers.a = next; return next;
    });
    let calls = 0;
    f.config.providers.a!.fetch = (async () => ++calls === 1
      ? Response.json({ error: { message: "synthetic key refusal" } }, { status: 429 }) : chatStream("rotated hosted final answer")) as unknown as typeof fetch;
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => {
      const adapter = create(...args);
      const owned = args[0].apiKey === "synthetic-second-key" ? !firstOwned : firstOwned;
      return owned ? { ...adapter, async fetchResponse(request, ctx) {
        const send = createAdapterPhysicalSend(ctx);
        return send({ url: request.url, dispatch: executor => executor(request.url, {
          method: request.method, headers: request.headers, body: request.body, signal: ctx?.abortSignal,
        }) });
      } } : adapter;
    });
    try {
      const response = await f.dispatch(); expect(response.status).toBe(200); expect(await response.text()).toContain("rotated hosted final answer");
      expect(calls).toBe(2); expect(f.budget.used).toBe(2); expect(f.charges).toBe(2); expect(f.refunds).toBe(0);
      expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 3 }); expect(getActiveTurnCount()).toBe(0);
    } finally { override.mockRestore(); rotate.mockRestore(); }
  }));
  test(`${kind} local build rejection is unsent and refunded once`, async () => hostedSendFixture(kind, "failover", async f => {
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args),
      buildRequest() { throw new Error("synthetic local build refusal"); },
    }));
    try {
      const response = await f.dispatch(); await response.text();
      expect(response.status).toBe(502); expect(f.inference).toBe(0); expect(f.budget.used).toBe(0);
      expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
      expect(f.settle()).toMatchObject({ settled: 0, reserved: 0, unresolved: 0 });
      expect(getActiveTurnCount()).toBe(0);
    } finally { override.mockRestore(); }
  }));
  test(`${kind} sent failure cannot restore capacity for a next target`, async () => hostedSendFixture(kind, "failover", async f => {
    // A three-target Combo has a six-send shared ceiling; prior work already occupies four.
    f.budget.used = 4;
    let first = 0, second = 0, third = 0;
    f.config.providers.a!.fetch = (async () => { first++; return Response.json({ error: { message: "synthetic upstream failure" } }, { status: 500 }); }) as unknown as typeof fetch;
    f.config.providers.b = { ...f.config.providers.a!, fetch: (async () => { second++; return Response.json({ error: { message: "second synthetic failure" } }, { status: 500 }); }) as unknown as typeof fetch };
    f.config.providers.c = { ...f.config.providers.a!, fetch: (async () => { third++; return chatStream("must not send"); }) as unknown as typeof fetch };
    f.config.combos!.auto!.targets.push({ provider: "b", model: "m" }, { provider: "c", model: "m" });
    const response = await f.dispatch(); await response.text();
    expect(response.status).toBe(500); expect(first).toBe(1); expect(second).toBe(1); expect(third).toBe(0);
    expect(f.budget.used).toBe(6); expect(f.charges).toBe(6); expect(f.refunds).toBe(0);
    expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 15 });
    expect(getActiveTurnCount()).toBe(0);
  }));
}
