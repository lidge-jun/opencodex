/**
 * A Gemini thought signature survives a Chat Completions tool loop against a Google route.
 *
 * Gemini 3 rejects a replayed functionCall that lost its thoughtSignature. On the Chat wire the
 * signature rides on \`tool_calls[].extra_content.google.thought_signature\` (the same carrier the
 * Responses wire uses): the proxy must surface it on the answer and read it back on the next turn,
 * on both the direct-encoder lane and the bridge lane.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { flushThoughtSignatureReplayForTests, resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const SIGNATURE = "CiQB0e2Kb7xQ9Zt0SignatureFixtureAAAA==";
const OTHER_ORIGIN = "https://chat.example.test";
let otherBodies: Record<string, any>[] = [];

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
let originalFetch: typeof fetch;
let upstreamBodies: Record<string, any>[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-google-sig-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-google-sig-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  upstreamBodies = [];
  otherBodies = [];
  resetThoughtSignatureReplayForTests();
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === GEMINI_ORIGIN && url.pathname.startsWith("/v1beta/models/")) {
      upstreamBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      const payload = {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: SIGNATURE }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      };
      return url.searchParams.get("alt") === "sse"
        ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json(payload);
    }
    if (url.origin === OTHER_ORIGIN) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, any>;
      otherBodies.push(body);
      const message = { role: "assistant", content: null, tool_calls: [{ id: "call_other", type: "function", function: { name: "lookup", arguments: "{}" } }] };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream === true) {
        const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
        const base = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "m1" };
        return new Response([
          frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] }, finish_reason: null }] }),
          frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
          frame({ ...base, choices: [], usage }),
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "chatcmpl-x", object: "chat.completion", created: 1, model: "m1", choices: [{ index: 0, message, finish_reason: "tool_calls" }], usage });
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

async function forgetRememberedSignatures(): Promise<void> {
  await flushThoughtSignatureReplayForTests();
  rmSync(join(testDir, "thought-signature-replay.json"), { force: true });
  resetThoughtSignatureReplayForTests();
}

function config(direct: boolean): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google",
    providers: {
      google: { adapter: "google", baseUrl: GEMINI_ORIGIN, authMode: "key", apiKey: "fixture-key", models: ["gemini-3-flash-preview"] },
      other: { adapter: "openai-chat", baseUrl: OTHER_ORIGIN + "/v1", authMode: "key", apiKey: "other-key", models: ["m1"] },
    },
    protocols: { rollout: { directEncoders: direct } },
  } as OcxConfig;
}

const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }];

async function chat(direct: boolean, body: Record<string, unknown>, model = "google/gemini-3-flash-preview"): Promise<string> {
  const cfg = config(direct);
  saveConfig(cfg);
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, tools, ...body }),
  }), cfg, { model: "", provider: "" }, { requestId: "sig-" + crypto.randomUUID(), start: Date.now() });
  expect(response.status).toBe(200);
  return response.text();
}

function toolCallsOf(text: string, stream: boolean): Record<string, any>[] {
  if (!stream) return (JSON.parse(text) as Record<string, any>).choices[0].message.tool_calls;
  return text.split("\n\n").filter(block => block.startsWith("data:") && !block.includes("[DONE]"))
    .flatMap(block => (JSON.parse(block.slice(5)) as Record<string, any>).choices?.[0]?.delta?.tool_calls ?? []);
}

describe("Gemini thought signatures on the Chat wire", () => {
  for (const direct of [true, false]) for (const stream of [false, true]) {
    test(`a signed call surfaces extra_content and its echo signs the replayed call (direct=${direct}, stream=${stream})`, async () => {
      const first = toolCallsOf(await chat(direct, { stream, messages: [{ role: "user", content: "look it up" }] }), stream);
      const call = first.find(entry => entry.id);
      expect(call?.extra_content).toEqual({ google: { thought_signature: SIGNATURE } });
      // The proxy also remembers the signature server-side (memory and its durable file); forget
      // both so turn 2 proves the echo.
      await forgetRememberedSignatures();
      await chat(direct, { stream: false, messages: [
        { role: "user", content: "look it up" },
        { role: "assistant", content: null, tool_calls: [{ id: call!.id, type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" }, extra_content: call!.extra_content }] },
        { role: "tool", tool_call_id: call!.id, content: "found" },
      ] });
      const replayed = (upstreamBodies.at(-1)!.contents as Record<string, any>[])
        .flatMap(content => content.parts as Record<string, any>[]).find(part => part.functionCall);
      expect(replayed?.thoughtSignature).toBe(SIGNATURE);
    });
  }
});

describe("Gemini thought signatures read from the Chat wire", () => {
  for (const direct of [true, false]) {
    test(`an echoed extra_content signs the replayed functionCall part (direct=${direct})`, async () => {
      await chat(direct, { stream: false, messages: [
        { role: "user", content: "look it up" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_echo_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" }, extra_content: { google: { thought_signature: SIGNATURE } } }] },
        { role: "tool", tool_call_id: "call_echo_1", content: "found" },
      ] });
      const replayed = (upstreamBodies.at(-1)!.contents as Record<string, any>[])
        .flatMap(content => content.parts as Record<string, any>[]).find(part => part.functionCall);
      expect(replayed?.thoughtSignature).toBe(SIGNATURE);
    });
  }
});

describe("Gemini thought signatures stay on Google routes", () => {
  const signedHistory = (extra: unknown) => [
    { role: "user", content: "look it up" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_echo_2", type: "function", function: { name: "lookup", arguments: "{}" }, extra_content: extra }] },
    { role: "tool", tool_call_id: "call_echo_2", content: "found" },
  ];

  for (const direct of [true, false]) {
    test(`malformed and oversized echoes are dropped, not refused (direct=${direct})`, async () => {
      for (const extra of ["x", { google: { thought_signature: 123 } }, { google: { thought_signature: "A".repeat(70_000) } }]) {
        await chat(direct, { stream: false, messages: signedHistory(extra) });
        const replayed = (upstreamBodies.at(-1)!.contents as Record<string, any>[])
          .flatMap(content => content.parts as Record<string, any>[]).find(part => part.functionCall);
        expect(replayed?.thoughtSignature === SIGNATURE).toBe(false);
      }
    });
  }

  test("another vendor never receives Google's extra_content and answers without it", async () => {
    for (const direct of [true, false]) {
      const text = await chat(direct, { stream: false, messages: signedHistory({ google: { thought_signature: SIGNATURE } }) }, "other/m1");
      expect(text).not.toContain("extra_content");
      expect(JSON.stringify(otherBodies.at(-1))).not.toContain("extra_content");
      expect(JSON.stringify(otherBodies.at(-1))).not.toContain(SIGNATURE);
    }
  });
});
