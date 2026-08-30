/**
 * #1700: the native Responses passthrough relayed a routed provider's call to a tool the request
 * never declared. Codex has no top-level handler for it, so the turn surfaced as a bare `aborted`
 * with the target file untouched. The bridged paths already fail closed on the same condition
 * (`declaredToolNames`, src/bridge.ts); these pin the passthrough's equivalent.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDeclaredNamelessClientCallTypes,
  collectDeclaredWireToolNames,
  collectProviderExecutedCallTypes,
  createUndeclaredToolCallGuardBlockRewrite,
  currentTurnWireToolCatalogBody,
  hasExplicitWireToolCatalog,
  undeclaredToolCallNameInResponse,
  UNDECLARED_TOOL_CALL_ERROR_CODE,
  type ProviderExecutedCallType,
} from "../src/server/responses-undeclared-tool-guard";
import { relaySseWithBlockRewrite } from "../src/server/sse-payload-rewrite";
import { handleResponses } from "../src/server/responses";
import { expandPreviousResponseInput } from "../src/responses/state";
import type { OcxConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

/** One SSE event block without its blank-line delimiter. */
function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;
}

/** One SSE event block including its delimiter, ready to concatenate. */
function sse(type: string, payload: Record<string, unknown>): string {
  return `${frame(type, payload)}\n\n`;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function relay(
  upstream: string,
  declared: Iterable<string>,
  declaredNamelessClientCallTypes: Iterable<string> = [],
): Promise<string> {
  const budget = createTestTranslatorBudget();
  try {
    return await readAll(relaySseWithBlockRewrite(
      streamFromText(upstream),
      createUndeclaredToolCallGuardBlockRewrite(
        new Set(declared),
        new Set(declaredNamelessClientCallTypes),
      ),
      budget,
    ));
  } finally {
    budget.dispose();
  }
}

describe("collectDeclaredWireToolNames", () => {
  test("reads function, custom, and namespaced tools off the outbound body", () => {
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "function", name: "exec" },
        { type: "custom", name: "apply_patch" },
        { type: "namespace", name: "linear", tools: [{ type: "function", name: "create_issue" }] },
        { type: "web_search" },
      ],
    });

    // Namespaced MCP tools are reachable under either coordinate system, so both are accepted.
    expect([...names].sort()).toEqual(
      ["apply_patch", "create_issue", "exec", "linear__create_issue"],
    );
  });

  test("withholds the bare alias when only a namespaced exec was declared", () => {
    // A bare `exec` in the declared set is not just a name: it switches on nested-helper
    // normalization, so aliasing a namespaced MCP `exec` under the bare name would authorize
    // `exec_command`/`shell_command`/`apply_patch` this request never declared.
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "exec" }] }],
    });

    expect([...names]).toEqual(["mcp__exec"]);
  });

  test("keeps exec bare in Codex's reserved functions namespace", () => {
    // Codex groups ordinary top-level tools here; this is not an MCP namespace and the parser
    // deliberately lowers its children without a namespace.
    const names = collectDeclaredWireToolNames({
      tools: [{
        type: "namespace",
        name: "functions",
        tools: [{ type: "custom", name: "exec", description: "Run a command" }],
      }],
    });

    expect([...names]).toEqual(["exec"]);
  });

  test("keeps the bare alias when the request also declared a top-level exec", () => {
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "custom", name: "exec" },
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "exec" }] },
      ],
    });

    expect([...names].sort()).toEqual(["exec", "mcp__exec"]);
  });

  test("reads tools carried inside input as an additional_tools item", () => {
    // Codex Desktop's responses_lite WS path ships the catalog there instead of body.tools.
    const names = collectDeclaredWireToolNames({
      input: [
        { type: "message", role: "user", content: [] },
        { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "wait" }] },
      ],
    });

    expect([...names]).toEqual(["wait"]);
  });

  test("reads definitions loaded by a current tool-search output", () => {
    const names = collectDeclaredWireToolNames({
      input: [{
        type: "tool_search_output",
        tools: [{ type: "function", name: "deferred_read" }],
      }],
    });

    expect([...names]).toEqual(["deferred_read"]);
  });

  test("recognizes nested function names accepted by the parser", () => {
    expect([...collectDeclaredWireToolNames({
      tools: [{ type: "function", function: { name: "lookup" } }],
    })]).toEqual(["lookup"]);
    expect(collectDeclaredWireToolNames({
      tools: [{ type: "function", function: {} }],
    }).size).toBe(0);
  });

  test("is empty for a body this proxy could not read", () => {
    expect(collectDeclaredWireToolNames(undefined).size).toBe(0);
    expect(collectDeclaredWireToolNames({ tools: "nonsense" }).size).toBe(0);
  });

  test("is empty when a readable request omits the tool catalog", () => {
    expect(collectDeclaredWireToolNames({}).size).toBe(0);
  });

  test("is empty when a readable request explicitly declares an empty tool catalog", () => {
    // The name set alone cannot distinguish omission from an explicit deny-all catalog, so the
    // caller separately tracks whether the readable body contained a supported catalog array.
    expect(collectDeclaredWireToolNames({ tools: [] }).size).toBe(0);
  });

  test("ignores hosted tool entries, which carry no client-executable name", () => {
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "web_search" }, { type: "image_generation" }, { type: "function", name: "exec" }],
    });

    expect([...names]).toEqual(["exec"]);
  });
});

