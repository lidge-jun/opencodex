import { getCachedProviderAccountQuota } from "../../src/providers/quota/account-cache";
import { REPLAY_REFUSAL_MESSAGE } from "../../src/lib/upstream-retry";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { httpStatusFromTerminalError } from "../../src/lib/errors";
import { errorDetailFor } from "../../src/usage/error-detail";
import { inspectResponseLogJson, type RequestLogContext } from "../../src/server/request-log";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import type { AdapterEvent, OcxConfig } from "../../src/types";
import * as resolver from "../../src/server/adapter-resolve";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { saveCredential, setActiveAccount, getAccountSet } from "../../src/oauth/store";
import { clearAnthropicAccountPoolState, formatAnthropicProviderForLog } from "../../src/oauth/anthropic-routing";
import { deriveOAuthProviderConfig } from "../../src/providers/derive";
import { readUsageEntries } from "../../src/usage/log";
import { parseSpendJournalRecord, SPEND_LEDGER_JOURNAL_FILENAME } from "../../src/lib/spend-reservation-ledger";

let releaseInheritedSpendHome: (() => void) | undefined;
// Taken per inherited-home dispatch because one row below installs a different home.
const takeInheritedSpendHome = (): void => { releaseInheritedSpendHome = acquireOwnedSpendHome(); };

const config = {
  port: 0,
  defaultProvider: "claude-se",
  providers: {
    "claude-se": {
      adapter: "anthropic",
      baseUrl: "https://example.test",
      apiKey: "sk-test",
    },
  },
} as unknown as OcxConfig;

/** Build an Anthropic SSE response from raw frames. */
function anthropicSse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const firstTurn = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我接下来会修改相关文件。"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const continuationTurn = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec_command","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** Build an OpenAI Chat Completions SSE response from raw frames. */
function chatSse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// A clean end-of-turn with only assistant text and no tool call — the suspicious
// no-tool completion the guard is meant to re-ask (mirrors firstTurn for openai-chat).
const chatFirstTurn = [
  'data: {"choices":[{"delta":{"content":"我接下来会修改相关文件。"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

// The continuation turn emits the tool call the model should have produced.
const chatContinuationTurn = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

function openAiChatConfig(terminalContinuationGuard?: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "glm-gw",
    providers: {
      "glm-gw": {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "key",
        defaultModel: "glm-5.2",
        models: ["glm-5.2"],
        ...(terminalContinuationGuard !== undefined ? { terminalContinuationGuard } : {}),
      },
    },
  } as unknown as OcxConfig;
}

