import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function* toolTurn(name: string, argumentsText = '{"cmd":"ls"}'): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-1", name } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-1", arguments: argumentsText } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-1" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

// #2493: Codex 0.149 declares the shell tool as `exec`, whose own description names the
// nested `tools.exec_command(...)` helper. Routed models echo the helper name back, and the
// undeclared-tool guard turned that into a 502 mid-turn. These pin the SSE path the guard
// actually runs on, which the review flagged as untested.
describe("bridge normalizes code-mode helper names against the declared catalog", () => {
  test("exec_command is delivered as the declared exec instead of failing the turn", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("exec_command"), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.exec_command({\\"cmd\\":\\"ls\\"})');
    expect(sse).not.toContain('"input":"{\\"cmd\\":\\"ls\\"}"');
  });

  test("shell_command normalizes the same way", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("shell_command"), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.exec_command({\\"cmd\\":\\"ls\\"})');
  });

  test("write_stdin is wrapped through the declared exec tool", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("write_stdin", '{"session_id":17,"yield_time_ms":1000}'),
      "fixture-model",
      undefined,
      new Set(["exec"]),
      undefined,
      undefined,
      50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.write_stdin({\\"session_id\\":17,\\"yield_time_ms\\":1000})');
  });

  test("a genuinely undeclared tool still fails the turn", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("other_tool"), "deepseek-x", undefined, undefined, undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).toContain("undeclared client tool");
  });

  test("apply_patch is wrapped through the declared exec tool", async () => {
    async function* patchTurn(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call-patch", name: "apply_patch" } as AdapterEvent;
      yield { type: "tool_call_delta", id: "call-patch", arguments: "*** Begin Patch\n*** Add File: note.txt\n+ok\n*** End Patch" } as AdapterEvent;
      yield { type: "tool_call_end", id: "call-patch" } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    }
    const sse = await drain(bridgeToResponsesSSE(
      patchTurn(), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain("await tools.apply_patch");
  });

  test("a catalog that declares exec_command itself is never rewritten", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("exec_command"), "deepseek-x", undefined, undefined, undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec", "exec_command"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec_command"');
    expect(sse).toContain('"arguments":"{\\"cmd\\":\\"ls\\"}"');
  });
});
