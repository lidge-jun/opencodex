/**
 * The routed custom-tool repair contract as handleResponses actually serves it.
 *
 * Split out of responses-custom-tool-repair.test.ts, which keeps the cases that exercise the
 * compat functions directly. These are the cases that dispatch, and a dispatching case needs the
 * spend-journal writer lease that startServer would have taken; the file it came from is at its
 * file-size cap and had no room to take it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { CANONICAL_PATCH, DECORATED_PATCH, dataPayload, frame } from "../helpers/custom-tool-repair-fixtures";

// Taken at each dispatch rather than per case, and dropped in teardown so a case that throws
// mid-assertion cannot leave the lease behind for the next one to trip over.
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };
afterEach(() => { releaseSpendHome?.(); releaseSpendHome = undefined; });

describe("routed Responses custom-tool repair through handleResponses", () => {
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
      takeSpendHome();
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

  test("handleResponses lowers and restores apply_patch when the destination denies custom tools", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const upstreamItem = {
      type: "function_call",
      id: "fc_patch_next",
      call_id: "call_patch_next",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
      status: "completed",
    };
    const upstream = [
      frame("response.output_item.added", {
        output_index: 0,
        item: { ...upstreamItem, arguments: "", status: "in_progress" },
      }),
      frame("response.function_call_arguments.done", {
        output_index: 0,
        item_id: upstreamItem.id,
        arguments: upstreamItem.arguments,
      }),
      frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
      frame("response.completed", {
        response: { id: "resp_patch", status: "completed", output: [upstreamItem] },
      }),
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
          supportsResponsesCustomTools: false,
        },
      },
    } as OcxConfig;

    try {
      takeSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/grok-4.6",
          stream: true,
          input: [
            {
              type: "custom_tool_call",
              id: "ctc_patch_prior",
              call_id: "call_patch_prior",
              name: "apply_patch",
              input: "noop",
            },
            { type: "custom_tool_call_output", call_id: "call_patch_prior", output: "done" },
          ],
          tools: [{
            type: "custom",
            name: "apply_patch",
            description: "Apply a patch",
            format: { type: "grammar", syntax: "lark" },
          }],
        }),
      }), config, { model: "", provider: "" });
      const clientSse = await response.text();
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;
      const outboundInput = outboundBody?.input as Array<Record<string, unknown>> | undefined;

      expect(outboundTools?.[0]).toMatchObject({ type: "function", name: "apply_patch" });
      expect(outboundInput?.[0]).toMatchObject({
        type: "function_call",
        call_id: "call_patch_prior",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "noop" }),
      });
      expect(outboundInput?.[1]).toMatchObject({
        type: "function_call_output",
        call_id: "call_patch_prior",
        output: "done",
      });
      expect(clientSse).toContain('"type":"custom_tool_call"');
      expect(clientSse).toContain('"id":"ctc_patch_next"');
      expect(clientSse).toContain('"call_id":"call_patch_next"');
      expect(clientSse).toContain('"name":"apply_patch"');
      expect(clientSse).toContain('"type":"response.custom_tool_call_input.done"');
      expect(clientSse).toContain("data: [DONE]");
      expect(clientSse).not.toContain('"type":"function_call"');
      expect(clientSse).not.toContain("response.function_call_arguments.done");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses lowers apply_patch for a noncanonical forward destination that denies custom tools", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    let outboundAuthorization: string | null = null;
    let outboundUrl = "";
    const upstreamItem = {
      type: "function_call",
      id: "fc_patch_next",
      call_id: "call_patch_next",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
      status: "completed",
    };
    const upstream = [
      frame("response.output_item.added", {
        output_index: 0,
        item: { ...upstreamItem, arguments: "", status: "in_progress" },
      }),
      frame("response.function_call_arguments.done", {
        output_index: 0,
        item_id: upstreamItem.id,
        arguments: upstreamItem.arguments,
      }),
      frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
      frame("response.completed", {
        response: { id: "resp_patch", status: "completed", output: [upstreamItem] },
      }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    globalThis.fetch = (async (input, init) => {
      outboundUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outboundAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://provider.example/v1",
          authMode: "forward",
          headers: { authorization: "Bearer provider-static" },
          supportsResponsesCustomTools: false,
        },
      },
    } as OcxConfig;

    try {
      takeSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-secret" },
        body: JSON.stringify({
          model: "fixture/grok-4.6",
          stream: true,
          input: [
            {
              type: "custom_tool_call",
              id: "ctc_patch_prior",
              call_id: "call_patch_prior",
              name: "apply_patch",
              input: "noop",
            },
            { type: "custom_tool_call_output", call_id: "call_patch_prior", output: "done" },
          ],
          tools: [{
            type: "custom",
            name: "apply_patch",
            description: "Apply a patch",
            format: { type: "grammar", syntax: "lark" },
          }],
        }),
      }), config, { model: "", provider: "" });
      const clientSse = await response.text();
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;
      const outboundInput = outboundBody?.input as Array<Record<string, unknown>> | undefined;

      expect(outboundUrl).toBe("https://provider.example/v1/responses");
      expect(outboundAuthorization).toBe("Bearer provider-static");
      expect(outboundTools?.[0]).toMatchObject({ type: "function", name: "apply_patch" });
      expect(outboundInput?.[0]).toMatchObject({
        type: "function_call",
        call_id: "call_patch_prior",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "noop" }),
      });
      expect(outboundInput?.[1]).toMatchObject({
        type: "function_call_output",
        call_id: "call_patch_prior",
        output: "done",
      });
      expect(clientSse).toContain('"type":"custom_tool_call"');
      expect(clientSse).toContain('"id":"ctc_patch_next"');
      expect(clientSse).toContain('"call_id":"call_patch_next"');
      expect(clientSse).toContain('"name":"apply_patch"');
      expect(clientSse).toContain('"type":"response.custom_tool_call_input.done"');
      expect(clientSse).toContain("data: [DONE]");
      expect(clientSse).not.toContain('"type":"function_call"');
      expect(clientSse).not.toContain("response.function_call_arguments.done");
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
      takeSpendHome();
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

      takeSpendHome();
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
      takeSpendHome();
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
        takeSpendHome();
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
      takeSpendHome();
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

  test("handleResponses preserves disallowed native apply_patch input in JSON and SSE", async () => {
    const savedFetch = globalThis.fetch;
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
    const upstreamItem = {
      type: "custom_tool_call",
      id: "ctc_patch",
      call_id: "call_patch",
      name: "apply_patch",
      input: DECORATED_PATCH,
      status: "completed",
    };

    globalThis.fetch = (async (_input, init) => {
      const outbound = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (outbound.stream === true) {
        const upstream = [
          frame("response.output_item.added", {
            output_index: 0,
            item: { ...upstreamItem, input: "", status: "in_progress" },
          }),
          frame("response.custom_tool_call_input.done", {
            output_index: 0,
            item_id: "ctc_patch",
            input: DECORATED_PATCH,
          }),
          frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
          frame("response.completed", {
            response: { id: "resp_patch_stream", status: "completed", output: [upstreamItem] },
          }),
          "data: [DONE]",
        ].join("\n\n") + "\n\n";
        return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "resp_patch_json", status: "completed", output: [upstreamItem] });
    }) as typeof fetch;

    try {
      for (const stream of [false, true]) {
        takeSpendHome();
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fixture/deepseek-v4-flash",
            stream,
            input: [{ role: "user", content: [{ type: "input_text", text: "patch" }] }],
            tools: [
              {
                type: "custom",
                name: "apply_patch",
                description: "Apply a patch",
                format: { type: "grammar", syntax: "lark" },
              },
              {
                type: "function",
                name: "ordinary",
                description: "Ordinary function",
                parameters: { type: "object" },
              },
            ],
            tool_choice: stream
              ? {
                  type: "allowed_tools",
                  mode: "required",
                  tools: [{ type: "function", name: "ordinary" }],
                }
              : { type: "function", name: "ordinary" },
          }),
        }), config, { model: "", provider: "" });

        if (!stream) {
          const body = await response.json() as { output: Array<Record<string, unknown>> };
          expect(body.output[0]).toEqual(upstreamItem);
          continue;
        }

        const blocks = (await response.text()).split("\n\n").filter(block => block.includes("data: {"));
        const payloads = blocks.map(dataPayload);
        const inputDone = payloads.find(payload => payload.type === "response.custom_tool_call_input.done");
        expect(inputDone).toMatchObject({ input: DECORATED_PATCH });
        const itemDone = payloads.find(payload => payload.type === "response.output_item.done") as {
          item?: Record<string, unknown>;
        } | undefined;
        expect(itemDone?.item).toMatchObject({ type: "custom_tool_call", input: DECORATED_PATCH });
        const completed = payloads.find(payload => payload.type === "response.completed") as {
          response?: { output?: Array<Record<string, unknown>> };
        } | undefined;
        expect(completed?.response?.output?.[0]).toMatchObject({ input: DECORATED_PATCH });
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses repairs authorized native apply_patch calls in JSON and SSE", async () => {
    const savedFetch = globalThis.fetch;
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
    const upstreamItem = {
      type: "custom_tool_call",
      id: "ctc_patch",
      call_id: "call_patch",
      name: "apply_patch",
      input: DECORATED_PATCH,
      status: "completed",
    };

    globalThis.fetch = (async (_input, init) => {
      const outbound = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (outbound.stream === true) {
        const upstream = [
          frame("response.output_item.added", {
            output_index: 0,
            item: { ...upstreamItem, input: "", status: "in_progress" },
          }),
          frame("response.custom_tool_call_input.done", {
            output_index: 0,
            item_id: "ctc_patch",
            input: DECORATED_PATCH,
          }),
          frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
          frame("response.completed", {
            response: { id: "resp_patch_stream", status: "completed", output: [upstreamItem] },
          }),
          "data: [DONE]",
        ].join("\n\n") + "\n\n";
        return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "resp_patch_json", status: "completed", output: [upstreamItem] });
    }) as typeof fetch;

    try {
      for (const stream of [false, true]) {
        takeSpendHome();
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fixture/deepseek-v4-flash",
            stream,
            input: [{ role: "user", content: [{ type: "input_text", text: "patch" }] }],
            tools: [{
              type: "custom",
              name: "apply_patch",
              description: "Apply a patch",
              format: { type: "grammar", syntax: "lark" },
            }],
          }),
        }), config, { model: "", provider: "" });

        if (!stream) {
          const body = await response.json() as { output: Array<Record<string, unknown>> };
          expect(body.output[0]).toMatchObject({
            type: "custom_tool_call",
            name: "apply_patch",
            input: CANONICAL_PATCH,
          });
          continue;
        }

        const blocks = (await response.text()).split("\n\n").filter(block => block.includes("data: {"));
        const payloads = blocks.map(dataPayload);
        const inputDone = payloads.find(payload => payload.type === "response.custom_tool_call_input.done");
        expect(inputDone).toMatchObject({ input: CANONICAL_PATCH });
        const itemDone = payloads.find(payload => payload.type === "response.output_item.done") as {
          item?: Record<string, unknown>;
        } | undefined;
        expect(itemDone?.item).toMatchObject({ type: "custom_tool_call", input: CANONICAL_PATCH });
        const completed = payloads.find(payload => payload.type === "response.completed") as {
          response?: { output?: Array<Record<string, unknown>> };
        } | undefined;
        expect(completed?.response?.output?.[0]).toMatchObject({ input: CANONICAL_PATCH });
      }
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
      takeSpendHome();
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
      takeSpendHome();
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
