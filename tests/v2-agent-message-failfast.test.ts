import { afterEach, describe, expect, test } from "bun:test";
import {
  handleResponses,
  hasUnreadableEncryptedAgentTask,
} from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

/**
 * Structurally faithful Fernet fixture: version + timestamp + IV + one AES-CBC
 * block + HMAC. Bytes are synthetic, so this validates wire shape without
 * publishing a real captured task or claiming the HMAC is authentic.
 */
function fernetFixture(ciphertextBytes = 16, version = 0x80): string {
  const raw = Buffer.alloc(57 + ciphertextBytes, 0x5a);
  raw[0] = version;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

const FERNET_TASK = fernetFixture();
const TOO_SHORT_FERNET = `gAAAA${"A".repeat(60)}`;
const INVALID_BLOCK_FERNET = fernetFixture(17);
const INVALID_VERSION_FERNET = fernetFixture(16, 0x81);
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

function agentMessage(content: Array<Record<string, unknown>>): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content,
  }];
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

function mixedComboConfig(): OcxConfig {
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
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
    combos: {
      mixed: {
        strategy: "failover",
        targets: [
          { provider: "xai", model: "grok-4.5" },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    },
  } as OcxConfig;
}

async function post(
  config: OcxConfig,
  model: string,
  input: unknown[],
  headers: HeadersInit = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify({ model, input, stream: false }),
  }), config, { model: "", provider: "" });
}

