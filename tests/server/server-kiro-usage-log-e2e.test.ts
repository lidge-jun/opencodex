import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../../src/adapters/kiro-constants";
import { saveConfig } from "../../src/config";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { saveCredential } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import * as resolver from "../../src/server/adapter-resolve";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses/core";
import { attachRequestSpendTracker } from "../../src/server/responses/request-spend";
import * as upstreamRetry from "../../src/lib/upstream-retry";
import {
  configureSharedSpendLedger, parseSpendJournalRecord, SPEND_LEDGER_JOURNAL_FILENAME, spendPolicyFromConfig,
} from "../../src/lib/spend-reservation-ledger";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { clearRequestLogsForTests, getRequestLogEntries, type RequestLogEntry } from "../../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// What Kiro itself reports for one turn, and what the usage ledger must record for it whichever
// client wire asked: reported counts, credits, no estimate. The prompt below is long enough that
// the adapter's own input estimate is far above these counts, so a row that fell back to the
// estimate cannot pass for a reported one.
const CREDITS = 0.04582331509121062;
const TOKENS = { uncachedInputTokens: 1000, cacheReadInputTokens: 400, cacheWriteInputTokens: 100, outputTokens: 50, totalTokens: 1550 };
const REPORTED = {
  inputTokens: 1500,
  outputTokens: 50,
  cachedInputTokens: 400,
  cacheReadInputTokens: 400,
  cacheCreationInputTokens: 100,
  providerCredits: CREDITS,
};
const LONG_PROMPT = "Summarise the repository layout. ".repeat(3000);

const enc = new TextEncoder();
const CHAT_ENDPOINT = "https://runtime.us-east-1.kiro.dev/";
const originalFetch = globalThis.fetch;

let testDir = "";
let previousOpenCodexHome: string | undefined;
let previousRegion: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousRegion = process.env.KIRO_REGION;
  isolatedCodexHome = installIsolatedCodexHome("ocx-kiro-usage-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-kiro-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.KIRO_REGION = "us-east-1";
  clearRequestLogsForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = previousRegion;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  removeTreeWithRetry(testDir);
});

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage({ ":message-type": "event", ":event-type": eventType }, enc.encode(JSON.stringify(payload)));
}

function kiroTurn(withTokenUsage: boolean): Uint8Array[] {
  return [
    eventFrame("assistantResponseEvent", { content: "The layout is flat." }),
    ...kiroMeters(withTokenUsage),
  ];
}

function kiroMeters(withTokenUsage: boolean): Uint8Array[] {
  return [
    eventFrame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: CREDITS }),
    ...(withTokenUsage ? [eventFrame("metadataEvent", { tokenUsage: TOKENS })] : []),
  ];
}

/** With tools declared, Kiro answers in two legs: progress prose, then the private completion call. */
function kiroTwoLegTurn(secondLegTokenUsage: boolean, firstLegTokenUsage = true): Uint8Array[][] {
  const input = JSON.stringify({ answer: "The layout is flat." });
  const toolUse = (extra: Record<string, unknown>) =>
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1", ...extra });
  return [
    [eventFrame("assistantResponseEvent", { content: "Checking the layout." }), ...kiroMeters(firstLegTokenUsage)],
    [toolUse({}), toolUse({ input }), toolUse({ stop: true }), ...kiroMeters(secondLegTokenUsage)],
  ];
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
}

type Route = "direct" | "combo";

