import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponsesCompact, clearCompactHandoffRoutesForTests } from "../../src/server/responses/compact";
import { translatorObservedBufferSnapshot } from "../../src/lib/translator-budget";
import { clearGuardrailsCompactContinuationsForTests } from "../../src/guardrails/compact-continuations";
import { clearGuardrailsContinuationsForTests } from "../../src/guardrails/continuations";
import { clearResponseStateForTests, rememberResponseState } from "../../src/responses/state";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import { codexHeaders, encryptedInput, fakeChatGptJwt, post, providerResponse, recoverySse, routedConfig } from "../helpers/agent-task-recovery";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "../helpers/test-budget";
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(15_000);
const originalFetch = globalThis.fetch;
const SECRET = "sk_live_abcdefghijklmnopqrstuvwx";
const PLACEHOLDER = "<STRIPE_ACCESS_TOKEN_1>";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGuardrailsCompactContinuationsForTests();
  clearGuardrailsContinuationsForTests();
  clearCompactHandoffRoutesForTests();
  clearResponseStateForTests();
  resetAgentTaskRecoveryState();
  clearComboTargetCooldowns();
});

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai-apikey",
    providers: { "openai-apikey": {
      adapter: "openai-responses", baseUrl: "https://api.openai.com/v1",
      authMode: "key", apiKey: "synthetic-key", models: ["gpt-5.5"],
    } },
    guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
  };
}

function completed(text: string) {
  return { id: "resp_refresh_248", status: "completed", output: [{
    type: "message", role: "assistant", content: [{ type: "output_text", text }],
  }] };
}

interface ChatChunk {
  choices: Array<{ delta: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{ index: number; function: { arguments: string } }>;
  }; finish_reason: string | null }>;
}

test.each(["completed", "incomplete", "disabled", "excluded"] as const)(
  "2.48 JSON-to-Chat-SSE preserves Guardrails boundaries: %s",
  async mode => {
    const cfg = config();
    if (mode === "disabled") cfg.guardrails = { enabled: false };
    if (mode === "excluded") cfg.guardrails!.providerScope = { mode: "selected", providerIds: ["elsewhere"] };
    const protectedTurn = mode === "completed" || mode === "incomplete";
    const token = protectedTurn ? PLACEHOLDER : SECRET;
    const bodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body));
      return Response.json({
        ...completed(`answer ${token}`),
        status: mode === "incomplete" ? "incomplete" : "completed",
        ...(mode === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output: [
          ...completed(`answer ${token}`).output,
          { type: "reasoning", summary: [{ type: "summary_text", text: `reasoning ${token}` }] },
          { type: "function_call", call_id: "call_refresh", name: "lookup", arguments: JSON.stringify({ key: token }) },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      });
    }) as typeof fetch;
    const before = translatorObservedBufferSnapshot().currentBytes;
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai-apikey/gpt-5.5", stream: true,
        messages: [{ role: "user", content: SECRET }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    }), cfg, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const wire = await response.text();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(token);
    if (protectedTurn) expect(bodies[0]).not.toContain(SECRET);
    const payloads = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6));
    expect(payloads.filter(value => value === "[DONE]")).toHaveLength(1);
    const chunks = payloads.filter(value => value !== "[DONE]").map(value => JSON.parse(value) as ChatChunk);
    const choices = chunks.flatMap(chunk => chunk.choices);
    expect(choices.map(choice => choice.delta.content ?? "").join(""))
      .toBe(`answer ${mode === "incomplete" ? PLACEHOLDER : SECRET}`);
    expect(choices.map(choice => choice.delta.reasoning_content ?? "").join("")).toBe(`reasoning ${token}`);
    expect(choices.flatMap(choice => choice.delta.tool_calls ?? []))
      .toMatchObject([{ index: 0, function: { arguments: JSON.stringify({ key: token }) } }]);
    expect(choices.filter(choice => choice.finish_reason !== null)).toHaveLength(1);
    expect(choices.at(-1)?.finish_reason).toBe(mode === "incomplete" ? "length" : "tool_calls");
    if (mode === "incomplete") expect(wire).not.toContain(SECRET);
    expect(translatorObservedBufferSnapshot().currentBytes).toBe(before);
  },
);

