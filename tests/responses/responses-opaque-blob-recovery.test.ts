import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { OPAQUE_COMPACTION_NOTE } from "../../src/responses/compaction";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import * as authContextModule from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  handleResponses,
  shouldAttemptOpaqueBlobRecovery,
} from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { markBodyNonPersistable, rememberResponseState, previousResponseProviderState } from "../../src/responses/state";

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const BLOB = "provider-minted-opaque-state";
// Synthetic Fernet-shaped data must survive the outbound ciphertext shape gate.
const FUNCTION_OUTPUT_BLOB = `g${"A".repeat(127)}`;
const FUNCTION_OUTPUT_DECRYPT_MESSAGE = "Encrypted function output content could not be decrypted or decoded.";
const OPENAI_BLOB_ERROR = JSON.stringify({
  error: {
    message: "The encrypted content could not be verified.",
    type: "invalid_request_error",
    code: "invalid_encrypted_content",
  },
});
const CHATGPT_UNVERIFIABLE_BLOB_ERROR = JSON.stringify({
  error: {
    message: "The encrypted content 6871-test-ef-0 could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    type: "invalid_request_error",
    param: "input",
    code: null,
  },
});
const CHATGPT_FUNCTION_OUTPUT_DECRYPT_ERROR = JSON.stringify({
  error: {
    message: FUNCTION_OUTPUT_DECRYPT_MESSAGE,
    type: "server_error",
    code: null,
  },
});
const XAI_DECODE_ERROR = JSON.stringify({
  code: "invalid-argument",
  error: "Could not decode the compaction blob: invalid payload",
});
const XAI_DECRYPT_ERROR = JSON.stringify({
  code: "invalid-argument",
  error: "Could not decrypt the provided encrypted_content: invalid payload",
});

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-opaque-blob-recovery-"));
  process.env.OPENCODEX_HOME = testDir;
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  removeTreeWithRetry(testDir);
});

function reasoningReplayInput(): Array<Record<string, unknown>> {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "before" }],
    },
    {
      type: "reasoning",
      content: [],
      summary: [{ type: "summary_text", text: "prior reasoning" }],
      encrypted_content: BLOB,
      status: "completed",
    },
    {
      type: "compaction",
      encrypted_content: BLOB,
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "after" }],
    },
  ];
}

function serializedOutboundWithBlob(): string {
  return JSON.stringify({ model: "model-a", input: reasoningReplayInput() });
}

function functionOutputReplayInput(): Array<Record<string, unknown>> {
  return [
    {
      type: "function_call",
      call_id: "call-encrypted-output",
      name: "browser_capture",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call-encrypted-output",
      output: [
        { type: "encrypted_content", encrypted_content: FUNCTION_OUTPUT_BLOB },
        { type: "input_text", text: "visible tool output" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    },
  ];
}

function serializedOutboundWithEncryptedFunctionOutput(): string {
  return JSON.stringify({ model: "model-a", input: functionOutputReplayInput() });
}

function agentMessageReplayInput(): Array<Record<string, unknown>> {
  return [
    {
      type: "agent_message",
      author: "/root/child_task",
      recipient: "/root",
      content: [
        { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/child_task\nPayload:" },
        { type: "encrypted_content", encrypted_content: FUNCTION_OUTPUT_BLOB },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    },
  ];
}

function serializedOutboundWithEncryptedAgentMessage(): string {
  return JSON.stringify({ model: "model-a", input: agentMessageReplayInput() });
}

function config(): OcxConfig {
  return {
    defaultProvider: "first",
    providers: {
      first: {
        adapter: "openai-responses",
        baseUrl: "https://first.example.test/v1",
        authMode: "key",
        apiKey: "first-test-key",
        decodesNativeCompactionBlobs: true,
      },
      second: {
        adapter: "openai-responses",
        baseUrl: "https://second.example.test/v1",
        authMode: "key",
        apiKey: "second-test-key",
      },
    },
  } as OcxConfig;
}

function request(provider = "first", threadId = "thread-opaque-recovery"): Request {
  return requestWithIdentityHeaders(provider, {
    "x-codex-parent-thread-id": threadId,
  });
}

function requestWithIdentityHeaders(
  provider = "first",
  identityHeaders: Record<string, string> = {},
): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...identityHeaders,
    },
    body: JSON.stringify({
      model: `${provider}/model-a`,
      stream: false,
      store: false,
      input: reasoningReplayInput(),
    }),
  });
}

function functionOutputRequest(stream = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "thread-encrypted-function-output",
    },
    body: JSON.stringify({
      model: "first/model-a",
      stream,
      store: false,
      input: functionOutputReplayInput(),
    }),
  });
}

function agentMessageRequest(stream = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "thread-encrypted-agent-message",
    },
    body: JSON.stringify({
      model: "first/model-a",
      stream,
      store: false,
      input: agentMessageReplayInput(),
    }),
  });
}

function decryptStreamResponse(wire: string, contentType: string | null): Response {
  // A string body would implicitly add text/plain even when headers are omitted.
  const response = new Response(new TextEncoder().encode(wire), {
    status: 200,
    ...(contentType === null ? {} : { headers: { "content-type": contentType } }),
  });
  expect(response.headers.get("content-type")).toBe(contentType);
  return response;
}