describe("hasExplicitWireToolCatalog", () => {
  test("distinguishes omitted or unreadable catalogs from top-level arrays", () => {
    expect(hasExplicitWireToolCatalog(undefined)).toBe(false);
    expect(hasExplicitWireToolCatalog({})).toBe(false);
    expect(hasExplicitWireToolCatalog({ tools: "nonsense" })).toBe(false);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "function" }] })).toBe(false);
    expect(hasExplicitWireToolCatalog({ tools: [] })).toBe(true);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "function", name: "exec" }] })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      tools: [{ type: "function" }, { type: "custom", name: "apply_patch" }],
    })).toBe(true);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "web_search" }] })).toBe(true);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "image_gen" }, { type: "x_search" }] })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      tools: [{ type: "namespace", name: "empty", tools: [] }],
    })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      tools: [{
        type: "namespace",
        name: "outer",
        tools: [{ type: "namespace", name: "inner", tools: [] }],
      }],
    })).toBe(false);
  });

  test("recognizes an additional_tools array, including an explicit empty catalog", () => {
    expect(hasExplicitWireToolCatalog({
      input: [{ type: "additional_tools", role: "developer", tools: [] }],
    })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      input: [{ type: "additional_tools", role: "developer", tools: "nonsense" }],
    })).toBe(false);
    expect(hasExplicitWireToolCatalog({
      input: [{ type: "additional_tools", role: "developer", tools: [{}] }],
    })).toBe(false);
  });
});

describe("collectDeclaredNamelessClientCallTypes", () => {
  test("maps supported nameless declarations to their client response call types", () => {
    const callTypes = collectDeclaredNamelessClientCallTypes({
      tools: [{ type: "local_shell" }, { type: "tool_search" }, { type: "web_search" }],
      input: [{
        type: "additional_tools",
        tools: [{ type: "computer_use_preview" }, { type: "function", name: "exec" }],
      }],
    });

    expect([...callTypes].sort()).toEqual(["computer_call", "local_shell_call", "tool_search_call"]);
  });
});

describe("currentTurnWireToolCatalogBody", () => {
  test("keeps top-level tools and only the current input suffix", () => {
    const body = {
      tools: [],
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "historical" }] },
        { type: "message", role: "assistant", content: [] },
        { type: "additional_tools", tools: [{ type: "function", name: "current" }] },
      ],
    };
    const current = currentTurnWireToolCatalogBody(body, 2) as typeof body;

    expect(current.tools).toEqual([]);
    expect(current.input).toEqual([
      { type: "additional_tools", tools: [{ type: "function", name: "current" }] },
    ]);
    expect(body.input).toHaveLength(3);
  });
});


describe("undeclared tool call guard", () => {
  const declared = ["exec", "wait", "request_user_input"];

  test("relays a declared call untouched", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", arguments: "{}" },
    }) + sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } });

    expect(await relay(upstream, declared)).toBe(upstream);
  });

  test("replaces an undeclared tool with a compatibility failure", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "other_tool", arguments: "{}" },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain("event: response.failed");
    expect(out).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(out).toContain('routed provider emitted undeclared client tool \\"other_tool\\"');
    expect(out).toEndWith("data: [DONE]\n\n");
  });

  test("drops the rest of the turn so a later completed cannot contradict the failure", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "other_tool", arguments: "" },
    })
      + sse("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"input\":\"" })
      + sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } })
      + "data: [DONE]\n\n";

    const out = await relay(upstream, declared);
    expect(out).not.toContain("response.completed");
    expect(out).not.toContain("function_call_arguments");
    expect(out.match(/\[DONE\]/g)).toHaveLength(1);
  });

  test("catches the snapshot-only shape, where no item event is ever streamed", async () => {
    const upstream = sse("response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "message", id: "msg_0", role: "assistant" },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "other_tool", arguments: "{}" },
        ],
      },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(out).not.toContain('"status":"completed"');
  });

  test("accepts a namespaced call echoed under its bare name", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "create_issue",
        namespace: "linear",
        arguments: "{}",
      },
    });

    expect(await relay(upstream, ["linear__create_issue"])).toBe(upstream);
  });

  test("never blocks apply_patch when the request really declared it", async () => {
    // `apply_patch` is exempt from the routed custom-tool rewrite, so it reaches upstream as
    // `{type:"custom"}` and comes back as a `custom_tool_call`. A request that declares it must
    // keep working — the guard exists for the case where the catalog never mentioned it.
    const outbound = { tools: [{ type: "custom", name: "apply_patch" }, { type: "function", name: "exec" }] };
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "" },
    });

    expect(await relay(upstream, collectDeclaredWireToolNames(outbound))).toBe(upstream);
  });

  test("ignores upstream-executed calls, which are never matched against the catalog", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "web_search_call", id: "ws_1", status: "completed" },
    }) + sse("response.output_item.added", {
      output_index: 1,
      item: { type: "tool_search_call", id: "tsc_1", status: "completed" },
    });

    expect(await relay(upstream, declared)).toBe(upstream);
  });

  test("relays a declared nameless client call and rejects an undeclared one", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: {
        type: "local_shell_call",
        id: "sh_1",
        call_id: "call_1",
        action: { type: "exec", command: ["echo", "ok"] },
      },
    });

    expect(await relay(upstream, [], ["local_shell_call"])).toBe(upstream);
    expect(await relay(upstream, [])).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
  });

  test("does not classify a server-executed tool search as a client call", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "tool_search_call", id: "ts_1", execution: "server", arguments: {} },
    });

    expect(await relay(upstream, [])).toBe(upstream);
  });

  test("leaves comment frames, [DONE], and unparseable payloads alone", async () => {
    const upstream = ": keep-alive\n\ndata: {not json\n\ndata: [DONE]\n\n";

    expect(await relay(upstream, declared)).toBe(upstream);
  });

  test("bounds a hostile tool name before it reaches the error message", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "x".repeat(5_000), arguments: "{}" },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain(`\\"${"x".repeat(100)}\\"`);
    expect(out).not.toContain("x".repeat(101));
  });
});

