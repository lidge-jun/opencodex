import { expect, test } from "bun:test";
import { createStepCliAdapter } from "../../src/adapters/step-cli/adapter";
import { ownedConversationHandle, withConversationLock } from "../../src/adapters/step-cli/conversation";
import { StepSessionError } from "../../src/adapters/step-cli/errors";
import { handleRuntimeEvent } from "../../src/adapters/step-cli/events";
import { currentTurn } from "../../src/adapters/step-cli/registry";
import type { AdapterEvent } from "../../src/types";
import { event, host, incoming, parsed, provider } from "../helpers/step-cli-ownership";

test("abandoning a held call cannot settle the replacement turn with the old query's completion", async () => {
  const pool = host();
  const adapter = createStepCliAdapter(provider, { openSession: pool });
  const emitted: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(parsed("caller-A"), incoming, () => {});
    const session = [...pool.entries.values()][0]!;
    let replacementOwned = false;
    let prematurelyDone = false;
    const sendInput = session.sendInput.bind(session);
    session.sendInput = async (queryId, text) => {
      prematurelyDone = emitted.some(e => e.type === "done");
      replacementOwned = !!currentTurn(session);
      await sendInput(queryId, text);
    };
    // resolveHeldToolResult queues the old completion before interrupt resolves. The replacement
    // receives its own completion only after sendInput observes whether its owner survived.
    session.capture = false;
    await adapter.runTurn!(parsed("caller-A"), incoming, e => emitted.push(e));
    expect(prematurelyDone).toBe(false);
    expect(replacementOwned).toBe(true);
    expect(session.inputs.map(input => input.queryId)).toEqual(["q_1", "q_2"]);
    expect(emitted.filter(e => e.type === "done")).toHaveLength(1);
    // A later replay of the old completion still cannot produce a second terminal event.
    handleRuntimeEvent(session, event("q_1", { type: "status", status: "turn_complete" }));
    expect(emitted.filter(e => e.type === "done")).toHaveLength(1);
  } finally { await pool.closeAll(); }
});

test("a cancelled queued turn leaves the shared session available without sending a query", async () => {
  const pool = host();
  const adapter = createStepCliAdapter(provider, { openSession: pool });
  const request = parsed("queued-caller");
  const handle = ownedConversationHandle(request, incoming, provider)!;
  await pool.open({ handle, sessionId: "" });
  const session = pool.entries.get(handle)!;
  session.capture = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = withConversationLock(handle, () => { entered.resolve(); return release.promise; });
  const controller = new AbortController();
  const events: AdapterEvent[] = [];
  try {
    await entered.promise;
    const queued = adapter.runTurn!(request, { ...incoming, abortSignal: controller.signal }, e => events.push(e));
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    release.resolve();
    await queued;
    expect(session.next).toBe(0);
    expect(session.inputs).toEqual([]);
    expect(events).toEqual([{ type: "error", message: "StepCode turn was aborted before start.", retryable: false }]);
    expect(session.closed).toBe(false);

    const next: AdapterEvent[] = [];
    await adapter.runTurn!(request, incoming, e => next.push(e));
    expect(next.filter(e => e.type === "done")).toHaveLength(1);
  } finally {
    release.resolve();
    await owner;
    await pool.closeAll();
  }
});

test.each(["busy retry", "input"] as const)("cancellation before query %s prevents further dispatch", async phase => {
  const pool = host();
  const adapter = createStepCliAdapter(provider, { openSession: pool });
  const request = parsed("dispatch-caller");
  const handle = ownedConversationHandle(request, incoming, provider)!;
  await pool.open({ handle, sessionId: "" });
  const session = pool.entries.get(handle)!;
  session.capture = false;
  const controller = new AbortController();
  const start = session.startQuery.bind(session);
  let starts = 0;
  session.startQuery = async () => {
    starts++;
    if (starts === 1) {
      controller.abort();
      if (phase === "busy retry") throw new StepSessionError("inert query busy", "step_cli_session_busy");
    }
    return start();
  };
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(request, { ...incoming, abortSignal: controller.signal }, e => events.push(e));
    expect(starts).toBe(1);
    expect(session.inputs).toEqual([]);
    expect(events.map(e => e.type)).toEqual(["error"]);
    expect(session.closed).toBe(phase === "input");
  } finally {
    await pool.closeAll();
  }
});
