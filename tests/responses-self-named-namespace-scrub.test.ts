/**
 * #3217 — a custom_tool_call whose `namespace` repeats its own `name` must not reach Codex.
 *
 * codex-rs resolves `ToolName::new(namespace, name)` and only treats None/""/"functions" as the
 * default namespace; `{ name: "exec", namespace: "exec" }` becomes the flat name `execexec`,
 * which no client tool matches, and Codex re-issues the call every turn. The adapter fix keeps
 * the reserved `functions` group intact so the backend stops answering that way; this scrub is
 * the belt to that suspender on the client-facing passthrough (SSE and bounded JSON).
 */
import { afterEach, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses";
import { scrubSelfNamedToolCallNamespace } from "../src/server/responses-self-named-namespace-scrub";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function forwardConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as unknown as OcxConfig;
}

const requestBody = {
  model: "gpt-5.3-codex-spark",
  stream: true,
  store: false,
  instructions: "x",
  input: [
    {
      type: "additional_tools",
      role: "developer",
      tools: [{
        type: "namespace",
        name: "functions",
        tools: [
          { type: "custom", name: "exec", description: "shell" },
          { type: "function", name: "wait", parameters: { type: "object", properties: {} } },
        ],
      }],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
  ],
};

function sseFrom(items: Array<Record<string, unknown>>): string {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...items[0], input: "", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: items[0] },
    { type: "response.completed", response: { id: "r1", status: "completed", output: items } },
  ];
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function request(body: Record<string, unknown> = requestBody): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test", "chatgpt-account-id": "acct" },
    body: JSON.stringify(body),
  });
}

function scrubAuthorization(names: string[]) {
  const authorizedNames = new Set(names);
  return { customToolCallNames: authorizedNames, functionCallNames: authorizedNames };
}

test("a self-named namespace on a passthrough custom_tool_call is scrubbed before the client (#3217)", async () => {
  const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", namespace: "exec", input: "pwd", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const res = await handleResponses(request(), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  const payloads = text.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)) as Record<string, unknown>);
  const callItems = payloads.flatMap(p => {
    const item = p.item as Record<string, unknown> | undefined;
    const output = (p.response as { output?: Array<Record<string, unknown>> } | undefined)?.output ?? [];
    return [...(item ? [item] : []), ...output];
  }).filter(i => i.type === "custom_tool_call");
  expect(callItems.length).toBeGreaterThanOrEqual(3);
  for (const item of callItems) {
    expect(item.name).toBe("exec");
    expect("namespace" in item).toBe(false);
  }
});

test("a self-named namespace declared by the current turn is preserved", async () => {
  const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", namespace: "exec", input: "pwd", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const body = {
    ...requestBody,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "exec",
          tools: [{ type: "custom", name: "exec", description: "shell" }],
        }],
      },
      requestBody.input[1],
    ],
  };

  const res = await handleResponses(request(body), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('\"name\":\"exec\",\"namespace\":\"exec\"');
});

test("the reserved functions namespace does not create a same-name collision", async () => {
  const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "functions", namespace: "functions", input: "pwd", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const body = {
    ...requestBody,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "functions",
          tools: [{ type: "custom", name: "functions", description: "shell" }],
        }],
      },
      requestBody.input[1],
    ],
  };

  const res = await handleResponses(request(body), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain('\"namespace\":\"functions\"');
});

test("a self-named namespace on a passthrough bare function_call is scrubbed", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "wait", namespace: "wait", arguments: "{}", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const res = await handleResponses(request(), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('\"type\":\"function_call\"');
  expect(text).not.toContain('\"namespace\":\"wait\"');
});

