import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPreviousResponseInput } from "../../src/responses/state";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";

const savedCodexHome = process.env.CODEX_HOME;
const codexHome = mkdtempSync(join(tmpdir(), "ocx-v2-routed-delegation-bridge-"));

beforeAll(() => {
  writeFileSync(join(codexHome, "config.toml"), "[features.multi_agent_v2]\nenabled = true\n");
  process.env.CODEX_HOME = codexHome;
});

afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    defaultProvider: "openai",
    multiAgentMode: "v2",
    v2RoutedDelegationBridge: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function request(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${fakeChatGptJwt("acct-bridge")}`,
      "chatgpt-account-id": "acct-bridge",
      originator: "codex_cli_rs",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function rootBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] }],
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object" } },
        { type: "function", name: "send_message", parameters: { type: "object" } },
      ],
    }],
    stream: false,
    ...extra,
  };
}

describe("Responses V2 routed delegation bridge runtime", () => {
  test("injects a canonical V2 root and normalizes its JSON mirror call before caching", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: "resp_bridge",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_bridge",
          call_id: "call_bridge",
          namespace: "ocx_agents",
          name: "spawn_agent",
          arguments: "{\"task\":\"sentinel\"}",
        }],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(rootBody()), config(), logCtx);
      const output = await response.json() as { output: Array<Record<string, unknown>> };

      expect(requests).toHaveLength(1);
      expect(requests[0]?.stream).toBe(false);
      expect((requests[0]?.tools as Array<Record<string, unknown>>)[0]?.name).toBe("collaboration");
      expect((requests[0]?.tools as Array<Record<string, unknown>>)[1]).toMatchObject({
        type: "namespace", name: "ocx_agents", tools: [{ name: "spawn_agent" }, { name: "send_message" }],
      });
      expect(output.output[0]).toMatchObject({
        namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [],
      });
      expect(logCtx.v2BridgeDecision).toBe("active");
      expect(logCtx.v2BridgeScope).toBe("root");
      expect(logCtx.v2BridgeStateDurability).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replays JSON continuation state with the restored collaboration namespace", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      return Response.json({
        id: requests.length === 1 ? "resp_bridge_json_replay" : "resp_bridge_json_followup",
        status: "completed",
        output: requests.length === 1 ? [{
          type: "function_call", id: "fc_bridge_json_replay", call_id: "call_bridge_json_replay",
          namespace: "ocx_agents", name: "spawn_agent", arguments: "{\"task\":\"continue\"}",
        }] : [],
      });
    }) as typeof fetch;
    try {
      await handleResponses(request(rootBody()), config(), { model: "", provider: "" });
      const followup = await handleResponses(request(rootBody({
        previous_response_id: "resp_bridge_json_replay",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] }],
      })), config(), { model: "", provider: "" });

      expect(followup.status).toBe(200);
      expect(JSON.stringify(requests[1]?.input)).toContain('"namespace":"collaboration"');
      expect(JSON.stringify(requests[1]?.input)).not.toContain('"namespace":"ocx_agents"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the same JSON normalization for the canonical websocket path", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ id: "resp_ws", status: "completed", output: [{
      type: "function_call", id: "fc_ws", call_id: "call_ws", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
    }] })) as typeof fetch;
    try {
      const response = await handleResponses(request(rootBody()), config(), { model: "", provider: "" }, { inboundTransport: "websocket" });
      expect((await response.json() as { output: Array<Record<string, unknown>> }).output[0]).toMatchObject({
        namespace: "collaboration", encrypted_function_args: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("mirrors additional_tools and rebuilds the parsed authorization catalog", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: "resp_additional", status: "completed", output: [{
        type: "function_call", id: "fc_additional", call_id: "call_additional", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
      }] });
    }) as typeof fetch;
    try {
      const native = { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }, { type: "function", name: "send_message", parameters: { type: "object" } }] };
      const response = await handleResponses(request(rootBody({ tools: [], input: [{ type: "additional_tools", tools: [native] }] })), config(), { model: "", provider: "" });
      const outbound = requests[0]!;
      expect((outbound.input as Array<Record<string, unknown>>)[0]?.tools).toEqual([{ ...native, tools: [] }, {
        type: "namespace", name: "ocx_agents", description: "Use this routed-child mirror for collaboration operations.", tools: [{ type: "function", name: "spawn_agent", description: "Use this routed-child mirror for collaboration operations. spawn_agent.", parameters: { type: "object" } }, { type: "function", name: "send_message", description: "Use this routed-child mirror for collaboration operations. send_message.", parameters: { type: "object" } }],
      }]);
      expect((await response.json() as { output: Array<Record<string, unknown>> }).output[0]).toMatchObject({ namespace: "collaboration", encrypted_function_args: [] });
    } finally { globalThis.fetch = originalFetch; }
  });

  test("keeps replayed additional_tools out of a fresh current-turn mirror catalog", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const native = { type: "namespace", name: "collaboration", tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "send_message", parameters: { type: "object" } },
    ] };
    const originalNative = structuredClone(native);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: requests.length === 1 ? "resp_additional_replay" : "resp_additional_after", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      await handleResponses(request(rootBody({ tools: [], input: [{ type: "additional_tools", tools: [native] }] })), config(), { model: "", provider: "" });
      const second = await handleResponses(request(rootBody({
        tools: [],
        previous_response_id: "resp_additional_replay",
        input: [{ type: "additional_tools", tools: [native] }],
      })), config(), { model: "", provider: "" });

      expect(second.status).toBe(200);
      const catalogs = (requests[1]?.input as Array<Record<string, unknown>>)
        .filter(item => item.type === "additional_tools")
        .map(item => item.tools);
      expect(catalogs).toEqual([[originalNative], [{ ...native, tools: [] }, expect.objectContaining({ name: "ocx_agents" })]]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("replayed additional_tools alone cannot arm a later bridge turn", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const native = { type: "namespace", name: "collaboration", tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "send_message", parameters: { type: "object" } },
    ] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: requests.length === 1 ? "resp_stale_catalog" : "resp_stale_after", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      await handleResponses(request(rootBody({ tools: [], input: [{ type: "additional_tools", tools: [native] }] })), config(), { model: "", provider: "" });
      const second = await handleResponses(request(rootBody({
        tools: [],
        previous_response_id: "resp_stale_catalog",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
      })), config(), { model: "", provider: "" });

      expect(second.status).toBe(200);
      expect(JSON.stringify(requests[0]?.input)).toContain('"ocx_agents"');
      expect(JSON.stringify(requests[1]?.input)).not.toContain('"ocx_agents"');
    } finally { globalThis.fetch = originalFetch; }
  });

  test("does not modify a genuine native collaboration response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ id: "resp_native", status: "completed", output: [{
      type: "function_call", id: "fc_native", call_id: "call_native", namespace: "collaboration", name: "spawn_agent", arguments: "{}",
    }] })) as typeof fetch;
    try {
      const call = (await (await handleResponses(request(rootBody()), config(), { model: "", provider: "" })).json() as { output: Array<Record<string, unknown>> }).output[0]!;
      expect(call.encrypted_function_args).toBeUndefined();
      expect(call.namespace).toBe("collaboration");
    } finally { globalThis.fetch = originalFetch; }
  });

  test("does not inject on excluded request shapes", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: `resp_${requests.length}`, status: "completed", output: [] });
    }) as typeof fetch;
    try {
      const routed = config();
      routed.providers.gw = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key", apiKey: "test" } as never;
      const cases: Array<[OcxConfig, Record<string, unknown>, Record<string, string>, Parameters<typeof handleResponses>[3]]> = [
        [{ ...config(), multiAgentMode: "v1" }, rootBody(), {}, {}],
        [{ ...config(), multiAgentMode: "default" }, rootBody(), {}, {}],
        [config(), rootBody({ tools: [] }), {}, {}],
        [config(), rootBody(), { "x-openai-subagent": "review" }, {}],
        [config(), rootBody(), { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "review" }) }, {}],
        [config(), rootBody({ tools: [{ type: "function", name: "spawn_agent" }, ...(rootBody().tools as unknown[]) ] }), {}, {}],
        [config(), rootBody(), {}, { comboAttempt: true }],
      ];
      for (const [cfg, body, headers, options] of cases) await handleResponses(request(body, headers), cfg, { model: "", provider: "" }, options);
      expect(requests).toHaveLength(cases.length);
      for (const outbound of requests) expect(JSON.stringify(outbound.tools ?? outbound.input)).not.toContain('"ocx_agents"');
      expect(routed.providers.gw).toBeDefined();
    } finally { globalThis.fetch = originalFetch; }
  });

  test("bridges a canonical native child so its routed grandchild task stays plaintext", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: "resp_nested_child", status: "completed", output: [{
        type: "function_call",
        id: "fc_nested_child",
        call_id: "call_nested_child",
        namespace: "ocx_agents",
        name: "spawn_agent",
        arguments: "{\"message\":\"plaintext grandchild assignment\"}",
      }] });
    }) as typeof fetch;
    try {
      const response = await handleResponses(
        request(rootBody(), {
          "x-openai-subagent": "collab_spawn",
          "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }),
        }),
        config(),
        { model: "", provider: "" },
      );
      const output = await response.json() as { output: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(JSON.stringify(requests[0]?.tools)).toContain('"name":"ocx_agents"');
      expect(output.output[0]).toMatchObject({
        namespace: "collaboration",
        name: "spawn_agent",
        arguments: "{\"message\":\"plaintext grandchild assignment\"}",
        encrypted_function_args: [],
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  test("runs the root, routed child, and parent continuation lifecycle without leaking mirrors", async () => {
    const outbound: Array<{ url: string; body: Record<string, unknown> }> = [];
    let turn = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      outbound.push({ url: String(url), body });
      turn += 1;
      if (turn === 1) return Response.json({ id: "resp_root", status: "completed", output: [{
        type: "function_call", id: "fc_root", call_id: "call_root", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
      }] });
      if (turn === 2) return Response.json({ choices: [{ message: { role: "assistant", content: "safe-fixed-result" }, finish_reason: "stop" }] });
      return Response.json({ id: "resp_parent", status: "completed", output: [
        { type: "function_call", id: "fc_follow", call_id: "call_follow", namespace: "ocx_agents", name: "followup_task", arguments: "{}" },
        { type: "function_call", id: "fc_wait", call_id: "call_wait", namespace: "collaboration", name: "wait_agent", arguments: "{}" },
        { type: "function_call", id: "fc_list", call_id: "call_list", namespace: "collaboration", name: "list_agents", arguments: "{}" },
      ] });
    }) as typeof fetch;
    try {
      const root = await handleResponses(request(rootBody()), config(), { model: "", provider: "" });
      expect((await root.json() as { output: Array<Record<string, unknown>> }).output[0]).toMatchObject({ namespace: "collaboration", encrypted_function_args: [] });

      const childConfig = config();
      childConfig.providers.gw = { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key", apiKey: "test" } as never;
      const child = await handleResponses(request({
        model: "gw/routed", stream: false,
        input: [{ type: "agent_message", author: "/root", recipient: "/root/child", content: [
          { type: "encrypted_content", encrypted_content: "Implement the readable child task." },
        ] }, { type: "function_call_output", call_id: "safe-fixed-call", output: "safe-fixed-result" }],
        tools: rootBody().tools,
      }, { "x-openai-subagent": "collab_spawn" }), childConfig, { model: "", provider: "" });
      expect(child.status).toBe(200);

      const parent = await handleResponses(request(rootBody({ tools: [{ type: "namespace", name: "collaboration", tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object" } },
        { type: "function", name: "followup_task", parameters: { type: "object" } },
        { type: "function", name: "wait_agent", parameters: { type: "object" } },
        { type: "function", name: "list_agents", parameters: { type: "object" } },
      ] }] })), config(), { model: "", provider: "" });
      const calls = (await parent.json() as { output: Array<Record<string, unknown>> }).output;

      expect(JSON.stringify(outbound[0]?.body.tools)).toContain('"ocx_agents"');
      expect(outbound[1]?.url).toContain("gateway.example");
      expect(outbound[1]?.url).not.toContain("chatgpt.com");
      expect(JSON.stringify(outbound[1]?.body)).toContain("Implement the readable child task.");
      expect(JSON.stringify(outbound[1]?.body)).toContain("safe-fixed-result");
      expect(JSON.stringify(outbound[1]?.body)).not.toContain('"ocx_agents"');
      expect(calls[0]).toMatchObject({ namespace: "collaboration", name: "followup_task", encrypted_function_args: [] });
      expect(calls[1]).toMatchObject({ namespace: "collaboration", name: "wait_agent" });
      expect(calls[1]?.encrypted_function_args).toBeUndefined();
      expect(calls[2]).toMatchObject({ namespace: "collaboration", name: "list_agents" });
      expect(calls[2]?.encrypted_function_args).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; }
  });

  test("keeps routed parent to native child to routed grandchild delegation plaintext on V2", async () => {
    const outbound: Array<{ url: string; body: Record<string, unknown> }> = [];
    let turn = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      outbound.push({ url: String(url), body });
      turn += 1;
      if (turn === 1) {
        return Response.json({ choices: [{ message: { role: "assistant", content: "dispatch native child" }, finish_reason: "stop" }] });
      }
      if (turn === 2) {
        return Response.json({ id: "resp_native_child", status: "completed", output: [{
          type: "function_call",
          id: "fc_native_child",
          call_id: "call_native_child",
          namespace: "ocx_agents",
          name: "spawn_agent",
          arguments: "{\"message\":\"plaintext routed grandchild assignment\"}",
        }] });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "grandchild complete" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    try {
      const mixed = config();
      mixed.providers.gw = {
        adapter: "openai-chat",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "test",
      } as never;

      const parent = await handleResponses(
        request(rootBody({ model: "gw/routed" })),
        mixed,
        { model: "", provider: "" },
      );
      expect(parent.status).toBe(200);

      const child = await handleResponses(
        request(rootBody({
          model: "gpt-5.5",
          input: [{
            type: "agent_message",
            author: "/root",
            recipient: "/root/native-child",
            content: [{ type: "input_text", text: "Inspect the routed parent result." }],
          }],
        }), {
          "x-openai-subagent": "collab_spawn",
          "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }),
        }),
        mixed,
        { model: "", provider: "" },
      );
      const childOutput = await child.json() as { output: Array<Record<string, unknown>> };

      const grandchild = await handleResponses(
        request({
          model: "gw/routed",
          stream: false,
          input: [{
            type: "agent_message",
            author: "/root/native-child",
            recipient: "/root/native-child/routed-grandchild",
            content: [{ type: "input_text", text: "plaintext routed grandchild assignment" }],
          }],
          tools: [],
        }, { "x-openai-subagent": "collab_spawn" }),
        mixed,
        { model: "", provider: "" },
      );

      expect(child.status).toBe(200);
      expect(grandchild.status).toBe(200);
      expect(outbound).toHaveLength(3);
      expect(outbound[0]?.url).toContain("gateway.example");
      expect(outbound[1]?.url).toContain("chatgpt.com");
      expect(JSON.stringify(outbound[1]?.body.tools)).toContain('"name":"ocx_agents"');
      expect(childOutput.output[0]).toMatchObject({
        namespace: "collaboration",
        name: "spawn_agent",
        arguments: "{\"message\":\"plaintext routed grandchild assignment\"}",
        encrypted_function_args: [],
      });
      expect(outbound[2]?.url).toContain("gateway.example");
      expect(JSON.stringify(outbound[2]?.body)).toContain("plaintext routed grandchild assignment");
      expect(JSON.stringify(outbound[2]?.body)).not.toContain("encrypted_content");
      expect(JSON.stringify(outbound[2]?.body)).not.toContain('"ocx_agents"');
    } finally { globalThis.fetch = originalFetch; }
  });

  test("fails a mirror namespace collision before upstream I/O", async () => {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("collision must not fetch");
    }) as typeof fetch;
    try {
      const response = await handleResponses(request(rootBody({ tools: [
        ...(rootBody().tools as unknown[]),
        { type: "namespace", name: "ocx_agents", tools: [] },
      ] })), config(), { model: "", provider: "" });

      expect(response.status).toBe(400);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rewrites split SSE calls for eligible roots and both spawned-child marker forms", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response([
      "data: ", JSON.stringify({ type: "response.output_item.added", item: {
        type: "function_call", id: "fc_bridge", call_id: "call_bridge", namespace: "ocx_agents", name: "spawn_agent", arguments: "",
      } }), "\n\n",
      "data: ", JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_bridge", arguments: "{}" }), "\n\n",
      "data: ", JSON.stringify({ type: "response.completed", response: { id: "resp_sse", status: "completed", output: [{
        type: "function_call", id: "fc_bridge", call_id: "call_bridge", namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
      }] } }), "\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
      const markerForms = [
        {},
        { "x-openai-subagent": "collab_spawn" },
        { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) },
      ];
      for (const headers of markerForms) {
        const response = await handleResponses(
          request(rootBody({ stream: true }), headers),
          config(),
          { model: "", provider: "" },
        );
        const text = await response.text();
        expect(text).toContain('"namespace":"collaboration"');
        expect(text).toContain('"encrypted_function_args":[]');
        expect(text).not.toContain('"namespace":"ocx_agents"');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replays SSE continuation state with the restored collaboration namespace", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return new Response([
          `data: ${JSON.stringify({ type: "response.output_item.added", item: {
            type: "function_call", id: "fc_bridge_sse_replay", call_id: "call_bridge_sse_replay",
            namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
          } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: {
            id: "resp_bridge_sse_replay", status: "completed", output: [{
              type: "function_call", id: "fc_bridge_sse_replay", call_id: "call_bridge_sse_replay",
              namespace: "ocx_agents", name: "spawn_agent", arguments: "{}",
            }],
          } })}\n\n`,
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "resp_bridge_sse_followup", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      const streamed = await handleResponses(request(rootBody({ stream: true })), config(), { model: "", provider: "" });
      expect(streamed.status).toBe(200);
      await streamed.text();
      const followup = await handleResponses(request(rootBody({
        previous_response_id: "resp_bridge_sse_replay",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] }],
      })), config(), { model: "", provider: "" });

      expect(followup.status).toBe(200);
      expect(JSON.stringify(requests[1]?.input)).toContain('"namespace":"collaboration"');
      expect(JSON.stringify(requests[1]?.input)).not.toContain('"namespace":"ocx_agents"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("leaves the canonical catalog unchanged when disabled", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: "resp_disabled", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      const disabled = config();
      disabled.v2RoutedDelegationBridge = false;
      await handleResponses(request(rootBody()), disabled, { model: "", provider: "" });

      expect(requests[0]?.tools).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
