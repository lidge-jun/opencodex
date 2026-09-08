import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import {
  XAI_GROK_CLI_BASE_URL,
  XAI_GROK_CLIENT_VERSION,
} from "../../src/providers/xai-transport";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const RESPONSES_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/responses`;
const encoder = new TextEncoder();

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;
let activeRoutedCase: { controller: AbortController; settled: Promise<void> } | null = null;

function runRoutedCase(body: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const result = body(controller.signal);
  // Observe the entire body, including its server-stop finally, even after a test timeout.
  activeRoutedCase = { controller, settled: result.then(() => {}, () => {}) };
  return result;
}

async function drainRoutedCase(): Promise<void> {
  const active = activeRoutedCase;
  if (!active) return;
  active.controller.abort(new DOMException("xAI fixture cleanup", "AbortError"));
  await active.settled;
  if (activeRoutedCase === active) activeRoutedCase = null;
}

function startXaiTestServer() {
  return startServer(0, {
    // This wire fixture does not exercise native Codex service ownership. Avoid
    // unrelated Windows service queries and native-main recovery during setup.
    inspectNativeCodexOwnership: () => ({ ownership: "foreign", reason: "xAI wire fixture" }),
  });
}

beforeEach(async () => {
  if (activeRoutedCase) throw new Error("previous routed-parent fixture has not finished cleanup");
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-xai-responses-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-xai-responses-"));
  process.env.OPENCODEX_HOME = testDir;
  await saveCredential("xai", {
    access: "stream-access",
    refresh: "stream-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "xai-stream-account",
    source: "oauth",
  });
});

afterEach(async () => {
  await drainRoutedCase();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
}, SERVER_BUDGET_MS);

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    fastMode: true,
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        models: ["grok-4.6"],
       modelAdapters: { "grok-4.6": "openai-responses" },
       modelSupportsServiceTier: { "grok-4.6": false },
        // Raw test config bypasses registry enrichment; production xai providers get
        // this denial from the registry entry (see derive.ts enrichProviderFromRegistry).
        supportsOpenAiWebSearchToolFields: false,
      },
    },
  } as OcxConfig;
}

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

describe("xAI OAuth Responses streaming opt-in", () => {
  test("routed-case cleanup waits for the entire aborted body finally", async () => {
    let markFinally!: () => void;
    const enteredFinally = new Promise<void>(resolve => { markFinally = resolve; });
    let releaseFinally!: () => void;
    const finallyGate = new Promise<void>(resolve => { releaseFinally = resolve; });
    let finallyFinished = false;
    const running = runRoutedCase(async signal => {
      try {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        markFinally();
        await finallyGate;
        finallyFinished = true;
      }
    });
    const outcome = running.then(() => null, (error: unknown) => error);
    let drained = false;
    const draining = drainRoutedCase().then(() => { drained = true; });
    try {
      await enteredFinally;
      await Promise.resolve();
      // Awaiting outcome first would hide a drain helper that returned too early.
      expect(drained).toBe(false);
      expect(finallyFinished).toBe(false);
    } finally {
      releaseFinally();
      await draining;
      await outcome;
    }
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(finallyFinished).toBe(true);
    expect(activeRoutedCase).toBeNull();
  }, SERVER_BUDGET_MS);

  test.each([true, false])("continues a routed parent after a string child result (stream=%s)", stream => runRoutedCase(async signal => {
    const captured: Array<Record<string, unknown>> = [];
    let privateItemRejections = 0;
    const childText = "  Synthetic worker result\nAll requested observations returned.\n ";
    const call = { type: "function_call", id: "fc_parent_probe", status: "completed",
      call_id: "call_parent_probe", name: "probe", arguments: "{}",
    };
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      // The fixture never falls through to a real OAuth or inference endpoint.
      if (url !== RESPONSES_ENDPOINT) throw new Error(`Unexpected fixture destination: ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.push(body);
      const items = body.input as Array<{ type?: string }>;
      if (items.some(item => item.type === "agent_message")) {
        privateItemRejections += 1;
        return Response.json({ error: 'unknown item type "agent_message"' }, { status: 422 });
      }
      const output = captured.length === 1 ? [call] : [{
        type: "message", id: `msg_child_result_${captured.length}`, status: "completed", role: "assistant",
        content: [{ type: "output_text", text: captured.length === 2 ? childText : "Parent continued", annotations: [] }],
      }];
      const response = { id: `resp_child_result_${captured.length}`, object: "response", status: "completed",
        model: "grok-4.6", output,
      };
      if (!stream) return Response.json(response);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({ type: "response.created", sequence_number: 0,
            response: { ...response, status: "in_progress", output: [] },
          }));
          controller.enqueue(sse({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: output[0] }));
          controller.enqueue(sse({ type: "response.output_item.done", sequence_number: 2, output_index: 0, item: output[0] }));
          controller.enqueue(sse({ type: "response.completed", sequence_number: 3, response }));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    saveConfig({ ...config(), multiAgentMode: "v2" });
    const server = startXaiTestServer();
    const send = async (session: string, input: unknown[], parentSession?: string) => {
      signal.throwIfAborted();
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        signal,
        method: "POST", headers: { "content-type": "application/json", "session-id": session,
          ...(parentSession ? { "x-codex-parent-thread-id": parentSession } : {}),
        },
        body: JSON.stringify({ model: "xai/grok-4.6", stream, store: false, input,
          tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: {} } }],
        }),
      });
      expect(response.status).toBe(200);
      if (!stream) return await response.json() as { output: Array<Record<string, unknown>> };
      const text = await response.text();
      const events = text.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));
      const terminal = events.find(event => event.type === "response.completed");
      expect(terminal).toBeDefined();
      return terminal.response as { output: Array<Record<string, unknown>> };
    };
    try {
      const initial = { type: "message", role: "user", content: [{ type: "input_text", text: "Collect a worker result" }] };
      const parent = await send("fixture-parent", [initial]);
      expect(parent.output[0]).toMatchObject(call);
      const child = await send("fixture-worker", [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Return the synthetic observations" }] },
      ], "fixture-parent");
      const childContent = child.output[0]!.content as Array<{ type: string; text: string }>;
      expect(childContent[0]).toMatchObject({ type: "output_text", text: childText });
      // Codex-client envelope simulation only: no scheduler or real child process is run.
      const toolResult = { type: "function_call_output", call_id: call.call_id, output: "Probe completed" };
      const agentMessage = { type: "agent_message", id: "amsg_worker_result", author: "/root/worker", recipient: "/root",
        content: childContent[0]!.text,
      };
      const resumed = await send("fixture-parent", [initial, ...parent.output, toolResult, agentMessage]);
      expect(resumed.output[0]).toMatchObject({ type: "message", content: [{ type: "output_text", text: "Parent continued" }] });
      expect(privateItemRejections).toBe(0);
      expect(captured).toHaveLength(3);
      const input = captured[2]!.input as Array<Record<string, unknown>>;
      expect(input.some(item => item.type === "agent_message")).toBe(false);
      expect(input.filter(item => item.type === "function_call")).toEqual([
        expect.objectContaining({ call_id: call.call_id, name: "probe", arguments: "{}" }),
      ]);
      expect(input.filter(item => item.type === "function_call_output")).toEqual([toolResult]);
      expect(input).toContainEqual({ type: "message", role: "user", content: [
        { type: "input_text", text: 'Agent message {"author":"/root/worker","recipient":"/root"}' },
        { type: "input_text", text: childText },
      ] });
      expect(agentMessage.content).toBe(childText);
    } finally {
      await server.stop(true);
    }
  }), 10_000);

  test("uses the native Responses wire and relays the first delta before completion", async () => {
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
    let completionReleased = false;
    let outboundBody: Record<string, unknown> | undefined;
    let outboundHeaders: Headers | undefined;
    let upstreamCalls = 0;

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESPONSES_ENDPOINT) return originalFetch(input, init);
      upstreamCalls += 1;
      outboundHeaders = new Headers(init?.headers);
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({
            type: "response.created",
            sequence_number: 0,
            response: {
              id: "resp_xai_stream",
              object: "response",
              status: "in_progress",
              model: "grok-4.6",
              output: [],
            },
          }));
          controller.enqueue(sse({
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { id: "msg_xai_stream", type: "message", status: "in_progress", role: "assistant", content: [] },
          }));
          controller.enqueue(sse({
            type: "response.content_part.added",
            sequence_number: 2,
            item_id: "msg_xai_stream",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }));
          controller.enqueue(sse({
            type: "response.output_text.delta",
            sequence_number: 3,
            item_id: "msg_xai_stream",
            output_index: 0,
            content_index: 0,
            delta: "first",
          }));
          void completionGate.then(() => {
            completionReleased = true;
            const message = {
              id: "msg_xai_stream",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "first second", annotations: [] }],
            };
            controller.enqueue(sse({
              type: "response.output_text.delta",
              sequence_number: 4,
              item_id: "msg_xai_stream",
              output_index: 0,
              content_index: 0,
              delta: " second",
            }));
            controller.enqueue(sse({
              type: "response.output_item.done",
              sequence_number: 5,
              output_index: 0,
              item: message,
            }));
            controller.enqueue(sse({
              type: "response.completed",
              sequence_number: 6,
              response: {
                id: "resp_xai_stream",
                object: "response",
                status: "completed",
                model: "grok-4.6",
                output: [message],
                usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
              },
            }));
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    saveConfig(config());
    const server = startXaiTestServer();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.6",
          input: "hello",
          stream: true,
          store: false,
          service_tier: "priority",
          reasoning: { effort: "xhigh", summary: "auto" },
        }),
      });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      await Promise.race([
        (async () => {
          while (!received.includes("response.output_text.delta")) {
            const chunk = await reader!.read();
            if (chunk.done) throw new Error("stream ended before the first xAI delta");
            received += decoder.decode(chunk.value, { stream: true });
          }
        })(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("the first xAI delta was not relayed before completion")),
          1_500,
        )),
      ]);

      expect(received).toContain("first");
      expect(completionReleased).toBe(false);
      expect(upstreamCalls).toBe(1);
      expect(outboundBody?.model).toBe("grok-4.6");
      expect(outboundBody?.input).toBe("hello");
      expect(outboundBody?.stream).toBe(true);
      expect(outboundBody?.service_tier).toBeUndefined();
      expect(outboundBody?.reasoning).toMatchObject({ effort: "xhigh" });
      expect(outboundBody?.messages).toBeUndefined();
      expect(outboundBody?.reasoning_effort).toBeUndefined();
      expect(outboundHeaders?.get("authorization")).toBe("Bearer stream-access");
      expect(outboundHeaders?.get("x-grok-client-identifier")).toBe("opencodex");
      expect(outboundHeaders?.get("x-grok-client-version")).toBe(XAI_GROK_CLIENT_VERSION);

      releaseCompletion();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("response.completed");
      expect(received).toContain(" second");
    } finally {
      releaseCompletion();
      await reader?.cancel().catch(() => {});
      await server.stop(true);
    }
  }, 10_000);

  test("lowers Codex namespaces for xAI and restores routed calls on the client stream", async () => {
    let outboundBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESPONSES_ENDPOINT) return originalFetch(input, init);
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const call = {
        id: "fc_spawn",
        type: "function_call",
        status: "completed",
        name: "collaboration__spawn_agent",
        call_id: "call_spawn",
        arguments: "{}",
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_namespace", object: "response", status: "in_progress", model: "grok-4.6", output: [] },
          }));
          controller.enqueue(sse({
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: call,
          }));
          controller.enqueue(sse({
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 0,
            item: call,
          }));
          controller.enqueue(sse({
            type: "response.completed",
            sequence_number: 3,
            response: {
              id: "resp_namespace",
              object: "response",
              status: "completed",
              model: "grok-4.6",
              output: [call],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    saveConfig(config());
    const server = startXaiTestServer();
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.6",
          stream: true,
          store: false,
          tools: [{ type: "web_search", external_web_access: true }],
          input: [
            {
              type: "additional_tools",
              role: "developer",
              tools: [
                {
                  type: "namespace",
                  name: "functions",
                  tools: [{ type: "custom", name: "exec", description: "run code", format: { type: "text" } }],
                },
                {
                  type: "namespace",
                  name: "collaboration",
                  tools: [{ type: "function", name: "spawn_agent", description: "spawn", parameters: {} }],
                },
              ],
            },
            { type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const clientText = await response.text();

      const outboundInput = outboundBody?.input as Array<{
        type: string;
        tools?: Array<{ type: string; name?: string }>;
      }> | undefined;
      const outboundTools = outboundInput?.find(item => item.type === "additional_tools")?.tools;
      expect(outboundTools?.some(tool => tool.type === "namespace")).toBe(false);
      expect(outboundTools?.find(tool => tool.name === "exec")?.type).toBe("function");
      expect(outboundTools?.find(tool => tool.name === "collaboration__spawn_agent")?.type).toBe("function");
      expect(outboundBody?.tools).toEqual([{ type: "web_search" }]);

      const payloads = clientText
        .split(/\r?\n/)
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const added = payloads.find(payload => payload.type === "response.output_item.added") as {
        item?: Record<string, unknown>;
      } | undefined;
      expect(added?.item).toMatchObject({
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: "call_spawn",
      });
      const completed = payloads.find(payload => payload.type === "response.completed") as {
        response?: { output?: Array<Record<string, unknown>> };
      } | undefined;
      expect(completed?.response?.output?.[0]).toMatchObject({
        namespace: "collaboration",
        name: "spawn_agent",
      });
    } finally {
      await server.stop(true);
    }
  }, 10_000);

  test("restores routed namespace calls in a non-streaming xAI JSON response", async () => {
    let outboundBody: Record<string, unknown> | undefined;
    const call = {
      id: "fc_spawn_json",
      type: "function_call",
      status: "completed",
      name: "collaboration__spawn_agent",
      call_id: "call_spawn_json",
      arguments: "{}",
    };

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESPONSES_ENDPOINT) return originalFetch(input, init);
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "resp_namespace_json",
        object: "response",
        status: "completed",
        model: "grok-4.6",
        output: [call],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    saveConfig(config());
    const server = startXaiTestServer();
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.6",
          stream: false,
          store: false,
          tools: [{
            type: "namespace",
            name: "collaboration",
            tools: [{ type: "function", name: "spawn_agent", description: "spawn", parameters: {} }],
          }],
          input: "delegate",
        }),
      });
      expect(response.status).toBe(200);

      const outboundTools = outboundBody?.tools as Array<{ type: string; name?: string }> | undefined;
      expect(outboundTools).toEqual([expect.objectContaining({
        type: "function",
        name: "collaboration__spawn_agent",
      })]);
      const clientBody = await response.json() as { output?: Array<Record<string, unknown>> };
      expect(clientBody.output?.[0]).toMatchObject({
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: "call_spawn_json",
      });
    } finally {
      await server.stop(true);
    }
  }, 10_000);
});