function streamedFunctionOutputDecryptFailure(contentType: string | null = "text/event-stream"): Response {
  const failed = {
    type: "response.failed",
    response: {
      id: "resp-function-output-failed",
      status: "failed",
      error: {
        message: FUNCTION_OUTPUT_DECRYPT_MESSAGE,
        type: "server_error",
        code: "upstream_server_error",
      },
    },
  };
  return decryptStreamResponse(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\ndata: [DONE]\n\n`, contentType);
}

// The observed ChatGPT production shape: response.created, then a bare error
// event carrying the decryption rejection, then EOF with no terminal event.
function streamedFunctionOutputDecryptErrorEvent(
  flat = false,
  contentType: string | null = "text/event-stream",
): Response {
  const created = {
    type: "response.created",
    response: { id: "resp-function-output-error-event", status: "in_progress" },
  };
  const error = {
    type: "server_error",
    code: "upstream_server_error",
    message: FUNCTION_OUTPUT_DECRYPT_MESSAGE,
  };
  const errorEvent = flat ? { ...error, type: "error" } : {
    type: "error",
    error,
  };
  return decryptStreamResponse(
    `event: response.created\ndata: ${JSON.stringify(created)}\n\nevent: error\ndata: ${JSON.stringify(errorEvent)}\n\n`,
    contentType,
  );
}

function streamedSuccess(id: string): Response {
  const completed = {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      model: "model-a",
      output: [],
    },
  };
  return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function rejection(body = OPENAI_BLOB_ERROR): Response {
  return new Response(body, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function success(id: string): Response {
  return Response.json({
    id,
    object: "response",
    status: "completed",
    model: "model-a",
    output: [],
  });
}

function hasBlob(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes(BLOB);
}

describe("opaque blob recovery trigger", () => {
  const base = {
    status: 400,
    adapterName: "openai-responses",
    outboundBody: serializedOutboundWithBlob(),
    errorBody: OPENAI_BLOB_ERROR,
    alreadyAttempted: false,
  };

  test("accepts OpenAI and both xAI opaque-state rejection identities", () => {
    expect(shouldAttemptOpaqueBlobRecovery(base)).toBe(true);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      errorBody: CHATGPT_UNVERIFIABLE_BLOB_ERROR,
    })).toBe(true);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, errorBody: XAI_DECODE_ERROR })).toBe(true);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, errorBody: XAI_DECRYPT_ERROR })).toBe(true);
  });

  test("rejects unrelated errors, 5xx, blobless sends, non-Responses adapters, and repeats", () => {
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      errorBody: JSON.stringify({
        error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter" },
      }),
    })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, status: 500 })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      outboundBody: JSON.stringify({ model: "model-a", input: [{ type: "message", role: "user" }] }),
    })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, adapterName: "openai-chat" })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, alreadyAttempted: true })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      errorBody: JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: null,
          message: "The encrypted content 6871-test-ef-0 could not be verified. Reason: Signature expired.",
        },
      }),
    })).toBe(false);
  });

  test("accepts the exact ChatGPT 502 rejection only when function output carries encrypted content", () => {
    const base = {
      status: 502,
      adapterName: "openai-responses",
      outboundBody: serializedOutboundWithEncryptedFunctionOutput(),
      errorBody: CHATGPT_FUNCTION_OUTPUT_DECRYPT_ERROR,
      alreadyAttempted: false,
    };

    expect(shouldAttemptOpaqueBlobRecovery(base)).toBe(true);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, status: 500 })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      errorBody: JSON.stringify({ error: { message: "Bad gateway" } }),
    })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      outboundBody: JSON.stringify({ model: "model-a", input: [{ type: "message", role: "user" }] }),
    })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...base, alreadyAttempted: true })).toBe(false);
  });

  test("accepts the exact ChatGPT 502 rejection when an agent_message content part carries encrypted content", () => {
    const base = {
      status: 502,
      adapterName: "openai-responses",
      outboundBody: serializedOutboundWithEncryptedAgentMessage(),
      errorBody: CHATGPT_FUNCTION_OUTPUT_DECRYPT_ERROR,
      alreadyAttempted: false,
    };

    expect(shouldAttemptOpaqueBlobRecovery(base)).toBe(true);
    expect(shouldAttemptOpaqueBlobRecovery({
      ...base,
      outboundBody: JSON.stringify({
        model: "model-a",
        input: [{ type: "agent_message", content: [{ type: "input_text", text: "plain" }] }],
      }),
    })).toBe(false);
  });
});

describe("opaque blob recovery through /v1/responses", () => {
  test("recovers a zero-output streamed function-output decrypt failure before client relay", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? streamedFunctionOutputDecryptFailure()
        : streamedSuccess("resp-stream-function-output-recovered");
    }) as typeof fetch;

    const response = await handleResponses(functionOutputRequest(true), config(), { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(outbound).toHaveLength(2);
    const retriedInput = outbound.at(1)?.input as Array<Record<string, unknown>> | undefined;
    expect(retriedInput?.at(1)).toEqual({
      type: "function_call_output",
      call_id: "call-encrypted-output",
      output: [
        { type: "input_text", text: "[encrypted content omitted]" },
        { type: "input_text", text: "visible tool output" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
      ],
    });
  });

  test("retries a ChatGPT function-output decrypt failure once with an omission marker", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length <= 3
        ? new Response(CHATGPT_FUNCTION_OUTPUT_DECRYPT_ERROR, {
          status: 502,
          headers: { "content-type": "application/json" },
        })
        : success("resp-function-output-recovered");
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(functionOutputRequest(), config(), logCtx);
    expect(response.status).toBe(200);
    await response.text();

    expect(outbound).toHaveLength(4);
    const firstInput = outbound.at(0)?.input as Array<Record<string, unknown>> | undefined;
    const retriedInput = outbound.at(3)?.input as Array<Record<string, unknown>> | undefined;
    expect(firstInput?.at(1)).toEqual(functionOutputReplayInput().at(1));
    expect(retriedInput?.at(0)).toEqual(functionOutputReplayInput().at(0));
    expect(retriedInput?.at(1)).toEqual({
      type: "function_call_output",
      call_id: "call-encrypted-output",
      output: [
        { type: "input_text", text: "[encrypted content omitted]" },
        { type: "input_text", text: "visible tool output" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
      ],
    });
    expect(retriedInput?.at(2)).toEqual(functionOutputReplayInput().at(2));
    expect(logCtx.activeAttempt?.sendCount).toBe(4);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["transient-5xx", "opaque-blob-rejection"]);
  });

  test("surfaces a repeated function-output decrypt rejection after one sanitized rebuild", async () => {
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CHATGPT_FUNCTION_OUTPUT_DECRYPT_ERROR, {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const response = await handleResponses(functionOutputRequest(), config(), logCtx);
    expect(response.status).toBe(502);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toBe(FUNCTION_OUTPUT_DECRYPT_MESSAGE);

    expect(outbound).toHaveLength(6);
    const initialInput = outbound.at(0)?.input as Array<Record<string, unknown>> | undefined;
    const finalInput = outbound.at(-1)?.input as Array<Record<string, unknown>> | undefined;
    expect(initialInput?.at(1)).toEqual(functionOutputReplayInput().at(1));
    expect(finalInput?.at(1)).toEqual({
      type: "function_call_output",
      call_id: "call-encrypted-output",
      output: [
        { type: "input_text", text: "[encrypted content omitted]" },
        { type: "input_text", text: "visible tool output" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
      ],
    });
  });

  test("keeps a repeated streamed function-output rejection visible after one sanitized rebuild", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamedFunctionOutputDecryptFailure();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(functionOutputRequest(true), config(), logCtx);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("response.failed");
    expect(body).toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(logCtx.upstreamError).toBe(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(outbound).toHaveLength(2);
    const finalInput = outbound.at(1)?.input as Array<Record<string, unknown>> | undefined;
    expect(finalInput?.at(1)).toEqual({
      type: "function_call_output",
      call_id: "call-encrypted-output",
      output: [
        { type: "input_text", text: "[encrypted content omitted]" },
        { type: "input_text", text: "visible tool output" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
      ],
    });
  });

  test("retries a ChatGPT agent-message decrypt failure once with an omission marker", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length <= 3
        ? new Response(CHATGPT_FUNCTION_OUTPUT_DECRYPT_ERROR, {
          status: 502,
          headers: { "content-type": "application/json" },
        })
        : success("resp-agent-message-recovered");
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(agentMessageRequest(), config(), logCtx);
    expect(response.status).toBe(200);
    await response.text();

    expect(outbound).toHaveLength(4);
    const retriedInput = outbound.at(3)?.input as Array<Record<string, unknown>> | undefined;
    expect(retriedInput?.at(0)).toEqual({
      type: "agent_message",
      author: "/root/child_task",
      recipient: "/root",
      content: [
        { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/child_task\nPayload:" },
        { type: "input_text", text: "[encrypted content omitted]" },
      ],
    });
    expect(retriedInput?.at(1)).toEqual(agentMessageReplayInput().at(1));
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["transient-5xx", "opaque-blob-rejection"]);
  });

  test("recovers a zero-output streamed agent-message decrypt failure before client relay", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? streamedFunctionOutputDecryptFailure()
        : streamedSuccess("resp-stream-agent-message-recovered");
    }) as typeof fetch;

    const response = await handleResponses(agentMessageRequest(true), config(), { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(outbound).toHaveLength(2);
    const retriedInput = outbound.at(1)?.input as Array<Record<string, unknown>> | undefined;
    expect(retriedInput?.at(0)).toEqual({
      type: "agent_message",
      author: "/root/child_task",
      recipient: "/root",
      content: [
        { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/child_task\nPayload:" },
        { type: "input_text", text: "[encrypted content omitted]" },
      ],
    });
  });

  test("recovers a zero-output error-event decrypt failure before client relay", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? streamedFunctionOutputDecryptErrorEvent()
        : streamedSuccess("resp-stream-error-event-recovered");
    }) as typeof fetch;

    const response = await handleResponses(agentMessageRequest(true), config(), { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(outbound).toHaveLength(2);
    const retriedInput = outbound.at(1)?.input as Array<Record<string, unknown>> | undefined;
    expect(retriedInput?.at(0)).toEqual({
      type: "agent_message",
      author: "/root/child_task",
      recipient: "/root",
      content: [
        { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/child_task\nPayload:" },
        { type: "input_text", text: "[encrypted content omitted]" },
      ],
    });
  });

  for (const streamMode of ["legacy-tee", "eager-relay"] as const) {
    test(`preserves non-decrypt failed SSE with encrypted history (${streamMode})`, async () => {
      const failed = { type: "response.failed", response: {
        id: "resp-other-failure", status: "failed", output: [],
        error: { type: "server_error", code: "unrelated_failure", message: "Other upstream failure" },
      } };
      const wire = `event: response.failed\ndata: ${JSON.stringify(failed)}\n\ndata: [DONE]\n\n`;
      let sends = 0;
      globalThis.fetch = Object.assign(async () => {
        sends += 1;
        return new Response(wire, { headers: { "content-type": "text/event-stream" } });
      }, { preconnect: originalFetch.preconnect });
      const response = await handleResponses(agentMessageRequest(true), {
        ...config(), streamMode,
      }, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(await response.text()).toBe(wire);
      expect(sends).toBe(1);
    });

    for (const flat of [false, true]) {
      test(`repeated bare decrypt errors terminate as failed (${streamMode}, flat=${flat})`, async () => {
        let sends = 0;
        globalThis.fetch = Object.assign(async () => {
          sends += 1;
          return streamedFunctionOutputDecryptErrorEvent(flat);
        }, { preconnect: originalFetch.preconnect });
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const terminals: string[] = [];
        let markTerminal!: () => void;
        const terminal = new Promise<void>(resolve => { markTerminal = resolve; });
        const response = await handleResponses(agentMessageRequest(true), {
          ...config(), streamMode,
        }, logCtx, { onNativePassthroughTerminal: status => {
          terminals.push(status);
          markTerminal();
        } });
        const body = await response.text();
        await terminal;
        expect(terminals).toEqual(["failed"]);
        expect(logCtx.activeAttempt).toBeDefined();
        expect(logCtx.activeAttempt?.streamAborted).not.toBe(true);
        expect(sends).toBe(2);
        expect(body).toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
        expect(body).not.toContain("adapter_eof");
        expect(body.match(/^event: response.failed$/gm)).toHaveLength(1);
        expect(body.match(/^data: \[DONE\]$/gm)).toHaveLength(1);
      });
    }
  }

  test("recovers a flat error event once and preserves the marked raw body identity", async () => {
    const definition = ADAPTER_REGISTRY["openai-responses"];
    const originalCreate = definition.create;
    const rawBodies: unknown[] = [];
    const createSpy = spyOn(definition, "create").mockImplementation((provider, context) => {
      const adapter = originalCreate(provider, context);
      const buildRequest = adapter.buildRequest.bind(adapter);
      adapter.buildRequest = (parsed, incoming) => {
        rawBodies.push(parsed._rawBody);
        if (rawBodies.length === 1) markBodyNonPersistable(parsed._rawBody);
        return buildRequest(parsed, incoming);
      };
      return adapter;
    });
    let sends = 0;
    globalThis.fetch = Object.assign(async () => {
      sends += 1;
      return sends === 1 ? streamedFunctionOutputDecryptErrorEvent(true) : streamedSuccess("resp-identity");
    }, { preconnect: originalFetch.preconnect });
    try {
      const response = await handleResponses(agentMessageRequest(true), config(), { model: "", provider: "" });
      const body = await response.text();
      expect(body).toContain("response.completed");
      expect(body).not.toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
      expect(sends).toBe(2);
      expect(rawBodies).toHaveLength(2);
      expect(rawBodies[1]).toBe(rawBodies[0]);
      rememberResponseState(rawBodies[1], { id: "resp-marked-identity", status: "completed", output: [] },
        { cursor: { conversationId: "must-not-persist" } }, { force: true });
      expect(previousResponseProviderState("resp-marked-identity")).toBeUndefined();
    } finally {
      createSpy.mockRestore();
    }
  });

  test("recovers a missing-Content-Type streamed function-output decrypt failure before client relay", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? streamedFunctionOutputDecryptFailure(null)
        : streamedSuccess("resp-missing-ct-function-output-recovered");
    }) as typeof fetch;

    const response = await handleResponses(functionOutputRequest(true), config(), { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(outbound).toHaveLength(2);
    const retriedInput = outbound.at(1)?.input as Array<Record<string, unknown>> | undefined;
    expect(retriedInput?.at(1)).toEqual({
      type: "function_call_output",
      call_id: "call-encrypted-output",
      output: [
        { type: "input_text", text: "[encrypted content omitted]" },
        { type: "input_text", text: "visible tool output" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
      ],
    });
  });

  test("recovers a missing-Content-Type error-event decrypt failure before client relay", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? streamedFunctionOutputDecryptErrorEvent(false, null)
        : streamedSuccess("resp-missing-ct-error-event-recovered");
    }) as typeof fetch;

    const response = await handleResponses(agentMessageRequest(true), config(), { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(body).not.toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(outbound).toHaveLength(2);
    const retriedInput = outbound.at(1)?.input as Array<Record<string, unknown>> | undefined;
    expect(retriedInput?.at(0)).toEqual({
      type: "agent_message",
      author: "/root/child_task",
      recipient: "/root",
      content: [
        { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/child_task\nPayload:" },
        { type: "input_text", text: "[encrypted content omitted]" },
      ],
    });
  });

  test("absent Content-Type decrypt stream does not recover a non-stream request", async () => {
    let sends = 0;
    globalThis.fetch = Object.assign(async () => {
      sends += 1;
      return streamedFunctionOutputDecryptFailure(null);
    }, { preconnect: originalFetch.preconnect });

    const response = await handleResponses(functionOutputRequest(false), config(), { model: "", provider: "" });
    const body = await response.text();

    expect(sends).toBe(1);
    expect(body).toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
    expect(body).not.toContain("response.completed");
  });

  for (const contentType of ["application/json", "text/plain"] as const) {
    test(`refuses non-SSE ${contentType} streamed decrypt recovery`, async () => {
      let sends = 0;
      globalThis.fetch = Object.assign(async () => {
        sends += 1;
        return streamedFunctionOutputDecryptFailure(contentType);
      }, { preconnect: originalFetch.preconnect });

      const response = await handleResponses(functionOutputRequest(true), config(), { model: "", provider: "" });
      const body = await response.text();

      expect(sends).toBe(1);
      expect(body).toContain(FUNCTION_OUTPUT_DECRYPT_MESSAGE);
      expect(body).not.toContain("response.completed");
    });
  }

  for (const streamMode of ["legacy-tee", "eager-relay"] as const) {
    test(`created-then-reset streamed function-output does not sanitize or resend (${streamMode})`, async () => {
      const created = {
        type: "response.created",
        response: { id: "resp-function-output-reset", status: "in_progress" },
      };
      const prefix = new TextEncoder().encode(
        `event: response.created
data: ${JSON.stringify(created)}

`,
      );
      const readError = new Error("upstream stream reset");
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        let sentPrefix = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sentPrefix) {
              sentPrefix = true;
              controller.enqueue(prefix);
              return;
            }
            return Promise.reject(readError);
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }, { preconnect: originalFetch.preconnect }) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const terminals: string[] = [];
      let markTerminal!: () => void;
      const terminal = new Promise<void>(resolve => { markTerminal = resolve; });
      const response = await handleResponses(functionOutputRequest(true), {
        ...config(), streamMode,
      }, logCtx, { onNativePassthroughTerminal: status => {
        terminals.push(status);
        markTerminal();
      } });
      const body = await response.text();
      await terminal;
      expect(terminals).toEqual(["failed"]);
      expect(logCtx.activeAttempt?.streamAborted).toBe(true);
      expect(response.status).toBe(200);
      expect(body).toContain("response.failed");
      expect(body).toContain('"code":"upstream_reset"');
      expect(body).not.toContain('"reason":"adapter_eof"');
      expect(outbound).toHaveLength(1);
      const sentInput = outbound.at(0)?.input as Array<Record<string, unknown>> | undefined;
      expect(sentInput?.at(1)).toEqual(functionOutputReplayInput().at(1));
      expect(JSON.stringify(sentInput)).toContain("encrypted_content");
    });

    test(`created-then-abort streamed function-output returns 499 without resend (${streamMode})`, async () => {
      const created = {
        type: "response.created",
        response: { id: "resp-function-output-abort", status: "in_progress" },
      };
      const prefix = new TextEncoder().encode(
        `event: response.created
data: ${JSON.stringify(created)}

`,
      );
      const abort = new AbortController();
      let fetchSignal: AbortSignal | undefined;
      let sawCreated!: () => void;
      const createdStarted = new Promise<void>(resolve => { sawCreated = resolve; });
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        fetchSignal = init?.signal ?? undefined;
        let sentPrefix = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sentPrefix) {
              sentPrefix = true;
              controller.enqueue(prefix);
              sawCreated();
              return new Promise<void>((_resolve, reject) => {
                const fail = () => reject(fetchSignal?.reason ?? new Error("aborted"));
                if (fetchSignal?.aborted) {
                  fail();
                  return;
                }
                fetchSignal?.addEventListener("abort", fail, { once: true });
              });
            }
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }, { preconnect: originalFetch.preconnect }) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const pending = handleResponses(functionOutputRequest(true), {
        ...config(), streamMode,
      }, logCtx, { abortSignal: abort.signal });
      await createdStarted;
      expect(fetchSignal).toBeDefined();
      abort.abort();
      expect(fetchSignal?.aborted).toBe(true);
      const response = await pending;
      expect(response.status).toBe(499);
      const body = await response.json() as { error?: { code?: string; type?: string } };
      expect(body.error?.code ?? body.error?.type).toBe("client_cancelled");
      expect(outbound).toHaveLength(1);
      const sentInput = outbound.at(0)?.input as Array<Record<string, unknown>> | undefined;
      expect(sentInput?.at(1)).toEqual(functionOutputReplayInput().at(1));
    });
  }

  test("#2247 strips reasoning and compaction ciphertext before a pooled thread moves accounts", async () => {
    const outbound: Array<{ accountId: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      outbound.push({
        accountId: headers.get("chatgpt-account-id"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;
    for (const account of [
      { id: "pool-a", accessToken: "shared-test-token-a", chatgptAccountId: "workspace-a" },
      { id: "pool-b", accessToken: "shared-test-token-b", chatgptAccountId: "workspace-b" },
    ]) {
      saveCodexAccountCredential(account.id, {
        accessToken: account.accessToken,
        refreshToken: `${account.id}-refresh-token`,
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: account.chatgptAccountId,
      });
    }
    const authSpy = spyOn(authContextModule, "resolveCodexAuthContext")
      .mockResolvedValueOnce({
        kind: "pool",
        accountId: "pool-a",
        writerGeneration: 11,
        generation: 1,
        accessToken: "shared-test-token-a",
        chatgptAccountId: "workspace-a",
      })
      .mockResolvedValueOnce({
        kind: "pool",
        accountId: "pool-b",
        writerGeneration: 12,
        generation: 1,
        accessToken: "shared-test-token-b",
        chatgptAccountId: "workspace-b",
      });
    const poolConfig = {
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [
        { id: "pool-a", email: "a@example.test", chatgptAccountId: "workspace-a", isMain: false },
        { id: "pool-b", email: "b@example.test", chatgptAccountId: "workspace-b", isMain: false },
      ],
    } as OcxConfig;
    const poolRequest = () => new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-parent-thread-id": "thread-2247-pool-switch",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        stream: false,
        store: false,
        input: reasoningReplayInput(),
      }),
    });

    try {
      for (let turn = 0; turn < 2; turn += 1) {
        const response = await handleResponses(poolRequest(), poolConfig, { model: "", provider: "" });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(authSpy).toHaveBeenCalledTimes(2);
    } finally {
      authSpy.mockRestore();
    }

    expect(outbound).toHaveLength(2);
    expect(outbound.map(entry => entry.accountId)).toEqual(["workspace-a", "workspace-b"]);
    expect(hasBlob(outbound[0]!.body)).toBe(true);
    const firstInput = outbound[0]!.body.input as Array<Record<string, unknown>>;
    expect(firstInput[1]?.encrypted_content).toBe(BLOB);
    expect(firstInput[2]).toEqual({ type: "compaction", encrypted_content: BLOB });
    expect(hasBlob(outbound[1]!.body)).toBe(false);
    const secondInput = outbound[1]!.body.input as Array<Record<string, unknown>>;
    expect(secondInput[1]).toEqual({
      type: "reasoning",
      content: [],
      summary: [{ type: "summary_text", text: "prior reasoning" }],
    });
    expect(secondInput[2]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
    });
  });

  test("#2247 retries the reported ChatGPT unverifiable-ciphertext rejection once", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? rejection(CHATGPT_UNVERIFIABLE_BLOB_ERROR)
        : success("resp-2247-recovered");
    }) as typeof fetch;

    const response = await handleResponses(request(), config(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(hasBlob(outbound[0]!)).toBe(true);
    expect(hasBlob(outbound[1]!)).toBe(false);
  });

  test("rebuilds once without the rejected blob and preserves surrounding items", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1 ? rejection() : success("resp-recovered");
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    expect(response.status).toBe(200);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(hasBlob(outbound[0]!)).toBe(true);
    const initialInput = outbound[0]!.input as Array<Record<string, unknown>>;
    // Guard the regression where status made upstream reject before checking the blob, so recovery never ran.
    expect(initialInput[1]).toEqual({
      type: "reasoning",
      content: [],
      summary: [{ type: "summary_text", text: "prior reasoning" }],
      encrypted_content: BLOB,
    });
    expect(hasBlob(outbound[1]!)).toBe(false);
    const retriedInput = outbound[1]!.input as Array<Record<string, unknown>>;
    expect(retriedInput[0]).toEqual(reasoningReplayInput()[0]);
    expect(retriedInput[1]).toEqual({
      type: "reasoning",
      content: [],
      summary: [{ type: "summary_text", text: "prior reasoning" }],
    });
    expect(retriedInput[2]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
    });
    expect(retriedInput[3]).toEqual(reasoningReplayInput()[3]);
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
  });

  test("restores namespace names from the rebuilt request alias set", async () => {
    const definition = ADAPTER_REGISTRY["openai-responses"] as unknown as {
      create: typeof ADAPTER_REGISTRY["openai-responses"]["create"];
    };
    const originalCreate = definition.create;
    let buildCount = 0;
    definition.create = (provider, context) => {
      const adapter = originalCreate(provider, context);
      const buildRequest = adapter.buildRequest.bind(adapter);
      adapter.buildRequest = async (parsed, incoming) => {
        const built = await buildRequest(parsed, incoming);
        buildCount += 1;
        const body = JSON.parse(built.body) as Record<string, unknown>;
        built.body = JSON.stringify({
          ...body,
          tools: [{
            type: "function",
            name: buildCount === 1 ? "stale_catalog__read" : "fresh_catalog__read",
            parameters: { type: "object" },
          }],
        });
        built.convertedRoutedNamespaceToolAliases = buildCount === 1
          ? new Map([["stale_catalog__read", { namespace: "stale_catalog", name: "read" }]])
          : new Map([["fresh_catalog__read", { namespace: "fresh_catalog", name: "read" }]]);
        return built;
      };
      return adapter;
    };

    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) return rejection();
      return Response.json({
        id: "resp-rebuilt-aliases",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_fresh_read",
          call_id: "call_fresh_read",
          name: "fresh_catalog__read",
          arguments: "{}",
          status: "completed",
        }],
      });
    }) as typeof fetch;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-parent-thread-id": "thread-rebuilt-namespace-aliases",
        },
        body: JSON.stringify({
          model: "first/model-a",
          stream: false,
          store: false,
          input: reasoningReplayInput(),
          tools: [{
            type: "namespace",
            name: "fresh_catalog",
            tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
          }],
        }),
      }), config(), { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(buildCount).toBe(2);
      expect(outbound).toHaveLength(2);
      expect((outbound[0]!.tools as Array<Record<string, unknown>>)[0]?.name).toBe("stale_catalog__read");
      expect((outbound[1]!.tools as Array<Record<string, unknown>>)[0]?.name).toBe("fresh_catalog__read");
      expect(body.output[0]).toMatchObject({
        type: "function_call",
        namespace: "fresh_catalog",
        name: "read",
        arguments: "{}",
      });
      expect(JSON.stringify(body)).not.toContain("stale_catalog");
    } finally {
      definition.create = originalCreate;
    }
  });

  test("degrades a compaction blob through the generic routed-compaction recovery resend", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1 ? rejection(XAI_DECODE_ERROR) : success("resp-compact-recovered");
    }) as typeof fetch;
    const body = {
      model: "first/model-a",
      stream: false,
      store: false,
      input: [...reasoningReplayInput(), { type: "compaction_trigger" }],
    };
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-parent-thread-id": "thread-routed-compaction-recovery",
      },
      body: JSON.stringify(body),
    }), config(), logCtx);
    expect(response.status).toBe(200);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(hasBlob(outbound[0]!)).toBe(true);
    expect(hasBlob(outbound[1]!)).toBe(false);
    expect(outbound[1]!.input).toContainEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
    });
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
  });

  test("surfaces the second rejection after exactly one recovery attempt", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return rejection();
    }) as typeof fetch;

    const response = await handleResponses(request(), config(), { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid_encrypted_content");
    expect(upstreamCalls).toBe(2);
  });

  test("records a successful recovery so the next cross-route turn strips pre-flight", async () => {
    const outbound = new Map<string, Array<Record<string, unknown>>>([
      ["first", []],
      ["second", []],
    ]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const provider = url.includes("first.example.test") ? "first" : "second";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outbound.get(provider)!.push(body);
      if (hasBlob(body)) return rejection(XAI_DECODE_ERROR);
      if (provider === "first") {
        // Simulate an eviction during the extra round trip. The post-success record is what makes
        // the following route change deterministic instead of cold again.
        clearReasoningReplayCacheForTests();
      }
      return success(`resp-${provider}`);
    }) as typeof fetch;

    const first = await handleResponses(request("first"), config(), { model: "", provider: "" });
    expect(first.status).toBe(200);
    await first.text();
    const second = await handleResponses(request("second"), config(), { model: "", provider: "" });
    expect(second.status).toBe(200);
    await second.text();

    expect(outbound.get("first")).toHaveLength(2);
    expect(outbound.get("second")).toHaveLength(1);
    expect(hasBlob(outbound.get("second")![0]!)).toBe(false);
  });
});

describe("reasoning replay serving identity commit through /v1/responses", () => {
  test("a stable session identity records and detects a serving-identity change without a parent-thread header", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    for (const provider of ["first", "second"]) {
      const response = await handleResponses(
        requestWithIdentityHeaders(provider, { session_id: "session-without-parent-thread" }),
        config(),
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(2);
    expect(hasBlob(outbound[0]!)).toBe(true);
    expect(hasBlob(outbound[1]!)).toBe(false);
  });

  test("foreign blobs recover once, then the same destination strips pre-flight on later headerless turns", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    const turns: RequestLogContext[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outbound.push(body);
      if (hasBlob(body)) return rejection(XAI_DECODE_ERROR);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    for (let turn = 0; turn < 3; turn++) {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      turns.push(logCtx);
      const response = await handleResponses(
        requestWithIdentityHeaders("first", { session_id: "three-turn-headerless-session" }),
        config(),
        logCtx,
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(4);
    expect(outbound.map(hasBlob)).toEqual([true, false, false, false]);
    expect(turns.map(turn => turn.activeAttempt?.sendCount)).toEqual([2, 1, 1]);
    expect(turns.map(turn => turn.activeAttempt?.recoveryKinds)).toEqual([
      ["opaque-blob-rejection"],
      [],
      [],
    ]);
  });

  test("a destination rejection memo does not keep stripping after switching back to the blob-minting destination", async () => {
    const outbound = new Map<string, Array<Record<string, unknown>>>([
      ["first", []],
      ["second", []],
    ]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const provider = String(input).includes("first.example.test") ? "first" : "second";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outbound.get(provider)!.push(body);
      if (provider === "first" && hasBlob(body)) return rejection(XAI_DECODE_ERROR);
      return success(`resp-${provider}-${outbound.get(provider)!.length}`);
    }) as typeof fetch;

    for (const provider of ["first", "second", "second"]) {
      const response = await handleResponses(
        requestWithIdentityHeaders(provider, { session_id: "switch-back-identity-session" }),
        config(),
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound.get("first")!.map(hasBlob)).toEqual([true, false]);
    // The first switch-back turn is still stripped by the unchanged deterministic serving record.
    // Once that record commits `second`, `first`'s memo must not suppress `second`'s own good blob.
    expect(outbound.get("second")!.map(hasBlob)).toEqual([false, true]);
  });

  test("a failed blobless resend records no memo, so the next turn tries the blob again", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    const turns: RequestLogContext[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outbound.push(body);
      if (hasBlob(body)) return rejection(XAI_DECODE_ERROR);
      return new Response(JSON.stringify({
        error: { type: "invalid_request_error", code: "unknown_parameter", message: "retry also failed" },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    for (let turn = 0; turn < 2; turn++) {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      turns.push(logCtx);
      const response = await handleResponses(
        requestWithIdentityHeaders("first", { session_id: "failed-resend-session" }),
        config(),
        logCtx,
      );
      expect(response.status).toBe(400);
      await response.text();
    }

    expect(outbound.map(hasBlob)).toEqual([true, false, true, false]);
    expect(turns.map(turn => turn.activeAttempt?.sendCount)).toEqual([2, 2]);
    expect(turns.map(turn => turn.activeAttempt?.recoveryKinds)).toEqual([
      ["opaque-blob-rejection"],
      ["opaque-blob-rejection"],
    ]);
  });

  test("an expired rejection memo rechecks once, then settles back to one send", async () => {
    let clock = 1_000;
    clearReasoningReplayCacheForTests(() => clock);
    const outbound: Array<Record<string, unknown>> = [];
    const turns: RequestLogContext[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outbound.push(body);
      return hasBlob(body) ? rejection(XAI_DECODE_ERROR) : success(`resp-${outbound.length}`);
    }) as typeof fetch;

    for (let turn = 0; turn < 4; turn++) {
      if (turn === 2) clock += 5 * 60 * 1000 + 1;
      const logCtx: RequestLogContext = { model: "", provider: "" };
      turns.push(logCtx);
      const response = await handleResponses(
        requestWithIdentityHeaders("first", { session_id: "memo-expiry-session" }),
        config(),
        logCtx,
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound.map(hasBlob)).toEqual([true, false, false, true, false, false]);
    expect(turns.map(turn => turn.activeAttempt?.sendCount)).toEqual([2, 1, 2, 1]);
    expect(turns.map(turn => turn.activeAttempt?.recoveryKinds)).toEqual([
      ["opaque-blob-rejection"],
      [],
      ["opaque-blob-rejection"],
      [],
    ]);
  });

  test("a stable conversation without a rejection memo remains unchanged", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    const turns: RequestLogContext[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    for (let turn = 0; turn < 3; turn++) {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      turns.push(logCtx);
      const response = await handleResponses(
        requestWithIdentityHeaders("first", { session_id: "no-rejection-memo-session" }),
        config(),
        logCtx,
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound.map(hasBlob)).toEqual([true, true, true]);
    expect(turns.map(turn => turn.activeAttempt?.sendCount)).toEqual([1, 1, 1]);
    expect(turns.map(turn => turn.activeAttempt?.recoveryKinds)).toEqual([[], [], []]);
  });

  test("the parent-thread header remains authoritative over fallback identities", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    const cases = [
      ["first", "parent-thread-a", "shared-session"],
      ["second", "parent-thread-a", "different-session"],
      ["second", "parent-thread-b", "shared-session"],
    ] as const;
    for (const [provider, parentThreadId, sessionId] of cases) {
      const response = await handleResponses(requestWithIdentityHeaders(provider, {
        "x-codex-parent-thread-id": parentThreadId,
        session_id: sessionId,
      }), config(), { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(3);
    expect(outbound.map(hasBlob)).toEqual([true, false, true]);
  });

  test("a later session_id fallback continues the same raw parent-thread conversation", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    const identity = "mixed-header-conversation";
    const first = await handleResponses(
      requestWithIdentityHeaders("first", { "x-codex-parent-thread-id": identity }),
      config(),
      { model: "", provider: "" },
    );
    expect(first.status).toBe(200);
    await first.text();
    const second = await handleResponses(
      requestWithIdentityHeaders("second", { session_id: identity }),
      config(),
      { model: "", provider: "" },
    );
    expect(second.status).toBe(200);
    await second.text();

    expect(outbound).toHaveLength(2);
    expect(outbound.map(hasBlob)).toEqual([true, false]);
  });

  test("a shared session_id does not coalesce distinct thread-id conversations", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    const cases = [
      ["first", "thread-a"],
      ["second", "thread-b"],
    ] as const;
    for (const [provider, threadId] of cases) {
      const response = await handleResponses(
        requestWithIdentityHeaders(provider, {
          "thread-id": threadId,
          session_id: "shared-cache-session",
        }),
        config(),
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(2);
    expect(outbound.map(hasBlob)).toEqual([true, true]);
  });

  test("requests without any usable conversation identity keep blobs and record nothing", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    for (const provider of ["first", "second"]) {
      const response = await handleResponses(
        requestWithIdentityHeaders(provider),
        config(),
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(2);
    expect(outbound.map(hasBlob)).toEqual([true, true]);
  });

  test("distinct fallback conversation identities never share a serving record", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    const cases = [
      ["first", "conversation-a"],
      ["second", "conversation-b"],
      ["second", "conversation-a"],
    ] as const;
    for (const [provider, sessionId] of cases) {
      const response = await handleResponses(
        requestWithIdentityHeaders(provider, { session_id: sessionId }),
        config(),
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(3);
    expect(outbound.map(hasBlob)).toEqual([true, true, false]);
  });

  test("a failed A-to-B turn does not commit B, so the next B retry still strips A-minted blobs", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    const first = await handleResponses(request("first", "thread-failed-switch"), config(), { model: "", provider: "" });
    expect(first.status).toBe(200);
    await first.text();

    const failedSwitch = await handleResponses(request("second", "thread-failed-switch"), config(), { model: "", provider: "" });
    expect(failedSwitch.status).toBe(429);
    await failedSwitch.text();

    const retry = await handleResponses(request("second", "thread-failed-switch"), config(), { model: "", provider: "" });
    expect(retry.status).toBe(200);
    await retry.text();

    expect(outbound).toHaveLength(3);
    expect(hasBlob(outbound[0]!)).toBe(true);
    expect(hasBlob(outbound[1]!)).toBe(false);
    expect(hasBlob(outbound[2]!)).toBe(false);
  });

  test("a successful A-to-B turn commits B, so the following B turn keeps B-minted blobs", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success(`resp-${outbound.length}`);
    }) as typeof fetch;

    for (const provider of ["first", "second", "second"]) {
      const response = await handleResponses(request(provider, "thread-successful-switch"), config(), { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(outbound).toHaveLength(3);
    expect(hasBlob(outbound[0]!)).toBe(true);
    expect(hasBlob(outbound[1]!)).toBe(false);
    expect(hasBlob(outbound[2]!)).toBe(true);
  });

  test("a thread without a serving record keeps opaque blobs", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success("resp-cold-thread");
    }) as typeof fetch;

    const response = await handleResponses(request("first", "thread-without-record"), config(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();

    expect(outbound).toHaveLength(1);
    expect(hasBlob(outbound[0]!)).toBe(true);
  });
});
