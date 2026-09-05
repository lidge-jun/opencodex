import { afterEach, expect, spyOn, test } from "bun:test";
import { createKiroAdapter } from "../../src/adapters/kiro";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { parseRequest } from "../../src/responses/parser";
import { bindTurnTerminationScope, rememberDeliveredFinalAnswer } from "../../src/responses/turn-termination";
import { conversationIdFromResponsesRequest } from "../../src/server/request-log-conversation";
import type { OcxParsedRequest } from "../../src/types";
import { recoverEncryptedAgentTask, resetAgentTaskRecoveryState, restoreCachedEncryptedAgentTasks } from "../../src/server/responses/agent-task-recovery";
import { codexHeaders, encryptedInput, FERNET_TASK, SECOND_FERNET_TASK, originalFetch, recoverySse, routedConfig } from "../helpers/agent-task-recovery";
afterEach(() => { globalThis.fetch = originalFetch; resetAgentTaskRecoveryState(); });

test("replay reuses admitted recovery after a tool result without another network call", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(recoverySse("Read nonce.txt exactly.")); }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
  const config = routedConfig({ enabled: true });
  expect(await recoverEncryptedAgentTask(req, encryptedInput(), {}, config, { parentThreadId: "parent" })).toBe(true);
  const replay = [...encryptedInput(), { type: "function_call_output", call_id: "tool", output: "result" }];
  expect(restoreCachedEncryptedAgentTasks(req, replay, config, { parentThreadId: "parent" })).toBe(1);
  expect(JSON.stringify(replay)).toContain("Read nonce.txt exactly.");
  expect(JSON.stringify(replay)).not.toContain(FERNET_TASK);
  expect(calls).toBe(1);
});

test("replay does not recover unseen envelopes, other parents, or other callers", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(recoverySse("Private assignment.")); }) as typeof fetch;
  const config = routedConfig({ enabled: true });
  const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
  expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config, { parentThreadId: "parent" })).toBe(0);
  expect(calls).toBe(0);
  expect(await recoverEncryptedAgentTask(req, encryptedInput(), {}, config, { parentThreadId: "parent" })).toBe(true);
  for (const [request, parent] of [[req, "another-parent"], [new Request("http://localhost/v1/responses", { headers: codexHeaders("another-account") }), "parent"], [new Request("http://localhost/v1/responses"), "parent"]] as const) {
    const input = encryptedInput();
    expect(restoreCachedEncryptedAgentTasks(request, input, config, { parentThreadId: parent })).toBe(0);
    expect(JSON.stringify(input)).toContain(FERNET_TASK);
  }
  expect(calls).toBe(1);
});

test("Responses handler restores a cached task in a continued child turn", async () => {
  const { post, providerResponse } = await import("../helpers/agent-task-recovery");
  let recoveries = 0;
  const bodies: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("chatgpt.com")) {
      recoveries++;
      return new Response(recoverySse("Read nonce.txt exactly."));
    }
    bodies.push(String(init?.body));
    return providerResponse();
  }) as typeof fetch;
  const config = routedConfig({ enabled: true });
  expect((await post(config, "xai/grok-4.5", encryptedInput(), codexHeaders())).status).toBe(200);
  expect((await post(config, "xai/grok-4.5", [...encryptedInput(), { type: "message", role: "user", content: "Continue the original task." }], codexHeaders())).status).toBe(200);
  expect(recoveries).toBe(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("Read nonce.txt exactly.");
  expect(bodies[1]).not.toContain(FERNET_TASK);
});

function encryptedMessage(): unknown[] {
  return JSON.parse(JSON.stringify(encryptedInput()).replace("Message Type: NEW_TASK", "Message Type: MESSAGE"));
}

test("MESSAGE recovery reaches the provider and survives tool-result replay", async () => {
  const { post, providerResponse } = await import("../helpers/agent-task-recovery");
  let recoveries = 0;
  const bodies: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("chatgpt.com")) {
      expect(String(init?.body)).toContain("Message Type: MESSAGE");
      recoveries++;
      return new Response(recoverySse("Stop waiting and report your result."));
    }
    bodies.push(String(init?.body));
    return providerResponse();
  }) as typeof fetch;
  const config = routedConfig({ enabled: true });
  expect((await post(config, "xai/grok-4.5", encryptedMessage(), codexHeaders())).status).toBe(200);
  expect((await post(config, "xai/grok-4.5", [...encryptedMessage(), {
    type: "message", role: "user", content: "Continue after the tool result.",
  }], codexHeaders())).status).toBe(200);
  expect(recoveries).toBe(1);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body).toContain("Stop waiting and report your result.");
    expect(body).not.toContain(FERNET_TASK);
  }
});