test.each(["enforced", "excluded"] as const)("native compact 404 retains captured %s policy through hot reload", async mode => {
  const cfg = config();
  if (mode === "excluded") cfg.guardrails!.providerScope = { mode: "selected", providerIds: ["elsewhere"] };
  const token = mode === "enforced" ? PLACEHOLDER : SECRET;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    if (calls.length === 1) {
      cfg.guardrails = { enabled: true, mode: "enforce", failurePolicy: "block" };
      return Response.json({ detail: "Not Found" }, { status: 404 });
    }
    return Response.json(completed(`summary ${token}`));
  }) as typeof fetch;
  const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openai-apikey/gpt-5.5", input: [{ role: "user", content: SECRET }] }),
  }), cfg, { model: "", provider: "", admissionKind: "loopback" });
  expect(response.status).toBe(200);
  const result = await response.text();
  expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/v1/responses/compact", "/v1/responses"]);
  for (const call of calls) {
    expect(call.body).toContain(token);
    if (mode === "enforced") expect(call.body).not.toContain(SECRET);
  }
  expect(result).toContain(token);
  if (mode === "enforced") expect(result).not.toContain(SECRET);
});

test.each(["xai/grok-4.5", "combo/recovery", "combo/native-recovery"])("cached encrypted-task recovery is rescanned before every %s send", async model => {
  const cfg = routedConfig();
  cfg.combos = { recovery: { strategy: "failover", targets: [{ provider: "xai", model: "grok-4.5" }] } };
  cfg.combos["native-recovery"] = { strategy: "failover", targets: [
    { provider: "openai", model: "gpt-5.5" }, { provider: "xai", model: "grok-4.5" },
  ] };
  cfg.guardrails = { enabled: true, mode: "enforce", failurePolicy: "block" };
  const bodies: string[] = [];
  let recoveries = 0;
  const headers = codexHeaders();
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chatgpt.com")) {
      if (!String(init?.body).includes("capture_assignment")) {
        return Response.json({ error: { message: "synthetic native failure" } }, { status: 503 });
      }
      recoveries++;
      return new Response(recoverySse(`Use ${SECRET}`), { headers: { "content-type": "text/event-stream" } });
    }
    bodies.push(String(init?.body));
    return providerResponse();
  }) as typeof fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post(cfg, model, encryptedInput(), headers);
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(recoveries).toBe(1);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body).toContain(PLACEHOLDER);
    expect(body).not.toContain(SECRET);
  }
});

test.each(["block", "passthrough"] as const)("combo recovered-task capacity failure honors %s without partial masking", async failurePolicy => {
  const cfg = routedConfig();
  cfg.guardrails = { enabled: true, mode: "enforce", failurePolicy };
  cfg.combos = { recovery: { strategy: "failover", targets: [{ provider: "xai", model: "grok-4.5" }] } };
  const bodies: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chatgpt.com")) {
      return new Response(recoverySse("r".repeat(140 * 1024)), { headers: { "content-type": "text/event-stream" } });
    }
    bodies.push(String(init?.body));
    return providerResponse();
  }) as typeof fetch;
  const response = await post(cfg, "combo/recovery", [
    { type: "message", role: "user", content: [{ type: "input_text", text: SECRET }] },
    ...encryptedInput(),
  ], codexHeaders());
  const text = await response.text();
  if (failurePolicy === "block") {
    expect(response.status).toBe(413);
    expect(text).toContain("guardrails_capacity_exceeded");
    expect(text).not.toContain(SECRET);
    expect(bodies).toHaveLength(0);
  } else {
    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(SECRET);
    expect(bodies[0]).not.toContain(PLACEHOLDER);
  }
});