async function startKiro(route: Route, turns: Uint8Array[][]): Promise<ReturnType<typeof startServer>> {
  await saveCredential("kiro", {
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "kiro-usage-account",
    source: "oauth",
  });
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kiro",
    providers: { kiro: { adapter: "kiro", baseUrl: CHAT_ENDPOINT.slice(0, -1), authMode: "oauth", models: ["claude-sonnet-4.5"] } },
    ...(route === "combo"
      ? { combos: { claude: { strategy: "failover", targets: [{ provider: "kiro", model: "claude-sonnet-4.5" }] } } }
      : {}),
  } as unknown as OcxConfig);
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CHAT_ENDPOINT) {
      return new Response(streamOf(turns.shift() ?? []), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return startServer(0);
}

const MODEL: Record<Route, string> = { direct: "kiro/claude-sonnet-4.5", combo: "combo/claude" };

interface Entry {
  label: string;
  path: string;
  body: (model: string) => Record<string, unknown>;
}

const ENTRIES: Entry[] = [
  {
    label: "/v1/responses stream",
    path: "/v1/responses",
    body: model => ({ model, input: LONG_PROMPT, stream: true }),
  },
  {
    label: "/v1/messages stream",
    path: "/v1/messages",
    body: model => ({ model, max_tokens: 256, stream: true, messages: [{ role: "user", content: LONG_PROMPT }] }),
  },
  {
    label: "/v1/messages non-stream",
    path: "/v1/messages",
    body: model => ({ model, max_tokens: 256, stream: false, messages: [{ role: "user", content: LONG_PROMPT }] }),
  },
  {
    label: "/v1/chat/completions non-stream",
    path: "/v1/chat/completions",
    body: model => ({ model, stream: false, messages: [{ role: "user", content: LONG_PROMPT }] }),
  },
];

async function ask(proxy: ReturnType<typeof startServer>, entry: Entry, route: Route): Promise<string> {
  const response = await originalFetch(new URL(entry.path, proxy.url), {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(entry.body(MODEL[route])),
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function finalRow(): Promise<{ memory: RequestLogEntry; persisted: ReturnType<typeof readUsageEntries>[number] }> {
  for (let attempt = 0; attempt < 100 && getRequestLogEntries().length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const memory = getRequestLogEntries().at(-1);
  if (!memory) throw new Error("no request log row was written");
  resetUsageReadCacheForTests();
  const persisted = readUsageEntries().find(row => row.requestId === memory.requestId);
  if (!persisted) throw new Error("the row never reached usage.jsonl");
  return { memory, persisted };
}

describe("Kiro usage reaches the ledger as Kiro reported it, on every inbound wire", () => {
  for (const route of ["direct", "combo"] as const) {
    for (const entry of ENTRIES) {
      test(`${entry.label} via ${route} records reported counts and credits`, async () => {
        const proxy = await startKiro(route, [kiroTurn(true)]);
        try {
          await ask(proxy, entry, route);
          const { memory, persisted } = await finalRow();
          for (const row of [memory, persisted]) {
            expect(row.usageStatus).toBe("reported");
            expect(row.usage).toMatchObject(REPORTED);
            expect(row.usage?.estimated).toBeUndefined();
            expect(row.totalTokens).toBe(1550);
          }
        } finally {
          await proxy.stop(true);
        }
      });

      test(`${entry.label} via ${route} stays estimated when Kiro sent no token usage`, async () => {
        const proxy = await startKiro(route, [kiroTurn(false)]);
        try {
          await ask(proxy, entry, route);
          const { memory, persisted } = await finalRow();
          for (const row of [memory, persisted]) {
            expect(row.usageStatus).toBe("estimated");
            expect(row.usage?.estimated).toBe(true);
            // The credits are metered separately from tokens and survive the missing token frame.
            expect(row.usage?.providerCredits).toBe(CREDITS);
            // The local estimate is a floor here, so it is the count that was written down.
            expect(row.usage?.inputTokens).toBeGreaterThan(REPORTED.inputTokens);
          }
        } finally {
          await proxy.stop(true);
        }
      });
    }
  }

  test("the Claude wire still carries Kiro's output and cache counts", async () => {
    const proxy = await startKiro("combo", [kiroTurn(true)]);
    try {
      const messages = ENTRIES.find(entry => entry.label === "/v1/messages non-stream")!;
      const message = JSON.parse(await ask(proxy, messages, "combo")) as { usage: Record<string, number> };
      expect(message.usage).toMatchObject({
        output_tokens: 50,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 100,
      });
    } finally {
      await proxy.stop(true);
    }
  });

  // Claude Code always declares tools, so its text answers take the two-leg path.
  for (const route of ["direct", "combo"] as const) {
    test(`a two-leg /v1/messages turn via ${route} sums both legs and stays reported`, async () => {
      const proxy = await startKiro(route, kiroTwoLegTurn(true));
      try {
        const tools = [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }];
        await ask(proxy, { label: "", path: "/v1/messages", body: model => ({
          model, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: LONG_PROMPT }],
        }) }, route);
        const { memory, persisted } = await finalRow();
        for (const row of [memory, persisted]) {
          expect(row.usageStatus).toBe("reported");
          expect(row.usage).toMatchObject({
            inputTokens: 2 * REPORTED.inputTokens,
            outputTokens: 2 * REPORTED.outputTokens,
            cacheReadInputTokens: 2 * REPORTED.cacheReadInputTokens,
            cacheCreationInputTokens: 2 * REPORTED.cacheCreationInputTokens,
            providerCredits: 2 * CREDITS,
          });
          expect(row.usage?.estimated).toBeUndefined();
        }
      } finally {
        await proxy.stop(true);
      }
    });

    test(`a two-leg turn via ${route} is estimated when one leg lacks token usage`, async () => {
      const proxy = await startKiro(route, kiroTwoLegTurn(false));
      try {
        const tools = [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }];
        await ask(proxy, { label: "", path: "/v1/messages", body: model => ({
          model, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: LONG_PROMPT }],
        }) }, route);
        const { memory, persisted } = await finalRow();
        for (const row of [memory, persisted]) {
          expect(row.usageStatus).toBe("estimated");
          expect(row.usage?.estimated).toBe(true);
          expect(row.usage?.providerCredits).toBe(2 * CREDITS);
        }
      } finally {
        await proxy.stop(true);
      }
    });
  }
});

