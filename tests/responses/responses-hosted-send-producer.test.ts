import { expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import type { IncomingMeta } from "../../src/adapters/base";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import { hostedSendFixture } from "../helpers/hosted-send-fixture";
import { existsSync } from "node:fs";
import * as spendOwner from "../../src/lib/spend-ledger-owner";

test("hosted fixture restores both homes and removes directories even when ownership assertion fails", async () => {
  const priorHome = process.env.OPENCODEX_HOME, priorCodex = process.env.CODEX_HOME;
  let home = "", codex = "";
  const snapshot = spyOn(spendOwner, "spendLedgerOwnerSnapshot").mockReturnValue({ ownership: "held" });
  try {
    await expect(hostedSendFixture("image", "failover", async () => {
      home = process.env.OPENCODEX_HOME!; codex = process.env.CODEX_HOME!;
    })).rejects.toThrow();
    expect(process.env.OPENCODEX_HOME).toBe(priorHome); expect(process.env.CODEX_HOME).toBe(priorCodex);
    expect(existsSync(home)).toBe(false); expect(existsSync(codex)).toBe(false);
  } finally { snapshot.mockRestore(); }
  expect(spendOwner.spendLedgerOwnerSnapshot().ownership).toBe("unheld");
  await hostedSendFixture("image", "failover", async () => {
    expect(spendOwner.spendLedgerOwnerSnapshot().ownership).toBe("held");
  });
});

/** Expose a producer gate so tests control dispatch after response construction. */
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
/** Fail a stalled synthetic producer and always clear its deadline timer. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic producer did not finish")), 2000); })])
    .finally(() => clearTimeout(timer));
}
/** Exercise adapter-owned physical admission and consume the synthetic response. */
async function dispatch(incoming: IncomingMeta) {
  const send = createAdapterPhysicalSend({ sendBudget: incoming.sendBudget, executor: incoming.providerFetch,
    abortSignal: incoming.abortSignal, onPhysicalSend: incoming.onPhysicalSend });
  const response = await send({ url: "https://synthetic.invalid/v1/chat/completions", dispatch: executor => executor(
    "https://synthetic.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }), signal: incoming.abortSignal }) });
  await response.text();
}
for (const strategy of ["failover", "jev"] as const) test(`search/${strategy} runTurn retains its ordinary producer-owned durable booking`, async () => hostedSendFixture("search", strategy, async f => {
  const create = ADAPTER_REGISTRY["openai-chat"].create;
  const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args), reportsPhysicalSends: true,
    async runTurn(_parsed, incoming, emit) {
      await dispatch(incoming); emit({ type: "text_delta", text: "hosted search producer final answer" }); emit({ type: "done" });
    },
  }));
  try {
    const response = await f.dispatch(); expect(response.status).toBe(200); expect(await response.text()).toContain("hosted search producer final answer");
    expect(f.inference).toBe(1); expect(f.judge).toBe(strategy === "jev" ? 1 : 0);
    expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
    expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 0 }); expect(getActiveTurnCount()).toBe(0);
  } finally { override.mockRestore(); }
}));
for (const kind of ["image", "video"] as const) {
  for (const mode of ["delayed", "cancel-before", "cancel-after", "unsent-error", "sent-error", "not-dispatched"] as const) {
    test(`${kind} asynchronous producer ${mode} owns its booking until dispatch or exit`, async () => hostedSendFixture(kind, "failover", async f => {
      const gate = deferred(), entered = deferred(), sent = deferred(), finished = deferred();
      const create = ADAPTER_REGISTRY["openai-chat"].create;
      const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args), reportsPhysicalSends: true,
        async runTurn(_parsed, incoming, emit) {
          entered.resolve();
          try {
            await Promise.race([gate.promise, new Promise<void>(resolve => {
              if (incoming.abortSignal?.aborted) resolve();
              else incoming.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            })]);
            if (incoming.abortSignal?.aborted) return;
            if (mode === "unsent-error") throw new Error("synthetic unsent producer error");
            if (mode !== "not-dispatched") { await dispatch(incoming); sent.resolve(); }
            if (mode === "sent-error") throw new Error("synthetic post-dispatch error");
            if (mode === "cancel-after") await new Promise<void>(resolve => {
              if (incoming.abortSignal?.aborted) resolve();
              else incoming.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            else { emit({ type: "text_delta", text: "hosted producer final answer" }); emit({ type: "done" }); }
          } finally { finished.resolve(); }
        },
      }));
      try {
        const response = await f.dispatchChild();
        expect(response.status).toBe(200);
        // Response exists while the asynchronous producer has not dispatched inference.
        expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0); expect(f.inference).toBe(0);
        const reading = response.body!.getReader();
        await reading.read(); // response.created starts the bridge without requiring inference.
        const pending = reading.read();
        await bounded(entered.promise);
        if (mode === "cancel-before") { await reading.cancel(); }
        else {
          gate.resolve();
          if (mode === "cancel-after") { await bounded(sent.promise); await reading.cancel(); }
          else { await bounded(pending); while (!(await reading.read()).done) { /* drain terminal */ } }
        }
        await bounded(finished.promise);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        const didSend = mode === "delayed" || mode === "cancel-after" || mode === "sent-error";
        expect(f.inference).toBe(didSend ? 1 : 0); expect(f.budget.used).toBe(didSend ? 1 : 0);
        expect(f.charges).toBe(1); expect(f.refunds).toBe(didSend ? 0 : 1);
        expect(f.settle()).toMatchObject({ settled: didSend ? 3 : 0, reserved: 0, unresolved: 0 });
        expect(getActiveTurnCount()).toBe(0);
      } finally { gate.resolve(); override.mockRestore(); }
    }));
  }
  test(`${kind} cancellation before producer startup refunds its booking once`, async () => hostedSendFixture(kind, "failover", async f => {
    let entered = 0;
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args),
      async runTurn() { entered++; },
    }));
    try {
      const response = await f.dispatchChild(); await response.body!.cancel();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(entered).toBe(0); expect(f.inference).toBe(0); expect(f.budget.used).toBe(0);
      expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
      expect(f.settle()).toMatchObject({ settled: 0, reserved: 0, unresolved: 0 }); expect(getActiveTurnCount()).toBe(0);
    } finally { override.mockRestore(); }
  }));
  test(`${kind} synchronous producer throw releases its unsent booking once`, async () => hostedSendFixture(kind, "failover", async f => {
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args),
      runTurn() { throw new Error("synthetic synchronous producer failure"); },
    }));
    try {
      const response = await f.dispatchChild();
      expect(await response.text()).toContain("synthetic synchronous producer failure");
      expect(f.inference).toBe(0); expect(f.budget.used).toBe(0); expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
      expect(f.settle()).toMatchObject({ settled: 0, reserved: 0, unresolved: 0 }); expect(getActiveTurnCount()).toBe(0);
    } finally { override.mockRestore(); }
  }));
  test(`${kind} unsent producer failure refunds before real next-target inference`, async () => hostedSendFixture(kind, "failover", async f => {
    f.config.providers.a!.headers = { "x-synthetic-unsent": "first" };
    f.config.providers.b = { ...f.config.providers.a!, headers: {} };
    f.config.combos!.auto!.targets.push({ provider: "b", model: "m" });
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({ ...create(...args), reportsPhysicalSends: true,
      async runTurn(_parsed, incoming, emit) {
        if (args[0].headers?.["x-synthetic-unsent"]) throw new Error("synthetic unsent first target");
        await dispatch(incoming);
        emit({ type: "text_delta", text: "next hosted target final answer" }); emit({ type: "done" });
      },
    }));
    try {
      const response = await f.dispatch(); expect(response.status).toBe(200); expect(await response.text()).toContain("next hosted target final answer");
      expect(f.inference).toBe(1); expect(f.budget.used).toBe(1); expect(f.charges).toBe(2); expect(f.refunds).toBe(1);
      expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 0 }); expect(getActiveTurnCount()).toBe(0);
    } finally { override.mockRestore(); }
  }));
}