test("a Chat-shaped function declaration still authorizes the bare function scrub", async () => {
  // `buildTools` accepts `{ type: "function", function: { name } }` and the undeclared-tool guard
  // authorizes it, so the scrub's raw-body collector has to read the nested name too; otherwise
  // the intersection drops the tool and a self-named echo for it loops Codex again.
  const chatShaped = {
    ...requestBody,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "wait" }] },
    ],
    tools: [{ type: "function", function: { name: "wait", parameters: { type: "object", properties: {} } } }],
  };
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "wait", namespace: "wait", arguments: "{}", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const res = await handleResponses(request(chatShaped), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('"type":"function_call"');
  expect(text).not.toContain('"namespace":"wait"');
});

test("tool_choice for a namespaced custom tool cannot authorize a colliding bare scrub", async () => {
  const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", namespace: "exec", input: "pwd", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const body = {
    ...requestBody,
    tool_choice: { type: "custom", name: "remote__exec" },
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "local shell" }],
          },
          {
            type: "namespace",
            name: "remote",
            tools: [{ type: "custom", name: "exec", description: "remote shell" }],
          },
        ],
      },
      requestBody.input[1],
    ],
  };

  const res = await handleResponses(request(body), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('\"name\":\"exec\",\"namespace\":\"exec\"');
});

test("mixed custom and function collisions are scoped to the response item type", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", namespace: "exec", arguments: "{}", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const body = {
    ...requestBody,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "shell" }],
          },
          {
            type: "namespace",
            name: "exec",
            tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }],
          },
        ],
      },
      requestBody.input[1],
    ],
  };

  const res = await handleResponses(request(body), forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('\"type\":\"function_call\"');
  expect(text).toContain('\"name\":\"exec\",\"namespace\":\"exec\"');

  const bareCall = { type: "custom_tool_call", id: "ctc_1", call_id: "call_2", name: "exec", namespace: "exec", input: "pwd", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([bareCall]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const bareRes = await handleResponses(request(body), forwardConfig(), { model: "", provider: "" });
  expect(bareRes.status).toBe(200);
  const bareText = await bareRes.text();
  expect(bareText).toContain('\"type\":\"custom_tool_call\"');
  expect(bareText).not.toContain('\"namespace\":\"exec\"');
});

test("a genuine MCP namespace on a passthrough call is left alone", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", namespace: "mcp__docs", arguments: "{}", status: "completed" };
  globalThis.fetch = (async () => new Response(sseFrom([call]), {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const res = await handleResponses(request(), forwardConfig(), { model: "", provider: "" });
  const text = await res.text();
  expect(text).toContain('"namespace":"mcp__docs"');
});

test("the bounded JSON (stream:false) passthrough path scrubs the same shape (#3217)", async () => {
  const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", namespace: "exec", input: "pwd", status: "completed" };
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "r1", object: "response", status: "completed", output: [call] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;

  const req = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test", "chatgpt-account-id": "acct" },
    body: JSON.stringify({ ...requestBody, stream: false }),
  });
  const res = await handleResponses(req, forwardConfig(), { model: "", provider: "" });
  expect(res.status).toBe(200);
  const body = await res.json() as { output: Array<Record<string, unknown>> };
  expect(body.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec" });
  expect("namespace" in body.output[0]).toBe(false);
});

test("scrub is recursive, shape-preserving, and a no-op on clean payloads", () => {
  const clean = { type: "response.completed", response: { output: [{ type: "custom_tool_call", name: "exec", input: "" }] } };
  expect(scrubSelfNamedToolCallNamespace(clean, scrubAuthorization(["exec"]))).toEqual({ value: clean, changed: false });
  const dirty = { response: { output: [{ type: "function_call", name: "wait", namespace: "wait", arguments: "{}" }, { type: "message" }] } };
  const result = scrubSelfNamedToolCallNamespace(dirty, scrubAuthorization(["wait"]));
  expect(result.changed).toBe(true);
  expect(result.value).toEqual({ response: { output: [{ type: "function_call", name: "wait", arguments: "{}" }, { type: "message" }] } });
  // An empty name never matches: a namespace equal to "" is not the self-named shape.
  expect(scrubSelfNamedToolCallNamespace({ type: "custom_tool_call", name: "", namespace: "" }, scrubAuthorization([])).changed).toBe(false);
});