// Kiro's bounded completion retry is dispatched from inside the first response's parse, and the
// terminal it yields sums both sends (1550 tokens each). Each send must settle with the reading of
// its own response. When the retry gets an unmetered HTTP failure, the terminal carries only send
// 1's reading: send 1 settles with it and the retry stays unresolved at its reservation, instead of
// send 1's tokens being booked against the retry.
//
// A retry whose response carries no tokenUsage frame (an empty HTTP 200 body, or a completion with
// only a credit meter) gets a locally estimated usage for the client and the request log. That
// estimate is not a provider reading: the retry stays unresolved rather than settling with it, and
// the aggregate fallback cannot settle it with the terminal's total minus send 1 either.
const kiroRetryRows = {
  metered: { title: "a Kiro retry dispatched inside the parse settles each send with its own reading",
    terminal: "response.completed", settled: [1550, 1550], lost: 0 },
  unmetered: { title: "an unmetered Kiro retry failure leaves the retry unresolved and settles send 1 with its reading",
    terminal: "response.failed", settled: [1550], lost: 1 },
  empty: { title: "an empty HTTP 200 Kiro retry leaves the retry unresolved instead of settling its local estimate",
    terminal: "response.incomplete", settled: [1550], lost: 1 },
  estimated: { title: "a Kiro retry without a tokenUsage frame leaves the retry unresolved instead of settling its local estimate",
    terminal: "response.completed", settled: [1550], lost: 1 },
  estimatedFirst: { title: "a dispatched Kiro retry leaves an estimated first send unresolved and settles the retry with its reading",
    terminal: "response.completed", settled: [1550], lost: 1 },
} as const;
for (const ceiling of [false, true]) for (const [retry, row] of Object.entries(kiroRetryRows)) {
  test(`${row.title} (pool ceiling: ${ceiling})`, async () => {
    const release = acquireOwnedSpendHome();
    try {
      if (ceiling) configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 10_000_000 } }, undefined, ["fixture"]));
      const turns = kiroTwoLegTurn(retry !== "estimated", retry !== "estimatedFirst");
      let sends = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if ((input instanceof Request ? input.url : String(input)) !== CHAT_ENDPOINT) throw new Error("unexpected network target");
        sends++;
        if (retry === "unmetered" && sends === 2) {
          return new Response(JSON.stringify({ message: "Improperly formed request." }), { status: 400, headers: { "content-type": "application/json" } });
        }
        if (retry === "empty" && sends === 2) {
          return new Response(streamOf([]), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
        }
        return new Response(streamOf(turns.shift() ?? []), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
      }) as typeof fetch;
      const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
        adapter: "kiro", baseUrl: CHAT_ENDPOINT.slice(0, -1), authMode: "key", apiKey: "ksk_fixture", models: ["claude-sonnet-4.5"], liveModels: false,
      } } } as OcxConfig;
      const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/claude-sonnet-4.5", input: "Summarise the repository layout.", stream: true,
          tools: [{ type: "function", name: "bash", parameters: { type: "object" } }] }) });
      const log: Parameters<typeof handleResponses>[2] = { model: "", provider: "" };
      const budget = createRequestExecutionBudget({ maxTotalModelSends: 4, baseSendAllowance: 4, finalRecoveryAllowance: 0,
        maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined, attachRequestSpendTracker(request, log));
      const response = await handleResponses(request, config, log, { sendBudget: budget });
      expect(await response.text()).toContain(row.terminal);
      log.spendTracker?.settle(log.usage);
      const journal = Bun.file(join(testDir, SPEND_LEDGER_JOURNAL_FILENAME));
      const records = await journal.exists() ? (await journal.text()).trim().split("\n").map(parseSpendJournalRecord) : [];
      expect({ sends, dispatched: records.filter(record => record?.kind === "dispatch").length,
        settled: records.flatMap(record => record?.kind === "settle" ? [record.tokens] : []),
        lost: records.filter(record => record?.kind === "lost").length })
        .toEqual({ sends: 2, dispatched: 2, settled: row.settled, lost: row.lost });
    } finally {
      release();
    }
  });
}

