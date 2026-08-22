/**
 * #1700: the native Responses passthrough relayed a routed provider's call to a tool the request
 * never declared. Codex has no top-level handler for it, so the turn surfaced as a bare `aborted`
 * with the target file untouched. The bridged paths already fail closed on the same condition
 * (`declaredToolNames`, src/bridge.ts); these pin the passthrough's equivalent.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDeclaredWireToolNames,
  createUndeclaredToolCallGuardBlockRewrite,
  undeclaredToolCallNameInResponse,
  UNDECLARED_TOOL_CALL_ERROR_CODE,
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

async function relay(upstream: string, declared: Iterable<string>): Promise<string> {
  const budget = createTestTranslatorBudget();
  try {
    return await readAll(relaySseWithBlockRewrite(
      streamFromText(upstream),
      createUndeclaredToolCallGuardBlockRewrite(new Set(declared)),
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

  test("is empty for a body this proxy could not read", () => {
    expect(collectDeclaredWireToolNames(undefined).size).toBe(0);
    expect(collectDeclaredWireToolNames({ tools: "nonsense" }).size).toBe(0);
  });

  test("is empty for a readable request that declares nothing", () => {
    // Indistinguishable from the unreadable case by size alone, which is why the caller keeps
    // readability as separate state: a request declaring no tools authorizes none.
    expect(collectDeclaredWireToolNames({}).size).toBe(0);
    expect(collectDeclaredWireToolNames({ tools: [] }).size).toBe(0);
  });

  test("ignores hosted tool entries, which carry no client-executable name", () => {
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "web_search" }, { type: "image_generation" }, { type: "function", name: "exec" }],
    });

    expect([...names]).toEqual(["exec"]);
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

  test("replaces an undeclared apply_patch with a compatibility failure", async () => {
    // The reported shape: the request-visible catalog holds exec/wait/request_user_input, and
    // `apply_patch` arrives anyway because code mode nests it inside the exec description.
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain("event: response.failed");
    expect(out).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(out).toContain('routed provider emitted undeclared client tool \\"apply_patch\\"');
    expect(out).toEndWith("data: [DONE]\n\n");
  });

  test("drops the rest of the turn so a later completed cannot contradict the failure", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "" },
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
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
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


  test("streaming: the leaked apply_patch becomes a named failure instead of a silent abort", async () => {
    const response = await post(true, () => new Response([
      frame("response.output_item.added", { output_index: 0, item: { ...leakedCall, arguments: "", status: "in_progress" } }),
      frame("response.output_item.done", { output_index: 0, item: leakedCall }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [leakedCall] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }));

    const body = await response.text();
    expect(body).toContain("response.failed");
    expect(body).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(body).toContain("apply_patch");
    // Before the guard this reached Codex as a call it has no handler for, and the turn showed
    // only `aborted`. The client must not see a completed turn now.
    expect(body).not.toContain("response.completed");
  });

  test("non-streaming: the same call is refused rather than answered", async () => {
    const response = await post(false, () => new Response(
      JSON.stringify({ id: "resp_1", status: "completed", output: [leakedCall] }),
      { headers: { "content-type": "application/json" } },
    ));

    expect(response.status).toBe(502);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('undeclared client tool "apply_patch"');
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

  test("a refused turn is not", async () => {
    const refused = await turn("resp_refused", {
      type: "function_call", id: "fc_bad", call_id: "call_bad", name: "apply_patch", arguments: "{}", status: "completed",
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
        item: { type: "function_call", id: "fc_bad", call_id: "call_bad", name: "apply_patch", arguments: "{}" },
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

describe("a request that declares no tools has no catalog to police", () => {
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

  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "apply_patch",
    arguments: "{}",
    status: "completed",
  };

  async function post(stream: boolean, tools: unknown[] | undefined, upstream: () => Response) {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => upstream()) as typeof fetch;
    try {
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream,
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
          ...(tools === undefined ? {} : { tools }),
        }),
      }), config, { model: "", provider: "" });
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
  // exactly that with `apply_patch`. Refusing on an empty catalog truncates those turns, so the
  // guard needs at least one declared name before it has an opinion.
  for (const [label, tools] of [["no tools field", undefined], ["tools: []", []]] as const) {
    test(`non-streaming, ${label} — relayed, not refused`, async () => {
      const response = await post(false, tools, jsonUpstream);

      expect(response.status).toBe(200);
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      expect(body.output[0]).toMatchObject({ name: "apply_patch" });
    });

    test(`streaming, ${label} — relayed, not refused`, async () => {
      const response = await post(true, tools, sseUpstream);
      const body = await response.text();

      expect(body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
      expect(body).toContain("response.completed");
    });
  }
});

describe("undeclaredToolCallNameInResponse", () => {
  test("names the first undeclared call in a non-streaming body", () => {
    const response = {
      output: [
        { type: "function_call", name: "exec" },
        { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" },
      ],
    };

    expect(undeclaredToolCallNameInResponse(response, new Set(["exec"]))).toBe("apply_patch");
    expect(undeclaredToolCallNameInResponse(response, new Set(["exec", "apply_patch"]))).toBeUndefined();
  });
});