describe("the reported turn, end to end through handleResponses", () => {
  // The report's setup: provider `opencode-go`, a model pinned to the openai-responses adapter,
  // and a Codex catalog of exec/wait/request_user_input with no top-level apply_patch schema.
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

  const requestBody = (stream: boolean) => JSON.stringify({
    model: "fixture/deepseek-v4-flash",
    stream,
    input: [{ role: "user", content: [{ type: "input_text", text: "change v1 to v2" }] }],
    tools: [
      { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
      { type: "function", name: "wait", parameters: { type: "object" } },
      { type: "function", name: "request_user_input", parameters: { type: "object" } },
    ],
  });

  const leakedCall = {
    type: "function_call",
    id: "fc_patch",
    call_id: "call_patch",
    name: "apply_patch",
    arguments: "{\"input\":\"*** Begin Patch\"}",
    status: "completed",
  };

  async function post(
    stream: boolean,
    upstream: () => Response,
    body: string = requestBody(stream),
  ): Promise<Response> {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => upstream()) as typeof fetch;
    try {
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }


  test("streaming: a top-level apply_patch is bridged through unified exec", async () => {
    const response = await post(true, () => new Response([
      frame("response.output_item.added", { output_index: 0, item: { ...leakedCall, arguments: "", status: "in_progress" } }),
      frame("response.output_item.done", { output_index: 0, item: leakedCall }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [leakedCall] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }));

    const body = await response.text();
    expect(body).not.toContain("response.failed");
    expect(body).toContain("response.completed");
    expect(body).toContain('"name":"exec"');
    expect(body).toContain("await tools.apply_patch");
  });

  test("non-streaming: the same call is bridged through unified exec", async () => {
    const response = await post(false, () => new Response(
      JSON.stringify({ id: "resp_1", status: "completed", output: [leakedCall] }),
      { headers: { "content-type": "application/json" } },
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec" });
    expect(body.output[0]?.input).toContain("await tools.apply_patch");
  });

  test("a declared exec call still completes normally", async () => {
    const execCall = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"await tools.apply_patch('*** Begin Patch')\"}",
      status: "completed",
    };
    const response = await post(false, () => new Response(
      JSON.stringify({ id: "resp_1", status: "completed", output: [execCall] }),
      { headers: { "content-type": "application/json" } },
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    // `exec` is declared as a custom tool, so it comes back restored to a custom_tool_call —
    // the supported editing path in the report stays intact.
    expect(body.output[0]).toMatchObject({ name: "exec", call_id: "call_exec" });
  });
});

describe("a refused turn does not become continuation state", () => {
  // The guard rejects the turn for the client, so it must not also be cached as a completed
  // response: a later `previous_response_id` replay would otherwise expand from a turn the
  // client never accepted, reintroducing the undeclared call as history.
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

  const declaredTools = [
    { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
  ];

  async function turn(responseId: string, outputItem: Record<string, unknown>): Promise<Response> {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ id: responseId, status: "completed", output: [outputItem] }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    try {
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "edit the file" }] }],
          tools: declaredTools,
        }),
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  /** How many items a follow-up turn inherits by naming `previousId`. */
  function expandedInputLength(previousId: string): number {
    const followUp = {
      model: "fixture/deepseek-v4-flash",
      previous_response_id: previousId,
      input: [{ role: "user", content: [{ type: "input_text", text: "and again" }] }],
      tools: declaredTools,
    };
    const expanded = expandPreviousResponseInput(followUp) as { input?: unknown[] };
    return Array.isArray(expanded.input) ? expanded.input.length : 0;
  }

  test("a completed turn is remembered, so the control is meaningful", async () => {
    const accepted = await turn("resp_accepted", {
      type: "function_call", id: "fc_ok", call_id: "call_ok", name: "exec", arguments: "{}", status: "completed",
    });

    expect(accepted.status).toBe(200);
    expect(expandedInputLength("resp_accepted")).toBeGreaterThan(1);
  });

  test("a bridged apply_patch turn is remembered as the declared exec call", async () => {
    const accepted = await turn("resp_apply_patch_bridged", {
      type: "function_call",
      id: "fc_patch",
      call_id: "call_patch",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
      status: "completed",
    });

    expect(accepted.status).toBe(200);
    const expanded = expandPreviousResponseInput({
      model: "fixture/deepseek-v4-flash",
      previous_response_id: "resp_apply_patch_bridged",
      input: [{ role: "user", content: [{ type: "input_text", text: "and again" }] }],
      tools: declaredTools,
    }) as { input?: Array<Record<string, unknown>> };
    const rememberedCall = expanded.input?.find(item => item.call_id === "call_patch");

    expect(rememberedCall).toMatchObject({ type: "custom_tool_call", name: "exec" });
    expect(rememberedCall?.input).toContain("tools.apply_patch");
    expect(JSON.stringify(expanded)).not.toContain('"name":"apply_patch"');
  });

  test("a streamed bridged apply_patch turn is remembered as the declared exec call", async () => {
    const responseId = "resp_stream_apply_patch_bridged";
    const call = {
      type: "function_call",
      id: "fc_stream_patch",
      call_id: "call_stream_patch",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
      status: "completed",
    };
    const sse = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: responseId, status: "in_progress" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: call })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", output: [call] } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    let response: Response;
    try {
      response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "edit the file" }] }],
          tools: declaredTools,
        }),
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }

    const clientStream = await response.text();
    expect(clientStream).toContain('"name":"exec"');
    expect(clientStream).not.toContain("response.failed");
    await Bun.sleep(50);

    const expanded = expandPreviousResponseInput({
      model: "fixture/deepseek-v4-flash",
      previous_response_id: responseId,
      input: [{ role: "user", content: [{ type: "input_text", text: "and again" }] }],
      tools: declaredTools,
    }) as { input?: Array<Record<string, unknown>> };
    const rememberedCall = expanded.input?.find(item => item.call_id === "call_stream_patch");
    expect(rememberedCall).toMatchObject({ type: "custom_tool_call", name: "exec" });
    expect(rememberedCall?.input).toContain("tools.apply_patch");
  });

  test("a refused turn is not", async () => {
    const refused = await turn("resp_refused", {
      type: "function_call", id: "fc_bad", call_id: "call_bad", name: "other_tool", arguments: "{}", status: "completed",
    });

    expect(refused.status).toBe(502);
    // Nothing to inherit: the follow-up keeps only its own single input item.
    expect(expandedInputLength("resp_refused")).toBe(1);
  });

  test("a streamed turn refused mid-stream is not remembered, even when the terminal snapshot is empty", async () => {
    // The terminal-snapshot check alone misses this shape: the undeclared call is announced in
    // `response.output_item.added` (which trips the client guard) and the stream then closes with
    // a `response.completed` carrying an EMPTY output. The client sees `response.failed`, the
    // terminal check sees nothing undeclared, and the refused turn would enter continuation state.
    const responseId = "resp_stream_refused";
    const sse = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: responseId, status: "in_progress" } })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_bad", call_id: "call_bad", name: "other_tool", arguments: "{}" },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", output: [] } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    let response: Response;
    try {
      response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "edit the file" }] }],
          tools: declaredTools,
        }),
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }

    // Drain so the inspection side observes the whole stream before we assert on its effect.
    const clientStream = await response.text();
    expect(clientStream).toContain("response.failed");
    await Bun.sleep(50);

    // Nothing to inherit: the follow-up keeps only its own single input item.
    expect(expandedInputLength(responseId)).toBe(1);
  });
});

