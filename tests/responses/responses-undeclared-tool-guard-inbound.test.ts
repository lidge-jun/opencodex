import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "../../src/server/responses-undeclared-tool-guard";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };
afterEach(() => { releaseSpendHome?.(); releaseSpendHome = undefined; });

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;
}

function readFrames(body: string) {
  return body.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    const payload = data && data !== "[DONE]" ? JSON.parse(data) as Record<string, unknown> : undefined;
    return { event, data, payload };
  });
}

describe("native passthrough inbound tool catalogs", () => {
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
    inboundWire?: "chat" | "anthropic",
  ) {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => upstream()) as typeof fetch;
    try {
      takeSpendHome();
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
      }), requestConfig, { model: "", provider: "" }, { inboundWire });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  for (const inboundWire of ["chat", "anthropic"] as const) {
    for (const stream of [false, true]) {
      // Deferred-catalog wires relay an undeclared client call: the caller's own tool
      // registry owns the full declaration boundary, not the partial translated catalog.
      test(`${inboundWire} passthrough relays an undeclared Write call (${stream ? "streaming" : "JSON"})`, async () => {
        const writeCall = { ...call, name: "Write" };
        const upstream = stream
          ? () => new Response([
            frame("response.output_item.added", { output_index: 0, item: writeCall }),
            frame("response.completed", { response: { id: "resp_1", status: "completed", output: [writeCall] } }),
          ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } })
          : () => new Response(
            JSON.stringify({ id: "resp_1", status: "completed", output: [writeCall] }),
            { headers: { "content-type": "application/json" } },
          );
        const response = await post(
          stream,
          [{ type: "function", name: "Read", parameters: { type: "object" } }],
          upstream,
          undefined,
          config,
          [],
          "fixture/deepseek-v4-flash",
          undefined,
          undefined,
          inboundWire,
        );

        if (stream) {
          const body = await response.text();
          const frames = readFrames(body);
          expect(frames.some(item => item.payload?.type === "response.failed")).toBe(false);
          expect(frames.some(item => item.payload?.type === "response.completed")).toBe(true);
        } else {
          expect(response.status).toBe(200);
          expect(await response.text()).not.toContain("undeclared");
        }
      });

      // An explicit empty catalog is still a deny-all the caller declared; it is the one
      // case a deferred wire cannot leave to a fuller client registry.
      test(`${inboundWire} passthrough refuses undeclared Write under tools:[] (${stream ? "streaming" : "JSON"})`, async () => {
        const writeCall = { ...call, name: "Write" };
        const upstream = stream
          ? () => new Response([
            frame("response.output_item.added", { output_index: 0, item: writeCall }),
            frame("response.completed", { response: { id: "resp_1", status: "completed", output: [writeCall] } }),
          ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } })
          : () => new Response(
            JSON.stringify({ id: "resp_1", status: "completed", output: [writeCall] }),
            { headers: { "content-type": "application/json" } },
          );
        const response = await post(
          stream,
          [],
          upstream,
          undefined,
          config,
          [],
          "fixture/deepseek-v4-flash",
          undefined,
          undefined,
          inboundWire,
        );

        if (stream) {
          // This direct internal call still returns Responses wire; endpoint projections are checked below.
          const body = await response.text();
          expect(body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
          const frames = readFrames(body);
          expect(frames.some(item => item.payload?.type === "response.failed")).toBe(true);
          expect(frames.some(item => item.payload?.type === "response.completed")).toBe(false);
        } else {
          expect(response.status).toBe(502);
          expect(await response.text()).toContain("undeclared");
        }
      });
    }
  }

  for (const surface of ["responses", "chat", "anthropic"] as const) {
    test(`${surface} endpoint refuses the undeclared call in its own wire without a successful terminal`, async () => {
      const savedFetch = globalThis.fetch;
      let upstreamRequests = 0;
      globalThis.fetch = (async () => {
        upstreamRequests++;
        const writeCall = { ...call, name: "Write" };
        return new Response([
          frame("response.output_item.added", { output_index: 0, item: writeCall }),
          frame("response.completed", { response: { id: "resp_wire_refusal", status: "completed", output: [writeCall] } }),
        ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      try {
        takeSpendHome();
        const model = "fixture/deepseek-v4-flash";
        const schema = { type: "object" };
        // Deferred wires only fail closed on an explicit empty catalog; the Responses wire
        // fails closed on any catalog the call's name is absent from.
        const input = surface === "responses"
          ? { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
            tools: [{ type: "function", name: "Read", parameters: schema }] }
          : surface === "chat"
            ? { messages: [{ role: "user", content: "hi" }], tools: [] }
            : { max_tokens: 64, messages: [{ role: "user", content: "hi" }], tools: [] };
        const path = surface === "responses" ? "responses" : surface === "chat" ? "chat/completions" : "messages";
        const request = new Request(`http://localhost/v1/${path}`, {
          method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, stream: true, ...input }),
        });
        const context = { model: "", provider: "" };
        const response = surface === "responses" ? await handleResponses(request, config, context)
          : surface === "chat" ? await handleChatCompletions(request, config, context)
            : await handleClaudeMessages(request, config, context);
        const body = await response.text();
        expect(upstreamRequests).toBeGreaterThan(0);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const frames = readFrames(body);
        const payloads = frames.flatMap(item => item.payload ? [item.payload] : []);
        expect(payloads.some(item => item.type === "response.completed")).toBe(false);
        if (surface === "responses") {
          const failed = frames.filter(item => item.payload?.type === "response.failed");
          expect(failed).toHaveLength(1);
          expect(failed[0]?.event).toBe("response.failed");
          expect(failed[0]?.payload).toMatchObject({ response: { status: "failed", error: { code: UNDECLARED_TOOL_CALL_ERROR_CODE } } });
          // [DONE] closes a canonical failure as well; it is not a successful Responses terminal.
          expect(frames.at(-1)?.data).toBe("[DONE]");
        } else {
          expect(frames.some(item => item.data === "[DONE]")).toBe(false);
          const errors = frames.filter(item => typeof item.payload?.error === "object" && item.payload.error !== null);
          expect(errors).toHaveLength(1);
          expect(errors[0]?.payload).toMatchObject({ error: { message: expect.stringContaining("undeclared") } });
          if (surface === "chat") {
            expect(errors[0]?.event).toBeUndefined();
            expect(errors[0]?.payload?.type).toBeUndefined();
            expect(typeof (errors[0]?.payload?.error as { type?: unknown }).type).toBe("string");
            // The deterministic refusal keeps its code on every translated wire.
            expect(errors[0]?.payload?.error).toMatchObject({ code: UNDECLARED_TOOL_CALL_ERROR_CODE });
            const choices = payloads.flatMap(item => Array.isArray(item.choices) ? item.choices : []);
            expect(choices.some(choice => choice.finish_reason != null)).toBe(false);
          } else {
            expect(errors[0]?.event).toBe("error");
            expect(errors[0]?.payload?.type).toBe("error");
            // A catalog violation is api_error + its code — never a retryable overloaded_error.
            expect(errors[0]?.payload?.error).toMatchObject({
              type: "api_error",
              code: UNDECLARED_TOOL_CALL_ERROR_CODE,
            });
            expect(frames.some(item => item.event === "message_stop" || item.payload?.type === "message_stop")).toBe(false);
            expect(payloads.some(item => item.type === "message_delta"
              && (item.delta as { stop_reason?: unknown } | undefined)?.stop_reason != null)).toBe(false);
          }
        }
      } finally { globalThis.fetch = savedFetch; }
    });
  }

});