describe("server terminal guard integration", () => {
  let originalFetch: typeof fetch;
  let calls: number;
  let requestBodies: Record<string, unknown>[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = 0;
    requestBodies = [];
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return anthropicSse(calls === 1 ? firstTurn : continuationTurn);
    }) as typeof fetch;
  });

  afterEach(() => {
    // Released first so a failed row cannot carry its writer lease into the next case.
    releaseInheritedSpendHome?.();
    releaseInheritedSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  test("re-asks Claude once inside the same Responses turn and forwards the tool call", async () => {
    takeInheritedSpendHome();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), config, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(text).toContain("response.completed");
    expect(text).toContain("exec_command");
    const messages = requestBodies[1]?.messages as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content?.[0]?.text).toContain("你刚才只描述了计划");
  });

  // #8877: both legs re-send the whole conversation. The client sizes its context window from the
  // terminal usage, so it gets the final leg's; the request log still meters both legs (10 + 20).
  for (const stream of [true, false]) {
    test(`${stream ? "streamed" : "buffered"} Responses terminal reports the final leg's usage; the log meters both`, async () => {
      takeInheritedSpendHome();
      if (!stream) {
        globalThis.fetch = (async () => {
          calls += 1;
          return Response.json(calls === 1
            ? { type: "message", role: "assistant", content: [{ type: "text", text: "我接下来会修改相关文件。" }],
              stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }
            : { type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "exec_command", input: {} }],
              stop_reason: "tool_use", usage: { input_tokens: 20, output_tokens: 3 } });
        }) as typeof fetch;
      }
      const log: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "se-claude-opus-4.8",
          input: "请检查这个问题并修复代码",
          stream,
          tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
        }),
      }), config, log);

      const text = await response.text();
      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      const usage = stream
        ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
          .find(frame => frame.type === "response.completed")?.response?.usage
        : JSON.parse(text).usage;
      expect(usage).toMatchObject({ input_tokens: 20, output_tokens: 3, total_tokens: 23 });
      expect(log.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 });
    });
  }

  test("Chat Completions usage reports the final leg's prompt tokens; the log meters both legs", async () => {
    takeInheritedSpendHome();
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "请检查这个问题并修复代码" }],
        tools: [{ type: "function", function: { name: "exec_command", description: "run a command", parameters: { type: "object" } } }],
      }),
    }), config, log);

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    const usage = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
      .findLast(chunk => chunk.usage)?.usage;
    expect(usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 });
    expect(log.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 });
  });

  // A re-ask that fails upstream fails the turn, and the failed terminal carries the usage the
  // request metered (the announcing leg's 10 + 2; the overloaded leg reported none). The Chat wire
  // ends that turn in an {error} frame, so an include_usage client reads it from the usage chunk
  // before the error, through the bridge converter and the direct Chat encoder alike.
  const failedContinuation = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
  ].join("");
  test.each([false, true])("a failed re-ask's metered usage precedes the Chat error frame (directEncoders=%p)", async directEncoders => {
    takeInheritedSpendHome();
    globalThis.fetch = (async () => { calls += 1; return anthropicSse(calls === 1 ? firstTurn : failedContinuation); }) as typeof fetch;
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8", stream: true, stream_options: { include_usage: true },
        messages: [{ role: "user", content: "请检查这个问题并修复代码" }],
        tools: [{ type: "function", function: { name: "exec_command", description: "run a command", parameters: { type: "object" } } }],
      }),
    }), { ...config, ...(directEncoders ? { protocols: { rollout: { directEncoders: true } } } : {}) } as OcxConfig, log);

    const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(calls).toBe(2);
    expect(frames.at(-1)?.error).toBeDefined();
    expect(frames.at(-2)).toMatchObject({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    expect(log.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  /**
   * Account A announces work, its re-ask is rate-limited, and account B answers the re-ask. The
   * first leg reports usage unless `firstUsageless`; `credits` adds that credit reading to every
   * usage the parser reports, as a credit-billed provider would.
   */
  async function oauthRotation(opts: { reported: boolean; firstUsageless?: boolean; credits?: number; inconclusive?: boolean }) {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-terminal-guard-oauth-usage-"));
    process.env.OPENCODEX_HOME = home;
    const originalResolve = resolver.resolveAdapter;
    const withCredits = (event: AdapterEvent): AdapterEvent => opts.credits !== undefined && "usage" in event && event.usage
      ? { ...event, usage: { ...event.usage, providerCredits: opts.credits } } as AdapterEvent : event;
    const adapterSpy = spyOn(resolver, "resolveAdapter").mockImplementation((...args) => {
      const adapter = originalResolve(...args);
      const parseResponse = adapter.parseResponse?.bind(adapter);
      return parseResponse ? { ...adapter, parseResponse: async (...params: Parameters<typeof parseResponse>) =>
        (await parseResponse(...params)).map(withCredits) } : adapter;
    });
    try {
      takeInheritedSpendHome();
      clearAnthropicAccountPoolState();
      for (const name of ["a", "b"]) await saveCredential("anthropic", {
        access: `fixture-access-${name}`, refresh: `fixture-refresh-${name}`,
        expires: Date.now() + 3_600_000, accountId: `fixture-account-${name}`, source: "oauth",
      });
      const [firstAccount, replacementAccount] = getAccountSet("anthropic")!.accounts.map(account => account.id);
      await setActiveAccount("anthropic", firstAccount!);
      const model = "claude-sonnet-4-6";
      const oauthConfig: OcxConfig = { port: 0, defaultProvider: "anthropic", providers: {
        anthropic: { ...deriveOAuthProviderConfig("anthropic")!, models: [model] },
      }, anthropicAccountPool: { enabled: true } };
      saveConfig(oauthConfig);
      const auth: string[] = [];
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
        auth.push(new Headers(init?.headers).get("authorization") ?? "");
        if (auth.length === 1) return Response.json({ type: "message", role: "assistant",
          content: [{ type: "text", text: "我接下来会修改相关文件。" }], stop_reason: "end_turn",
          ...(opts.firstUsageless ? {} : { usage: { input_tokens: 10, output_tokens: 2 } }) });
        if (auth.length === 2) return Response.json({
          ...(opts.inconclusive ? { padding: "x".repeat(32_000) } : {}),
          type: "error", error: { type: "rate_limit_error", message: "rate limit exceeded" },
        }, { status: 429, headers: { "retry-after": "120", "anthropic-ratelimit-unified-5h-utilization": "0.91" } });
        return Response.json({ type: "message", role: "assistant", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "exec_command", input: {} }],
          ...(opts.reported ? { usage: { input_tokens: 20, output_tokens: 3 } } : {}) });
      }) as typeof fetch;

      const log: RequestLogContext = { model: "", provider: "" };
      const requestId = crypto.randomUUID();
      const start = Date.now();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `anthropic/${model}`, input: "请检查这个问题并修复代码", stream: false,
          tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }] }),
      }), oauthConfig, log);
      const body = await responseWithDeferredRequestLog(response, requestId, start, log).json();
      const row = readUsageEntries().find(entry => entry.requestId === requestId);
      const journal = Bun.file(join(home, SPEND_LEDGER_JOURNAL_FILENAME));
      const records = await journal.exists() ? (await journal.text()).trim().split("\n").map(parseSpendJournalRecord) : [];
      const dispatched = records.flatMap(record => record?.kind === "dispatch" ? [record.send] : []);
      const ledger = records.flatMap(record => record?.kind === "settle" ? [{ send: dispatched.indexOf(record.send) + 1, tokens: record.tokens }]
        : record?.kind === "lost" ? [{ send: dispatched.indexOf(record.send) + 1, tokens: "lost" as const }] : [])
        .sort((a, b) => a.send - b.send);
      const quota = [firstAccount!, replacementAccount!].map(id => getCachedProviderAccountQuota("anthropic", id)?.fiveHourPercent);
      return { status: response.status, body, auth, row, ledger, quota, accounts: [firstAccount, replacementAccount] };
    } finally {
      adapterSpy.mockRestore();
      releaseInheritedSpendHome?.();
      releaseInheritedSpendHome = undefined;
      clearAnthropicAccountPoolState();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  }

  test.each([true, false])("buffered OAuth continuation keeps usage on its issuing account (replacement reports usage: %s)", async reported => {
    const { status, body, auth, row, ledger, accounts: [firstAccount, replacementAccount] } = await oauthRotation({ reported });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "completed", usage: reported
      ? { input_tokens: 20, output_tokens: 3 } : { input_tokens: 10, output_tokens: 2 } });
    expect(auth).toEqual(["Bearer fixture-access-a", "Bearer fixture-access-a", "Bearer fixture-access-b"]);
    expect(row?.attempts?.map(attempt => ({
      provider: attempt.provider, sends: attempt.sendCount, status: attempt.status,
      input: attempt.usage?.inputTokens, output: attempt.usage?.outputTokens,
    }))).toEqual([
      { provider: formatAnthropicProviderForLog("anthropic", firstAccount), sends: 2, status: 429, input: 10, output: 2 },
      { provider: formatAnthropicProviderForLog("anthropic", replacementAccount), sends: 1, status: 200,
        input: reported ? 20 : undefined, output: reported ? 3 : undefined },
    ]);
    // #8902: account A's first send settles its own 12 tokens, the usage-less 429 stays
    // unresolved, and account B's send settles only what it reported.
    expect(ledger).toEqual([{ send: 1, tokens: 12 }, { send: 2, tokens: "lost" }, { send: 3, tokens: reported ? 23 : "lost" }]);
  });

  test("an inconclusive OAuth continuation preserves the issuing account's quota and send settlement", async () => {
    const { body, auth, quota, ledger } = await oauthRotation({ reported: false, inconclusive: true });
    expect(auth).toEqual(["Bearer fixture-access-a", "Bearer fixture-access-a"]);
    expect(quota).toEqual([91, undefined]);
    expect(ledger).toEqual([{ send: 1, tokens: 12 }, { send: 2, tokens: "lost" }]);
    expect(body).toMatchObject({ status: "failed", retryable: false,
      error: { message: "Provider error 429: upstream diagnostic withheld for a non-replayable failure" } });
  });

  // #8452 across a rotation: the rotation reuses the live attempt object for account B, so a
  // marker keyed by that object made A's usage-less leg mark B's own 3 credits incomplete. A's
  // missing reading leaves the request's credit total incomplete; B's attempt keeps its reading.
  test("a usage-less leg before an OAuth rotation leaves the request credits incomplete and keeps the replacement's own", async () => {
    const { status, row } = await oauthRotation({ reported: true, firstUsageless: true, credits: 3 });
    expect(status).toBe(200);
    expect(row?.attempts?.map(attempt => attempt.usage?.providerCredits)).toEqual([undefined, 3]);
    expect(row?.usage?.providerCredits).toBe(-1);
  });

  // #8877, empty-completion retry path: the retry runs its own terminal guard, and a re-ask
  // there must not sum its legs into the client terminal either. The empty first attempt stays
  // on the terminal (the empty-completion guard's documented merge); the log meters all three.
  test("a re-ask inside the empty-completion retry reports the final leg's usage to the client", async () => {
    takeInheritedSpendHome();
    const emptyTurn = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    globalThis.fetch = (async () => {
      calls += 1;
      return anthropicSse(calls === 1 ? emptyTurn : calls === 2 ? firstTurn : continuationTurn);
    }) as typeof fetch;
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), { ...config, emptyCompletionRetry: true } as OcxConfig, log);

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    const usage = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
      .find(frame => frame.type === "response.completed")?.response?.usage;
    expect(usage).toMatchObject({ input_tokens: 25, output_tokens: 3 });
    expect(log.usage).toMatchObject({ inputTokens: 35, outputTokens: 5 });
  });

  test("terminal-guard continuation 429 replays on the same key before surfacing", async () => {
    takeInheritedSpendHome();
    const retryConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    const requestBodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      requestBodies.push(String(init?.body ?? ""));
      if (sends === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicSse(sends === 1 ? firstTurn : continuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), retryConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    // initial turn + 429 continuation + replayed continuation
    expect(sends).toBe(3);
    expect(text).toContain("response.completed");
    expect(text).toContain("exec_command");
    // The 429 continuation (send 2) and its same-key replay (send 3) must be byte-identical.
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]).toBe(requestBodies[2]);
  });

  test.each(["upstream_response_refused", "upstream_reset_replay_refused", "inconclusive", "header"] as const)(
    "terminal-guard continuation stops on a same-key retry with %s", async veto => {
    takeInheritedSpendHome();
    const retryConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 2, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      if (sends === 3) {
        const coded = veto.startsWith("upstream_");
        return Response.json({
          ...(veto === "inconclusive" ? { padding: "x".repeat(70_000) } : {}),
          error: { ...(coded ? { code: veto } : {}), message: "fixture diagnostic" },
        }, { status: 429, headers: {
          "retry-after": "30", ...(veto === "header" ? { "x-should-retry": "false" } : {}),
        } });
      }
      return anthropicSse(sends === 1 ? firstTurn : continuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), retryConfig, { model: "", provider: "" });

    const frames = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(sends).toBe(3);
    const failed = frames.find(frame => frame.type === "response.failed");
    expect(failed?.response.retryable).toBe(false);
    if (veto.startsWith("upstream_")) {
      expect(failed.response.error).toMatchObject({ code: veto, message: REPLAY_REFUSAL_MESSAGE });
    }
  });

  for (const path of ["responses", "chat/completions"] as const) {
    for (const stream of [true, false]) {
      for (const directEncoders of path === "responses" ? [false] : [false, true]) {
        const variants = path === "responses" ? ["inconclusive", "ordinary"]
          : ["upstream_response_refused", "upstream_reset_replay_refused", "header", "inconclusive", "ordinary"];
        test.each(variants)(`${path} stream=${stream} direct=${directEncoders} continuation %s`, async variant => {
          takeInheritedSpendHome();
          const chat = path === "chat/completions";
          const coded = variant.startsWith("upstream_");
          const veto = variant !== "ordinary";
          globalThis.fetch = (async () => {
            calls += 1;
            if (calls === 1) return (stream || chat) ? anthropicSse(firstTurn) : Response.json({
              id: "msg_fixture", type: "message", role: "assistant", model: "se-claude-opus-4.8",
              content: [{ type: "text", text: "我接下来会修改相关文件。" }],
              stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
            });
            return Response.json({
              ...(variant === "inconclusive" ? { padding: "x".repeat(32_000) } : {}),
              error: { ...(coded ? { code: variant } : {}), message: "fixture diagnostic" },
            }, { status: 429, headers: veto ? {
              "retry-after": "30", ...(variant === "header" ? { "x-should-retry": "false" } : {}),
            } : {} });
          }) as typeof fetch;
          const tool = { name: "exec_command", description: "run a command", parameters: { type: "object" } };
          const input = "请检查这个问题并修复代码";
          const log: RequestLogContext = { model: "", provider: "" };
          const response = await (chat ? handleChatCompletions : handleResponses)(
            new Request(`http://localhost/v1/${path}`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "se-claude-opus-4.8", stream,
                ...(chat ? { messages: [{ role: "user", content: input }], tools: [{ type: "function", function: tool }],
                  ...(stream ? { stream_options: { include_usage: true } } : {}) }
                  : { input, tools: [{ type: "function", ...tool }] }),
              }),
            }), { ...config, protocols: { rollout: { directEncoders } } } as OcxConfig, log);
          const body = await response.text();
          const frames = stream ? body.split("\n").filter(line => line.startsWith("data: {"))
            .map(line => JSON.parse(line.slice(6))) : [];
          const terminal = stream ? chat ? frames.find(frame => frame.error)
            : frames.find(frame => frame.type === "response.failed")?.response : JSON.parse(body);
          expect(calls).toBe(2);
          expect(log.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
          if (chat && stream) {
            expect(frames.filter(frame => frame.usage).map(frame => frame.usage))
              .toEqual([expect.objectContaining({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })]);
          }
          expect(response.headers.get("retry-after")).toBeNull();
          if (coded) expect(terminal?.error).toMatchObject({ code: variant, message: REPLAY_REFUSAL_MESSAGE });
          else if (veto) expect(terminal?.error?.message).toBe("Provider error 429: upstream diagnostic withheld for a non-replayable failure");
          else if (chat) expect(terminal?.error).toMatchObject({ code: "rate_limit_exceeded" });
          else expect(terminal?.error?.message).toContain("fixture diagnostic");
          if (!stream) expect(response.headers.get("x-should-retry")).toBe(veto ? "false" : null);
          if (chat && !stream) expect(response.status).toBe(429);
          if (!chat) expect(terminal?.retryable).toBe(veto ? false : undefined);
        });
      }
    }
  }

  test("terminal-guard continuation retry budget stays per request across key failover", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-terminal-guard-failover-"));
    process.env.OPENCODEX_HOME = home;
    // Taken after this case installs its home so the direct dispatch owns that journal.
    const releaseSpendHome = acquireOwnedSpendHome();
    clearKeyCooldowns("claude-se");
    const budgetConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          apiKeyPool: [
            { id: "k1", key: "sk-test", addedAt: 1 },
            { id: "k2", key: "sk-test-2", addedAt: 2 },
          ],
          retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      if (sends === 1) {
        return anthropicSse(firstTurn);
      }
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      saveConfig(budgetConfig);
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "se-claude-opus-4.8",
          input: "请检查这个问题并修复代码",
          stream: true,
          tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
        }),
      }), budgetConfig, { model: "", provider: "" });

      await response.text();
      // initial turn + continuation retry (same key) + failover continuation (second key) = 4.
      // A per-iteration budget would replay on the second key too (5+ sends).
      expect(sends).toBe(4);
    } finally {
      // Released before restoring or removing the home so its lease files can be deleted.
      releaseSpendHome();
      clearKeyCooldowns("claude-se");
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  test("terminal-guard continuation shares the request-wide 429 budget with the main loop", async () => {
    takeInheritedSpendHome();
    const budgetConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        // The main recovery loop consumes the only same-key replay...
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      if (sends === 2) {
        // ...the replay succeeds and the terminal-guard continuation starts.
        return anthropicSse(firstTurn);
      }
      // Continuation 429 with the request budget already spent: surfaces, never replays.
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), budgetConfig, { model: "", provider: "" });

    const text = await response.text();
    // main 429 -> same-key replay -> continuation 429 (no budget left) = exactly 3 sends.
    expect(sends).toBe(3);
    expect(text).toContain("Provider continuation error 429");
  });

  test("terminal-guard continuation preserves structured cyber_policy semantics", async () => {
    takeInheritedSpendHome();
    const secret = `OpenAI flagged this request for potential high-risk cybersecurity activity. Authorization: ${["Bear", "er"].join("")} continuationsecret123456`;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) return anthropicSse(firstTurn);
      return Response.json({
        error: {
          message: secret,
          type: "server_error",
          code: "cyber_policy",
        },
      }, { status: 400, headers: { "retry-after": "120" } });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), config, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(2);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).toContain('"type":"server_error"');
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain("Authorization: Bearer [REDACTED]");
    expect(text).not.toContain("continuationsecret123456");
    expect(text).not.toContain("Provider continuation error 400");
  });

  test("terminal-guard continuation abort during the 429 wait yields 499 without replaying", async () => {
    takeInheritedSpendHome();
    const abortConfig = {
      ...config,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 3, intervalMs: 30_000, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        return anthropicSse(firstTurn);
      }
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const abort = new AbortController();
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), abortConfig, { model: "", provider: "" }, { abortSignal: abort.signal });

    // The terminal-guard continuation runs inside the SSE producer, so consume the body to
    // drive it, then wait until the continuation's 429 lands and its retry sleep is running.
    const response = await pending;
    const textPromise = response.text();
    for (let i = 0; i < 100 && sends < 2; i += 1) await Bun.sleep(10);
    expect(sends).toBe(2);
    abort.abort(new DOMException("client disconnected", "AbortError"));
    const text = await textPromise;
    expect(text).toContain("client closed request during terminal continuation");
    expect(sends).toBe(2);
  });

  test("a stalled continuation body reports 504 even when cancelling it aborts the client signal", async () => {
    takeInheritedSpendHome();
    // Cancelling the stalled source can disconnect the client in the same tick. The
    // classifier has to read the thrown error first, or this timeout is reported as a
    // client cancellation and the caller loses the upstream stall signal.
    const stallConfig = { ...config, stallTimeoutSec: 1 } as unknown as OcxConfig;
    const abort = new AbortController();
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) return anthropicSse(firstTurn);
      const stalled = new ReadableStream<Uint8Array>({
        cancel() { abort.abort(new DOMException("client disconnected", "AbortError")); },
      });
      return new Response(stalled, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), stallConfig, { model: "", provider: "" }, { abortSignal: abort.signal });

    const text = await response.text();
    expect(sends).toBe(2);
    const failure = JSON.parse(text.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.failed"'))!.slice(6));
    expect(failure.response.error).toMatchObject({ code: "upstream_stall_timeout", message: "Upstream response body stalled for 1000ms" });
    const log: RequestLogContext = { model: "fixture-model", provider: "fixture" };
    inspectResponseLogJson(log, JSON.stringify(failure));
    expect(log.terminalHttpStatus).toBe(504);
    expect(errorDetailFor({ status: log.terminalHttpStatus!, upstreamError: log.upstreamError }).failureDetail)
      .toEqual({ code: "body_stall", value: 1000 });
    expect(text).not.toContain("client closed request during terminal continuation");
  });

  test.each([true, false])("an empty-completion retry body stall preserves 504 classification (stream=%s)", async stream => {
    takeInheritedSpendHome();
    const stallConfig = { ...config, emptyCompletionRetry: true, stallTimeoutSec: 1 } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) return stream
        ? anthropicSse('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
        : Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "se-claude-opus-4.8",
            content: [], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } });
      return new Response(new ReadableStream<Uint8Array>({}), {
        status: 200, headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "se-claude-opus-4.8", input: "Hi", stream }),
    }), stallConfig, { model: "", provider: "" });
    const text = await response.text();
    const failure = stream
      ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.failed"'))!.slice(6)).response
      : JSON.parse(text);
    expect(sends).toBe(2);
    expect(response.status).toBe(stream ? 200 : 504);
    expect(failure.error).toMatchObject({ code: "upstream_stall_timeout", message: "Upstream response body stalled for 1000ms" });
    expect(httpStatusFromTerminalError(failure.error)).toBe(504);
    expect(errorDetailFor({ status: 504, upstreamError: failure.error.message }).failureDetail)
      .toEqual({ code: "body_stall", value: 1000 });
  });

  test("a stalled buffered continuation returns 504 with the failed response", async () => {
    takeInheritedSpendHome();
    const stallConfig = { ...config, stallTimeoutSec: 1 } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) return Response.json({ id: "msg_fixture", type: "message", role: "assistant",
        model: "se-claude-opus-4.8", content: [{ type: "text", text: "我接下来会修改相关文件。" }],
        stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } });
      return new Response(new ReadableStream<Uint8Array>({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "se-claude-opus-4.8", input: "请检查这个问题并修复代码", stream: false,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }] }),
    }), stallConfig, { model: "", provider: "" });
    const body = await response.json() as { status: string; error: { code?: string; message: string } };
    expect(sends).toBe(2);
    expect(response.status).toBe(504);
    expect(body.status).toBe("failed");
    expect(body.error).toMatchObject({ code: "upstream_stall_timeout", message: "Upstream response body stalled for 1000ms" });
    expect(errorDetailFor({ status: response.status, upstreamError: body.error.message }).failureDetail)
      .toEqual({ code: "body_stall", value: 1000 });
  });

  test.each(["invalid-body", "provider-timeout-code"] as const)("a buffered continuation %s keeps the existing HTTP 200", async variant => {
    takeInheritedSpendHome();
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) return variant === "invalid-body"
        ? Response.json({ id: "msg_fixture", type: "message", role: "assistant",
          model: "se-claude-opus-4.8", content: [{ type: "text", text: "我接下来会修改相关文件。" }],
          stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } })
        : Response.json({ id: "chat_fixture", choices: [{ message: { role: "assistant", content: "我接下来会修改相关文件。" }, finish_reason: "stop" }] });
      return variant === "invalid-body" ? Response.json(null)
        : Response.json({ error: { type: "upstream_error", code: "upstream_stall_timeout", message: "provider supplied code" } });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: variant === "invalid-body" ? "se-claude-opus-4.8" : "glm-5.2", input: "请检查这个问题并修复代码", stream: false,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }] }),
    }), variant === "invalid-body" ? config : openAiChatConfig(true), { model: "", provider: "" });
    const body = await response.json() as { status: string; error: { code?: string } };
    expect(sends).toBe(2);
    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    if (variant === "provider-timeout-code") expect(body.error.code).toBe("upstream_stall_timeout");
  });

  test("a stalled initial body fails with a 504 upstream error instead of a proxy error", async () => {
    takeInheritedSpendHome();
    // The initial stream has no continuation classifier: without one the bridge catch
    // reports this upstream timeout as a 500 proxy_error.
    const stallConfig = { ...config, stallTimeoutSec: 1 } as unknown as OcxConfig;
    globalThis.fetch = (async () => {
      const stalled = new ReadableStream<Uint8Array>({});
      return new Response(stalled, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), stallConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    const failure = JSON.parse(text.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.failed"'))!.slice(6));
    expect(failure.response.error).toMatchObject({ code: "upstream_stall_timeout", message: "Upstream response body stalled for 1000ms" });
    expect(httpStatusFromTerminalError(failure.response.error)).toBe(504);
    const log: RequestLogContext = { model: "fixture-model", provider: "fixture" };
    inspectResponseLogJson(log, JSON.stringify(failure));
    expect(log.terminalHttpStatus).toBe(504);
    expect(errorDetailFor({ status: log.terminalHttpStatus!, upstreamError: log.upstreamError }).failureDetail)
      .toEqual({ code: "body_stall", value: 1000 });
    expect(text).toContain('"type":"upstream_error"');
    expect(text).not.toContain("proxy_error");
  });

  test("a stalled buffered body preserves 504 and the bounded stall detail", async () => {
    takeInheritedSpendHome();
    const stallConfig = { ...config, stallTimeoutSec: 1 } as unknown as OcxConfig;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({}), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "se-claude-opus-4.8", input: "Hi", stream: false }),
    }), stallConfig, { model: "", provider: "" });
    expect(response.status).toBe(504);
    const body = await response.json() as { error: { message: string } };
    expect(errorDetailFor({ status: response.status, upstreamError: body.error.message }).failureDetail)
      .toEqual({ code: "body_stall", value: 1000 });
  });

  test("terminal-guard 429 wait longer than the stall budget still succeeds (heartbeats)", async () => {
    takeInheritedSpendHome();
    const stallConfig = {
      ...config,
      stallTimeoutSec: 1,
      providers: {
        "claude-se": {
          adapter: "anthropic",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          retryOn429: { attempts: 1, intervalMs: 1_500, respectRetryAfter: false },
        },
      },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) {
        return anthropicSse(firstTurn);
      }
      if (sends === 2) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicSse(continuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "se-claude-opus-4.8",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), stallConfig, { model: "", provider: "" });

    const text = await response.text();
    // A 1.5s continuation backoff under a 1s stall budget must not trip upstream_stall_timeout:
    // the wait yields heartbeat events, the replay lands, and the turn completes.
    expect(sends).toBe(3);
    expect(text).toContain("response.completed");
    expect(text).not.toContain("upstream_stall_timeout");
  }, 5_000);

  test("openai-chat provider without terminalContinuationGuard does not re-ask", async () => {
    takeInheritedSpendHome();
    const chatConfig = openAiChatConfig();
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    // Guard is opt-in for openai-chat: no continuation, so exactly one upstream call.
    expect(sends).toBe(1);
    expect(text).toContain("response.completed");
  });

  test("openai-chat provider with terminalContinuationGuard false does not re-ask", async () => {
    takeInheritedSpendHome();
    const chatConfig = openAiChatConfig(false);
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(text).toContain("response.completed");
  });

  test("openai-chat provider with terminalContinuationGuard re-asks once and forwards the tool call", async () => {
    takeInheritedSpendHome();
    const chatConfig = openAiChatConfig(true);
    let sends = 0;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return chatSse(sends === 1 ? chatFirstTurn : chatContinuationTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    // Opted-in openai-chat provider: one bounded continuation, so two upstream calls.
    expect(sends).toBe(2);
    expect(text).toContain("response.completed");
    expect(text).toContain("exec_command");
    const messages = bodies[1]?.messages as Array<{ role?: string; content?: unknown }>;
    expect(messages.some(m => m.role === "developer" || m.role === "system")).toBe(true);
  });

  test("synthetic Antigravity continuation 401 does not rotate accounts", async () => {
    const priorHome = process.env.OPENCODEX_HOME;
    const isolated = mkdtempSync(join(tmpdir(), "ocx-antigravity-continuation-"));
    process.env.OPENCODEX_HOME = isolated;
    try {
      await saveCredential("google-antigravity", { access: "access-a", refresh: "refresh-a",
        expires: Date.now() + 3_600_000, accountId: "account-a", projectId: "project-a", source: "oauth" });
      const a = getAccountSet("google-antigravity")!.activeAccountId;
      await saveCredential("google-antigravity", { access: "access-b", refresh: "refresh-b",
        expires: Date.now() + 3_600_000, accountId: "account-b", projectId: "project-b", source: "oauth" }, { addAccount: true });
      await setActiveAccount("google-antigravity", a);
      takeInheritedSpendHome();
      const antigravityConfig: OcxConfig = { port: 0, defaultProvider: "google-antigravity", providers: {
        "google-antigravity": {
          adapter: "google", modelAdapters: { "gemini-3.8-flash": "openai-chat" },
          baseUrl: "https://example.test/v1", authMode: "oauth", googleMode: "cloud-code-assist",
          terminalContinuationGuard: true, models: ["gemini-3.8-flash"],
        },
      } } as OcxConfig;
      const auth: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization") ?? "");
        if (auth.length === 1) return chatSse(chatFirstTurn);
        if (auth.length === 2) return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
        return chatSse(chatContinuationTurn);
      }) as typeof fetch;

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "google-antigravity/gemini-3.8-flash",
          input: "Please fix the file", stream: true,
          tools: [{ type: "function", name: "exec_command", description: "run a command",
            parameters: { type: "object" } }] }),
      }), antigravityConfig, { model: "", provider: "" });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("Provider continuation error 401");
      expect(body).not.toContain("exec_command");
      expect(auth).toEqual(["Bearer access-a", "Bearer access-a"]);
    } finally {
      releaseInheritedSpendHome?.();
      releaseInheritedSpendHome = undefined;
      if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = priorHome;
      removeTreeWithRetry(isolated);
    }
  });

  test("combo attempts do not run an opted-in openai-chat terminal guard", async () => {
    takeInheritedSpendHome();
    const comboConfig = {
      ...openAiChatConfig(true),
      combos: {
        guarded: {
          strategy: "failover",
          targets: [{ provider: "glm-gw", model: "glm-5.2" }],
        },
      },
    } as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/guarded",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), comboConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(text).toContain("response.completed");
  });

  test("routed compaction does not run an opted-in openai-chat terminal guard", async () => {
    takeInheritedSpendHome();
    const chatConfig = openAiChatConfig(true);
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return chatSse(chatFirstTurn);
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-gw/glm-5.2",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
          { type: "compaction_trigger" },
        ],
        stream: true,
        tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
      }),
    }), chatConfig, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(text).toContain('"type":"compaction"');
    expect(text).toContain("response.completed");
  });

});