describe("V2 routed agent-message ciphertext guard", () => {
  test("blocks a pure Fernet-only agent task", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(true);
  });

  test("blocks a routing envelope followed only by a Fernet task", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(true);
  });

  test("blocks a control preamble mixed into the Fernet slot before sanitization", async () => {
    const input = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      {
        type: "encrypted_content",
        encrypted_content: `[CXC-LEAF-GUARD] follow the worker boundary.\n\n${FERNET_TASK}`,
      },
    ]);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("provider dispatch must not happen");
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", input);
    const raw = await response.text();
    const json = JSON.parse(raw) as {
      error?: { type?: string; code?: string; message?: string };
    };

    expect(response.status).toBe(400);
    expect(json.error).toMatchObject({
      type: "invalid_request_error",
      code: "unreadable_encrypted_agent_task",
    });
    expect(json.error?.message).toContain("encrypted");
    expect(fetchCalls).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("gAAAA");
  });

  test("filters a combo to a decrypt-capable native target before dispatch", async () => {
    const fetchedUrls: string[] = [];
    let forwardedBody = "";
    globalThis.fetch = (async (input, init) => {
      fetchedUrls.push(String(input));
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        id: "resp_combo_native",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await post(
      mixedComboConfig(),
      "combo/mixed",
      agentMessage([
        { type: "input_text", text: ROUTING_ENVELOPE },
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ]),
      { authorization: "Bearer caller-codex-token" },
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(fetchedUrls[0]).not.toContain("api.x.ai");
    expect(forwardedBody).toContain(FERNET_TASK);
  });

  test("returns the machine-readable guard error when a combo has no native target", async () => {
    const config = mixedComboConfig();
    config.combos!.mixed!.targets = [{ provider: "xai", model: "grok-4.5" }];
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("provider dispatch must not happen");
    }) as typeof fetch;

    const response = await post(config, "combo/mixed", agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "unreadable_encrypted_agent_task",
      },
    });
    expect(fetchCalls).toBe(0);
  });

  test("keeps encrypted combo failover on native targets after a native failure", async () => {
    const config = mixedComboConfig();
    config.providers["openai-backup"] = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      codexAccountMode: "direct",
    };
    config.combos!.mixed!.targets = [
      { provider: "xai", model: "grok-primary" },
      { provider: "openai", model: "gpt-native-primary" },
      { provider: "xai", model: "grok-secondary" },
      { provider: "openai-backup", model: "gpt-native-backup" },
    ];
    const forwardedModels: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      forwardedBodies.push(raw);
      const parsed = JSON.parse(raw) as { model?: string };
      forwardedModels.push(parsed.model ?? "");
      if (forwardedModels.length === 1) {
        return Response.json({ error: { message: "native target rejected this request" } }, { status: 403 });
      }
      return Response.json({
        id: "resp_combo_native_backup",
        object: "response",
        status: "completed",
        model: "gpt-native-backup",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await post(
      config,
      "combo/mixed",
      agentMessage([
        { type: "input_text", text: ROUTING_ENVELOPE },
        { type: "encrypted_content", encrypted_content: FERNET_TASK },
      ]),
      { authorization: "Bearer caller-codex-token" },
    );

    expect(response.status).toBe(200);
    expect(forwardedModels).toEqual(["gpt-native-primary", "gpt-native-backup"]);
    expect(forwardedBodies).toHaveLength(2);
    expect(forwardedBodies.every(body => body.includes(FERNET_TASK))).toBe(true);
  });

  test("blocks an exact routing envelope and Fernet task inside one mixed slot", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([{
      type: "encrypted_content",
      encrypted_content: `${ROUTING_ENVELOPE.trimEnd()}${FERNET_TASK}`,
    }]))).toBe(true);
  });

  test("blocks repeated and future CXC control paragraphs", () => {
    for (const preamble of [
      "[CXC-LEAF-GUARD] stay in scope.\n\n[CXC-SKILL-AFFORDANCE] use only declared tools.",
      "[CXC-RATE-GUARD] provider compatibility metadata.",
    ]) {
      expect(hasUnreadableEncryptedAgentTask(agentMessage([
        { type: "input_text", text: ROUTING_ENVELOPE },
        {
          type: "encrypted_content",
          encrypted_content: `${preamble}\n\n${FERNET_TASK}`,
        },
      ]))).toBe(true);
    }
  });

  test("allows genuine task text after a CXC control paragraph", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      {
        type: "encrypted_content",
        encrypted_content: `[CXC-LEAF-GUARD] follow the worker boundary.\n\n${FERNET_TASK}`,
      },
      { type: "input_text", text: "Implement the focused regression test." },
    ]))).toBe(false);
  });

  test("allows a readable payload after CXC metadata and the routing envelope", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      {
        type: "encrypted_content",
        encrypted_content: `[CXC-LEAF-GUARD] follow the worker boundary.\n${ROUTING_ENVELOPE}Implement the focused regression test.\n${FERNET_TASK}`,
      },
    ]))).toBe(false);
  });

  test("allows genuine readable task text after the envelope", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      {
        type: "input_text",
        text: `${ROUTING_ENVELOPE}Implement the focused regression test.`,
      },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(false);
  });

  test("ignores encrypted reasoning and compaction items", () => {
    expect(hasUnreadableEncryptedAgentTask([
      { type: "reasoning", encrypted_content: FERNET_TASK, summary: [] },
      { type: "compaction", encrypted_content: FERNET_TASK },
    ])).toBe(false);
  });

  test("allows meaningful plaintext before the exact codex-rs routing envelope", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      {
        type: "input_text",
        text: `Implement the requested fix.\n${ROUTING_ENVELOPE}`,
      },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(false);
  });

  test("allows a readable payload on the same line as the marker", () => {
    const sameLinePayload = ROUTING_ENVELOPE.replace(
      "Payload:\n",
      "Payload: Implement the focused regression test.\n",
    );
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      { type: "input_text", text: sameLinePayload },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(false);
  });

  test("does not mistake structurally impossible Fernet-like runs for backend tasks", () => {
    for (const invalid of [
      TOO_SHORT_FERNET,
      INVALID_BLOCK_FERNET,
      INVALID_VERSION_FERNET,
      FERNET_TASK.slice(0, -1),
      FERNET_TASK.replace(/=+$/, ""),
      `x${FERNET_TASK}`,
    ]) {
      expect(hasUnreadableEncryptedAgentTask(agentMessage([
        { type: "input_text", text: ROUTING_ENVELOPE },
        { type: "encrypted_content", encrypted_content: invalid },
      ]))).toBe(false);
    }
  });

  test("does not count output-only text that the routed input parser drops", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      { type: "output_text", text: "not provider-readable on an input item" },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(true);
  });

  test("classifies only trailing current agent messages, not encrypted history", () => {
    const encryptedHistory = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ])[0];
    const readableCurrent = agentMessage([
      { type: "input_text", text: "Current readable task." },
    ])[0];

    expect(hasUnreadableEncryptedAgentTask([
      encryptedHistory,
      readableCurrent,
    ])).toBe(false);
    expect(hasUnreadableEncryptedAgentTask([
      encryptedHistory,
      { type: "message", role: "assistant", content: "history boundary" },
      readableCurrent,
    ])).toBe(false);
    expect(hasUnreadableEncryptedAgentTask([
      encryptedHistory,
      { type: "message", role: "user", content: "Current readable turn." },
    ])).toBe(false);
  });

  test("still blocks an unreadable current task after readable history", () => {
    const unreadableCurrent = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ])[0];
    for (const trailingMetadata of [
      { type: "compaction_trigger" },
      { type: "additional_tools", tools: [] },
    ]) {
      expect(hasUnreadableEncryptedAgentTask([
        { type: "message", role: "user", content: "old readable turn" },
        unreadableCurrent,
        trailingMetadata,
      ])).toBe(true);
    }
  });

  test("treats string content as plaintext, not as an encrypted-content slot", () => {
    // codex-rs AgentMessageInputContent is an array union. A loose string shape is
    // accepted by the proxy parser as readable text, so it must not trigger this guard.
    expect(hasUnreadableEncryptedAgentTask([{
      type: "agent_message",
      content: FERNET_TASK,
    }])).toBe(false);
  });

  test("allows the canonical ChatGPT route to forward the encrypted task", async () => {
    let forwardedBody = "";
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        id: "resp_native",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const input = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]);
    const response = await post(nativeConfig(), "gpt-5.5", input, {
      authorization: "Bearer caller-codex-token",
    });

    expect(response.status).toBe(200);
    expect(forwardedBody).toContain(FERNET_TASK);
  });
});
