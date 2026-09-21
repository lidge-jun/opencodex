import { describe, expect, test } from "bun:test";
import {
  collectRoutedCustomToolNames,
  restoreRoutedCustomCallsInJson,
  rewriteRoutedCustomToolsForUpstream,
} from "../../src/responses/custom-tool-compat";
import { compileCodeModeHelperInput } from "../../src/responses/code-mode-helper-compat";
import { createRoutedCustomToolRestoreBlockRewrite } from "../../src/server/responses-custom-tool-repair";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { CANONICAL_PATCH, DECORATED_PATCH, WRAPPED_DECORATED_PATCH, dataPayload, frame } from "../helpers/custom-tool-repair-fixtures";

describe("routed Responses custom-tool compatibility", () => {
  test("restores legacy structured shell aliases as executable unified-exec input", () => {
    const declared = new Set(["exec"]);
    const upstream = JSON.stringify({
      id: "resp_shell",
      output: [{
        type: "function_call",
        id: "fc_shell",
        call_id: "call_shell",
        name: "shell_command",
        arguments: JSON.stringify({ command: "printf '%s' \\\"$HOME\\\"", workdir: "/tmp" }),
        status: "completed",
      }],
    });

    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      upstream,
      new Set(["exec"]),
      new Set(),
      declared,
    )) as { output: Array<Record<string, unknown>> };
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: compileCodeModeHelperInput(
        JSON.stringify({ command: "printf '%s' \\\"$HOME\\\"", workdir: "/tmp" }),
        "shell_command",
      ),
    });
    expect(restored.output[0]).not.toHaveProperty("arguments");
  });

  test("restores a native apply_patch stream through unified exec", () => {
    const declared = new Set(["exec"]);
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]),
      undefined,
      new Set(),
      declared,
    );
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "ctc_patch_alias",
        call_id: "call_patch_alias",
        name: "apply_patch",
        input: "",
        status: "in_progress",
      },
    }));
    expect(dataPayload(added[0]!).item).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: "",
    });

    expect(rewrite(frame("response.custom_tool_call_input.delta", {
      output_index: 0,
      item_id: "ctc_patch_alias",
      delta: CANONICAL_PATCH,
    }))).toEqual([]);
    const inputDone = rewrite(frame("response.custom_tool_call_input.done", {
      output_index: 0,
      item_id: "ctc_patch_alias",
      input: CANONICAL_PATCH,
    }));
    expect(dataPayload(inputDone[0]!).input).toBe(
      compileCodeModeHelperInput(CANONICAL_PATCH, "apply_patch"),
    );

    const itemDone = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "ctc_patch_alias",
        call_id: "call_patch_alias",
        name: "apply_patch",
        input: CANONICAL_PATCH,
        status: "completed",
      },
    }));
    expect(dataPayload(itemDone[0]!).item).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: compileCodeModeHelperInput(CANONICAL_PATCH, "apply_patch"),
    });
    rewrite.dispose?.();
  });

  // A raw patch envelope submitted as the `exec` body is recompiled at the done event, so
  // the progressive deltas must be held: streaming the envelope bytes and then replacing them
  // with compiled helper JavaScript is the rewind this path forbids.
  // See devlog/_plan/260905_apply_patch_envelope_gap.
  test("holds envelope deltas and compiles a raw exec patch body on the native stream", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]),
      undefined,
      new Set(),
      new Set(["exec"]),
    );
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_raw_patch",
        call_id: "call_raw_patch",
        name: "exec",
        arguments: "",
        status: "in_progress",
      },
    }));

    // Every envelope delta is suppressed rather than previewed.
    for (const chunk of [WRAPPED_DECORATED_PATCH.slice(0, 20), WRAPPED_DECORATED_PATCH.slice(20)]) {
      expect(rewrite(frame("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_raw_patch",
        delta: chunk,
      }))).toEqual([]);
    }

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_raw_patch",
      arguments: WRAPPED_DECORATED_PATCH,
    }));
    expect(dataPayload(done[0]!).input).toBe(
      compileCodeModeHelperInput(CANONICAL_PATCH, "apply_patch"),
    );
    rewrite.dispose?.();
  });

  test("keeps progressive deltas for ordinary exec JavaScript", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]),
      undefined,
      new Set(),
      new Set(["exec"]),
    );
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_plain_js",
        call_id: "call_plain_js",
        name: "exec",
        arguments: "",
        status: "in_progress",
      },
    }));

    const source = "const marker = 1;\ntext(marker);";
    const wrapped = JSON.stringify({ input: source });
    const emitted = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_plain_js",
      delta: wrapped,
    }));
    expect(emitted.length).toBe(1);
    expect(dataPayload(emitted[0]!).delta).toBe(source);
    rewrite.dispose?.();
  });

  test.each([
    { label: "native raw exec", native: true, name: "exec", input: DECORATED_PATCH },
    { label: "native wrapped exec", native: true, name: "exec", input: WRAPPED_DECORATED_PATCH },
    { label: "native pretty wrapper", native: true, name: "exec", input: JSON.stringify({ input: DECORATED_PATCH }, null, 2) },
    { label: "native escaped-key wrapper", native: true, name: "exec", input: `{ "\\u0069nput": ${JSON.stringify(DECORATED_PATCH)} }` },
    { label: "function apply_patch wrapper alias", native: false, name: "apply_patch", input: WRAPPED_DECORATED_PATCH },
  ])("holds fragmented $label previews and completes with executable patch input", async ({ native, name, input }) => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]), budget, new Set(), new Set(["exec"]),
    );
    const id = native ? "ctc_patch_lifecycle" : "fc_patch_lifecycle";
    const item = { type: native ? "custom_tool_call" : "function_call", id, call_id: "call_patch_lifecycle", name };
    const payloadKey = native ? "input" : "arguments";
    const eventPrefix = native ? "response.custom_tool_call_input" : "response.function_call_arguments";
    // Independent oracle: do not compute expected source with the production compiler.
    const expected = `const result = await tools.apply_patch(${JSON.stringify(CANONICAL_PATCH)});\ntext(result);`;
    try {
      const added = rewrite(frame("response.output_item.added", {
        output_index: 0, item: { ...item, [payloadKey]: "", status: "in_progress" },
      }));
      expect(added).toHaveLength(1);
      expect(dataPayload(added[0]!).item).toMatchObject({
        type: "custom_tool_call", id: "ctc_patch_lifecycle", call_id: item.call_id, name: "exec", input: "",
      });
      // Split both the JSON wrapper and patch markers, including escaped newlines.
      for (const delta of input) {
        expect(rewrite(frame(`${eventPrefix}.delta`, { output_index: 0, item_id: id, delta }))).toEqual([]);
      }
      expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
      const inputDone = rewrite(frame(`${eventPrefix}.done`, {
        output_index: 0, item_id: id, [payloadKey]: input,
      }));
      expect(inputDone).toHaveLength(1);
      expect(dataPayload(inputDone[0]!)).toMatchObject({
        type: "response.custom_tool_call_input.done", item_id: "ctc_patch_lifecycle", input: expected,
      });
      if (native) expect(budget.snapshot().currentBytes).toBe(0);
      const completedItem = { ...item, [payloadKey]: input, status: "completed" };
      const itemDone = rewrite(frame("response.output_item.done", { output_index: 0, item: completedItem }));
      expect(itemDone).toHaveLength(1);
      expect(dataPayload(itemDone[0]!).item).toMatchObject({
        type: "custom_tool_call", id: "ctc_patch_lifecycle", call_id: item.call_id, name: "exec", input: expected,
      });
      expect(dataPayload(itemDone[0]!).item).not.toHaveProperty("arguments");
      expect(budget.snapshot().currentBytes).toBe(0);
      const terminal = rewrite(frame("response.completed", {
        response: { id: "resp_patch_lifecycle", status: "completed", output: [completedItem] },
      }));
      expect(terminal).toHaveLength(1);
      const response = dataPayload(terminal[0]!).response as { output: Array<Record<string, unknown>> };
      expect(response.output).toHaveLength(1);
      expect(response.output[0]).toMatchObject({
        type: "custom_tool_call", id: "ctc_patch_lifecycle", call_id: item.call_id, name: "exec", input: expected,
      });
      expect(response.output[0]).not.toHaveProperty("arguments");
      // Execute the client-consumed terminal item once, not each redundant representation.
      const calls: unknown[] = [];
      const output: unknown[] = [];
      const run = new Function("tools", "text", `return (async () => { ${response.output[0]!.input} })();`);
      await run({ apply_patch: async (patch: unknown) => { calls.push(patch); return "patched"; } },
        (value: unknown) => output.push(value));
      expect(calls).toEqual([CANONICAL_PATCH]);
      expect(output).toEqual(["patched"]);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      rewrite.dispose?.();
    }
  });

  test.each([
    { label: "raw item.done without input.done", input: DECORATED_PATCH, started: true, itemDone: true },
    { label: "wrapped item.done without input.done", input: WRAPPED_DECORATED_PATCH, started: true, itemDone: true },
    { label: "terminal after held deltas without either done event", input: WRAPPED_DECORATED_PATCH, started: true, itemDone: false },
    { label: "raw terminal-only", input: DECORATED_PATCH, started: false, itemDone: false },
    { label: "wrapped terminal-only", input: WRAPPED_DECORATED_PATCH, started: false, itemDone: false },
  ])("repairs native exec at $label completion", ({ input, started, itemDone }) => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]), budget, new Set(), new Set(["exec"]),
    );
    const item = { type: "custom_tool_call", id: "ctc_missing_done", call_id: "call_missing_done", name: "exec" };
    const expected = `const result = await tools.apply_patch(${JSON.stringify(CANONICAL_PATCH)});\ntext(result);`;
    try {
      if (started) {
        rewrite(frame("response.output_item.added", {
          output_index: 0, item: { ...item, input: "", status: "in_progress" },
        }));
        // The authoritative item must win even when only a prefix was previewed upstream.
        expect(rewrite(frame("response.custom_tool_call_input.delta", {
          output_index: 0, item_id: item.id, delta: input.slice(0, 12),
        }))).toEqual([]);
        expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
      }
      if (itemDone) {
        const done = rewrite(frame("response.output_item.done", {
          output_index: 0, item: { ...item, input, status: "completed" },
        }));
        expect(done).toHaveLength(1);
        expect(dataPayload(done[0]!).item).toEqual({ ...item, input: expected, status: "completed" });
        expect(budget.snapshot().currentBytes).toBe(0);
      }
      const terminal = rewrite(frame("response.completed", {
        response: { id: "resp_missing_done", status: "completed", output: [{ ...item, input, status: "completed" }] },
      }));
      expect(terminal).toHaveLength(1);
      expect(dataPayload(terminal[0]!).response).toMatchObject({
        status: "completed", output: [{ ...item, input: expected, status: "completed" }],
      });
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      rewrite.dispose?.();
    }
  });

  test.each([
    { label: "arbitrary JavaScript mentioning a patch", name: "exec", input: `const patch = ${JSON.stringify(DECORATED_PATCH)};\ntext(patch);` },
    { label: "JavaScript block with an ambiguous brace prefix", name: "exec", input: '{ const value = "literal"; text(value); }' },
    { label: "unrelated custom JSON input", name: "render_diagram", input: '{"input":"literal"}' },
    { label: "incomplete patch envelope", name: "exec", input: "*** Begin Patch ***\n*** Add File: note.txt\n+unfinished" },
    { label: "envelope without an operation", name: "exec", input: "*** Begin Patch ***\nnot an operation\n*** End Patch ***" },
    { label: "flat exec catalog", name: "exec", input: DECORATED_PATCH, flat: true },
    { label: "foreign exec namespace", name: "exec", input: DECORATED_PATCH, namespace: "mcp" },
    { label: "foreign helper namespace", name: "apply_patch", input: DECORATED_PATCH, namespace: "mcp" },
  ])("preserves native $label across completion boundaries", ({ name, input, ...options }) => {
    const namespace = "namespace" in options ? options.namespace : undefined;
    const flat = "flat" in options && options.flat;
    const names = new Set(["exec", "render_diagram", "mcp__exec", "mcp__apply_patch"]);
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      names, undefined, new Set(), new Set([...names, ...(flat ? ["exec_command"] : [])]),
    );
    const item = {
      type: "custom_tool_call", id: "ctc_preserved", call_id: "call_preserved", name,
      ...(namespace ? { namespace } : {}),
    };
    try {
      rewrite(frame("response.output_item.added", {
        output_index: 0, item: { ...item, input: "", status: "in_progress" },
      }));
      let preview = "";
      for (const delta of input) {
        for (const block of rewrite(frame("response.custom_tool_call_input.delta", {
          output_index: 0, item_id: item.id, delta,
        }))) {
          const payload = dataPayload(block);
          expect(payload.type).toBe("response.custom_tool_call_input.delta");
          expect(typeof payload.delta).toBe("string");
          preview += payload.delta;
          expect(input.startsWith(preview)).toBe(true);
        }
      }
      // Ordinary JS and unrelated tools retain progressive input; ambiguous exec may be held.
      if (input.startsWith("const ") || name === "render_diagram") expect(preview).toBe(input);
      const inputDone = rewrite(frame("response.custom_tool_call_input.done", {
        output_index: 0, item_id: item.id, input,
      }));
      expect(inputDone).toHaveLength(1);
      expect(dataPayload(inputDone[0]!)).toMatchObject({ type: "response.custom_tool_call_input.done", input });
      const completedItem = { ...item, input, status: "completed" };
      const itemDone = rewrite(frame("response.output_item.done", { output_index: 0, item: completedItem }));
      expect(itemDone).toHaveLength(1);
      expect(dataPayload(itemDone[0]!).item).toEqual(completedItem);
      const terminal = rewrite(frame("response.completed", {
        response: { id: "resp_preserved", status: "completed", output: [completedItem] },
      }));
      expect(terminal).toHaveLength(1);
      expect(dataPayload(terminal[0]!).response).toEqual({
        id: "resp_preserved", status: "completed", output: [completedItem],
      });
    } finally {
      rewrite.dispose?.();
    }
  });

  test.each(["failed", "incomplete", "dispose"])("releases held native exec input on %s without synthesizing success", outcome => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]), budget, new Set(), new Set(["exec"]),
    );
    try {
      rewrite(frame("response.output_item.added", {
        output_index: 0,
        item: { type: "custom_tool_call", id: "ctc_cancelled", call_id: "call_cancelled", name: "exec", input: "", status: "in_progress" },
      }));
      expect(rewrite(frame("response.custom_tool_call_input.delta", {
        output_index: 0, item_id: "ctc_cancelled", delta: WRAPPED_DECORATED_PATCH,
      }))).toEqual([]);
      expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
      if (outcome === "dispose") {
        expect(rewrite.dispose?.()).toBeUndefined();
      } else {
        const terminal = frame(`response.${outcome}`, {
          response: { id: "resp_cancelled", status: outcome, output: [] },
        });
        expect(rewrite(terminal)).toEqual([terminal]);
      }
      expect(budget.snapshot().currentBytes).toBe(0);
      // Late provider bytes cannot reopen a cancelled collector or flush a successful item.
      const lateDelta = frame("response.custom_tool_call_input.delta", {
        output_index: 0, item_id: "ctc_cancelled", delta: "late",
      });
      expect(rewrite(lateDelta)).toEqual([lateDelta]);
      rewrite.dispose?.();
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      rewrite.dispose?.();
    }
  });

  test("restores streamed exec_command arguments through unified exec", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]),
      undefined,
      new Set(),
      new Set(["exec"]),
    );
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_shell_alias",
        call_id: "call_shell_alias",
        name: "exec_command",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(dataPayload(added[0]!).item).toMatchObject({ type: "custom_tool_call", name: "exec" });
    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_shell_alias",
      delta: '{"cmd":"pwd"}',
    }))).toEqual([]);
    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_shell_alias",
      arguments: '{"cmd":"pwd"}',
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      input: compileCodeModeHelperInput('{"cmd":"pwd"}', "exec_command"),
    });
    rewrite.dispose?.();
  });

  test("restores streamed write_stdin arguments through unified exec", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(["exec"]),
      undefined,
      new Set(),
      new Set(["exec"]),
    );
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_stdin_alias",
        call_id: "call_stdin_alias",
        name: "write_stdin",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(dataPayload(added[0]!).item).toMatchObject({ type: "custom_tool_call", name: "exec" });
    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_stdin_alias",
      delta: '{"session_id":17,"yield_time_ms":1000}',
    }))).toEqual([]);
    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_stdin_alias",
      arguments: '{"session_id":17,"yield_time_ms":1000}',
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      input: compileCodeModeHelperInput(
        '{"session_id":17,"yield_time_ms":1000}',
        "write_stdin",
      ),
    });
    rewrite.dispose?.();
  });

  test("restores a non-streaming write_stdin call through unified exec", () => {
    const upstream = JSON.stringify({
      id: "resp_stdin",
      output: [{
        type: "function_call",
        id: "fc_stdin",
        call_id: "call_stdin",
        name: "write_stdin",
        arguments: '{"session_id":17,"yield_time_ms":1000}',
        status: "completed",
      }],
    });

    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      upstream,
      new Set(["exec"]),
      new Set(),
      new Set(["exec"]),
    )) as { output: Array<Record<string, unknown>> };
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: compileCodeModeHelperInput(
        '{"session_id":17,"yield_time_ms":1000}',
        "write_stdin",
      ),
    });
  });

  test("rewrites exec definitions and paired history without touching apply_patch", () => {
    const raw = {
      model: "deepseek-v4-flash",
      tools: [
        { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark" } },
        { type: "function", name: "ordinary", parameters: { type: "object" } },
      ],
      input: [
        { type: "custom_tool_call", id: "ctc_exec", call_id: "call_exec", name: "exec", input: "await sky.list_apps()" },
        { type: "custom_tool_call_output", call_id: "call_exec", output: "27 apps" },
        { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
      ],
    };

    expect(collectRoutedCustomToolNames(raw)).toEqual(new Set(["exec"]));
    const rewritten = rewriteRoutedCustomToolsForUpstream(raw);
    expect(rewritten.names).toEqual(new Set(["exec"]));
    expect(rewritten.repairNames).toEqual(new Set(["apply_patch"]));
    expect(rewritten.body).not.toBe(raw);
    expect(raw.tools[0]?.type).toBe("custom");

    const body = rewritten.body as typeof raw;
    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "exec",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    });
    expect(body.tools[0]).not.toHaveProperty("format");
    expect(body.tools[1]).toEqual(raw.tools[1]);
    expect(body.tools[2]).toEqual(raw.tools[2]);
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_exec",
      name: "exec",
      arguments: JSON.stringify({ input: "await sky.list_apps()" }),
    });
    expect(body.input[0]).not.toHaveProperty("input");
    expect(body.input[1]).toMatchObject({ type: "function_call_output", call_id: "call_exec" });
    expect(body.input[2]).toEqual(raw.input[2]);
    expect(body.input[3]).toEqual(raw.input[3]);
  });

  test("restores non-streaming exec calls while leaving ordinary functions alone", () => {
    const upstream = JSON.stringify({
      id: "resp_1",
      output: [
        { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "{\"input\":\"const apps = await sky.list_apps();\"}", status: "completed" },
        { type: "function_call", id: "fc_other", call_id: "call_other", name: "ordinary", arguments: "{}", status: "completed" },
      ],
    });

    const restored = JSON.parse(restoreRoutedCustomCallsInJson(upstream, new Set(["exec"]))) as {
      output: Array<Record<string, unknown>>;
    };
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: "const apps = await sky.list_apps();",
    });
    expect(restored.output[0]).not.toHaveProperty("arguments");
    expect(restored.output[1]).toMatchObject({ type: "function_call", name: "ordinary", arguments: "{}" });
  });

  test("repairs an authorized native apply_patch custom call without changing its type", () => {
    const upstream = JSON.stringify({
      id: "resp_patch",
      output: [{
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "call_patch",
        name: "apply_patch",
        input: DECORATED_PATCH,
        status: "completed",
      }],
    });

    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      upstream,
      new Set(),
      new Set(["apply_patch"]),
    )) as { output: Array<Record<string, unknown>> };
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      id: "ctc_patch",
      name: "apply_patch",
      input: CANONICAL_PATCH,
    });

    const unnamed = JSON.stringify({
      output: [{ type: "custom_tool_call", input: DECORATED_PATCH }],
    });
    expect(restoreRoutedCustomCallsInJson(
      unnamed,
      new Set(),
      new Set(["apply_patch"]),
    )).toBe(unnamed);

    const metadataOnly = JSON.stringify({
      id: "resp_metadata",
      output: [],
      metadata: {
        shadow: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: DECORATED_PATCH,
        },
      },
    });
    expect(restoreRoutedCustomCallsInJson(
      metadataOnly,
      new Set(),
      new Set(["apply_patch"]),
    )).toBe(metadataOnly);

    const wrappedNative = JSON.stringify({
      id: "resp_wrapped_patch",
      output: [{
        type: "custom_tool_call",
        id: "ctc_wrapped_patch",
        name: "apply_patch",
        input: WRAPPED_DECORATED_PATCH,
      }],
    });
    expect(restoreRoutedCustomCallsInJson(
      wrappedNative,
      new Set(),
      new Set(["apply_patch"]),
    )).toBe(wrappedNative);

    expect(restoreRoutedCustomCallsInJson(upstream, new Set())).toBe(upstream);
  });

  test("preserves decorated delimiters for a non-functions namespaced apply_patch tool", () => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [{
        type: "namespace",
        name: "mcp",
        tools: [{ type: "custom", name: "apply_patch", description: "Remote patch grammar" }],
      }],
    });
    expect(rewritten.repairNames).toEqual(new Set());

    const item = {
      type: "custom_tool_call",
      id: "ctc_remote_patch",
      call_id: "call_remote_patch",
      namespace: "mcp",
      name: "apply_patch",
      input: DECORATED_PATCH,
      status: "completed",
    };
    const upstream = JSON.stringify({ id: "resp_remote_patch", output: [item] });
    expect(restoreRoutedCustomCallsInJson(
      upstream,
      rewritten.names,
      rewritten.repairNames,
    )).toBe(upstream);

    const block = frame("response.output_item.done", { output_index: 0, item });
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      rewritten.names,
      undefined,
      rewritten.repairNames,
    );
    expect(rewrite(block)).toEqual([block]);
    rewrite.dispose?.();
  });

  test("preserves a converted non-functions namespaced apply_patch payload", () => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [{
        type: "namespace",
        name: "mcp",
        tools: [{ type: "custom", name: "apply_patch", description: "Remote patch grammar" }],
      }],
    }, false);
    expect(rewritten.names).toEqual(new Set(["mcp__apply_patch"]));

    const upstream = JSON.stringify({
      id: "resp_remote_patch",
      output: [{
        type: "function_call",
        id: "fc_remote_patch",
        call_id: "call_remote_patch",
        namespace: "mcp",
        name: "apply_patch",
        arguments: WRAPPED_DECORATED_PATCH,
        status: "completed",
      }],
    });
    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      upstream,
      rewritten.names,
      rewritten.repairNames,
    )) as { output: Record<string, unknown>[] };
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      input: DECORATED_PATCH,
    });

    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      rewritten.names,
      undefined,
      rewritten.repairNames,
    );
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_remote_patch",
        call_id: "call_remote_patch",
        namespace: "mcp",
        name: "apply_patch",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(dataPayload(added[0]!).item).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      input: "",
    });
    const inputDone = rewrite(frame("response.function_call_arguments.done", {
      item_id: "fc_remote_patch",
      output_index: 0,
      arguments: WRAPPED_DECORATED_PATCH,
    }));
    expect(dataPayload(inputDone[0]!).input).toBe(DECORATED_PATCH);
    rewrite.dispose?.();
  });

  test("repairs native apply_patch item and input-done events in an SSE lifecycle", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      new Set(),
      undefined,
      new Set(["apply_patch"]),
    );
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "call_patch",
        name: "apply_patch",
        input: "",
        status: "in_progress",
      },
    }));
    expect(dataPayload(added[0]!).item).toMatchObject({ type: "custom_tool_call", name: "apply_patch" });

    const inputDone = rewrite(frame("response.custom_tool_call_input.done", {
      output_index: 0,
      item_id: "ctc_patch",
      input: DECORATED_PATCH,
    }));
    expect(dataPayload(inputDone[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      input: CANONICAL_PATCH,
    });

    rewrite(frame("response.output_item.added", {
      output_index: 1,
      item: {
        type: "custom_tool_call",
        id: "ctc_wrapped_patch",
        name: "apply_patch",
        input: "",
      },
    }));
    const wrappedInputDone = rewrite(frame("response.custom_tool_call_input.done", {
      output_index: 1,
      item_id: "ctc_wrapped_patch",
      input: WRAPPED_DECORATED_PATCH,
    }));
    expect(dataPayload(wrappedInputDone[0]!)).toMatchObject({ input: WRAPPED_DECORATED_PATCH });

    const itemDone = rewrite(frame("response.output_item.done", {
      output_index: 0,
      metadata: {
        shadow: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: DECORATED_PATCH,
        },
      },
      item: {
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "call_patch",
        name: "apply_patch",
        input: DECORATED_PATCH,
        status: "completed",
      },
    }));
    const itemDonePayload = dataPayload(itemDone[0]!);
    expect(itemDonePayload.item).toMatchObject({ input: CANONICAL_PATCH });
    expect(itemDonePayload.metadata).toEqual({
      shadow: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: DECORATED_PATCH,
      },
    });
    rewrite.dispose?.();
  });

  test("restores the streamed exec lifecycle and unwraps progressive input", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));
    expect(added).toHaveLength(1);
    expect(dataPayload(added[0]!).item).toMatchObject({
      type: "custom_tool_call",
      id: "ctc_exec",
      name: "exec",
      input: "",
    });

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0, item_id: "fc_exec", delta: "{\"inp",
    }))).toEqual([]);
    const firstDelta = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0, item_id: "fc_exec", delta: "ut\":\"const apps = await sky.list_apps();\\n",
    }));
    expect(firstDelta).toHaveLength(1);
    expect(dataPayload(firstDelta[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.delta",
      item_id: "ctc_exec",
      delta: "const apps = await sky.list_apps();\n",
    });
    const secondDelta = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0, item_id: "fc_exec", delta: "apps.length\"}",
    }));
    expect(dataPayload(secondDelta[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.delta",
      delta: "apps.length",
    });

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\\napps.length\"}",
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      item_id: "ctc_exec",
      input: "const apps = await sky.list_apps();\napps.length",
    });

    const itemDone = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_exec",
        call_id: "call_exec",
        name: "exec",
        arguments: "{\"input\":\"const apps = await sky.list_apps();\\napps.length\"}",
        status: "completed",
      },
    }));
    expect(dataPayload(itemDone[0]!).item).toMatchObject({
      type: "custom_tool_call",
      input: "const apps = await sky.list_apps();\napps.length",
    });

    const completed = rewrite(frame("response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_exec",
          call_id: "call_exec",
          name: "exec",
          arguments: "{\"input\":\"apps.length\"}",
          status: "completed",
        }],
      },
    }));
    const response = dataPayload(completed[0]!).response as { output: Array<Record<string, unknown>> };
    expect(response.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input: "apps.length" });
    rewrite.dispose?.();
  });

  test("buffers argument events until a missing added event is identified by item done", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);
    const deltaBlock = frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_exec",
      delta: "{\"input\":\"echo",
    });
    const argumentsDoneBlock = frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: "{\"input\":\"echo ok\"}",
    });

    expect(rewrite(deltaBlock)).toEqual([]);
    expect(rewrite(argumentsDoneBlock)).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const replayed = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_exec",
        call_id: "call_exec",
        name: "exec",
        arguments: "{\"input\":\"echo ok\"}",
        status: "completed",
      },
    }));
    expect(replayed.map(block => dataPayload(block).type)).toEqual([
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
    ]);
    expect(dataPayload(replayed[0]!)).toMatchObject({ item_id: "ctc_exec", delta: "echo" });
    expect(dataPayload(replayed[1]!)).toMatchObject({ item_id: "ctc_exec", input: "echo ok" });
    expect(dataPayload(replayed[2]!).item).toMatchObject({
      type: "custom_tool_call",
      id: "ctc_exec",
      name: "exec",
      input: "echo ok",
    });
    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
  });

  test("does not match a known pending item id by output index alone", () => {
    const budget = createTestTranslatorBudget();
    const chargeRetained = budget.chargeRetained.bind(budget);
    const releaseRetained = budget.releaseRetained.bind(budget);
    let charges = 0;
    let releases = 0;
    budget.chargeRetained = (...args) => {
      charges += 1;
      chargeRetained(...args);
    };
    budget.releaseRetained = (...args) => {
      releases += 1;
      releaseRetained(...args);
    };
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_a",
      delta: "{\"input\":\"a",
    }))).toEqual([]);
    expect(charges).toBe(1);

    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_b",
        call_id: "call_b",
        name: "exec",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(added.map(block => dataPayload(block).type)).toEqual(["response.output_item.added"]);
    expect(JSON.stringify(added)).not.toContain('"item_id":"ctc_b"');
    expect(charges).toBe(1);
    expect(releases).toBe(0);

    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("does not retain argument events that arrive after a terminal event", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);

    rewrite(frame("response.completed", {
      response: { id: "resp_1", status: "completed", output: [] },
    }));
    expect(budget.snapshot().currentBytes).toBe(0);

    rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_late",
      delta: "{\"input\":\"late",
    }));
    rewrite.dispose?.();

    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("replays buffered events unchanged when item done identifies an ordinary function", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);
    const deltaBlock = frame("response.function_call_arguments.delta", {
      output_index: 1,
      item_id: "fc_other",
      delta: "{}",
    });

    expect(rewrite(deltaBlock)).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const replayed = rewrite(frame("response.output_item.done", {
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_other",
        call_id: "call_other",
        name: "ordinary",
        arguments: "{}",
        status: "completed",
      },
    }));
    expect(replayed).toEqual([deltaBlock, frame("response.output_item.done", {
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_other",
        call_id: "call_other",
        name: "ordinary",
        arguments: "{}",
        status: "completed",
      },
    })]);
    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
  });

  test("replays id-less argument deltas once output_item.added resolves the routed item", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      delta: "{\"input\":\"echo",
    }))).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const replayed = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_exec",
        call_id: "call_exec",
        name: "exec",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(replayed.map(block => dataPayload(block).type)).toEqual([
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
    ]);
    expect(dataPayload(replayed[0]!).item).toMatchObject({ type: "custom_tool_call", id: "ctc_exec", name: "exec" });
    expect(dataPayload(replayed[1]!)).toMatchObject({ item_id: "ctc_exec", delta: "echo" });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: "{\"input\":\"echo ok\"}",
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      item_id: "ctc_exec",
      input: "echo ok",
    });
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("keeps progressive exec input consistent for escaped control characters", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));

    const fragments = ['{"inp', 'ut":"before\\', 'b\\fafter"}'];
    let streamedInput = "";
    for (const delta of fragments) {
      const blocks = rewrite(frame("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_exec",
        delta,
      }));
      for (const block of blocks) streamedInput += String(dataPayload(block).delta ?? "");
    }

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: fragments.join(""),
    }));
    const doneInput = dataPayload(done[0]!).input;
    expect(streamedInput).toBe(doneInput);
    expect(streamedInput).toBe("before\b\fafter");
    rewrite.dispose?.();
  });

  test("keeps progressive exec input consistent for spaced freeform wrappers", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));

    const fragments = ['{ "input": "', 'spaced"}'];
    let streamedInput = "";
    for (const delta of fragments) {
      const blocks = rewrite(frame("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_exec",
        delta,
      }));
      for (const block of blocks) streamedInput += String(dataPayload(block).delta ?? "");
    }

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: fragments.join(""),
    }));
    expect(streamedInput).toBe(dataPayload(done[0]!).input);
    expect(streamedInput).toBe("spaced");
    rewrite.dispose?.();
  });

  test("suppresses progressive deltas for unrecognized argument shapes until done", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_exec",
      delta: '{"other":"x"',
    }))).toEqual([]);

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: '{"input":"authoritative"}',
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      input: "authoritative",
    });
    rewrite.dispose?.();
  });

  test("keeps progressive exec input consistent for split unicode escapes", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));

    const fragments = ['{"input":"caf\\u00', 'e9 \\u0041"}'];
    let streamedInput = "";
    for (const delta of fragments) {
      const blocks = rewrite(frame("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_exec",
        delta,
      }));
      for (const block of blocks) streamedInput += String(dataPayload(block).delta ?? "");
    }

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: fragments.join(""),
    }));
    expect(streamedInput).toBe(dataPayload(done[0]!).input);
    expect(streamedInput).toBe("café A");
    rewrite.dispose?.();
  });

});