describe("empty and absent tool catalogs", () => {
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

  const xaiConfig = {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "fixture-key",
      },
    },
  } as OcxConfig;

  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "apply_patch",
    arguments: "{}",
    status: "completed",
  };

  async function post(
    stream: boolean,
    tools: unknown[] | undefined,
    upstream: () => Response,
    additionalTools?: unknown[],
    requestConfig: OcxConfig = config,
    history: unknown[] = [],
    model = "fixture/deepseek-v4-flash",
    previousResponseId?: string,
    toolChoice?: unknown,
  ) {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => upstream()) as typeof fetch;
    try {
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          input: [
            ...history,
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
            ...(additionalTools === undefined
              ? []
              : [{ type: "additional_tools", role: "developer", tools: additionalTools }]),
          ],
          ...(tools === undefined ? {} : { tools }),
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        }),
      }), requestConfig, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  const jsonUpstream = () => new Response(
    JSON.stringify({ id: "resp_1", status: "completed", output: [call] }),
    { headers: { "content-type": "application/json" } },
  );

  const sseUpstream = () => new Response(
    [
      frame("response.output_item.added", { output_index: 0, item: call }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [call] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

  // A passthrough request may omit `tools` entirely and still receive a tool call the client
  // understands — the Copilot contract in tests/github-copilot-stream-contract.test.ts does
  // exactly that with `apply_patch`. With no catalog the proxy has no authorization boundary to
  // enforce, so the call remains untouched on both transports.
  test("non-streaming, no tools field — relayed, not refused", async () => {
    const response = await post(false, undefined, jsonUpstream);

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject({ name: "apply_patch" });
  });

  test("streaming, no tools field — relayed, not refused", async () => {
    const response = await post(true, undefined, sseUpstream);
    const body = await response.text();

    expect(body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(body).toContain("response.completed");
  });

  test("non-streaming, an unreadable top-level catalog — relayed, not refused", async () => {
    const response = await post(false, [{ type: "function" }], jsonUpstream);

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject({ name: "apply_patch" });
  });

  test("streaming, an unreadable additional_tools catalog — relayed, not refused", async () => {
    const response = await post(true, undefined, sseUpstream, [{}]);
    const body = await response.text();

    expect(body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(body).toContain("response.completed");
  });

  test("Spark normalization cannot turn an unreadable catalog into deny-all", async () => {
    const response = await post(
      false,
      [{ type: "some_future_hosted_tool" }],
      jsonUpstream,
      undefined,
      config,
      [],
      "fixture/gpt-5.3-codex-spark",
    );

    expect(response.status).toBe(200);
    const sparkBody = await response.json() as { output: Array<Record<string, unknown>> };
    expect(sparkBody.output[0]).toMatchObject({ name: "apply_patch" });
  });

  test("Spark normalization preserves streaming stand-down for an unreadable top-level catalog", async () => {
    const response = await post(
      true,
      [{ type: "some_future_hosted_tool" }],
      sseUpstream,
      undefined,
      config,
      [],
      "fixture/gpt-5.3-codex-spark",
    );
    const sparkBody = await response.text();

    expect(sparkBody).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(sparkBody).toContain("response.completed");
  });

  test("Spark normalization preserves non-streaming stand-down for unreadable additional tools", async () => {
    const response = await post(
      false,
      undefined,
      jsonUpstream,
      [{ type: "some_future_hosted_tool" }],
      config,
      [],
      "fixture/gpt-5.3-codex-spark",
    );

    expect(response.status).toBe(200);
    const sparkBody = await response.json() as { output: Array<Record<string, unknown>> };
    expect(sparkBody.output[0]).toMatchObject({ name: "apply_patch" });
  });

  test("Spark normalization preserves streaming stand-down for unreadable additional tools", async () => {
    const response = await post(
      true,
      undefined,
      sseUpstream,
      [{ type: "some_future_hosted_tool" }],
      config,
      [],
      "fixture/gpt-5.3-codex-spark",
    );
    const sparkBody = await response.text();

    expect(sparkBody).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(sparkBody).toContain("response.completed");
  });

  test("non-streaming, tools: [] — refuses an upstream client tool call", async () => {
    const response = await post(false, [], jsonUpstream);

    expect(response.status).toBe(502);
    const topLevelEmptyBody = await response.json() as { error: { message: string } };
    expect(topLevelEmptyBody.error.message).toContain('undeclared client tool "apply_patch"');
  });

  test("streaming, tools: [] — refuses an upstream client tool call", async () => {
    const response = await post(true, [], sseUpstream);
    const body = await response.text();

    expect(body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(body).not.toContain("response.completed");
  });

  test("non-streaming, additional_tools.tools: [] — refuses an upstream client tool call", async () => {
    const response = await post(false, undefined, jsonUpstream, []);

    expect(response.status).toBe(502);
    const embeddedEmptyBody = await response.json() as { error: { message: string } };
    expect(embeddedEmptyBody.error.message).toContain('undeclared client tool "apply_patch"');
  });

  test("streaming, additional_tools.tools: [] — refuses an upstream client tool call", async () => {
    const response = await post(true, undefined, sseUpstream, []);
    const body = await response.text();

    expect(body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(body).not.toContain("response.completed");
  });

  test("non-streaming, a rewritten-away top-level catalog remains authoritative", async () => {
    const response = await post(
      false,
      [{ type: "web_search", external_web_access: false }],
      jsonUpstream,
      undefined,
      xaiConfig,
    );

    expect(response.status).toBe(502);
    const rewrittenCatalogBody = await response.json() as { error: { message: string } };
    expect(rewrittenCatalogBody.error.message).toContain('undeclared client tool "apply_patch"');
  });

  test("streaming, a rewritten-away additional_tools catalog remains authoritative", async () => {
    const response = await post(
      true,
      undefined,
      sseUpstream,
      [{ type: "web_search", external_web_access: false }],
      xaiConfig,
    );
    const body = await response.text();

    expect(body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(body).not.toContain("response.completed");
  });

  test("non-streaming, tools: [] — refuses a nameless local shell call", async () => {
    const response = await post(false, [], () => Response.json({
      id: "resp_shell",
      status: "completed",
      output: [{
        type: "local_shell_call",
        id: "sh_1",
        call_id: "call_shell",
        action: { type: "exec", command: ["echo", "ok"] },
        status: "completed",
      }],
    }));

    expect(response.status).toBe(502);
    const localShellBody = await response.json() as { error: { message: string } };
    expect(localShellBody.error.message).toContain('undeclared client tool "local_shell"');
  });

  test("streaming, additional_tools.tools: [] — refuses a client tool-search call", async () => {
    const response = await post(true, undefined, () => new Response(
      [
        frame("response.output_item.added", {
          output_index: 0,
          item: {
            type: "tool_search_call",
            id: "ts_1",
            call_id: "call_search",
            execution: "client",
            arguments: { query: "tools" },
          },
        }),
        frame("response.completed", {
          response: { id: "resp_search", status: "completed", output: [] },
        }),
        "data: [DONE]",
      ].join("\n\n") + "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ), []);
    const toolSearchBody = await response.text();

    expect(toolSearchBody).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(toolSearchBody).toContain('undeclared client tool \\"tool_search\\"');
    expect(toolSearchBody).not.toContain("response.completed");
  });

  test("a declared tool_search authorizes its nameless client call", async () => {
    const response = await post(false, [{ type: "tool_search" }], () => Response.json({
      id: "resp_search_allowed",
      status: "completed",
      output: [{
        type: "tool_search_call",
        id: "ts_1",
        call_id: "call_search",
        execution: "client",
        arguments: { query: "tools" },
        status: "completed",
      }],
    }));

    expect(response.status).toBe(200);
    const allowedSearchBody = await response.json() as { output: Array<Record<string, unknown>> };
    expect(allowedSearchBody.output[0]).toMatchObject({ type: "tool_search_call", execution: "client" });
  });

  test("history-only tool search restoration does not override a current empty catalog", async () => {
    const response = await post(
      false,
      [],
      () => Response.json({
        id: "resp_history_search",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_history_search",
          call_id: "call_history_search",
          name: "tool_search",
          arguments: '{"query":"new tools"}',
          status: "completed",
        }],
      }),
      undefined,
      config,
      [
        {
          type: "tool_search_call",
          id: "tsc_old",
          call_id: "call_old",
          execution: "client",
          arguments: { query: "old tools" },
          status: "completed",
        },
        {
          type: "tool_search_output",
          call_id: "call_old",
          execution: "client",
          status: "completed",
          tools: [],
        },
      ],
    );

    expect(response.status).toBe(502);
    const historySearchBody = await response.json() as { error: { message: string } };
    expect(historySearchBody.error.message).toContain('undeclared client tool "tool_search"');
  });

  test("a replayed named catalog cannot authorize a deny-all continuation", async () => {
    const previousId = "resp_replayed_named_catalog";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
      [{ type: "function", name: "exec", parameters: { type: "object" } }],
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const response = await post(
      false,
      [],
      () => Response.json({
        id: "resp_named_continuation",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_replayed_exec",
          call_id: "call_replayed_exec",
          name: "exec",
          arguments: "{}",
          status: "completed",
        }],
      }),
      undefined,
      config,
      [],
      "fixture/deepseek-v4-flash",
      previousId,
    );

    expect(response.status).toBe(502);
    const namedBody = await response.json() as { error: { message: string } };
    expect(namedBody.error.message).toContain('undeclared client tool "exec"');
  });

  test("a replayed nameless catalog cannot authorize a deny-all continuation", async () => {
    const previousId = "resp_replayed_nameless_catalog";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
      [{ type: "local_shell" }],
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const response = await post(
      true,
      undefined,
      () => {
        const replayedShell = {
          type: "local_shell_call",
          id: "sh_replayed",
          call_id: "call_replayed_shell",
          action: { type: "exec", command: ["echo", "blocked"] },
          status: "completed",
        };
        return new Response(
          [
            frame("response.output_item.added", { output_index: 0, item: replayedShell }),
            frame("response.completed", {
              response: { id: "resp_nameless_continuation", status: "completed", output: [replayedShell] },
            }),
            "data: [DONE]",
          ].join("\n\n") + "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      [],
      config,
      [],
      "fixture/deepseek-v4-flash",
      previousId,
    );

    const namelessBody = await response.text();
    expect(namelessBody).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(namelessBody).toContain('undeclared client tool \\"local_shell\\"');
    expect(namelessBody).not.toContain("response.completed");
  });

  test("a replay without a current catalog retains passthrough compatibility", async () => {
    const previousId = "resp_replayed_catalog_without_current_boundary";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
      [{ type: "function", name: "exec", parameters: { type: "object" } }],
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const response = await post(
      false,
      undefined,
      () => Response.json({
        id: "resp_unbounded_continuation",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_unbounded_exec",
          call_id: "call_unbounded_exec",
          name: "exec",
          arguments: "{}",
          status: "completed",
        }],
      }),
      undefined,
      config,
      [],
      "fixture/deepseek-v4-flash",
      previousId,
    );

    expect(response.status).toBe(200);
    const unboundedBody = await response.json() as { output: Array<Record<string, unknown>> };
    expect(unboundedBody.output[0]).toMatchObject({ name: "exec" });
  });

  test("a current additional-tools suffix still authorizes after replay", async () => {
    const previousId = "resp_replay_with_current_catalog_suffix";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
      [{ type: "function", name: "historical", parameters: { type: "object" } }],
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const response = await post(
      false,
      undefined,
      () => Response.json({
        id: "resp_current_suffix",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_current_exec",
          call_id: "call_current_exec",
          name: "exec",
          arguments: "{}",
          status: "completed",
        }],
      }),
      [{ type: "function", name: "exec", parameters: { type: "object" } }],
      config,
      [],
      "fixture/deepseek-v4-flash",
      previousId,
    );

    expect(response.status).toBe(200);
    const currentBody = await response.json() as { output: Array<Record<string, unknown>> };
    expect(currentBody.output[0]).toMatchObject({ name: "exec" });
  });

  test("a replayed functions namespace still authorizes its top-level exec", async () => {
    const previousId = "resp_replay_with_functions_exec";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
      [{ type: "function", name: "historical", parameters: { type: "object" } }],
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const response = await post(
      false,
      undefined,
      () => Response.json({
        id: "resp_functions_exec",
        status: "completed",
        output: [{
          type: "custom_tool_call",
          id: "ctc_functions_exec",
          call_id: "call_functions_exec",
          name: "exec",
          input: "echo allowed",
          status: "completed",
        }],
      }),
      [{
        type: "namespace",
        name: "functions",
        tools: [{ type: "custom", name: "exec", description: "Run a command" }],
      }],
      config,
      [],
      "fixture/deepseek-v4-flash",
      previousId,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject({ name: "exec", type: "custom_tool_call" });
  });

  test("a current tool-search output still authorizes its discovered tool after replay", async () => {
    const previousId = "resp_replay_with_current_tool_search_output";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const response = await post(
      false,
      [{ type: "tool_search" }],
      () => Response.json({
        id: "resp_discovered_tool",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_deferred_read",
          call_id: "call_deferred_read",
          name: "deferred_read",
          arguments: "{}",
          status: "completed",
        }],
      }),
      undefined,
      config,
      [
        {
          type: "tool_search_call",
          id: "tsc_current",
          call_id: "call_current_search",
          execution: "client",
          arguments: { query: "read tools" },
          status: "completed",
        },
        {
          type: "tool_search_output",
          call_id: "call_current_search",
          execution: "client",
          status: "completed",
          tools: [{ type: "function", name: "deferred_read", parameters: { type: "object" } }],
        },
      ],
      "fixture/deepseek-v4-flash",
      previousId,
    );

    expect(response.status).toBe(200);
    const discoveredBody = await response.json() as { output: Array<Record<string, unknown>> };
    expect(discoveredBody.output[0]).toMatchObject({ name: "deferred_read" });
  });

  test("a nameless-only current discovery activates a bounded replay guard", async () => {
    const previousId = "resp_replay_with_current_nameless_discovery";
    const prime = await post(
      false,
      undefined,
      () => Response.json({ id: previousId, status: "completed", output: [] }),
    );
    expect(prime.status).toBe(200);
    await prime.arrayBuffer();

    const discoveryInput = [
      {
        type: "tool_search_call",
        id: "tsc_nameless",
        call_id: "call_nameless_search",
        execution: "client",
        arguments: { query: "shell tools" },
        status: "completed",
      },
      {
        type: "tool_search_output",
        call_id: "call_nameless_search",
        execution: "client",
        status: "completed",
        tools: [{ type: "local_shell" }],
      },
    ];

    const allowed = await post(
      false,
      undefined,
      () => Response.json({
        id: "resp_discovered_shell",
        status: "completed",
        output: [{
          type: "local_shell_call",
          id: "sh_discovered",
          call_id: "call_discovered_shell",
          action: { type: "exec", command: ["echo", "allowed"] },
          status: "completed",
        }],
      }),
      undefined,
      config,
      discoveryInput,
      "fixture/deepseek-v4-flash",
      previousId,
    );
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();

    const refused = await post(
      false,
      undefined,
      jsonUpstream,
      undefined,
      config,
      discoveryInput,
      "fixture/deepseek-v4-flash",
      previousId,
    );
    expect(refused.status).toBe(502);
    const refusedBody = await refused.json() as { error: { message: string } };
    expect(refusedBody.error.message).toContain('undeclared client tool "apply_patch"');
  });

  test("a bare tool_choice restores only its unambiguous namespaced exec", async () => {
    const tools = [{
      type: "namespace",
      name: "mcp__functions",
      tools: [{ type: "function", name: "exec", description: "Run a command", parameters: { type: "object" } }],
    }];
    const toolChoice = { type: "function", name: "exec" };
    const upstreamCall = (name: string) => () => Response.json({
      id: `resp_${name}`,
      status: "completed",
      output: [{
        type: "function_call",
        id: `fc_${name}`,
        call_id: `call_${name}`,
        name,
        arguments: "{}",
        status: "completed",
      }],
    });

    const accepted = await post(
      false,
      tools,
      upstreamCall("exec"),
      undefined,
      config,
      [],
      "fixture/deepseek-v4-flash",
      undefined,
      toolChoice,
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { output: Array<Record<string, unknown>> };
    expect(acceptedBody.output[0]).toMatchObject({
      type: "function_call",
      name: "exec",
      namespace: "mcp__functions",
    });

    for (const name of ["apply_patch", "exec_command", "shell_command"]) {
      const refused = await post(
        false,
        tools,
        upstreamCall(name),
        undefined,
        config,
        [],
        "fixture/deepseek-v4-flash",
        undefined,
        toolChoice,
      );
      expect(refused.status).toBe(502);
      const body = await refused.json() as { error: { message: string } };
      expect(body.error.message).toContain(`undeclared client tool "${name}"`);
    }
  });

  test("a request that really declares a bare exec still accepts the helper names", () => {
    return post(
      false,
      [
        { type: "custom", name: "exec", description: "Run a command" },
        {
          type: "namespace",
          name: "mcp__functions",
          tools: [{ type: "custom", name: "exec", description: "Run a command" }],
        },
      ],
      jsonUpstream,
    ).then(async response => {
      expect(response.status).toBe(200);
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      // Accepted and normalized onto the declared code-mode shell tool, exactly as before.
      expect(body.output[0]).toMatchObject({ name: "exec", type: "custom_tool_call" });
      expect(String(body.output[0]?.input)).toContain("tools.apply_patch");
    });
  });
});

describe("undeclaredToolCallNameInResponse", () => {
  test("names the first undeclared call in a non-streaming body", () => {
    const response = {
      output: [
        { type: "function_call", name: "exec" },
        { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" },
      ],
    };

    expect(undeclaredToolCallNameInResponse(response, new Set(["exec"]))).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(response, new Set(["exec", "apply_patch"]))).toBeUndefined();
  });

  test("maps nameless client calls without colliding with ordinary function names", () => {
    const response = {
      output: [{ type: "computer_call", id: "cmp_1", action: { type: "screenshot" } }],
    };

    expect(undeclaredToolCallNameInResponse(response, new Set(["computer_use"]))).toBe("computer_use");
    expect(undeclaredToolCallNameInResponse(
      response,
      new Set(),
      new Set(["computer_call"]),
    )).toBeUndefined();
  });

  test("accepts legacy shell bridge names when the catalog declares unified exec", () => {
    // Codex 0.149 declares the code-mode shell tool as `exec`; routed models (DeepSeek)
    // sometimes echo the nested helper name `exec_command` instead. The guard must accept
    // it when the request catalog declares `exec` and does not itself declare the legacy
    // name — but must still refuse it when the legacy name is a real declared tool.
    const response = {
      output: [
        { type: "function_call", name: "exec_command" },
        { type: "function_call", name: "shell_command" },
      ],
    };

    expect(undeclaredToolCallNameInResponse(response, new Set(["exec"]))).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(response, new Set(["exec", "exec_command"]))).toBe(
      "shell_command",
    );
    expect(undeclaredToolCallNameInResponse(response, new Set(["exec_command"]))).toBe(
      "shell_command",
    );
    expect(undeclaredToolCallNameInResponse(response, new Set())).toBe("exec_command");
  });

  test("never legacy-normalizes a namespaced shell bridge call", () => {
    // A namespaced call (e.g. an MCP server advertising its own exec_command) must be
    // matched by its full wire name only — never normalized to bare `exec`.
    const namespaced = {
      output: [
        { type: "function_call", name: "exec_command", namespace: "mcp__server" },
        { type: "function_call", name: "exec_command" },
      ],
    };

    expect(undeclaredToolCallNameInResponse(namespaced, new Set(["exec"]))).toBe(
      "exec_command",
    );
    expect(undeclaredToolCallNameInResponse(namespaced, new Set(["exec", "mcp__server__exec_command"]))).toBeUndefined();
  });

  test("a namespaced-only exec declaration does not authorize the nested helper names", () => {
    // End-to-end over the real collector: declaring `exec` inside an MCP namespace must not
    // hand the request a bare code-mode shell tool.
    const declared = collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "exec" }] }],
    });

    for (const name of ["exec_command", "shell_command", "apply_patch", "exec"]) {
      expect(undeclaredToolCallNameInResponse(
        { output: [{ type: "function_call", name, call_id: "call_1" }] },
        declared,
      )).toBe(name);
    }

    // The declared tool itself still answers under either coordinate system.
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "function_call", name: "exec", namespace: "mcp", call_id: "call_1" }] },
      declared,
    )).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "function_call", name: "mcp__exec", call_id: "call_1" }] },
      declared,
    )).toBeUndefined();
  });
});

