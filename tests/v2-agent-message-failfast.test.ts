import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses, hasUnreadableEncryptedAgentTask, sanitizeEncryptedContentInPlace } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const FERNET_TASK = `gAAAA${"Ab1_-".repeat(20)}==`;
const ROUTING_ENVELOPE = [
  "Message Type: NEW_TASK",
  "Task name: /root/worker",
  "Sender: /root",
  "Payload:",
  "",
].join("\n");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function workerInput(extraContent: Array<Record<string, unknown>> = []): unknown[] {
  return [
    {
      type: "agent_message",
      author: "/root",
      recipient: "/root/worker",
      content: [
        { type: "input_text", text: ROUTING_ENVELOPE },
        ...extraContent,
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ],
    },
  ];
}

function routedConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
    },
  } as OcxConfig;
}

function nativeConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

async function post(config: OcxConfig, model: string, input: unknown[], headers: HeadersInit = {}): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify({ model, input, stream: false }),
  }), config, { model: "", provider: "" });
}

describe("V2 routed agent-message ciphertext guard", () => {
  test("recognizes Fernet-only task delivery but ignores readable and unrelated encrypted content", () => {
    expect(hasUnreadableEncryptedAgentTask(workerInput())).toBe(true);
    expect(hasUnreadableEncryptedAgentTask([{
      type: "agent_message",
      content: [
        { type: "input_text", text: `[CXC-LEAF-GUARD] obey the worker boundary.\n${ROUTING_ENVELOPE}` },
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ],
    }])).toBe(true);
    expect(hasUnreadableEncryptedAgentTask(workerInput([
      { type: "input_text", text: "Implement the focused regression test." },
    ]))).toBe(false);
    expect(hasUnreadableEncryptedAgentTask([
      { type: "reasoning", encrypted_content: FERNET_TASK, summary: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ])).toBe(false);
  });

  test("plaintext parked in the encrypted slot still follows the compatibility sanitizer", () => {
    const input = [{
      type: "agent_message",
      content: [
        { type: "input_text", text: ROUTING_ENVELOPE },
        { type: "encrypted_content", encrypted_content: "Build the requested artifact." },
      ],
    }];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    expect(hasUnreadableEncryptedAgentTask(input)).toBe(false);
    expect(input[0]).toMatchObject({ type: "message", role: "user" });
  });

  test("routed Fernet-only task fails as a non-retryable 400 before provider dispatch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("provider dispatch must not happen");
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", workerInput());
    const raw = await response.text();
    const json = JSON.parse(raw) as { error?: { type?: string; code?: string; message?: string } };
    expect(response.status).toBe(400);
    expect(json.error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    expect(json.error?.message).toContain("plaintext V2 agent-message delivery");
    expect(fetchCalls).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("gAAAA");
  });

  test("native ChatGPT route keeps the ciphertext for backend decryption", async () => {
    let forwardedBody = "";
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({
        id: "resp_native",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const response = await post(nativeConfig(), "gpt-5.5", workerInput(), {
      authorization: "Bearer caller-codex-token",
    });
    expect(response.status).toBe(200);
    expect(forwardedBody).toContain(FERNET_TASK);
  });
});
