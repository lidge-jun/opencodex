import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authContextModule from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Retention deliberately forwards ciphertext another route minted. ChatGPT can refuse it inside a
// 200 stream (a Codex WebSocket error frame or a response.failed terminal) instead of an HTTP 4xx;
// that refusal must still strip the blob and rebuild exactly once, like the HTTP rejection does.
const BLOB = "retained-reasoning-ciphertext";
const REJECTION = {
  message: "The encrypted content could not be verified.",
  type: "invalid_request_error",
  code: "invalid_encrypted_content",
};
const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-retained-reasoning-stream-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

// A bare error frame ends the stream with no terminal event or [DONE], as ChatGPT sends it.
function sse(done: boolean, ...payloads: unknown[]): Response {
  const body = payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const completed = (id: string) => sse(true, { type: "response.completed", response: { id, status: "completed", model: "m", output: [] } });
const frames = {
  "WebSocket error frame": () => sse(
    false,
    { type: "response.created", response: { id: "resp-error", status: "in_progress" } },
    { type: "error", status: 400, error: REJECTION },
  ),
  "response.failed terminal": () => sse(
    true,
    { type: "response.created", response: { id: "resp-failed", status: "in_progress" } },
    { type: "response.failed", response: { id: "resp-failed", status: "failed", error: REJECTION } },
  ),
} as const;

function turn(model: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": "thread-retained-stream" },
    body: JSON.stringify({
      model,
      stream: true,
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] },
        { type: "reasoning", content: [], summary: [{ type: "summary_text", text: "prior" }], encrypted_content: BLOB },
        { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
      ],
    }),
  });
}

function retentionConfig(): OcxConfig {
  return {
    defaultProvider: "openai",
    nativeReasoningRetention: { modelSwitch: true },
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [{ id: "pool-a", email: "a@example.test", chatgptAccountId: "workspace-a", isMain: false }],
  } as OcxConfig;
}

function poolAccount(): ReturnType<typeof spyOn> {
  saveCodexAccountCredential("pool-a", {
    accessToken: "shared-test-token-a",
    refreshToken: "pool-a-refresh-token",
    expiresAt: Date.now() + 300_000,
    chatgptAccountId: "workspace-a",
  });
  return spyOn(authContextModule, "resolveCodexAuthContext").mockResolvedValue({
    kind: "pool",
    accountId: "pool-a",
    writerGeneration: 11,
    generation: 1,
    accessToken: "shared-test-token-a",
    chatgptAccountId: "workspace-a",
  });
}

describe("retained native reasoning rejected inside a stream", () => {
  for (const [shape, rejected] of Object.entries(frames)) {
    test(`strips and rebuilds once after a ${shape}`, async () => {
      const outbound: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(String(init?.body));
        return outbound.length === 2 ? rejected() : completed(`resp-${outbound.length}`);
      }) as typeof fetch;
      const authSpy = poolAccount();
      const config = retentionConfig();
      try {
        const first = await handleResponses(turn("gpt-5.6-sol"), config, { model: "", provider: "" });
        expect(first.status).toBe(200);
        await first.text();
        const second = await handleResponses(turn("gpt-6-astra"), config, { model: "", provider: "" });
        const body = await second.text();
        expect(second.status).toBe(200);
        expect(body).toContain("response.completed");
        expect(body).not.toContain("invalid_encrypted_content");
      } finally {
        authSpy.mockRestore();
      }
      expect(outbound).toHaveLength(3);
      // The model switch was allowed to carry the ciphertext; the refusal removes it for the
      // single rebuild only.
      expect(outbound[1]).toContain(BLOB);
      expect(outbound[2]).not.toContain(BLOB);
    });
  }

  test("a repeated streamed refusal is rebuilt only once and then reaches the client", async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(init?.body));
      return outbound.length === 1 ? completed("resp-1") : frames["response.failed terminal"]();
    }) as typeof fetch;
    const authSpy = poolAccount();
    try {
      await (await handleResponses(turn("gpt-5.6-sol"), retentionConfig(), { model: "", provider: "" })).text();
      const body = await (await handleResponses(turn("gpt-6-astra"), retentionConfig(), { model: "", provider: "" })).text();
      expect(body).toContain("invalid_encrypted_content");
    } finally {
      authSpy.mockRestore();
    }
    expect(outbound).toHaveLength(3);
    expect(outbound[1]).toContain(BLOB);
    expect(outbound[2]).not.toContain(BLOB);
  });

  test("an already spent ambiguous replacement leaves the refusal stream untouched", async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(init?.body));
      return outbound.length === 1 ? completed("resp-1") : frames["response.failed terminal"]();
    }) as typeof fetch;
    const authSpy = poolAccount();
    const sendBudget = createRequestExecutionBudget();
    expect(sendBudget.claimAmbiguousResend(1)).toBe(true);
    try {
      await (await handleResponses(turn("gpt-5.6-sol"), retentionConfig(), { model: "", provider: "" })).text();
      const second = await handleResponses(turn("gpt-6-astra"), retentionConfig(), { model: "", provider: "" }, { sendBudget });
      // No rebuild is allowed, so the preflight must not consume the stream into a synthetic 400:
      // the client receives the upstream frames, including the response id a projection drops.
      expect(second.status).toBe(200);
      const body = await second.text();
      expect(body).toContain("response.created");
      expect(body).toContain("resp-failed");
      expect(body).toContain("invalid_encrypted_content");
    } finally {
      authSpy.mockRestore();
    }
    expect(outbound).toHaveLength(2);
  });
});
