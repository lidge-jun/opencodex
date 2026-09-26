/**
 * Keyless Zen tier gate-call redirection (#4121 follow-up): when the model
 * calls a shell/read compatibility declaration the client never made, the
 * passthrough relay substitutes guidance instead of failing the turn.
 * Without the redirect (every other route), the same frames fail closed
 * exactly as before.
 */
import { describe, expect, test } from "bun:test";
import {
  createUndeclaredToolCallGuardBlockRewrite,
  type UndeclaredGateRedirect,
} from "../../src/server/responses-undeclared-tool-guard";

const DECLARED = new Set(["exec", "wait"]);
const REDIRECT: UndeclaredGateRedirect = {
  names: new Set(["shell", "read"]),
  message: (name: string) => `GUIDE:${name}`,
};

function rewrite(redirect?: UndeclaredGateRedirect) {
  return createUndeclaredToolCallGuardBlockRewrite(DECLARED, new Set(), new Set(), undefined, redirect);
}

/** One SSE event block without its blank-line delimiter. */
function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;
}

function shellAdded(outputIndex = 2): string {
  return frame("response.output_item.added", {
    output_index: outputIndex,
    item: { id: "fc_1", type: "function_call", status: "in_progress", name: "shell", call_id: "call_1", arguments: "" },
  });
}

function shellDelta(): string {
  return frame("response.function_call_arguments.delta", {
    output_index: 2,
    item_id: "fc_1",
    delta: '{"command":"hi"}',
  });
}

function shellDone(): string {
  return frame("response.output_item.done", {
    output_index: 2,
    item: { id: "fc_1", type: "function_call", status: "completed", name: "shell", call_id: "call_1", arguments: '{"command":"hi"}' },
  });
}

function parseData(block: string): Record<string, unknown> {
  const line = block.split("\n").find(l => l.startsWith("data: "))!;
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

describe("zen-free gate-call redirection", () => {
  test("a gate call becomes guidance frames, follow-ups are dropped", () => {
    const guard = rewrite(REDIRECT);
    const out = guard(shellAdded());
    // added + content_part.added + delta + content_part.done + done
    expect(out).toHaveLength(5);
    const added = parseData(out[0]!);
    expect(added.type).toBe("response.output_item.added");
    const item = added.item as Record<string, unknown>;
    expect(item.type).toBe("message");
    expect(item.role).toBe("assistant");
    const done = parseData(out[4]!);
    expect(done.type).toBe("response.output_item.done");
    const doneItem = done.item as Record<string, unknown>;
    expect(doneItem.status).toBe("completed");
    const content = doneItem.content as Array<{ text?: unknown }>;
    expect(content[0]?.text).toBe("GUIDE:shell");
    // Follow-up frames for the suppressed call vanish; the turn stays alive.
    expect(guard(shellDelta())).toEqual([]);
    expect(guard(shellDone())).toEqual([]);
    expect(guard(frame("response.completed", { response: { status: "completed", output: [] } }))).toHaveLength(1);
  });

  test("declared calls pass through untouched under a redirect", () => {
    const guard = rewrite(REDIRECT);
    const block = frame("response.output_item.added", {
      output_index: 3,
      item: { id: "fc_2", type: "function_call", status: "in_progress", name: "exec", call_id: "call_2", arguments: "" },
    });
    expect(guard(block)).toEqual([block]);
  });

  test("a client-declared shell is never redirected", () => {
    // The client owns a real shell tool: same factory, but the declared
    // catalog names it, so its frames must survive verbatim.
    const owned = createUndeclaredToolCallGuardBlockRewrite(
      new Set(["exec", "shell"]),
      new Set(),
      new Set(),
      undefined,
      REDIRECT,
    );
    const block = shellAdded();
    expect(owned(block)).toEqual([block]);
    expect(owned(shellDelta())).toEqual([shellDelta()]);
    expect(owned(shellDone())).toEqual([shellDone()]);
  });

  test("non-gate undeclared calls still fail with a redirect configured", () => {
    const guard = rewrite(REDIRECT);
    const out = guard(frame("response.output_item.added", {
      output_index: 4,
      item: { id: "fc_9", type: "function_call", status: "in_progress", name: "frobnicate", call_id: "call_9", arguments: "" },
    }));
    expect(out.join("\n")).toContain("response.failed");
    expect(out.join("\n")).toContain("frobnicate");
  });

  test("without a redirect the gate call fails exactly as before", () => {
    const guard = rewrite(undefined);
    const out = guard(shellAdded());
    expect(out.join("\n")).toContain("response.failed");
    expect(out.join("\n")).toContain("undeclared_tool_call");
  });

  test("the completed snapshot drops suppressed calls and replaces sparse ones", () => {
    const guard = rewrite(REDIRECT);
    guard(shellAdded());
    guard(shellDelta());
    const completed = frame("response.completed", {
      response: {
        status: "completed",
        output: [
          { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [] },
          { id: "fc_1", type: "function_call", status: "completed", name: "shell", call_id: "call_1", arguments: "{}" },
          { id: "fc_8", type: "function_call", status: "completed", name: "read", call_id: "call_8", arguments: "{}" },
          { id: "fc_2", type: "function_call", status: "completed", name: "exec", call_id: "call_2", arguments: "{}" },
        ],
      },
    });
    const out = guard(completed);
    expect(out).toHaveLength(1);
    const body = parseData(out[0]!);
    expect(body.type).toBe("response.completed");
    const output = (body.response as { output: Array<{ id?: unknown; type?: unknown; name?: unknown }> }).output;
    // fc_1 was seen incrementally: dropped. fc_8 is sparse (first sighting
    // here): replaced in place. exec survives.
    const names = output.map(item => item.type === "message" ? `message:${(item.content as Array<{ text?: unknown }>)?.[0]?.text}` : item.name);
    expect(names).toContain("message:GUIDE:read");
    expect(names).toContain("exec");
    expect(names.some(n => typeof n === "string" && n.includes("shell"))).toBe(false);
    expect(output.some(item => item.id === "fc_1")).toBe(false);
  });
});