test("MESSAGE cache remains isolated by message type, account, parent and sender", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(recoverySse("Private message.")); }) as typeof fetch;
  const config = routedConfig({ enabled: true });
  const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
  expect(await recoverEncryptedAgentTask(req, encryptedMessage(), {}, config, { parentThreadId: "parent" })).toBe(true);
  expect(restoreCachedEncryptedAgentTasks(req, encryptedInput(), config, { parentThreadId: "parent" })).toBe(0);
  for (const [request, parent] of [[req, "other-parent"], [new Request("http://localhost/v1/responses", { headers: codexHeaders("other-account") }), "parent"]] as const) {
    expect(restoreCachedEncryptedAgentTasks(request, encryptedMessage(), config, { parentThreadId: parent })).toBe(0);
  }
  const malformed = JSON.parse(JSON.stringify(encryptedMessage()));
  malformed[0].author = "/root/wrong-sender";
  expect(await recoverEncryptedAgentTask(req, malformed, {}, config)).toBe(false);
  const unknown = JSON.parse(JSON.stringify(encryptedMessage()).replace("Message Type: MESSAGE", "Message Type: UNKNOWN"));
  expect(await recoverEncryptedAgentTask(req, unknown, {}, config)).toBe(false);
  expect(calls).toBe(1);
});


test("mixed history restores cached NEW_TASK and MESSAGE separately before recovering only the new tail", async () => {
  let calls = 0;
  const payloads = ["Initial assignment.", "First message.", "Second message."];
  globalThis.fetch = (async () => new Response(recoverySse(payloads[calls++]!))) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
  const config = routedConfig({ enabled: true });
  const scope = { parentThreadId: "parent" };
  const nextMessage = () => JSON.parse(JSON.stringify(encryptedMessage()).replace(FERNET_TASK, SECOND_FERNET_TASK));

  expect(await recoverEncryptedAgentTask(req, encryptedInput(), {}, config, scope)).toBe(true);
  expect(await recoverEncryptedAgentTask(req, encryptedMessage(), {}, config, scope)).toBe(true);
  const input = [...encryptedInput(), ...encryptedMessage(), ...nextMessage()];
  expect(restoreCachedEncryptedAgentTasks(req, input, config, scope)).toBe(2);
  expect(calls).toBe(2);
  expect(await recoverEncryptedAgentTask(req, input, {}, config, scope)).toBe(true);
  expect(calls).toBe(3);
  for (const payload of payloads) expect(JSON.stringify(input)).toContain(payload);
  expect(JSON.stringify(input)).not.toContain(SECOND_FERNET_TASK);

  const replay = [...encryptedInput(), ...encryptedMessage(), ...nextMessage(), {
    type: "function_call_output", call_id: "tool", output: "done",
  }];
  expect(restoreCachedEncryptedAgentTasks(req, replay, config, scope)).toBe(3);
  expect(calls).toBe(3);
});

test("Responses handler restores known history and recovers only the new MESSAGE tail", async () => {
  const { post, providerResponse } = await import("../helpers/agent-task-recovery");
  const assignments = ["Initial assignment.", "First message.", "Second message."];
  const recoveryBodies: string[] = [];
  const providerBodies: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const requestBody = String(init?.body);
    if (String(url).includes("chatgpt.com")) {
      recoveryBodies.push(requestBody);
      return new Response(recoverySse(assignments[recoveryBodies.length - 1] ?? "Unexpected extra recovery."));
    }
    providerBodies.push(requestBody);
    return providerResponse();
  }) as typeof fetch;
  const config = routedConfig({ enabled: true });
  const headers = codexHeaders();
  const nextMessage = () => JSON.parse(JSON.stringify(encryptedMessage()).replace(FERNET_TASK, SECOND_FERNET_TASK));
  const turns = [
    encryptedInput(),
    [...encryptedInput(), ...encryptedMessage()],
    [...encryptedInput(), ...encryptedMessage(), ...nextMessage()],
  ];

  for (const [index, input] of turns.entries()) {
    const response = await post(config, "xai/grok-4.5", input, headers);
    expect(response.status).toBe(200);
    await response.text();
    expect(recoveryBodies).toHaveLength(index + 1);
    expect(providerBodies).toHaveLength(index + 1);
    const sent = providerBodies[index]!;
    let previousPosition = -1;
    for (const assignment of assignments.slice(0, index + 1)) {
      const position = sent.indexOf(assignment);
      expect(position).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
    expect(sent).not.toContain(FERNET_TASK);
    expect(sent).not.toContain(SECOND_FERNET_TASK);
  }
  // Recovery may receive only the fresh tail, never a batch of cached history.
  expect(JSON.parse(recoveryBodies[2]!).input).toEqual(nextMessage());

  const response = await post(config, "xai/grok-4.5", [
    ...encryptedInput(), ...encryptedMessage(), ...nextMessage(),
    { type: "message", role: "user", content: "Continue with all three instructions." },
  ], headers);
  expect(response.status).toBe(200);
  await response.text();
  expect(recoveryBodies).toHaveLength(3);
  expect(providerBodies).toHaveLength(4);
  for (const assignment of assignments) expect(providerBodies[3]).toContain(assignment);
  expect(providerBodies[3]).toContain("Continue with all three instructions.");
  expect(providerBodies[3]).not.toContain(FERNET_TASK);
  expect(providerBodies[3]).not.toContain(SECOND_FERNET_TASK);
});

