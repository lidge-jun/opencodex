import { afterEach, expect, test } from "bun:test";
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
