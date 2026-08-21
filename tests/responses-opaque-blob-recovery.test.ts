import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_REGISTRY } from "../src/adapters/registry";
import { clearReasoningReplayCacheForTests } from "../src/responses/reasoning-replay-cache";
import { OPAQUE_COMPACTION_NOTE } from "../src/responses/compaction";
import { resetThoughtSignatureReplayForTests } from "../src/responses/thought-signature-replay";
import {
  handleResponses,
  shouldAttemptOpaqueBlobRecovery,
} from "../src/server/responses/core";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const BLOB = "provider-minted-opaque-state";
const OPENAI_BLOB_ERROR = JSON.stringify({
  error: {
    message: "The encrypted content could not be verified.",
    type: "invalid_request_error",
    code: "invalid_encrypted_content",
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
  rmSync(testDir, { recursive: true, force: true });
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
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": threadId,
    },
    body: JSON.stringify({
      model: `${provider}/model-a`,
      stream: false,
      store: false,
      input: reasoningReplayInput(),
    }),
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
  });
});

describe("opaque blob recovery through /v1/responses", () => {
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
