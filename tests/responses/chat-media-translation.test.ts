import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatCompletionsRequestError, chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat";
import { isNativeChatRouteEligible } from "../../src/server/chat-native";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { RouteResult } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "test-placeholder", authMode: "key" };
const media = [
  { type: "input_audio", input_audio: { data: "YWJj", format: "wav" } },
  { type: "input_audio", audio_url: "data:audio/wav;base64,YWJj" },
  { type: "input_file", file_id: "file-private" },
];
// An inline document is carried in user content and still has no carrier anywhere else (#5212).
const INLINE_FILE = { type: "file", file: { filename: "private.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } };

function chat(part: unknown, role = "user") {
  return { model: "model", messages: [{ role, tool_call_id: "call1", content: [{ type: "text", text: "read this" }, part] }] };
}

describe("Chat media stays native or fails explicitly at translation", () => {
  test("user and tool media never disappear in the converter", () => {
    for (const role of ["user", "tool"]) {
      for (const part of media) {
        expect(() => chatCompletionsToResponsesBody(chat(part, role))).toThrow(ChatCompletionsRequestError);
        expect(() => chatCompletionsToResponsesBody(chat(part, role))).toThrow("OpenCodex cannot translate");
      }
    }
  });

  test("an inline document is carried in user content and refused where nothing carries it", () => {
    const translated = chatCompletionsToResponsesBody(chat(INLINE_FILE));
    expect(translated.input).toEqual([{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "read this" },
        { type: "input_file", file_data: "data:application/pdf;base64,JVBERi0=", filename: "private.pdf" },
      ],
    }]);
    for (const role of ["tool", "system", "assistant"]) {
      expect(() => chatCompletionsToResponsesBody(chat(INLINE_FILE, role))).toThrow("OpenCodex cannot translate");
    }
  });

  test("the native Chat route retains the caller's exact media blocks", () => {
    const route = { provider, providerName: "gateway", modelId: "model" } as RouteResult;
    for (const part of [...media, INLINE_FILE]) {
      const raw = chat(part);
      expect(isNativeChatRouteEligible(route, raw)).toBe(true);
      const wire = JSON.parse(buildOpenAIChatPassthroughRequest(provider, raw, "model", false).body);
      expect(wire.messages).toEqual(raw.messages);
    }
  });

  test("diverted legacy function images return an explicit error instead of losing the result", () => {
    const raw = {
      model: "model",
      messages: [
        { role: "user", content: "Inspect the result." },
        { role: "assistant", function_call: { name: "capture", arguments: "{}" }, content: null },
        { role: "function", name: "capture", content: [{ type: "image_url", image_url: { url: "https://example.invalid/secret.png" } }] },
      ],
    };
    const route = { provider, providerName: "gateway", modelId: "model" } as RouteResult;
    expect(isNativeChatRouteEligible(route, raw)).toBe(false);
    expect(() => chatCompletionsToResponsesBody(raw)).toThrow("Legacy function-result image translation is not implemented");
  });

  test("legacy declarations, calls and textual results translate as one paired tool exchange", () => {
    const translated = chatCompletionsToResponsesBody({
      model: "model",
      functions: [{ name: "lookup", description: "Look up a value", parameters: {
        type: "object", properties: { key: { type: "string" } }, required: ["key"],
      } }],
      function_call: { name: "lookup" },
      messages: [
        { role: "user", content: "Find it." },
        { role: "assistant", content: null, function_call: { name: "lookup", arguments: '{"key":"answer"}' } },
        { role: "function", name: "lookup", content: "RESULT_42" },
        { role: "assistant", content: "The result is 42." },
      ],
    });

    expect(translated.tools).toEqual([{
      type: "function", name: "lookup", description: "Look up a value",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    }]);
    expect(translated.tool_choice).toEqual({ type: "function", name: "lookup" });
    const input = translated.input as Array<Record<string, unknown>>;
    const call = input.find(item => item.type === "function_call")!;
    const output = input.find(item => item.type === "function_call_output")!;
    expect(call).toMatchObject({ name: "lookup", arguments: '{"key":"answer"}' });
    expect(output).toEqual({ type: "function_call_output", call_id: call.call_id, output: "RESULT_42" });
    expect(input).toContainEqual({
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "The result is 42." }],
    });
  });

  test("a null legacy function call preserves a textual assistant message", () => {
    const translated = chatCompletionsToResponsesBody({
      model: "model",
      messages: [{ role: "assistant", content: "The result is 42.", function_call: null }],
    });

    expect(translated.input).toEqual([{
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "The result is 42." }],
    }]);
  });

  test("an orphan legacy function result is rejected instead of silently discarded", () => {
    expect(() => chatCompletionsToResponsesBody({
      model: "model",
      messages: [{ role: "user", content: "go" }, { role: "function", name: "lookup", content: "orphan" }],
    })).toThrow("function result has no pending call named lookup");
  });

  test("plain text mentioning an attachment is not treated as one", () => {
    const text = JSON.stringify([...media, INLINE_FILE]);
    const out = chatCompletionsToResponsesBody({ model: "model", messages: [{ role: "user", content: text }] });
    expect(out.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text }] }]);
  });
});

let home = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-media-guard-");
  home = mkdtempSync(join(tmpdir(), "ocx-media-guard-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome?.restore();
  codexHome = undefined;
  try { removeTreeWithRetry(home); } catch { /* Temp cleanup cannot change a passed request assertion. */ }
});

test("real HTTP translation refuses media before sending to the selected upstream", async () => {
  let sends = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { sends++; return new Response("Unexpected upstream request", { status: 500 }); } });
  let server: ReturnType<typeof startServer> | undefined;
  try {
    saveConfig({
      port: 0, defaultProvider: "gateway",
      providers: { gateway: { ...provider, baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`, allowPrivateNetwork: true } },
    } as OcxConfig);
    server = startServer(0);
    for (const part of [
      { type: "input_audio", audio_url: "data:audio/wav;base64,YWJj" },
      { type: "input_file", filename: "private.pdf", file_id: "file-private" },
    ]) {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gateway/model", stream: false, input: [{ type: "message", role: "user", content: [part] }] }),
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("OpenCodex cannot translate");
      expect(body.error.message).not.toContain("private.pdf");
      expect(body.error.message).not.toContain("YWJj");
    }
    expect(sends).toBe(0);
  } finally {
    await server?.stop(true);
    await upstream.stop(true);
  }
}, 25000);
