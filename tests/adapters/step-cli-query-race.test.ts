import { expect, test } from "bun:test";
import { createStepCliAdapter } from "../../src/adapters/step-cli/adapter";
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