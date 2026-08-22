import { describe, expect, test } from "bun:test";
import {
  collectRoutedCustomToolNames,
  restoreRoutedCustomCallsInJson,
  rewriteRoutedCustomToolsForUpstream,
} from "../src/responses/custom-tool-compat";
import { createRoutedCustomToolRestoreBlockRewrite } from "../src/server/responses-custom-tool-repair";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function dataPayload(block: string): Record<string, unknown> {
  const line = block.split(/\r?\n/).find(entry => entry.startsWith("data:"));
  if (!line) throw new Error("missing SSE data line");
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;
}

describe("routed Responses custom-tool compatibility", () => {
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

  test("handleResponses sends an upstream-safe exec function and restores client SSE", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\"}",
      status: "completed",
    };
    const upstream = [
      frame("response.output_item.added", { output_index: 0, item: { ...upstreamItem, arguments: "", status: "in_progress" } }),
      frame("response.function_call_arguments.done", { output_index: 0, item_id: "fc_exec", arguments: upstreamItem.arguments }),
      frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [upstreamItem] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "list apps" }] }],
          tools: [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }],
        }),
      }), config, { model: "", provider: "" });
      const clientSse = await response.text();
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundTools?.[0]).toMatchObject({ type: "function", name: "exec" });
      expect(clientSse).toContain('"type":"custom_tool_call"');
      expect(clientSse).toContain('"type":"response.custom_tool_call_input.done"');
      expect(clientSse).toContain('"input":"const apps = await sky.list_apps();"');
      expect(clientSse).not.toContain("response.function_call_arguments.done");
      expect(clientSse).not.toContain('"type":"function_call"');
      expect(clientSse).toContain("data: [DONE]");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses continuation rewrites custom_tool_call_output and keeps call_id ordered", async () => {
    const savedFetch = globalThis.fetch;
    const outboundBodies: Array<Record<string, unknown>> = [];
    const firstUpstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\"}",
      status: "completed",
    };
    const secondUpstreamMessage = {
      type: "message",
      id: "msg_2",
      role: "assistant",
      content: [{ type: "output_text", text: "27 apps" }],
      status: "completed",
    };
    let turn = 0;
    globalThis.fetch = (async (_input, init) => {
      outboundBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      turn += 1;
      if (turn === 1) {
        const upstream = [
          frame("response.output_item.added", { output_index: 0, item: { ...firstUpstreamItem, arguments: "", status: "in_progress" } }),
          frame("response.function_call_arguments.done", { output_index: 0, item_id: "fc_exec", arguments: firstUpstreamItem.arguments }),
          frame("response.output_item.done", { output_index: 0, item: firstUpstreamItem }),
          frame("response.completed", { response: { id: "resp_1", status: "completed", output: [firstUpstreamItem] } }),
          "data: [DONE]",
        ].join("\n\n") + "\n\n";
        return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
      }
      const upstream = [
        frame("response.output_item.added", { output_index: 0, item: { ...secondUpstreamMessage, content: [], status: "in_progress" } }),
        frame("response.output_item.done", { output_index: 0, item: secondUpstreamMessage }),
        frame("response.completed", { response: { id: "resp_2", status: "completed", output: [secondUpstreamMessage] } }),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;
    const tools = [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }];

    try {
      const first = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "list apps" }] }],
          tools,
        }),
      }), config, { model: "", provider: "" });
      const firstSse = await first.text();
      expect(firstSse).toContain('"type":"custom_tool_call"');
      expect(firstSse).toContain('"call_id":"call_exec"');
      expect(firstSse).not.toContain('"type":"function_call"');

      const second = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [
            { role: "user", content: [{ type: "input_text", text: "list apps" }] },
            {
              type: "custom_tool_call",
              id: "ctc_exec",
              call_id: "call_exec",
              name: "exec",
              input: "const apps = await sky.list_apps();",
            },
            { type: "custom_tool_call_output", call_id: "call_exec", output: "27 apps" },
            { type: "custom_tool_call_output", call_id: "call_other", output: "wrong pairing must stay distinct" },
          ],
          tools,
        }),
      }), config, { model: "", provider: "" });
      const secondSse = await second.text();
      const continuationInput = outboundBodies[1]?.input as Array<Record<string, unknown>>;
      expect(outboundBodies).toHaveLength(2);
      expect(continuationInput).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call_exec",
          name: "exec",
          arguments: JSON.stringify({ input: "const apps = await sky.list_apps();" }),
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_exec",
          output: "27 apps",
        }),
      ]));
      const execOutput = continuationInput.find(item => item.type === "function_call_output" && item.call_id === "call_exec");
      const otherOutput = continuationInput.find(item => item.call_id === "call_other");
      expect(execOutput).toMatchObject({ type: "function_call_output", output: "27 apps" });
      expect(otherOutput).toMatchObject({ type: "custom_tool_call_output", call_id: "call_other" });
      expect(continuationInput.filter(item => item.type === "function_call_output")).toHaveLength(1);
      expect(secondSse).toContain('"text":"27 apps"');
      expect(secondSse).toContain('"id":"resp_2"');
      expect(secondSse).not.toContain('"type":"function_call"');
      expect(secondSse.indexOf("resp_2")).toBeLessThan(secondSse.indexOf("data: [DONE]"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses restores routed custom calls in non-streaming JSON", async () => {
    const savedFetch = globalThis.fetch;
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\"}",
      status: "completed",
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "resp_json",
      status: "completed",
      output: [upstreamItem],
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "list apps" }] }],
          tools: [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }],
        }),
      }), config, { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        id: "ctc_exec",
        name: "exec",
        input: "const apps = await sky.list_apps();",
      });
      expect(body.output[0]).not.toHaveProperty("arguments");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses does not restore routed custom calls excluded by request policy", async () => {
    const savedFetch = globalThis.fetch;
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"ignored policy\"}",
      status: "completed",
    };
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;
    const execTool = {
      type: "custom",
      name: "exec",
      description: "Run JavaScript",
      format: { type: "grammar", syntax: "lark" },
    };
    const ordinaryTool = {
      type: "function",
      name: "ordinary",
      description: "Ordinary function",
      parameters: { type: "object" },
    };
    const cases: Array<{
      name: string;
      stream: boolean;
      tools: Array<Record<string, unknown>>;
      toolChoice?: unknown;
      metadata?: unknown;
      /** The upstream call names a tool this request never declared at all (#1700). */
      undeclared?: boolean;
    }> = [
      {
        name: "streaming none",
        stream: true,
        tools: [execTool],
        toolChoice: "none",
      },
      {
        name: "streaming allowlist",
        stream: true,
        tools: [execTool, ordinaryTool],
        toolChoice: {
          type: "allowed_tools",
          mode: "required",
          tools: [{ type: "function", name: "ordinary" }],
        },
      },
      {
        name: "named ordinary function",
        stream: false,
        tools: [execTool, ordinaryTool],
        toolChoice: { type: "function", name: "ordinary" },
      },
      {
        name: "custom-looking metadata without a declared tool",
        stream: false,
        tools: [ordinaryTool],
        metadata: { nested: { type: "custom", name: "exec" } },
        undeclared: true,
      },
    ];

    globalThis.fetch = (async (_input, init) => {
      const outboundBody = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (outboundBody.stream === true) {
        const upstream = [
          frame("response.output_item.added", {
            output_index: 0,
            item: { ...upstreamItem, arguments: "", status: "in_progress" },
          }),
          frame("response.function_call_arguments.done", {
            output_index: 0,
            item_id: "fc_exec",
            arguments: upstreamItem.arguments,
          }),
          frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
          frame("response.completed", {
            response: { id: "resp_policy", status: "completed", output: [upstreamItem] },
          }),
          "data: [DONE]",
        ].join("\n\n") + "\n\n";
        return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "resp_policy",
        status: "completed",
        output: [upstreamItem],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      for (const policyCase of cases) {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fixture/deepseek-v4-flash",
            stream: policyCase.stream,
            input: [{ role: "user", content: [{ type: "input_text", text: policyCase.name }] }],
            tools: policyCase.tools,
            ...(policyCase.toolChoice !== undefined ? { tool_choice: policyCase.toolChoice } : {}),
            ...(policyCase.metadata !== undefined ? { metadata: policyCase.metadata } : {}),
          }),
        }), config, { model: "", provider: "" });

        if (policyCase.stream) {
          const clientSse = await response.text();
          expect(clientSse).toContain('"type":"function_call"');
          expect(clientSse).toContain('"id":"fc_exec"');
          expect(clientSse).toContain("response.function_call_arguments.done");
          expect(clientSse).not.toContain("custom_tool_call");
          expect(clientSse).not.toContain("ctc_exec");
        } else if (policyCase.undeclared) {
          // #1700: this request's catalog holds only `ordinary` — a metadata blob that merely
          // looks like a tool declaration declares nothing — so a call to `exec` is refused
          // instead of relayed. The restore contract still holds either way: it never became
          // a custom_tool_call.
          expect(response.status).toBe(502);
          const body = await response.json() as { error: { message: string } };
          expect(body.error.message).toContain('undeclared client tool "exec"');
        } else {
          const body = await response.json() as { output: Array<Record<string, unknown>> };
          expect(body.output[0]).toEqual(upstreamItem);
        }
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses preserves native apply_patch calls that were never converted", async () => {
    const savedFetch = globalThis.fetch;
    const upstreamItem = {
      type: "function_call",
      id: "fc_patch",
      call_id: "call_patch",
      name: "apply_patch",
      arguments: "{\"patch\":\"*** Begin Patch\"}",
      status: "completed",
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "resp_patch",
      status: "completed",
      output: [upstreamItem],
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "patch" }] }],
          tools: [{
            type: "custom",
            name: "apply_patch",
            description: "Apply a patch",
            format: { type: "grammar", syntax: "lark" },
          }],
        }),
      }), config, { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(body.output[0]).toEqual(upstreamItem);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses does not restore a custom image tool replaced by hosted preference", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const upstreamItem = {
      type: "function_call",
      id: "fc_image",
      call_id: "call_image",
      name: "image_gen.generate",
      arguments: "{}",
      status: "completed",
    };
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp_image",
        status: "completed",
        output: [upstreamItem],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
          modelPreferHostedTools: { "deepseek-v4-flash": ["image_generation"] },
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "draw" }] }],
          tools: [{
            type: "custom",
            name: "image_gen.generate",
            description: "Generate an image",
            format: { type: "grammar", syntax: "lark" },
          }],
        }),
      }), config, { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundTools).toEqual([{ type: "image_generation" }]);
      expect(body.output[0]).toEqual(upstreamItem);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses leaves custom tools native for forward-auth passthrough", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    let outboundAuthorization: string | null = null;
    let outboundUrl = "";
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"native\"}",
      status: "completed",
    };
    globalThis.fetch = (async (input, init) => {
      outboundUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outboundAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ id: "resp_forward", status: "completed", output: [upstreamItem] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({
          model: "fixture/native-model",
          stream: false,
          input: "run",
          tools: [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }],
        }),
      }), config, { model: "", provider: "" });
      const clientBody = await response.json() as { output: Array<Record<string, unknown>> };
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(outboundAuthorization).toBe("Bearer caller-token");
      expect(outboundTools?.[0]).toMatchObject({ type: "custom", name: "exec" });
      expect(clientBody.output[0]).toMatchObject({ type: "function_call", name: "exec" });
      expect(clientBody.output[0]).not.toHaveProperty("input");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
