import { handleResponses } from "../../src/server/responses";
import type { TranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";

export const originalFetch = globalThis.fetch;

export function fakeChatGptJwt(accountId: string, claimOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({
    alg: "RS256",
    typ: "JWT",
    kid: "fixture-key",
  })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://auth.openai.com/",
    aud: "https://api.openai.com/v1",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    exp: Math.floor(Date.now() / 1000) + 3_600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    ...claimOverrides,
  })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

function fernetFixture(ciphertextBytes = 16, version = 0x80, fill = 0x5a): string {
  const raw = Buffer.alloc(57 + ciphertextBytes, fill);
  raw[0] = version;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

export const FERNET_TASK = fernetFixture();
export const SECOND_FERNET_TASK = fernetFixture(16, 0x80, 0x4b);

function routingEnvelope(
  taskName = "/root/worker",
  sender = "/root",
): string {
  return [
    "Message Type: NEW_TASK",
    `Task name: ${taskName}`,
    `Sender: ${sender}`,
    "Payload:",
    "",
  ].join("\n");
}

export const ROUTING_ENVELOPE = routingEnvelope();

export function agentMessage(content: Array<Record<string, unknown>>): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content,
  }];
}

export function routedConfig(
  recovery: OcxConfig["agentTaskRecovery"] | null = { enabled: true },
): OcxConfig {
  const config = {
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
  } as OcxConfig;
  if (recovery !== null) config.agentTaskRecovery = recovery;
  return config;
}

export function codexHeaders(accountId = "acct-caller", extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${fakeChatGptJwt(accountId)}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "codex_cli_rs");
  headers.set("x-openai-subagent", "collab_spawn");
  return headers;
}

export function recoverySse(assignment: string): string {
  const payload = JSON.stringify({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "capture_assignment",
      arguments: JSON.stringify({ assignment }),
    },
  });
  return `data: ${payload}\n\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { status: "completed", output: [] },
  })}\n\n`;
}

export function recoveryArgumentsDoneSse(assignment: string): string {
  return `data: ${JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "capture_assignment",
    arguments: JSON.stringify({ assignment }),
  })}\n\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { status: "completed", output: [] },
  })}\n\n`;
}

export function recoveryCompletedSse(assignment: string): string {
  return `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      status: "completed",
      output: [{
        type: "function_call",
        name: "capture_assignment",
        arguments: JSON.stringify({ assignment }),
      }],
    },
  })}\n\n`;
}

export function providerResponse(): Response {
  return Response.json({
    id: "resp_routed",
    object: "response",
    status: "completed",
    model: "grok-4.5",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

export async function post(
  config: OcxConfig,
  model: string,
  input: unknown[],
  headers: HeadersInit = {},
  abortSignal?: AbortSignal,
  options: { tools?: unknown[]; translatorBudget?: TranslatorBudget } = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify({ model, input, stream: false, ...(options.tools ? { tools: options.tools } : {}) }),
  }), config, { model: "", provider: "" }, { abortSignal, translatorBudget: options.translatorBudget });
}

export function encryptedInput(options: {
  ciphertext?: string;
  taskName?: string;
  sender?: string;
} = {}): unknown[] {
  const taskName = options.taskName ?? "/root/worker";
  const sender = options.sender ?? "/root";
  return [{
    type: "agent_message",
    author: sender,
    recipient: taskName,
    content: [
      { type: "input_text", text: routingEnvelope(taskName, sender) },
      { type: "encrypted_content", encrypted_content: options.ciphertext ?? FERNET_TASK },
    ],
  }];
}