/**
 * xAI runs hosted `x_search` itself and reports the activity as a `custom_tool_call` whose name
 * is absent from the request catalog. Probed 2026-08-23 against the OAuth CLI destination: the
 * provider's hosted calls carry an `xs_call-` call-id prefix. Observed names were
 * `x_keyword_search`, `x_semantic_search`, and `x_user_search`, so authorization keys on the
 * declaration, item type, and call-id prefix, never on the name.
 */
describe("provider-executed hosted calls", () => {
  const declared = new Set(["shell"]);
  const nameless = new Set<string>();
  const xSearchAuthorized = collectProviderExecutedCallTypes({
    tools: [{ type: "function", name: "shell" }, { type: "x_search" }],
  });

  function hostedCall(name: string) {
    return { output: [{ type: "custom_tool_call", name, call_id: "xs_call-1" }] };
  }

  test("authorizes the provider's hosted call under any of its observed names", () => {
    expect(collectProviderExecutedCallTypes({ tools: [{ type: "x_search" }] }))
      .toEqual(new Set([{ itemType: "custom_tool_call", callIdPrefix: "xs_call-" }]));
    for (const name of ["x_keyword_search", "x_semantic_search", "x_user_search"]) {
      expect(undeclaredToolCallNameInResponse(
        hostedCall(name), declared, nameless, xSearchAuthorized,
      )).toBeUndefined();
    }
  });

  test("without the x_search declaration the same item is still refused", () => {
    const noHostedDeclaration = collectProviderExecutedCallTypes({
      tools: [{ type: "function", name: "shell" }],
    });
    expect(noHostedDeclaration.size).toBe(0);
    expect(undeclaredToolCallNameInResponse(
      hostedCall("x_keyword_search"), declared, nameless, noHostedDeclaration,
    )).toBe("x_keyword_search");
  });

  test("the caller gates on destination: an empty authorization set refuses the same item", () => {
    // core.ts passes an empty set unless the route actually terminates at xAI, so a declaration
    // alone cannot buy the exemption on an upstream that never serves the hosted tool.
    expect(undeclaredToolCallNameInResponse(
      hostedCall("x_keyword_search"), declared, nameless, new Set<ProviderExecutedCallType>(),
    )).toBe("x_keyword_search");
  });

  test("#1700 still holds: an undeclared client tool is refused inside an authorized turn", () => {
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "custom_tool_call", name: "apply_patch", call_id: "call_patch" }] },
      declared, nameless, xSearchAuthorized,
    )).toBe("apply_patch");
  });

  test("a declared client tool is unaffected", () => {
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "function_call", name: "shell", call_id: "c1" }] },
      declared, nameless, xSearchAuthorized,
    )).toBeUndefined();
  });
});

