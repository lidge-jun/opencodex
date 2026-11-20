import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { CLIENT_ERROR_CONTRACTS } from "../../src/lib/client-error-body";
import { isAutomaticReplayBlocked, isNonReplayableResponse, isReplayRefusalResponse } from "../../src/lib/upstream-retry";
import { deriveXaiConvId } from "../../src/providers/xai-transport";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONV_KEY = "server-parity-conversation";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-xai-parity-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-xai-parity-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function config(connectTimeoutMs = 1_000): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    connectTimeoutMs,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "xai-test-key-000111222333",
        defaultModel: "grok-test",
      },
    },
  } as OcxConfig;
}

function post(serverUrl: string, signal?: AbortSignal): Promise<Response> {
  return originalFetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "xai/grok-test",
      stream: false,
      prompt_cache_key: CONV_KEY,
      input: "hello",
    }),
  });
}

describe("xAI headers through /v1/responses", () => {
  test("two serving attempts refresh request id and preserve conversation affinity", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.x.ai/v1/chat/completions") {
        seen.push(new Headers(init?.headers));
        return Response.json({
          id: `chatcmpl-${seen.length}`,
          object: "chat.completion",
          created: 1,
          model: "grok-test",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig(config());
    const server = startServer(0);
    try {
      expect((await post(String(server.url))).status).toBe(200);
      expect((await post(String(server.url))).status).toBe(200);
      expect(seen).toHaveLength(2);
      const firstReq = seen[0].get("x-grok-req-id");
      const secondReq = seen[1].get("x-grok-req-id");
      expect(firstReq).toMatch(UUID_V4);
      expect(secondReq).toMatch(UUID_V4);
      expect(secondReq).not.toBe(firstReq);
      expect(seen[0].get("x-grok-conv-id")).toBe(deriveXaiConvId(CONV_KEY));
      expect(seen[1].get("x-grok-conv-id")).toBe(seen[0].get("x-grok-conv-id"));
    } finally {
      await server.stop(true);
    }
  });

  test("provider executor remains inside the header-timeout race", async () => {
    let sends = 0, aborts = 0;
    let deadlineReason: unknown;
    const caller = new AbortController();
    globalThis.fetch = ((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.x.ai/v1/chat/completions") {
        sends++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborts++;
            deadlineReason = init.signal?.reason;
            reject(deadlineReason);
          }, { once: true });
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig(config(25));
    const server = startServer(0);
    try {
      const response = await post(String(server.url), caller.signal);
      expect(sends).toBe(1);
      expect(aborts).toBe(1);
      expect(caller.signal.aborted).toBe(false);
      expect(deadlineReason).toMatchObject({ name: "TimeoutError", message: "Timeout elapsed" });
      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(response.headers.has("retry-after")).toBe(false);
      // The HTTP directive carries the veto across the connection.
      expect(isAutomaticReplayBlocked(response)).toBe(true);
      expect(isNonReplayableResponse(response)).toBe(false);
      expect(isReplayRefusalResponse(response)).toBe(false);
      expect(await response.json()).toMatchObject({ error: {
        code: "upstream_reset_replay_refused", message: CLIENT_ERROR_CONTRACTS.replay_refused,
      } });
    } finally {
      await server.stop(true);
    }
  });
});