test("cached-history reparse preserves recorded final-answer scope without suppressing a user follow-up", async () => {
  const { post, providerResponse } = await import("../helpers/agent-task-recovery");
  const sessionId = `recovery-final-replay-${crypto.randomUUID()}`;
  const headers = codexHeaders("acct-caller", { session_id: sessionId });
  const config = routedConfig({ enabled: true });
  const deliveredAnswer = "The assignment is complete.";
  const recorded = parseRequest({ model: "xai/grok-4.5", input: "Earlier turn" });
  bindTurnTerminationScope(recorded, conversationIdFromResponsesRequest({ sessionIdHeader: sessionId }));
  rememberDeliveredFinalAnswer(recorded, { output: [{
    type: "message", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: deliveredAnswer }],
  }] });

  let recoveries = 0;
  const providerBodies: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("chatgpt.com")) {
      recoveries++;
      return new Response(recoverySse("Read the assignment."));
    }
    providerBodies.push(String(init?.body));
    return providerResponse();
  }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { headers });
  expect(await recoverEncryptedAgentTask(req, encryptedInput(), {}, config)).toBe(true);

  // Keep the ordinary transport fixture, but exercise Kiro's real pre-send termination hook.
  // The remembered record above belongs to a different parsed object: only core can bind
  // the new object produced by recovery reparse to the same conversation.
  const kiro = createKiroAdapter({ adapter: "kiro", baseUrl: "https://kiro.test", authMode: "key", apiKey: "synthetic-key" });
  const createChat = ADAPTER_REGISTRY["openai-chat"].create;
  const inspectedBodies: string[] = [];
  const factory = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((provider, context) => ({
    ...createChat(provider, context),
    localTerminal(parsed: OcxParsedRequest) {
      inspectedBodies.push(JSON.stringify(parsed._rawBody));
      return kiro.localTerminal?.(parsed);
    },
  }));
  const finalMessage = { type: "message", role: "assistant", content: [{ type: "output_text", text: deliveredAnswer }] };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(config, "xai/grok-4.5", [...encryptedInput(), finalMessage], headers);
      expect(response.status).toBe(200);
      expect((await response.json() as { output: unknown[] }).output).toEqual([]);
      expect(providerBodies).toHaveLength(0);
    }
    const followUp = await post(config, "xai/grok-4.5", [
      ...encryptedInput(), finalMessage,
      { type: "message", role: "user", content: "Now explain your result." },
    ], headers);
    expect(followUp.status).toBe(200);
    await followUp.text();
    expect(providerBodies).toHaveLength(1);
    expect(providerBodies[0]).toContain("Now explain your result.");
    expect(inspectedBodies).toHaveLength(3);
    for (const inspected of inspectedBodies) {
      expect(inspected).toContain("Read the assignment.");
      expect(inspected).not.toContain(FERNET_TASK);
    }
    expect(recoveries).toBe(1);
  } finally {
    factory.mockRestore();
  }
});

test("fresh recovery only handles the current tail, leaving uncached history unchanged", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(recoverySse("Current message.")); }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { headers: codexHeaders() });
  const config = routedConfig({ enabled: true });
  const historical = encryptedInput();
  const input = [...historical, ...encryptedMessage()];
  expect(await recoverEncryptedAgentTask(req, input, {}, config)).toBe(true);
  expect(input[0]).toEqual(encryptedInput()[0]);
  expect(JSON.stringify(input[1])).toContain("Current message.");
  expect(calls).toBe(1);
});
