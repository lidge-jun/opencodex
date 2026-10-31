/**
 * Native Anthropic Messages candidates inside a combo.
 *
 * Tests a Messages combo with an OAuth `anthropic` candidate + key-auth `anthropic-apikey` candidate:
 * 1) When candidate 1 succeeds, it sends native `/v1/messages` (messages -> messages).
 * 2) When candidate 1 returns 429/500, combo fails over to candidate 2 and sends native `/v1/messages`
 *    (messages -> messages) from a fresh body copy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, unknown>;

interface Sent {
  url: string;
  headers: Headers;
  body: Rec;
}

let sentOAuth: Sent[] = [];
let sentApiKey: Sent[] = [];
let testDir = "";
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-native-combo-"));
  process.env.OPENCODEX_HOME = testDir;
  sentOAuth = [];
  sentApiKey = [];
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  resetProviderRequestPacingForTest();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: Date.now() + 3_600_000,
    accountId: `synthetic-account-${index}`,
    source: "oauth" as const,
  };
}

async function seedOAuth(count = 1): Promise<string[]> {
  for (let index = 0; index < count; index++) await saveCredential("anthropic", credential(index));
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  forgetAnthropicFailoverQuorum();
  return ids;
}

const MESSAGE_RESPONSE: Rec = {
  id: "msg_success_fixture",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "native combo reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 15, output_tokens: 6 },
};

function comboConfig(options: {
  oauthResponder: (sent: Sent, index: number) => Response | Promise<Response>;
  apiKeyResponder: (sent: Sent, index: number) => Response | Promise<Response>;
}): OcxConfig {
  const oauthTransport = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const entry: Sent = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Rec,
    };
    sentOAuth.push(entry);
    return options.oauthResponder(entry, sentOAuth.length - 1);
  }) as typeof fetch;

  const apiKeyTransport = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const entry: Sent = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Rec,
    };
    sentApiKey.push(entry);
    return options.apiKeyResponder(entry, sentApiKey.length - 1);
  }) as typeof fetch;

  const oauthProvider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    models: ["claude-sonnet-4-5"],
    fetch: oauthTransport,
  };

  const apiKeyProvider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "key",
    apiKey: "sk-ant-apikey-fixture",
    models: ["claude-sonnet-4-5"],
    fetch: apiKeyTransport,
  };

  return {
    port: 0,
    defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: false },
    providers: {
      anthropic: oauthProvider,
      "anthropic-apikey": apiKeyProvider,
    },
    combos: {
      pair: {
        strategy: "failover",
        targets: [
          { provider: "anthropic", model: "claude-sonnet-4-5" },
          { provider: "anthropic-apikey", model: "claude-sonnet-4-5" },
        ],
      },
    },
    protocols: {
      rollout: {
        managedMessagesNative: true,
        managedMessagesNativeOAuth: true,
      },
    },
  };
}

describe("Native Anthropic Messages support for Combos", () => {
  test("when candidate 1 (OAuth) succeeds, sends native /v1/messages and stops", async () => {
    await seedOAuth(1);

    const config = comboConfig({
      oauthResponder: () => Response.json(MESSAGE_RESPONSE),
      apiKeyResponder: () => Response.json(MESSAGE_RESPONSE),
    });

    const requestId = `test-native-combo-succeed-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "combo/pair",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello combo" }],
      }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });

    expect(response.status).toBe(200);
    const result = await response.json() as Rec;
    expect(result.id).toBe("msg_success_fixture");
    expect(result.model).toBe("combo/pair");

    // Candidate 1 (OAuth) was dispatched natively
    expect(sentOAuth).toHaveLength(1);
    expect(sentOAuth[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sentOAuth[0]!.headers.get("authorization")).toBe(["Bearer", "synthetic-anthropic-access-0"].join(" "));
    expect(sentOAuth[0]!.headers.get("x-api-key")).toBeNull();
    expect(sentOAuth[0]!.body.model).toBe("claude-sonnet-4-5");
    expect(sentOAuth[0]!.body.messages).toEqual([{ role: "user", content: "hello combo" }]);

    // Candidate 2 was never dispatched
    expect(sentApiKey).toHaveLength(0);

    const rows = getRequestLogEntries().filter(e => e.requestId === requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(200);
    expect(rows[0]!.provider).toBe("combo");
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "messages",
      mode: "native",
      requestPath: ["messages", "messages"],
      attempts: [{ ordinal: 1, mode: "native", requestPath: ["messages", "messages"] }],
    });
  });

  test("when candidate 1 returns 429, combo fails over to candidate 2 and sends native /v1/messages from a fresh body copy", async () => {
    await seedOAuth(1);

    const config = comboConfig({
      oauthResponder: () => new Response(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "OAuth rate limited" },
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
      apiKeyResponder: () => Response.json({
        ...MESSAGE_RESPONSE,
        id: "msg_apikey_fallback",
      }),
    });

    const requestId = `test-native-combo-failover-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "combo/pair",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello failover" }],
      }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });

    expect(response.status).toBe(200);
    const result = await response.json() as Rec;
    expect(result.id).toBe("msg_apikey_fallback");
    expect(result.model).toBe("combo/pair");

    // Candidate 1 was called first and returned 429
    expect(sentOAuth).toHaveLength(1);
    expect(sentOAuth[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sentOAuth[0]!.headers.get("authorization")).toBe(["Bearer", "synthetic-anthropic-access-0"].join(" "));
    expect(sentOAuth[0]!.body.messages).toEqual([{ role: "user", content: "hello failover" }]);

    // Candidate 2 (API key) was called after failover and succeeded from a fresh body copy
    expect(sentApiKey).toHaveLength(1);
    expect(sentApiKey[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sentApiKey[0]!.headers.get("x-api-key")).toBe("sk-ant-apikey-fixture");
    expect(sentApiKey[0]!.headers.get("authorization")).toBeNull();
    expect(sentApiKey[0]!.body.model).toBe("claude-sonnet-4-5");
    expect(sentApiKey[0]!.body.messages).toEqual([{ role: "user", content: "hello failover" }]);

    const rows = getRequestLogEntries().filter(e => e.requestId === requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(200);
    expect(rows[0]!.provider).toBe("combo");
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "messages",
      mode: "native",
      requestPath: ["messages", "messages"],
      attempts: [
        { ordinal: 1, mode: "native", requestPath: ["messages", "messages"] },
        { ordinal: 2, mode: "native", requestPath: ["messages", "messages"] },
      ],
    });
  });

  test("streams a native SSE answer from candidate 2 after candidate 1 returns 429 before any bytes", async () => {
    await seedOAuth(1);
    const sse = [
      `event: message_start
data: ${JSON.stringify({ type: "message_start", message: { ...MESSAGE_RESPONSE, id: "msg_stream_fallback", content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}

`,
      `event: message_stop
data: ${JSON.stringify({ type: "message_stop" })}

`,
    ].join("");
    const config = comboConfig({
      oauthResponder: () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limited" } }), {
        status: 429, headers: { "content-type": "application/json" },
      }),
      apiKeyResponder: () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const requestId = `test-native-combo-stream-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "combo/pair", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello stream" }] }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("msg_stream_fallback");
    expect(text).toContain("message_stop");
    expect(sentOAuth).toHaveLength(1);
    expect(sentApiKey).toHaveLength(1);
    expect(sentApiKey[0]!.body.stream).toBe(true);
    expect(getRequestLogEntries().filter(e => e.requestId === requestId)).toHaveLength(1);
  });

  test("a request-selector effort pin keeps the combo child on the bridge", async () => {
    await seedOAuth(1);
    const frames = [
      ["message_start", { type: "message_start", message: { ...MESSAGE_RESPONSE, content: [], usage: { input_tokens: 3, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ].map(([event, data]) => `event: ${event}
data: ${JSON.stringify(data)}

`).join("");
    const sse = () => new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
    const config = comboConfig({ oauthResponder: sse, apiKeyResponder: sse });
    config.modelPinnedEfforts = { "combo/pair": "high" };
    const requestId = `test-native-combo-selector-pin-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "combo/pair", max_tokens: 1024, messages: [{ role: "user", content: "hello pin" }] }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
    expect(response.status).toBe(200);
    await response.text();
    const rows = getRequestLogEntries().filter(e => e.requestId === requestId);
    expect(rows).toHaveLength(1);
    const attempts = (rows[0]!.protocolTrace as { attempts?: Array<{ mode: string }> } | undefined)?.attempts ?? [];
    expect(attempts.every(attempt => attempt.mode !== "native")).toBe(true);
  });

  test("when candidate 1 returns 500, combo fails over to candidate 2", async () => {
    await seedOAuth(1);

    const config = comboConfig({
      oauthResponder: () => new Response(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Internal server error" },
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      apiKeyResponder: () => Response.json({
        ...MESSAGE_RESPONSE,
        id: "msg_apikey_fallback_500",
      }),
    });

    const requestId = `test-native-combo-failover-500-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "combo/pair",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello 500 failover" }],
      }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });

    expect(response.status).toBe(200);
    const result = await response.json() as Rec;
    expect(result.id).toBe("msg_apikey_fallback_500");

    expect(sentOAuth).toHaveLength(1);
    expect(sentApiKey).toHaveLength(1);
    expect(sentApiKey[0]!.body.messages).toEqual([{ role: "user", content: "hello 500 failover" }]);
  });
});
