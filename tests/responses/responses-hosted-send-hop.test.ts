import { expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import * as transport from "../../src/server/responses/request-transport";
import * as oauth from "../../src/oauth/generic-account-failover";
import { hostedSendFixture } from "../helpers/hosted-send-fixture";
import { chatStream } from "../helpers/combo-failover-upstream";

for (const kind of ["search", "image", "video"] as const) for (const owned of [false, true]) for (const unsent of [false, true]) {
  test(`${kind} ${owned ? "adapter" : "generic"} OAuth hop ${unsent ? "unsent cleanup refunds once" : "dispatch consumes its own booking once"}`, async () => hostedSendFixture(kind, "failover", async f => {
    delete f.config.providers.a!.transientRetryOn5xx;
    let calls = 0, rotated = false;
    f.config.providers.a!.fetch = (async () => ++calls === 1
      ? Response.json({ error: { message: "synthetic rate refusal" } }, { status: 429 }) : chatStream("hop final answer")) as unknown as typeof fetch;
    // Credential selection is synthetic; dispatch, receipts, shared budget and journal are real.
    const prepare = transport.prepareResponsesTransport;
    const prepared = spyOn(transport, "prepareResponsesTransport").mockImplementation(async (...args) => {
      const state = await prepare(...args);
      if (state instanceof Response) return state;
      state.genericFailoverAccountId = "synthetic-first";
      state.applyFailoverSnapshot = async snapshot => { rotated = true; return snapshot; };
      return state;
    });
    const enabled = spyOn(oauth, "isGenericOAuthFailoverEnabled").mockReturnValue(true);
    const rotate = spyOn(oauth, "rotateGenericOAuthAccountOn429").mockReturnValue("synthetic-second");
    const snapshot = spyOn(oauth, "failoverAccountSnapshot").mockResolvedValue({ provider: "a", accountId: "synthetic-second", generation: "synthetic-generation", accessToken: "synthetic-token" });
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const adapter = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => {
      const base = create(...args);
      return { ...base,
        buildRequest(...input) {
          if (unsent && rotated) throw new Error("synthetic unsent hop build refusal");
          return base.buildRequest(...input);
        },
        ...(owned ? { async fetchResponse(request, ctx) {
          const send = createAdapterPhysicalSend(ctx);
          return send({ url: request.url, dispatch: executor => executor(request.url, {
            method: request.method, headers: request.headers, body: request.body, signal: ctx?.abortSignal,
          }) });
        } } : {}),
      };
    });
    try {
      const response = await f.dispatch(); const body = await response.text();
      expect(response.status).toBe(unsent ? 502 : 200);
      expect(body).toContain(unsent ? "synthetic unsent hop build refusal" : "hop final answer");
      expect(calls).toBe(unsent ? 1 : 2); expect(f.budget.used).toBe(unsent ? 1 : 2);
      expect(f.charges).toBe(2); expect(f.refunds).toBe(unsent ? 1 : 0);
      expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: unsent ? 0 : 3 });
      expect(getActiveTurnCount()).toBe(0);
    } finally { adapter.mockRestore(); snapshot.mockRestore(); rotate.mockRestore(); enabled.mockRestore(); prepared.mockRestore(); }
  }));
}
