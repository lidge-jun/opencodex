import { expect, test } from "bun:test";
import {
  createTranslatorBudget, finalizeTranslatorBudgetResponse, translatorLiveBudgetCountForTests,
  translatorObservedBufferSnapshot,
} from "../../src/lib/translator-budget";
import { finalizeOwnedTranslatorBudget } from "../../src/server/responses/core-lifetime";
import {
  markNativePassthroughSseResponse, isNativePassthroughSseResponse,
  markEagerRelaySseResponse, isEagerRelaySseResponse,
  markPreinspectedJsonResponse, isPreinspectedJsonResponse,
} from "../../src/server/relay";

for (const [kind, wrap] of [
  ["shared Chat/Messages", finalizeTranslatorBudgetResponse],
  ["Responses", finalizeOwnedTranslatorBudget],
] as const) {
  for (const mode of ["before", "after", "cancel"] as const) {
    test(`${kind}: ${mode} releases unread accounting while producer cancellation is held`, async () => {
      const baseline = translatorLiveBudgetCountForTests();
      const aggregate = translatorObservedBufferSnapshot();
      const budget = createTranslatorBudget();
      budget.openCall("call");
      budget.chargeRetained(512, { kind: "tool_args", callId: "call" });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let cancellations = 0;
      const original = new Response(new ReadableStream({ cancel() { cancellations++; return held; } }));
      const controller = new AbortController();
      if (mode === "before") controller.abort();
      const response = wrap(original, budget, controller.signal);
      let cancelled: Promise<void> | undefined;
      try {
        if (mode !== "before") expect(translatorLiveBudgetCountForTests()).toBe(baseline + 1);
        if (mode === "after") controller.abort();
        if (mode === "cancel") cancelled = response.body!.cancel("client gone");
        await Promise.resolve();
        expect(translatorLiveBudgetCountForTests()).toBe(baseline);
        expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
        expect(translatorObservedBufferSnapshot()).toMatchObject({ currentBytes: aggregate.currentBytes, active: aggregate.active });
        expect(cancellations).toBe(mode === "cancel" ? 1 : 0);
      } finally {
        cancelled ??= response.body!.cancel("cleanup");
        release();
        await cancelled;
        budget.dispose();
      }
      expect(cancellations).toBe(1);
      expect(translatorLiveBudgetCountForTests()).toBe(baseline);
    });
  }

  for (const status of [200, 499, 504]) {
    test(`${kind}: already aborted prepared ${status} retains bytes, status and headers`, async () => {
      const baseline = translatorLiveBudgetCountForTests();
      const budget = createTranslatorBudget();
      budget.observeAcceptedRequestCopy(1024);
      const controller = new AbortController();
      controller.abort();
      const response = wrap(new Response("prepared verdict", { status, statusText: "Fixture", headers: { "x-fixture": "kept" } }), budget, controller.signal);
      try {
        expect(translatorLiveBudgetCountForTests()).toBe(baseline);
        expect(budget.snapshot().currentBytes).toBe(0);
        expect(response.status).toBe(status);
        expect(response.statusText).toBe("Fixture");
        expect(response.headers.get("x-fixture")).toBe("kept");
        expect(await response.text()).toBe("prepared verdict");
      } finally { await response.body?.cancel().catch(() => {}); budget.dispose(); }
    });
  }

  test(`${kind}: EOF and reader errors finalize once and detach the abort observer`, async () => {
    const baseline = translatorLiveBudgetCountForTests();
    const budget = createTranslatorBudget();
    const controller = new AbortController();
    const response = wrap(new Response("EOF", { headers: { "x-fixture": "kept" } }), budget, controller.signal);
    expect(await response.text()).toBe("EOF");
    expect(response.headers.get("x-fixture")).toBe("kept");
    expect(translatorLiveBudgetCountForTests()).toBe(baseline);
    controller.abort();
    const errorBudget = createTranslatorBudget();
    const errorController = new AbortController();
    const broken = wrap(new Response(new ReadableStream({ pull(c) { c.error(new Error("producer failed")); } })), errorBudget, errorController.signal);
    await expect(broken.text()).rejects.toThrow("producer failed");
    expect(translatorLiveBudgetCountForTests()).toBe(baseline);
    errorController.abort();
  });
}

for (const operation of ["open", "reserve", "commit", "charge", "observe"] as const) {
  test(`disposed budget ignores late ${operation} without resurrecting either accounting scope`, () => {
    const aggregate = translatorObservedBufferSnapshot();
    const budget = createTranslatorBudget({ maxTurnBytes: 4096, maxCallArgumentBytes: 4096 });
    budget.openCall("prior");
    const prior = budget.reserveTransient(32, { kind: "tool_args", callId: "prior" });
    const observed = budget.observeAcceptedRequestCopy(64);
    budget.dispose();
    try {
      if (operation === "open") budget.openCall("late");
      if (operation === "reserve") budget.reserveTransient(8192, { kind: "tool_args", callId: "late" }).commitRetained();
      if (operation === "commit") prior.commitRetained();
      if (operation === "charge") budget.chargeRetained(8192, { kind: "retained_collectors" });
      if (operation === "observe") {
        const accepted = budget.observeAcceptedRequestCopy(128);
        const external = budget.observeExternallyCapped("mcp_payload", 256);
        try { expect(budget.snapshot().currentBytes).toBe(0); }
        finally { accepted(); external(); }
      }
      prior.release();
      observed();
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, overflows: 0 });
      expect(translatorObservedBufferSnapshot()).toMatchObject({ currentBytes: aggregate.currentBytes, active: aggregate.active });
    } finally { budget.dispose(); }
  });
}

for (const [mark, inspect] of [
  [markNativePassthroughSseResponse, isNativePassthroughSseResponse],
  [markEagerRelaySseResponse, isEagerRelaySseResponse],
  [markPreinspectedJsonResponse, isPreinspectedJsonResponse],
] as const) {
  test(`Responses retains ${inspect.name} through budget wrapping`, async () => {
    const source = mark(new Response("unchanged"));
    const budget = createTranslatorBudget();
    const wrapped = finalizeOwnedTranslatorBudget(source, budget);
    expect(inspect(wrapped)).toBe(true);
    expect(await wrapped.text()).toBe("unchanged");
  });
}

for (const surface of ["responses", "chat-completions", "claude-messages"] as const) {
  test(`${surface}: HTTP owner links request abort to its unread response budget`, async () => {
    const handle = surface === "responses"
      ? (await import("../../src/server/responses")).handleResponses
      : surface === "chat-completions"
        ? (await import("../../src/server/chat-completions")).handleChatCompletions
        : (await import("../../src/server/claude-messages")).handleClaudeMessages;
    const baseline = translatorLiveBudgetCountForTests();
    const controller = new AbortController();
    const response = await handle(new Request("http://localhost/v1/fixture", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{", signal: controller.signal,
    }), { port: 0, defaultProvider: "fixture", providers: {} }, { model: "", provider: "" });
    try {
      expect(response.status).toBe(400);
      expect(translatorLiveBudgetCountForTests()).toBe(baseline + 1);
      controller.abort();
      expect(translatorLiveBudgetCountForTests()).toBe(baseline);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).toContain("error");
    } finally { await response.body?.cancel().catch(() => {}); }
  });
}