async function openSocket(url: URL): Promise<WebSocket> {
  const target = new URL("/v1/responses", url);
  target.protocol = "ws:";
  const socket = new WebSocket(target, { headers: {
    authorization: `Bearer ${fakeChatGptJwt("acct-guardrails-refresh")}`,
    "chatgpt-account-id": "acct-guardrails-refresh",
  } } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("synthetic socket did not open"));
    }, INTERNAL_DEADLINE_MS);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("synthetic socket failed")); };
  });
  return socket;
}

function socketTurn(socket: WebSocket, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, frame?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.onmessage = socket.onclose = socket.onerror = null;
      if (error) reject(error);
      else resolve(frame!);
    };
    const timer = setTimeout(() => finish(new Error("synthetic turn did not terminate")), INTERNAL_DEADLINE_MS);
    socket.onclose = socket.onerror = () => finish(new Error("synthetic socket closed"));
    socket.onmessage = event => {
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (["error", "response.completed", "response.failed", "response.incomplete"].includes(String(frame.type))) {
          finish(undefined, frame);
        }
      } catch {
        finish(new Error("invalid synthetic frame"));
      }
    };
    socket.send(JSON.stringify({ type: "response.create", ...body }));
  });
}

test.each(["expired", "missing"] as const)("protected WS reconnect masks full tool history after %s replay", async mode => {
  let server: ReturnType<typeof startServer> | undefined;
  let socket: WebSocket | undefined;
  const realNow = Date.now;
  const bodies: Array<Record<string, unknown>> = [];
  const previousId = "resp_guardrails_expired";
  const message = { type: "message", role: "user", content: [{ type: "input_text", text: SECRET }] };
  const toolCall = { type: "function_call", call_id: "call_refresh", name: "lookup",
    arguments: JSON.stringify({ key: SECRET }), status: "completed" };
  const toolResult = { type: "function_call_output", call_id: "call_refresh", output: SECRET };
  try {
    if (mode === "expired") {
      Date.now = () => realNow() - 2 * 60 * 60 * 1000;
      rememberResponseState({ input: [message], store: false },
        { id: previousId, status: "completed", output: [toolCall] }, undefined, { force: true });
      Date.now = realNow;
    }
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(`event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed", response: completed(`answer ${PLACEHOLDER}`),
        })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.hostname !== "127.0.0.1") throw new Error("unexpected synthetic destination");
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig({
      port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "openai", openaiProviderTierVersion: 2,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", codexAccountMode: "direct" } },
      guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
    } as OcxConfig);
    server = startServer(0);
    socket = await openSocket(server.url);
    const rejected = await socketTurn(socket, {
      model: "gpt-5.5", previous_response_id: previousId, input: [toolResult], store: false,
    });
    expect(rejected).toMatchObject({ type: "error", status: 400, error: { code: "previous_response_not_found" } });
    expect(JSON.stringify(rejected)).not.toContain(SECRET);
    expect(bodies).toHaveLength(0);
    socket.close();
    socket = await openSocket(server.url);
    const restored = await socketTurn(socket, {
      model: "gpt-5.5", input: [message, toolCall, toolResult], store: false,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
    expect(restored.type).toBe("response.completed");
    expect(JSON.stringify(restored)).toContain(SECRET);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.previous_response_id).toBeUndefined();
    expect(bodies[0]!.input).toHaveLength(3);
    expect(JSON.stringify(bodies)).toContain(PLACEHOLDER);
    expect(JSON.stringify(bodies)).not.toContain(SECRET);
    expect(bodies[0]!.input).toMatchObject([
      { content: [{ text: PLACEHOLDER }] },
      { call_id: "call_refresh", arguments: JSON.stringify({ key: PLACEHOLDER }) },
      { call_id: "call_refresh", output: PLACEHOLDER },
    ]);
  } finally {
    Date.now = realNow;
    socket?.close();
    await server?.stop(true);
  }
}, SERVER_BUDGET_MS);