// When Kiro's first response carries no tokenUsage frame and the request's one-send budget refuses
// the completion retry before it leaves, that response is the request's only routed send. It must
// settle with the request's aggregate (estimated) usage, as a single send always did, instead of
// staying unresolved at its full reservation: under a 3,000-token pool ceiling the leaked
// reservation would refuse the next identical request.
// A retry whose attempt deadline expires before its dispatch receipt never leaves either: the
// transport turns that TimeoutError into a synthetic 504, and the same single-send rule applies.
const kiroUndispatchedRetryRows = {
  budget: "an estimated Kiro response whose retry the budget refuses settles its estimate",
  timeout: "an estimated Kiro response whose retry times out before dispatch settles its estimate",
} as const;
for (const ceiling of [false, true]) for (const [cause, title] of Object.entries(kiroUndispatchedRetryRows)) {
  test(`${title} (pool ceiling: ${ceiling})`, async () => {
    const release = acquireOwnedSpendHome();
    // Every Kiro request makes two deadline calls when its retry runs; the second is the retry's.
    let deadlineCalls = 0;
    const realDeadline = upstreamRetry.fetchWithAttemptDeadline;
    const deadlineSpy = spyOn(upstreamRetry, "fetchWithAttemptDeadline").mockImplementation((url, init, timeoutMs, abortSignal, ...rest) =>
      realDeadline(url, init, timeoutMs, cause === "timeout" && ++deadlineCalls % 2 === 0
        ? AbortSignal.abort(new DOMException("Timeout elapsed", "TimeoutError")) : abortSignal, ...rest));
    try {
      if (ceiling) configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 3_000 } }, undefined, ["fixture"]));
      let sends = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if ((input instanceof Request ? input.url : String(input)) !== CHAT_ENDPOINT) throw new Error("unexpected network target");
        sends++;
        const frames = [eventFrame("assistantResponseEvent", { content: "Checking the layout." }), ...kiroMeters(false)];
        return new Response(streamOf(frames), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
      }) as typeof fetch;
      const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
        adapter: "kiro", baseUrl: CHAT_ENDPOINT.slice(0, -1), authMode: "key", apiKey: "ksk_fixture", models: ["claude-sonnet-4.5"], liveModels: false,
      } } } as OcxConfig;
      const ledgerRows = async () => {
        const journal = Bun.file(join(testDir, SPEND_LEDGER_JOURNAL_FILENAME));
        const records = await journal.exists() ? (await journal.text()).trim().split("\n").map(parseSpendJournalRecord) : [];
        return { dispatched: records.filter(record => record?.kind === "dispatch").length,
          settled: records.flatMap(record => record?.kind === "settle" ? [record.tokens] : []),
          lost: records.filter(record => record?.kind === "lost").length };
      };
      const statuses: number[] = [];
      for (let round = 0; round < (ceiling ? 2 : 1); round++) {
        const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture/claude-sonnet-4.5", input: "Summarise the repository layout.", stream: true,
            tools: [{ type: "function", name: "bash", parameters: { type: "object" } }] }) });
        const log: Parameters<typeof handleResponses>[2] = { model: "", provider: "" };
        const sendCap = cause === "budget" ? 1 : 4;
        const budget = createRequestExecutionBudget({ maxTotalModelSends: sendCap, baseSendAllowance: sendCap, finalRecoveryAllowance: 0,
          maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined, attachRequestSpendTracker(request, log));
        const response = await handleResponses(request, config, log, { sendBudget: budget });
        statuses.push(response.status);
        await response.text();
        log.spendTracker?.settle(log.usage);
        if (round === 0) {
          const rows = await ledgerRows();
          expect({ sends, ...rows, settled: rows.settled.length }).toEqual({ sends: 1, dispatched: 1, settled: 1, lost: 0 });
          expect(rows.settled[0]).toBe((log.usage?.inputTokens ?? 0) + (log.usage?.outputTokens ?? 0));
        }
      }
      expect(statuses).toEqual(ceiling ? [200, 200] : [200]);
      if (cause === "timeout") expect(deadlineCalls).toBe(ceiling ? 4 : 2);
    } finally {
      deadlineSpy.mockRestore();
      release();
    }
  });
}

