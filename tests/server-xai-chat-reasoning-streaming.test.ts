import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { saveCredential } from "../src/oauth/store";
import {
  XAI_GROK_CLI_BASE_URL,
  XAI_GROK_CLIENT_VERSION,
} from "../src/providers/xai-transport";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const CHAT_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/chat/completions`;
const encoder = new TextEncoder();

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-xai-chat-reasoning-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-xai-chat-reasoning-"));
  process.env.OPENCODEX_HOME = testDir;
  await saveCredential("xai", {
    access: "stream-access",
    refresh: "stream-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "xai-stream-account",
    source: "oauth",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        models: ["grok-4.6"],
      },
    },
  } as OcxConfig;
}

function chatSse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

describe("xAI OAuth Chat reasoning streaming", () => {
  test("bridges reasoning_content before content and response.completed", async () => {
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
    let completionReleased = false;
    let outboundBody: Record<string, unknown> | undefined;
    let outboundHeaders: Headers | undefined;
    let upstreamCalls = 0;

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== CHAT_ENDPOINT) return originalFetch(input, init);
      upstreamCalls += 1;
      outboundHeaders = new Headers(init?.headers);
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chatSse({
            id: "chatcmpl_xai_reasoning",
            object: "chat.completion.chunk",
            model: "grok-4.6",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          }));
          controller.enqueue(chatSse({
            id: "chatcmpl_xai_reasoning",
            object: "chat.completion.chunk",
            model: "grok-4.6",
            choices: [{ index: 0, delta: { reasoning_content: "first thought" }, finish_reason: null }],
          }));
          controller.enqueue(chatSse({
            id: "chatcmpl_xai_reasoning",
            object: "chat.completion.chunk",
            model: "grok-4.6",
            choices: [{ index: 0, delta: { reasoning_content: " then second" }, finish_reason: null }],
          }));
          void completionGate.then(() => {
            completionReleased = true;
            controller.enqueue(chatSse({
              id: "chatcmpl_xai_reasoning",
              object: "chat.completion.chunk",
              model: "grok-4.6",
              choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
            }));
            controller.enqueue(chatSse({
              id: "chatcmpl_xai_reasoning",
              object: "chat.completion.chunk",
              model: "grok-4.6",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
            }));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    saveConfig(config());
    const server = startServer(0);
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
          while (!received.includes("response.reasoning_summary_text.delta")) {
            const chunk = await reader!.read();
            if (chunk.done) throw new Error("stream ended before the first xAI reasoning delta");
            received += decoder.decode(chunk.value, { stream: true });
          }
        })(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("xAI reasoning was not relayed before completion")),
          1_500,
        )),
      ]);

      expect(received).toContain("first thought");
      expect(received).not.toContain("response.completed");
      expect(completionReleased).toBe(false);
      expect(upstreamCalls).toBe(1);
      expect(outboundBody?.model).toBe("grok-4.6");
      expect(outboundBody?.messages).toBeArray();
      expect(outboundBody?.stream).toBe(true);
      expect(outboundBody?.service_tier).toBeUndefined();
      expect(outboundBody?.reasoning_effort).toBe("xhigh");
      expect(outboundBody?.input).toBeUndefined();
      expect(outboundBody?.reasoning).toBeUndefined();
      expect(outboundHeaders?.get("authorization")).toBe("Bearer stream-access");
      expect(outboundHeaders?.get("x-grok-client-identifier")).toBe("opencodex");
      expect(outboundHeaders?.get("x-grok-client-version")).toBe(XAI_GROK_CLIENT_VERSION);

      releaseCompletion();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      const reasoningIndex = received.indexOf("response.reasoning_summary_text.delta");
      const contentIndex = received.indexOf("response.output_text.delta");
      const completedIndex = received.indexOf("response.completed");
      expect(reasoningIndex).toBeGreaterThanOrEqual(0);
      expect(contentIndex).toBeGreaterThan(reasoningIndex);
      expect(completedIndex).toBeGreaterThan(contentIndex);
      expect(received).toContain("then second");
      expect(received).toContain("answer");
    } finally {
      releaseCompletion();
      await reader?.cancel().catch(() => {});
      await server.stop(true);
    }
  }, 10_000);
});
