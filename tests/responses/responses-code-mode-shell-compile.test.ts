import { describe, expect, test } from "bun:test";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../../src/responses/code-mode-helper-compat";
import { restoreRoutedCustomCallsInJson } from "../../src/responses/custom-tool-compat";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
import { createRoutedCustomToolRestoreBlockRewrite } from "../../src/server/responses-custom-tool-repair";
import { dataPayload, frame } from "../helpers/custom-tool-repair-fixtures";

const CODE_MODE = new Set(["exec"]);
const COMMAND = 'cd "/tmp/example repo" && git status --short';

describe("structured shell arguments submitted to code-mode exec", () => {
  test("compiles the observed cmd object without losing shell options", async () => {
    const args = { cmd: COMMAND, workdir: "/tmp", yield_time_ms: 1000, max_output_tokens: 2000 };
    const body = JSON.stringify(args);
    expect(resolveCodeModeHelperName(undefined, "exec", body, undefined, CODE_MODE)).toBe("exec_command");
    const restored = JSON.parse(restoreRoutedCustomCallsInJson(JSON.stringify({
      output: [{ type: "function_call", id: "fc_shell", call_id: "call_shell", name: "exec", arguments: body }],
    }), CODE_MODE, new Set(), CODE_MODE));
    const item = restored.output[0];
    expect(item).toMatchObject({ type: "custom_tool_call", name: "exec", call_id: "call_shell" });
    const calls: unknown[] = [];
    const outputs: unknown[] = [];
    const run = new Function("tools", "text", `return (async () => { ${item.input} })();`);
    await run({ exec_command: async (value: unknown) => { calls.push(value); return { output: "ok" }; } },
      (value: unknown) => outputs.push(value));
    expect(calls).toEqual([args]);
    expect(outputs).toEqual([{ output: "ok" }]);
  });

  test("the canonical input wrapper and command alias use the same shell payload", () => {
    for (const args of [{ cmd: COMMAND }, { command: COMMAND }]) {
      for (const body of [JSON.stringify(args), JSON.stringify({ input: JSON.stringify(args) })]) {
        const helper = resolveCodeModeHelperName(undefined, "exec", body, undefined, CODE_MODE);
        expect(helper).toBe("exec_command");
        expect(compileCodeModeHelperInput(body, helper!, "exec"))
          .toBe(`const result = await tools.exec_command(${JSON.stringify({ cmd: COMMAND })});\ntext(result);`);
      }
    }
  });

  test("leaves JavaScript, ambiguous objects and unrelated catalogs alone", () => {
    for (const body of [
      'text("hello")',
      JSON.stringify({ cmd: 'await tools.exec_command({ cmd: "pwd" });' }),
      JSON.stringify({ command: 'text("hello")' }),
      JSON.stringify({ cmd: "ls" }), // Also a valid JavaScript identifier: do not guess.
      JSON.stringify({ input: "text(1)", cmd: COMMAND }),
      JSON.stringify({ cmd: COMMAND, code: "text(1)" }),
      JSON.stringify({ cmd: COMMAND, command: "echo other" }),
      JSON.stringify({ cmd: COMMAND, unknownOption: true }),
      JSON.stringify({ cmd: 42 }),
      JSON.stringify([{ cmd: COMMAND }]),
      '{"cmd":',
    ]) expect(resolveCodeModeHelperName(undefined, "exec", body, undefined, CODE_MODE)).toBeUndefined();
    for (const declared of [undefined, new Set(["exec", "shell_command"]), new Set(["mcp__exec"])]) {
      expect(resolveCodeModeHelperName(undefined, "exec", JSON.stringify({ cmd: COMMAND }), undefined, declared)).toBeUndefined();
    }
    expect(resolveCodeModeHelperName(undefined, "exec", JSON.stringify({ cmd: COMMAND }), "mcp", CODE_MODE)).toBeUndefined();
  });

  test("shell metacharacters remain data passed to the nested tool", async () => {
    const args = { cmd: 'printf "%s" "`id` $(whoami)"\n# ${text("not source")}', tty: false };
    const body = JSON.stringify(args);
    const helper = resolveCodeModeHelperName(undefined, "exec", body, undefined, CODE_MODE);
    expect(helper).toBe("exec_command");
    const calls: unknown[] = [];
    const run = new Function("tools", "text", `return (async () => { ${compileCodeModeHelperInput(body, helper!, "exec")} })();`);
    await run({ exec_command: async (value: unknown) => { calls.push(value); return "ok"; } }, () => {});
    expect(calls).toEqual([args]);
  });

  test("Chat adapter JSON and fragmented SSE deliver the same executable call", async () => {
    const args = { cmd: COMMAND, workdir: "/tmp" };
    const expected = `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);`;
    for (const body of [JSON.stringify(args), JSON.stringify({ input: JSON.stringify(args) })]) {
      async function* events(): AsyncGenerator<AdapterEvent> {
        yield { type: "tool_call_start", id: "call-shell", name: "exec" };
        for (const arguments_ of body) yield { type: "tool_call_delta", id: "call-shell", arguments: arguments_ };
        yield { type: "tool_call_end", id: "call-shell" };
        yield { type: "done" };
      }
      const options = { declaredToolNames: CODE_MODE };
      const collected: AdapterEvent[] = [];
      for await (const event of events()) collected.push(event);
      const json = buildResponseJSON(collected, "fixture", { ...options, freeformToolNames: CODE_MODE });
      expect(json.output).toMatchObject([{ type: "custom_tool_call", name: "exec", input: expected }]);
      const stream = bridgeToResponsesSSE(events(), "fixture", undefined, CODE_MODE, undefined, undefined, 50_000, options);
      const text = await new Response(stream).text();
      const payloads = text.split(/\r?\n\r?\n/).filter(block => block.includes("data: {")).map(dataPayload);
      const preview = payloads.filter(p => p.type === "response.custom_tool_call_input.delta").map(p => p.delta).join("");
      expect(expected.startsWith(preview)).toBe(true);
      expect(payloads.find(p => p.type === "response.custom_tool_call_input.done")?.input).toBe(expected);
      expect(payloads.find(p => p.type === "response.output_item.done")?.item).toMatchObject({ input: expected });
      expect(payloads.find(p => p.type === "response.completed")?.response).toMatchObject({ output: [{ input: expected }] });
    }
  });

  test("native and lowered Responses streams agree at every split boundary", () => {
    const args = { cmd: COMMAND };
    const expected = `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);`;
    for (const native of [false, true]) {
      for (const body of [JSON.stringify(args), JSON.stringify({ input: JSON.stringify(args) })]) {
        for (let split = 0; split <= body.length; split++) {
          const rewrite = createRoutedCustomToolRestoreBlockRewrite(CODE_MODE, undefined, new Set(), CODE_MODE);
          const type = native ? "custom_tool_call" : "function_call";
          const field = native ? "input" : "arguments";
          const event = native ? "response.custom_tool_call_input" : "response.function_call_arguments";
          const item = { type, id: "fc_shell", call_id: "call_shell", name: "exec", [field]: body };
          try {
            rewrite(frame("response.output_item.added", { output_index: 0, item: { ...item, [field]: "" } }));
            let preview = "";
            for (const delta of [body.slice(0, split), body.slice(split)]) {
              preview += rewrite(frame(`${event}.delta`, { output_index: 0, item_id: "fc_shell", delta }))
                .map(block => dataPayload(block).delta ?? "").join("");
            }
            expect(preview).toBe("");
            const done = rewrite(frame(`${event}.done`, { output_index: 0, item_id: "fc_shell", [field]: body }));
            expect(dataPayload(done[0]!).input).toBe(expected);
            const itemDone = rewrite(frame("response.output_item.done", { output_index: 0, item }));
            expect(dataPayload(itemDone[0]!).item).toMatchObject({ input: expected, call_id: "call_shell" });
            const terminal = rewrite(frame("response.completed", { response: { output: [item] } }));
            expect(dataPayload(terminal[0]!).response).toMatchObject({ output: [{ input: expected }] });
          } finally {
            rewrite.dispose?.();
          }
        }
      }
    }
  });

  test("canonical JavaScript retains progressive output under a code-mode catalog", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(CODE_MODE, undefined, new Set(), CODE_MODE);
    try {
      rewrite(frame("response.output_item.added", {
        output_index: 0,
        item: { type: "function_call", id: "fc_js", call_id: "call_js", name: "exec", arguments: "" },
      }));
      let preview = "";
      for (const delta of ['{"input":"text(', '1)', '"}']) {
        preview += rewrite(frame("response.function_call_arguments.delta", { item_id: "fc_js", delta }))
          .map(block => dataPayload(block).delta ?? "").join("");
        expect(preview.length).toBeGreaterThan(0);
      }
      expect(preview).toBe("text(1)");
    } finally {
      rewrite.dispose?.();
    }
  });
});