describe("xAI hosted-call authorization through handleResponses", () => {
  const hostedCall = {
    type: "custom_tool_call",
    id: "ctc_search",
    call_id: "xs_call-1",
    name: "x_keyword_search",
    input: "{}",
    status: "completed",
  };

  async function post(
    baseUrl: string,
    options: {
      injectXSearch?: boolean;
      observeOutbound?: (body: Record<string, unknown>) => void;
    } = {},
  ): Promise<Response> {
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl,
          authMode: "key",
          apiKey: "fixture-key",
          ...(options.injectXSearch
            ? { xaiResponsesXSearch: true, supportsOpenAiWebSearchToolFields: false }
            : {}),
        },
      },
    } as OcxConfig;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      if (options.observeOutbound && init?.body !== undefined) {
        options.observeOutbound(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return Response.json({
        id: "resp_search",
        status: "completed",
        output: [hostedCall],
      });
    }) as typeof fetch;
    try {
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/grok-4.6",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "search" }] }],
          tools: options.injectXSearch
            ? [
              { type: "function", name: "shell", parameters: { type: "object" } },
              { type: "web_search", external_web_access: true },
            ]
            : [
              { type: "function", name: "shell", parameters: { type: "object" } },
              { type: "x_search" },
            ],
        }),
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  test("accepts the measured xs_call shape for an exact xAI destination", async () => {
    const response = await post("https://api.x.ai/v1");

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject(hostedCall);
  });

  test("authorizes an x_search declaration injected into the actual xAI outbound body", async () => {
    let outbound: Record<string, unknown> | undefined;
    const response = await post("https://cli-chat-proxy.grok.com/v1", {
      injectXSearch: true,
      observeOutbound: body => { outbound = body; },
    });

    expect(response.status).toBe(200);
    expect((outbound?.tools as Record<string, unknown>[]).map(tool => tool.type))
      .toEqual(["function", "web_search", "x_search"]);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject(hostedCall);
  });

  test("rejects the identical item for a lookalike destination", async () => {
    const response = await post("https://api.x.ai.evil.test/v1");

    expect(response.status).toBe(502);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('undeclared client tool "x_keyword_search"');
  });
});
