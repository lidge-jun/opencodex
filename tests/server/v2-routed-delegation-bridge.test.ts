import { describe, expect, test } from "bun:test";
import {
  createV2RoutedDelegationSseRewrite,
  injectV2RoutedDelegationBridge,
  rewriteV2RoutedDelegationCallsInJson,
} from "../../src/server/responses/v2-routed-delegation-bridge";
import type { OcxParsedRequest } from "../../src/types";

const GUIDANCE = "Use this routed-child mirror for collaboration operations.";

function parsed(body: Record<string, unknown>): OcxParsedRequest {
  return {
    modelId: "gpt-5.6-terra",
    stream: false,
    context: {
      messages: [],
      tools: [{ namespace: "collaboration", name: "spawn_agent", description: "native spawn", parameters: { type: "object", properties: { task: { type: "string" } } } }],
    },
    options: {},
    _rawBody: body,
  };
}

const spawn = { type: "function", name: "spawn_agent", description: "native spawn", parameters: { type: "object", properties: { task: { type: "string" } } }, strict: true };
const send = { type: "function", name: "send_message", description: "native send", parameters: { type: "object" } };
const followup = { type: "function", name: "followup_task", description: "native follow", parameters: { type: "object" } };

describe("V2 routed delegation bridge", () => {
  test("moves message operations to plaintext mirrors while preserving native control operations", () => {
    const encrypted = (tool: Record<string, any>) => ({
      ...tool,
      parameters: { type: "object", properties: {
        target: { type: "string" },
        message: { type: "string", encrypted: true, description: `${tool.name} message` },
      } },
    });
    const messages = [encrypted(spawn), encrypted(send), encrypted(followup)];
    const controls = ["wait_agent", "interrupt_agent", "list_agents"].map(name => (
      { type: "function", name, parameters: { type: "object", properties: { id: { type: "string" } } } }
    ));
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [...messages, ...controls] }] };
    const request = parsed(body);
    request.context.tools = [...messages, ...controls].map(tool => ({
      namespace: "collaboration", name: tool.name, description: tool.description, parameters: tool.parameters,
    }));
    const original = structuredClone(body);

    const active = injectV2RoutedDelegationBridge(request);

    expect(active?.names).toEqual(new Set(["spawn_agent", "send_message", "followup_task"]));
    expect(active?.requestStateBody).toEqual(original);
    expect(body.tools[0]).toEqual({ type: "namespace", name: "collaboration", tools: controls });
    expect(body.tools).toHaveLength(2);
    const mirrored = (body.tools[1] as { tools: Array<Record<string, any>> }).tools;
    expect(mirrored.map(tool => tool.name)).toEqual(["spawn_agent", "send_message", "followup_task"]);
    for (const tool of mirrored) {
      expect(tool.parameters.properties).toEqual({
        target: { type: "string" },
        message: { type: "string", description: `${tool.name} message` },
      });
    }
    expect(request.context.tools?.filter(tool => tool.namespace === "collaboration")).toEqual(
      controls.map(tool => ({ namespace: "collaboration", name: tool.name, parameters: tool.parameters })),
    );
    expect(request.context.tools?.filter(tool => tool.namespace === "ocx_agents").map(tool => tool.name))
      .toEqual(["spawn_agent", "send_message", "followup_task"]);
  });

  test("mirrors every catalog shape, exactly the available three functions, and is idempotent", () => {
    const body = {
      tools: [{ type: "namespace", name: "collaboration", tools: [spawn] }],
      input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "collaboration", tools: [send, followup] }] }],
    };
    const request = parsed(body);
    const first = injectV2RoutedDelegationBridge(request);
    const raw = structuredClone(body);
    const second = injectV2RoutedDelegationBridge(request);

    expect(first?.names).toEqual(new Set(["spawn_agent", "send_message", "followup_task"]));
    expect(second?.names).toEqual(first?.names);
    expect(body).toEqual(raw);
    expect((body.tools[1] as { tools: unknown[] }).tools).toHaveLength(1);
    const inputMirror = (body.input[0] as { tools: Array<Record<string, unknown>> }).tools[1]!;
    expect(inputMirror).toMatchObject({
      type: "namespace",
      name: "ocx_agents",
      description: GUIDANCE,
    });
    expect(inputMirror.tools).toHaveLength(2);
  });

  test("fails closed for a conflicting ocx_agents namespace", () => {
    const request = parsed({ tools: [
      { type: "namespace", name: "collaboration", tools: [spawn] },
      { type: "namespace", name: "ocx_agents", tools: [] },
    ] });
    expect(() => injectV2RoutedDelegationBridge(request)).toThrow("v2 routed delegation bridge namespace collision");
  });

  test("rejects an adjacent mirror whose schema differs from native collaboration", () => {
    const request = parsed({ tools: [
      { type: "namespace", name: "collaboration", tools: [spawn] },
      { type: "namespace", name: "ocx_agents", description: GUIDANCE, tools: [{ ...spawn, description: `${GUIDANCE} spawn_agent.`, parameters: { type: "object" } }] },
    ] });
    expect(() => injectV2RoutedDelegationBridge(request)).toThrow("v2 routed delegation bridge namespace collision");
  });

  test("rejects a caller-supplied canonical mirror beside native control tools", () => {
    const request = parsed({ tools: [
      { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "wait_agent", parameters: {} }] },
      { type: "namespace", name: "ocx_agents", description: GUIDANCE, tools: [{ ...spawn, description: `${GUIDANCE} spawn_agent.` }] },
    ] });

    expect(() => injectV2RoutedDelegationBridge(request)).toThrow("v2 routed delegation bridge namespace collision");
  });

  test("accepts a key-reordered injected mirror as idempotent", () => {
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [spawn] }] };
    const request = parsed(body);
    injectV2RoutedDelegationBridge(request);
    const mirror = body.tools[1] as { tools: Array<Record<string, unknown>> };
    mirror.tools[0] = Object.fromEntries(Object.entries(mirror.tools[0]!).reverse());

    expect(() => injectV2RoutedDelegationBridge(request)).not.toThrow();
  });

  test("leaves a collaboration group with no mirrorable function inactive", () => {
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "wait_agent", parameters: {} }] }] };
    const request = parsed(body);
    const before = structuredClone(body);
    const tools = structuredClone(request.context.tools);

    expect(injectV2RoutedDelegationBridge(request)).toBeUndefined();
    expect(body).toEqual(before);
    expect(request.context.tools).toEqual(tools);
  });

  test("normalizes only armed mirror calls in JSON", () => {
    const active = { names: new Set(["spawn_agent"]) };
    const input = JSON.stringify({ output: [
      { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "{}", status: "completed" },
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_2", call_id: "call_2", arguments: "{}" },
      { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_3", call_id: "call_3", arguments: "{}" },
      { type: "function_call", namespace: 4, name: "spawn_agent", id: "fc_4", call_id: "call_4", arguments: "{}" },
    ] });

    expect(JSON.parse(rewriteV2RoutedDelegationCallsInJson(input, active))).toEqual({ output: [
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "{}", status: "completed", encrypted_function_args: [] },
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", id: "fc_2", call_id: "call_2", arguments: "{}" },
      { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_3", call_id: "call_3", arguments: "{}" },
      { type: "function_call", namespace: 4, name: "spawn_agent", id: "fc_4", call_id: "call_4", arguments: "{}" },
    ] });
  });

  test("preserves owned __proto__ data while normalizing untrusted JSON", () => {
    const input = '{"__proto__":{"polluted":true},"type":"function_call","namespace":"ocx_agents","name":"spawn_agent"}';
    const output = JSON.parse(rewriteV2RoutedDelegationCallsInJson(input, { names: new Set(["spawn_agent"]) }));

    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(output.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  test("normalizes SSE item snapshots and only matching interleaved argument events", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = JSON.stringify({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_1", call_id: "call_1", arguments: "", status: "in_progress" } });
    const unrelated = JSON.stringify({ type: "response.output_item.added", output_index: 4, item: { type: "function_call", namespace: "ocx_agents", name: "list_agents", id: "fc_2", call_id: "call_2", arguments: "" } });

    expect(JSON.parse(rewrite(added))).toMatchObject({ item: { namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [] } });
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "native_fc", output_index: 3, delta: "{" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 4, delta: "{" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 3, arguments: "{}" })))).toMatchObject({ encrypted_function_args: [] });
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 3, delta: "late" })))).not.toHaveProperty("encrypted_function_args");
    expect(JSON.parse(rewrite(unrelated))).toMatchObject({ item: { namespace: "ocx_agents", name: "list_agents" } });
  });

  test("fails ID-less mirror snapshots closed and leaves index-only arguments untouched", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const snapshot = JSON.stringify({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent" } });

    expect(() => rewrite(snapshot)).toThrow("v2 routed delegation bridge received an unbound SSE call");
    const argument = JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 3, delta: "{}" });
    expect(rewrite(argument)).toBe(argument);
  });

  test("fails closed before a capped SSE mirror can escape", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    for (let index = 0; index < 128; index++) {
      rewrite(JSON.stringify({ type: "response.output_item.added", output_index: index, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: `fc_${index}` } }));
    }

    expect(() => rewrite(JSON.stringify({ type: "response.output_item.added", output_index: 128, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_128" } })))
      .toThrow("v2 routed delegation bridge exceeded 128 SSE call bindings");
  });

  test("keeps only authorized nonblank ids through completed aggregates", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const snapshot = (id: string, output_index: number) => JSON.stringify({ type: "response.output_item.added", output_index, item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id } });
    rewrite(snapshot("fc_0", 0));
    expect(() => rewrite(snapshot(" ", 1))).toThrow("v2 routed delegation bridge received an unbound SSE call");
    const completed = JSON.parse(rewrite(JSON.stringify({ type: "response.completed", response: { output: [
      { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_0" },
    ] } })));

    expect(completed.response.output.map((item: { namespace: string }) => item.namespace)).toEqual(["collaboration"]);
    expect(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_0", delta: "late" }))).toContain('"item_id":"fc_0"');
  });

  test("normalizes admitted calls in failed and incomplete terminal snapshots", () => {
    for (const type of ["response.failed", "response.incomplete"]) {
      const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
      rewrite(JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_terminal" } }));

      const terminal = JSON.parse(rewrite(JSON.stringify({ type, response: { status: type.slice(9), output: [
        { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_terminal" },
      ] } })));

      expect(terminal.response.output[0]).toMatchObject({ namespace: "collaboration", encrypted_function_args: [] });
    }
  });

  test("an unknown item-id terminal does not affect an authorized call", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    rewrite(JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_known" } }));
    const unknown = JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_unknown", arguments: "{}" });

    expect(rewrite(unknown)).toBe(unknown);
    expect(JSON.parse(rewrite(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_known", delta: "{}" }))).encrypted_function_args).toEqual([]);
  });

  test("does not reauthorize arguments after a call closes", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_closed" } });
    rewrite(added);
    rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_closed", arguments: "{}" }));
    rewrite(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_closed" } }));

    const late = JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_closed", delta: "late" });
    expect(rewrite(late)).toBe(late);
  });

  test("does not reopen a closed id when its added snapshot repeats", () => {
    const rewrite = createV2RoutedDelegationSseRewrite({ names: new Set(["spawn_agent"]) })!;
    const added = JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_duplicate" } });
    rewrite(added);
    rewrite(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_duplicate", arguments: "{}" }));
    rewrite(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", namespace: "ocx_agents", name: "spawn_agent", id: "fc_duplicate" } }));

    expect(JSON.parse(rewrite(added))).toMatchObject({ item: { namespace: "collaboration", encrypted_function_args: [] } });
    const late = JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_duplicate", delta: "late" });
    expect(rewrite(late)).toBe(late);
  });

});