for (const component of ["userinfo", "path", "query"] as const) for (const stream of [false, true]) {
  test(`Kiro local send-budget refusal bounds the destination ${component} stream=${stream}`, async () => {
    const key = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
    const baseUrl = component === "userinfo" ? `https://${key}:fixture@provider.example.test/`
      : component === "path" ? `https://provider.example.test/${key}` : `https://provider.example.test/?key=${key}`;
    const config = { port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", providers: { fixture: {
      adapter: "kiro", baseUrl, authMode: "key", apiKey: "ksk_fixture", models: ["claude-sonnet-4.5"], liveModels: false,
    } } } as OcxConfig;
    const originalResolve = resolver.resolveAdapter;
    let attempts = 0; let sentUrl = "";
    const refused = createRequestExecutionBudget({ maxTotalModelSends: 0, baseSendAllowance: 0, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    const adapterSpy = spyOn(resolver, "resolveAdapter").mockImplementation((provider, cache, id) => {
      const adapter = originalResolve(provider, cache, id);
      if (provider.adapter !== "kiro") return adapter;
      const fetchResponse = adapter.fetchResponse!.bind(adapter);
      return { ...adapter, fetchResponse(request, context) { sentUrl = request.url; attempts++; return fetchResponse(request, { ...context, sendBudget: refused }); } };
    });
    try {
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/claude-sonnet-4.5", stream,
          messages: [{ role: "user", content: "fixture question" }] }) }), config, { model: "", provider: "" },
        { requestId: `destination-${component}-${stream}`, start: Date.now() });
      const body = await response.text();
      expect(attempts).toBe(1);
      expect(sentUrl).toContain(key);
      expect(refused.used).toBe(0);
      expect(response.status).toBe(429);
      const error = JSON.parse(body).error;
      expect(error).toBeDefined();
      expect(error.type).toBe("rate_limit_error");
      expect(error.code).toBe("rate_limit_exceeded");
      expect(error.message).toContain("request send budget exhausted before dispatch");
      const { memory, persisted } = await finalRow();
      const raw = readFileSync(usageLogPath(), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.requestId === memory.requestId);
      expect(raw).toBeDefined();
      for (const row of [memory, persisted, raw]) {
        expect(row.status).toBe(429);
        expect(row.errorCode).toBe("rate_limit_exceeded");
      }
      expect(body).not.toContain(key);
      expect(JSON.stringify(memory)).not.toContain(key);
      expect(JSON.stringify(persisted)).not.toContain(key);
      expect(JSON.stringify(raw)).not.toContain(key);
    } finally { adapterSpy.mockRestore(); }
  });
}
