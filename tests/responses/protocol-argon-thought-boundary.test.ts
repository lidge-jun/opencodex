import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { collectChatCompletion } from "../../src/chat/outbound";
import { collectAnthropicMessage } from "../../src/claude/outbound";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Synthetic protocol markers, not a transcript or an assertion about Argon's live output.
const THOUGHT = "MARKER_T1MARKER_T2";
const ANSWER = "MARKER_A1MARKER_A2MARKER_A3";
const SIGNATURE = "c3ludGhldGljLWFyZ29uLXRvb2wtc2lnbmF0dXJl";
const BASE = "https://daily-cloudcode-pa.googleapis.com";
const MODEL = "google-antigravity/gemini-4-argon";
type Protocol = "responses" | "chat" | "messages";
type Rec = Record<string, any>;
const modes = [
  { name: "buffered", stream: false, split: false },
  { name: "coalesced SSE", stream: true, split: false },
  { name: "split SSE", stream: true, split: true },
] as const;
const routes: Array<{ protocol: Protocol; direct: boolean }> = [
  { protocol: "responses", direct: false },
  { protocol: "chat", direct: false }, { protocol: "chat", direct: true },
  { protocol: "messages", direct: false }, { protocol: "messages", direct: true },
];
let home = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let releaseSpend: () => void;
let originalFetch: typeof fetch;
let wireBodies: Rec[];
let parts: Rec[];
let split: boolean;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-argon-boundary-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-argon-boundary-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  wireBodies = [];
  parts = [];
  split = false;
  await saveCredential("google-antigravity", {
    access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
    accountId: "fixture-account", projectId: "fixture-project", source: "oauth",
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== BASE || !["/v1internal:generateContent", "/v1internal:streamGenerateContent"].includes(url.pathname)) {
      throw new Error(`unexpected fixture request: ${url.origin}${url.pathname}`);
    }
    wireBodies.push(JSON.parse(String(init?.body)));
    const payload = (group: Rec[], terminal: boolean) => ({ response: {
      candidates: [{ content: { role: "model", parts: group }, ...(terminal ? { finishReason: "STOP" } : {}) }],
      ...(terminal ? { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 4, totalTokenCount: 22 } } : {}),
    } });
    if (url.searchParams.get("alt") !== "sse") return Response.json(payload(parts, true));
    const groups = split ? parts.map(part => [part]) : [parts];
    return new Response(groups.map((group, i) => `data: ${JSON.stringify(payload(group, i === groups.length - 1))}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  try { releaseSpend?.(); }
  finally {
    clearGenericFailoverHealth();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    codexHome?.restore();
    if (home) removeTreeWithRetry(home);
  }
});

function frames(text: string): Rec[] {
  return text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
}

async function verify(protocol: Protocol, direct: boolean, mode: typeof modes[number], tool: boolean, shown: boolean, clientOmit = false) {
  split = mode.split;
  parts = [
    { thought: true, text: "MARKER_T1" }, { thought: true, text: "MARKER_T2" },
    { thoughtSignature: SIGNATURE },
    { text: "MARKER_A1" }, { text: "MARKER_A2", thought: false },
    // Signatures can also belong to ordinary text; they are not a visibility flag.
    { text: "MARKER_A3", thoughtSignature: SIGNATURE },
    ...(tool ? [{ functionCall: { name: "lookup", args: { q: "fixture" } }, thoughtSignature: SIGNATURE }] : []),
  ];
  const config = {
    port: 0, hostname: "127.0.0.1", defaultProvider: "google-antigravity",
    providers: { "google-antigravity": {
      adapter: "google", baseUrl: BASE, authMode: "oauth", googleMode: "cloud-code-assist",
      project: "fixture-project", models: ["gemini-4-argon"], liveModels: false,
      showThinkingSummary: shown,
    } },
    protocols: { rollout: { antigravityDirect: direct, directEncoders: false } },
  } as OcxConfig;
  saveConfig(config);
  const schema = { type: "object", properties: { q: { type: "string" } } };
  const body = {
    model: MODEL, stream: mode.stream,
    ...(protocol === "responses" ? {
      input: "Return the fixture.", reasoning: { effort: "medium", ...(!shown || clientOmit ? { summary: "none" } : {}) },
      tools: [{ type: "function", name: "lookup", parameters: schema }],
    } : {
      messages: [{ role: "user", content: "Return the fixture." }], max_tokens: 400,
      ...(protocol === "chat" ? {
        reasoning_effort: "medium", reasoning: { summary: shown && !clientOmit ? "auto" : "none" },
        tools: [{ type: "function", function: { name: "lookup", parameters: schema } }],
      } : {
        thinking: shown ? { type: "enabled", budget_tokens: 2048, ...(clientOmit ? { display: "omitted" } : {}) } : { type: "disabled" },
        tools: [{ name: "lookup", input_schema: schema }],
      }),
    }),
  };
  const path = protocol === "chat" ? "chat/completions" : protocol;
  const req = new Request(`http://localhost/v1/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const requestId = `argon-boundary-${crypto.randomUUID()}`;
  const handler = protocol === "responses" ? handleResponses : protocol === "chat" ? handleChatCompletions : handleClaudeMessages;
  const response = await handler(req, config, { model: "", provider: "" }, { requestId, start: Date.now() });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(wireBodies).toHaveLength(1);
  expect(wireBodies[0].model).toMatch(/^gemini-4-argon-(low|medium|high)$/);
  expect(wireBodies[0].request.generationConfig?.thinkingConfig?.includeThoughts === true).toBe(shown && !clientOmit);
  const visible = shown && !clientOmit;
  const events = mode.stream ? frames(text) : [];
  const budget = createTranslatorBudget();
  try {
    let result: Rec;
    if (!mode.stream) result = JSON.parse(text);
    else if (protocol === "responses") {
      expect(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("")).toBe(ANSWER);
      expect(events.filter(e => e.type === "response.reasoning_summary_text.delta").map(e => e.delta).join("")).toBe(visible ? THOUGHT : "");
      const completed = events.filter(e => e.type === "response.completed");
      expect(completed).toHaveLength(1);
      result = completed[0].response;
    } else if (protocol === "chat") {
      expect(text).toContain("data: [DONE]");
      expect(events.map(e => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(ANSWER);
      expect(events.map(e => e.choices?.[0]?.delta?.reasoning_content ?? "").join("")).toBe(visible ? THOUGHT : "");
      result = await collectChatCompletion(new Response(text).body!, MODEL, budget);
    } else {
      expect(events.filter(e => e.type === "message_stop")).toHaveLength(1);
      expect(events.filter(e => e.delta?.type === "text_delta").map(e => e.delta.text).join("")).toBe(ANSWER);
      expect(events.filter(e => e.delta?.type === "thinking_delta").map(e => e.delta.thinking).join("")).toBe(visible ? THOUGHT : "");
      result = await collectAnthropicMessage(new Response(text).body!, MODEL, budget);
    }
    if (protocol === "responses") {
      expect(result.status).toBe("completed");
      expect(result.output.filter((i: Rec) => i.type === "message").flatMap((i: Rec) => i.content).map((p: Rec) => p.text).join("")).toBe(ANSWER);
      expect(result.output.filter((i: Rec) => i.type === "reasoning").flatMap((i: Rec) => i.summary ?? []).map((p: Rec) => p.text).join("")).toBe(visible ? THOUGHT : "");
      const calls = result.output.filter((i: Rec) => i.type === "function_call");
      expect(calls).toHaveLength(tool ? 1 : 0);
      if (tool) expect(calls[0]).toMatchObject({ name: "lookup", arguments: '{"q":"fixture"}', extra_content: { google: { thought_signature: SIGNATURE } } });
    } else if (protocol === "chat") {
      const choice = result.choices[0];
      expect(choice.message.content).toBe(ANSWER);
      expect(choice.message.reasoning_content ?? "").toBe(visible ? THOUGHT : "");
      expect(choice.finish_reason).toBe(tool ? "tool_calls" : "stop");
      expect(choice.message.tool_calls ?? []).toHaveLength(tool ? 1 : 0);
      if (tool) expect(choice.message.tool_calls[0].function).toEqual({ name: "lookup", arguments: '{"q":"fixture"}' });
    } else {
      expect(result.content.filter((b: Rec) => b.type === "text").map((b: Rec) => b.text).join("")).toBe(ANSWER);
      expect(result.content.filter((b: Rec) => b.type === "thinking").map((b: Rec) => b.thinking).join("")).toBe(visible ? THOUGHT : "");
      expect(result.stop_reason).toBe(tool ? "tool_use" : "end_turn");
      const calls = result.content.filter((b: Rec) => b.type === "tool_use");
      expect(calls).toHaveLength(tool ? 1 : 0);
      if (tool) expect(calls[0]).toMatchObject({ name: "lookup", input: { q: "fixture" } });
    }
    if (!visible) expect(text).not.toContain("MARKER_T");
  } finally { budget.dispose(); }
  if (protocol !== "responses") {
    let trace: Rec | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      trace = getRequestLogEntries().find(row => row.requestId === requestId)?.protocolTrace;
      if (trace) break;
      await Bun.sleep(10);
    }
    expect(trace?.requestPath).toEqual(direct ? [protocol, "ir", "other"] : [protocol, "responses-internal", "ir", "other"]);
    expect(trace?.responsePath).toEqual(direct ? ["other", "ir", protocol] : ["other", "ir", "responses-internal", protocol]);
  }
}

describe("Argon thought markers stay out of ordinary client output", () => {
  for (const { protocol, direct } of routes) for (const mode of modes) for (const tool of [false, true]) for (const shown of [false, true]) {
    test(`${protocol} direct=${direct} ${mode.name} tool=${tool} summaries=${shown}`, () => verify(protocol, direct, mode, tool, shown));
  }
  for (const { protocol, direct } of routes) for (const mode of modes) {
    test(`${protocol} direct=${direct} client-only display opt-out: ${mode.name}`, () => verify(protocol, direct, mode, true, true, true));
  }
});
